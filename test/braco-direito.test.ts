import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp, safeLinks } from "../src/app.js";
import { buildOperation, type BuildInput } from "../src/briefing.js";
import { loadConfig } from "../src/config.js";
import { githubConnector } from "../src/connectors/github.js";
import { Brain } from "../src/memory/brain.js";
import { AuditLog, summarizeArgs, withAudit } from "../src/skills/audit.js";
import { AgentGuard, lintRun, parseAgentRules, textFields, type AgentRun } from "../src/skills/guard.js";
import { buildLovablePrompt, lovableLink, sitesConnector, TECH_BLOCK } from "../src/skills/sites.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-"));
const CRM = "https://crm.example.com/functions/v1/integration-api";

const RULES = `# Regras dos agentes
## Proibido
- concorrente X
- /desconto de \\d+%/i
## Evitar
- imperdível
## Links permitidos
- ampliize.com.br
`;

const sdrRun = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "11111111-1111-1111-1111-111111111111",
  agente: "sdr",
  status: "draft",
  criado_em: "2026-10-01T10:00:00Z",
  lead: { id: 7, nome: "Clínica Sorriso", nicho: "odontologia", etapa: "novo" },
  saida: {
    angulo: "Agenda cheia sem depender de indicação",
    primeira_mensagem: "Oi [nome], tudo bem? Garantimos  resultado em 30 dias, imperdível!! Veja https://bit.ly/abc",
    follow_up_1: "Oi, conseguiu ver? O plano custa R$ 1.500 por mês, com desconto de 20% hoje.",
    follow_up_2: "Passando para saber se se faz sentido conversar sobre o concorrente X.",
    observacoes_para_sdr: "Perguntar quantos pacientes faltam por semana.",
  },
  ...over,
});

test("guardião: regras fixas pegam placeholder, preço, promessa, link, proibido e pontuação", () => {
  const rules = parseAgentRules(RULES);
  assert.equal(rules.proibido.length, 2);
  assert.ok(rules.links.includes("ampliize.com.br") && rules.links.includes("wa.me"));
  assert.deepEqual(textFields({ a: "x", b: [{ c: "y", formato: "post" }] }), [["a", "x"], ["b[0].c", "y"]]);

  const f = lintRun(sdrRun(), rules);
  const has = (nivel: string, re: RegExp, campo?: string) => f.some((x) => x.nivel === nivel && re.test(x.regra) && (!campo || x.campo === campo));
  assert.ok(has("bloquear", /Placeholder/, "primeira_mensagem"));
  assert.ok(has("bloquear", /Preço/, "follow_up_1"));
  assert.ok(has("bloquear", /desconto/, "follow_up_1"));
  assert.ok(has("bloquear", /concorrente X/, "follow_up_2"));
  assert.ok(has("ajustar", /Promessa/));
  assert.ok(has("ajustar", /Link fora da lista permitida \(bit\.ly\)/));
  assert.ok(has("ajustar", /imperdível/));
  assert.ok(has("estilo", /Espaço duplo/));
  assert.ok(has("estilo", /Pontuação repetida/));
  assert.ok(has("estilo", /Palavra repetida/, "follow_up_2"));
  assert.ok(f.find((x) => /Placeholder/.test(x.regra))!.trecho.includes("[nome]"));

  // Closer pode falar de preço; texto limpo passa sem nada.
  assert.equal(lintRun({ agente: "closer", saida: { proposta: { faixa_investimento: "R$ 2.000 a R$ 3.000" } } }, rules).length, 0);
  assert.equal(lintRun({ agente: "sdr", saida: { primeira_mensagem: "Oi, Ana! Vi que a clínica abriu uma unidade nova. Posso te mostrar como lembrar os pacientes da consulta pelo WhatsApp?" } }, rules).length, 0);
});

/** CRM e OpenAI falsos: conta as chamadas à IA. */
function fakeServices(review: unknown, runs: AgentRun[] = [sdrRun()]) {
  const calls = { llm: 0, crm: [] as unknown[] };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(CRM)) {
      const body = JSON.parse(String(init?.body));
      calls.crm.push(body);
      if (body.resource === "agent_runs") return Response.json({ resource: "agent_runs", data: runs });
      return Response.json({ error: "x" }, { status: 500 });
    }
    if (u.startsWith("https://api.openai.com/")) {
      calls.llm++;
      const req = JSON.parse(String(init?.body));
      assert.equal(req.response_format?.type, "json_schema");
      return Response.json({ choices: [{ message: { content: JSON.stringify(review) }, finish_reason: "stop" }], usage: {} });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const cfg = (dataDir: string, extra: Record<string, string> = {}) =>
  loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir, OPENAI_API_KEY: "sk-test", AMPLIIZE_API_URL: CRM, AMPLIIZE_API_KEY: "amp_" + "a".repeat(48), ...extra });

test("guardião: junta regras fixas e IA, guarda a revisão e não revisa de novo o mesmo texto", async () => {
  const dataDir = await tmp();
  await mkdir(path.join(dataDir, "brain", "_jarvis"), { recursive: true });
  await writeFile(path.join(dataDir, "brain", "_jarvis", "regras-dos-agentes.md"), RULES);
  const { fetchImpl, calls } = fakeServices({
    veredito: "ajustar",
    resumo: "Tom insistente e promessa sem base.",
    problemas: [{ campo: "angulo", trecho: "Agenda cheia", problema: "Promete agenda cheia", correcao: "Mais pacientes confirmados", gravidade: "ajustar" }],
  });
  const config = cfg(dataDir);
  const guard = new AgentGuard({ config, brainRoot: path.join(dataDir, "brain"), dataDir, fetchImpl });
  const r1 = await guard.reviewDrafts();
  assert.equal(r1.total_rascunhos, 1);
  const rev = r1.revisoes[0]!;
  assert.equal(rev.veredito, "bloquear", "regra fixa de bloqueio vence o 'ajustar' da IA");
  assert.equal(rev.resumo, "Tom insistente e promessa sem base.");
  assert.ok(rev.revisao_ia);
  assert.ok(rev.problemas.some((p) => p.campo === "angulo" && p.sugestao === "Mais pacientes confirmados"));
  assert.equal(rev.problemas[0]!.nivel, "bloquear", "mais grave primeiro");
  assert.deepEqual((calls.crm[0] as any).params, { status: "draft" });

  await guard.reviewDrafts();
  assert.equal(calls.llm, 1, "mesmo texto: usa a revisão guardada");
  // Guardado em disco: outra instância lê.
  assert.equal((await new AgentGuard({ config, brainRoot: path.join(dataDir, "brain"), dataDir, fetchImpl }).stored()).length, 1);

  // IA fora do ar: fica só com as regras fixas, sem quebrar.
  const down = (async (url: string | URL, init?: RequestInit) =>
    String(url).startsWith(CRM) ? fetchImpl(url, init) : new Response("{}", { status: 500 })) as typeof fetch;
  const other = await tmp();
  const g2 = new AgentGuard({ config: cfg(other), brainRoot: path.join(other, "brain"), dataDir: other, fetchImpl: down });
  const r2 = (await g2.reviewDrafts()).revisoes[0]!;
  assert.equal(r2.revisao_ia, false);
  assert.equal(r2.veredito, "bloquear");
  assert.match(r2.resumo, /revisão por IA indisponível/);
});

test("monitor da operação: área dos agentes de IA", () => {
  const base: BuildInput = { crm: null, crmConfigured: true, pendencias: [], inbox: 0, ownerName: "Davy", timeZone: "America/Maceio", now: new Date("2026-10-01T12:00:00Z"), sistemas: [] };
  const review = { id: sdrRun().id, agente: "sdr", lead: "Clínica Sorriso", criado_em: "", veredito: "bloquear" as const, resumo: "Placeholder esquecido", problemas: [], revisado_em: "", revisao_ia: true, hash: "" };
  const two = [sdrRun(), sdrRun({ id: "22222222-2222-2222-2222-222222222222", agente: "content", lead: null })];
  const area = (input: BuildInput) => buildOperation(input).areas.find((a) => a.id === "agentes")!;
  const a = area({ ...base, agentes: { rascunhos: two, revisoes: [review] } });
  assert.equal(a.estado, "critico");
  assert.equal(a.resumo, "2 rascunhos pendentes · 1 bloqueado(s) · 0 para ajustar · 1 sem revisão");
  assert.deepEqual(a.itens, ["🔴 SDR · Clínica Sorriso: Placeholder esquecido"]);
  assert.equal(area({ ...base, agentes: { rascunhos: [], revisoes: [] } }).estado, "ok");
  assert.equal(area({ ...base, agentes: { rascunhos: null, revisoes: [] } }).estado, "sem_dados");
  assert.equal(area(base).estado, "sem_dados");
});

test("sites: prompt do Lovable sempre com o bloco técnico e link montado", async () => {
  const plan = {
    titulo: "Clínica Sorriso",
    conceito: "Do sorriso escondido ao sorriso confiante.",
    identidade: "Azul #0A4DFF, Inter.",
    secoes: Array.from({ length: 9 }, (_, i) => ({ nome: `Seção ${i}`, objetivo: "x", textos: "y".repeat(3000), animacao: "pin + scrub" })),
    seo: "Dentista em Aracaju",
  };
  const prompt = buildLovablePrompt(plan, "Clínica Sorriso");
  assert.ok(prompt.length <= 12_000);
  assert.ok(prompt.endsWith(TECH_BLOCK), "bloco técnico nunca é cortado");
  assert.match(prompt, /GSAP \+ ScrollTrigger/);
  const link = lovableLink("Crie um site & teste #1");
  assert.equal(link, "https://lovable.dev/?autosubmit=true#prompt=Crie%20um%20site%20%26%20teste%20%231");

  // Ferramenta completa: IA falsa planeja, roteiro vai para a inbox, link vira botão.
  const dataDir = await tmp();
  const brain = new Brain(dataDir);
  const small = { ...plan, secoes: plan.secoes.slice(0, 3).map((s) => ({ ...s, textos: "Seu sorriso, sem medo." })) };
  const { fetchImpl } = fakeServices(small);
  const tool = sitesConnector(cfg(dataDir), brain, fetchImpl).tools[0]!;
  const r = await tool.run({ nome: "Clínica Sorriso", objetivo: "Agendamentos no WhatsApp", publico: null, cliente: "Clínica Sorriso", secoes: null, estilo: null });
  assert.equal(r.ok, true);
  assert.equal(r.links![0]!.rotulo, "Criar no Lovable");
  assert.ok(r.links![0]!.url.startsWith("https://lovable.dev/?autosubmit=true#prompt="));
  assert.match(JSON.parse(r.content).roteiro_no_vault, /^inbox\/\d{4}-\d{2}-\d{2}-site-clinica-sorriso\.md$/);
  assert.equal((await tool.run({ nome: "", objetivo: "", publico: null, cliente: null, secoes: null, estilo: null })).ok, false);

  // Só destinos conhecidos viram botão no HUD.
  assert.deepEqual(safeLinks([{ rotulo: "ok", url: link }, { rotulo: "mal", url: "https://evil.com/x" }, { rotulo: "js", url: "javascript:alert(1)" }]).map((l) => l.rotulo), ["ok"]);
});

test("github: só lê os donos permitidos e o token só vai para api.github.com", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    if (String(url).includes("/contents/")) return Response.json({ type: "file", path: "src/a.ts", size: 5, encoding: "base64", content: Buffer.from("hello").toString("base64") });
    return Response.json([]);
  }) as typeof fetch;
  const gh = githubConnector({ token: "ghp_test", owners: ["ampliize"] }, fetchImpl);
  const tool = (n: string) => gh.tools.find((t) => t.name === n)!;
  const file = await tool("github_arquivo").run({ repo: "jarviscentral", caminho: "../../etc/../src/a.ts", ref: null });
  assert.equal(JSON.parse(file.content).conteudo, "hello");
  assert.equal(seen[0]!.url, "https://api.github.com/repos/ampliize/jarviscentral/contents/etc/src/a.ts");
  assert.equal(seen[0]!.auth, "Bearer ghp_test");

  const denied = await tool("github_arquivo").run({ repo: "outra-org/segredo", caminho: "", ref: null });
  assert.equal(denied.ok, false);
  assert.match(JSON.parse(denied.content).erro, /Só leio repositórios de: ampliize/);
  assert.equal((await tool("github_atividade").run({ repo: "x/../y", estado: "open" })).ok, false);
  assert.ok(seen.every((s) => s.url.startsWith("https://api.github.com/")));
});

test("auditoria: registra cada ferramenta, esconde segredos e responde pela API", async () => {
  assert.deepEqual(summarizeArgs({ token: "abc", texto: "x".repeat(300), n: 2, lista: ["a"] }), { token: "[oculto]", texto: `${"x".repeat(200)}…`, n: 2, lista: '["a"]' });
  const dataDir = await tmp();
  const audit = new AuditLog(dataDir);
  const [c] = withAudit([{ id: "x", name: "X", description: "", tools: [{ name: "x_ok", description: "", parameters: {}, run: async () => ({ ok: true, content: "{}" }) }] }], audit);
  await c!.tools[0]!.run({ cliente: "Ruddar" });
  await new Promise((r) => setTimeout(r, 20));
  const list = await audit.recent(1);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.ferramenta, "x_ok");
  assert.deepEqual(list[0]!.parametros, { cliente: "Ruddar" });

  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir }), fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });
  assert.equal((await app.request("/api/auditoria")).status, 401);
  const body = (await (await app.request("/api/auditoria?dias=2", { headers: auth })).json()) as any;
  assert.equal(body.auditoria[0].ferramenta, "x_ok");
  // Sem CRM, o guardião avisa em vez de quebrar.
  assert.equal((await app.request("/api/agentes/revisar", { method: "POST", headers: auth })).status, 503);
  const connectors = (await (await app.request("/api/connectors", { headers: auth })).json()) as any[];
  assert.deepEqual(connectors.find((k) => k.id === "guardiao").ferramentas, ["agentes_revisar"]);
  assert.deepEqual(connectors.find((k) => k.id === "sites").ferramentas, ["site_criar"]);
  assert.ok(!connectors.some((k) => k.id === "github"), "sem GITHUB_TOKEN, sem conector");
});

test("revisão de código: rascunhos além dos 8 primeiros entram na próxima rodada e a auditoria cobre meses no meio", async () => {
  const dataDir = await tmp();
  const runs = Array.from({ length: 12 }, (_, i) => sdrRun({ id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}` }));
  const { fetchImpl, calls } = fakeServices({ veredito: "aprovado", resumo: "ok", problemas: [] }, runs);
  const guard = new AgentGuard({ config: cfg(dataDir), brainRoot: path.join(dataDir, "brain"), dataDir, fetchImpl });
  const first = await guard.reviewDrafts();
  assert.deepEqual([first.revisados_agora, first.restantes, first.revisoes.length], [8, 4, 8]);
  const second = await guard.reviewDrafts();
  assert.deepEqual([second.revisados_agora, second.restantes, second.revisoes.length], [4, 0, 12]);
  assert.equal(second.revisoes[0]!.id, runs[0]!.id, "mantém a ordem do CRM");
  assert.equal(calls.llm, 12);
  assert.equal((await guard.stored()).length, 12);

  let now = new Date("2026-01-31T12:00:00Z");
  const audit = new AuditLog(await tmp(), () => now);
  for (const d of ["2026-01-31T12:00:00Z", "2026-02-15T12:00:00Z", "2026-03-01T09:00:00Z"]) {
    now = new Date(d);
    await audit.record({ ferramenta: d.slice(0, 10), parametros: {}, ok: true, ms: 1 });
  }
  now = new Date("2026-03-01T12:00:00Z");
  assert.deepEqual((await audit.recent(30)).map((e) => e.ferramenta), ["2026-03-01", "2026-02-15", "2026-01-31"]);
});
