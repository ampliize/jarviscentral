import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Sequência de frames para a animação de scroll (o "vídeo que anda com a
 * rolagem", como na landing da Nova Esplanada): desktop em 1920x1080 e
 * celular em 720x1280, em WebP, nomeados f_000.webp, f_001.webp...
 *
 * - Com um vídeo (gerado no Google Flow, por exemplo): tira os frames dele.
 * - Sem vídeo: faz um movimento de câmera (aproximação suave) sobre a imagem
 *   principal gerada para o site.
 */
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export const defaultRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} falhou: ${String(stderr || err.message).split("\n").slice(-3).join(" ").slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });

export const DESKTOP = { w: 1920, h: 1080 };
export const MOBILE = { w: 720, h: 1280 };

export interface FrameSet {
  count: number;
  /** Pastas relativas à pasta pública do trabalho. */
  desktop: string;
  mobile: string;
  origem: "video" | "imagem";
}

const OUT = (dir: string) => path.join(dir, "f_%03d.webp");
const WEBP = ["-c:v", "libwebp", "-quality", "78", "-compression_level", "4", "-start_number", "0"];

async function countFrames(dir: string) {
  return (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^f_\d{3}\.webp$/.test(f)).length;
}

/** Duração do vídeo em segundos. */
async function duration(video: string, run: Runner): Promise<number> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video], 30_000);
  const d = Number.parseFloat(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("não consegui ler a duração do vídeo");
  return d;
}

export async function framesFromVideo(video: string, publicDir: string, count = 128, run: Runner = defaultRunner): Promise<FrameSet> {
  const fps = (count / (await duration(video, run))).toFixed(4);
  const d = path.join(publicDir, "frames", "d");
  const m = path.join(publicDir, "frames", "m");
  await fs.rm(path.join(publicDir, "frames"), { recursive: true, force: true });
  await fs.mkdir(d, { recursive: true });
  await fs.mkdir(m, { recursive: true });
  // Desktop: cobre 16:9 cortando o excesso. Celular: recorte central 9:16.
  const cover = (w: number, h: number) => `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  await run("ffmpeg", ["-y", "-v", "error", "-i", video, "-vf", cover(DESKTOP.w, DESKTOP.h), "-frames:v", String(count), ...WEBP, OUT(d)], 10 * 60_000);
  await run("ffmpeg", ["-y", "-v", "error", "-i", video, "-vf", cover(MOBILE.w, MOBILE.h), "-frames:v", String(count), ...WEBP, OUT(m)], 10 * 60_000);
  const total = Math.min(await countFrames(d), await countFrames(m));
  if (!total) throw new Error("o vídeo não gerou frames");
  return { count: total, desktop: "frames/d", mobile: "frames/m", origem: "video" };
}

/** Aproximação suave (push-in) sobre uma imagem, quadro a quadro. */
function pushIn(size: { w: number; h: number }, count: number) {
  const step = (0.4 / count).toFixed(5);
  return [
    `scale=${size.w * 2}:${size.h * 2}:force_original_aspect_ratio=increase,crop=${size.w * 2}:${size.h * 2}`,
    `zoompan=z='min(1+${step}*on,1.4)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${count}:s=${size.w}x${size.h}:fps=30`,
  ].join(",");
}

export async function framesFromImages(desktopImage: string, mobileImage: string, publicDir: string, count = 96, run: Runner = defaultRunner): Promise<FrameSet> {
  const d = path.join(publicDir, "frames", "d");
  const m = path.join(publicDir, "frames", "m");
  await fs.rm(path.join(publicDir, "frames"), { recursive: true, force: true });
  await fs.mkdir(d, { recursive: true });
  await fs.mkdir(m, { recursive: true });
  await run("ffmpeg", ["-y", "-v", "error", "-i", desktopImage, "-vf", pushIn(DESKTOP, count), "-frames:v", String(count), ...WEBP, OUT(d)], 10 * 60_000);
  await run("ffmpeg", ["-y", "-v", "error", "-i", mobileImage, "-vf", pushIn(MOBILE, count), "-frames:v", String(count), ...WEBP, OUT(m)], 10 * 60_000);
  const total = Math.min(await countFrames(d), await countFrames(m));
  if (!total) throw new Error("as imagens não geraram frames");
  return { count: total, desktop: "frames/d", mobile: "frames/m", origem: "imagem" };
}
