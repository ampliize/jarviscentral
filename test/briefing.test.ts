import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { buildBriefing, greeting, type CrmBriefing } from "../src/briefing.js";
import { loadConfig } from "../src/config.js";
import { Brain } from "../src/memory/brain.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TZ = "America/Maceio";
// 30/09/2026 às 09:00 em Aracaju.
const NOW = new Date("2026-09-30T12:00:00Z");

const crm = (over: Partial<CrmBriefing> = {}): CrmBriefing => ({
  data_referencia: "2026-09-30",
  financeiro: {
    recebido_no_mes: 12880,
    vencidas: [{ cliente: "Ruddar", valor: 1500, vencimento: "2026-09-01", obs: "Parcela 1/2" }],
    a_vencer_7_dias: [{ cliente: "Essencial Group", valor: 3000, vencimento: "2026-10-03" }],
    contas_a_pagar_7_dias: [],
  },
  tarefas: {
    atrasadas: [{ tarefa: "Conteúdos & Posts", projeto: "EssêncialGroup", responsavel: "Miguel Bezerra", prazo: "2026-09-28T17:50:00+00:00" }],
    vencendo: [],
    bloqueadas: [],
  },
  comercial: { leads_novos_24h: { quantidade: 0, nomes: [] }, em_aberto: 89, follow_ups_atrasados: 0 },
  sistema: { erros_abertos: 0 },
  ...over,
});

test("briefing: cards e fala saem dos dados, com nomes, valores e datas exatos", () => {
  const b = buildBriefing({ crm: crm(), crmConfigured: true, pendencias: ["Cobrar a Ruddar"], inbox: 1, ownerName: "Davy", timeZone: TZ, now: NOW });
  assert.equal(b.saudacao, "Bom dia, Davy.");
  assert.equal(b.atencao, 2);
  assert.match(b.abertura, /2 pontos pedem sua atenção/);
  assert.deepEqual(b.cards.map((c) => c.id), ["dinheiro", "entregas", "comercial", "cerebro"]);

  const money = b.cards[0]!;
  assert.equal(money.destaque!.legenda, "recebido em setembro");
  assert.match(money.fala, /Em setembro entraram R\$\s12\.880\./);
  assert.match(money.fala, /Tem uma cobrança vencida: Ruddar, R\$\s1\.500 desde 01\/09\./);
  assert.match(money.fala, /vence uma: Essencial Group, R\$\s3\.000 em 03\/10\./);
  assert.equal(money.itens[0]!.alerta, true);

  const tasks = b.cards[1]!;
  assert.match(tasks.fala, /Uma tarefa atrasada: Conteúdos & Posts \(EssêncialGroup\), com Miguel, desde 28\/09\./);
  assert.equal(tasks.destaque!.valor, "1");

  assert.match(b.cards[3]!.fala, /1 pendência aberta.*Cobrar a Ruddar.*1 nota na caixa de entrada/);
});

test("briefing: dia tranquilo, erros do Monitor e CRM fora do ar", () => {
  const calm = crm({
    financeiro: { recebido_no_mes: 0, vencidas: [], a_vencer_7_dias: [], contas_a_pagar_7_dias: [] },
    tarefas: { atrasadas: [], vencendo: [], bloqueadas: [] },
  });
  const quiet = buildBriefing({ crm: calm, crmConfigured: true, pendencias: [], inbox: 0, ownerName: "Davy", timeZone: TZ, now: NOW });
  assert.equal(quiet.atencao, 0);
  assert.match(quiet.abertura, /Nada urgente hoje/);
  assert.match(quiet.cards[0]!.fala, /Nenhuma cobrança vencida/);
  assert.ok(!quiet.cards.some((c) => c.id === "cerebro"));

  const withErrors = buildBriefing({ crm: crm({ sistema: { erros_abertos: 3 } }), crmConfigured: true, pendencias: [], inbox: 0, ownerName: "Davy", timeZone: TZ, now: NOW });
  assert.ok(withErrors.cards.some((c) => c.id === "sistema" && /3 erros abertos/.test(c.fala)));

  const down = buildBriefing({ crm: null, crmError: "HTTP 502", crmConfigured: true, pendencias: [], inbox: 0, ownerName: "Davy", timeZone: TZ, now: NOW });
  assert.equal(down.cards[0]!.id, "crm");
  assert.match(down.cards[0]!.fala, /Não consegui ler o CRM agora \(HTTP 502\)/);

  const missing = buildBriefing({ crm: null, crmConfigured: false, pendencias: [], inbox: 0, ownerName: "Davy", timeZone: TZ, now: NOW });
  assert.match(missing.cards[0]!.fala, /AMPLIIZE_API_KEY/);
});

test("briefing: saudação pelo horário de Aracaju", () => {
  assert.equal(greeting(new Date("2026-09-30T11:00:00Z"), TZ), "Bom dia"); // 08h
  assert.equal(greeting(new Date("2026-09-30T17:00:00Z"), TZ), "Boa tarde"); // 14h
  assert.equal(greeting(new Date("2026-09-30T23:30:00Z"), TZ), "Boa noite"); // 20h30
});

test("cérebro: pendências abertas sem Markdown e contagem da inbox", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jarvis-"));
  const brain = new Brain(dir);
  await brain.init();
  await writeFile(
    path.join(brain.root, "pendencias.md"),
    "# Pendências\n- [ ] Cobrar a **Ruddar**: R$ 1.500\n- [x] Já feito\n  - [ ] Ver [[clientes/ruddar|a nota]] e [o CRM](https://x)\ntexto solto\n",
  );
  await writeFile(path.join(brain.root, "inbox", "a.md"), "x");
  await writeFile(path.join(brain.root, "inbox", ".gitkeep"), "");
  assert.deepEqual(await brain.pendencias(), ["Cobrar a Ruddar: R$ 1.500", "Ver a nota e o CRM"]);
  assert.equal(await brain.inboxCount(), 1);
});

test("rota /api/briefing: pede o recurso briefing ao CRM, exige senha, e a imagem do camaleão é pública", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jarvis-"));
  await mkdir(path.join(dataDir, "brain"), { recursive: true });
  const asked: string[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { resource } = JSON.parse(String(init!.body));
    asked.push(resource);
    if (resource === "agenda") {
      return json({
        resource,
        data: {
          de: "2026-09-30", ate: "2026-09-30", dias: 1, proxima_reuniao: null,
          contagem: { reunioes: 1, prazos: 1, cobrancas: 0, pagamentos: 0, follow_ups: 0 },
          eventos: [
            { tipo: "reuniao", data: "2026-09-30", hora: "09:30", titulo: "Reunião · Clínica Sorriso", detalhe: "presencial", local: "presencial", link: null, status: "scheduled" },
            { tipo: "prazo", data: "2026-09-30", hora: null, titulo: "Entregar layout", detalhe: "Site Sorriso", status: "todo" },
          ],
        },
      });
    }
    return json({ resource: "briefing", data: crm() });
  }) as typeof fetch;
  const config = loadConfig({
    JARVIS_ACCESS_TOKEN: TOKEN,
    DATA_DIR: dataDir,
    AMPLIIZE_API_URL: "https://crm.test/api",
    AMPLIIZE_API_KEY: "amp_" + "a".repeat(48),
  });
  const app = await createApp({ config, fetchImpl });

  assert.equal((await app.request("/api/briefing")).status, 401);
  const res = await app.request("/api/briefing", { headers: auth });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cards: { id: string; fala: string; itens: { titulo: string }[] }[]; abertura: string };
  assert.ok(asked.includes("briefing") && asked.includes("agenda"), asked.join(","));
  // Agenda do CRM vem antes do dinheiro, com hora falada do jeito certo.
  assert.deepEqual(body.cards.slice(0, 2).map((c) => c.id), ["agenda", "dinheiro"]);
  assert.match(body.cards[0]!.fala, /reunião com Clínica Sorriso, às 9h30/);
  assert.deepEqual(body.cards[0]!.itens.map((i) => i.titulo), ["09:30 · Reunião · Clínica Sorriso", "— · Prazo: Entregar layout"]);
  assert.match(body.abertura, /Davy/);

  const png = await app.request("/camaleao.png");
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  const page = await app.request("/");
  assert.match(await page.text(), /camaleao\.png/);
});

test("briefing: usa os totais do CRM quando as listas vêm cortadas", () => {
  const base = crm();
  const cut = crm({
    financeiro: { ...base.financeiro, vencidas_total: 5 },
    tarefas: { ...base.tarefas, atrasadas_total: 30 },
  });
  const b = buildBriefing({ crm: cut, crmConfigured: true, pendencias: Array.from({ length: 45 }, (_, i) => `item ${i}`), inbox: 0, ownerName: "Davy", timeZone: TZ, now: NOW });
  assert.match(b.cards[0]!.fala, /Tem 5 cobranças vencidas: Ruddar, R\$\s1\.500 desde 01\/09, e mais 4\./);
  assert.equal(b.cards[1]!.destaque!.valor, "30");
  assert.match(b.cards[1]!.fala, /30 tarefas atrasadas: .*e mais 29\./);
  assert.equal(b.atencao, 35);
  assert.deepEqual(b.numeros, { recebido_no_mes: 12880, vencidas: 5, tarefas_atrasadas: 30, leads_em_aberto: 89, pendencias: 45, lembretes_hoje: 0, clima: null, sistemas: null, riscos: 0 });
  const brainCard = b.cards.find((c) => c.id === "cerebro")!;
  assert.match(brainCard.fala, /45 pendências abertas\. As primeiras: item 0 e item 1\./);
  assert.equal(brainCard.itens.length, 6);
});
