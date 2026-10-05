import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Action, ActionType, Grant, Platform } from "./actions.js";

/**
 * Fila de aprovação do agente de tráfego, em DATA_DIR/trafego.json.
 *
 * pendente → (dono aprova | permissão cobre) → executando → executada | falhou
 * pendente → recusada | expirada (48 h sem decisão: o cenário muda)
 */

export type ProposalStatus = "pendente" | "executando" | "executada" | "falhou" | "recusada" | "expirada";

export type Origin = "agente" | "hud";

export interface Proposal {
  id: string;
  plataforma: Platform;
  tipo: ActionType;
  acao: Action;
  resumo: string;
  motivo: string;
  origem: Origin;
  status: ProposalStatus;
  criada_em: string;
  /** Última mudança de status (cursor dos avisos). */
  atualizada_em: string;
  expira_em: string;
  /** "dono" (HUD ou WhatsApp) ou "permissao:<id>". */
  decidida_por?: string;
  decidida_em?: string;
  motivo_recusa?: string;
  /** Resultado da plataforma (ids criados) ou erro. */
  resultado?: string;
  /** Aumento de gasto diário que a ação pode causar (R$). */
  aumento_dia: number;
}

interface Saved {
  propostas: Proposal[];
  permissoes: Grant[];
  /** Ações automáticas por permissão no dia (teto max_por_dia). */
  automaticas?: { dia: string; por_permissao: Record<string, number> };
}

const PROPOSAL_ID_RE = /^a_[a-f0-9]{12}$/;
const GRANT_ID_RE = /^p_[a-f0-9]{12}$/;
export const isProposalId = (v: unknown): v is string => typeof v === "string" && PROPOSAL_ID_RE.test(v);
export const isGrantId = (v: unknown): v is string => typeof v === "string" && GRANT_ID_RE.test(v);

const MAX_PROPOSALS = 500;
const MAX_PENDING = 30;
export const PROPOSAL_TTL_MS = 48 * 3600_000;

export class TrafficError extends Error {}

export class TrafficStore {
  private file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "trafego.json");
  }

  private async load(): Promise<Saved> {
    const raw = await fs.readFile(this.file, "utf8").catch(() => "");
    if (!raw) return { propostas: [], permissoes: [] };
    try {
      const d = JSON.parse(raw) as Partial<Saved>;
      return {
        propostas: Array.isArray(d.propostas) ? d.propostas : [],
        permissoes: Array.isArray(d.permissoes) ? d.permissoes : [],
        ...(d.automaticas ? { automaticas: d.automaticas } : {}),
      };
    } catch {
      await fs.copyFile(this.file, `${this.file}.corrompido-${Date.now()}`).catch(() => {});
      return { propostas: [], permissoes: [] };
    }
  }

  private async save(data: Saved) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, this.file);
  }

  private mutate<T>(fn: (data: Saved) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const data = await this.load();
      const out = await fn(data);
      await this.save(data);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Marca como expiradas as pendentes vencidas (na leitura, sem agendador). */
  private expire(data: Saved, now: Date) {
    let changed = false;
    for (const p of data.propostas) {
      if (p.status === "pendente" && Date.parse(p.expira_em) <= now.getTime()) {
        p.status = "expirada";
        p.atualizada_em = now.toISOString();
        changed = true;
      }
    }
    return changed;
  }

  /** Leitura; só grava quando alguma pendente acabou de expirar. */
  async snapshot(now = new Date()): Promise<Saved> {
    await this.queue.catch(() => {});
    const data = await this.load();
    if (!data.propostas.some((p) => p.status === "pendente" && Date.parse(p.expira_em) <= now.getTime())) return data;
    return this.mutate((d) => {
      this.expire(d, now);
      return structuredClone(d);
    });
  }

  async add(input: Omit<Proposal, "id" | "status" | "criada_em" | "atualizada_em" | "expira_em">, now = new Date()): Promise<Proposal> {
    return this.mutate((data) => {
      this.expire(data, now);
      if (data.propostas.filter((p) => p.status === "pendente").length >= MAX_PENDING) {
        throw new TrafficError(`Já existem ${MAX_PENDING} propostas esperando decisão: aprove ou recuse antes de propor mais.`);
      }
      // Carimbo na hora da gravação (a proposta passou segundos na plataforma
      // antes daqui): um cursor de avisos lido nesse meio-tempo não a pula.
      const at = new Date(Math.max(now.getTime(), Date.now()));
      const p: Proposal = {
        ...input,
        id: `a_${randomBytes(6).toString("hex")}`,
        status: "pendente",
        criada_em: at.toISOString(),
        atualizada_em: at.toISOString(),
        expira_em: new Date(at.getTime() + PROPOSAL_TTL_MS).toISOString(),
      };
      data.propostas.unshift(p);
      data.propostas.splice(MAX_PROPOSALS);
      return structuredClone(p);
    });
  }

  async get(id: string, now = new Date()): Promise<Proposal | null> {
    const d = await this.snapshot(now);
    return d.propostas.find((p) => p.id === id) ?? null;
  }

  /**
   * Passa a proposta de pendente para executando (uma vez só: dois "aprovar"
   * seguidos não executam duas vezes). Devolve null se não estava pendente.
   */
  async claim(id: string, by: string, now = new Date()): Promise<Proposal | null> {
    return this.mutate((data) => {
      this.expire(data, now);
      const p = data.propostas.find((x) => x.id === id);
      if (!p || p.status !== "pendente") return null;
      p.status = "executando";
      p.decidida_por = by;
      p.decidida_em = now.toISOString();
      p.atualizada_em = now.toISOString();
      return structuredClone(p);
    });
  }

  async finish(id: string, ok: boolean, resultado: string, now = new Date()) {
    await this.mutate((data) => {
      const p = data.propostas.find((x) => x.id === id);
      if (!p) return;
      p.status = ok ? "executada" : "falhou";
      p.resultado = resultado.slice(0, 600);
      p.atualizada_em = new Date(Math.max(now.getTime(), Date.now(), Date.parse(p.atualizada_em))).toISOString();
    });
  }

  async reject(id: string, motivo: string, now = new Date()): Promise<Proposal | null> {
    return this.mutate((data) => {
      this.expire(data, now);
      const p = data.propostas.find((x) => x.id === id);
      if (!p || p.status !== "pendente") return null;
      p.status = "recusada";
      p.decidida_por = "dono";
      p.decidida_em = now.toISOString();
      p.motivo_recusa = motivo.slice(0, 300) || undefined;
      p.atualizada_em = now.toISOString();
      return structuredClone(p);
    });
  }

  /** Propostas que mudaram depois de `since` (avisos do HUD e do WhatsApp). */
  async changedSince(since: Date, now = new Date()): Promise<Proposal[]> {
    const d = await this.snapshot(now);
    return d.propostas.filter((p) => Date.parse(p.atualizada_em) > since.getTime()).sort((a, b) => a.atualizada_em.localeCompare(b.atualizada_em));
  }

  async addGrant(g: Omit<Grant, "id" | "criada_em">, now = new Date()): Promise<Grant> {
    return this.mutate((data) => {
      // Mesma permissão de novo: renova (troca a antiga).
      data.permissoes = data.permissoes.filter((x) => x.preset !== g.preset);
      const grant: Grant = { ...g, id: `p_${randomBytes(6).toString("hex")}`, criada_em: now.toISOString() };
      data.permissoes.push(grant);
      return structuredClone(grant);
    });
  }

  async removeGrant(ref: string): Promise<boolean> {
    return this.mutate((data) => {
      const before = data.permissoes.length;
      data.permissoes = ref === "todas" ? [] : data.permissoes.filter((g) => g.id !== ref && g.preset !== ref);
      return data.permissoes.length < before;
    });
  }

  /** Reserva uma execução automática no teto diário da permissão. */
  async takeAuto(grant: Grant, day: string): Promise<boolean> {
    return this.mutate((data) => {
      if (data.automaticas?.dia !== day) data.automaticas = { dia: day, por_permissao: {} };
      const used = data.automaticas.por_permissao[grant.id] ?? 0;
      if (used >= grant.max_por_dia) return false;
      data.automaticas.por_permissao[grant.id] = used + 1;
      return true;
    });
  }
}
