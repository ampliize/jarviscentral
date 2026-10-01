/**
 * Conferência automática do HTML que o Claude escreveu, antes de entregar.
 * O que falhar volta para o Claude corrigir (uma rodada).
 */
export interface QualityInput {
  html: string;
  frames: { count: number; desktopUrl: string; mobileUrl: string } | null;
  imageUrls: string[];
}

export function checkHtml({ html, frames, imageUrls }: QualityInput): string[] {
  const issues: string[] = [];
  const has = (re: RegExp) => re.test(html);
  if (!has(/^\s*<!doctype html>/i)) issues.push("O arquivo precisa começar com <!DOCTYPE html>.");
  if (!has(/<html[^>]*\slang=["']pt-BR["']/i)) issues.push('Falta <html lang="pt-BR">.');
  if (!has(/<meta[^>]+name=["']viewport["']/i)) issues.push("Falta a meta viewport (celular).");
  if (!has(/<title>[^<]{5,}<\/title>/i)) issues.push("Falta um <title> descritivo.");
  if (!has(/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{30,}/i)) issues.push("Falta a meta description (SEO).");
  if ((html.match(/<h1[\s>]/gi) ?? []).length !== 1) issues.push("A página precisa de exatamente um <h1>.");
  if (!has(/gsap(?:\.min)?\.js/i) || !has(/ScrollTrigger(?:\.min)?\.js/i)) issues.push("Carregue GSAP e ScrollTrigger pelo CDN.");
  if (!has(/registerPlugin\(\s*ScrollTrigger/)) issues.push("Falta gsap.registerPlugin(ScrollTrigger).");
  if (!has(/prefers-reduced-motion/)) issues.push("Respeite prefers-reduced-motion (sem pin/scrub, só fade).");
  if (has(/lorem ipsum/i)) issues.push("Tem lorem ipsum: troque pelos textos do roteiro.");
  if (has(/\[(?:nome|empresa|telefone|link|cidade|x+)[^\]]{0,20}\]|\{\{[^}]{0,30}\}\}/i)) issues.push("Sobrou placeholder ([nome], {{...}}) no texto.");
  if (has(/<img(?![^>]*\balt=)[^>]*>/i)) issues.push("Toda <img> precisa de alt.");
  if (frames) {
    if (!has(/<canvas/i)) issues.push("A sequência de frames precisa de um <canvas>.");
    if (!html.includes(frames.desktopUrl)) issues.push(`Use os frames do desktop em ${frames.desktopUrl}.`);
    if (!html.includes(frames.mobileUrl)) issues.push(`Use os frames do celular em ${frames.mobileUrl}.`);
    if (!has(new RegExp(`\\b${frames.count}\\b`))) issues.push(`A sequência tem ${frames.count} frames (f_000 a f_${String(frames.count - 1).padStart(3, "0")}).`);
  }
  const missing = imageUrls.filter((u) => !html.includes(u));
  if (missing.length) issues.push(`Imagens geradas que não foram usadas: ${missing.join(", ")}.`);
  if (html.length < 8_000) issues.push("O HTML está curto demais para uma landing completa.");
  return issues;
}

/** Tira o HTML de dentro de ```html ... ``` (ou do texto puro). */
export function extractHtml(text: string): string {
  const fenced = /```(?:html)?\s*\n([\s\S]*?)\n```/i.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.search(/<!doctype html>/i);
  return start > 0 ? body.slice(start) : body;
}
