import type { VoiceConfig } from "./config.js";
import { OpenAIError } from "./llm/openai.js";

/**
 * Voz do Jarvis pela API da OpenAI:
 *  - ouvir: áudio gravado no navegador → texto (Whisper / gpt-4o-transcribe)
 *  - falar: texto da resposta → mp3 (tts-1 / gpt-4o-mini-tts)
 * O microfone e o alto-falante ficam no aparelho de quem usa; o servidor só
 * converte. Assim funciona no PC, no celular e com o Jarvis rodando na VPS.
 */
const OPENAI_URL = "https://api.openai.com/v1";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_SPEECH_CHARS = 4_000;

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
};

/** Extensão do arquivo a partir do Content-Type (a OpenAI usa o nome para reconhecer o formato). */
export const audioExtension = (contentType: string) => EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] ?? null;

async function openaiError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return new OpenAIError(response.status, payload.error?.code ?? null, payload.error?.message ?? `HTTP ${response.status}`);
}

export async function transcribe(voice: VoiceConfig, audio: ArrayBuffer, contentType: string, fetchImpl: typeof fetch = fetch) {
  const ext = audioExtension(contentType);
  if (!ext) throw new Error("Formato de áudio não suportado.");
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType.split(";")[0] }), `fala.${ext}`);
  form.append("model", voice.sttModel);
  form.append("language", "pt");
  form.append("response_format", "json");
  const response = await fetchImpl(`${OPENAI_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${voice.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw await openaiError(response);
  const payload = (await response.json()) as { text?: string };
  return (payload.text ?? "").trim();
}

/** Texto próprio para ser falado: sem markdown, sem URLs longas. */
export function speakableText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_#>]+/g, " ")
    .replace(/https?:\/\/\S+/g, "o link na tela")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_SPEECH_CHARS);
}

export async function speak(voice: VoiceConfig, text: string, fetchImpl: typeof fetch = fetch) {
  const input = speakableText(text);
  if (!input) throw new Error("Nada para falar.");
  const response = await fetchImpl(`${OPENAI_URL}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${voice.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: voice.ttsModel, voice: voice.ttsVoice, input, response_format: "mp3" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw await openaiError(response);
  return response.arrayBuffer();
}
