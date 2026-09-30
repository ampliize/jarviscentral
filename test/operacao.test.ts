import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { buildBriefing, buildOperation, type BuildInput, type CrmBriefing } from "../src/briefing.js";
import { loadConfig } from "../src/config.js";
import { AlertBook, parseAlerts, parseSeverity } from "../src/skills/alerts.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-"));
const TZ = "America/Maceio";
const NOW = new Date("2026-09-30T12:00:00Z");

const ALERTAS = `# Riscos
<!-- - [ ] crítico | exemplo | comentado -->
- [ ] 🟡 Zyron | Front chama tabela taxas que não existe | desde 2026-09-30 | ação: corrigir front ou criar tabela
- [ ] crítico | bate-ponto | Dados abertos para qualquer pessoa | desde 2026-09-30 | ação: fechar acesso anon
- [x] alto | Reutiliize | Imagens sumiram | desde 2026-09-24
- [ ] **alto** | Reutiliize | send-email sem login | desde 2026-09-30
- [ ] Revisar contrato da Essencial
- [ ] médio | Karol | Tabela \`kb_itens\` vazia | ação: preencher _jarvis/sistemas.md
- não é item de risco`;

test("riscos: lê nível, sistema, desde e ação; ignora resolvidos e comentários", async () => {
  assert.equal(parseSeverity("Crítico"), "critico");
  assert.equal(parseSeverity("🟠"), "alto");
  assert.equal(parseSeverity("média"), "medio");
  assert.equal(parseSeverity("qualquer"), null);

  const all = parseAlerts(ALERTAS);
  assert.equal(all.length, 6);
  assert.equal(all[5]!.descricao, "Tabela kb_itens vazia");
  assert.equal(all[5]!.acao, "preencher _jarvis/sistemas.md");
  assert.deepEqual(all[1], { nivel: "critico", sistema: "bate-ponto", descricao: "Dados abertos para qualquer pessoa", desde: "2026-09-30", acao: "fechar acesso anon", resolvido: false });
  assert.deepEqual(all[4], { nivel: "medio", sistema: "geral", descricao: "Revisar contrato da Essencial", desde: null, acao: null, resolvido: false });

  const root = await tmp();
  await mkdir(path.join(root, "_jarvis"), { recursive: true });
  await writeFile(path.join(root, "_jarvis", "alertas.md"), ALERTAS);
  const open = await new AlertBook(root).open();
  assert.deepEqual(open.map((a) => `${a.nivel}:${a.sistema}`), ["critico:bate-ponto", "alto:Reutiliize", "medio:Zyron", "medio:geral", "medio:Karol"]);

  // Link simbólico no lugar do arquivo é ignorado.
  const other = await tmp();
  await mkdir(path.join(other, "_jarvis"), { recursive: true });
  await writeFile(path.join(other, "x.md"), ALERTAS);
  await symlink(path.join(other, "x.md"), path.join(other, "_jarvis", "alertas.md"));
  assert.deepEqual(await new AlertBook(other).open(), []);
});

const crm = (): CrmBriefing => ({
  data_referencia: "2026-09-30",
  financeiro: {
    recebido_no_mes: 12880,
    vencidas: [{ cliente: "Ruddar", valor: 1500, vencimento: "2026-08-20" }],
    vencidas_total: 1,
    a_vencer_7_dias: [],
    contas_a_pagar_7_dias: [],
  },
  tarefas: { atrasadas: [{ tarefa: "Post", projeto: "Ampliize", responsavel: "Miguel", prazo: "2026-09-28T17:00:00Z" }], vencendo: [], bloqueadas: [] },
  comercial: { leads_novos_24h: { quantidade: 0, nomes: [] }, em_aberto: 89, follow_ups_atrasados: 0 },
  sistema: { erros_abertos: 0 },
});

const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  crm: crm(),
  crmConfigured: true,
  pendencias: [],
  inbox: 0,
  ownerName: "Davy",
  timeZone: TZ,
  now: NOW,
  alertas: parseAlerts(ALERTAS).filter((a) => !a.resolvido).sort((a, b) => (a.nivel === "critico" ? -1 : b.nivel === "critico" ? 1 : 0)),
  sistemas: [],
  ...over,
});

test("bom dia: card de riscos com o mais grave primeiro e conta como atenção", () => {
  const b = buildBriefing(input());
  const card = b.cards.find((c) => c.id === "riscos")!;
  assert.equal(card.titulo, "Riscos críticos em aberto");
  assert.equal(card.destaque!.legenda, "1 crítico");
  assert.equal(card.fala, "Tem 5 riscos em aberto. O mais grave: bate-ponto, Dados abertos para qualquer pessoa, nível crítico, desde 30/09.");
  assert.equal(b.numeros.riscos, 5);
  // 1 cobrança vencida + 1 tarefa atrasada + 5 riscos
  assert.equal(b.atencao, 7);
  assert.ok(!buildBriefing(input({ alertas: [] })).cards.some((c) => c.id === "riscos"));
});

test("monitor da operação: semáforo por área e geral pelo pior", () => {
  const op = buildOperation(input());
  const by = Object.fromEntries(op.areas.map((a) => [a.id, a]));
  assert.equal(op.geral, "critico");
  assert.equal(by.riscos!.estado, "critico");
  assert.equal(by.riscos!.resumo, "5 em aberto, 1 crítico");
  assert.equal(by.financeiro!.estado, "critico", "vencida há mais de 30 dias");
  assert.match(by.financeiro!.itens[0]!, /Ruddar: R\$\s1\.500 vencida em 20\/08/);
  assert.equal(by.entregas!.estado, "atencao");
  assert.equal(by.comercial!.estado, "ok");
  assert.equal(by.crm!.estado, "ok");
  assert.equal(by.sistemas!.estado, "sem_dados");
  assert.equal(by.lembretes!.estado, "ok");

  const calm = buildOperation(
    input({
      alertas: [],
      crm: { ...crm(), financeiro: { recebido_no_mes: 0, vencidas: [], a_vencer_7_dias: [], contas_a_pagar_7_dias: [] }, tarefas: { atrasadas: [], vencendo: [], bloqueadas: [] } },
      sistemas: [{ nome: "CRM", url: "https://a.com", cliente: null, status: "ok", http: 200, ms: 100, ssl_dias: 80, detalhe: null, uptime_24h: 100, verificado_em: "" }],
    }),
  );
  assert.equal(calm.geral, "ok");

  const noCrm = buildOperation(input({ crm: null, crmError: "HTTP 502", alertas: [] }));
  assert.equal(noCrm.areas.find((a) => a.id === "financeiro")!.estado, "sem_dados");
  assert.equal(noCrm.areas.find((a) => a.id === "financeiro")!.resumo, "CRM não respondeu (HTTP 502)");
});

test("rota /api/operacao e ferramentas do modelo", async () => {
  const dataDir = await tmp();
  await mkdir(path.join(dataDir, "brain", "_jarvis"), { recursive: true });
  await writeFile(path.join(dataDir, "brain", "_jarvis", "alertas.md"), ALERTAS);
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir }), fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });
  assert.equal((await app.request("/api/operacao")).status, 401);
  const op = (await (await app.request("/api/operacao", { headers: auth })).json()) as any;
  assert.equal(op.geral, "critico");
  assert.equal(op.areas.find((a: any) => a.id === "riscos").itens[0], "🔴 bate-ponto: Dados abertos para qualquer pessoa (desde 30/09)");
  const connectors = (await (await app.request("/api/connectors", { headers: auth })).json()) as any[];
  const ops = connectors.find((c) => c.id === "operacao");
  assert.deepEqual(ops.ferramentas, ["operacao_status", "riscos_listar"]);
});
