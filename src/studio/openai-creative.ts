import type { Content, CreativeModel, Effort } from "./claude.js";
import { CreativeError } from "./claude.js";

/**
 * Motor do estúdio pela OpenAI (a mesma chave que o Jarvis já usa), enquanto
 * a API do Claude não está contratada. Mesma interface do Claude: quando a
 * ANTHROPIC_API_KEY entrar, o estúdio passa a usar o Claude sozinho.
 */
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "low" | "high" | "auto" } };

/** Converte o conteúdo (blocos no formato do Claude) para o formato da OpenAI. */
export function toOpenAIContent(content: Content): string | Part[] {
  if (typeof content === "string") return content;
  const parts: Part[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ type: "text", text: block.text });
    else if (block.type === "image" && block.source.type === "base64") {
      parts.push({ type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}`, detail: "low" } });
    }
  }
  return parts;
}

export class OpenAICreative implements CreativeModel {
  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4.1",
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async run(opts: { system: string; content: Content; maxTokens?: number }, schema?: Record<string, unknown>) {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      // Um site completo pode levar alguns minutos.
      signal: AbortSignal.timeout(15 * 60_000),
      body: JSON.stringify({
        model: this.model,
        // O teto de saída do modelo (gpt-4.1: 32 mil tokens) basta para um HTML completo.
        max_completion_tokens: Math.min(opts.maxTokens ?? 32_000, 32_000),
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: toOpenAIContent(opts.content) },
        ],
        ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "resposta", strict: true, schema } } } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
      error?: { message?: string; code?: string };
    };
    if (!res.ok) {
      if (body.error?.code === "insufficient_quota") throw new CreativeError("A conta da OpenAI está sem créditos.");
      if (res.status === 401) throw new CreativeError("OPENAI_API_KEY inválida.");
      if (res.status === 429) throw new CreativeError("A OpenAI está limitando as requisições. Tente em alguns minutos.");
      throw new CreativeError(`A OpenAI falhou (HTTP ${res.status}).`);
    }
    const choice = body.choices?.[0];
    if (choice?.message?.refusal) throw new CreativeError("A OpenAI recusou este pedido.");
    if (choice?.finish_reason === "length") throw new CreativeError("A resposta passou do tamanho máximo.");
    return String(choice?.message?.content ?? "");
  }

  async json<T>(opts: { system: string; content: Content; schema: Record<string, unknown>; effort?: Effort; maxTokens?: number }): Promise<T> {
    const text = await this.run(opts, opts.schema);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CreativeError("A OpenAI não devolveu JSON válido.");
    }
  }

  text(opts: { system: string; content: Content; effort?: Effort; maxTokens?: number }): Promise<string> {
    return this.run(opts);
  }
}
