import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Riscos em aberto da operação (segurança, sistemas, entregas…), registrados
 * no vault em _jarvis/alertas.md, uma linha por risco:
 *
 *   - [ ] crítico | bate-ponto | Dados abertos para qualquer pessoa | desde 2026-09-30 | ação: fechar acesso anon
 *
 * Marcou [x], o risco sai do monitor. O Jarvis lê, lembra no "bom dia" e
 * responde "quais riscos temos?"; ele não resolve nada sozinho.
 */
export type Severity = "critico" | "alto" | "medio" | "baixo";

export interface Alert {
  nivel: Severity;
  sistema: string;
  descricao: string;
  desde: string | null;
  acao: string | null;
  resolvido: boolean;
}

const ORDER: Record<Severity, number> = { critico: 0, alto: 1, medio: 2, baixo: 3 };

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** "crítico", "🔴", "alto", "🟠", "médio", "🟡", "baixo", "🟢" → nível. */
export function parseSeverity(text: string): Severity | null {
  const t = normalize(text);
  if (/🔴|critic/.test(t)) return "critico";
  if (/🟠|alto|alta/.test(t)) return "alto";
  if (/🟡|medi/.test(t)) return "medio";
  if (/🟢|baix/.test(t)) return "baixo";
  return null;
}

export function parseAlerts(markdown: string): Alert[] {
  const out: Alert[] = [];
  for (const raw of markdown.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(raw);
    if (!m) continue;
    // Tira só a marcação de negrito/código (mantém o "_" de nomes como kb_itens).
    const cells = m[2]!.split("|").map((c) => c.replace(/\*\*|`/g, "").trim()).filter(Boolean);
    const nivel = cells.length > 1 ? parseSeverity(cells[0]!) : null;
    // "🟡 Zyron | ...": o nível e o sistema podem vir na mesma coluna.
    const leftover = nivel ? cells[0]!.replace(/🔴|🟠|🟡|🟢/gu, "").replace(/^\s*(cr[ií]tic[oa]|alt[oa]|m[eé]di[oa]|baix[oa])\b/i, "").trim() : "";
    const body = nivel ? (leftover ? [leftover, ...cells.slice(1)] : cells.slice(1)) : cells;
    // Uma coluna só: é a descrição, de um risco "geral". Sem nível: médio.
    const [sistema, descricao, ...rest] = body.length === 1 ? ["geral", body[0]!] : body;
    if (!sistema || !descricao) continue;
    const desde = rest.map((c) => /(\d{4}-\d{2}-\d{2})/.exec(c)?.[1]).find(Boolean) ?? null;
    const acao = rest.find((c) => /^a[cç][aã]o\s*:/i.test(c))?.replace(/^a[cç][aã]o\s*:\s*/i, "") ?? rest.find((c) => !/\d{4}-\d{2}-\d{2}/.test(c)) ?? null;
    out.push({ nivel: nivel ?? "medio", sistema: sistema.slice(0, 80), descricao: descricao.slice(0, 300), desde, acao: acao ? acao.slice(0, 300) : null, resolvido: m[1] !== " " });
  }
  return out;
}

export class AlertBook {
  private readonly file: string;

  constructor(brainRoot: string) {
    this.file = path.join(brainRoot, "_jarvis", "alertas.md");
  }

  /** Riscos em aberto, do mais grave ao mais leve (e do mais antigo ao mais novo). */
  async open(): Promise<Alert[]> {
    const st = await fs.lstat(this.file).catch(() => null);
    if (!st?.isFile()) return [];
    const list = parseAlerts(await fs.readFile(this.file, "utf8").catch(() => ""));
    return list
      .filter((a) => !a.resolvido)
      .sort((a, b) => ORDER[a.nivel] - ORDER[b.nivel] || (a.desde ?? "9").localeCompare(b.desde ?? "9"));
  }
}
