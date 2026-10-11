import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ActionError, grantBlocks, parseAction, type Action, type Grant } from "../src/ads/actions.js";
import { trafficConnector } from "../src/ads/connector.js";
import { GoogleAds, searchCampaignOps } from "../src/ads/google.js";
import { MetaAds } from "../src/ads/meta.js";
import { TrafficManager } from "../src/ads/service.js";
import { TrafficStore } from "../src/ads/store.js";
import { AdsError, type AdsClient, type StatsRow } from "../src/ads/types.js";
import { missionTools } from "../src/skills/manager.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const TZ = "America/Maceio";
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-trafego-"));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const LIMITS = { maxDailyBudget: 300 };

const campaign = (over: Record<string, unknown> = {}) => ({
  campanha: {
    nome: "Pesquisa · Sites para clínicas",
    orcamento_dia: 50,
    lance: "maximizar_cliques",
    cpc_max: null,
    locais: ["Aracaju"],
    grupo: null,
    palavras_chave: [{ texto: "Site para Clínica", correspondencia: "frase" }, { texto: "site para clínica", correspondencia: "frase" }, { texto: "criar site clínica", correspondencia: "exata" }],
    negativas: [{ texto: "grátis", correspondencia: "ampla" }],
    anuncio: { titulos: ["Sites para Clínicas", "Agende uma Conversa", "Ampliize Marketing"], descricoes: ["Sites rápidos que trazem pacientes.", "Fale com a Ampliize e veja como."], url_final: "https://ampliize.com/clinicas", caminho1: "clinicas", caminho2: null },
    iniciar_ativa: false,
    ...over,
  },
});

/** Plataforma falsa: guarda o que foi executado. */
class FakeAds implements AdsClient {
  executed: Action[] = [];
  preflights = 0;
  budgets = new Map<string, number>([["111", 40], ["222", 100]]);
  failNext = false;
  constructor(readonly platform: "google" | "meta" = "google") {}
  async ready() { return true; }
  async status() { return { configurado: true, conectado: true, conta: "123-456-7890" }; }
  async stats(): Promise<StatsRow[]> { return []; }
  async target(_l: string, id: string) { return this.budgets.has(id) ? { nome: `Campanha ${id}`, orcamento_dia: this.budgets.get(id)! } : null; }
  async preflight() { this.preflights++; }
  async resolveLocations(names: string[]) { return names.map((n) => ({ nome: `${n}, Sergipe, Brasil`, id: "geoTargetConstants/1001773" })); }
  async execute(a: Action) {
    if (this.failNext) { this.failNext = false; throw new AdsError("recusado pela plataforma"); }
    this.executed.push(a);
    return "ok";
  }
}

async function manager() {
  const dir = await tmp();
  const fake = new FakeAds();
  const store = new TrafficStore(dir);
  return { fake, store, traffic: new TrafficManager(store, { google: fake }, { limits: LIMITS, timeZone: TZ, grantDays: 30 }) };
}

test("tráfego: valida a ação (teto, títulos, palavras, ids) antes de chegar ao dono", () => {
  const a = parseAction("criar_campanha_pesquisa", campaign(), LIMITS);
  assert.equal(a.tipo, "criar_campanha_pesquisa");
  if (a.tipo !== "criar_campanha_pesquisa") return;
  // palavras normalizadas e sem repetição
  assert.deepEqual(a.campanha.palavras_chave.map((k) => k.texto), ["site para clínica", "criar site clínica"]);
  assert.equal(a.campanha.iniciar_ativa, false);
  assert.throws(() => parseAction("criar_campanha_pesquisa", campaign({ orcamento_dia: 3000 }), LIMITS), /teto de R\$\s?300,00/);
  assert.throws(() => parseAction("criar_campanha_pesquisa", campaign({ anuncio: { titulos: ["a".repeat(31), "b", "c"], descricoes: ["x", "y"], url_final: "https://a.com" } }), LIMITS), /mais de 30/);
  assert.throws(() => parseAction("criar_campanha_pesquisa", campaign({ anuncio: { titulos: ["a", "b", "c"], descricoes: ["x", "y"], url_final: "http://a.com" } }), LIMITS), /https/);
  assert.throws(() => parseAction("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "abc", novo_orcamento_dia: 10 }, LIMITS), ActionError);
  assert.throws(() => parseAction("pausar", { plataforma: "google", nivel: "anuncio", id: "123" }, LIMITS), /grupo~anuncio/);
  assert.equal(parseAction("pausar", { plataforma: "google", nivel: "anuncio", id: "12~34" }, LIMITS).tipo, "pausar");
  assert.throws(() => parseAction("adicionar_negativas", { plataforma: "meta", campanha_id: "1", palavras: ["x"] }, LIMITS), /só existem no Google/);
  assert.throws(() => parseAction("apagar_tudo", {}, LIMITS), /Tipo de ação inválido/);
});

test("tráfego: permissão cobre só o tipo e os limites que o dono escolheu", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const g: Grant = { id: "p_000000000001", preset: "orcamento20", titulo: "x", tipos: ["alterar_orcamento"], plataforma: "todas", max_variacao_pct: 20, max_orcamento_dia: 300, max_por_dia: 4, criada_em: now.toISOString(), expira_em: "2026-11-01T00:00:00Z" };
  const budget = (antes: number | null, novo: number): Action => ({ tipo: "alterar_orcamento", plataforma: "google", nivel: "campanha", id: "1", antes, novo_orcamento_dia: novo });
  assert.equal(grantBlocks(g, budget(100, 120), now), null);
  assert.equal(grantBlocks(g, budget(100, 80), now), null);
  assert.match(grantBlocks(g, budget(100, 130), now)!, /30%/);
  assert.match(grantBlocks(g, budget(null, 50), now)!, /desconhecido/);
  assert.match(grantBlocks(g, { tipo: "pausar", plataforma: "google", nivel: "campanha", id: "1" }, now)!, /tipo/);
  assert.match(grantBlocks({ ...g, expira_em: "2026-10-01T00:00:00Z" }, budget(100, 110), now)!, /vencida/);
});

test("tráfego: sem permissão a proposta espera o dono; aprovar executa uma vez só; recusar não executa", async () => {
  const { fake, traffic } = await manager();
  const p = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "111", novo_orcamento_dia: 60 }, "CPA de R$ 40 com 12 reuniões em 7 dias", "agente");
  assert.equal(p.status, "pendente");
  assert.match(p.resumo, /de R\$\s?40,00 para R\$\s?60,00/);
  assert.equal(p.aumento_dia, 20);
  assert.equal(fake.executed.length, 0);
  const done = await traffic.approve(p.id);
  assert.equal(done.status, "executada");
  assert.equal(done.decidida_por, "dono");
  await assert.rejects(traffic.approve(p.id), /já está executada/);
  assert.equal(fake.executed.length, 1);

  const q = await traffic.propose("pausar", { plataforma: "google", nivel: "campanha", id: "222" }, "Gastou R$ 300 sem conversão em 7 dias", "agente");
  const rejected = await traffic.reject(q.id, "ainda está aprendendo");
  assert.equal(rejected.status, "recusada");
  await assert.rejects(traffic.approve(q.id), /recusada/);
  assert.equal(fake.executed.length, 1);
  // motivo é obrigatório e o item precisa existir
  await assert.rejects(traffic.propose("pausar", { plataforma: "google", nivel: "campanha", id: "222" }, "curto", "agente"), /motivo/);
  await assert.rejects(traffic.propose("pausar", { plataforma: "google", nivel: "campanha", id: "999" }, "sem resultado na semana", "agente"), /Não encontrei/);
});

test("tráfego: com permissão do dono roda sozinho dentro do limite; fora dele espera", async () => {
  const { fake, traffic } = await manager();
  await traffic.grant("orcamento20");
  const auto = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "222", novo_orcamento_dia: 120 }, "custo por reunião de R$ 35, abaixo da meta", "agente");
  assert.equal(auto.status, "executada");
  assert.match(auto.decidida_por!, /^permissao:p_/);
  const big = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "111", novo_orcamento_dia: 80 }, "custo por reunião de R$ 35, abaixo da meta", "agente");
  assert.equal(big.status, "pendente"); // 100% de aumento: passa dos 20%
  assert.equal(fake.executed.length, 1);
  // revogar volta a exigir aprovação
  assert.equal(await traffic.revoke("orcamento20"), true);
  const after = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "222", novo_orcamento_dia: 110 }, "custo por reunião de R$ 35, abaixo da meta", "agente");
  assert.equal(after.status, "pendente");
});

test("tráfego: teto diário de ações automáticas e falha da plataforma ficam registrados", async () => {
  const { fake, traffic } = await manager();
  await traffic.grant("pausar");
  for (let i = 0; i < 10; i++) assert.equal((await traffic.propose("pausar", { plataforma: "google", nivel: "campanha", id: "111" }, "sem conversão em 7 dias", "agente")).status, "executada");
  assert.equal((await traffic.propose("pausar", { plataforma: "google", nivel: "campanha", id: "111" }, "sem conversão em 7 dias", "agente")).status, "pendente");
  const p = await traffic.propose("pausar", { plataforma: "google", nivel: "campanha", id: "222" }, "sem conversão em 7 dias", "agente");
  fake.failNext = true;
  const failed = await traffic.approve(p.id);
  assert.equal(failed.status, "falhou");
  assert.match(failed.resultado!, /recusado pela plataforma/);
});

test("tráfego: proposta pendente expira em 48 h e os avisos andam com o cursor", async () => {
  const { traffic, store } = await manager();
  const t0 = new Date("2026-10-05T12:00:00Z");
  const p = await traffic.propose("pausar", { plataforma: "google", nivel: "campanha", id: "111" }, "sem conversão em 7 dias", "agente", t0);
  const first = await traffic.notices(new Date("2026-10-05T11:00:00Z"), t0);
  assert.deepEqual(first.propostas.map((x) => x.id), [p.id]);
  const again = await traffic.notices(new Date(first.agora), t0);
  assert.deepEqual(again.propostas, []);
  // O carimbo da proposta usa max(agora, relógio real): a expiração é contada a partir dele.
  const later = new Date(Math.max(t0.getTime(), Date.now()) + 49 * 3600_000);
  assert.equal((await store.get(p.id, later))!.status, "expirada");
  await assert.rejects(traffic.approve(p.id, later), /expirada/);
});

test("tráfego: a IA só lê e propõe (sem ferramenta de aprovar ou dar permissão) e as missões podem propor", async () => {
  const { traffic, fake } = await manager();
  const c = trafficConnector(traffic);
  const names = c.tools.map((t) => t.name);
  assert.ok(names.every((n) => !/aprov|permiss|recus/.test(n)), names.join(","));
  const tool = c.tools.find((t) => t.name === "trafego_propor_status")!;
  const out = await tool.run({ plataforma: "google", acao: "pausar", nivel: "campanha", id: "111", motivo: "gastou R$ 200 sem conversão" });
  assert.equal(out.ok, true);
  assert.match(out.content, /NÃO foi aplicada/);
  assert.match(out.links![0]!.url, /^jarvis:trafego\/a_[a-f0-9]{12}$/);
  assert.equal(fake.executed.length, 0);
  const campaignTool = c.tools.find((t) => t.name === "trafego_propor_campanha_google")!;
  const created = await campaignTool.run({ ...campaign().campanha, titulos: campaign().campanha.anuncio.titulos, descricoes: campaign().campanha.anuncio.descricoes, url_final: "https://ampliize.com/clinicas", caminho1: null, caminho2: null, motivo: "começar o Google com intenção de compra" });
  assert.equal(created.ok, true, created.content);
  assert.equal(fake.preflights, 2);
  const bad = await tool.run({ plataforma: "google", acao: "pausar", nivel: "campanha", id: "999", motivo: "gastou R$ 200 sem conversão" });
  assert.equal(bad.ok, false);
  assert.ok(missionTools([c]).has("trafego_propor_orcamento"));
});

test("google ads: autentica, lê campanhas em reais, confere com validateOnly e cria a campanha numa operação só", async () => {
  const dir = await tmp();
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    calls.push({ url: u, body, headers });
    if (u === "https://oauth2.googleapis.com/token") {
      if (body.grant_type === "authorization_code") return json({ refresh_token: "rt-novo", access_token: "at" });
      return json({ access_token: "at-1", expires_in: 3600 });
    }
    if (u.endsWith("/googleAds:search")) {
      return json({ results: [{ campaign: { id: "111", name: "Clínicas", status: "ENABLED" }, campaignBudget: { amountMicros: "50000000" }, metrics: { costMicros: "123450000", impressions: "1000", clicks: "50", conversions: 5 } }] });
    }
    if (u.endsWith("/geoTargetConstants:suggest")) {
      return json({ geoTargetConstantSuggestions: [{ searchTerm: "Aracaju", geoTargetConstant: { resourceName: "geoTargetConstants/1001773", status: "ENABLED", canonicalName: "Aracaju,State of Sergipe,Brazil" } }] });
    }
    if (u.endsWith("/googleAds:mutate")) {
      return json({ mutateOperationResponses: [{ campaignBudgetResult: { resourceName: "customers/1234567890/campaignBudgets/9" } }, { campaignResult: { resourceName: "customers/1234567890/campaigns/777" } }] });
    }
    return json({}, 404);
  }) as typeof fetch;
  const g = new GoogleAds({ developerToken: "dev", clientId: "cid", clientSecret: "sec", customerId: "1234567890", loginCustomerId: "9999999999", apiVersion: "v22" }, dir, fetchImpl);
  assert.equal(await g.ready(), false);
  await assert.rejects(g.stats("campanha", 7, TZ), /não conectado/);
  await g.exchangeCode("code-1", "https://jarvis.test/oauth/google/callback");
  assert.equal(await g.ready(), true);
  const file = path.join(dir, "trafego-google.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(await readFile(file, "utf8"), /rt-novo/);

  const rows = await g.stats("campanha", 7, TZ);
  assert.deepEqual({ gasto: rows[0]!.gasto, orc: rows[0]!.orcamento_dia, cpc: rows[0]!.cpc, cpa: rows[0]!.custo_por_conversao }, { gasto: 123.45, orc: 50, cpc: 2.47, cpa: 24.69 });
  const search = calls.find((c) => c.url.endsWith("googleAds:search"))!;
  assert.equal(search.url, "https://googleads.googleapis.com/v22/customers/1234567890/googleAds:search");
  assert.equal(search.headers["developer-token"], "dev");
  assert.equal(search.headers["login-customer-id"], "9999999999");
  assert.equal(search.headers.Authorization, "Bearer at-1");
  assert.match(search.body.query, /segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);

  const a = parseAction("criar_campanha_pesquisa", campaign(), LIMITS);
  if (a.tipo !== "criar_campanha_pesquisa") throw new Error();
  a.campanha.locais_ids = await g.resolveLocations(a.campanha.locais);
  await g.preflight(a);
  const pre = calls.filter((c) => c.url.endsWith("googleAds:mutate")).at(-1)!;
  assert.equal(pre.body.validateOnly, true);
  assert.equal(pre.body.partialFailure, false);
  const ops = pre.body.mutateOperations;
  assert.equal(ops[0].campaignBudgetOperation.create.amountMicros, "50000000");
  assert.equal(ops[1].campaignOperation.create.status, "PAUSED");
  assert.deepEqual(ops[1].campaignOperation.create.targetSpend, {});
  assert.equal(ops[1].campaignOperation.create.containsEuPoliticalAdvertising, "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");
  assert.ok(ops.some((o: any) => o.campaignCriterionOperation?.create?.location?.geoTargetConstant === "geoTargetConstants/1001773"));
  assert.ok(ops.some((o: any) => o.campaignCriterionOperation?.create?.negative === true));
  assert.equal(ops.at(-1).adGroupAdOperation.create.ad.responsiveSearchAd.headlines.length, 3);
  const result = await g.execute(a);
  assert.match(result, /Campanha criada: id 777 \(pausada\)/);
  assert.equal(calls.filter((c) => c.url.endsWith("googleAds:mutate")).at(-1)!.body.validateOnly, false);
});

test("google ads: erros da API viram mensagens claras", async () => {
  const dir = await tmp();
  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (String(url).includes("oauth2")) return json({ access_token: "at", expires_in: 3600 });
    return json({ error: { code: 400, message: "Request contains an invalid argument.", details: [{ errors: [{ message: "Too long." }, { message: "Too long." }] }] } }, 400);
  }) as typeof fetch;
  const g = new GoogleAds({ developerToken: "d", clientId: "c", clientSecret: "s", customerId: "1234567890", loginCustomerId: null, apiVersion: "v22" }, dir, fetchImpl);
  await writeFile(path.join(dir, "trafego-google.json"), JSON.stringify({ refresh_token: "rt" }));
  await assert.rejects(g.stats("campanha", 7, TZ), /Google Ads: Too long\.$/);
  assert.throws(() => searchCampaignOps("1", { ...(parseAction("criar_campanha_pesquisa", campaign(), LIMITS) as any).campanha }), /locais/);
});

test("meta ads: junta objetos e insights (gasto, conversas) e pausa/muda orçamento pela Graph API", async () => {
  const calls: Array<{ url: URL; method: string; body: string }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (u.pathname.endsWith("/act_555/campaigns")) return json({ data: [{ id: "10", name: "CTWA Clínicas", effective_status: "ACTIVE", daily_budget: "5000" }] });
    if (u.pathname.endsWith("/act_555/insights")) return json({ data: [{ campaign_id: "10", spend: "80.50", impressions: "4000", clicks: "120", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "7" }, { action_type: "lead", value: "2" }, { action_type: "onsite_conversion.lead_grouped", value: "2" }, { action_type: "link_click", value: "100" }] }] });
    if (u.pathname.endsWith("/10") && (init?.method ?? "GET") === "GET") return json({ id: "10", name: "CTWA Clínicas", account_id: "555", daily_budget: "5000" });
    // campanha de outra conta (cliente) que o mesmo token alcança
    if (u.pathname.endsWith("/20") && (init?.method ?? "GET") === "GET") return json({ id: "20", name: "Cliente X", account_id: "999", daily_budget: "9000" });
    // conjunto sem orçamento próprio (orçamento na campanha)
    if (u.pathname.endsWith("/30") && (init?.method ?? "GET") === "GET") return json({ id: "30", name: "Conjunto A", account_id: "555", campaign: { daily_budget: "20000" } });
    if (u.pathname.endsWith("/10")) return json({ success: true });
    return json({ error: { message: "x" } }, 400);
  }) as typeof fetch;
  const m = new MetaAds({ accessToken: "tok", accountId: "555", apiVersion: "v23.0" }, fetchImpl);
  const [row] = await m.stats("campanha", 7, TZ);
  // conversas + leads, sem contar lead_grouped de novo
  assert.deepEqual({ gasto: row!.gasto, conv: row!.conversoes, orc: row!.orcamento_dia, cpa: row!.custo_por_conversao }, { gasto: 80.5, conv: 9, orc: 50, cpa: 8.94 });
  assert.ok(calls[1]!.url.searchParams.get("time_range")!.includes("since"));
  await m.execute({ tipo: "pausar", plataforma: "meta", nivel: "campanha", id: "10" });
  assert.equal(calls.at(-1)!.body, "status=PAUSED");
  await m.execute({ tipo: "alterar_orcamento", plataforma: "meta", nivel: "campanha", id: "10", novo_orcamento_dia: 65.5 });
  assert.equal(calls.at(-1)!.body, "daily_budget=6550");
  await assert.rejects(m.stats("termos", 7, TZ), /só existem no Google/);
  // outra conta: não encontra e não executa
  assert.equal(await m.target("campanha", "20"), null);
  await assert.rejects(m.execute({ tipo: "pausar", plataforma: "meta", nivel: "campanha", id: "20" }), /não é da conta/);
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.pathname.endsWith("/20")));
  // ativar conjunto mostra o orçamento da campanha; mudar orçamento nele é recusado
  assert.deepEqual(await m.target("conjunto", "30"), { nome: "Conjunto A", orcamento_dia: 200, orcamento_proprio: false });
  await assert.rejects(m.execute({ tipo: "alterar_orcamento", plataforma: "meta", nivel: "conjunto", id: "30", novo_orcamento_dia: 50 }), /orçamento diário próprio/);
  await assert.rejects(m.execute({ tipo: "adicionar_negativas", plataforma: "google", campanha_id: "1", palavras: [] } as Action), /outra plataforma/);
});

test("tráfego (API): exige token, aprova pelo HUD, permissão por preset e login do Google com state de uso único", async () => {
  const dataDir = await tmp();
  const fake = new FakeAds();
  const app = await createApp({
    config: loadConfig({
      JARVIS_ACCESS_TOKEN: TOKEN,
      DATA_DIR: dataDir,
      OPENAI_API_KEY: "sk-test",
      JARVIS_PUBLIC_URL: "https://jarvis.test",
      GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
      GOOGLE_ADS_CLIENT_ID: "cid",
      GOOGLE_ADS_CLIENT_SECRET: "sec",
      GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
    }),
    noScheduler: true,
    adsClients: { google: fake },
    fetchImpl: (async () => json({}, 404)) as typeof fetch,
  });
  assert.equal((await app.request("/api/trafego")).status, 401);
  const tools = trafficConnector(new TrafficManager(new TrafficStore(dataDir), { google: fake }, { limits: LIMITS, timeZone: TZ, grantDays: 30 }));
  const out = await tools.tools.find((t) => t.name === "trafego_propor_orcamento")!.run({ plataforma: "google", nivel: "campanha", id: "111", novo_orcamento_dia: 70, motivo: "custo por reunião bom" });
  const id = JSON.parse(out.content).proposta.id as string;

  const overview = (await (await app.request("/api/trafego", { headers: auth })).json()) as any;
  assert.equal(overview.pendentes[0].id, id);
  assert.equal(overview.teto_orcamento_dia, 300);
  assert.equal(overview.presets.length, 4);
  const approved = (await (await app.request(`/api/trafego/propostas/${id}/aprovar`, { method: "POST", headers: auth })).json()) as any;
  assert.equal(approved.proposta.status, "executada");
  assert.equal((await app.request(`/api/trafego/propostas/${id}/aprovar`, { method: "POST", headers: auth })).status, 409);
  assert.equal((await app.request("/api/trafego/propostas/a_123/aprovar", { method: "POST", headers: auth })).status, 404);

  const grant = (await (await app.request("/api/trafego/permissoes", { method: "POST", headers: auth, body: JSON.stringify({ preset: "pausar", dias: 7 }) })).json()) as any;
  assert.equal(grant.permissao.preset, "pausar");
  assert.equal((await app.request("/api/trafego/permissoes", { method: "POST", headers: auth, body: JSON.stringify({ preset: "tudo" }) })).status, 409);
  assert.equal((await app.request("/api/trafego/permissoes/pausar", { method: "DELETE", headers: auth })).status, 200);

  // Login do Google: o link usa o endereço público e o state só vale uma vez.
  const link = (await (await app.request("/api/trafego/google/conectar", { method: "POST", headers: auth })).json()) as any;
  const u = new URL(link.url);
  assert.equal(u.searchParams.get("redirect_uri"), "https://jarvis.test/oauth/google/callback");
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/adwords");
  assert.equal(u.searchParams.get("access_type"), "offline");
  const state = u.searchParams.get("state")!;
  assert.equal((await app.request("/oauth/google/callback?state=errado&code=x")).status, 400);
  // code inválido (o fetch falso responde 404): falha, mas o state já foi gasto
  assert.equal((await app.request(`/oauth/google/callback?state=${state}&code=x`)).status, 502);
  assert.equal((await app.request(`/oauth/google/callback?state=${state}&code=x`)).status, 400);
});

test("tráfego: a permissão de 20% vale contra o orçamento do começo do dia (não empilha)", async () => {
  const { fake, traffic } = await manager();
  await traffic.grant("orcamento20");
  const t = new Date("2026-10-05T13:00:00Z");
  // 100 → 120 sozinho (20%)
  const a = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "222", novo_orcamento_dia: 120 }, "custo por reunião de R$ 35, abaixo da meta", "agente", t);
  assert.equal(a.status, "executada");
  fake.budgets.set("222", 120);
  // 120 → 140 é 16,7% do atual, mas 40% do começo do dia: espera o dono
  const b = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "222", novo_orcamento_dia: 140 }, "custo por reunião de R$ 35, abaixo da meta", "agente", t);
  assert.equal(b.status, "pendente");
  // o dono aprova: a nova base passa a ser o valor aprovado
  await traffic.approve(b.id, t);
  fake.budgets.set("222", 140);
  const c = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "222", novo_orcamento_dia: 160 }, "custo por reunião de R$ 35, abaixo da meta", "agente", t);
  assert.equal(c.status, "executada");
  // reduzir 120 (dentro dos 20% sobre a base do dia, que agora é 140 → 160 → base 140): 160 → 112 passa de 20%
  fake.budgets.set("222", 160);
  const d = await traffic.propose("alterar_orcamento", { plataforma: "google", nivel: "campanha", id: "222", novo_orcamento_dia: 100 }, "custo subiu demais nesta tarde", "agente", t);
  assert.equal(d.status, "pendente");
});

test("tráfego: missão não cria campanha e desconectar o Google desconecta de verdade", async () => {
  const { traffic } = await manager();
  const tools = missionTools([trafficConnector(traffic)]);
  assert.ok(!tools.has("trafego_propor_campanha_google"));
  assert.ok(tools.has("trafego_propor_status"));
  const dir = await tmp();
  const g = new GoogleAds({ developerToken: "d", clientId: "c", clientSecret: "s", customerId: "1234567890", loginCustomerId: null, apiVersion: "v22" }, dir, (async () => json({}, 404)) as typeof fetch);
  await writeFile(path.join(dir, "trafego-google.json"), JSON.stringify({ refresh_token: "rt" }));
  assert.equal((await g.status()).conectado, true);
  await g.disconnect();
  assert.equal((await g.status()).conectado, false);
});

test("tráfego: versão de API fora do formato não derruba o Jarvis", () => {
  const cfg = loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, META_API_VERSION: "v24", GOOGLE_ADS_API_VERSION: "22" });
  assert.equal(cfg.ads.meta, null);
  assert.equal(cfg.ads.google, null);
  assert.equal(cfg.ads.maxDailyBudget, 300);
});

test("equipe: a ferramenta de tarefas por pessoa consulta o recurso team_tasks só com o que foi pedido", async () => {
  const { ampliizeConnector } = await import("../src/connectors/ampliize.js");
  const pedidos: unknown[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    pedidos.push(JSON.parse(String(init!.body)));
    return json({ data: { por_pessoa: { "Gustavo Matias": { abertas: 0, concluidas_no_periodo: 5 } }, tarefas: [] } });
  }) as typeof fetch;
  const c = ampliizeConnector({ url: "https://crm.test/api", key: "amp_" + "a".repeat(48), fetchImpl });
  const tool = c.tools.find((t) => t.name === "ampliize_tarefas_equipe");
  assert.ok(tool);
  const out = await tool!.run({ pessoa: "gustavo", status: null, dias: null });
  assert.equal(out.ok, true);
  assert.deepEqual(pedidos[0], { resource: "team_tasks", params: { pessoa: "gustavo" } });
  assert.match(out.content, /Gustavo Matias/);
});

test("onde estamos: a ferramenta consulta o recurso automations e o prompt manda usá-la primeiro", async () => {
  const { ampliizeConnector } = await import("../src/connectors/ampliize.js");
  const pedidos: unknown[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    pedidos.push(JSON.parse(String(init!.body)));
    return json({ data: { manchete: "10 funcionando · 2 pedindo atenção", proximos_passos: [] } });
  }) as typeof fetch;
  const c = ampliizeConnector({ url: "https://crm.test/api", key: "amp_" + "a".repeat(48), fetchImpl });
  const tool = c.tools.find((t) => t.name === "ampliize_onde_estamos");
  assert.ok(tool);
  const out = await tool!.run({});
  assert.equal(out.ok, true);
  assert.deepEqual(pedidos[0], { resource: "automations", params: {} });
  assert.match(out.content, /10 funcionando/);
  const { readFile } = await import("node:fs/promises");
  const agent = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
  assert.match(agent, /ampliize_onde_estamos PRIMEIRO/);
});
