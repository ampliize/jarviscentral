import { promises as fs } from "node:fs";
import path from "node:path";
import type { Connector } from "../connectors/types.js";
import { toolResult } from "../connectors/types.js";

/**
 * Registro de auditoria: cada ferramenta que o Jarvis usa (o que, com quais
 * parâmetros, se deu certo e quanto tempo levou) vai para
 * DATA_DIR/auditoria/AAAA-MM.jsonl. Responde "o que você fez hoje?".
 */
export interface AuditEntry {
  quando: string;
  ferramenta: string;
  parametros: Record<string, unknown>;
  ok: boolean;
  ms: number;
}

const MAX_ARG_CHARS = 200;
/** Campos que nunca vão para o registro, nem cortados. */
const SECRET_KEY_RE = /token|senha|password|secret|chave|api[_-]?key|authorization/i;

/** Parâmetros resumidos: textos cortados, nada que pareça segredo. */
export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {}).slice(0, 12)) {
    if (SECRET_KEY_RE.test(k)) { out[k] = "[oculto]"; continue; }
    if (typeof v === "string") out[k] = v.length > MAX_ARG_CHARS ? `${v.slice(0, MAX_ARG_CHARS)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = JSON.stringify(v).slice(0, MAX_ARG_CHARS);
  }
  return out;
}

export class AuditLog {
  private readonly dir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private readonly now: () => Date = () => new Date()) {
    this.dir = path.join(dataDir, "auditoria");
  }

  private fileFor(d: Date) {
    return path.join(this.dir, `${d.toISOString().slice(0, 7)}.jsonl`);
  }

  record(entry: Omit<AuditEntry, "quando">): Promise<void> {
    const at = this.now();
    const line = JSON.stringify({ quando: at.toISOString(), ...entry, parametros: summarizeArgs(entry.parametros) }) + "\n";
    // Em fila: duas ferramentas ao mesmo tempo não embaralham as linhas.
    this.queue = this.queue
      .then(() => fs.mkdir(this.dir, { recursive: true }))
      .then(() => fs.appendFile(this.fileFor(at), line))
      .catch((err) => console.error("auditoria: falha ao gravar:", err instanceof Error ? err.message : err));
    return this.queue;
  }

  /** Últimas entradas (mais novas primeiro), dos últimos `days` dias. */
  async recent(days = 1, limit = 200): Promise<AuditEntry[]> {
    await this.queue;
    const now = this.now();
    const since = now.getTime() - days * 86_400_000;
    // Todos os meses da janela (30 dias podem atravessar três meses).
    const months = new Set<string>();
    for (let t = since; t <= now.getTime() + 86_400_000; t += 86_400_000) months.add(this.fileFor(new Date(Math.min(t, now.getTime()))));
    const lines: AuditEntry[] = [];
    for (const file of months) {
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      for (const l of raw.split("\n")) {
        if (!l.trim()) continue;
        try {
          const e = JSON.parse(l) as AuditEntry;
          if (Date.parse(e.quando) >= since) lines.push(e);
        } catch {}
      }
    }
    return lines.sort((a, b) => b.quando.localeCompare(a.quando)).slice(0, limit);
  }
}

/** Embrulha as ferramentas dos conectores para registrar cada uso. */
export function withAudit(connectors: Connector[], audit: AuditLog): Connector[] {
  return connectors.map((c) => ({
    ...c,
    tools: c.tools.map((t) => ({
      ...t,
      run: async (args: Record<string, unknown>) => {
        const started = Date.now();
        let ok = false;
        try {
          const r = await t.run(args);
          ok = r.ok;
          return r;
        } finally {
          void audit.record({ ferramenta: t.name, parametros: args, ok, ms: Date.now() - started });
        }
      },
    })),
  }));
}

export function auditConnector(audit: AuditLog): Connector {
  return {
    id: "auditoria",
    name: "Auditoria do Jarvis",
    description: "Registro de tudo o que o Jarvis consultou ou fez (ferramenta, parâmetros, resultado).",
    tools: [
      {
        name: "auditoria_listar",
        description: "O que o Jarvis fez nos últimos dias: cada ferramenta usada, com parâmetros resumidos, se deu certo e quando. Use em 'o que você fez hoje?', 'o que você consultou?'.",
        parameters: {
          type: "object",
          properties: { dias: { type: "number", description: "Quantos dias para trás (1 a 30)." } },
          required: ["dias"],
          additionalProperties: false,
        },
        run: async (args) => {
          const dias = Math.min(30, Math.max(1, Math.floor(Number(args.dias) || 1)));
          const list = (await audit.recent(dias, 80)).filter((e) => e.ferramenta !== "auditoria_listar");
          return toolResult(true, list.length ? list : { resultado: "nada registrado no período" });
        },
      },
    ],
  };
}
