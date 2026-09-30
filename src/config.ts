import path from "node:path";

/**
 * Configuração do Jarvis, lida das variáveis de ambiente (no Easypanel:
 * aba "Environment" do serviço). Nada de segredo no código.
 */
export interface ProjectConfig {
  /** Identificador curto, usado no nome das ferramentas (ex.: "bateponto"). */
  id: string;
  name: string;
  /** Endpoint que segue o contrato da integration-api: POST { resource, params } com x-api-key. */
  url: string;
  key: string;
  description?: string;
}

export interface VoiceConfig {
  /** Chave usada para ouvir/falar (padrão: a mesma OPENAI_API_KEY). */
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
}

export interface BrainGitConfig {
  /** URL https do repositório do vault (ex.: https://github.com/ampliize/ampliize-brain.git). */
  url: string;
  /** Token com permissão de leitura/escrita no repositório (GitHub: fine-grained, Contents read/write). */
  token: string;
  syncMinutes: number;
  author: string;
}

export interface Config {
  port: number;
  accessToken: string;
  openaiApiKey: string;
  /** Endpoint compatível com a OpenAI (ex.: Ollama em http://ollama:11434/v1). */
  openaiBaseUrl: string;
  /** Chave enviada ao endpoint do chat. Fora da OpenAI, só LLM_API_KEY (nunca a chave da OpenAI). */
  llmApiKey: string;
  openaiModel: string;
  voice: VoiceConfig;
  brainGit: BrainGitConfig | null;
  dataDir: string;
  timeZone: string;
  ownerName: string;
  corsOrigins: string[];
  ampliize: { url: string; key: string } | null;
  projects: ProjectConfig[];
}

const PROJECT_ID_RE = /^[a-z][a-z0-9_]{1,30}$/;

function parseProjects(raw: string | undefined): ProjectConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("JARVIS_PROJECTS precisa ser um JSON válido (lista de projetos).");
  }
  if (!Array.isArray(parsed)) throw new Error("JARVIS_PROJECTS precisa ser uma lista.");
  return parsed.map((p, i) => {
    const item = p as Partial<ProjectConfig>;
    if (!item.id || !PROJECT_ID_RE.test(item.id)) throw new Error(`JARVIS_PROJECTS[${i}].id inválido (use letras minúsculas, números e _).`);
    if (!item.url || !/^https:\/\//.test(item.url)) throw new Error(`JARVIS_PROJECTS[${i}].url precisa começar com https://`);
    if (!item.key) throw new Error(`JARVIS_PROJECTS[${i}].key é obrigatório.`);
    return { id: item.id, name: item.name || item.id, url: item.url, key: item.key, description: item.description };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const accessToken = env.JARVIS_ACCESS_TOKEN ?? "";
  if (accessToken.length < 24) {
    throw new Error("Defina JARVIS_ACCESS_TOKEN com pelo menos 24 caracteres (é a senha de acesso ao Jarvis).");
  }
  const openaiApiKey = env.OPENAI_API_KEY ?? "";
  if (!openaiApiKey) throw new Error("Defina OPENAI_API_KEY.");

  const ampliizeUrl = env.AMPLIIZE_API_URL?.trim();
  const ampliizeKey = env.AMPLIIZE_API_KEY?.trim();
  if (ampliizeUrl && !/^https:\/\//.test(ampliizeUrl)) throw new Error("AMPLIIZE_API_URL precisa começar com https://");

  const openaiBaseUrl = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(openaiBaseUrl)) throw new Error("OPENAI_BASE_URL precisa começar com http:// ou https://");

  const brainUrl = env.BRAIN_GIT_URL?.trim();
  const brainToken = env.BRAIN_GIT_TOKEN?.trim() ?? "";
  if (brainUrl && !/^https:\/\/[^@\s]+$/.test(brainUrl)) {
    throw new Error("BRAIN_GIT_URL precisa ser https:// e sem usuário/senha embutidos (use BRAIN_GIT_TOKEN).");
  }

  return {
    port: Number(env.PORT) || 3000,
    accessToken,
    openaiApiKey,
    openaiBaseUrl,
    llmApiKey: env.LLM_API_KEY?.trim() || (/^https:\/\/api\.openai\.com(\/|$)/.test(openaiBaseUrl) ? openaiApiKey : ""),
    openaiModel: env.OPENAI_MODEL?.trim() || "gpt-4.1",
    voice: {
      apiKey: env.OPENAI_VOICE_API_KEY?.trim() || openaiApiKey,
      sttModel: env.OPENAI_STT_MODEL?.trim() || "whisper-1",
      ttsModel: env.OPENAI_TTS_MODEL?.trim() || "tts-1",
      ttsVoice: env.OPENAI_TTS_VOICE?.trim() || "onyx",
    },
    brainGit: brainUrl
      ? {
          url: brainUrl,
          token: brainToken,
          syncMinutes: Math.max(1, Number(env.BRAIN_SYNC_MINUTES) || 5),
          author: env.BRAIN_GIT_AUTHOR?.trim() || "Jarvis <jarvis@ampliize.com>",
        }
      : null,
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    timeZone: env.TZ_JARVIS || "America/Maceio",
    ownerName: env.JARVIS_OWNER_NAME?.trim() || "Davy",
    corsOrigins: (env.JARVIS_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ampliize: ampliizeUrl && ampliizeKey ? { url: ampliizeUrl, key: ampliizeKey } : null,
    projects: parseProjects(env.JARVIS_PROJECTS),
  };
}
