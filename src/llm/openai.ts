/**
 * Cliente mínimo da OpenAI (Chat Completions) com loop de ferramentas.
 * Usa fetch direto — sem SDK — para ter controle total de timeout e erros.
 */

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (modo strict: todos os campos em required, additionalProperties false). */
  parameters: Record<string, unknown>;
}

export interface ToolRunResult {
  ok: boolean;
  content: string;
  /** Links que a ferramenta gerou para o dono abrir (ex.: criar o site no Lovable). */
  links?: ToolLink[];
}

export interface ToolLink {
  rotulo: string;
  url: string;
}

export interface ChatResult {
  text: string;
  toolRuns: Array<{ name: string; ok: boolean }>;
  links: ToolLink[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export class OpenAIError extends Error {
  constructor(public status: number, public code: string | null, message: string) {
    super(message);
  }
}

export interface ChatOptions {
  apiKey: string;
  /** Endpoint compatível com a OpenAI. Padrão: https://api.openai.com/v1 */
  baseUrl?: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  runTool: (name: string, args: unknown) => Promise<ToolRunResult>;
  maxIterations?: number;
  timeoutMs?: number;
  /** Saída estruturada (ex.: { type: "json_schema", json_schema: {...} }), para chamadas sem ferramentas. */
  responseFormat?: Record<string, unknown>;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

const FALLBACK_MODEL = "gpt-4o-mini";

async function request(opts: ChatOptions, model: string, messages: ChatMessage[]) {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(`${opts.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    body: JSON.stringify({
      model,
      max_completion_tokens: opts.maxTokens ?? 4000,
      messages,
      ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      ...(opts.tools.length
        ? {
            tools: opts.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
            })),
            tool_choice: "auto",
          }
        : {}),
    }),
  });
  let payload: any;
  try {
    payload = await response.json();
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    payload = {};
  }
  if (!response.ok) {
    const e = payload?.error ?? {};
    throw new OpenAIError(response.status, e.code ?? null, e.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

/**
 * Conversa com o modelo executando as ferramentas pedidas até ele responder
 * em texto (ou até o limite de iterações, para não entrar em loop).
 */
export async function chatWithTools(opts: ChatOptions): Promise<ChatResult> {
  const messages = [...opts.messages];
  const maxIterations = opts.maxIterations ?? 8;
  const toolRuns: ChatResult["toolRuns"] = [];
  const links: ToolLink[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let model = opts.model;

  for (let i = 0; i < maxIterations; i++) {
    let payload: any;
    try {
      payload = await request(opts, model, messages);
    } catch (err) {
      const unavailable = err instanceof OpenAIError && (err.code === "model_not_found" || err.status === 404);
      if (!unavailable || model === FALLBACK_MODEL) throw err;
      model = FALLBACK_MODEL;
      payload = await request(opts, model, messages);
    }
    usage.inputTokens += Number(payload.usage?.prompt_tokens ?? 0);
    usage.outputTokens += Number(payload.usage?.completion_tokens ?? 0);

    const choice = payload.choices?.[0];
    const message = choice?.message ?? {};
    if (message.refusal) return { text: String(message.refusal), toolRuns, links, usage, model };

    const calls: ToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      if (choice?.finish_reason === "length") {
        return { text: `${message.content ?? ""}\n\n(resposta cortada por tamanho)`.trim(), toolRuns, links, usage, model };
      }
      return { text: String(message.content ?? ""), toolRuns, links, usage, model };
    }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let result: ToolRunResult;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        result = await opts.runTool(call.function.name, args);
      } catch (err) {
        result = { ok: false, content: JSON.stringify({ erro: err instanceof Error ? err.message : "falha na ferramenta" }) };
      }
      toolRuns.push({ name: call.function.name, ok: result.ok });
      if (result.links?.length) links.push(...result.links);
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
  }

  return {
    text: "Precisei de consultas demais para responder. Pode reformular a pergunta de um jeito mais específico?",
    toolRuns,
    links,
    usage,
    model,
  };
}
