import { NetError, safeDownload, type NetDeps } from "./net.js";

/**
 * Referências visuais para o site: pins de uma pasta pública do Pinterest
 * (pelo feed RSS da pasta) e imagens por link. Elas servem só para o Claude
 * entender o estilo (paleta, composição, tipografia, clima). Nunca vão
 * para o site: imagem de terceiro não é publicada.
 */
export interface RefImage {
  url: string;
  type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: Buffer;
}

export const MAX_REFS = 12;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif)$/;
const RESERVED = new Set(["pin", "search", "ideas", "today", "explore", "_", "settings", "business", "login"]);

/** https://br.pinterest.com/usuario/pasta/ → https://www.pinterest.com/usuario/pasta.rss */
export function pinterestRssUrl(boardUrl: string): string | null {
  const m = /^https:\/\/(?:[a-z]{2,3}\.)?pinterest\.[a-z.]{2,8}\/([^/?#\s]+)\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(boardUrl.trim());
  if (!m || RESERVED.has(m[1]!.toLowerCase())) return null;
  return `https://www.pinterest.com/${encodeURIComponent(decodeURIComponent(m[1]!))}/${encodeURIComponent(decodeURIComponent(m[2]!))}.rss`;
}

/** Imagens dos pins no feed RSS (na maior resolução que o feed permite). */
export function parseRssImages(xml: string): string[] {
  const urls = new Set<string>();
  for (const m of xml.matchAll(/https:\/\/i\.pinimg\.com\/[^"'<>\s&]+?\.(?:jpe?g|png|webp|gif)/gi)) {
    urls.add(m[0].replace(/\/(?:\d+x|originals)\//, "/736x/"));
  }
  return [...urls].slice(0, MAX_REFS);
}

export async function collectReferences(
  input: { pinterest?: string | null; urls?: string[] },
  deps: NetDeps = {},
): Promise<{ images: RefImage[]; erros: string[] }> {
  const erros: string[] = [];
  const candidates: string[] = [];
  if (input.pinterest) {
    const rss = pinterestRssUrl(input.pinterest);
    if (!rss) erros.push("Link do Pinterest não é de uma pasta (use pinterest.com/usuario/pasta).");
    else {
      try {
        const feed = await safeDownload(rss, { maxBytes: 3 * 1024 * 1024, accept: /xml|rss|text/ }, deps);
        const found = parseRssImages(feed.data.toString("utf8"));
        if (!found.length) erros.push("A pasta do Pinterest não tem pins públicos (ou é secreta).");
        candidates.push(...found);
      } catch (err) {
        erros.push(`Não consegui ler a pasta do Pinterest (${err instanceof NetError ? err.message : "falha de rede"}).`);
      }
    }
  }
  for (const u of input.urls ?? []) if (/^https:\/\//i.test(u.trim())) candidates.push(u.trim());

  const images: RefImage[] = [];
  const unique = [...new Set(candidates)].slice(0, MAX_REFS);
  // Em lotes de 4 para não abrir conexões demais de uma vez.
  for (let i = 0; i < unique.length; i += 4) {
    const batch = await Promise.all(
      unique.slice(i, i + 4).map(async (url) => {
        try {
          const r = await safeDownload(url, { maxBytes: MAX_IMAGE_BYTES, accept: IMAGE_TYPES }, deps);
          return { url, type: r.type as RefImage["type"], data: r.data };
        } catch (err) {
          erros.push(`Referência ignorada (${err instanceof NetError ? err.message : "falha"}): ${url.slice(0, 120)}`);
          return null;
        }
      }),
    );
    for (const img of batch) if (img) images.push(img);
  }
  return { images, erros };
}
