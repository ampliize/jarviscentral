import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
  tools?: Array<{ name: string; ok: boolean }>;
}

const ID_RE = /^[0-9a-f-]{36}$/;

/**
 * Histórico de conversas em arquivos JSONL (um por conversa) em
 * DATA_DIR/conversations. Simples de fazer backup e de inspecionar.
 */
export class ConversationStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "conversations");
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  newId() {
    return randomUUID();
  }

  isValidId(id: unknown): id is string {
    return typeof id === "string" && ID_RE.test(id);
  }

  private file(id: string) {
    if (!this.isValidId(id)) throw new Error("id de conversa inválido");
    return path.join(this.dir, `${id}.jsonl`);
  }

  async append(id: string, turn: StoredTurn) {
    await this.init();
    await fs.appendFile(this.file(id), `${JSON.stringify(turn)}\n`, "utf8");
  }

  async read(id: string): Promise<StoredTurn[]> {
    const raw = await fs.readFile(this.file(id), "utf8").catch(() => "");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as StoredTurn];
        } catch {
          return [];
        }
      });
  }

  /** Últimas trocas para dar contexto ao modelo (sem estourar tokens). */
  async recent(id: string, maxTurns = 20): Promise<StoredTurn[]> {
    return (await this.read(id)).slice(-maxTurns);
  }

  async list(limit = 50) {
    await this.init();
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".jsonl"));
    const items = await Promise.all(
      files.map(async (f) => {
        const full = path.join(this.dir, f);
        const stat = await fs.stat(full);
        const first = (await fs.readFile(full, "utf8")).split("\n")[0] ?? "";
        let title = "";
        try {
          title = (JSON.parse(first) as StoredTurn).content.slice(0, 80);
        } catch {
          title = "";
        }
        return { id: f.replace(/\.jsonl$/, ""), updatedAt: stat.mtime.toISOString(), title };
      }),
    );
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }
}
