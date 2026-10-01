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
import { buildOperation, gatherOperation, loadBriefing } from "./briefing.js";
import { AlertBook } from "./skills/alerts.js";
import { operationConnector } from "./skills/operation.js";
import type { Skills } from "./skills/index.js";
import { NewsService } from "./skills/news.js";
import { ReminderStore } from "./skills/reminders.js";
import { WeatherService } from "./skills/weather.js";
import { SystemMonitor, type MonitorOptions } from "./skills/monitor.js";
import { Playbooks } from "./skills/playbooks.js";
import { BriefingMusic, MAX_MUSIC_BYTES, musicType } from "./skills/music.js";
import { AuditLog, auditConnector, withAudit } from "./skills/audit.js";
import { AgentGuard, guardConnector } from "./skills/guard.js";
import { sitesConnector } from "./skills/sites.js";
import { githubConnector } from "./connectors/github.js";
import type { ToolLink } from "./llm/openai.js";
import { ClaudeCreative, type CreativeModel } from "./studio/claude.js";
import { isJobId, Studio, StudioError } from "./studio/studio.js";
import { jobView, studioConnector } from "./studio/connector.js";
import type { Runner } from "./studio/frames.js";
import type { ImageFormat } from "./studio/images.js";
import type { NetDeps } from "./studio/net.js";

const MAX_QUESTION_CHARS = 4_000;
const RATE_LIMIT_PER_MINUTE = 120;
const FAILED_AUTH_PER_MINUTE = 10;

/** Comparação de token em tempo constante (hash antes para igualar tamanhos). */
const sameToken = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export interface AppDeps {
  config: Config;
  fetchImpl?: typeof fetch;
  /** Testes: esperar o clone do vault antes de responder. */
  awaitBrainSetup?: boolean;
  /** Testes: DNS, certificado e relógio falsos para o monitor de sistemas. */
  monitorOptions?: Omit<MonitorOptions, "fetchImpl">;
  /** Testes: Claude, imagens, rede e ffmpeg falsos para o estúdio. */
  studioOptions?: { creative?: CreativeModel | null; image?: (prompt: string, format: ImageFormat) => Promise<Buffer>; net?: NetDeps; runner?: Runner };
}

/** Só links para destinos conhecidos viram botão no HUD (e "jarvis:estudio/<id>", que abre o andamento). */
const LINK_HOSTS = ["lovable.dev", "github.com"];
export const safeLinks = (links: ToolLink[] = []) =>
  links
    .filter((l) => {
      if (/^jarvis:estudio\/[a-f0-9]{24}$/.test(l.url)) return true;
      try {
        const u = new URL(l.url);
        return u.protocol === "https:" && LINK_HOSTS.includes(u.hostname);
      } catch {
        return false;
      }
    })
    .slice(0, 4)
    .map((l) => ({ rotulo: String(l.rotulo).slice(0, 40), url: l.url }));

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

const STUDIO_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg" };
const VIDEO_EXT: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Lê o corpo parando no limite (um envio sem Content-Length não enche a memória). null = passou do limite. */
async function readLimited(req: Request, max: number): Promise<ArrayBuffer | null> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export async function createApp({ config, fetchImpl, awaitBrainSetup, monitorOptions, studioOptions }: AppDeps) {
  const brain = new Brain(config.dataDir);
  const store = new ConversationStore(config.dataDir);
  await Promise.all([brain.init(), store.init()]);
  const access = await ensureAccessToken(config.dataDir, config.accessToken);
  const skills: Skills = {
    reminders: new ReminderStore(config.dataDir),
    weather: new WeatherService(fetchImpl),
    news: new NewsService(fetchImpl),
    city: config.city,
    timeZone: config.timeZone,
    monitor: new SystemMonitor(brain.root, { fetchImpl, ...monitorOptions }),
    alerts: new AlertBook(brain.root),
    guard: new AgentGuard({ config, brainRoot: brain.root, dataDir: config.dataDir, fetchImpl, context: () => brain.context() }),
  };
  const audit = new AuditLog(config.dataDir);
  const studio = new Studio({
    config,
    brain,
    dataDir: config.dataDir,
    creative: studioOptions && "creative" in studioOptions ? studioOptions.creative ?? null : config.anthropicApiKey ? new ClaudeCreative(config.anthropicApiKey) : null,
    image: studioOptions?.image,
    net: studioOptions?.net ?? (fetchImpl ? { fetchImpl } : undefined),
    runner: studioOptions?.runner,
  });
  await studio.recover();
  // Endereço público do Jarvis para as URLs dos sites (JARVIS_PUBLIC_URL ou o da última requisição).
  let origin = config.publicUrl || `http://localhost:${config.port}`;
  skills.monitor!.start();
  const playbooks = new Playbooks(brain.root);
  const music = new BriefingMusic(config.dataDir);
  const getOperation = async () => buildOperation(await gatherOperation(config, brain, fetchImpl, new Date(), skills));
  // Toda ferramenta usada fica registrada na auditoria (o que, com quais parâmetros, resultado).
  const connectors = withAudit(
    buildConnectors(config, brain, fetchImpl, skills, playbooks, [
      operationConnector(getOperation, skills.alerts!),
      guardConnector(skills.guard!),
      sitesConnector(config, brain, fetchImpl),
      studioConnector(studio, () => origin),
      ...(config.github ? [githubConnector(config.github, fetchImpl)] : []),
      auditConnector(audit),
    ]),
    audit,
  );

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
  // A prévia e os frames do estúdio são carregados por outros domínios (o site no Lovable).
  const strict = secureHeaders();
  const studioHeaders = secureHeaders({ crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false, xFrameOptions: false });
  app.use("*", (c, next) => (c.req.path.startsWith("/estudio/") ? studioHeaders(c, next) : strict(c, next)));
  /** Sem JARVIS_PUBLIC_URL: usa o endereço das requisições autenticadas (nunca de quem não tem a senha). */
  const learnOrigin = (c: Context) => {
    if (config.publicUrl) return;
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(c.req.url).protocol.replace(":", "");
    if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) && /^https?$/.test(proto)) origin = `${proto}://${host}`;
  };
  if (config.corsOrigins.length) {
    app.use("/api/*", cors({ origin: config.corsOrigins, allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "DELETE"] }));
  }

  app.get("/health", (c) => c.json({ ok: true, conectores: connectors.map((k) => k.id) }));

  // Autenticação simples de dono único: Bearer JARVIS_ACCESS_TOKEN.
  // Dois limites por IP: tentativas de senha errada (contra força bruta) e uso
  // normal (a voz em pedaços e os avisos de lembrete fazem várias chamadas).
  const hits = new Map<string, { count: number; resetAt: number }>();
  const failures = new Map<string, { count: number; resetAt: number }>();
  const over = (map: typeof hits, ip: string, limit: number, now: number) => {
    if (map.size > 5_000) for (const [k, v] of map) if (v.resetAt < now) map.delete(k);
    const bucket = map.get(ip);
    if (!bucket || bucket.resetAt < now) {
      map.set(ip, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    return ++bucket.count > limit;
  };
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const now = Date.now();
    const tooManyFailures = (failures.get(ip)?.resetAt ?? 0) >= now && (failures.get(ip)?.count ?? 0) >= FAILED_AUTH_PER_MINUTE;
    if (tooManyFailures) return c.json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);

    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !sameToken(token, access.token)) {
      over(failures, ip, FAILED_AUTH_PER_MINUTE, now);
      return c.json({ error: "Não autorizado." }, 401);
    }
    if (over(hits, ip, RATE_LIMIT_PER_MINUTE, now)) return c.json({ error: "Muitas requisições. Aguarde um minuto." }, 429);
    learnOrigin(c);
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
      return c.json(await loadBriefing(config, brain, fetchImpl, new Date(), skills));
    } catch (err) {
      console.error("briefing falhou:", err);
      return c.json({ error: "Não consegui montar o briefing." }, 500);
    }
  });

  // Trilha de abertura do briefing (arquivo do dono, guardado no volume /data).
  app.get("/api/briefing/musica/info", async (c) => c.json({ musica: await music.info() }));
  app.get("/api/briefing/musica", async (c) => {
    const found = await music.read();
    if (!found) return c.json({ error: "Nenhuma trilha enviada." }, 404);
    return new Response(new Uint8Array(found.data), { headers: { "Content-Type": found.info.tipo, "Cache-Control": "no-store" } });
  });
  app.post("/api/briefing/musica", async (c) => {
    const type = c.req.header("content-type") ?? "";
    if (!musicType(type)) return c.json({ error: "Envie um áudio (mp3, m4a, aac, ogg, wav ou webm)." }, 415);
    if (Number(c.req.header("content-length") ?? 0) > MAX_MUSIC_BYTES) return c.json({ error: "Arquivo grande demais (máximo 15 MB)." }, 413);
    const audio = await c.req.arrayBuffer();
    if (!audio.byteLength) return c.json({ error: "Arquivo vazio." }, 400);
    if (audio.byteLength > MAX_MUSIC_BYTES) return c.json({ error: "Arquivo grande demais (máximo 15 MB)." }, 413);
    try {
      return c.json({ musica: await music.save(audio, type, c.req.header("x-file-name") ?? "") });
    } catch (err) {
      console.error("trilha do briefing falhou:", err);
      return c.json({ error: "Não consegui guardar a trilha." }, 500);
    }
  });
  app.delete("/api/briefing/musica", async (c) => {
    await music.remove();
    return c.json({ musica: null });
  });

  // Lembretes: a HUD pergunta a cada 30 s quais venceram e avisa em voz.
  const reminderView = (r: { id: string; texto: string; quando: string; status: string }) => ({ id: r.id, texto: r.texto, quando: r.quando, status: r.status });
  app.get("/api/lembretes", async (c) => c.json({ lembretes: (await skills.reminders.open()).map(reminderView) }));
  // Sem efeito colateral: a tela manda até onde já avisou (desde) e guarda o "agora" devolvido.
  app.get("/api/lembretes/avisos", async (c) => {
    const now = new Date();
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const asked = Date.parse(c.req.query("desde") ?? "");
    const since = new Date(Number.isNaN(asked) ? now.getTime() - 60_000 : Math.min(now.getTime(), Math.max(asked, weekAgo)));
    return c.json({ avisos: (await skills.reminders.dueBetween(since, now)).map(reminderView), agora: now.toISOString() });
  });
  app.post("/api/lembretes/:id/concluir", async (c) => {
    const r = await skills.reminders.complete(c.req.param("id"));
    return r ? c.json({ ok: true, lembrete: reminderView(r) }) : c.json({ error: "Lembrete não encontrado." }, 404);
  });

  app.get("/api/sistemas", async (c) => {
    const monitor = skills.monitor!;
    return c.json({ sistemas: c.req.query("atualizar") === "1" ? await monitor.checkAll() : await monitor.status() });
  });
  // Monitor da operação: semáforo por área (mesmos dados do briefing, sem fala).
  app.get("/api/operacao", async (c) => {
    try {
      return c.json(await getOperation());
    } catch (err) {
      console.error("monitor da operação falhou:", err);
      return c.json({ error: "Não consegui montar o monitor da operação." }, 500);
    }
  });

  // Auditoria: tudo o que o Jarvis consultou ou fez.
  app.get("/api/auditoria", async (c) => {
    const dias = Math.min(30, Math.max(1, Number(c.req.query("dias")) || 1));
    return c.json({ auditoria: await audit.recent(dias, 300) });
  });

  // Guardião dos agentes de IA: revisa os rascunhos do CRM (só aponta).
  app.get("/api/agentes/revisoes", async (c) => c.json({ revisoes: await skills.guard!.stored() }));
  app.post("/api/agentes/revisar", async (c) => {
    if (!config.ampliize) return c.json({ error: "CRM não conectado." }, 503);
    try {
      return c.json(await skills.guard!.reviewDrafts());
    } catch (err) {
      console.error("guardião falhou:", err);
      return c.json({ error: err instanceof Error ? err.message : "Falha ao revisar os agentes." }, 502);
    }
  });

  // Estúdio de sites: produção em segundo plano; o HUD acompanha pelo id.
  app.post("/api/estudio", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "Envie o briefing em JSON." }, 400);
    try {
      return c.json({ trabalho: jobView(await studio.start(body as never, origin)) }, 202);
    } catch (err) {
      if (err instanceof StudioError) return c.json({ error: err.message }, 400);
      console.error("estúdio falhou:", err);
      return c.json({ error: "Não consegui começar a produção." }, 500);
    }
  });
  app.get("/api/estudio", async (c) => c.json({ trabalhos: (await studio.list(20)).map(jobView) }));
  app.get("/api/estudio/:id", async (c) => {
    const job = await studio.get(c.req.param("id"));
    return job ? c.json({ trabalho: jobView(job) }) : c.json({ error: "Trabalho não encontrado." }, 404);
  });
  app.post("/api/estudio/:id/video", async (c) => {
    const ext = VIDEO_EXT[(c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase()];
    if (!ext) return c.json({ error: "Envie um vídeo mp4, webm ou mov." }, 415);
    if (Number(c.req.header("content-length") ?? 0) > MAX_VIDEO_BYTES) return c.json({ error: "Vídeo grande demais (máximo 100 MB)." }, 413);
    const data = await readLimited(c.req.raw, MAX_VIDEO_BYTES);
    if (!data?.byteLength) return c.json({ error: "Vídeo vazio ou grande demais (máximo 100 MB)." }, 413);
    try {
      return c.json({ trabalho: jobView(await studio.attachVideo(c.req.param("id"), data, ext)) }, 202);
    } catch (err) {
      return c.json({ error: err instanceof StudioError ? err.message : "Não consegui usar o vídeo." }, err instanceof StudioError ? 409 : 500);
    }
  });

  app.get("/api/skills", async (c) => c.json({ skills: (await playbooks.list()).map((p) => ({ id: p.id, nome: p.nome, quando_usar: p.quando })) }));

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
      const [permanentContext, skillsIndex] = await Promise.all([brain.context(), playbooks.index()]);
      const result = await ask({ config, connectors, history, question, permanentContext, skillsIndex, fetchImpl });
      const at = new Date().toISOString();
      await store.append(conversationId, { role: "user", content: question, at });
      await store.append(conversationId, { role: "assistant", content: result.text, at: new Date().toISOString(), tools: result.toolRuns });
      return c.json({ conversationId, answer: result.text, tools: result.toolRuns, links: safeLinks(result.links), usage: result.usage, model: result.model });
    } catch (err) {
      console.error("chat falhou:", err);
      return aiErrorResponse(c, err);
    }
  });

  // Prévia pública do estúdio (id impossível de adivinhar). A página roda isolada
  // (CSP sandbox, origem opaca): o código gerado não alcança a senha guardada no HUD.
  app.get("/estudio/:id/*", async (c) => {
    const id = c.req.param("id");
    if (!isJobId(id)) return c.notFound();
    const rel = decodeURIComponent(c.req.path.slice(`/estudio/${id}/`.length));
    const download = rel === "baixar";
    const file = download || rel === "" ? "index.html" : rel;
    if (!/^(index\.html|assets\/[a-z0-9-]+\.webp|frames\/[dm]\/f_\d{3}\.webp)$/.test(file)) return c.notFound();
    const data = await readFile(path.join(studio.publicDir(id), file)).catch(() => null);
    if (!data) return c.notFound();
    const headers: Record<string, string> = {
      "Content-Type": STUDIO_TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
    };
    if (file === "index.html") {
      headers["Cache-Control"] = "no-store";
      headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
      if (download) headers["Content-Disposition"] = `attachment; filename="${id}.html"`;
    } else headers["Cache-Control"] = "public, max-age=31536000, immutable";
    return c.body(data, 200, headers);
  });

  // Interface (HUD com o holograma do camaleão da Ampliize).
  app.get("/", async (c) => c.html(await readFile(path.join(PUBLIC_DIR, "index.html"), "utf8")));
  app.get("/camaleao.png", async (c) =>
    c.body(await readFile(path.join(PUBLIC_DIR, "camaleao.png")), 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }),
  );

  return app;
}
