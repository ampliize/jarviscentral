/**
 * Cliente do contrato de integração usado pelos projetos:
 *   POST <url>  header x-api-key: <chave>
 *   body { "resource": "<nome>", "params": { ... } }
 *   resposta { "resource": "...", "data": ... } ou { "error": "..." }
 *
 * O CRM da Ampliize expõe isso na edge function integration-api; qualquer
 * outro projeto que implementar o mesmo contrato entra no Jarvis só com
 * configuração (JARVIS_PROJECTS).
 */
export class ResourceApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ResourceApiOptions {
  url: string;
  key: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function callResource(opts: ResourceApiOptions, resource: string, params: Record<string, unknown> = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(opts.url, {
      method: "POST",
      headers: { "x-api-key": opts.key, "Content-Type": "application/json" },
      body: JSON.stringify({ resource, params }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    throw new ResourceApiError(0, err instanceof Error && err.name === "TimeoutError" ? "O projeto demorou demais para responder." : "Não consegui falar com o projeto.");
  }
  const payload = (await response.json().catch(() => ({}))) as { data?: unknown; error?: string };
  if (!response.ok) throw new ResourceApiError(response.status, payload.error ?? `HTTP ${response.status}`);
  return payload.data;
}

/** Remove parâmetros nulos (o modo strict da OpenAI manda null para os opcionais). */
export const dropNulls = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined && v !== ""));
