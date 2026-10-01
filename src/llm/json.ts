import type { Config } from "../config.js";
import { chatWithTools } from "./openai.js";

/**
 * Uma chamada ao modelo que devolve JSON no formato do schema (saída
 * estruturada). Usada pelo revisor dos agentes e pelo criador de sites.
 */
export async function completeJson<T>(
  config: Config,
  opts: { system: string; user: string; name: string; schema: Record<string, unknown>; maxTokens?: number; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<T> {
  const result = await chatWithTools({
    apiKey: config.llmApiKey,
    baseUrl: config.openaiBaseUrl,
    model: config.openaiModel,
    fetchImpl: opts.fetchImpl,
    maxTokens: opts.maxTokens ?? 4000,
    timeoutMs: opts.timeoutMs ?? 120_000,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    tools: [],
    runTool: async () => ({ ok: false, content: "{}" }),
    responseFormat: { type: "json_schema", json_schema: { name: opts.name, strict: true, schema: opts.schema } },
  });
  // Modelos locais às vezes embrulham em ```json ... ```.
  const text = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("O modelo não devolveu JSON válido.");
  }
}
