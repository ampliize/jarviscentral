import {
  ActionError,
  GRANT_PRESETS,
  brl,
  dailySpendIncrease,
  describeAction,
  grantBlocks,
  kw,
  parseAction,
  presetById,
  type Action,
  type Grant,
  type Limits,
  type Platform,
} from "./actions.js";
import { type Origin, type Proposal, TrafficError, type TrafficStore } from "./store.js";
import { AdsError, type AdsClient, type StatsLevel, type StatsRow } from "./types.js";

/**
 * O agente de tráfego: propõe, o dono decide, o Jarvis executa.
 *
 * - Toda proposta é validada (limites, teto de orçamento) e conferida na
 *   própria plataforma antes de chegar ao dono (Google: validateOnly).
 * - Sem permissão do dono, nada é aplicado: a proposta espera "aprovar" no
 *   HUD ou no WhatsApp. Com permissão (preset escolhido pelo dono), roda
 *   sozinha dentro dos limites e o dono é avisado depois.
 * - A IA não tem ferramenta para aprovar nem para dar permissão.
 */

export interface TrafficOptions {
  limits: Limits;
  timeZone: string;
  /** Validade padrão das permissões, em dias. */
  grantDays: number;
}

export interface ProposalView {
  id: string;
  plataforma: Platform;
  tipo: string;
  resumo: string;
  detalhes: string[];
  motivo: string;
  origem: Origin;
  status: Proposal["status"];
  criada_em: string;
  atualizada_em: string;
  expira_em: string;
  decidida_por: string | null;
  resultado: string | null;
  motivo_recusa: string | null;
  aumento_dia: number;
}

/** Linhas de detalhe para o dono revisar antes de aprovar. */
export function detailLines(a: Action): string[] {
  if (a.tipo === "criar_campanha_pesquisa") {
    const c = a.campanha;
    const lance = c.lance === "cpc_manual" ? `CPC manual até ${brl(c.cpc_max ?? 0)}` : c.lance === "maximizar_conversoes" ? "maximizar conversões" : "maximizar cliques";
    return [
      `Orçamento: ${brl(c.orcamento_dia)}/dia · lance: ${lance}`,
      `Locais: ${(c.locais_ids?.map((l) => l.nome) ?? c.locais).join("; ")}`,
      `Palavras-chave (${c.palavras_chave.length}): ${c.palavras_chave.map(kw).join(", ")}`,
      ...(c.negativas.length ? [`Negativas (${c.negativas.length}): ${c.negativas.map(kw).join(", ")}`] : []),
      `Títulos: ${c.anuncio.titulos.join(" | ")}`,
      `Descrições: ${c.anuncio.descricoes.join(" | ")}`,
      `Página: ${c.anuncio.url_final}`,
      c.iniciar_ativa ? `Começa a rodar assim que for criada (gasta até ${brl(c.orcamento_dia)}/dia).` : "Nasce PAUSADA: só gasta depois de ativada.",
    ];
  }
  if (a.tipo === "adicionar_palavras_chave" || a.tipo === "adicionar_negativas") return [a.palavras.map(kw).join(", ")];
  return [];
}

export class TrafficManager {
  constructor(
    private readonly store: TrafficStore,
    private readonly clients: Partial<Record<Platform, AdsClient>>,
    private readonly opts: TrafficOptions,
  ) {}

  get limits() {
    return this.opts.limits;
  }

  private client(p: Platform): AdsClient {
    const c = this.clients[p];
    if (!c) {
      throw new AdsError(
        p === "google"
          ? "Google Ads não configurado: faltam GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET e GOOGLE_ADS_CUSTOMER_ID no Easypanel."
          : "Meta Ads não configurado: faltam META_ADS_ACCESS_TOKEN e META_ADS_ACCOUNT_ID no Easypanel.",
      );
    }
    return c;
  }

  view(p: Proposal): ProposalView {
    return {
      id: p.id,
      plataforma: p.plataforma,
      tipo: p.tipo,
      resumo: p.resumo,
      detalhes: detailLines(p.acao),
      motivo: p.motivo,
      origem: p.origem,
      status: p.status,
      criada_em: p.criada_em,
      atualizada_em: p.atualizada_em,
      expira_em: p.expira_em,
      decidida_por: p.decidida_por ?? null,
      resultado: p.resultado ?? null,
      motivo_recusa: p.motivo_recusa ?? null,
      aumento_dia: p.aumento_dia,
    };
  }

  async overview(now = new Date()) {
    const data = await this.store.snapshot(now);
    const plataformas: Record<string, unknown> = {};
    for (const p of ["google", "meta"] as Platform[]) {
      const c = this.clients[p];
      plataformas[p] = c ? await c.status().catch(() => ({ configurado: true, conectado: false, conta: "" })) : { configurado: false, conectado: false, conta: "" };
    }
    const ativas = data.permissoes.filter((g) => !g.expira_em || Date.parse(g.expira_em) > now.getTime());
    return {
      plataformas,
      teto_orcamento_dia: this.opts.limits.maxDailyBudget,
      pendentes: data.propostas.filter((p) => p.status === "pendente").map((p) => this.view(p)),
      recentes: data.propostas.filter((p) => p.status !== "pendente").slice(0, 15).map((p) => this.view(p)),
      permissoes: ativas,
      presets: GRANT_PRESETS.map((g) => ({ preset: g.preset, titulo: g.titulo, explicacao: g.explicacao, ativa: ativas.some((a) => a.preset === g.preset) })),
    };
  }

  async stats(plataforma: Platform, nivel: StatsLevel, dias: number): Promise<StatsRow[]> {
    const c = this.client(plataforma);
    if (!(await c.ready())) throw new AdsError("Google Ads não conectado: toque em \"Conectar Google Ads\" no HUD (Tráfego).");
    return c.stats(nivel, Math.min(90, Math.max(1, Math.round(dias) || 7)), this.opts.timeZone);
  }

  /** Completa a ação com o estado atual (nome, orçamento) e confere na plataforma. */
  private async prepare(a: Action, c: AdsClient): Promise<Action> {
    if (a.tipo === "criar_campanha_pesquisa") {
      if (!c.resolveLocations) throw new AdsError("Plataforma sem segmentação por local.");
      return { ...a, campanha: { ...a.campanha, locais_ids: await c.resolveLocations(a.campanha.locais) } };
    }
    const level = a.tipo === "adicionar_palavras_chave" ? "grupo" : a.tipo === "adicionar_negativas" ? "campanha" : a.nivel;
    const id = a.tipo === "adicionar_palavras_chave" ? a.grupo_id : a.tipo === "adicionar_negativas" ? a.campanha_id : a.id;
    const info = await c.target(level, id);
    if (!info) throw new AdsError(`Não encontrei ${level} ${id} na conta.`);
    const nome = info.nome ?? undefined;
    if (a.tipo === "alterar_orcamento") {
      if (info.compartilhado) throw new AdsError("Esse orçamento é compartilhado com outras campanhas: mude pelo Google Ads.");
      if (info.orcamento_proprio === false) {
        throw new ActionError(a.nivel === "campanha" ? "Essa campanha não tem orçamento próprio: o orçamento está nos conjuntos." : "Esse conjunto não tem orçamento próprio: o orçamento está na campanha.");
      }
      if (info.orcamento_dia != null && Math.abs(info.orcamento_dia - a.novo_orcamento_dia) < 0.01) throw new ActionError(`O orçamento já é ${brl(a.novo_orcamento_dia)}.`);
      return { ...a, nome, antes: info.orcamento_dia };
    }
    if (a.tipo === "ativar") return { ...a, nome, orcamento_dia: info.orcamento_dia };
    return { ...a, nome };
  }

  private today(now: Date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.opts.timeZone }).format(now);
  }

  /**
   * Cria a proposta. Se uma permissão do dono cobrir a ação, executa na hora;
   * senão fica pendente esperando o "aprovar".
   */
  async propose(tipo: unknown, raw: Record<string, unknown>, motivo: unknown, origem: Origin, now = new Date()): Promise<ProposalView> {
    const why = String(motivo ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (why.length < 10) throw new ActionError("Explique o motivo da proposta (com os números que justificam).");
    const parsed = parseAction(tipo, raw, this.opts.limits);
    const c = this.client(parsed.plataforma);
    if (!(await c.ready())) throw new AdsError("Google Ads não conectado: toque em \"Conectar Google Ads\" no HUD (Tráfego).");
    const action = await this.prepare(parsed, c);
    if (c.preflight) await c.preflight(action);
    const proposal = await this.store.add(
      { plataforma: action.plataforma, tipo: action.tipo, acao: action, resumo: describeAction(action), motivo: why, origem, aumento_dia: dailySpendIncrease(action) },
      now,
    );
    const grant = await this.coveringGrant(action, now);
    if (grant) {
      const done = await this.run(proposal.id, `permissao:${grant.id}`, now);
      if (done) return this.view(done);
    }
    return this.view(proposal);
  }

  private async coveringGrant(a: Action, now: Date): Promise<Grant | null> {
    const data = await this.store.snapshot(now);
    const checked = a.tipo === "alterar_orcamento" ? { ...a, antes: this.dayBase(data.propostas, a, now) } : a;
    for (const g of data.permissoes) {
      if (grantBlocks(g, checked, now)) continue;
      if (await this.store.takeAuto(g, this.today(now))) return g;
    }
    return null;
  }

  /**
   * Orçamento de referência do dia para a permissão de "até X%": o valor de
   * antes da primeira mudança automática de hoje (depois da última que o dono
   * aprovou). Assim 20% + 20% + 20% no mesmo dia não passam sem aprovação.
   */
  private dayBase(all: Proposal[], a: Extract<Action, { tipo: "alterar_orcamento" }>, now: Date): number | null | undefined {
    const today = this.today(now);
    // A lista vem da mais nova para a mais velha: no empate de horário, a mais velha primeiro.
    const sameTarget = all
      .map((p, i) => ({ p, i }))
      .filter(
        ({ p }) =>
          p.status === "executada" &&
          p.acao.tipo === "alterar_orcamento" &&
          p.acao.plataforma === a.plataforma &&
          p.acao.id === a.id &&
          p.decidida_em &&
          this.today(new Date(p.decidida_em)) === today,
      )
      .sort((x, y) => x.p.decidida_em!.localeCompare(y.p.decidida_em!) || y.i - x.i)
      .map(({ p }) => p);
    const lastOwner = sameTarget.map((p) => p.decidida_por).lastIndexOf("dono");
    const autos = sameTarget.slice(lastOwner + 1);
    const first = autos[0]?.acao;
    return first && first.tipo === "alterar_orcamento" && first.antes != null ? first.antes : a.antes;
  }

  /** Executa a proposta pendente (uma vez só). null = não estava pendente. */
  private async run(id: string, by: string, now = new Date()): Promise<Proposal | null> {
    const p = await this.store.claim(id, by, now);
    if (!p) return null;
    try {
      const out = await this.client(p.plataforma).execute(p.acao);
      await this.store.finish(id, true, out);
    } catch (err) {
      await this.store.finish(id, false, err instanceof Error ? err.message : "falhou");
    }
    return this.store.get(id);
  }

  async approve(id: string, now = new Date()): Promise<ProposalView> {
    const current = await this.store.get(id, now);
    if (!current) throw new TrafficError("Proposta não encontrada.");
    if (current.status !== "pendente") throw new TrafficError(`Essa proposta já está ${current.status}.`);
    const done = await this.run(id, "dono", now);
    if (!done) throw new TrafficError("Essa proposta já foi decidida.");
    return this.view(done);
  }

  async reject(id: string, motivo: string, now = new Date()): Promise<ProposalView> {
    const p = await this.store.reject(id, motivo, now);
    if (!p) {
      const current = await this.store.get(id, now);
      throw new TrafficError(current ? `Essa proposta já está ${current.status}.` : "Proposta não encontrada.");
    }
    return this.view(p);
  }

  async proposal(id: string): Promise<ProposalView | null> {
    const p = await this.store.get(id);
    return p ? this.view(p) : null;
  }

  async list(status: "pendente" | "todas" = "pendente", limit = 20): Promise<ProposalView[]> {
    const data = await this.store.snapshot();
    return data.propostas.filter((p) => status === "todas" || p.status === status).slice(0, limit).map((p) => this.view(p));
  }

  /** Permissão escolhida pelo dono (HUD ou WhatsApp). */
  async grant(preset: string, days?: number, now = new Date()): Promise<Grant> {
    const p = presetById(preset);
    if (!p) throw new TrafficError(`Permissão desconhecida: use ${GRANT_PRESETS.map((g) => g.preset).join(", ")}.`);
    const d = Math.min(90, Math.max(1, Math.round(days ?? this.opts.grantDays)));
    return this.store.addGrant(
      {
        preset: p.preset,
        titulo: p.titulo,
        tipos: p.tipos,
        plataforma: "todas",
        max_variacao_pct: p.max_variacao_pct,
        max_orcamento_dia: p.usa_teto ? this.opts.limits.maxDailyBudget : null,
        max_por_dia: p.max_por_dia,
        expira_em: new Date(now.getTime() + d * 86_400_000).toISOString(),
      },
      now,
    );
  }

  async revoke(ref: string): Promise<boolean> {
    return this.store.removeGrant(ref);
  }

  /** O que mudou desde o cursor: proposta nova pedindo decisão, executada, falhou. */
  async notices(since: Date, now = new Date()) {
    const changed = await this.store.changedSince(since, now);
    const relevant = changed.filter((p) => p.status === "pendente" || p.status === "executada" || p.status === "falhou");
    const agora = changed.length ? changed[changed.length - 1]!.atualizada_em : since.toISOString();
    return { propostas: relevant.map((p) => this.view(p)), agora };
  }
}
