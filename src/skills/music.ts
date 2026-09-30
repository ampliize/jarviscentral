import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Trilha de abertura do briefing: um arquivo de áudio que o dono envia pelo
 * HUD e fica em DATA_DIR/media (volume /data, sobrevive ao deploy). Sem
 * arquivo, o HUD toca uma vinheta própria gerada no navegador.
 */
export const MAX_MUSIC_BYTES = 15 * 1024 * 1024;

const TYPES: Record<string, string> = {
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/mp4": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/aac": "audio/aac",
  "audio/ogg": "audio/ogg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/webm": "audio/webm",
};

/** Tipo de áudio aceito (normalizado) ou null. */
export const musicType = (contentType: string) => TYPES[contentType.split(";")[0]!.trim().toLowerCase()] ?? null;

export interface MusicInfo {
  nome: string;
  tipo: string;
  bytes: number;
  enviado_em: string;
}

/** Nome para mostrar no HUD: sem caminho nem caracteres de controle. */
const cleanName = (raw: string) => {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {}
  return name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "trilha";
};

export class BriefingMusic {
  private readonly dir: string;
  private readonly file: string;
  private readonly meta: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "media");
    this.file = path.join(this.dir, "briefing-musica");
    this.meta = path.join(this.dir, "briefing-musica.json");
  }

  async info(): Promise<MusicInfo | null> {
    const st = await fs.lstat(this.file).catch(() => null);
    if (!st?.isFile()) return null;
    const meta = JSON.parse(await fs.readFile(this.meta, "utf8").catch(() => "{}")) as Partial<MusicInfo>;
    const tipo = musicType(String(meta.tipo ?? "")) ?? "audio/mpeg";
    return { nome: meta.nome || "trilha", tipo, bytes: st.size, enviado_em: meta.enviado_em || st.mtime.toISOString() };
  }

  async read(): Promise<{ data: Buffer; info: MusicInfo } | null> {
    const info = await this.info();
    if (!info) return null;
    const data = await fs.readFile(this.file).catch(() => null);
    return data ? { data, info } : null;
  }

  async save(data: ArrayBuffer, contentType: string, fileName: string): Promise<MusicInfo> {
    const tipo = musicType(contentType);
    if (!tipo) throw new Error("tipo de áudio não aceito");
    await fs.mkdir(this.dir, { recursive: true });
    const info: MusicInfo = { nome: cleanName(fileName), tipo, bytes: data.byteLength, enviado_em: new Date().toISOString() };
    // Grava num temporário e troca: o briefing nunca lê um arquivo pela metade.
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, Buffer.from(data));
    await fs.rename(tmp, this.file);
    await fs.writeFile(this.meta, JSON.stringify(info));
    return info;
  }

  async remove(): Promise<void> {
    await fs.rm(this.file, { force: true });
    await fs.rm(this.meta, { force: true });
  }
}
