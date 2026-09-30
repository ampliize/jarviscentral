import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { chatWithTools } from "../src/llm/openai.js";
import { Brain } from "../src/memory/brain.js";

const TOKEN = "t".repeat(32);
const AMPLIIZE_URL = "https://crm.test/functions/v1/integration-api";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** fetch falso: roteia OpenAI e CRM, registrando as chamadas. */
function fakeFetch(script: Array<(body: any) => Response>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let step = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers, body });
    if (url.startsWith(AMPLIIZE_URL)) {
      if (headers["x-api-key"] !== "amp_" + "a".repeat(48)) return json({ error: "Chave inválida" }, 401);
      if (body.resource === "overview") return json({ resource: "overview", data: { receita_recorrente_mensal: 2400, projetos: { atrasados: [{ nome: "Automação Osso" }] } } });
      return json({ error: "Recurso desconhecido" }, 404);
    }
    const handler = script[step++];
    if (!handler) throw new Error("chamada inesperada à OpenAI");
    return handler(body);
  }) as typeof fetch;
  return { impl, calls };
}

const config = async () =>
  loadConfig({
    JARVIS_ACCESS_TOKEN: TOKEN,
    OPENAI_API_KEY: "sk-test",
    DATA_DIR: await mkdtemp(path.join(os.tmpdir(), "jarvis-")),
    AMPLIIZE_API_URL: AMPLIIZE_URL,
    AMPLIIZE_API_KEY: "amp_" + "a".repeat(48),
    JARVIS_PROJECTS: JSON.stringify([{ id: "bateponto", name: "Bate-ponto", url: "https://ponto.test/api", key: "k" }]),
  });

test("config exige token forte e valida projetos", () => {
  assert.throws(() => loadConfig({ JARVIS_ACCESS_TOKEN: "curto", OPENAI_API_KEY: "x" }), /24 caracteres/);
  // Sem chave da OpenAI o Jarvis sobe (e avisa na tela), em vez de reiniciar em loop.
  assert.equal(loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN }).openaiApiKey, "");
  assert.throws(
    () => loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, OPENAI_API_KEY: "x", JARVIS_PROJECTS: '[{"id":"X!","url":"http://a","key":"k"}]' }),
    /id inválido/,
  );
});

test("API exige o token de acesso", async () => {
  const app = await createApp({ config: await config(), fetchImpl: fakeFetch([]).impl });
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/api/connectors")).status, 401);
  assert.equal((await app.request("/api/connectors", { headers: { Authorization: "Bearer errado" } })).status, 401);
  const ok = await app.request("/api/connectors", { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  const ids = ((await ok.json()) as Array<{ id: string }>).map((c) => c.id);
  assert.deepEqual(ids, ["ampliize", "bateponto", "memoria"]);
});

test("chat: o modelo chama a ferramenta do CRM e responde com o dado", async () => {
  const { impl, calls } = fakeFetch([
    (body) => {
      assert.equal(body.model, "gpt-4.1");
      assert.ok(body.tools.some((t: any) => t.function.name === "ampliize_panorama" && t.function.strict === true));
      assert.match(body.messages[0].content, /Jarvis/);
      return json({
        model: "gpt-4.1",
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ampliize_panorama", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    },
    (body) => {
      const toolMsg = body.messages.find((m: any) => m.role === "tool");
      assert.match(toolMsg.content, /2400/);
      return json({ model: "gpt-4.1", choices: [{ finish_reason: "stop", message: { content: "Receita recorrente de R$ 2.400,00; 1 projeto atrasado." } }], usage: { prompt_tokens: 200, completion_tokens: 20 } });
    },
  ]);
  const app = await createApp({ config: await config(), fetchImpl: impl });
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Como está a operação?" }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.match(data.answer, /2\.400/);
  assert.deepEqual(data.tools, [{ name: "ampliize_panorama", ok: true }]);
  assert.deepEqual(data.usage, { inputTokens: 300, outputTokens: 30 });
  const crmCall = calls.find((c) => c.url === AMPLIIZE_URL)!;
  assert.deepEqual(crmCall.body, { resource: "overview", params: {} });

  // A conversa fica salva e volta como contexto na próxima pergunta.
  const hist = await app.request(`/api/conversations/${data.conversationId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(((await hist.json()) as unknown[]).length, 2);
});

test("chat: erro do CRM vira resultado de ferramenta, não derruba a resposta", async () => {
  const { impl } = fakeFetch([
    () => json({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ampliize_erros", arguments: "{}" } }] } }] }),
    (body) => {
      const toolMsg = body.messages.find((m: any) => m.role === "tool");
      assert.match(toolMsg.content, /Recurso desconhecido/);
      return json({ choices: [{ finish_reason: "stop", message: { content: "Não consegui consultar os erros agora." } }] });
    },
  ]);
  const app = await createApp({ config: await config(), fetchImpl: impl });
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Tem erro no sistema?" }),
  });
  const data = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.deepEqual(data.tools, [{ name: "ampliize_erros", ok: false }]);
});

test("chat: OpenAI sem crédito devolve 402 com mensagem clara", async () => {
  const { impl } = fakeFetch([() => json({ error: { code: "insufficient_quota", message: "quota" } }, 429)]);
  const app = await createApp({ config: await config(), fetchImpl: impl });
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "oi" }),
  });
  assert.equal(res.status, 402);
});

test("loop de ferramentas tem limite e cai para gpt-4o-mini se o modelo não existir", async () => {
  const models: string[] = [];
  const loopForever = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    models.push(body.model);
    if (body.model === "modelo-inexistente") return json({ error: { code: "model_not_found", message: "no" } }, 404);
    return json({ choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "t", arguments: "{}" } }] } }] });
  }) as typeof fetch;
  const result = await chatWithTools({
    apiKey: "k",
    model: "modelo-inexistente",
    messages: [{ role: "user", content: "oi" }],
    tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }],
    runTool: async () => ({ ok: true, content: "{}" }),
    maxIterations: 3,
    fetchImpl: loopForever,
  });
  assert.equal(models[0], "modelo-inexistente");
  assert.equal(models[1], "gpt-4o-mini");
  assert.equal(result.toolRuns.length, 3);
  assert.match(result.text, /consultas demais/);
});

test("memória: anota só na inbox, não sobrescreve e encontra pela busca", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "brain-"));
  const brain = new Brain(dir);
  const a = await brain.propose("Combinado com a Clínica Osso", "Relatório toda sexta às 17h.", ["cliente"]);
  const b = await brain.propose("Combinado com a Clínica Osso", "Segunda versão.", ["cliente"]);
  assert.ok(a.startsWith("inbox/") && b.startsWith("inbox/") && a !== b);
  const content = await readFile(path.join(dir, "brain", a), "utf8");
  assert.match(content, /status: proposta/);
  const hits = await brain.search("clínica osso sexta");
  assert.equal(hits[0]?.path, a);
  // Título malicioso não sai da pasta inbox.
  const evil = await brain.propose("../../etc/passwd", "x");
  assert.ok(evil.startsWith("inbox/") && !evil.includes(".."));
  assert.equal((await readdir(path.join(dir, "brain", "inbox"))).length, 3);
  // Termo que só aparece no nome do arquivo ainda devolve o conteúdo da nota.
  const byName = await brain.search("passwd");
  assert.ok(byName[0] && byName[0].snippet.length > 0);
});
