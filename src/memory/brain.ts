import { promises as fs } from "node:fs";
import path from "node:path";
import { toolResult, type Connector } from "../connectors/types.js";
import type { BrainGit } from "./brainGit.js";

/**
 * Memória do Jarvis: um vault de Markdown (compatível com Obsidian) em
 * DATA_DIR/brain. Arquivos .md comuns — legíveis, versionáveis em git e sem
 * formato proprietário ("memória blindada").
 *
 * O Jarvis só escreve em brain/inbox/: são propostas de nota que você revisa
 * e move para a pasta certa no Obsidian. As pastas curadas (clientes,
 * decisoes, processos, reunioes...) só são lidas.
 */
const MAX_NOTE_CHARS = 8_000;
const MAX_FILES_SCANNED = 2_000;

const slugify = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "nota";

export const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

async function listMarkdown(dir: string, acc: string[] = []): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES_SCANNED) break;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listMarkdown(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

export interface SearchHit {
  path: string;
  score: number;
  snippet: string;
}

const MAX_CONTEXT_CHARS = 4_000;

export class Brain {
  readonly root: string;
  /** Sincronização com o vault do Obsidian (Git). Null = memória só local. */
  git: BrainGit | null = null;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "brain");
  }

  /**
   * Contexto permanente escrito por você em _jarvis/contexto.md (vai em toda
   * conversa). Comentários HTML do modelo são ignorados.
   */
  async context(): Promise<string> {
    const raw = await fs.readFile(path.join(this.root, "_jarvis", "contexto.md"), "utf8").catch(() => "");
    const text = raw
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^#\s*Contexto permanente\s*$/im, "")
      .trim();
    return text.slice(0, MAX_CONTEXT_CHARS);
  }

  async init() {
    await fs.mkdir(path.join(this.root, "inbox"), { recursive: true });
  }

  /** Todos os itens "- [ ]" ainda abertos em pendencias.md (texto limpo, sem Markdown). */
  async pendencias(limit = 500): Promise<string[]> {
    const raw = await fs.readFile(path.join(this.root, "pendencias.md"), "utf8").catch(() => "");
    return raw
      .split("\n")
      .map((line) => /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line)?.[1] ?? "")
      .map((text) =>
        text
          .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, target: string, alias: string) => alias || target)
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/[*_`]/g, "")
          .trim(),
      )
      .filter(Boolean)
      .slice(0, limit);
  }

  /** Notas na inbox/ esperando revisão. */
  async inboxCount(): Promise<number> {
    const entries = await fs.readdir(path.join(this.root, "inbox")).catch(() => [] as string[]);
    return entries.filter((name) => name.endsWith(".md")).length;
  }

  /** Busca por palavras-chave (sem acento, sem caixa). Suficiente até termos embeddings. */
  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const terms = normalize(query)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);
    if (!terms.length) return [];
    const files = await listMarkdown(this.root);
    const hits: SearchHit[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, "utf8").catch(() => "");
      const lower = normalize(content);
      const name = normalize(path.basename(file));
      let score = 0;
      for (const term of terms) {
        const inBody = lower.split(term).length - 1;
        score += inBody + (name.includes(term) ? 3 : 0);
      }
      if (score === 0) continue;
      // Termo só no nome do arquivo: mostra o começo da nota.
      const positions = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
      const first = positions.length ? Math.min(...positions) : 0;
      const start = Math.max(0, first - 200);
      hits.push({ path: path.relative(this.root, file), score, snippet: content.slice(start, start + 700).trim() });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Grava uma proposta de nota em inbox/ (nunca sobrescreve). */
  async propose(title: string, body: string, tags: string[] = []): Promise<string> {
    await this.init();
    const date = new Date().toISOString().slice(0, 10);
    const base = `${date}-${slugify(title)}`;
    let file = path.join(this.root, "inbox", `${base}.md`);
    for (let i = 2; await fs.stat(file).then(() => true, () => false); i++) {
      file = path.join(this.root, "inbox", `${base}-${i}.md`);
    }
    const safeTags = tags.map((t) => slugify(t)).filter(Boolean);
    const frontmatter = [
      "---",
      `titulo: ${JSON.stringify(title.slice(0, 120))}`,
      "fonte: jarvis",
      `criado: ${new Date().toISOString()}`,
      `tags: [${safeTags.join(", ")}]`,
      "status: proposta",
      "---",
      "",
    ].join("\n");
    await fs.writeFile(file, `${frontmatter}${body.slice(0, MAX_NOTE_CHARS)}\n`, { flag: "wx" });
    return path.relative(this.root, file);
  }

  /** Envia a nota para o vault (se o Git estiver configurado). Nunca derruba a resposta. */
  async sync(message: string): Promise<{ sincronizado: boolean; erro?: string }> {
    if (!this.git) return { sincronizado: false };
    try {
      await this.git.commitAndPush(message);
      return { sincronizado: true };
    } catch (err) {
      const erro = err instanceof Error ? err.message : "falha no git";
      console.error("cérebro: envio falhou:", erro);
      return { sincronizado: false, erro };
    }
  }
}

/** Ferramentas de memória para o modelo. */
export function memoryConnector(brain: Brain): Connector {
  return {
    id: "memoria",
    name: "Memória (Obsidian)",
    description: "Notas em Markdown: contexto de clientes, decisões, processos e reuniões.",
    tools: [
      {
        name: "memoria_buscar",
        description:
          "Busca nas notas da memória (vault Obsidian) por contexto que não está no banco: combinados com clientes, decisões, preferências, processos. Cite o caminho da nota usada.",
        parameters: {
          type: "object",
          properties: { consulta: { type: "string", description: "Palavras-chave da busca." } },
          required: ["consulta"],
          additionalProperties: false,
        },
        run: async (args) => {
          const hits = await brain.search(String(args.consulta ?? ""));
          return toolResult(true, hits.length ? hits : { resultado: "nenhuma nota encontrada" });
        },
      },
      {
        name: "memoria_anotar",
        description:
          "Guarda uma nota nova na caixa de entrada da memória (inbox) para revisão humana. Use SOMENTE quando o usuário pedir explicitamente para anotar, lembrar ou registrar algo.",
        parameters: {
          type: "object",
          properties: {
            titulo: { type: "string", description: "Título curto da nota." },
            conteudo: { type: "string", description: "Conteúdo em Markdown." },
            tags: { type: "array", items: { type: "string" }, description: "Tags (ex.: cliente, decisao)." },
          },
          required: ["titulo", "conteudo", "tags"],
          additionalProperties: false,
        },
        run: async (args) => {
          const file = await brain.propose(
            String(args.titulo ?? "nota"),
            String(args.conteudo ?? ""),
            Array.isArray(args.tags) ? args.tags.map(String) : [],
          );
          const sync = await brain.sync(`Jarvis: nota ${file}`);
          return toolResult(true, {
            gravado_em: file,
            enviado_ao_obsidian: sync.sincronizado,
            observacao: sync.sincronizado
              ? "Nota na inbox do vault; aparece no Obsidian na próxima sincronização."
              : "Nota salva só no servidor (sincronização com o Obsidian não configurada ou falhou).",
          });
        },
      },
    ],
  };
}
