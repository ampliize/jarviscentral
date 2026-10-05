import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MissionRunner, MissionStore, nextRun, parseFrequency, parseReport, type Mission } from "../src/skills/missions.js";
import { MANAGER_PACK, missionTools } from "../src/skills/manager.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const TZ = "America/Maceio";
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-"));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("missões: próximo horário no fuso de Aracaju, dias úteis, semanal, mensal e uma vez", () => {
  // Sexta, 02/10/2026, 10:00 em Aracaju (13:00 UTC).
  const fri = new Date("2026-10-02T13:00:00Z");
  assert.equal(nextRun(parseFrequency({ tipo: "diaria", hora: "07:30" }), TZ, fri), "2026-10-03T10:30:00.000Z");
  assert.equal(nextRun(parseFrequency({ tipo: "diaria", hora: "11:00" }), TZ, fri), "2026-10-02T14:00:00.000Z");
  // Dias úteis: pula sábado e domingo.
  assert.equal(nextRun(parseFrequency({ tipo: "dias_uteis", hora: "07:45" }), TZ, fri), "2026-10-05T10:45:00.000Z");
  assert.equal(nextRun(parseFrequency({ tipo: "semanal", dias_semana: [1, 3], hora: "09:00" }), TZ, fri), "2026-10-05T12:00:00.000Z");
  assert.equal(nextRun(parseFrequency({ tipo: "mensal", dia_mes: 5, hora: "08:00" }), TZ, fri), "2026-10-05T11:00:00.000Z");
  assert.equal(nextRun(parseFrequency({ tipo: "uma_vez", data: "2026-10-02", hora: "09:00" }), TZ, fri), null);
  assert.equal(nextRun(parseFrequency({ tipo: "uma_vez", data: "2026-10-09", hora: "9:00" }), TZ, fri), "2026-10-09T12:00:00.000Z");
  assert.throws(() => parseFrequency({ tipo: "semanal", hora: "09:00" }), /dias da semana/);
  assert.throws(() => parseFrequency({ tipo: "diaria", hora: "25:00" }), /Hora inválida/);
  assert.throws(() => parseFrequency({ tipo: "mensal", dia_mes: 31, hora: "08:00" }), /entre 1 e 28/);
});

test("missões: lê resumo, ordens (com responsável e prazo) e o que precisa do dono", () => {
  const md = `# Plano de conteúdo · semana 41
## Resumo
Três clientes com calendário pronto.
Falta a data do evento.
## O que eu fiz
- li as notas
## Ordens para o time
- [Miguel] Gravar 2 reels da obra da Essencial · prazo: quarta
- [Agente SDR] Gerar a 1ª abordagem para Clínica Sorriso (score 92)
- Revisar legendas
## Precisa de você
- Confirmar a data do evento da Lahs & Brow
- nada
## Entregáveis
...`;
  const r = parseReport(md);
  assert.equal(r.titulo, "Plano de conteúdo · semana 41");
  assert.equal(r.resumo, "Três clientes com calendário pronto. Falta a data do evento.");
  assert.deepEqual(r.ordens, [
    { para: "Miguel", tarefa: "Gravar 2 reels da obra da Essencial", prazo: "quarta" },
    { para: "Agente SDR", tarefa: "Gerar a 1ª abordagem para Clínica Sorriso (score 92)" },
    { para: "Time", tarefa: "Revisar legendas" },
  ]);
  assert.deepEqual(r.precisa_de_voce, ["Confirmar a data do evento da Lahs & Brow"]);
  assert.deepEqual(parseReport("texto solto").ordens, []);
});

test("missões: ferramentas com efeito colateral ficam fora da missão", () => {
  const fake = (name: string) => ({ name, description: "", parameters: {}, run: async () => ({ ok: true, content: "" }) });
  const tools = missionTools([
    { id: "x", name: "x", description: "", tools: ["ampliize_fila_sdr", "memoria_buscar", "memoria_anotar", "site_produzir", "lembrete_criar", "missao_delegar", "relatorio_ler", "agentes_revisar"].map(fake) },
  ]);
  assert.deepEqual([...tools.keys()], ["ampliize_fila_sdr", "memoria_buscar", "agentes_revisar"]);
});

test("missões: agendador roda o que venceu uma vez, reagenda, respeita o teto diário e registra erro", async () => {
  const store = new MissionStore(await tmp(), TZ);
  const t0 = new Date("2026-10-05T10:00:00Z"); // segunda 07:00
  const a = await store.create({ titulo: "Rotina", instrucoes: "Faça a ronda da manhã.", frequencia: { tipo: "dias_uteis", hora: "07:30" } }, t0);
  const b = await store.create({ titulo: "Falha", instrucoes: "Esta missão sempre falha.", frequencia: { tipo: "diaria", hora: "07:30" } }, t0);
  const ran: string[] = [];
  const runner = new MissionRunner(
    store,
    async (m: Mission) => {
      ran.push(m.titulo);
      if (m.titulo === "Falha") throw new Error("sem dados");
      return store.addReport({ missao_id: m.id, missao: m.titulo, area: m.area, titulo: "ok", criado_em: new Date().toISOString(), resumo: "", precisa_de_voce: [], ordens: [], arquivo: null }, "# ok");
    },
    { maxPerDay: 1, timeZone: TZ },
  );
  const at = new Date("2026-10-05T10:31:00Z");
  assert.equal(await runner.tick(at), 1, "teto de 1 por dia: só a primeira roda");
  assert.deepEqual(ran, ["Rotina"]);
  const [ma, mb] = [await store.get(a.id), await store.get(b.id)];
  assert.equal(ma!.ultima!.ok, true);
  assert.equal(ma!.proxima, "2026-10-06T10:30:00.000Z");
  assert.equal(mb!.ultima, null, "não conta como execução");
  assert.equal(mb!.execucoes, 0);
  assert.equal(mb!.proxima, "2026-10-06T09:00:00.000Z", "sem orçamento: fica para amanhã às 06:00, sem perder a execução");
  // O teto sobrevive a reinício (fica gravado): um runner novo no mesmo dia não roda nada.
  const restarted = new MissionRunner(store, async () => { throw new Error("não devia rodar"); }, { maxPerDay: 1, timeZone: TZ });
  assert.equal(await restarted.tick(new Date("2026-10-05T11:00:00Z")), 0);
  // "Executar agora" sem orçamento hoje é recusado (não fica preso numa fila).
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  await store.takeBudget(hoje, 1);
  assert.equal(await restarted.runNow(a.id), false);
  // Dia seguinte: as duas rodam (teto renovado), a que falha registra o erro e segue o calendário.
  const runner2 = new MissionRunner(store, async (m) => {
    ran.push(m.titulo);
    if (m.titulo === "Falha") throw new Error("sem dados");
    return store.addReport({ missao_id: m.id, missao: m.titulo, area: m.area, titulo: "ok", criado_em: new Date().toISOString(), resumo: "", precisa_de_voce: [], ordens: [], arquivo: null }, "# ok");
  }, { maxPerDay: 5, timeZone: TZ });
  assert.equal(await runner2.tick(new Date("2026-10-06T10:31:00Z")), 2);
  assert.equal((await store.get(b.id))!.ultima!.erro, "sem dados");
  // Pausada não roda; "uma vez" se desativa depois de rodar.
  await store.setActive(a.id, false);
  assert.equal((await store.due(new Date("2026-10-09T12:00:00Z"))).some((m) => m.id === a.id), false);
});

test("missões: pacote do gerente, execução com a IA (fake) e relatório no vault, no HUD e no briefing", async () => {
  const dataDir = await tmp();
  await mkdir(path.join(dataDir, "brain", "_jarvis"), { recursive: true });
  await writeFile(path.join(dataDir, "brain", "_jarvis", "operacao.md"), "# Operação\n- Miguel faz social media.\n");
  const chatBodies: any[] = [];
  let calls = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init!.body));
      chatBodies.push(body);
      calls++;
      if (calls === 1) {
        return json({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ampliize_fila_sdr", arguments: '{"limite":5}' } }] } }], usage: {} });
      }
      return json({
        choices: [{ message: { content: "# Rotina de segunda\n## Resumo\nDois follow-ups vencidos e 5 leads para abordar.\n## Ordens para o time\n- [Agente SDR] Gerar abordagem para Clínica A · prazo: hoje\n## Precisa de você\n- Aprovar a mensagem nova do SDR\n## Entregáveis\n- lista" } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    }
    if (u.startsWith("https://crm.test")) {
      const { resource } = JSON.parse(String(init!.body));
      if (resource === "sdr_queue") return json({ data: { restam_hoje: 20, follow_ups_vencidos: [], novas_abordagens: [{ id: 1, nome: "Clínica A", score: 92 }] } });
      return json({ error: "x" }, 404);
    }
    return json({}, 404);
  }) as typeof fetch;
  const app = await createApp({
    config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir, OPENAI_API_KEY: "sk-test", AMPLIIZE_API_URL: "https://crm.test/api", AMPLIIZE_API_KEY: "amp_" + "a".repeat(48) }),
    fetchImpl,
    noScheduler: true,
  });

  assert.equal((await app.request("/api/missoes")).status, 401);
  const before = (await (await app.request("/api/missoes", { headers: auth })).json()) as any;
  assert.deepEqual(before.pacote.map((p: any) => p.chave), MANAGER_PACK.map((p) => p.chave));
  assert.ok(before.pacote.every((p: any) => !p.ativa));

  const pack = (await (await app.request("/api/missoes/pacote", { method: "POST", headers: auth, body: JSON.stringify({ chaves: ["rotina-diaria"] }) })).json()) as any;
  assert.equal(pack.criadas.length, 1);
  assert.equal(pack.criadas[0].quando, "de segunda a sexta às 07:45");
  // Segunda chamada não duplica.
  assert.equal(((await (await app.request("/api/missoes/pacote", { method: "POST", headers: auth, body: "{}" })).json()) as any).criadas.length, MANAGER_PACK.length - 1);
  const id = pack.criadas[0].id;

  const since = new Date().toISOString();
  assert.equal((await app.request(`/api/missoes/${id}/executar`, { method: "POST", headers: auth })).status, 200);
  let reports: any[] = [];
  for (let i = 0; i < 50 && !reports.length; i++) {
    await new Promise((r) => setTimeout(r, 40));
    reports = ((await (await app.request(`/api/relatorios/avisos?desde=${encodeURIComponent(since)}`, { headers: auth })).json()) as any).relatorios;
  }
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.titulo, "Rotina de segunda");
  assert.deepEqual(r.ordens, [{ para: "Agente SDR", tarefa: "Gerar abordagem para Clínica A", prazo: "hoje" }]);
  assert.deepEqual(r.precisa_de_voce, ["Aprovar a mensagem nova do SDR"]);
  assert.match(r.arquivo, /^relatorios\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}-\d{4}-rotina-de-segunda\.md$/);
  const vault = await readFile(path.join(dataDir, "brain", r.arquivo), "utf8");
  assert.match(vault, /Consultas: ampliize_fila_sdr/);

  // A missão rodou só com ferramentas de leitura e com a nota de operação no contexto.
  const toolNames = chatBodies[0].tools.map((t: any) => t.function.name);
  assert.ok(toolNames.includes("ampliize_fila_sdr"));
  assert.ok(!toolNames.some((n: string) => ["site_produzir", "memoria_anotar", "lembrete_criar", "missao_delegar"].includes(n)));
  assert.match(chatBodies[0].messages[0].content, /MODO MISSÃO/);
  assert.match(chatBodies[0].messages[0].content, /Miguel faz social media/);

  const full = (await (await app.request(`/api/relatorios/${r.id}`, { headers: auth })).json()) as any;
  assert.match(full.texto, /## Ordens para o time/);
  const m = ((await (await app.request("/api/missoes", { headers: auth })).json()) as any).missoes.find((x: any) => x.id === id);
  assert.equal(m.ultima.ok, true);
  assert.equal(m.execucoes, 1);

  // Briefing mostra o relatório não lido; depois de lido, some.
  const brief = (await (await app.request("/api/briefing", { headers: auth })).json()) as any;
  const card = brief.cards.find((c: any) => c.id === "relatorios");
  assert.match(card.fala, /Tenho um relatório novo: Rotina de segunda\. Um ponto precisa da sua decisão\./);
  assert.equal((await app.request(`/api/relatorios/${r.id}/lido`, { method: "POST", headers: auth })).status, 200);
  // Pausa e exclusão.
  assert.equal(((await (await app.request(`/api/missoes/${id}/ativa`, { method: "POST", headers: auth, body: '{"ativa":false}' })).json()) as any).missao.ativa, false);
  assert.equal((await app.request(`/api/missoes/${id}`, { method: "DELETE", headers: auth })).status, 200);
  assert.equal((await app.request(`/api/missoes/m_000000000000/executar`, { method: "POST", headers: auth })).status, 404);
});

test("missões: delegar pela conversa deixa aguardando o dono; a IA não consegue ativar sozinha", async () => {
  const { missionsConnector } = await import("../src/skills/manager.js");
  const { safeLinks } = await import("../src/app.js");
  const store = new MissionStore(await tmp(), TZ);
  const runner = new MissionRunner(store, async () => { throw new Error("não devia rodar"); }, { maxPerDay: 5, timeZone: TZ });
  const tools = Object.fromEntries(missionsConnector(store, runner).tools.map((t) => [t.name, t]));
  const res = await tools.missao_delegar!.run({
    titulo: "Cobrar clientes",
    area: "financeiro",
    instrucoes: "Toda manhã veja as vencidas e escreva a cobrança.",
    entrega: "Lista de cobranças.",
    frequencia: { tipo: "dias_uteis", hora: "08:00", dias_semana: null, dia_mes: null, data: null },
  });
  assert.equal(res.ok, true);
  const id = JSON.parse(res.content).aguardando_confirmacao.id;
  assert.deepEqual(res.links, [{ rotulo: "Ativar missão", url: `jarvis:missao/${id}` }]);
  const m = (await store.get(id))!;
  assert.equal(m.ativa, false);
  assert.equal(m.pendente, true);
  assert.equal(m.proxima, null, "não roda antes da confirmação");
  // A IA não ativa nem executa a missão pendente.
  assert.equal((await tools.missao_pausar!.run({ missao: id, ativa: true })).ok, false);
  assert.equal((await tools.missao_executar_agora!.run({ missao: id })).ok, false);
  // O toque em Ativar (rota do HUD → setActive) libera.
  const on = (await store.setActive(id, true))!;
  assert.equal(on.ativa, true);
  assert.equal(on.pendente, undefined);
  assert.ok(on.proxima);
  assert.deepEqual(safeLinks([{ rotulo: "a", url: `jarvis:missao/${id}` }, { rotulo: "b", url: "jarvis:missao/x" }]).map((l) => l.url), [`jarvis:missao/${id}`]);
});

test("whatsapp: avisa só lead esperando resposta nossa, uma vez, sem telefone", async () => {
  const dataDir = await tmp();
  let crmCalls = 0;
  const conversas = [
    { id: 7, nome: "Clínica A", aguardando_nossa_resposta: true, texto_do_lead: "Quanto custa?", lead_escreveu_em: "2026-10-04T12:00:00.123456+00:00", telefone: "nao deveria vir" },
    { id: 8, nome: "Imobiliária B", aguardando_nossa_resposta: false, texto_do_lead: "Ok", lead_escreveu_em: "2026-10-04T11:00:00.000Z" },
  ];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://crm.test")) {
      const { resource, params } = JSON.parse(String(init!.body));
      assert.equal(resource, "whatsapp_inbox");
      assert.deepEqual(params, { dias: 2 });
      crmCalls++;
      return json({ data: { conversas } });
    }
    return json({}, 404);
  }) as typeof fetch;
  const app = await createApp({
    config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir, OPENAI_API_KEY: "sk-test", AMPLIIZE_API_URL: "https://crm.test/api", AMPLIIZE_API_KEY: "amp_" + "a".repeat(48) }),
    fetchImpl,
    noScheduler: true,
  });
  assert.equal((await app.request("/api/whatsapp/avisos")).status, 401);
  const first = (await (await app.request("/api/whatsapp/avisos?desde=2026-10-04T00:00:00.000Z", { headers: auth })).json()) as any;
  assert.deepEqual(first.conversas, [{ id: 7, nome: "Clínica A", texto: "Quanto custa?", quando: "2026-10-04T12:00:00.123456+00:00" }]);
  assert.equal(first.agora, "2026-10-04T12:00:00.123456+00:00");
  // Com o cursor devolvido, o mesmo aviso não se repete (e o CRM não é chamado de novo em 30 s).
  const again = (await (await app.request(`/api/whatsapp/avisos?desde=${encodeURIComponent(first.agora)}`, { headers: auth })).json()) as any;
  assert.deepEqual(again.conversas, []);
  assert.equal(Date.parse(again.agora), Date.parse(first.agora));
  assert.equal(crmCalls, 1);
});

test("reuniões: avisa a reunião marcada pelo atendente uma vez, com o dossiê", async () => {
  const dataDir = await tmp();
  const reunioes = [
    { lead_id: 3, nome: "Clínica Sorriso", marcada_em: "2026-10-01T12:00:00.123456+00:00", inicio: "2026-10-06T13:00:00Z", dossie: { resumo: "Quer mais pacientes" } },
    { lead_id: 4, nome: "Antiga", marcada_em: "2026-09-30T10:00:00+00:00", inicio: "2026-10-05T13:00:00Z", dossie: null },
  ];
  const pedidos: unknown[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://crm.test")) {
      const { resource, params } = JSON.parse(String(init!.body));
      assert.equal(resource, "agent_meetings");
      pedidos.push(params);
      return json({ data: { desde: params.desde, reunioes } });
    }
    return json({}, 404);
  }) as typeof fetch;
  const app = await createApp({
    config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir, OPENAI_API_KEY: "sk-test", AMPLIIZE_API_URL: "https://crm.test/api", AMPLIIZE_API_KEY: "amp_" + "a".repeat(48) }),
    fetchImpl,
    noScheduler: true,
  });
  assert.equal((await app.request("/api/reunioes/avisos")).status, 401);
  const first = (await (await app.request("/api/reunioes/avisos?desde=2026-10-01T00:00:00.000Z", { headers: auth })).json()) as any;
  assert.deepEqual(first.reunioes.map((r: any) => r.lead_id), [3]);
  assert.equal(first.reunioes[0].dossie.resumo, "Quer mais pacientes");
  assert.equal(first.agora, "2026-10-01T12:00:00.123456+00:00");
  assert.deepEqual(pedidos[0], { desde: "2026-10-01T00:00:00.000Z" });
  // Com o cursor (microssegundos), a mesma reunião não volta.
  const again = (await (await app.request(`/api/reunioes/avisos?desde=${encodeURIComponent(first.agora)}`, { headers: auth })).json()) as any;
  assert.deepEqual(again.reunioes, []);
  assert.equal(again.agora, first.agora);
  // Recém-marcada sem dossiê espera; as anteriores saem e o cursor para antes dela.
  const agoraMesmo = new Date().toISOString();
  reunioes.push(
    { lead_id: 5, nome: "Sem dossiê ainda", marcada_em: agoraMesmo, inicio: "2026-10-07T13:00:00Z", dossie: null },
    { lead_id: 6, nome: "Depois", marcada_em: new Date(Date.now() + 1000).toISOString(), inicio: "2026-10-07T14:00:00Z", dossie: { resumo: "ok" } },
  );
  const held = (await (await app.request(`/api/reunioes/avisos?desde=${encodeURIComponent(first.agora)}`, { headers: auth })).json()) as any;
  assert.deepEqual(held.reunioes, []);
  assert.equal(held.agora, first.agora);
  (reunioes[2] as any).dossie = { resumo: "pronto" };
  const ready = (await (await app.request(`/api/reunioes/avisos?desde=${encodeURIComponent(first.agora)}`, { headers: auth })).json()) as any;
  assert.deepEqual(ready.reunioes.map((r: any) => r.lead_id), [5, 6]);
  assert.equal(ready.agora, reunioes[3]!.marcada_em);
});
