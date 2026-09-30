import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { systemPrompt } from "../src/agent.js";
import { buildBriefing } from "../src/briefing.js";
import { loadConfig } from "../src/config.js";
import { isPrivateAddress, parseSystems, SystemMonitor } from "../src/skills/monitor.js";
import { parsePlaybook, Playbooks, playbooksConnector } from "../src/skills/playbooks.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-"));

const SKILL = `---
nome: Cobrança de cliente
quando_usar: pedirem para cobrar alguém ou ver quem está devendo
---
# Cobrança
1. Veja as parcelas vencidas com ampliize_financeiro.
<!-- comentário interno -->
2. Monte a mensagem.`;

async function vault() {
  const root = await tmp();
  await mkdir(path.join(root, "_jarvis", "skills"), { recursive: true });
  await writeFile(path.join(root, "_jarvis", "skills", "cobranca.md"), SKILL);
  await writeFile(path.join(root, "_jarvis", "skills", "revisao-semanal.md"), "# Revisão semanal\nToda segunda.");
  await writeFile(path.join(root, "_jarvis", "skills", "README.md"), "não é skill");
  return root;
}

test("skills: lê cabeçalho, ignora comentário e README, acha por id ou nome", async () => {
  const p = parsePlaybook("cobranca", SKILL);
  assert.equal(p.nome, "Cobrança de cliente");
  assert.equal(p.quando, "pedirem para cobrar alguém ou ver quem está devendo");
  assert.ok(!p.corpo.includes("comentário interno"));
  assert.equal(parsePlaybook("x", "# Revisão semanal\ntexto").nome, "Revisão semanal");

  const books = new Playbooks(await vault());
  assert.deepEqual((await books.list()).map((b) => b.id), ["cobranca", "revisao-semanal"]);
  assert.equal((await books.get("COBRANÇA DE CLIENTE"))!.id, "cobranca");
  assert.equal((await books.get("revisao"))!.id, "revisao-semanal");
  assert.equal(await books.get("inexistente"), null);
  assert.equal(
    await books.index(),
    "- cobranca: Cobrança de cliente — usar quando pedirem para cobrar alguém ou ver quem está devendo\n- revisao-semanal: Revisão semanal",
  );

  const tools = Object.fromEntries(playbooksConnector(books).tools.map((t) => [t.name, t]));
  const opened = await tools.skill_abrir!.run({ nome: "cobranca" });
  assert.equal(opened.ok, true);
  assert.match(opened.content, /ampliize_financeiro/);
  const missing = await tools.skill_abrir!.run({ nome: "xyz" });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /revisao-semanal/);
});

test("skills: a lista entra no prompt do sistema", () => {
  const config = loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN });
  const prompt = systemPrompt(config, [], new Date("2026-09-30T12:00:00Z"), "", "- cobranca: Cobrança de cliente");
  assert.match(prompt, /Skills \(processos da Ampliize.*chame skill_abrir[\s\S]*- cobranca: Cobrança de cliente/);
  assert.ok(!systemPrompt(config, [], new Date()).includes("Skills (processos"));
});

test("sistemas: lê lista e tabela Markdown, sem repetir URL", () => {
  const md = `# Sistemas
<!-- - Exemplo | https://exemplo.com | Cliente -->
- CRM da Ampliize | https://ampliize.lovable.app | Ampliize
- **Site** | https://ampliize.com
| Nome | URL | Cliente |
|---|---|---|
| Reutiliize API | https://abc.supabase.co | Reutiliize |
- repetido | https://ampliize.com | x
- https://sem-nome.com.br/app
- https://crm.x.com | CRM | Ampliize
- Quebrada | https://% | Cliente
- http://inseguro.com | sem https
Uma linha por sistema: \`Nome | https://... | Cliente\`. Só \`https://\` de endereços públicos.
- Sem domínio | https://localhost
texto sem link`;
  assert.deepEqual(parseSystems(md), [
    { nome: "CRM da Ampliize", url: "https://ampliize.lovable.app", cliente: "Ampliize" },
    { nome: "Site", url: "https://ampliize.com", cliente: null },
    { nome: "Reutiliize API", url: "https://abc.supabase.co", cliente: "Reutiliize" },
    { nome: "sem-nome.com.br", url: "https://sem-nome.com.br/app", cliente: null },
    { nome: "CRM", url: "https://crm.x.com", cliente: "Ampliize" },
  ]);
});

test("sistemas: classifica no ar, atenção e fora; certificado; uptime de 24 h", async () => {
  const root = await tmp();
  await mkdir(path.join(root, "_jarvis"), { recursive: true });
  await writeFile(
    path.join(root, "_jarvis", "sistemas.md"),
    ["- Site | https://ok.test", "- API | https://api.test | Cliente A", "- Quebrado | https://down.test", "- 404 | https://missing.test", "- SSL | https://ssl.test"].join("\n"),
  );
  let clock = 1_000_000;
  let downAnswers = 0;
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const host = new URL(String(url)).hostname;
    if (host === "down.test") {
      downAnswers++;
      if (downAnswers === 1) throw new TypeError("fetch failed");
      return new Response("", { status: 200 });
    }
    const status = host === "api.test" ? 401 : host === "missing.test" ? 404 : 200;
    return new Response("", { status });
  }) as typeof fetch;
  const lookup = async () => ["93.184.216.34"];
  const monitor = new SystemMonitor(root, { fetchImpl, lookup, sslCheck: async (h) => (h === "ssl.test" ? 5 : 200), now: () => clock });
  const first = Object.fromEntries((await monitor.checkAll()).map((s) => [s.nome, s]));
  assert.equal(first.Site!.status, "ok");
  assert.equal(first.API!.status, "ok", "401 = API no ar pedindo chave");
  assert.equal(first.API!.cliente, "Cliente A");
  assert.equal(first.Quebrado!.status, "fora");
  assert.equal(first.Quebrado!.detalhe, "sem conexão");
  assert.equal(first["404"]!.status, "atencao");
  assert.equal(first.SSL!.status, "atencao");
  assert.equal(first.SSL!.detalhe, "certificado HTTPS vence em 5 dia(s)");
  assert.equal(first.Quebrado!.uptime_24h, 0);

  clock += 5 * 60_000;
  const second = Object.fromEntries((await monitor.checkAll()).map((s) => [s.nome, s]));
  assert.equal(second.Quebrado!.status, "ok");
  assert.equal(second.Quebrado!.uptime_24h, 50);
  // status() reaproveita o último teste dentro da janela.
  clock += 1_000;
  const cached = await monitor.status();
  assert.equal(cached.find((s) => s.nome === "Quebrado")!.uptime_24h, 50);

  // Resposta acima de 3 s = atenção (lento).
  const slowRoot = await tmp();
  await mkdir(path.join(slowRoot, "_jarvis"), { recursive: true });
  await writeFile(path.join(slowRoot, "_jarvis", "sistemas.md"), "- Lento | https://slow.test");
  let t = 0;
  const slow = new SystemMonitor(slowRoot, {
    lookup,
    fetchImpl: (async () => {
      t += 4_000;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    sslCheck: async () => 200,
    now: () => t,
  });
  const [lento] = await slow.checkAll();
  assert.equal(lento!.status, "atencao");
  assert.equal(lento!.detalhe, "lento (4.0 s)");
});

test("sistemas: não acessa rede interna, não segue link simbólico e junta testes próximos", async () => {
  for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.20.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);

  const root = await tmp();
  await mkdir(path.join(root, "_jarvis"), { recursive: true });
  await writeFile(path.join(root, "_jarvis", "sistemas.md"), "- Interno | https://intranet.test\n- IP | https://10.0.0.5\n- Sumiu | https://nao-existe.test");
  let fetched = 0;
  const monitor = new SystemMonitor(root, {
    fetchImpl: (async () => {
      fetched++;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    lookup: async (h) => {
      if (h === "nao-existe.test") throw new Error("ENOTFOUND");
      return ["10.1.2.3"];
    },
    sslCheck: async () => 200,
  });
  const out = Object.fromEntries((await monitor.checkAll()).map((s) => [s.nome, s]));
  assert.equal(fetched, 0, "nenhuma requisição para endereço interno");
  assert.equal(out.Interno!.detalhe, "endereço interno: não monitorado");
  assert.equal(out.IP!.detalhe, "endereço interno: não monitorado");
  assert.equal(out.Sumiu!.status, "fora");
  assert.equal(out.Sumiu!.detalhe, "domínio não encontrado");

  // Link simbólico no lugar do sistemas.md é ignorado.
  const other = await tmp();
  await mkdir(path.join(other, "_jarvis"), { recursive: true });
  const target = path.join(other, "segredo.md");
  await writeFile(target, "- X | https://x.test");
  await symlink(target, path.join(other, "_jarvis", "sistemas.md"));
  assert.deepEqual(await new SystemMonitor(other).systems(), []);

  // Vários testes em menos de 4 min contam como uma amostra: não derruba a disponibilidade.
  const flaky = await tmp();
  await mkdir(path.join(flaky, "_jarvis"), { recursive: true });
  await writeFile(path.join(flaky, "_jarvis", "sistemas.md"), "- S | https://s.test");
  let t = 0;
  let down = true;
  const m = new SystemMonitor(flaky, {
    fetchImpl: (async () => (down ? Promise.reject(new TypeError("x")) : new Response(""))) as typeof fetch,
    lookup: async () => ["93.184.216.34"],
    sslCheck: async () => 200,
    now: () => t,
  });
  for (let i = 0; i < 5; i++) {
    await m.checkAll();
    t += 30_000;
  }
  down = false;
  t += 10 * 60_000;
  const [after] = await m.checkAll();
  assert.equal(after!.uptime_24h, 50);
});

test("skills: link simbólico na pasta não é lido", async () => {
  const root = await vault();
  const secret = path.join(root, "segredo.txt");
  await writeFile(secret, "TOKEN-SECRETO");
  await symlink(secret, path.join(root, "_jarvis", "skills", "token.md"));
  const books = new Playbooks(root);
  assert.deepEqual((await books.list()).map((b) => b.id), ["cobranca", "revisao-semanal"]);
});

test("briefing: card de sistemas fala só dos problemas e conta como atenção", () => {
  const base = { cliente: null, http: 200, ms: 120, ssl_dias: 80, detalhe: null, uptime_24h: 100, verificado_em: "" };
  const b = buildBriefing({
    crm: null,
    crmConfigured: false,
    pendencias: [],
    inbox: 0,
    ownerName: "Davy",
    timeZone: "America/Maceio",
    now: new Date("2026-09-30T12:00:00Z"),
    sistemas: [
      { ...base, nome: "CRM", url: "https://a", status: "ok" },
      { ...base, nome: "Marketplace", url: "https://b", cliente: "Reutiliize", status: "fora", http: null, ms: null, detalhe: "não respondeu em 10 s" },
    ],
  });
  const card = b.cards.find((c) => c.id === "sistemas")!;
  assert.equal(card.destaque!.valor, "1/2");
  assert.equal(card.fala, "Um sistema pede atenção: Marketplace (Reutiliize), fora do ar, não respondeu em 10 s.");
  assert.deepEqual(b.numeros.sistemas, { total: 2, ok: 1 });
  assert.equal(b.atencao, 1, "conta mesmo sem o CRM");
  assert.match(b.abertura, /Um ponto pede sua atenção/);
  const calm = buildBriefing({ crm: null, crmConfigured: false, pendencias: [], inbox: 0, ownerName: "Davy", timeZone: "America/Maceio", sistemas: [{ ...base, nome: "CRM", url: "https://a", status: "ok" }] });
  assert.equal(calm.cards.find((c) => c.id === "sistemas")!.fala, "O sistema monitorado está no ar, sem alertas.");
});

test("rotas /api/skills e /api/sistemas", async () => {
  const dataDir = await tmp();
  const brain = path.join(dataDir, "brain");
  await mkdir(path.join(brain, "_jarvis", "skills"), { recursive: true });
  await writeFile(path.join(brain, "_jarvis", "skills", "cobranca.md"), SKILL);
  await writeFile(path.join(brain, "_jarvis", "sistemas.md"), "- Site | https://ok.test | Ampliize");
  const fetchImpl = (async () => new Response("", { status: 200 })) as typeof fetch;
  const app = await createApp({
    config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir }),
    fetchImpl,
    monitorOptions: { lookup: async () => ["93.184.216.34"], sslCheck: async () => 200 },
  });
  assert.equal((await app.request("/api/skills")).status, 401);
  const skills = (await (await app.request("/api/skills", { headers: auth })).json()) as any;
  assert.deepEqual(skills.skills, [{ id: "cobranca", nome: "Cobrança de cliente", quando_usar: "pedirem para cobrar alguém ou ver quem está devendo" }]);
  const sys = (await (await app.request("/api/sistemas?atualizar=1", { headers: auth })).json()) as any;
  assert.equal(sys.sistemas[0].nome, "Site");
  assert.equal(sys.sistemas[0].http, 200);
});
