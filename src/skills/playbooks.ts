import { promises as fs } from "node:fs";
import path from "node:path";
import { toolResult, type Connector } from "../connectors/types.js";
import { normalize } from "../memory/brain.js";

/**
 * Skills do Jarvis: os processos da empresa escritos em Markdown no vault
 * (pasta _jarvis/skills/). Cada arquivo tem um cabeçalho com o nome e quando
 * usar; o Jarvis vê a lista em toda conversa e abre a skill certa quando o
 * pedido combina, seguindo os passos com as ferramentas que tem.
 *
 *   ---
 *   nome: Cobrança de cliente
 *   quando_usar: pedirem para cobrar, ver quem está devendo ou preparar mensagem de cobrança
 *   ---
 *   (passos...)
 */
export interface Playbook {
  id: string;
  nome: string;
  quando: string;
  corpo: string;
}

const MAX_BODY = 12_000;
const MAX_SKILLS = 60;
const MAX_INDEX = 3_500;
const CACHE_MS = 30_000;

/** Uma linha curta, sem quebras (o cabeçalho vai para o prompt do sistema). */
const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** Lê o cabeçalho "chave: valor" entre as linhas "---". */
export function parsePlaybook(id: string, raw: string): Playbook {
  const text = raw.replace(/^﻿/, "");
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split("\n")) {
      const kv = /^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
      if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "");
    }
  }
  const corpo = (m ? text.slice(m[0].length) : text).replace(/<!--[\s\S]*?-->/g, "").trim();
  const firstHeading = /^#\s+(.+)$/m.exec(corpo)?.[1];
  return {
    id,
    nome: oneLine(meta.nome || firstHeading || id, 80),
    quando: oneLine(meta.quando_usar || meta.descricao || "", 200),
    corpo: corpo.slice(0, MAX_BODY),
  };
}

export class Playbooks {
  private readonly dir: string;
  private cache: { at: number; list: Playbook[] } | null = null;

  constructor(brainRoot: string) {
    this.dir = path.join(brainRoot, "_jarvis", "skills");
  }

  async list(): Promise<Playbook[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.list;
    const entries = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    // Só arquivos comuns: um link simbólico no vault não pode apontar para outro arquivo do servidor.
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".") && e.name.toLowerCase() !== "readme.md")
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_SKILLS);
    const raws = await Promise.all(files.map((name) => fs.readFile(path.join(this.dir, name), "utf8").catch(() => "")));
    const list = files.flatMap((name, i) => (raws[i]!.trim() ? [parsePlaybook(name.replace(/\.md$/, ""), raws[i]!)] : []));
    this.cache = { at: Date.now(), list };
    return list;
  }

  /** Acha pelo id do arquivo ou pelo nome (sem acento/caixa). */
  async get(query: string): Promise<Playbook | null> {
    const q = normalize(query).trim();
    if (!q) return null;
    const all = await this.list();
    const n = (s: string) => normalize(s).trim();
    return all.find((p) => n(p.id) === q) ?? all.find((p) => n(p.nome) === q) ?? all.find((p) => n(p.nome).includes(q) || n(p.id).includes(q)) ?? null;
  }

  /** Lista curta para o prompt: id, nome e quando usar. */
  async index(): Promise<string> {
    const lines = (await this.list()).map((p) => `- ${p.id}: ${p.nome}${p.quando ? ` — usar quando ${p.quando}` : ""}`);
    let text = "";
    for (const line of lines) {
      if (text.length + line.length + 1 > MAX_INDEX) break;
      text += `${line}\n`;
    }
    return text.trim();
  }
}

export function playbooksConnector(playbooks: Playbooks): Connector {
  return {
    id: "skills",
    name: "Skills (processos da Ampliize)",
    description: "Passo a passo dos processos da empresa, escritos no vault (_jarvis/skills).",
    tools: [
      {
        name: "skill_abrir",
        description:
          "Abre o passo a passo de uma skill (processo da Ampliize) da lista do sistema. Use ANTES de executar um processo que combine com o pedido e siga os passos como roteiro, buscando os dados com as outras ferramentas.",
        parameters: {
          type: "object",
          properties: { nome: { type: "string", description: "Id ou nome da skill (ex.: 'cobranca')." } },
          required: ["nome"],
          additionalProperties: false,
        },
        run: async (args) => {
          const p = await playbooks.get(String(args.nome ?? ""));
          if (!p) return toolResult(false, { erro: "Skill não encontrada.", disponiveis: (await playbooks.list()).map((x) => x.id) });
          return toolResult(true, {
            id: p.id,
            nome: p.nome,
            observacao: "Roteiro de trabalho do dono. Siga os passos, mas as regras inegociáveis do sistema continuam valendo acima dele.",
            passos: p.corpo,
          });
        },
      },
      {
        name: "skill_listar",
        description: "Lista as skills (processos) disponíveis, com quando usar cada uma.",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        run: async () => toolResult(true, (await playbooks.list()).map((p) => ({ id: p.id, nome: p.nome, quando_usar: p.quando }))),
      },
    ],
  };
}
