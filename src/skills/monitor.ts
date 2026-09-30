import { promises as dns } from "node:dns";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

/**
 * Monitor dos sistemas (nossos e dos clientes). A lista fica no vault, em
 * _jarvis/sistemas.md, uma linha por sistema:
 *
 *   - CRM da Ampliize | https://ampliize.lovable.app | Ampliize
 *
 * O Jarvis testa cada endereço (responde? em quanto tempo? o certificado
 * HTTPS vence quando?) a cada 5 minutos e guarda o histórico de 24 h.
 * Só aceita https para endereços públicos e não segue redirecionamentos, para
 * a lista não virar uma forma de acessar a rede interna do servidor.
 */
export interface SystemEntry {
  nome: string;
  url: string;
  cliente: string | null;
}

export type Health = "ok" | "atencao" | "fora";

export interface SystemCheck extends SystemEntry {
  status: Health;
  http: number | null;
  ms: number | null;
  ssl_dias: number | null;
  detalhe: string | null;
  uptime_24h: number | null;
  verificado_em: string;
}

const SLOW_MS = 3_000;
const SSL_WARN_DAYS = 14;
const HISTORY_MS = 24 * 60 * 60 * 1000;
/** Testes mais próximos que isso contam como uma amostra só (não distorce a disponibilidade). */
const SAMPLE_MS = 4 * 60 * 1000;
const MAX_SYSTEMS = 50;

const validUrl = (text: string) => {
  try {
    const u = new URL(text);
    return u.protocol === "https:" && !!u.hostname ? u : null;
  } catch {
    return null;
  }
};

/** Lê as linhas "Nome | https://... | Cliente" (lista ou tabela Markdown). */
export function parseSystems(markdown: string): SystemEntry[] {
  const out: SystemEntry[] = [];
  const seen = new Set<string>();
  for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const line = raw.replace(/^\s*[-*]\s+/, "").replace(/^\s*\||\|\s*$/g, "").trim();
    const url = /https:\/\/[^\s|)>\]]+/.exec(line)?.[0];
    const parsed = url ? validUrl(url) : null;
    if (!url || !parsed || seen.has(url)) continue;
    const cells = line.split("|").map((c) => c.trim().replace(/[*_`[\]]/g, ""));
    const idx = cells.findIndex((c) => c.includes(url));
    const rest = cells.map((c, i) => ({ c, i })).filter((x) => x.c && x.i !== idx);
    // Nome: a coluna antes do link ou, com o link na frente, a primeira depois dele.
    const nomeCell = idx > 0 ? { c: cells[0]!, i: 0 } : rest[0];
    const clienteCell = rest.find((x) => x.i !== nomeCell?.i && (idx > 0 ? x.i > idx : true));
    seen.add(url);
    out.push({ nome: nomeCell?.c || parsed.hostname, url, cliente: clienteCell?.c ?? null });
    if (out.length >= MAX_SYSTEMS) break;
  }
  return out;
}

/** Endereço de rede interna, loopback, link-local ou reservado. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Dias até o certificado HTTPS vencer (null se não deu para ler). */
export function sslDaysLeft(host: string, port = 443, timeoutMs = 6_000): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      const end = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
      resolve(Number.isNaN(end) ? null : Math.floor((end - Date.now()) / 86_400_000));
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}

const defaultLookup = async (host: string) => (await dns.lookup(host, { all: true })).map((a) => a.address);

export interface MonitorOptions {
  fetchImpl?: typeof fetch;
  sslCheck?: (host: string, port: number) => Promise<number | null>;
  lookup?: (host: string) => Promise<string[]>;
  now?: () => number;
}

export class SystemMonitor {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sslCheck: (host: string, port: number) => Promise<number | null>;
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly now: () => number;
  private history = new Map<string, { at: number; up: boolean }[]>();
  private last: SystemCheck[] = [];
  private lastAt = 0;
  private running: Promise<SystemCheck[]> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(brainRoot: string, opts: MonitorOptions = {}) {
    this.file = path.join(brainRoot, "_jarvis", "sistemas.md");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sslCheck = opts.sslCheck ?? ((host, port) => sslDaysLeft(host, port));
    this.lookup = opts.lookup ?? defaultLookup;
    this.now = opts.now ?? Date.now;
  }

  async systems(): Promise<SystemEntry[]> {
    // Arquivo comum só (um link simbólico no vault não aponta para outro arquivo do servidor).
    const st = await fs.lstat(this.file).catch(() => null);
    if (!st?.isFile()) return [];
    return parseSystems(await fs.readFile(this.file, "utf8").catch(() => ""));
  }

  private async probe(s: SystemEntry): Promise<Pick<SystemCheck, "status" | "http" | "ms" | "ssl_dias" | "detalhe">> {
    const url = new URL(s.url);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    try {
      addresses = net.isIP(host) ? [host] : await this.lookup(host);
    } catch {
      return { status: "fora", http: null, ms: null, ssl_dias: null, detalhe: "domínio não encontrado" };
    }
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      return { status: "atencao", http: null, ms: null, ssl_dias: null, detalhe: "endereço interno: não monitorado" };
    }
    const started = this.now();
    let http: number | null = null;
    let detalhe: string | null = null;
    let status: Health;
    try {
      const res = await this.fetchImpl(s.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Jarvis-Ampliize-Monitor" } });
      http = res.status;
      await res.body?.cancel().catch(() => undefined);
      // 3xx: o site respondeu (redireciona para login/www). 401/403: API no ar pedindo chave.
      status = res.status >= 500 ? "fora" : res.status >= 400 && res.status !== 401 && res.status !== 403 ? "atencao" : "ok";
      if (status !== "ok") detalhe = `respondeu HTTP ${res.status}`;
    } catch (err) {
      status = "fora";
      const code = String((err as { cause?: { code?: string } })?.cause?.code ?? "");
      detalhe = err instanceof Error && err.name === "TimeoutError"
        ? "não respondeu em 10 s"
        : /CERT|SSL|TLS/i.test(code)
          ? "certificado HTTPS vencido ou inválido"
          : "sem conexão";
    }
    const ms = http === null ? null : this.now() - started;
    if (status === "ok" && ms !== null && ms > SLOW_MS) {
      status = "atencao";
      detalhe = `lento (${(ms / 1000).toFixed(1)} s)`;
    }
    const port = Number(url.port) || 443;
    const ssl_dias = http === null ? null : await this.sslCheck(host, port).catch(() => null);
    if (ssl_dias !== null && ssl_dias < SSL_WARN_DAYS) {
      status = ssl_dias < 0 ? "fora" : status === "fora" ? "fora" : "atencao";
      detalhe = ssl_dias < 0 ? "certificado HTTPS vencido" : `certificado HTTPS vence em ${ssl_dias} dia(s)`;
    }
    return { status, http, ms, ssl_dias, detalhe };
  }

  private record(url: string, up: boolean) {
    const at = this.now();
    const hist = (this.history.get(url) ?? []).filter((h) => at - h.at < HISTORY_MS);
    const last = hist[hist.length - 1];
    if (last && at - last.at < SAMPLE_MS) hist[hist.length - 1] = { at: last.at, up: last.up && up };
    else hist.push({ at, up });
    this.history.set(url, hist);
    return Math.round((hist.filter((h) => h.up).length / hist.length) * 1000) / 10;
  }

  private async checkOne(s: SystemEntry): Promise<SystemCheck> {
    const result = await this.probe(s);
    const uptime_24h = this.record(s.url, result.status !== "fora");
    return { ...s, ...result, uptime_24h, verificado_em: new Date(this.now()).toISOString() };
  }

  /** Testa todos agora (uma rodada por vez). */
  checkAll(): Promise<SystemCheck[]> {
    this.running ??= (async () => {
      try {
        const list = await this.systems();
        const urls = new Set(list.map((s) => s.url));
        for (const url of this.history.keys()) if (!urls.has(url)) this.history.delete(url);
        const results = await Promise.all(list.map((s) => this.checkOne(s)));
        this.last = results;
        this.lastAt = this.now();
        return results;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Último resultado; testa de novo se tiver mais de maxAgeMs. */
  async status(maxAgeMs = 5 * 60 * 1000): Promise<SystemCheck[]> {
    if (!this.lastAt || this.now() - this.lastAt > maxAgeMs) return this.checkAll();
    return this.last;
  }

  /** Primeiro teste logo depois de subir e depois a cada 5 minutos. */
  start(everyMs = 5 * 60 * 1000, firstAfterMs = 3_000) {
    if (this.timer) return;
    setTimeout(() => this.checkAll().catch(() => undefined), firstAfterMs).unref();
    this.timer = setInterval(() => this.checkAll().catch(() => undefined), everyMs);
    this.timer.unref();
  }
}
