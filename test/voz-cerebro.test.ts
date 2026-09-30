import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Brain } from "../src/memory/brain.js";
import { BrainGit } from "../src/memory/brainGit.js";
import { speakableText } from "../src/voice.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const baseEnv = async (extra: Record<string, string> = {}) => ({
  JARVIS_ACCESS_TOKEN: TOKEN,
  OPENAI_API_KEY: "sk-test",
  DATA_DIR: await mkdtemp(path.join(os.tmpdir(), "jarvis-")),
  ...extra,
});

test("voz: transcrição manda o áudio como arquivo, em português, com o modelo configurado", async () => {
  let seen: { url: string; form: FormData; auth: string } | null = null;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(url), form: init!.body as FormData, auth: (init!.headers as Record<string, string>).Authorization! };
    return json({ text: " Como está a operação? " });
  }) as typeof fetch;
  const app = await createApp({ config: loadConfig(await baseEnv({ OPENAI_STT_MODEL: "gpt-4o-mini-transcribe" })), fetchImpl });

  const res = await app.request("/api/voice/transcribe", { method: "POST", headers: { ...auth, "Content-Type": "audio/webm;codecs=opus" }, body: new Uint8Array(3000) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "Como está a operação?" });
  assert.equal(seen!.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(seen!.auth, "Bearer sk-test");
  assert.equal(seen!.form.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(seen!.form.get("language"), "pt");
  assert.equal((seen!.form.get("file") as File).name, "fala.webm");

  // formato desconhecido, vazio e sem senha
  assert.equal((await app.request("/api/voice/transcribe", { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: "x" })).status, 415);
  assert.equal((await app.request("/api/voice/transcribe", { method: "POST", headers: { ...auth, "Content-Type": "audio/webm" }, body: new Uint8Array(0) })).status, 400);
  assert.equal((await app.request("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": "audio/webm" }, body: new Uint8Array(10) })).status, 401);
});

test("voz: fala devolve mp3 com a voz configurada e texto limpo de markdown", async () => {
  let body: any = null;
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init!.body));
    return new Response(new Uint8Array([0x49, 0x44, 0x33]), { headers: { "Content-Type": "audio/mpeg" } });
  }) as typeof fetch;
  const app = await createApp({ config: loadConfig(await baseEnv({ OPENAI_TTS_VOICE: "alloy" })), fetchImpl });
  const res = await app.request("/api/voice/speak", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "**Receita** de R$ 2.400. Veja https://crm.ampliize.com/x" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.equal((await res.arrayBuffer()).byteLength, 3);
  assert.equal(body.model, "tts-1");
  assert.equal(body.voice, "alloy");
  assert.equal(body.input, "Receita de R$ 2.400. Veja o link na tela");
  assert.equal(speakableText("```\ncodigo\n```\n# Título"), "Título");
});

test("voz: OpenAI sem crédito devolve 402", async () => {
  const fetchImpl = (async () => json({ error: { code: "insufficient_quota", message: "q" } }, 429)) as typeof fetch;
  const app = await createApp({ config: loadConfig(await baseEnv()), fetchImpl });
  const res = await app.request("/api/voice/speak", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ text: "oi" }) });
  assert.equal(res.status, 402);
});

test("modelo local: OPENAI_BASE_URL aponta o chat para outro endpoint (ex.: Ollama)", async () => {
  const urls: string[] = [];
  const auths: Array<string | undefined> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url));
    auths.push((init?.headers as Record<string, string>).Authorization);
    return json({ choices: [{ finish_reason: "stop", message: { content: "Olá." } }] });
  }) as typeof fetch;
  const app = await createApp({ config: loadConfig(await baseEnv({ OPENAI_BASE_URL: "http://ollama:11434/v1/", OPENAI_MODEL: "gemma4:e4b" })), fetchImpl });
  const res = await app.request("/api/chat", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "oi" }) });
  assert.equal(res.status, 200);
  assert.equal(urls[0], "http://ollama:11434/v1/chat/completions");
  // A chave da OpenAI nunca vai para outro endpoint.
  assert.equal(auths[0], undefined);
  const cfg = loadConfig(await baseEnv({ OPENAI_BASE_URL: "https://llm.exemplo.com/v1", LLM_API_KEY: "chave-do-llm" }));
  assert.equal(cfg.llmApiKey, "chave-do-llm");
  assert.equal(loadConfig(await baseEnv()).llmApiKey, "sk-test");
});

test("config: BRAIN_GIT_URL não aceita senha embutida", async () => {
  assert.throws(() => loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, OPENAI_API_KEY: "x", BRAIN_GIT_URL: "https://user:senha@github.com/a/b.git" }), /sem usuário/);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Davy", "-c", "user.email=davy@test", ...args], { cwd, encoding: "utf8" }).trim();

test("cérebro: clona vault vazio, cria a estrutura, envia notas e recebe o que vem do Obsidian", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vault-"));
  const remote = path.join(tmp, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);

  // Nota gravada antes de o Git ser ligado não pode se perder.
  const dataDir = path.join(tmp, "data");
  const brain = new Brain(dataDir);
  await brain.init();
  const early = await brain.propose("Nota antiga", "feita antes do git");

  const cfg = { url: remote, token: "tok-SECRETO-123", syncMinutes: 5, author: "Jarvis <jarvis@test>" };
  brain.git = new BrainGit(brain.root, cfg);
  await brain.git.setup();

  // O "Obsidian" (outro clone) vê a estrutura e a nota antiga.
  const obsidian = path.join(tmp, "obsidian");
  execFileSync("git", ["clone", "-q", remote, obsidian]);
  const readme = await readFile(path.join(obsidian, "README.md"), "utf8");
  assert.match(readme, /Cérebro do Jarvis/);
  assert.equal(await readFile(path.join(obsidian, early), "utf8").then((t) => t.includes("feita antes do git")), true);

  // Jarvis anota → aparece no Obsidian.
  const file = await brain.propose("Combinado Clínica Osso", "Relatório toda sexta.");
  assert.deepEqual(await brain.sync("Jarvis: nota"), { sincronizado: true });
  git(obsidian, "pull", "-q");
  assert.match(await readFile(path.join(obsidian, file), "utf8"), /Relatório toda sexta/);

  // Davy escreve o contexto permanente no Obsidian → Jarvis puxa e usa.
  await writeFile(path.join(obsidian, "_jarvis", "contexto.md"), "# Contexto permanente\n<!-- modelo -->\nPrioridade do trimestre: fechar 5 clínicas em Aracaju.\n");
  git(obsidian, "add", "-A");
  git(obsidian, "commit", "-qm", "contexto");
  git(obsidian, "push", "-q");
  await brain.git.pull();
  assert.equal(await brain.context(), "Prioridade do trimestre: fechar 5 clínicas em Aracaju.");

  // Os dois escrevem ao mesmo tempo: o push do Jarvis integra e não perde nada.
  await writeFile(path.join(obsidian, "clientes", "osso.md"), "# Clínica Osso\n");
  git(obsidian, "add", "-A");
  git(obsidian, "commit", "-qm", "cliente");
  git(obsidian, "push", "-q");
  const second = await brain.propose("Outra nota", "conteúdo");
  assert.deepEqual(await brain.sync("Jarvis: nota 2"), { sincronizado: true });
  git(obsidian, "pull", "-q");
  assert.ok(await readFile(path.join(obsidian, second), "utf8"));
  assert.ok(await readFile(path.join(brain.root, "clientes", "osso.md"), "utf8"));

  // O token nunca vai para o .git/config.
  assert.doesNotMatch(await readFile(path.join(brain.root, ".git", "config"), "utf8"), /SECRETO/);
});

test("cérebro: clone que falha não some com as notas e dá certo na nova tentativa", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vault-"));
  const remote = path.join(tmp, "remote.git");
  const brain = new Brain(path.join(tmp, "data"));
  await brain.init();
  const note = await brain.propose("Nota local", "não pode sumir");
  const cfg = { url: remote, token: "", syncMinutes: 5, author: "Jarvis <j@t>" };
  brain.git = new BrainGit(brain.root, cfg);
  await assert.rejects(brain.git.setup()); // repositório ainda não existe
  assert.match(await readFile(path.join(brain.root, note), "utf8"), /não pode sumir/);
  assert.equal((await brain.search("sumir"))[0]?.path, note);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  await brain.git.setup(); // nova tentativa
  assert.ok(await brain.git.isReady());
  assert.match(await readFile(path.join(brain.root, note), "utf8"), /não pode sumir/);
  const check = path.join(tmp, "check");
  execFileSync("git", ["clone", "-q", remote, check]);
  assert.match(await readFile(path.join(check, note), "utf8"), /não pode sumir/);
});

test("cérebro: erro do git não vaza o token e não derruba a nota", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vault-"));
  const brain = new Brain(path.join(tmp, "data"));
  await brain.init();
  brain.git = new BrainGit(brain.root, { url: path.join(tmp, "nao-existe.git"), token: "tok-SECRETO-456", syncMinutes: 5, author: "Jarvis <j@t>" });
  await assert.rejects(brain.git.setup(), (err: Error) => !err.message.includes("SECRETO"));
  const file = await brain.propose("Nota", "texto");
  const result = await brain.sync("x");
  assert.equal(result.sincronizado, false);
  assert.ok(!String(result.erro).includes("SECRETO"));
  assert.ok(file.startsWith("inbox/"));
});

test("contexto permanente entra no prompt do modelo", async () => {
  let system = "";
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    system = JSON.parse(String(init!.body)).messages[0].content;
    return json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
  }) as typeof fetch;
  const env = await baseEnv();
  const app = await createApp({ config: loadConfig(env), fetchImpl });
  await writeFile(path.join(env.DATA_DIR, "brain", "contexto-ignorado.md"), "x");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(env.DATA_DIR, "brain", "_jarvis"), { recursive: true });
  await writeFile(path.join(env.DATA_DIR, "brain", "_jarvis", "contexto.md"), "Sou o Davy, dono da Ampliize.");
  await app.request("/api/chat", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "oi" }) });
  assert.match(system, /Contexto permanente[\s\S]*Sou o Davy, dono da Ampliize\./);
});

test("primeiro start: sem senha definida o Jarvis gera, guarda e reaproveita", async () => {
  const env = await baseEnv({ JARVIS_ACCESS_TOKEN: "" });
  const logs: string[] = [];
  const { ensureAccessToken } = await import("../src/setup.js");
  const first = await ensureAccessToken(env.DATA_DIR, "", (m) => logs.push(m));
  assert.equal(first.generated, true);
  assert.ok(first.token.length >= 24);
  assert.ok(logs.join("").includes(first.token));
  const again = await ensureAccessToken(env.DATA_DIR, "", (m) => logs.push(m));
  assert.deepEqual(again, { token: first.token, generated: false });
  assert.equal(logs.length, 1);

  const app = await createApp({ config: loadConfig(env), fetchImpl: (async () => json({})) as typeof fetch });
  assert.equal((await app.request("/api/connectors", { headers: auth })).status, 401);
  assert.equal((await app.request("/api/connectors", { headers: { Authorization: `Bearer ${first.token}` } })).status, 200);
});

test("sem OPENAI_API_KEY: sobe, avisa no chat e na voz, e a configuração mostra o que falta", async () => {
  const env = await baseEnv({ OPENAI_API_KEY: "", AMPLIIZE_API_URL: "https://crm.test/api", AMPLIIZE_API_KEY: "amp_" + "a".repeat(48) });
  const fetchImpl = (async (url: RequestInfo | URL) =>
    String(url).startsWith("https://crm.test") ? json({ resource: "resources", data: {} }) : json({}, 500)) as typeof fetch;
  const app = await createApp({ config: loadConfig(env), fetchImpl });
  const chat = await app.request("/api/chat", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message: "oi" }) });
  assert.equal(chat.status, 503);
  assert.match(((await chat.json()) as any).error, /OPENAI_API_KEY/);
  const speakRes = await app.request("/api/voice/speak", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ text: "oi" }) });
  assert.equal(speakRes.status, 503);
  const status = (await (await app.request("/api/status", { headers: auth })).json()) as any;
  const byItem = Object.fromEntries(status.configuracao.map((i: any) => [i.item, i.ok]));
  assert.deepEqual(byItem, { "Chave da OpenAI": false, "CRM da Ampliize": true, "Cérebro no Obsidian": false, "Senha de acesso": true });
  assert.equal(status.configuracao.find((i: any) => i.item === "Cérebro no Obsidian").opcional, true);
});

test("senha: arquivo corrompido ou variável em branco param a subida em vez de trocar a senha", async () => {
  const env = await baseEnv({ JARVIS_ACCESS_TOKEN: "" });
  const { ensureAccessToken } = await import("../src/setup.js");
  await writeFile(path.join(env.DATA_DIR, ".access-token"), "curta\n");
  await assert.rejects(ensureAccessToken(env.DATA_DIR, "", () => undefined), /corrompido/);
  assert.equal((await readFile(path.join(env.DATA_DIR, ".access-token"), "utf8")).trim(), "curta");
  assert.throws(() => loadConfig({ ...env, JARVIS_ACCESS_TOKEN: "   " }), /espaços/);
});

test("status: várias chamadas ao mesmo tempo testam o CRM uma vez só", async () => {
  let crmCalls = 0;
  const env = await baseEnv({ AMPLIIZE_API_URL: "https://crm.test/api", AMPLIIZE_API_KEY: "amp_" + "a".repeat(48) });
  const fetchImpl = (async (url: RequestInfo | URL) => {
    if (String(url).startsWith("https://crm.test")) crmCalls++;
    return json({ resource: "resources", data: {} });
  }) as typeof fetch;
  const app = await createApp({ config: loadConfig(env), fetchImpl });
  await Promise.all([1, 2, 3].map(() => app.request("/api/status", { headers: auth })));
  await app.request("/api/status", { headers: auth });
  assert.equal(crmCalls, 1);
});
