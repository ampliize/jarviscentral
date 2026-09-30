import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Lembretes do Jarvis: um arquivo JSON em DATA_DIR (volume /data).
 * A HUD pergunta de tempos em tempos quais venceram e avisa em voz.
 */
export interface Reminder {
  id: string;
  texto: string;
  /** Quando avisar (ISO, UTC). */
  quando: string;
  criado: string;
  status: "pendente" | "concluido";
}

const MAX_TEXT = 300;
const MAX_REMINDERS = 500;
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;
const INVALID = "Data/hora inválida. Use ISO 8601, ex.: 2026-10-01T09:00:00-03:00.";

export class ReminderError extends Error {}

/** Diferença (ms) entre o horário local do fuso e UTC naquele instante. */
const zoneOffsetMs = (utcMs: number, timeZone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - utcMs;
};

/**
 * Lê a data/hora do lembrete. Com fuso (Z ou ±hh:mm) usa o fuso dado; sem
 * fuso, entende como horário do dono (ex.: Aracaju), nunca o do servidor.
 */
export function parseWhen(value: string, timeZone: string): Date {
  const text = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) throw new ReminderError(INVALID);
    return d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) throw new ReminderError(INVALID);
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  // Duas passadas acertam a virada de horário de verão, se o fuso tiver.
  let utc = wall - zoneOffsetMs(wall, timeZone);
  utc = wall - zoneOffsetMs(utc, timeZone);
  return new Date(utc);
}

export class ReminderStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "lembretes.json");
  }

  private async read(): Promise<Reminder[]> {
    const raw = await fs.readFile(this.file, "utf8").catch(() => "[]");
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? (list as Reminder[]) : [];
    } catch {
      return [];
    }
  }

  private async write(list: Reminder[]) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(list, null, 2));
    await fs.rename(tmp, this.file);
  }

  /** Uma alteração por vez no arquivo. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  add(texto: string, when: Date, now = new Date()) {
    return this.serial(async () => {
      const text = texto.trim().slice(0, MAX_TEXT);
      if (!text) throw new ReminderError("O lembrete precisa de um texto.");
      if (Number.isNaN(when.getTime())) throw new ReminderError(INVALID);
      if (when.getTime() < now.getTime() - 60_000) throw new ReminderError("Essa data/hora já passou.");
      if (when.getTime() > now.getTime() + YEAR_MS) throw new ReminderError("Só aceito lembretes para até um ano.");
      const list = await this.read();
      const open = list.filter((r) => r.status !== "concluido");
      if (open.length >= MAX_REMINDERS) throw new ReminderError("Lembretes demais em aberto. Conclua alguns antes.");
      // Mantém o arquivo pequeno: guarda só os 100 concluídos mais recentes.
      const done = list.filter((r) => r.status === "concluido").slice(-100);
      const reminder: Reminder = { id: randomUUID().slice(0, 8), texto: text, quando: when.toISOString(), criado: now.toISOString(), status: "pendente" };
      await this.write([...open, ...done, reminder]);
      return reminder;
    });
  }

  /** Lembretes não concluídos, do mais próximo ao mais distante. */
  async open(): Promise<Reminder[]> {
    await this.queue;
    return (await this.read()).filter((r) => r.status !== "concluido").sort((a, b) => a.quando.localeCompare(b.quando));
  }

  /**
   * Lembretes em aberto que venceram no intervalo (desde, agora]. Não altera
   * nada: cada tela guarda até onde já avisou, então nenhum aviso se perde
   * com duas abas abertas ou uma resposta que não chegou.
   */
  async dueBetween(since: Date, now = new Date()) {
    return (await this.open()).filter((r) => {
      const t = Date.parse(r.quando);
      return t > since.getTime() && t <= now.getTime();
    });
  }

  complete(id: string) {
    return this.serial(async () => {
      const list = await this.read();
      const r = list.find((x) => x.id === id);
      if (!r) return null;
      r.status = "concluido";
      await this.write(list);
      return r;
    });
  }
}
