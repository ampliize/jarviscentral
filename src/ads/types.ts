import type { Action, Level, Platform } from "./actions.js";

export class AdsError extends Error {}

/** Níveis de leitura. "palavras" e "termos" (o que as pessoas pesquisaram) só no Google. */
export type StatsLevel = "campanha" | "grupo" | "conjunto" | "anuncio" | "palavras" | "termos";

export interface StatsRow {
  plataforma: Platform;
  nivel: StatsLevel;
  id: string;
  nome: string;
  status: string;
  campanha?: string;
  grupo?: string;
  orcamento_dia?: number | null;
  gasto: number;
  impressoes: number;
  cliques: number;
  /** Google: conversões; Meta: conversas iniciadas no WhatsApp/Messenger. */
  conversoes: number;
  ctr: number | null;
  cpc: number | null;
  custo_por_conversao: number | null;
}

export interface TargetInfo {
  nome: string | null;
  /** Orçamento diário que vale para o item (o próprio ou o do nível de cima). */
  orcamento_dia: number | null;
  /** O item tem orçamento próprio (dá para mudar nele)? */
  orcamento_proprio?: boolean;
  /** Google: orçamento compartilhado entre campanhas. */
  compartilhado?: boolean;
}

/** O que o agente precisa de cada plataforma (permite plataformas falsas nos testes). */
export interface AdsClient {
  platform: Platform;
  ready(): Promise<boolean>;
  status(): Promise<{ configurado: boolean; conectado: boolean; conta: string }>;
  stats(level: StatsLevel, days: number, timeZone: string): Promise<StatsRow[]>;
  target(level: Level, id: string): Promise<TargetInfo | null>;
  /** Conferência na própria plataforma sem aplicar (quando ela oferece). */
  preflight?(a: Action): Promise<void>;
  execute(a: Action): Promise<string>;
  resolveLocations?(names: string[]): Promise<Array<{ nome: string; id: string }>>;
}

/** Últimos `days` dias até hoje (inclusive), no fuso da conta. */
export function dateRange(days: number, timeZone: string, now = new Date()) {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  const until = fmt(now);
  const since = fmt(new Date(Date.parse(`${until}T12:00:00Z`) - (Math.max(1, days) - 1) * 86_400_000));
  return { since, until };
}

/** CTR, CPC e custo por conversão a partir dos totais (mesma regra nas duas plataformas). */
export function rates(gasto: number, impressoes: number, cliques: number, conversoes: number) {
  return {
    ctr: impressoes ? Math.round((cliques / impressoes) * 10_000) / 100 : null,
    cpc: cliques ? Math.round((gasto / cliques) * 100) / 100 : null,
    custo_por_conversao: conversoes ? Math.round((gasto / conversoes) * 100) / 100 : null,
  };
}
