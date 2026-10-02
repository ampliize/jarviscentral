import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { buildBriefing } from "../src/briefing.js";
import { loadConfig } from "../src/config.js";
import { skillsConnector } from "../src/skills/index.js";
import { NewsService, parseRss } from "../src/skills/news.js";
import { parseWhen, ReminderStore } from "../src/skills/reminders.js";
import { WeatherService } from "../src/skills/weather.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-"));
const TZ = "America/Maceio";
const NOW = new Date("2026-09-30T12:00:00Z"); // 09:00 em Aracaju

const GEO = { results: [{ name: "Aracaju", admin1: "Sergipe", latitude: -10.9, longitude: -37.07 }] };
const FORECAST = {
  current: { temperature_2m: 27.4, apparent_temperature: 29.1, relative_humidity_2m: 70, weather_code: 2 },
  daily: { temperature_2m_max: [30.2, 29.6], temperature_2m_min: [23.3, 23.9], precipitation_probability_max: [20, 55], weather_code: [2, 61] },
};
const weatherFetch = (calls: string[] = []) =>
  (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    if (String(url).startsWith("https://geocoding-api.open-meteo.com")) return json(GEO);
    if (String(url).startsWith("https://api.open-meteo.com")) return json(FORECAST);
    return json({}, 404);
  }) as typeof fetch;

test("lembretes: horário sem fuso é o de Aracaju, nunca o do servidor", () => {
  assert.equal(parseWhen("2026-10-01T09:00:00-03:00", TZ).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(parseWhen("2026-10-01T09:00:00", TZ).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(parseWhen("2026-10-01 09:00", TZ).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(parseWhen("2026-10-01T12:00:00Z", TZ).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(parseWhen("2026-07-01T09:00", "Europe/Lisbon").toISOString(), "2026-07-01T08:00:00.000Z");
  assert.throws(() => parseWhen("amanhã às 9", TZ), /inválida/);
});

test("lembretes: cria, valida, avisa por intervalo sem alterar nada e conclui", async () => {
  const store = new ReminderStore(await tmp());
  const at = (s: string) => parseWhen(s, TZ);
  await assert.rejects(store.add("", at("2026-10-01T09:00"), NOW), /texto/);
  await assert.rejects(store.add("x", new Date("x"), NOW), /inválida/);
  await assert.rejects(store.add("x", at("2026-09-29T09:00"), NOW), /já passou/);
  await assert.rejects(store.add("x", at("2028-01-01T09:00"), NOW), /um ano/);

  const a = await store.add("cobrar a Ruddar", at("2026-09-30T09:30"), NOW);
  const b = await store.add("ligar para a Souza", at("2026-10-02T14:00"), NOW);
  assert.equal(a.quando, "2026-09-30T12:30:00.000Z");
  assert.deepEqual((await store.open()).map((r) => r.id), [a.id, b.id]);

  assert.deepEqual(await store.dueBetween(NOW, new Date("2026-09-30T12:10:00Z")), []);
  assert.deepEqual((await store.dueBetween(NOW, new Date("2026-09-30T12:31:00Z"))).map((r) => r.id), [a.id]);
  // Outra tela que ainda não avisou também recebe; quem já avisou (desde depois) não.
  assert.deepEqual((await store.dueBetween(NOW, new Date("2026-09-30T12:40:00Z"))).map((r) => r.id), [a.id]);
  assert.deepEqual(await store.dueBetween(new Date("2026-09-30T12:31:00Z"), new Date("2026-09-30T12:40:00Z")), []);

  assert.equal((await store.complete(a.id))!.status, "concluido");
  assert.equal(await store.complete("nao-existe"), null);
  assert.deepEqual((await store.open()).map((r) => r.id), [b.id]);
});

test("lembretes: gravações ao mesmo tempo não se perdem", async () => {
  const store = new ReminderStore(await tmp());
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.add(`item ${i}`, parseWhen("2026-10-01T09:00", TZ), NOW)));
  assert.equal((await store.open()).length, 10);
});

test("clima: Open-Meteo vira dados em português, fica em cache e não inventa 0°", async () => {
  const calls: string[] = [];
  const w = new WeatherService(weatherFetch(calls));
  const data = await w.get("Aracaju");
  assert.deepEqual(data, {
    cidade: "Aracaju (Sergipe)",
    agora: { temperatura: 27, sensacao: 29, umidade: 70, condicao: "parcialmente nublado" },
    hoje: { minima: 23, maxima: 30, chance_de_chuva: 20 },
    amanha: { minima: 24, maxima: 30, chance_de_chuva: 55, condicao: "chuva fraca" },
  });
  assert.match(calls[1]!, /timezone=auto/);
  await w.get("aracaju");
  assert.equal(calls.length, 2, "segunda consulta sai do cache");

  const none = new WeatherService((async () => json({ results: [] })) as typeof fetch);
  await assert.rejects(none.get("Xyzabc"), /Não encontrei a cidade/);

  // Valor que falta não vira 0°: amanhã some, hoje fica sem máxima.
  const gaps = new WeatherService((async (url: RequestInfo | URL) =>
    String(url).includes("geocoding")
      ? json(GEO)
      : json({ current: { temperature_2m: 26, weather_code: 0 }, daily: { temperature_2m_max: [null, 29], temperature_2m_min: [22, null] } })) as typeof fetch);
  const partial = await gaps.get("Aracaju");
  assert.deepEqual(partial.hoje, { minima: 22, maxima: null, chance_de_chuva: null });
  assert.equal(partial.amanha, null);
  assert.equal(partial.agora.sensacao, null);
});

test("notícias: lê o RSS do Google Notícias sem a fonte no título", async () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>Google</title>
    <item><title>OpenAI lança modelo novo - Folha</title><link>https://news.google.com/a</link><pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate><source url="https://folha.uol.com.br">Folha</source></item>
    <item><title><![CDATA[Aracaju &amp; região: obras <b>novas</b> - G1]]></title><link>https://news.google.com/b</link><source url="https://g1.globo.com">G1</source></item>
    <item><title>Sem link</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  assert.deepEqual(parseRss(xml), [
    { titulo: "OpenAI lança modelo novo", fonte: "Folha", link: "https://news.google.com/a", publicado: "2026-09-29T10:00:00.000Z" },
    { titulo: "Aracaju & região: obras novas", fonte: "G1", link: "https://news.google.com/b", publicado: null },
  ]);
  let asked = "";
  const news = new NewsService((async (url: RequestInfo | URL) => {
    asked = String(url);
    return new Response(xml);
  }) as typeof fetch);
  assert.equal((await news.search("marketing digital")).length, 2);
  assert.match(asked, /news\.google\.com\/rss\/search\?q=marketing%20digital&hl=pt-BR/);
});

test("habilidades: ferramentas do modelo criam lembrete e tratam erros", async () => {
  const s = {
    reminders: new ReminderStore(await tmp()),
    weather: new WeatherService(weatherFetch()),
    news: new NewsService((async () => new Response("", { status: 503 })) as typeof fetch),
    city: "Aracaju",
    timeZone: TZ,
  };
  const tools = Object.fromEntries(skillsConnector(s).tools.map((t) => [t.name, t]));
  const far = await tools.lembrete_criar!.run({ texto: "cobrar a Ruddar", quando: "2099-01-01T09:00:00-03:00" });
  assert.equal(far.ok, false, "mais de um ano à frente");
  const noZone = await tools.lembrete_criar!.run({ texto: "sem fuso", quando: "2099-01-01 09:00" });
  assert.match(noZone.content, /um ano/);
  const created = await tools.lembrete_criar!.run({ texto: "cobrar a Ruddar", quando: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(created.ok, true);
  assert.match(created.content, /cobrar a Ruddar/);
  assert.match((await tools.lembrete_listar!.run({})).content, /pendente/);
  assert.match((await tools.clima!.run({ cidade: null })).content, /Aracaju/);
  const news = await tools.noticias!.run({ tema: "x" });
  assert.equal(news.ok, false);
  assert.match(news.content, /HTTP 503/);
});

test("briefing: card de clima e de lembretes (atrasados contam como atenção)", () => {
  const b = buildBriefing({
    crm: null,
    crmConfigured: false,
    pendencias: [],
    inbox: 0,
    ownerName: "Davy",
    timeZone: TZ,
    now: NOW,
    clima: {
      cidade: "Aracaju (Sergipe)",
      agora: { temperatura: 27, sensacao: 29, umidade: 70, condicao: "parcialmente nublado" },
      hoje: { minima: 23, maxima: 30, chance_de_chuva: 20 },
      amanha: null,
    },
    lembretes: [
      { id: "c", texto: "renovar domínio", quando: "2026-09-28T13:00:00.000Z", criado: "", status: "pendente" },
      { id: "b", texto: "enviar proposta", quando: "2026-09-30T11:00:00.000Z", criado: "", status: "pendente" },
      { id: "a", texto: "cobrar a Ruddar", quando: "2026-09-30T12:30:00.000Z", criado: "", status: "pendente" },
    ],
  });
  assert.deepEqual(b.cards.slice(0, 2).map((c) => c.id), ["clima", "lembretes"]);
  assert.equal(b.cards[0]!.fala, "Em Aracaju agora faz 27 graus, parcialmente nublado. Hoje a mínima é 23 e a máxima 30, com 20% de chance de chuva.");
  assert.equal(
    b.cards[1]!.fala,
    "Você tem 3 lembretes: renovar domínio, atrasado desde 28/09 às 10:00; enviar proposta, atrasado desde 08:00 e cobrar a Ruddar, às 09:30.",
  );
  assert.deepEqual(b.cards[1]!.itens.map((i) => i.alerta), [true, true, false]);
  assert.deepEqual(b.numeros.clima, { cidade: "Aracaju", temperatura: 27 });
  assert.equal(b.numeros.lembretes_hoje, 3);
});

test("rotas de lembretes (sem efeito colateral) e briefing com clima", async () => {
  const dataDir = await tmp();
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir, JARVIS_CITY: "Aracaju" }), fetchImpl: weatherFetch() });
  assert.equal((await app.request("/api/lembretes")).status, 401);

  const store = new ReminderStore(dataDir);
  const before = new Date().toISOString();
  const r = await store.add("teste", new Date(Date.now() + 1000));
  assert.deepEqual(((await (await app.request("/api/lembretes", { headers: auth })).json()) as any).lembretes.map((x: any) => x.id), [r.id]);
  await new Promise((res) => setTimeout(res, 1100));
  const avisos = (desde: string) => app.request(`/api/lembretes/avisos?desde=${encodeURIComponent(desde)}`, { headers: auth }).then((x) => x.json() as Promise<any>);
  const first = await avisos(before);
  assert.deepEqual(first.avisos.map((x: any) => x.texto), ["teste"]);
  // Outra tela com o mesmo "desde" também recebe; com o "agora" devolvido, não repete.
  assert.equal((await avisos(before)).avisos.length, 1);
  assert.deepEqual((await avisos(first.agora)).avisos, []);
  assert.equal((await app.request(`/api/lembretes/${r.id}/concluir`, { method: "POST", headers: auth })).status, 200);
  assert.equal((await app.request("/api/lembretes/zzz/concluir", { method: "POST", headers: auth })).status, 404);

  const brief = (await (await app.request("/api/briefing", { headers: auth })).json()) as any;
  assert.equal(brief.cards[0].id, "clima");
  assert.equal(brief.numeros.clima.temperatura, 27);
});

test("limites: senha errada trava depois de 10 tentativas, uso normal aguenta a voz em pedaços", async () => {
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: await tmp() }) });
  const headers = { "x-forwarded-for": "9.9.9.9" };
  for (let i = 0; i < 10; i++) assert.equal((await app.request("/api/lembretes", { headers: { ...headers, Authorization: "Bearer errado" } })).status, 401);
  assert.equal((await app.request("/api/lembretes", { headers: { ...headers, ...auth } })).status, 429, "IP bloqueado após 10 erros");
  const other = { "x-forwarded-for": "8.8.8.8", ...auth };
  for (let i = 0; i < 60; i++) assert.equal((await app.request("/api/lembretes", { headers: other })).status, 200);
});

test("painéis do HUD: /api/clima, /api/noticias e serviços no /api/status", async () => {
  const rss = `<rss><channel><item><title>IA no varejo - G1</title><link>https://news.google.com/x</link><source url="https://g1.globo.com">G1</source></item></channel></rss>`;
  const asked: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    asked.push(u);
    if (u.startsWith("https://news.google.com/")) return new Response(rss);
    return weatherFetch()(url, init);
  }) as typeof fetch;
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: await tmp(), JARVIS_CITY: "Aracaju" }), fetchImpl });
  assert.equal((await app.request("/api/clima")).status, 401);
  assert.equal((await app.request("/api/noticias")).status, 401);

  const clima = ((await (await app.request("/api/clima", { headers: auth })).json()) as any).clima;
  assert.equal(clima.agora.temperatura, 27);
  assert.equal(clima.agora.umidade, 70);
  assert.equal(clima.hoje.chance_de_chuva, 20);

  const res = await app.request(`/api/noticias?tema=${encodeURIComponent("Inteligência artificial" + "x".repeat(200))}`, { headers: auth });
  const news = (await res.json()) as any;
  assert.equal(news.tema.length, 80);
  assert.deepEqual(news.noticias.map((n: any) => n.titulo), ["IA no varejo"]);
  assert.match(asked.find((u) => u.includes("news.google.com"))!, /q=Intelig%C3%AAncia%20artificial/);

  const status = (await (await app.request("/api/status", { headers: auth })).json()) as any;
  assert.deepEqual(status.servicos, { motor: false, crm: false, fala: "navegador", estudio: null, github: false, sistemas_monitorados: 0 });

  // Clima fora do ar: 502 com JSON (a tela não confunde com o servidor caído).
  const down = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: await tmp() }), fetchImpl: (async () => new Response("", { status: 500 })) as typeof fetch });
  const r = await down.request("/api/clima", { headers: auth });
  assert.equal(r.status, 502);
  assert.match(r.headers.get("content-type") ?? "", /json/);
});
