import { timingSafeEqual, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ask, buildConnectors } from "./agent.js";
import type { Config } from "./config.js";
import { ConversationStore } from "./conversations/store.js";
import { OpenAIError } from "./llm/openai.js";
import { Brain } from "./memory/brain.js";

const MAX_QUESTION_CHARS = 4_000;
const RATE_LIMIT_PER_MINUTE = 30;

/** Comparação de token em tempo constante (hash antes para igualar tamanhos). */
const sameToken = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface AppDeps {
  config: Config;
  fetchImpl?: typeof fetch;
}

export async function createApp({ config, fetchImpl }: AppDeps) {
  const brain = new Brain(config.dataDir);
  const store = new ConversationStore(config.dataDir);
  await Promise.all([brain.init(), store.init()]);
  const connectors = buildConnectors(config, brain, fetchImpl);

  const app = new Hono();
  app.use("*", secureHeaders());
  if (config.corsOrigins.length) {
    app.use("/api/*", cors({ origin: config.corsOrigins, allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST"] }));
  }

  app.get("/health", (c) => c.json({ ok: true, conectores: connectors.map((k) => k.id) }));

  // Autenticação simples de dono único: Bearer JARVIS_ACCESS_TOKEN.
  const hits = new Map<string, { count: number; resetAt: number }>();
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const now = Date.now();
    if (hits.size > 5_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    const bucket = hits.get(ip);
    if (!bucket || bucket.resetAt < now) hits.set(ip, { count: 1, resetAt: now + 60_000 });
    else if (++bucket.count > RATE_LIMIT_PER_MINUTE) return c.json({ error: "Muitas requisições. Aguarde um minuto." }, 429);

    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !sameToken(token, config.accessToken)) return c.json({ error: "Não autorizado." }, 401);
    return next();
  });

  app.get("/api/connectors", (c) =>
    c.json(connectors.map((k) => ({ id: k.id, nome: k.name, descricao: k.description, ferramentas: k.tools.map((t) => t.name) }))),
  );

  app.get("/api/conversations", async (c) => c.json(await store.list()));

  app.get("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!store.isValidId(id)) return c.json({ error: "Conversa inválida." }, 400);
    return c.json(await store.read(id));
  });

  app.post("/api/chat", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; conversationId?: unknown } | null;
    const question = typeof body?.message === "string" ? body.message.trim() : "";
    if (!question) return c.json({ error: "Envie { message }." }, 400);
    if (question.length > MAX_QUESTION_CHARS) return c.json({ error: "Mensagem longa demais." }, 413);

    const conversationId = store.isValidId(body?.conversationId) ? body.conversationId : store.newId();
    const history = await store.recent(conversationId);

    try {
      const result = await ask({ config, connectors, history, question, fetchImpl });
      const at = new Date().toISOString();
      await store.append(conversationId, { role: "user", content: question, at });
      await store.append(conversationId, { role: "assistant", content: result.text, at: new Date().toISOString(), tools: result.toolRuns });
      return c.json({ conversationId, answer: result.text, tools: result.toolRuns, usage: result.usage, model: result.model });
    } catch (err) {
      console.error("chat falhou:", err);
      if (err instanceof OpenAIError) {
        if (err.code === "insufficient_quota") return c.json({ error: "A conta da OpenAI está sem créditos." }, 402);
        if (err.status === 401) return c.json({ error: "OPENAI_API_KEY inválida." }, 503);
        if (err.status === 429) return c.json({ error: "A OpenAI está limitando as requisições. Tente em instantes." }, 429);
        return c.json({ error: "A OpenAI falhou. Tente novamente." }, 502);
      }
      if (err instanceof DOMException && err.name === "TimeoutError") return c.json({ error: "A IA demorou demais." }, 504);
      return c.json({ error: "Erro interno do Jarvis." }, 500);
    }
  });

  // Interface provisória (será trocada pelo frontend definitivo do Jarvis).
  app.get("/", async (c) => c.html(await readFile(path.join(PUBLIC_DIR, "index.html"), "utf8")));

  return app;
}
