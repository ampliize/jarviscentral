import { NetError, safeDownload, type NetDeps } from "./net.js";

/**
 * O Jarvis pesquisa referências sozinho, por palavra-chave, em bancos de
 * imagem com API aberta:
 *  - Openverse (imagens Creative Commons; gratuito e sem chave), sempre;
 *  - Pexels e Unsplash (fotos profissionais; chaves gratuitas em
 *    PEXELS_API_KEY e UNSPLASH_ACCESS_KEY), quando configurados.
 * Não raspa o Pinterest (vai contra as regras dele); pastas do Pinterest
 * que o dono mandar continuam sendo lidas pelo feed público.
 */
export interface SearchKeys {
  pexels?: string;
  unsplash?: string;
}

export interface SearchHit {
  url: string;
  fonte: "pexels" | "unsplash" | "openverse";
}

const JSON_TYPE = /json/;

async function getJson(url: string, deps: NetDeps, headers: Record<string, string> = {}): Promise<any> {
  const r = await safeDownload(url, { maxBytes: 2 * 1024 * 1024, accept: JSON_TYPE, headers, timeoutMs: 15_000 }, deps);
  return JSON.parse(r.data.toString("utf8"));
}

export async function searchImages(term: string, perTerm: number, keys: SearchKeys, deps: NetDeps = {}): Promise<{ hits: SearchHit[]; erros: string[] }> {
  const q = encodeURIComponent(term.slice(0, 100));
  const hits: SearchHit[] = [];
  const erros: string[] = [];
  const tryProvider = async (name: SearchHit["fonte"], fn: () => Promise<string[]>) => {
    if (hits.length >= perTerm) return;
    try {
      for (const url of await fn()) if (hits.length < perTerm && /^https:\/\//.test(url)) hits.push({ url, fonte: name });
    } catch (err) {
      erros.push(`Busca no ${name} falhou (${err instanceof NetError ? err.message : "erro"}).`);
    }
  };
  if (keys.pexels) {
    await tryProvider("pexels", async () => {
      const d = await getJson(`https://api.pexels.com/v1/search?query=${q}&per_page=${perTerm}`, deps, { Authorization: keys.pexels! });
      return (d.photos ?? []).map((p: any) => p?.src?.large).filter(Boolean);
    });
  }
  if (keys.unsplash) {
    await tryProvider("unsplash", async () => {
      const d = await getJson(`https://api.unsplash.com/search/photos?query=${q}&per_page=${perTerm}`, deps, { Authorization: `Client-ID ${keys.unsplash}` });
      return (d.results ?? []).map((p: any) => p?.urls?.small).filter(Boolean);
    });
  }
  await tryProvider("openverse", async () => {
    const d = await getJson(`https://api.openverse.org/v1/images/?q=${q}&page_size=${perTerm}&mature=false`, deps);
    return (d.results ?? []).map((p: any) => p?.thumbnail || p?.url).filter(Boolean);
  });
  return { hits, erros };
}

/** Pesquisa vários termos e junta, sem repetir, até `max` imagens. */
export async function searchReferences(terms: string[], max: number, keys: SearchKeys, deps: NetDeps = {}) {
  const all: SearchHit[] = [];
  const erros: string[] = [];
  const perTerm = Math.max(2, Math.ceil(max / Math.max(1, terms.length)));
  for (const term of terms.slice(0, 5)) {
    if (all.length >= max) break;
    const r = await searchImages(term, perTerm, keys, deps);
    for (const h of r.hits) if (all.length < max && !all.some((x) => x.url === h.url)) all.push(h);
    for (const e of r.erros) if (!erros.includes(e)) erros.push(e);
  }
  return { hits: all, erros };
}
