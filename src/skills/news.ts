/**
 * Notícias pelo RSS do Google Notícias (sem chave). Guarda cada busca por
 * 15 minutos. Os títulos são dados de terceiros: o Jarvis só os resume.
 */
const TTL_MS = 15 * 60 * 1000;
const MAX_ITEMS = 6;

export interface NewsItem {
  titulo: string;
  fonte: string | null;
  link: string;
  publicado: string | null;
}

export class NewsError extends Error {}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export const decodeXml = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decodeXml(m[1]!) : null;
};

/** Lê os itens de um RSS (só o necessário: título, fonte, link, data). */
export function parseRss(xml: string, max = MAX_ITEMS): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const body = m[1]!;
    const fonte = tag(body, "source");
    let titulo = tag(body, "title") ?? "";
    // O Google Notícias põe " - Fonte" no fim do título.
    if (fonte && titulo.endsWith(` - ${fonte}`)) titulo = titulo.slice(0, -(fonte.length + 3));
    const link = tag(body, "link") ?? "";
    if (!titulo || !/^https:\/\//.test(link)) continue;
    const date = tag(body, "pubDate");
    items.push({ titulo, fonte, link, publicado: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null });
    if (items.length >= max) break;
  }
  return items;
}

export class NewsService {
  private cache = new Map<string, { at: number; data: NewsItem[] }>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Última consulta de verdade: true = respondeu, false = falhou, null = ainda não consultou. */
  lastOk: boolean | null = null;

  async search(topic?: string | null): Promise<NewsItem[]> {
    try {
      const data = await this.fetchNews(topic);
      this.lastOk = true;
      return data;
    } catch (err) {
      this.lastOk = false;
      throw err;
    }
  }

  private async fetchNews(topic?: string | null): Promise<NewsItem[]> {
    const q = (topic ?? "").trim().slice(0, 120);
    const key = q.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
    const locale = "hl=pt-BR&gl=BR&ceid=BR:pt-419";
    const url = q ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${locale}` : `https://news.google.com/rss?${locale}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/rss+xml, application/xml" } });
    } catch {
      throw new NewsError("O serviço de notícias não respondeu.");
    }
    if (!res.ok) throw new NewsError(`O serviço de notícias falhou (HTTP ${res.status}).`);
    const data = parseRss(await res.text());
    // Temas vêm de fora (rota do HUD): guarda só os 50 mais recentes.
    this.cache.delete(key);
    this.cache.set(key, { at: Date.now(), data });
    while (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value!);
    return data;
  }
}
