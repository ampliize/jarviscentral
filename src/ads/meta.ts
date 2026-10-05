import type { Action, Level } from "./actions.js";
import { AdsError, type AdsClient, type StatsLevel, type StatsRow, type TargetInfo, dateRange, rates } from "./types.js";

/**
 * Meta Ads (Facebook/Instagram) pela Graph API, com o token de um usuário do
 * sistema do Business Manager (META_ADS_ACCESS_TOKEN, nas variáveis do
 * Easypanel). Leitura de desempenho; escrita: pausar, ativar e orçamento.
 * Criar campanha no Meta exige criativo (imagem/vídeo): fica com o time.
 */

export interface MetaAdsConfig {
  accessToken: string;
  /** Conta de anúncios, só os números (sem "act_"). */
  accountId: string;
  apiVersion: string;
}

const GRAPH = "https://graph.facebook.com";
/**
 * Ações que contam como conversa/lead (Click-to-WhatsApp e formulários).
 * Só "lead": o Meta repete os mesmos leads em onsite_conversion.lead_grouped.
 */
const CONVERSION_ACTIONS = new Set(["onsite_conversion.messaging_conversation_started_7d", "lead"]);
/** Campos que só existem no nível certo: um id de outro nível ou de outra conta não passa. */
const TARGET_FIELDS: Record<string, string> = {
  campanha: "name,account_id,objective,daily_budget",
  conjunto: "name,account_id,campaign_id,daily_budget,campaign{daily_budget}",
  anuncio: "name,account_id,adset_id,adset{daily_budget},campaign{daily_budget}",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

const centsToReais = (v: unknown) => (v == null || v === "" ? null : Math.round(Number(v)) / 100);

export class MetaAds implements AdsClient {
  readonly platform = "meta" as const;

  constructor(
    private readonly cfg: MetaAdsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ready() {
    return true;
  }

  async status() {
    return { configurado: true, conectado: true, conta: `act_${this.cfg.accountId}` };
  }

  private async request(method: "GET" | "POST", pathPart: string, params: Record<string, string> = {}): Promise<Json> {
    const url = new URL(`${GRAPH}/${this.cfg.apiVersion}/${pathPart}`);
    const init: RequestInit = { method, headers: { Authorization: `Bearer ${this.cfg.accessToken}` }, signal: AbortSignal.timeout(45_000) };
    if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    else init.body = new URLSearchParams(params);
    const res = await this.fetchImpl(url, init);
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      if (e.code === 190) throw new AdsError("O token do Meta expirou ou é inválido (META_ADS_ACCESS_TOKEN).");
      if (e.code === 200 || e.code === 10) throw new AdsError("O token do Meta não tem permissão nesta conta (ads_management / ads_read).");
      throw new AdsError(`Meta Ads: ${String(e.error_user_msg || e.message || `HTTP ${res.status}`).slice(0, 240)}`);
    }
    return json;
  }

  private async list(pathPart: string, params: Record<string, string>, maxPages = 5): Promise<Json[]> {
    const out: Json[] = [];
    let after: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.request("GET", pathPart, { ...params, limit: "200", ...(after ? { after } : {}) });
      out.push(...((page.data as Json[]) ?? []));
      after = page.paging?.next ? page.paging?.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  async stats(level: StatsLevel, days: number, timeZone: string): Promise<StatsRow[]> {
    if (level === "palavras" || level === "termos" || level === "grupo") {
      throw new AdsError(level === "grupo" ? "No Meta use o nível conjunto." : "Palavras-chave e termos de pesquisa só existem no Google.");
    }
    const act = `act_${this.cfg.accountId}`;
    const { since, until } = dateRange(days, timeZone);
    const apiLevel = level === "campanha" ? "campaign" : level === "conjunto" ? "adset" : "ad";
    const objects = await this.list(`${act}/${apiLevel === "campaign" ? "campaigns" : apiLevel === "adset" ? "adsets" : "ads"}`, {
      fields: apiLevel === "ad" ? "id,name,effective_status,adset{name},campaign{name}" : `id,name,effective_status,daily_budget${apiLevel === "adset" ? ",campaign{name}" : ""}`,
    });
    const insights = await this.list(`${act}/insights`, {
      level: apiLevel,
      fields: `${apiLevel}_id,spend,impressions,clicks,actions`,
      time_range: JSON.stringify({ since, until }),
    });
    const byId = new Map(insights.map((r) => [String(r[`${apiLevel}_id`]), r]));
    return objects
      .map((o): StatsRow => {
        const r = byId.get(String(o.id)) ?? {};
        const gasto = Math.round(Number(r.spend ?? 0) * 100) / 100;
        const impressoes = Number(r.impressions ?? 0);
        const cliques = Number(r.clicks ?? 0);
        const conversoes = ((r.actions as Json[]) ?? []).filter((a) => CONVERSION_ACTIONS.has(String(a.action_type))).reduce((acc, a) => acc + Number(a.value ?? 0), 0);
        return {
          plataforma: "meta",
          nivel: level,
          id: String(o.id),
          nome: String(o.name ?? ""),
          status: String(o.effective_status ?? ""),
          ...(o.campaign?.name ? { campanha: String(o.campaign.name) } : {}),
          ...(o.adset?.name ? { grupo: String(o.adset.name) } : {}),
          ...(apiLevel !== "ad" ? { orcamento_dia: centsToReais(o.daily_budget) } : {}),
          gasto,
          impressoes,
          cliques,
          conversoes,
          ...rates(gasto, impressoes, cliques, conversoes),
        };
      })
      .sort((a, b) => b.gasto - a.gasto);
  }

  /**
   * O item, se for da conta configurada e do nível pedido (null = não é).
   * Protege contas de clientes que o mesmo token alcance.
   */
  async target(level: Level, id: string): Promise<TargetInfo | null> {
    const fields = TARGET_FIELDS[level];
    if (!fields) return null;
    let o: Json;
    try {
      o = await this.request("GET", id, { fields });
    } catch (err) {
      // Id inexistente ou de outro nível (campo que não existe nele): não é o item pedido.
      if (err instanceof AdsError && !/token|permissão/.test(err.message)) return null;
      throw err;
    }
    if (String(o.account_id ?? "") !== this.cfg.accountId) return null;
    const own = centsToReais(o.daily_budget);
    const parent = centsToReais(o.adset?.daily_budget) ?? centsToReais(o.campaign?.daily_budget);
    return { nome: o.name ?? null, orcamento_dia: own ?? parent, orcamento_proprio: own != null };
  }

  async execute(a: Action): Promise<string> {
    if (a.plataforma !== "meta") throw new AdsError("Ação de outra plataforma.");
    if (a.tipo !== "pausar" && a.tipo !== "ativar" && a.tipo !== "alterar_orcamento") {
      throw new AdsError("No Meta, o agente só pausa, ativa e muda orçamento. Criação de campanha fica com o time.");
    }
    // Confere de novo na hora de aplicar: conta e nível certos.
    const info = await this.target(a.nivel, a.id);
    if (!info) throw new AdsError(`O item ${a.id} não é da conta de anúncios configurada (act_${this.cfg.accountId}).`);
    if (a.tipo === "alterar_orcamento") {
      if (!info.orcamento_proprio) throw new AdsError(a.nivel === "campanha" ? "Essa campanha não tem orçamento próprio: o orçamento está nos conjuntos." : "Esse conjunto não tem orçamento diário próprio.");
      await this.request("POST", a.id, { daily_budget: String(Math.round(a.novo_orcamento_dia * 100)) });
      return "Orçamento atualizado no Meta Ads.";
    }
    await this.request("POST", a.id, { status: a.tipo === "pausar" ? "PAUSED" : "ACTIVE" });
    return `${a.tipo === "pausar" ? "Pausado" : "Ativado"} no Meta Ads.`;
  }
}
