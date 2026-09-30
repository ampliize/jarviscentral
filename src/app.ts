import { timingSafeEqual, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ask, buildConnectors } from "./agent.js";
import type { Config } from "./config.js";
import { ConversationStore } from "./conversations/store.js";
import { OpenAIError } from "./llm/openai.js";
import { Brain } from "./memory/brain.js";
import { BrainGit } from "./memory/brainGit.js";
import { MAX_AUDIO_BYTES, audioExtension, speak, transcribe } from "./voice.js";
import { ensureAccessToken } from "./setup.js";
import { callResource } from "./connectors/resourceApi.js";
import { loadBriefing } from "./briefing.js";

const MAX_QUESTION_CHARS = 4_000;
const RATE_LIMIT_PER_MINUTE = 30;

/** Comparação de token em tempo constante (hash antes para igualar tamanhos). */
const sameToken = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface AppDeps {
  config: Config;
  fetchImpl?: typeof fetch;
  /** Testes: esperar o clone do vault antes de responder. */
  awaitBrainSetup?: boolean;
}

/** Converte erros da OpenAI em respostas claras para a interface. */
function aiErrorResponse(c: Context, err: unknown) {
  if (err instanceof OpenAIError) {
    if (err.code === "insufficient_quota") return c.json({ error: "A conta da OpenAI está sem créditos." }, 402);
    if (err.status === 401) return c.json({ error: "OPENAI_API_KEY inválida." }, 503);
    if (err.status === 429) return c.json({ error: "A OpenAI está limitando as requisições. Tente em instantes." }, 429);
    return c.json({ error: "A OpenAI falhou. Tente novamente." }, 502);
  }
  if (err instanceof DOMException && err.name === "TimeoutError") return c.json({ error: "A IA demorou demais." }, 504);
  return c.json({ error: "Erro interno do Jarvis." }, 500);
}

export async function createApp({ config, fetchImpl, awaitBrainSetup }: AppDeps) {
  const brain = new Brain(config.dataDir);
  const store = new ConversationStore(config.dataDir);
  await Promise.all([brain.init(), store.init()]);
  const access = await ensureAccessToken(config.dataDir, config.accessToken);
  const connectors = buildConnectors(config, brain, fetchImpl);

  // Cérebro no Obsidian: clona/sincroniza em segundo plano para não travar a subida.
  if (config.brainGit) {
    const git = new BrainGit(brain.root, config.brainGit);
    brain.git = git;
    const setup = git
      .setup()
      .then(() => console.log("cérebro: vault sincronizado com o Git"))
      .catch((err: Error) => {
        git.lastSync = { at: new Date().toISOString(), ok: false, message: err.message };
        console.error("cérebro: não consegui clonar o vault (tento de novo no próximo ciclo):", err.message);
      })
      .finally(() => git.start());
    if (awaitBrainSetup) await setup;
  }

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
    if (!token || !sameToken(token, access.token)) return c.json({ error: "Não autorizado." }, 401);
    return next();
  });

  const chatKeyMissing = config.usesOpenAI && !config.llmApiKey;
  const missingKey = (c: Context) => c.json({ error: "Falta configurar a OPENAI_API_KEY no Easypanel." }, 503);

  // Teste de conexão com o CRM: guardado por 1 minuto e uma chamada por vez.
  let crmCheck: { at: number; ok: boolean; erro?: string } | null = null;
  let crmPending: Promise<{ at: number; ok: boolean; erro?: string }> | null = null;
  const checkCrm = async () => {
    if (!config.ampliize) return null;
    if (crmCheck && Date.now() - crmCheck.at < 60_000) return crmCheck;
    crmPending ??= callResource({ ...config.ampliize, fetchImpl, timeoutMs: 5_000 }, "resources")
      .then(() => ({ at: Date.now(), ok: true }))
      .catch((err: unknown) => ({ at: Date.now(), ok: false, erro: err instanceof Error ? err.message : "falha" }))
      .then((result) => {
        crmCheck = result;
        crmPending = null;
        return result;
      });
    return crmPending;
  };

  app.get("/api/status", async (c) => {
    const crm = await checkCrm();
    const brainReady = brain.git ? await brain.git.isReady() : false;
    return c.json({
      modelo: config.openaiModel,
      voz: { ouvir: config.voice.sttModel, falar: `${config.voice.ttsModel}/${config.voice.ttsVoice}` },
      cerebro: brain.git ? { obsidian: true, pronto: brainReady, ultima_sincronizacao: brain.git.lastSync } : { obsidian: false },
      conectores: connectors.map((k) => k.id),
      // Lista do que está pronto e do que falta, para a tela de configuração.
      configuracao: [
        {
          item: "Chave da OpenAI",
          ok: !chatKeyMissing && !!config.voice.apiKey,
          dica: chatKeyMissing
            ? "Defina OPENAI_API_KEY no Easypanel (Environment) e faça Deploy."
            : "A voz usa a OpenAI: defina OPENAI_API_KEY (ou OPENAI_VOICE_API_KEY) para o microfone funcionar.",
        },
        {
          item: "CRM da Ampliize",
          ok: !!crm?.ok,
          dica: !config.ampliize
            ? "Defina AMPLIIZE_API_URL e AMPLIIZE_API_KEY (chave gerada no CRM: Monitor → Chaves de API)."
            : `O CRM não respondeu: ${crm?.erro ?? "erro"}. Confira a AMPLIIZE_API_URL e a AMPLIIZE_API_KEY.`,
        },
        {
          item: "Cérebro no Obsidian",
          opcional: true,
          ok: brainReady && brain.git?.lastSync?.ok !== false,
          dica: !brain.git
            ? "Opcional: defina BRAIN_GIT_URL e BRAIN_GIT_TOKEN para sincronizar com o Obsidian."
            : `Sincronização com problema: ${brain.git.lastSync?.message ?? "aguardando o primeiro clone"}.`,
        },
        {
          item: "Senha de acesso",
          ok: true,
          dica: config.accessToken
            ? "Definida em JARVIS_ACCESS_TOKEN."
            : `Gerada automaticamente: aparece nos logs do primeiro start e fica em ${path.join(config.dataDir, ".access-token")}.`,
        },
      ],
    });
  });

  app.post("/api/brain/sync", async (c) => {
    if (!brain.git) return c.json({ error: "Sincronização com o Obsidian não configurada (BRAIN_GIT_URL)." }, 400);
    try {
      await brain.git.pull();
      return c.json({ ok: true, ultima_sincronizacao: brain.git.lastSync });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Falha ao sincronizar." }, 502);
    }
  });

  app.post("/api/voice/transcribe", async (c) => {
    if (!config.voice.apiKey) return missingKey(c);
    const type = c.req.header("content-type") ?? "";
    if (!audioExtension(type)) return c.json({ error: "Envie o áudio (webm, ogg, mp4, m4a, mp3 ou wav)." }, 415);
    if (Number(c.req.header("content-length") ?? 0) > MAX_AUDIO_BYTES) return c.json({ error: "Áudio longo demais." }, 413);
    const audio = await c.req.arrayBuffer();
    if (!audio.byteLength) return c.json({ error: "Áudio vazio." }, 400);
    if (audio.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "Áudio longo demais." }, 413);
    try {
      return c.json({ text: await transcribe(config.voice, audio, type, fetchImpl) });
    } catch (err) {
      console.error("transcrição falhou:", err);
      return aiErrorResponse(c, err);
    }
  });

  app.post("/api/voice/speak", async (c) => {
    if (!config.voice.apiKey) return missingKey(c);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) return c.json({ error: "Envie { text }." }, 400);
    try {
      const mp3 = await speak(config.voice, text, fetchImpl);
      return new Response(mp3, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
    } catch (err) {
      console.error("voz falhou:", err);
      return aiErrorResponse(c, err);
    }
  });

  // Briefing do dia (cards + fala) a partir do CRM e das pendências do cérebro.
  app.get("/api/briefing", async (c) => {
    try {
      return c.json(await loadBriefing(config, brain, fetchImpl));
    } catch (err) {
      console.error("briefing falhou:", err);
      return c.json({ error: "Não consegui montar o briefing." }, 500);
    }
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
    if (chatKeyMissing) return missingKey(c);

    const conversationId = store.isValidId(body?.conversationId) ? body.conversationId : store.newId();
    const history = await store.recent(conversationId);

    try {
      const result = await ask({ config, connectors, history, question, permanentContext: await brain.context(), fetchImpl });
      const at = new Date().toISOString();
      await store.append(conversationId, { role: "user", content: question, at });
      await store.append(conversationId, { role: "assistant", content: result.text, at: new Date().toISOString(), tools: result.toolRuns });
      return c.json({ conversationId, answer: result.text, tools: result.toolRuns, usage: result.usage, model: result.model });
    } catch (err) {
      console.error("chat falhou:", err);
      return aiErrorResponse(c, err);
    }
  });

  // Interface (HUD com o holograma do camaleão da Ampliize).
  app.get("/", async (c) => c.html(await readFile(path.join(PUBLIC_DIR, "index.html"), "utf8")));
  app.get("/camaleao.png", async (c) =>
    c.body(await readFile(path.join(PUBLIC_DIR, "camaleao.png")), 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }),
  );

  return app;
}
