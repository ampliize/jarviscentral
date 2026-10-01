/**
 * Imagens do site geradas pela OpenAI (o mesmo motor de imagem do ChatGPT),
 * com a OPENAI_API_KEY que o Jarvis já usa. Saem em WebP, prontas para a web.
 */
export type ImageFormat = "paisagem" | "retrato" | "quadrado";

const SIZES: Record<ImageFormat, string> = { paisagem: "1536x1024", retrato: "1024x1536", quadrado: "1024x1024" };

export class ImageError extends Error {}

export async function generateImage(
  prompt: string,
  format: ImageFormat,
  opts: { apiKey: string; model?: string; fetchImpl?: typeof fetch },
): Promise<Buffer> {
  const res = await (opts.fetchImpl ?? fetch)("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      model: opts.model || "gpt-image-1",
      prompt: prompt.slice(0, 4000),
      size: SIZES[format] ?? SIZES.paisagem,
      quality: "high",
      output_format: "webp",
      output_compression: 88,
      n: 1,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string }>; error?: { message?: string; code?: string } };
  if (!res.ok) {
    if (body.error?.code === "insufficient_quota") throw new ImageError("A conta da OpenAI está sem créditos para imagens.");
    if (res.status === 400) throw new ImageError("A OpenAI recusou o pedido de imagem (conteúdo ou tamanho).");
    throw new ImageError(`A OpenAI falhou ao gerar a imagem (HTTP ${res.status}).`);
  }
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new ImageError("A OpenAI não devolveu a imagem.");
  return Buffer.from(b64, "base64");
}
