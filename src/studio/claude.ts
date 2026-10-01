import Anthropic from "@anthropic-ai/sdk";

/**
 * O "Claude do estúdio": diretor de criação e desenvolvedor front-end do
 * Jarvis. Usa a API do Claude (ANTHROPIC_API_KEY) com streaming, porque o
 * HTML completo de um site passa de 40 mil caracteres.
 */
export const CLAUDE_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Content = string | Anthropic.Beta.BetaContentBlockParam[];

export interface CreativeModel {
  json<T>(opts: { system: string; content: Content; schema: Record<string, unknown>; effort?: Effort; maxTokens?: number }): Promise<T>;
  text(opts: { system: string; content: Content; effort?: Effort; maxTokens?: number }): Promise<string>;
}

export class CreativeError extends Error {}

export class ClaudeCreative implements CreativeModel {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model = CLAUDE_MODEL) {
    // Um site completo pode levar alguns minutos para ser escrito.
    this.client = new Anthropic({ apiKey, timeout: 20 * 60 * 1000, maxRetries: 2 });
  }

  private async run(opts: { system: string; content: Content; effort?: Effort; maxTokens?: number }, schema?: Record<string, unknown>) {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: opts.maxTokens ?? 64_000,
      // Se o Claude recusar por política, a própria API tenta o modelo recomendado.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: opts.system,
      output_config: { effort: opts.effort ?? "high", ...(schema ? { format: { type: "json_schema", schema } } : {}) },
      messages: [{ role: "user", content: opts.content }],
    });
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new CreativeError("ANTHROPIC_API_KEY inválida.");
      if (err instanceof Anthropic.RateLimitError) throw new CreativeError("O Claude está limitando as requisições. Tente em alguns minutos.");
      if (err instanceof Anthropic.APIError) throw new CreativeError(`O Claude falhou (HTTP ${err.status ?? "?"}).`);
      throw err;
    }
    if (message.stop_reason === "refusal") throw new CreativeError("O Claude recusou este pedido.");
    if (message.stop_reason === "max_tokens") throw new CreativeError("A resposta do Claude passou do tamanho máximo.");
    return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  }

  async json<T>(opts: { system: string; content: Content; schema: Record<string, unknown>; effort?: Effort; maxTokens?: number }): Promise<T> {
    const text = await this.run(opts, opts.schema);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CreativeError("O Claude não devolveu JSON válido.");
    }
  }

  text(opts: { system: string; content: Content; effort?: Effort; maxTokens?: number }): Promise<string> {
    return this.run(opts);
  }
}
