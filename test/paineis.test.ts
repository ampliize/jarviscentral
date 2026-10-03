import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp, safeLinks } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CrmPanels, panelsConnector } from "../src/skills/panels.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-"));
const CRM = { AMPLIIZE_API_URL: "https://crm.test/api", AMPLIIZE_API_KEY: "amp_" + "a".repeat(48) };

const FIN = {
  mes_atual: "2026-10",
  receita_recorrente_mensal: 9000,
  contratos_recorrentes: 6,
  custos_por_categoria_mes_atual: { folha: 4000 },
  serie: [{ mes: "2026-10", previsto: false, faturado: 10000, recebido: 6000, a_receber: 4000, vencido: 0, custos: 5000, custos_pagos: 3000, resultado: 3000, resultado_previsto: 5000 }],
};

test("painéis: rota pede o recurso certo ao CRM, guarda 60 s e explica quando o CRM é antigo", async () => {
  const asked: { resource: string; params: unknown }[] = [];
  let mode: "ok" | "old" = "ok";
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!String(url).startsWith("https://crm.test")) return json({}, 404);
    const body = JSON.parse(String(init!.body));
    asked.push(body);
    if (mode === "old") return json({ error: `Recurso desconhecido: "${body.resource}".` }, 404);
    return json({ resource: body.resource, data: body.resource === "finance_history" ? FIN : { serie: [] } });
  }) as typeof fetch;
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: await tmp(), ...CRM }), fetchImpl });

  assert.equal((await app.request("/api/painel/financeiro")).status, 401);
  assert.equal((await app.request("/api/painel/xyz", { headers: auth })).status, 404);
  const r = await app.request("/api/painel/financeiro", { headers: auth });
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as any).dados, FIN);
  const fin = asked.filter((a) => a.resource === "finance_history");
  assert.deepEqual(fin.at(-1)!.params, { meses: 12, futuros: 2 });
  await app.request("/api/painel/financeiro", { headers: auth });
  assert.equal(asked.filter((a) => a.resource === "finance_history").length, fin.length, "segunda leitura sai do cache");

  await app.request("/api/painel/comercial", { headers: auth });
  assert.ok(asked.some((a) => a.resource === "sales_history"));

  // CRM sem o recurso novo: 501 com a orientação (e o erro não fica no cache).
  mode = "old";
  const old = await app.request("/api/painel/agenda", { headers: auth });
  assert.equal(old.status, 501);
  assert.match(((await old.json()) as any).error, /publique a integration-api nova/);

  // Sem CRM configurado: 503.
  const bare = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: await tmp() }) });
  assert.equal((await bare.request("/api/painel/agenda", { headers: auth })).status, 503);

  // Fontes de dados no status: CRM ligado, WhatsApp honestamente "ainda não integrado".
  const st = (await (await app.request("/api/status", { headers: auth })).json()) as any;
  const fontes = Object.fromEntries(st.fontes.map((f: any) => [f.id, f.estado]));
  assert.equal(fontes.whatsapp, "indisponivel");
  // Clima: só vira "conectado" depois de uma consulta que respondeu; antes, "não testado".
  assert.equal(fontes.clima, "nao_testado");
  assert.equal(fontes.github, "desligado");
  await app.request("/api/clima", { headers: auth }); // o fake responde 404 para o Open-Meteo
  const st2 = (await (await app.request("/api/status", { headers: auth })).json()) as any;
  assert.equal(st2.fontes.find((f: any) => f.id === "clima").estado, "falha");
});

test("painéis: a IA abre um painel por link seguro; links inventados não passam", async () => {
  const panels = new CrmPanels({ url: "https://crm.test/api", key: "k" }, (async () => json({ data: FIN })) as typeof fetch);
  const tool = panelsConnector(panels).tools[0]!;
  const ok = await tool.run({ painel: "financeiro" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.links, [{ rotulo: "Abrir painel financeiro", url: "jarvis:painel/financeiro" }]);
  // A IA recebe só o resumo (o HUD busca o painel completo).
  const res = JSON.parse(ok.content);
  assert.equal(res.resumo.receita_recorrente_mensal, 9000);
  assert.equal(res.resumo.mes_atual.recebido, 6000);
  assert.equal(res.dados, undefined);
  assert.equal((await tool.run({ painel: "senhas" })).ok, false);

  assert.deepEqual(
    safeLinks([
      { rotulo: "a", url: "jarvis:painel/agenda" },
      { rotulo: "b", url: "jarvis:painel/../../x" },
      { rotulo: "c", url: "jarvis:painel/financeiro?x=1" },
    ]).map((l) => l.url),
    ["jarvis:painel/agenda"],
  );
});
