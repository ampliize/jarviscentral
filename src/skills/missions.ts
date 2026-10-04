import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseWhen } from "./reminders.js";

/**
 * Missões: responsabilidades que o dono delega ao Jarvis ("toda segunda,
 * planeje os posts dos clientes"). O Jarvis executa sozinho no horário,
 * com ferramentas só de leitura, e entrega um relatório (vault + HUD).
 *
 * Nada aqui envia mensagem para cliente nem altera sistemas: o relatório
 * traz ordens para o time (pessoas e agentes) e o que precisa do dono.
 */

export type MissionArea = "conteudo" | "comercial" | "financeiro" | "operacao" | "agentes" | "outro";
export const MISSION_AREAS: MissionArea[] = ["conteudo", "comercial", "financeiro", "operacao", "agentes", "outro"];

export type FrequencyKind = "diaria" | "dias_uteis" | "semanal" | "mensal" | "uma_vez";
export const FREQUENCY_KINDS: FrequencyKind[] = ["diaria", "dias_uteis", "semanal", "mensal", "uma_vez"];

export interface Frequency {
  tipo: FrequencyKind;
  /** HH:MM no fuso do Jarvis. */
  hora: string;
  /** Semanal: 0 = domingo … 6 = sábado. */
  dias_semana?: number[];
  /** Mensal: dia do mês (1-28). */
  dia_mes?: number;
  /** Uma vez: AAAA-MM-DD. */
  data?: string;
}

export interface MissionRun {
  quando: string;
  ok: boolean;
  relatorio_id?: string;
  erro?: string;
}

export interface Mission {
  id: string;
  /** Chave das missões do pacote do gerente (evita duplicar). */
  chave?: string;
  titulo: string;
  area: MissionArea;
  instrucoes: string;
  entrega: string;
  frequencia: Frequency;
  ativa: boolean;
  criada_em: string;
  proxima: string | null;
  ultima: MissionRun | null;
  execucoes: number;
  /** Criada pela conversa: só roda depois que o dono toca em Ativar no HUD. */
  pendente?: boolean;
}

export interface Order {
  para: string;
  tarefa: string;
  prazo?: string;
}

export interface ReportMeta {
  id: string;
  missao_id: string;
  missao: string;
  area: MissionArea;
  titulo: string;
  criado_em: string;
  resumo: string;
  precisa_de_voce: string[];
  ordens: Order[];
  /** Caminho no vault (relatorios/...) quando a gravação deu certo. */
  arquivo: string | null;
  lido: boolean;
}

export class MissionError extends Error {}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^m_[a-f0-9]{12}$/;
const REPORT_ID_RE = /^r_[a-f0-9]{12}$/;
const MAX_MISSIONS = 40;
const MAX_REPORTS = 300;
const MAX_TEXT = 4_000;

export const isMissionId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
export const isReportId = (v: unknown): v is string => typeof v === "string" && REPORT_ID_RE.test(v);

/** Valida e normaliza a frequência (lança MissionError com a explicação). */
export function parseFrequency(raw: unknown): Frequency {
  const f = (raw ?? {}) as Record<string, unknown>;
  const tipo = f.tipo as FrequencyKind;
  if (!FREQUENCY_KINDS.includes(tipo)) throw new MissionError(`Frequência inválida: use ${FREQUENCY_KINDS.join(", ")}.`);
  const hora = String(f.hora ?? "").trim().replace(/^(\d):/, "0$1:");
  if (!HHMM_RE.test(hora)) throw new MissionError("Hora inválida: use HH:MM (ex.: 07:30).");
  const out: Frequency = { tipo, hora };
  if (tipo === "semanal") {
    const dias = Array.isArray(f.dias_semana) ? [...new Set(f.dias_semana.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    if (!dias.length) throw new MissionError("Semanal: informe os dias da semana (0 = domingo … 6 = sábado).");
    out.dias_semana = dias.sort();
  }
  if (tipo === "mensal") {
    const dia = Math.round(Number(f.dia_mes));
    if (!(dia >= 1 && dia <= 28)) throw new MissionError("Mensal: informe o dia do mês entre 1 e 28.");
    out.dia_mes = dia;
  }
  if (tipo === "uma_vez") {
    const data = String(f.data ?? "");
    if (!DATE_RE.test(data)) throw new MissionError("Uma vez: informe a data (AAAA-MM-DD).");
    out.data = data;
  }
  return out;
}

/** AAAA-MM-DD + HH:MM no fuso → instante UTC (mesma conversão dos lembretes). */
export function zonedTime(date: string, hhmm: string, timeZone: string): number {
  return parseWhen(`${date}T${hhmm}`, timeZone).getTime();
}

const localDate = (at: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(at));
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Próximo horário da missão depois de `after` (null = não roda mais). */
export function nextRun(freq: Frequency, timeZone: string, after: Date): string | null {
  const start = localDate(after.getTime(), timeZone);
  if (freq.tipo === "uma_vez") {
    const at = zonedTime(freq.data!, freq.hora, timeZone);
    return at > after.getTime() ? new Date(at).toISOString() : null;
  }
  for (let i = 0; i <= 62; i++) {
    const day = addDays(start, i);
    const wd = weekday(day);
    const ok =
      freq.tipo === "diaria" ||
      (freq.tipo === "dias_uteis" && wd >= 1 && wd <= 5) ||
      (freq.tipo === "semanal" && freq.dias_semana!.includes(wd)) ||
      (freq.tipo === "mensal" && Number(day.slice(8)) === freq.dia_mes);
    if (!ok) continue;
    const at = zonedTime(day, freq.hora, timeZone);
    if (at > after.getTime()) return new Date(at).toISOString();
  }
  return null;
}

const DAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
/** "toda segunda e quinta às 07:30" */
export function describeFrequency(f: Frequency): string {
  if (f.tipo === "diaria") return `todo dia às ${f.hora}`;
  if (f.tipo === "dias_uteis") return `de segunda a sexta às ${f.hora}`;
  if (f.tipo === "semanal") {
    const names = f.dias_semana!.map((d) => DAY_NAMES[d]);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} e ${names.at(-1)}` : names[0];
    return `toda ${list} às ${f.hora}`;
  }
  if (f.tipo === "mensal") return `todo dia ${f.dia_mes} às ${f.hora}`;
  return `uma vez, em ${f.data!.split("-").reverse().join("/")} às ${f.hora}`;
}

const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/**
 * Lê as seções do relatório em Markdown (o modelo escreve com estes títulos).
 * Tolerante: título que faltar vira lista vazia.
 */
export function parseReport(md: string): { titulo: string; resumo: string; precisa_de_voce: string[]; ordens: Order[] } {
  const titulo = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? "Relatório";
  const section = (name: RegExp) => {
    const lines = md.split("\n");
    const start = lines.findIndex((l) => /^##\s+/.test(l) && name.test(l.replace(/^##\s+/, "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()));
    if (start < 0) return [] as string[];
    const out: string[] = [];
    for (let i = start + 1; i < lines.length && !/^##\s+/.test(lines[i]!); i++) out.push(lines[i]!);
    return out;
  };
  const bullets = (lines: string[]) =>
    lines
      .map((l) => /^\s*[-*]\s+(?:\[[ x]\]\s+)?(.+)$/.exec(l)?.[1]?.trim() ?? "")
      .filter((l) => l && !/^(nada|nenhum|nenhuma|—|-)\.?$/i.test(l));
  const resumo = section(/^resumo/).join(" ").replace(/\s+/g, " ").trim();
  const precisa = bullets(section(/^precisa de voce/)).slice(0, 12);
  const ordens = bullets(section(/^ordens/))
    .map((b): Order => {
      const m = /^\[([^\]]{1,60})\]\s*(.+)$/.exec(b);
      const para = m ? m[1]!.trim() : "Time";
      let tarefa = (m ? m[2]! : b).trim();
      let prazo: string | undefined;
      const p = /\s*[·|-]\s*prazo:\s*(.+)$/i.exec(tarefa);
      if (p) {
        prazo = p[1]!.trim();
        tarefa = tarefa.slice(0, p.index).trim();
      }
      return prazo ? { para, tarefa, prazo } : { para, tarefa };
    })
    .slice(0, 30);
  return { titulo: titulo.slice(0, 160), resumo: resumo.slice(0, 600), precisa_de_voce: precisa, ordens };
}

interface Saved {
  missoes: Mission[];
  relatorios: ReportMeta[];
  /** Execuções no dia (sobrevive a reinício: o teto diário vale de verdade). */
  orcamento?: { dia: string; execucoes: number };
}

/** Missões e relatórios em DATA_DIR (JSON) + texto completo de cada relatório. */
export class MissionStore {
  private file: string;
  private dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, private readonly timeZone: string) {
    this.file = path.join(dataDir, "missoes.json");
    this.dir = path.join(dataDir, "relatorios");
  }

  private async load(): Promise<Saved> {
    const raw = await fs.readFile(this.file, "utf8").catch(() => "");
    if (!raw) return { missoes: [], relatorios: [] };
    try {
      const data = JSON.parse(raw) as Partial<Saved>;
      return {
        missoes: Array.isArray(data.missoes) ? data.missoes : [],
        relatorios: Array.isArray(data.relatorios) ? data.relatorios : [],
        ...(data.orcamento ? { orcamento: data.orcamento } : {}),
      };
    } catch {
      // Arquivo corrompido: guarda uma cópia e começa do zero, sem derrubar o Jarvis.
      await fs.copyFile(this.file, `${this.file}.corrompido-${Date.now()}`).catch(() => {});
      return { missoes: [], relatorios: [] };
    }
  }

  private async save(data: Saved) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, this.file);
  }

  /** Uma alteração por vez (leitura + escrita), para não perder gravações simultâneas. */
  private mutate<T>(fn: (data: Saved) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const data = await this.load();
      const out = await fn(data);
      await this.save(data);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async list(): Promise<Mission[]> {
    await this.queue.catch(() => {});
    return (await this.load()).missoes;
  }

  async get(id: string): Promise<Mission | null> {
    return (await this.list()).find((m) => m.id === id) ?? null;
  }

  /** Acha por id ou por parte do título (sem acento). */
  async find(ref: string): Promise<Mission | null> {
    const all = await this.list();
    if (ID_RE.test(ref)) return all.find((m) => m.id === ref) ?? null;
    const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const q = norm(ref.trim());
    if (q.length < 3) return null;
    const hits = all.filter((m) => norm(m.titulo).includes(q));
    return hits.length === 1 ? hits[0]! : null;
  }

  async create(
    input: { titulo: unknown; area?: unknown; instrucoes: unknown; entrega?: unknown; frequencia: unknown; chave?: string; pendente?: boolean },
    now = new Date(),
  ): Promise<Mission> {
    const titulo = text(input.titulo, 120);
    const instrucoes = text(input.instrucoes, MAX_TEXT);
    if (titulo.length < 3) throw new MissionError("Dê um título à missão.");
    if (instrucoes.length < 10) throw new MissionError("Descreva o que o Jarvis deve fazer na missão.");
    const area = MISSION_AREAS.includes(input.area as MissionArea) ? (input.area as MissionArea) : "outro";
    const frequencia = parseFrequency(input.frequencia);
    const proxima = nextRun(frequencia, this.timeZone, now);
    if (!proxima) throw new MissionError("Esse horário já passou: escolha uma data futura.");
    return this.mutate((data) => {
      if (data.missoes.length >= MAX_MISSIONS) throw new MissionError(`Limite de ${MAX_MISSIONS} missões: exclua alguma antes.`);
      if (input.chave && data.missoes.some((m) => m.chave === input.chave)) throw new MissionError("Essa missão do pacote já existe.");
      const mission: Mission = {
        id: `m_${randomBytes(6).toString("hex")}`,
        ...(input.chave ? { chave: input.chave } : {}),
        titulo,
        area,
        instrucoes,
        entrega: text(input.entrega, 600) || "Relatório com resumo, achados, ordens para o time e o que precisa do dono.",
        frequencia,
        ativa: !input.pendente,
        criada_em: now.toISOString(),
        proxima: input.pendente ? null : proxima,
        ultima: null,
        execucoes: 0,
        ...(input.pendente ? { pendente: true } : {}),
      };
      data.missoes.push(mission);
      return mission;
    });
  }

  async setActive(id: string, ativa: boolean, now = new Date()): Promise<Mission | null> {
    return this.mutate((data) => {
      const m = data.missoes.find((x) => x.id === id);
      if (!m) return null;
      m.ativa = ativa;
      if (ativa) delete m.pendente;
      m.proxima = ativa ? nextRun(m.frequencia, this.timeZone, now) : null;
      if (ativa && !m.proxima) m.ativa = false; // "uma vez" que já passou
      return m;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((data) => {
      const before = data.missoes.length;
      data.missoes = data.missoes.filter((m) => m.id !== id);
      return data.missoes.length < before;
    });
  }

  /** Missões ativas com horário vencido. */
  async due(now = new Date()): Promise<Mission[]> {
    return (await this.list()).filter((m) => m.ativa && m.proxima && Date.parse(m.proxima) <= now.getTime());
  }

  /** Marca o início da execução: já reagenda, para um erro não repetir em loop. */
  async markStarted(id: string, now = new Date()): Promise<Mission | null> {
    return this.mutate((data) => {
      const m = data.missoes.find((x) => x.id === id);
      if (!m) return null;
      m.proxima = nextRun(m.frequencia, this.timeZone, now);
      if (!m.proxima) m.ativa = false;
      return m;
    });
  }

  async markFinished(id: string, run: MissionRun) {
    await this.mutate((data) => {
      const m = data.missoes.find((x) => x.id === id);
      if (!m) return;
      m.ultima = run;
      m.execucoes += 1;
    });
  }

  async budget(): Promise<{ dia: string; execucoes: number }> {
    await this.queue.catch(() => {});
    return (await this.load()).orcamento ?? { dia: "", execucoes: 0 };
  }

  /** Reserva uma execução no teto do dia; false = acabou o orçamento de hoje. */
  async takeBudget(day: string, max: number): Promise<boolean> {
    return this.mutate((data) => {
      if (data.orcamento?.dia !== day) data.orcamento = { dia: day, execucoes: 0 };
      if (data.orcamento.execucoes >= max) return false;
      data.orcamento.execucoes += 1;
      return true;
    });
  }

  /** Adia uma missão vencida (sem orçamento hoje) para `until`, sem perder a execução. */
  async postpone(id: string, until: string) {
    await this.mutate((data) => {
      const m = data.missoes.find((x) => x.id === id);
      if (m && m.ativa) m.proxima = until;
    });
  }

  async addReport(meta: Omit<ReportMeta, "id" | "lido">, body: string): Promise<ReportMeta> {
    const id = `r_${randomBytes(6).toString("hex")}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${id}.md`), body);
    return this.mutate(async (data) => {
      const report: ReportMeta = { ...meta, id, lido: false };
      data.relatorios.unshift(report);
      for (const old of data.relatorios.splice(MAX_REPORTS)) await fs.rm(path.join(this.dir, `${old.id}.md`), { force: true });
      return report;
    });
  }

  async reports(limit = 20, missaoId?: string): Promise<ReportMeta[]> {
    await this.queue.catch(() => {});
    const all = (await this.load()).relatorios;
    return (missaoId ? all.filter((r) => r.missao_id === missaoId) : all).slice(0, limit);
  }

  async report(id: string): Promise<{ meta: ReportMeta; texto: string } | null> {
    if (!isReportId(id)) return null;
    const meta = (await this.reports(MAX_REPORTS)).find((r) => r.id === id);
    if (!meta) return null;
    const texto = await fs.readFile(path.join(this.dir, `${id}.md`), "utf8").catch(() => "");
    return { meta, texto };
  }

  async markRead(id: string): Promise<boolean> {
    return this.mutate((data) => {
      const r = data.relatorios.find((x) => x.id === id);
      if (!r) return false;
      r.lido = true;
      return true;
    });
  }

  /** Relatórios criados depois de `since` (avisos do HUD). */
  async since(since: Date): Promise<ReportMeta[]> {
    return (await this.reports(MAX_REPORTS)).filter((r) => Date.parse(r.criado_em) > since.getTime()).reverse();
  }
}

/**
 * Agendador: a cada minuto roda as missões vencidas, uma de cada vez, com
 * teto diário de execuções (custo da IA sob controle).
 */
export class MissionRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Missões que alguém mandou executar agora (fila de "executar agora"). */
  private manual: string[] = [];

  constructor(
    private readonly store: MissionStore,
    private readonly execute: (mission: Mission) => Promise<ReportMeta>,
    private readonly opts: { maxPerDay: number; timeZone: string; onError?: (m: Mission | null, err: unknown) => void },
  ) {}

  start(intervalMs = 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get busy() {
    return this.running;
  }

  /** Dispara uma passada sem deixar erro escapar (disco cheio não derruba o servidor). */
  private kick() {
    this.tick().catch((err) => this.opts.onError?.(null, err));
  }

  /** Coloca a missão na fila para rodar já. false = acabou o orçamento de hoje. */
  async runNow(id: string): Promise<boolean> {
    if (!(await this.hasBudget())) return false;
    if (!this.manual.includes(id)) this.manual.push(id);
    this.kick();
    return true;
  }

  private today(at = new Date()) {
    return localDate(at.getTime(), this.opts.timeZone);
  }

  private async hasBudget(): Promise<boolean> {
    const o = await this.store.budget();
    return o.dia !== this.today() || o.execucoes < this.opts.maxPerDay;
  }

  /** Uma passada: executa o que venceu. Retorna quantas missões rodaram. */
  async tick(at?: Date): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let ran = 0;
    try {
      let now = at ?? new Date();
      for (;;) {
        const manualId = this.manual.shift();
        const mission = manualId ? await this.store.get(manualId) : (await this.store.due(now))[0];
        if (!mission) {
          if (manualId) continue; // excluída enquanto esperava
          break;
        }
        if (!(await this.store.takeBudget(this.today(now), this.opts.maxPerDay))) {
          // Sem orçamento hoje: a vencida fica para amanhã cedo (não perde a semana); a manual é recusada.
          if (!manualId) {
            const tomorrow = addDays(this.today(now), 1);
            await this.store.postpone(mission.id, new Date(zonedTime(tomorrow, "06:00", this.opts.timeZone)).toISOString());
          }
          continue;
        }
        if (!manualId) await this.store.markStarted(mission.id, now);
        try {
          const report = await this.execute(mission);
          await this.store.markFinished(mission.id, { quando: new Date().toISOString(), ok: true, relatorio_id: report.id });
        } catch (err) {
          this.opts.onError?.(mission, err);
          await this.store.markFinished(mission.id, { quando: new Date().toISOString(), ok: false, erro: err instanceof Error ? err.message.slice(0, 300) : "falhou" });
        }
        ran++;
        now = at ?? new Date();
      }
    } finally {
      this.running = false;
    }
    return ran;
  }
}
