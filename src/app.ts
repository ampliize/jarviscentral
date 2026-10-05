import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
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

/** Conversa do recurso whatsapp_inbox do CRM (só os campos que o HUD usa). */
interface WhatsappConversa {
  id: number;
  nome: string | null;
  aguardando_nossa_resposta: boolean;
  texto_do_lead: string | null;
  lead_escreveu_em: string | null;
}
/** Reunião marcada pelo atendente de IA (recurso agent_meetings do CRM, sem telefone nem e-mail). */
interface AgentMeeting {
  lead_id: number;
  nome: string | null;
  marcada_em: string | null;
  [campo: string]: unknown;
}
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
import { OpenAICreative } from "./studio/openai-creative.js";
import { isJobId, Studio, StudioError } from "./studio/studio.js";
import { jobView, studioConnector } from "./studio/connector.js";
import type { Runner } from "./studio/frames.js";
import type { ImageFormat } from "./studio/images.js";
import type { NetDeps } from "./studio/net.js";
import { CrmPanels, PANEL_KINDS, PanelError, panelsConnector, type PanelKind } from "./skills/panels.js";
import { isMissionId, isReportId, MissionError, MissionRunner, MissionStore, describeFrequency, type Mission } from "./skills/missions.js";
import { MANAGER_PACK, missionExecutor, missionsConnector } from "./skills/manager.js";
import type { Connector } from "./connectors/types.js";
import { ActionError, type Platform } from "./ads/actions.js";
import { trafficConnector } from "./ads/connector.js";
import { GoogleAds } from "./ads/google.js";
import { MetaAds } from "./ads/meta.js";
import { TrafficManager } from "./ads/service.js";
import { isProposalId, TrafficError, TrafficStore } from "./ads/store.js";
import { AdsError, type AdsClient, type StatsLevel } from "./ads/types.js";

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
  /** Testes: não liga o agendador das missões (elas rodam só quando o teste manda). */
  noScheduler?: boolean;
  /** Testes: esperar o clone do vault antes de responder. */
  awaitBrainSetup?: boolean;
  /** Testes: DNS, certificado e relógio falsos para o monitor de sistemas. */
  monitorOptions?: Omit<MonitorOptions, "fetchImpl">;
  /** Testes: Claude, imagens, rede e ffmpeg falsos para o estúdio. */
  studioOptions?: { creative?: CreativeModel | null; image?: (prompt: string, format: ImageFormat) => Promise<Buffer>; net?: NetDeps; runner?: Runner };
  /** Testes: plataformas de anúncio falsas. */
  adsClients?: Partial<Record<Platform, AdsClient>>;
}

/** Só links para destinos conhecidos viram botão no HUD (e "jarvis:estudio/<id>", que abre o andamento). */
const LINK_HOSTS = ["lovable.dev", "github.com"];
const PANEL_LINK_RE = new RegExp(`^jarvis:painel/(${PANEL_KINDS.join("|")})$`);
export const safeLinks = (links: ToolLink[] = []) =>
  links
    .filter((l) => {
      if (/^jarvis:estudio\/[a-f0-9]{24}$/.test(l.url)) return true;
      if (PANEL_LINK_RE.test(l.url)) return true;
      if (/^jarvis:missao\/m_[a-f0-9]{12}$/.test(l.url)) return true;
      if (/^jarvis:trafego\/a_[a-f0-9]{12}$/.test(l.url)) return true;
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

/** Motor criativo do estúdio: Claude se houver chave; senão a OpenAI (só com a API oficial, que lê imagens). */
function studioEngine(config: Config): CreativeModel | null {
  if (config.anthropicApiKey) return new ClaudeCreative(config.anthropicApiKey);
  if (config.openaiApiKey) return new OpenAICreative(config.openaiApiKey, config.studioOpenAIModel);
  return null;
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

/** Erro do agente de tráfego → resposta HTTP clara. */
function trafficError(c: Context, err: unknown) {
  if (err instanceof ActionError || err instanceof TrafficError) return c.json({ error: err.message }, 409);
  if (err instanceof AdsError) return c.json({ error: err.message }, 502);
  console.error("tráfego falhou:", err);
  return c.json({ error: "Falha no agente de tráfego." }, 500);
}

const OAUTH_PAGE = (titulo: string, texto: string) =>
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><body style="font-family:system-ui,sans-serif;background:#0b1116;color:#e2e9ef;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:22px">${titulo}</h1><p>${texto}</p></main></body></html>`;

export async function createApp({ config, fetchImpl, awaitBrainSetup, monitorOptions, studioOptions, noScheduler, adsClients }: AppDeps) {
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
    panels: new CrmPanels(config.ampliize ?? null, fetchImpl),
    missions: new MissionStore(config.dataDir, config.timeZone),
  };
  const audit = new AuditLog(config.dataDir);
  // Agente de tráfego: propõe; o dono aprova (HUD/WhatsApp) ou deu permissão.
  const google = config.ads.google ? new GoogleAds(config.ads.google, config.dataDir, fetchImpl) : null;
  const traffic = new TrafficManager(
    new TrafficStore(config.dataDir),
    adsClients ?? { ...(google ? { google } : {}), ...(config.ads.meta ? { meta: new MetaAds(config.ads.meta, fetchImpl) } : {}) },
    { limits: { maxDailyBudget: config.ads.maxDailyBudget }, timeZone: config.timeZone, grantDays: config.ads.grantDays },
  );
  const engine = studioOptions && "creative" in studioOptions ? studioOptions.creative ?? null : studioEngine(config);
  const studio = new Studio({
    config,
    brain,
    dataDir: config.dataDir,
    // Claude quando a ANTHROPIC_API_KEY existir; até lá, a OpenAI que o Jarvis já usa.
    creative: engine,
    motor: engine instanceof ClaudeCreative ? "claude" : "openai",
    searchKeys: { pexels: config.pexelsApiKey, unsplash: config.unsplashAccessKey },
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
  // Jarvis gerente: executa as missões delegadas sozinho, com as mesmas ferramentas (só leitura).
  let allConnectors: Connector[] = [];
  const missionStore = skills.missions!;
  const runner = new MissionRunner(
    missionStore,
    missionExecutor({ config, brain, store: missionStore, connectors: () => allConnectors, playbooksIndex: () => playbooks.index(), fetchImpl }),
    { maxPerDay: config.missionsMaxPerDay, timeZone: config.timeZone, onError: (m, err) => console.error(m ? `missão "${m.titulo}" falhou:` : "agendador de missões falhou:", err instanceof Error ? err.message : err) },
  );
  // Toda ferramenta usada fica registrada na auditoria (o que, com quais parâmetros, resultado).
  const connectors = withAudit(
    buildConnectors(config, brain, fetchImpl, skills, playbooks, [
      operationConnector(getOperation, skills.alerts!),
      guardConnector(skills.guard!),
      sitesConnector(config, brain, fetchImpl),
      studioConnector(studio, () => origin),
      ...(config.github ? [githubConnector(config.github, fetchImpl)] : []),
      auditConnector(audit),
      panelsConnector(skills.panels!),
      missionsConnector(missionStore, runner),
      trafficConnector(traffic),
    ]),
    audit,
  );
  allConnectors = connectors;

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

  // Login do Google Ads (botão "Conectar Google Ads" no HUD). Rota pública: só
  // aceita um "state" que o próprio Jarvis gerou há menos de 10 min, uma vez.
  const oauthStates = new Map<string, { until: number; redirect: string }>();
  app.get("/oauth/google/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const saved = oauthStates.get(state);
    oauthStates.delete(state);
    if (!google || !saved || saved.until < Date.now()) {
      return c.html(OAUTH_PAGE("Link vencido", "Volte ao Jarvis e toque em Conectar Google Ads de novo."), 400);
    }
    const code = c.req.query("code") ?? "";
    if (!code) return c.html(OAUTH_PAGE("Conexão cancelada", "O Google não autorizou o acesso. Você pode tentar de novo pelo Jarvis."), 400);
    try {
      await google.exchangeCode(code, saved.redirect);
      return c.html(OAUTH_PAGE("Google Ads conectado", "Pode fechar esta aba e voltar ao Jarvis."));
    } catch (err) {
      console.error("google ads: conexão falhou:", err instanceof Error ? err.message : err);
      return c.html(OAUTH_PAGE("Não consegui conectar", "Confira as variáveis do Google Ads no Easypanel e tente de novo."), 502);
    }
  });

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
  // Sem chave da IA as missões não têm como rodar: o agendador fica parado.
  if (!chatKeyMissing && !noScheduler) runner.start();
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

  const lastState = (ok: boolean | null) => (ok === null ? "nao_testado" : ok ? "conectado" : "falha");
  app.get("/api/status", async (c) => {
    const [crm, brainReady, systems] = await Promise.all([
      checkCrm(),
      brain.git ? brain.git.isReady() : false,
      skills.monitor!.systems().catch(() => []),
    ]);
    return c.json({
      modelo: config.openaiModel,
      voz: { ouvir: config.voice.sttModel, falar: `${config.voice.ttsModel}/${config.voice.ttsVoice}` },
      cerebro: brain.git ? { obsidian: true, pronto: brainReady, ultima_sincronizacao: brain.git.lastSync } : { obsidian: false },
      conectores: connectors.map((k) => k.id),
      // Painel "Núcleo · Serviços" do HUD: só o que é verdade agora.
      servicos: {
        motor: !chatKeyMissing,
        crm: !!crm?.ok,
        fala: config.voice.apiKey ? "openai" : "navegador",
        estudio: engine ? (engine instanceof ClaudeCreative ? "claude" : "openai") : null,
        github: !!config.github,
        sistemas_monitorados: systems.length,
      },
      // Tela "Fontes de dados": de onde vem cada informação e como ligar o que falta.
      fontes: [
        { id: "crm", nome: "CRM da Ampliize", area: "Operação, agenda e finanças", estado: !config.ampliize ? "desligado" : crm?.ok ? "conectado" : "falha", como_ligar: "AMPLIIZE_API_URL e AMPLIIZE_API_KEY" },
        { id: "cerebro", nome: "Cérebro (Obsidian)", area: "Memória", estado: !brain.git ? "desligado" : brainReady && brain.git.lastSync?.ok !== false ? "conectado" : "falha", como_ligar: "BRAIN_GIT_URL e BRAIN_GIT_TOKEN" },
        // Chave da OpenAI presente (motor quando usa a OpenAI, voz sempre); não testa a conta.
        { id: "openai", nome: "OpenAI", area: "Motor e voz", estado: (config.usesOpenAI && config.llmApiKey) || config.voice.apiKey ? "configurado" : "desligado", como_ligar: "OPENAI_API_KEY" },
        // Serviços públicos: o estado é o da última consulta real.
        { id: "clima", nome: "Clima (Open-Meteo)", area: "Sensores", estado: lastState(skills.weather.lastOk), como_ligar: null },
        { id: "noticias", nome: "Notícias (Google Notícias)", area: "Radar", estado: lastState(skills.news.lastOk), como_ligar: null },
        { id: "sistemas", nome: "Monitor de sistemas", area: "Sites e APIs dos clientes", estado: systems.length ? "conectado" : "desligado", como_ligar: "_jarvis/sistemas.md no cérebro" },
        // Chaves sem teste de conta: "configurado" (não "conectado").
        { id: "github", nome: "GitHub", area: "Código (leitura)", estado: config.github ? "configurado" : "desligado", como_ligar: "GITHUB_TOKEN" },
        { id: "anthropic", nome: "Claude (Anthropic)", area: "Estúdio de sites", estado: config.anthropicApiKey ? "configurado" : "desligado", como_ligar: "ANTHROPIC_API_KEY" },
        { id: "pexels", nome: "Pexels", area: "Referências do estúdio", estado: config.pexelsApiKey ? "configurado" : "desligado", como_ligar: "PEXELS_API_KEY" },
        { id: "unsplash", nome: "Unsplash", area: "Referências do estúdio", estado: config.unsplashAccessKey ? "configurado" : "desligado", como_ligar: "UNSPLASH_ACCESS_KEY" },
        ...config.projects.map((p) => ({ id: `projeto-${p.id}`, nome: p.name, area: "Projeto conectado", estado: "configurado", como_ligar: null })),
        { id: "whatsapp", nome: "WhatsApp", area: "Comunicações", estado: "indisponivel", como_ligar: "ainda não integrado" },
        { id: "email", nome: "E-mail", area: "Comunicações", estado: "indisponivel", como_ligar: "ainda não integrado" },
      ],
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
  // Painéis do HUD: agenda, financeiro e comercial, direto do CRM.
  app.get("/api/painel/:tipo", async (c) => {
    const kind = c.req.param("tipo") as PanelKind;
    if (!PANEL_KINDS.includes(kind)) return c.json({ error: "Painel desconhecido." }, 404);
    try {
      return c.json({ painel: kind, dados: await skills.panels!.panel(kind) });
    } catch (err) {
      if (err instanceof PanelError) return c.json({ error: err.message }, err.status as 501 | 502 | 503);
      console.error("painel falhou:", err);
      return c.json({ error: "Não consegui montar o painel." }, 500);
    }
  });
  // Jarvis gerente: missões delegadas e relatórios.
  const missionView = (m: Mission) => ({ ...m, quando: describeFrequency(m.frequencia) });
  app.get("/api/missoes", async (c) => {
    const list = await missionStore.list();
    return c.json({
      missoes: list.map(missionView),
      pacote: MANAGER_PACK.map((p) => ({ chave: p.chave, titulo: p.titulo, quando: describeFrequency(p.frequencia), ativa: list.some((m) => m.chave === p.chave) })),
      executando: runner.busy,
      ia_configurada: !chatKeyMissing,
      limite_diario: config.missionsMaxPerDay,
    });
  });
  // Ativa as missões do pacote do gerente que ainda não existem (ou só as escolhidas).
  app.post("/api/missoes/pacote", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { chaves?: unknown };
    const wanted = Array.isArray(body.chaves) ? new Set(body.chaves.map(String)) : null;
    const existing = new Set((await missionStore.list()).map((m) => m.chave).filter(Boolean));
    const created: Mission[] = [];
    const erros: string[] = [];
    for (const p of MANAGER_PACK) {
      if (existing.has(p.chave) || (wanted && !wanted.has(p.chave))) continue;
      try {
        created.push(await missionStore.create(p));
      } catch (err) {
        // Duplicada por um toque duplo, ou limite de missões: segue com as outras.
        if (!(err instanceof MissionError)) throw err;
        if (!/já existe/.test(err.message)) erros.push(`${p.titulo}: ${err.message}`);
      }
    }
    return c.json({ criadas: created.map(missionView), erros });
  });
  app.post("/api/missoes/:id/executar", async (c) => {
    const id = c.req.param("id");
    if (!isMissionId(id) || !(await missionStore.get(id))) return c.json({ error: "Missão não encontrada." }, 404);
    if (chatKeyMissing) return missingKey(c);
    if (!(await runner.runNow(id))) return c.json({ error: `Limite de ${config.missionsMaxPerDay} execuções de missão por hoje atingido.` }, 429);
    return c.json({ executando: true });
  });
  app.post("/api/missoes/:id/ativa", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { ativa?: unknown };
    if (!isMissionId(id)) return c.json({ error: "Missão não encontrada." }, 404);
    // Tocar em Ativar no HUD é a confirmação humana de uma missão criada pela conversa.
    const m = await missionStore.setActive(id, body.ativa === true);
    return m ? c.json({ missao: missionView(m) }) : c.json({ error: "Missão não encontrada." }, 404);
  });
  app.delete("/api/missoes/:id", async (c) => {
    const id = c.req.param("id");
    if (!isMissionId(id) || !(await missionStore.remove(id))) return c.json({ error: "Missão não encontrada." }, 404);
    return c.json({ ok: true });
  });
  app.get("/api/relatorios", async (c) => c.json({ relatorios: await missionStore.reports(Math.min(50, Number(c.req.query("limite")) || 20)) }));
  app.get("/api/relatorios/avisos", async (c) => {
    const raw = c.req.query("desde") ?? "";
    const since = Number.isFinite(Date.parse(raw)) ? new Date(raw) : new Date(Date.now() - 12 * 3600_000);
    const list = await missionStore.since(since);
    // Cursor = o relatório mais novo entregue (não a hora do servidor): um relatório
    // que ainda estava sendo gravado durante a consulta chega na próxima.
    return c.json({ relatorios: list, agora: list.length ? list[list.length - 1]!.criado_em : since.toISOString() });
  });
  // Lead respondeu no WhatsApp da Ampliize: o HUD avisa (até 1 consulta ao CRM a cada 30 s).
  let wppCache: { at: number; conversas: WhatsappConversa[] } | null = null;
  app.get("/api/whatsapp/avisos", async (c) => {
    const raw = c.req.query("desde") ?? "";
    const since = Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : new Date(Date.now() - 12 * 3600_000).toISOString();
    if (!config.ampliize) return c.json({ conversas: [], agora: since });
    if (!wppCache || Date.now() - wppCache.at > 30_000) {
      try {
        const data = (await callResource({ ...config.ampliize, fetchImpl, timeoutMs: 8_000 }, "whatsapp_inbox", { dias: 2 })) as { conversas?: unknown };
        wppCache = { at: Date.now(), conversas: Array.isArray(data?.conversas) ? (data.conversas as WhatsappConversa[]) : [] };
      } catch {
        return c.json({ conversas: [], agora: since });
      }
    }
    // Datas comparadas como instantes: o CRM devolve no formato do Postgres (+00:00, microssegundos).
    const at = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
    const sinceMs = Date.parse(since);
    const novas = wppCache.conversas.filter((x) => x.aguardando_nossa_resposta && at(x.lead_escreveu_em) > sinceMs);
    const agora = novas.reduce((max, x) => (at(x.lead_escreveu_em) > Date.parse(max) ? x.lead_escreveu_em! : max), since);
    return c.json({
      conversas: novas.map((x) => ({ id: x.id, nome: x.nome, texto: x.texto_do_lead, quando: x.lead_escreveu_em })),
      agora,
    });
  });
  // Reunião marcada pelo atendente de IA: o fluxo de avisos do n8n manda o dossiê no WhatsApp do dono.
  app.get("/api/reunioes/avisos", async (c) => {
    const raw = c.req.query("desde") ?? "";
    const since = Number.isFinite(Date.parse(raw)) ? raw : new Date(Date.now() - 12 * 3600_000).toISOString();
    if (!config.ampliize) return c.json({ reunioes: [], agora: since });
    let reunioes: AgentMeeting[];
    try {
      const data = (await callResource({ ...config.ampliize, fetchImpl, timeoutMs: 8_000 }, "agent_meetings", { desde: since })) as { reunioes?: unknown };
      reunioes = Array.isArray(data?.reunioes) ? (data.reunioes as AgentMeeting[]) : [];
    } catch {
      return c.json({ reunioes: [], agora: since });
    }
    // Instantes comparados aqui (o CRM devolve microssegundos; o filtro de lá é por milissegundo).
    const at = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
    const sinceMs = Date.parse(since);
    const novas = reunioes.filter((r) => at(r.marcada_em) > sinceMs).sort((a, b) => at(a.marcada_em) - at(b.marcada_em));
    // O dossiê é gravado segundos depois da reunião: a recém-marcada sem dossiê espera
    // (até 3 min) e o cursor não passa dela, para o aviso sair completo.
    const espera = novas.findIndex((r) => !r.dossie && Date.now() - at(r.marcada_em) < 3 * 60_000);
    const prontas = espera === -1 ? novas : novas.slice(0, espera);
    const agora = prontas.length ? prontas[prontas.length - 1]!.marcada_em! : since;
    return c.json({ reunioes: prontas, agora });
  });
  // ================= agente de tráfego =================
  app.get("/api/trafego", async (c) => {
    try {
      return c.json(await traffic.overview());
    } catch (err) {
      return trafficError(c, err);
    }
  });
  app.get("/api/trafego/desempenho", async (c) => {
    const plataforma = c.req.query("plataforma") === "meta" ? "meta" : "google";
    const nivel = (c.req.query("nivel") ?? "campanha") as StatsLevel;
    if (!["campanha", "grupo", "conjunto", "anuncio", "palavras", "termos"].includes(nivel)) return c.json({ error: "Nível inválido." }, 400);
    try {
      return c.json({ plataforma, nivel, linhas: await traffic.stats(plataforma, nivel, Number(c.req.query("dias")) || 7) });
    } catch (err) {
      return trafficError(c, err);
    }
  });
  app.get("/api/trafego/avisos", async (c) => {
    const raw = c.req.query("desde") ?? "";
    const since = Number.isFinite(Date.parse(raw)) ? new Date(raw) : new Date(Date.now() - 12 * 3600_000);
    return c.json(await traffic.notices(since));
  });
  app.get("/api/trafego/propostas/:id", async (c) => {
    const id = c.req.param("id");
    const p = isProposalId(id) ? await traffic.proposal(id) : null;
    return p ? c.json({ proposta: p }) : c.json({ error: "Proposta não encontrada." }, 404);
  });
  // Aprovar e recusar: só o dono (HUD ou o fluxo do WhatsApp com o número dele).
  app.post("/api/trafego/propostas/:id/aprovar", async (c) => {
    const id = c.req.param("id");
    if (!isProposalId(id)) return c.json({ error: "Proposta não encontrada." }, 404);
    try {
      return c.json({ proposta: await traffic.approve(id) });
    } catch (err) {
      return trafficError(c, err);
    }
  });
  app.post("/api/trafego/propostas/:id/recusar", async (c) => {
    const id = c.req.param("id");
    if (!isProposalId(id)) return c.json({ error: "Proposta não encontrada." }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { motivo?: unknown };
    try {
      return c.json({ proposta: await traffic.reject(id, typeof body.motivo === "string" ? body.motivo : "") });
    } catch (err) {
      return trafficError(c, err);
    }
  });
  app.post("/api/trafego/permissoes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { preset?: unknown; dias?: unknown };
    try {
      return c.json({ permissao: await traffic.grant(String(body.preset ?? ""), typeof body.dias === "number" ? body.dias : undefined) });
    } catch (err) {
      return trafficError(c, err);
    }
  });
  app.delete("/api/trafego/permissoes/:ref", async (c) => {
    const ref = c.req.param("ref");
    if (!/^(p_[a-f0-9]{12}|[a-z0-9]{3,20})$/.test(ref)) return c.json({ error: "Permissão não encontrada." }, 404);
    return (await traffic.revoke(ref)) ? c.json({ ok: true }) : c.json({ error: "Permissão não encontrada." }, 404);
  });
  app.post("/api/trafego/google/conectar", async (c) => {
    if (!google) return c.json({ error: "Faltam as variáveis do Google Ads no Easypanel (GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_CUSTOMER_ID)." }, 503);
    const redirect = `${origin}/oauth/google/callback`;
    if (!/^https:\/\//.test(redirect)) return c.json({ error: "O Jarvis precisa estar em https (defina JARVIS_PUBLIC_URL)." }, 409);
    for (const [k, v] of oauthStates) if (v.until < Date.now()) oauthStates.delete(k);
    if (oauthStates.size > 20) return c.json({ error: "Muitas tentativas de conexão. Aguarde alguns minutos." }, 429);
    const state = randomBytes(24).toString("hex");
    oauthStates.set(state, { until: Date.now() + 10 * 60_000, redirect });
    return c.json({ url: google.authUrl(state, redirect), redirect });
  });
  app.post("/api/trafego/google/desconectar", async (c) => {
    if (!google) return c.json({ ok: true });
    await google.disconnect();
    return c.json({ ok: true });
  });

  app.get("/api/relatorios/:id", async (c) => {
    const id = c.req.param("id");
    const r = isReportId(id) ? await missionStore.report(id) : null;
    return r ? c.json(r) : c.json({ error: "Relatório não encontrado." }, 404);
  });
  app.post("/api/relatorios/:id/lido", async (c) => {
    const id = c.req.param("id");
    return isReportId(id) && (await missionStore.markRead(id)) ? c.json({ ok: true }) : c.json({ error: "Relatório não encontrado." }, 404);
  });

  // Painéis do HUD (sensores de clima e radar de notícias), com os mesmos serviços das habilidades.
  app.get("/api/clima", async (c) => {
    try {
      return c.json({ clima: await skills.weather.get(config.city) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Clima indisponível." }, 502);
    }
  });
  app.get("/api/noticias", async (c) => {
    const tema = (c.req.query("tema") ?? "").trim().slice(0, 80);
    try {
      return c.json({ tema, noticias: await skills.news.search(tema || null) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Notícias indisponíveis." }, 502);
    }
  });

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
