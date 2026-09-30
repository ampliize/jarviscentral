import type { ToolDefinition, ToolRunResult } from "../llm/openai.js";

/** Uma ferramenta que o Jarvis pode chamar. */
export interface Tool extends ToolDefinition {
  run: (args: Record<string, unknown>) => Promise<ToolRunResult>;
}

/** Um projeto conectado (Ampliize, Bate-ponto, ...), com as ferramentas dele. */
export interface Connector {
  id: string;
  name: string;
  description: string;
  tools: Tool[];
}

/** Resultado de ferramenta em JSON compacto; texto longo é cortado para não estourar o contexto. */
export const toolResult = (ok: boolean, data: unknown, maxChars = 24_000): ToolRunResult => {
  const text = JSON.stringify(data);
  return { ok, content: text.length > maxChars ? `${text.slice(0, maxChars)}…(cortado)` : text };
};
