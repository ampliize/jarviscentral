import { lookup as dnsLookup, promises as dns, type LookupAddress } from "node:dns";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { isPrivateAddress } from "../skills/monitor.js";

/**
 * Download seguro de arquivos da internet (referências do Pinterest, imagens
 * por link): só https, só endereços públicos (checa o DNS a cada redirecionamento,
 * para um link não virar acesso à rede interna do servidor) e tamanho máximo.
 */
export interface NetDeps {
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
}

export class NetError extends Error {}

const defaultLookup = async (host: string) => (await dns.lookup(host, { all: true })).map((a) => a.address);

async function assertPublic(url: URL, lookup: (host: string) => Promise<string[]>) {
  if (url.protocol !== "https:") throw new NetError("só aceito links https");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : await lookup(host).catch(() => [] as string[]);
  if (!addresses.length) throw new NetError(`domínio não encontrado: ${host}`);
  if (addresses.some(isPrivateAddress)) throw new NetError("endereço interno bloqueado");
}

/**
 * GET https com o IP fixado: a conexão usa o mesmo endereço que acabou de ser
 * checado (sem uma segunda consulta ao DNS que poderia apontar para a rede interna).
 */
function pinnedGet(url: URL, timeoutMs: number, extra: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": "Mozilla/5.0 (Jarvis-Ampliize)", Accept: "*/*", ...extra },
        timeout: timeoutMs,
        lookup: (host, opts, cb) => {
          dnsLookup(host, { all: true }, (err, addresses: LookupAddress[]) => {
            if (err) return cb(err, "", 4);
            if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return cb(new NetError("endereço interno bloqueado"), "", 4);
            if ((opts as { all?: boolean }).all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
            cb(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers.set(k, v);
        const status = res.statusCode ?? 500;
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      },
    );
    req.on("timeout", () => req.destroy(new NetError("tempo esgotado")));
    req.on("error", (err) => reject(err instanceof NetError ? err : new NetError("falha de conexão")));
  });
}

/** Baixa até `maxBytes`, seguindo no máximo 3 redirecionamentos (cada um checado). */
export async function safeDownload(
  rawUrl: string,
  { maxBytes, accept, timeoutMs = 20_000, headers: initialHeaders = {} }: { maxBytes: number; accept?: RegExp; timeoutMs?: number; headers?: Record<string, string> },
  deps: NetDeps = {},
): Promise<{ data: Buffer; type: string; url: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let headers = initialHeaders;
  const lookup = deps.lookup ?? defaultLookup;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetError("link inválido");
  }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url, lookup);
    // Sem fetch injetado (produção): conexão com o IP checado. Com fetch injetado: testes.
    const res = deps.fetchImpl
      ? await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "Mozilla/5.0 (Jarvis-Ampliize)", Accept: "*/*", ...headers } })
      : await pinnedGet(url, timeoutMs, headers);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new NetError("redirecionamento sem destino");
      const next = new URL(loc, url);
      // Chave de API (Pexels/Unsplash) nunca segue para outro domínio.
      if (next.host !== url.host) headers = {};
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new NetError(`HTTP ${res.status}`);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (accept && !accept.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      throw new NetError(`tipo não aceito (${type || "desconhecido"})`);
    }
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new NetError("arquivo grande demais");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += (chunk as Uint8Array).byteLength;
      if (size > maxBytes) throw new NetError("arquivo grande demais");
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return { data: Buffer.concat(chunks), type, url: url.toString() };
  }
  throw new NetError("redirecionamentos demais");
}
