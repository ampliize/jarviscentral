import { promises as fs } from "node:fs";
import path from "node:path";
import type { Action, Keyword, Level, SearchCampaign } from "./actions.js";
import { AdsError, type AdsClient, type StatsLevel, type StatsRow, type TargetInfo, dateRange, rates } from "./types.js";

/**
 * Google Ads pela API REST (googleads.googleapis.com), sem SDK.
 *
 * - Credenciais da aplicação nas variáveis do Easypanel (developer token,
 *   OAuth client id/secret, id da conta). O refresh token vem do botão
 *   "Conectar Google Ads" no HUD (login do Google) e fica em DATA_DIR.
 * - Toda escrita passa antes por validateOnly (a própria API confere a ação
 *   sem aplicar) e é atômica: ou entra tudo, ou nada.
 */

export interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  /** Conta de anúncios (só números). */
  customerId: string;
  /** Conta administradora (MCC) usada no login, se houver. */
  loginCustomerId: string | null;
  apiVersion: string;
}

const API = "https://googleads.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/adwords";
/** Português (languageConstants). */
const LANGUAGE_PT = "languageConstants/1014";

const MATCH: Record<Keyword["correspondencia"], string> = { ampla: "BROAD", frase: "PHRASE", exata: "EXACT" };
const micros = (reais: number) => String(Math.round(reais * 100) * 10_000);
const reais = (m: unknown) => Math.round(Number(m ?? 0) / 10_000) / 100;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

export class GoogleAds implements AdsClient {
  readonly platform = "google" as const;
  private tokenFile: string;
  private access: { token: string; until: number } | null = null;

  constructor(
    private readonly cfg: GoogleAdsConfig,
    dataDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.tokenFile = path.join(dataDir, "trafego-google.json");
  }

  private get cid() {
    return this.cfg.customerId;
  }

  private async storedRefresh(): Promise<string | null> {
    const raw = await fs.readFile(this.tokenFile, "utf8").catch(() => "");
    try {
      const t = raw ? (JSON.parse(raw) as { refresh_token?: string }).refresh_token : null;
      return typeof t === "string" && t ? t : null;
    } catch {
      return null;
    }
  }

  private async refreshToken(): Promise<string | null> {
    return this.storedRefresh();
  }

  async status() {
    const refresh = await this.refreshToken();
    return { configurado: true, conectado: !!refresh, conta: this.cid.replace(/^(\d{3})(\d{3})(\d+)$/, "$1-$2-$3") };
  }

  async ready() {
    return !!(await this.refreshToken());
  }

  // ------------------------------------------------------------ OAuth (botão "Conectar Google Ads")

  authUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Troca o código do login pelo refresh token e guarda em DATA_DIR (só o servidor lê). */
  async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || typeof body.refresh_token !== "string") {
      throw new AdsError(body.error_description || body.error || "O Google não devolveu o acesso. Tente conectar de novo.");
    }
    await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
    await fs.writeFile(this.tokenFile, JSON.stringify({ refresh_token: body.refresh_token, conectado_em: new Date().toISOString() }), { mode: 0o600 });
    this.access = null;
  }

  async disconnect() {
    await fs.rm(this.tokenFile, { force: true });
    this.access = null;
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const refresh = await this.refreshToken();
    if (!refresh) throw new AdsError("Google Ads não conectado: toque em \"Conectar Google Ads\" no HUD (Tráfego).");
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: refresh, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || typeof body.access_token !== "string") {
      if (body.error === "invalid_grant") throw new AdsError("O acesso ao Google Ads expirou ou foi revogado: conecte de novo no HUD.");
      throw new AdsError("Não consegui autenticar no Google Ads (confira GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET).");
    }
    this.access = { token: body.access_token, until: Date.now() + Math.max(60, Number(body.expires_in) - 120) * 1000 };
    return this.access.token;
  }

  private async call(pathPart: string, body: Json): Promise<Json> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "developer-token": this.cfg.developerToken,
      "Content-Type": "application/json",
    };
    if (this.cfg.loginCustomerId) headers["login-customer-id"] = this.cfg.loginCustomerId;
    const res = await this.fetchImpl(`${API}/${this.cfg.apiVersion}/${pathPart}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok) throw new AdsError(googleError(res.status, json));
    return json;
  }

  private async search(query: string, maxPages = 5): Promise<Json[]> {
    const rows: Json[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const out = await this.call(`customers/${this.cid}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) });
      rows.push(...((out.results as Json[]) ?? []));
      pageToken = out.nextPageToken;
      if (!pageToken) break;
    }
    return rows;
  }

  async mutate(operations: Json[], validateOnly: boolean): Promise<Json> {
    return this.call(`customers/${this.cid}/googleAds:mutate`, { mutateOperations: operations, partialFailure: false, validateOnly });
  }

  /** Nomes de cidades/estados → ids de segmentação do Google (Brasil). */
  async resolveLocations(names: string[]): Promise<Array<{ nome: string; id: string }>> {
    const out = await this.call("geoTargetConstants:suggest", { locale: "pt", countryCode: "BR", locationNames: { names } });
    const found: Array<{ nome: string; id: string }> = [];
    const missing: string[] = [];
    for (const name of names) {
      const s = ((out.geoTargetConstantSuggestions as Json[]) ?? []).find(
        (x) => String(x.searchTerm ?? "").toLowerCase() === name.toLowerCase() && x.geoTargetConstant?.status === "ENABLED",
      );
      if (s) found.push({ nome: String(s.geoTargetConstant.canonicalName ?? name), id: String(s.geoTargetConstant.resourceName) });
      else missing.push(name);
    }
    if (missing.length) throw new AdsError(`O Google não reconheceu estes locais: ${missing.join(", ")}. Use o nome da cidade ou do estado (ex.: "Aracaju", "Sergipe").`);
    return found;
  }

  // ------------------------------------------------------------ leitura

  async stats(level: StatsLevel, days: number, timeZone: string): Promise<StatsRow[]> {
    const { since, until } = dateRange(days, timeZone);
    const during = `segments.date BETWEEN '${since}' AND '${until}'`;
    const metrics = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions";
    const row = (r: Json, base: Omit<StatsRow, "gasto" | "impressoes" | "cliques" | "conversoes" | "ctr" | "cpc" | "custo_por_conversao">): StatsRow => {
      const gasto = reais(r.metrics?.costMicros);
      const cliques = Number(r.metrics?.clicks ?? 0);
      const impressoes = Number(r.metrics?.impressions ?? 0);
      const conversoes = Math.round(Number(r.metrics?.conversions ?? 0) * 100) / 100;
      return { ...base, gasto, impressoes, cliques, conversoes, ...rates(gasto, impressoes, cliques, conversoes) };
    };
    if (level === "campanha") {
      const rows = await this.search(
        `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, ${metrics} FROM campaign WHERE campaign.status != 'REMOVED' AND ${during} ORDER BY metrics.cost_micros DESC LIMIT 100`,
      );
      return rows.map((r) => row(r, { plataforma: "google", nivel: "campanha", id: String(r.campaign?.id), nome: r.campaign?.name ?? "", status: r.campaign?.status ?? "", orcamento_dia: reais(r.campaignBudget?.amountMicros) }));
    }
    if (level === "grupo") {
      const rows = await this.search(
        `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, ${metrics} FROM ad_group WHERE ad_group.status != 'REMOVED' AND ${during} ORDER BY metrics.cost_micros DESC LIMIT 200`,
      );
      return rows.map((r) => row(r, { plataforma: "google", nivel: "grupo", id: String(r.adGroup?.id), nome: r.adGroup?.name ?? "", status: r.adGroup?.status ?? "", campanha: `${r.campaign?.name} (${r.campaign?.id})` }));
    }
    if (level === "anuncio") {
      const rows = await this.search(
        `SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group.id, ad_group.name, campaign.name, ${metrics} FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND ${during} ORDER BY metrics.cost_micros DESC LIMIT 200`,
      );
      return rows.map((r) =>
        row(r, {
          plataforma: "google",
          nivel: "anuncio",
          id: `${r.adGroup?.id}~${r.adGroupAd?.ad?.id}`,
          nome: `Anúncio ${r.adGroupAd?.ad?.id}`,
          status: `${r.adGroupAd?.status ?? ""}${r.adGroupAd?.policySummary?.approvalStatus ? ` · ${r.adGroupAd.policySummary.approvalStatus}` : ""}`,
          campanha: r.campaign?.name,
          grupo: `${r.adGroup?.name} (${r.adGroup?.id})`,
        }),
      );
    }
    if (level === "palavras") {
      const rows = await this.search(
        `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group.id, ad_group.name, ${metrics} FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED' AND ${during} ORDER BY metrics.cost_micros DESC LIMIT 200`,
      );
      return rows.map((r) =>
        row(r, {
          plataforma: "google",
          nivel: "palavras",
          id: String(r.adGroupCriterion?.criterionId),
          nome: `${r.adGroupCriterion?.keyword?.text} [${r.adGroupCriterion?.keyword?.matchType}]`,
          status: r.adGroupCriterion?.status ?? "",
          grupo: `${r.adGroup?.name} (${r.adGroup?.id})`,
        }),
      );
    }
    // termos: o que as pessoas pesquisaram de fato (base das negativas)
    const rows = await this.search(
      `SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, ${metrics} FROM search_term_view WHERE ${during} ORDER BY metrics.cost_micros DESC LIMIT 200`,
    );
    return rows.map((r) =>
      row(r, {
        plataforma: "google",
        nivel: "termos",
        id: String(r.adGroup?.id ?? ""),
        nome: String(r.searchTermView?.searchTerm ?? ""),
        status: r.searchTermView?.status ?? "",
        campanha: `${r.campaign?.name} (${r.campaign?.id})`,
      }),
    );
  }

  async target(level: Level, id: string): Promise<TargetInfo | null> {
    if (level === "campanha") {
      const [r] = await this.search(`SELECT campaign.id, campaign.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${Number(id)}`, 1);
      return r ? { nome: r.campaign?.name ?? null, orcamento_dia: reais(r.campaignBudget?.amountMicros), compartilhado: r.campaignBudget?.explicitlyShared === true } : null;
    }
    if (level === "grupo") {
      const [r] = await this.search(`SELECT ad_group.id, ad_group.name, campaign_budget.amount_micros FROM ad_group WHERE ad_group.id = ${Number(id)}`, 1);
      return r ? { nome: r.adGroup?.name ?? null, orcamento_dia: reais(r.campaignBudget?.amountMicros) } : null;
    }
    const [groupId, adId] = id.split("~");
    const [r] = await this.search(
      `SELECT ad_group_ad.ad.id, ad_group.name, campaign_budget.amount_micros FROM ad_group_ad WHERE ad_group.id = ${Number(groupId)} AND ad_group_ad.ad.id = ${Number(adId)}`,
      1,
    );
    return r ? { nome: `Anúncio ${adId} em ${r.adGroup?.name}`, orcamento_dia: reais(r.campaignBudget?.amountMicros) } : null;
  }

  // ------------------------------------------------------------ escrita

  /** Operações da ação no formato do googleAds:mutate (com ids temporários negativos). */
  async operations(a: Action): Promise<Json[]> {
    const cid = this.cid;
    switch (a.tipo) {
      case "criar_campanha_pesquisa":
        return searchCampaignOps(cid, a.campanha);
      case "alterar_orcamento": {
        const [r] = await this.search(`SELECT campaign_budget.resource_name, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${Number(a.id)}`, 1);
        if (!r?.campaignBudget?.resourceName) throw new AdsError(`Campanha ${a.id} não encontrada no Google Ads.`);
        if (r.campaignBudget.explicitlyShared) throw new AdsError("Esse orçamento é compartilhado com outras campanhas: mude pelo Google Ads.");
        return [{ campaignBudgetOperation: { update: { resourceName: r.campaignBudget.resourceName, amountMicros: micros(a.novo_orcamento_dia) }, updateMask: "amountMicros" } }];
      }
      case "pausar":
      case "ativar": {
        const status = a.tipo === "pausar" ? "PAUSED" : "ENABLED";
        if (a.nivel === "campanha") return [{ campaignOperation: { update: { resourceName: `customers/${cid}/campaigns/${a.id}`, status }, updateMask: "status" } }];
        if (a.nivel === "grupo") return [{ adGroupOperation: { update: { resourceName: `customers/${cid}/adGroups/${a.id}`, status }, updateMask: "status" } }];
        return [{ adGroupAdOperation: { update: { resourceName: `customers/${cid}/adGroupAds/${a.id}`, status }, updateMask: "status" } }];
      }
      case "adicionar_palavras_chave":
        return a.palavras.map((k) => ({
          adGroupCriterionOperation: { create: { adGroup: `customers/${cid}/adGroups/${a.grupo_id}`, status: "ENABLED", keyword: { text: k.texto, matchType: MATCH[k.correspondencia] } } },
        }));
      case "adicionar_negativas":
        return a.palavras.map((k) => ({
          campaignCriterionOperation: { create: { campaign: `customers/${cid}/campaigns/${a.campanha_id}`, negative: true, keyword: { text: k.texto, matchType: MATCH[k.correspondencia] } } },
        }));
      default:
        throw new AdsError("Ação não suportada no Google Ads.");
    }
  }

  async preflight(a: Action): Promise<void> {
    await this.mutate(await this.operations(a), true);
  }

  async execute(a: Action): Promise<string> {
    const out = await this.mutate(await this.operations(a), false);
    const names = ((out.mutateOperationResponses as Json[]) ?? [])
      .map((r) => Object.values(r)[0] as Json)
      .map((v) => String(v?.resourceName ?? ""))
      .filter(Boolean);
    if (a.tipo === "criar_campanha_pesquisa") {
      const campaign = names.find((n) => /\/campaigns\/\d+$/.test(n));
      return campaign ? `Campanha criada: id ${campaign.split("/").pop()}${a.campanha.iniciar_ativa ? " (ativa)" : " (pausada)"}.` : "Campanha criada.";
    }
    return `${names.length} alteração(ões) aplicada(s) no Google Ads.`;
  }
}

/** Monta a campanha de pesquisa inteira numa operação atômica. */
export function searchCampaignOps(cid: string, c: SearchCampaign): Json[] {
  const budget = `customers/${cid}/campaignBudgets/-1`;
  const campaign = `customers/${cid}/campaigns/-2`;
  const group = `customers/${cid}/adGroups/-3`;
  const bidding =
    c.lance === "maximizar_conversoes" ? { maximizeConversions: {} } : c.lance === "cpc_manual" ? { manualCpc: { enhancedCpcEnabled: false } } : { targetSpend: {} };
  const ops: Json[] = [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${c.nome} · orçamento ${Date.now()}`, amountMicros: micros(c.orcamento_dia), deliveryMethod: "STANDARD", explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: c.nome,
          status: c.iniciar_ativa ? "ENABLED" : "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: budget,
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          ...bidding,
        },
      },
    },
    { campaignCriterionOperation: { create: { campaign, language: { languageConstant: LANGUAGE_PT } } } },
    ...(c.locais_ids ?? []).map((l) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: l.id } } } })),
    ...c.negativas.map((k) => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: k.texto, matchType: MATCH[k.correspondencia] } } } })),
    {
      adGroupOperation: {
        create: {
          resourceName: group,
          name: c.grupo,
          campaign,
          status: "ENABLED",
          type: "SEARCH_STANDARD",
          ...(c.lance === "cpc_manual" && c.cpc_max ? { cpcBidMicros: micros(c.cpc_max) } : {}),
        },
      },
    },
    ...c.palavras_chave.map((k) => ({ adGroupCriterionOperation: { create: { adGroup: group, status: "ENABLED", keyword: { text: k.texto, matchType: MATCH[k.correspondencia] } } } })),
    {
      adGroupAdOperation: {
        create: {
          adGroup: group,
          status: "ENABLED",
          ad: {
            finalUrls: [c.anuncio.url_final],
            responsiveSearchAd: {
              headlines: c.anuncio.titulos.map((text) => ({ text })),
              descriptions: c.anuncio.descricoes.map((text) => ({ text })),
              ...(c.anuncio.caminho1 ? { path1: c.anuncio.caminho1 } : {}),
              ...(c.anuncio.caminho2 ? { path2: c.anuncio.caminho2 } : {}),
            },
          },
        },
      },
    },
  ];
  if (!c.locais_ids?.length) throw new AdsError("Os locais da campanha não foram resolvidos no Google.");
  return ops;
}

/** Mensagem de erro curta e útil a partir do erro da API do Google Ads. */
function googleError(status: number, json: Json): string {
  const details = ((json.error?.details as Json[]) ?? []).flatMap((d) => (d.errors as Json[]) ?? []);
  const msgs = [...new Set(details.map((e) => String(e.message ?? "")).filter(Boolean))].slice(0, 3);
  if (status === 401) return "O Google Ads recusou o acesso: conecte de novo no HUD.";
  if (status === 403) {
    if (/DEVELOPER_TOKEN|developer token/i.test(JSON.stringify(json))) return "O developer token ainda não foi aprovado para esta conta (GOOGLE_ADS_DEVELOPER_TOKEN).";
    return `Sem permissão nesta conta do Google Ads${msgs.length ? `: ${msgs.join(" · ")}` : ""}. Confira GOOGLE_ADS_CUSTOMER_ID e GOOGLE_ADS_LOGIN_CUSTOMER_ID.`;
  }
  if (status === 404) return "Versão da API do Google Ads indisponível: atualize GOOGLE_ADS_API_VERSION.";
  return msgs.length ? `Google Ads: ${msgs.join(" · ")}` : `Google Ads respondeu ${status}: ${String(json.error?.message ?? "erro").slice(0, 200)}`;
}

