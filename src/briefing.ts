import type { Config } from "./config.js";
import { callResource, ResourceApiError } from "./connectors/resourceApi.js";
import type { Brain } from "./memory/brain.js";
import type { Skills } from "./skills/index.js";
import type { Alert } from "./skills/alerts.js";
import type { AgentRun, Review } from "./skills/guard.js";
import type { SystemCheck } from "./skills/monitor.js";
import type { Reminder } from "./skills/reminders.js";
import type { Weather } from "./skills/weather.js";

/**
 * Briefing do dia: junta o CRM (recurso "briefing" da integration-api) e as
 * pendências do cérebro em cards para a tela e uma fala para cada card.
 * Tudo é montado a partir dos dados, sem IA: números e nomes saem exatos e
 * o briefing funciona mesmo sem a chave da OpenAI.
 */

export interface BriefingItem {
  titulo: string;
  detalhe?: string;
  alerta?: boolean;
}

export interface BriefingCard {
  id: string;
  rotulo: string;
  titulo: string;
  destaque?: { valor: string; legenda: string };
  itens: BriefingItem[];
  vazio?: string;
  fala: string;
}

export interface Briefing {
  saudacao: string;
  abertura: string;
  cards: BriefingCard[];
  fechamento: string;
  atencao: number;
  /** Totais para o painel lateral (não dependem do corte das listas). */
  numeros: {
    recebido_no_mes: number | null;
    vencidas: number | null;
    tarefas_atrasadas: number | null;
    leads_em_aberto: number | null;
    pendencias: number;
    lembretes_hoje: number;
    clima: { cidade: string; temperatura: number } | null;
    sistemas: { total: number; ok: number } | null;
    riscos: number;
  };
}

interface Invoice { cliente: string | null; valor: number; vencimento: string; obs?: string | null }
interface Task { tarefa: string; projeto: string | null; responsavel: string | null; prazo: string | null; motivo?: string | null }
export interface CrmBriefing {
  data_referencia: string;
  financeiro: {
    recebido_no_mes: number;
    vencidas: Invoice[];
    vencidas_total?: number;
    a_vencer_7_dias: Invoice[];
    a_vencer_7_dias_total?: number;
    contas_a_pagar_7_dias: { descricao: string; valor: number; vencimento: string }[];
    contas_a_pagar_7_dias_total?: number;
  };
  tarefas: {
    atrasadas: Task[];
    atrasadas_total?: number;
    vencendo: Task[];
    vencendo_total?: number;
    bloqueadas: Task[];
    bloqueadas_total?: number;
  };
  comercial: { leads_novos_24h: { quantidade: number; nomes: string[] }; em_aberto: number; follow_ups_atrasados: number };
  sistema: { erros_abertos: number };
}

const brl = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);

/** "2026-10-01" ou timestamp → "01/10" no fuso do dono. */
const ddmm = (value: string | null | undefined, timeZone: string) => {
  if (!value) return "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(date);
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Total real (contado no CRM); as listas podem vir cortadas. */
const total = (list: unknown[], counted?: number) => Math.max(list.length, counted ?? 0);

/** Junta itens para a fala: "A, B e mais 2". */
const spokenList = (parts: string[], max = 3) => {
  const shown = parts.slice(0, max).filter(Boolean);
  const rest = parts.length - shown.length;
  const head = shown.length > 1 ? `${shown.slice(0, -1).join("; ")} e ${shown[shown.length - 1]}` : (shown[0] ?? "");
  return rest > 0 ? `${head}, e mais ${rest}` : head;
};

export function greeting(now: Date, timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
  return hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
}

function moneyCard(f: CrmBriefing["financeiro"], tz: string, month: string): BriefingCard {
  const overdue = f.vencidas.map((i) => ({
    titulo: `${i.cliente ?? "Sem cliente"} · ${brl(i.valor)}`,
    detalhe: `venceu em ${ddmm(i.vencimento, tz)}${i.obs ? ` · ${i.obs}` : ""}`,
    alerta: true,
  }));
  const upcoming = f.a_vencer_7_dias.map((i) => ({
    titulo: `${i.cliente ?? "Sem cliente"} · ${brl(i.valor)}`,
    detalhe: `vence em ${ddmm(i.vencimento, tz)}`,
  }));
  const nOverdue = total(f.vencidas, f.vencidas_total);
  const nUpcoming = total(f.a_vencer_7_dias, f.a_vencer_7_dias_total);
  const nPay = total(f.contas_a_pagar_7_dias, f.contas_a_pagar_7_dias_total);
  // spokenList fala os primeiros e "e mais N" com base no total real.
  const withRest = (parts: string[], n: number) => [...parts, ...Array(Math.max(0, n - parts.length)).fill("")];
  const parts = [`Em ${month} entraram ${brl(f.recebido_no_mes)}.`];
  if (nOverdue) {
    parts.push(
      `${nOverdue === 1 ? "Tem uma cobrança vencida" : `Tem ${nOverdue} cobranças vencidas`}: ${spokenList(
        withRest(f.vencidas.map((i) => `${i.cliente ?? "sem cliente"}, ${brl(i.valor)} desde ${ddmm(i.vencimento, tz)}`), nOverdue),
      )}.`,
    );
  }
  if (nUpcoming) {
    parts.push(
      `Nos próximos 7 dias ${nUpcoming === 1 ? "vence uma" : `vencem ${nUpcoming}`}: ${spokenList(
        withRest(f.a_vencer_7_dias.map((i) => `${i.cliente ?? "sem cliente"}, ${brl(i.valor)} em ${ddmm(i.vencimento, tz)}`), nUpcoming),
      )}.`,
    );
  }
  if (!nOverdue && !nUpcoming) parts.push("Nenhuma cobrança vencida nem vencendo esta semana.");
  if (nPay) {
    const sumShown = f.contas_a_pagar_7_dias.reduce((acc, p) => acc + p.valor, 0);
    parts.push(
      nPay > f.contas_a_pagar_7_dias.length
        ? `Para pagar nos próximos 7 dias: ${plural(nPay, "conta", "contas")}.`
        : `Para pagar nos próximos 7 dias: ${plural(nPay, "conta", "contas")}, ${brl(sumShown)}.`,
    );
  }
  return {
    id: "dinheiro",
    rotulo: "FINANCEIRO · COBRANÇA",
    titulo: nOverdue ? "Dinheiro pedindo atenção" : "Dinheiro",
    destaque: { valor: brl(f.recebido_no_mes), legenda: `recebido em ${month}` },
    itens: [
      ...overdue,
      ...upcoming,
      ...f.contas_a_pagar_7_dias.map((p) => ({ titulo: `A pagar: ${p.descricao} · ${brl(p.valor)}`, detalhe: `vence em ${ddmm(p.vencimento, tz)}` })),
    ].slice(0, 8),
    vazio: "Nada vencido nem vencendo nos próximos 7 dias.",
    fala: parts.join(" "),
  };
}

function tasksCard(t: CrmBriefing["tarefas"], tz: string): BriefingCard {
  const nLate = total(t.atrasadas, t.atrasadas_total);
  const nSoon = total(t.vencendo, t.vencendo_total);
  const nBlocked = total(t.bloqueadas, t.bloqueadas_total);
  const withRest = (parts: string[], n: number) => [...parts, ...Array(Math.max(0, n - parts.length)).fill("")];
  const who = (x: Task) => (x.responsavel ? `, com ${x.responsavel.split(" ")[0]}` : "");
  const where = (x: Task) => (x.projeto ? ` (${x.projeto.trim()})` : "");
  const parts: string[] = [];
  if (nLate) {
    parts.push(
      `${nLate === 1 ? "Uma tarefa atrasada" : `${nLate} tarefas atrasadas`}: ${spokenList(
        withRest(t.atrasadas.map((x) => `${x.tarefa}${where(x)}${who(x)}, desde ${ddmm(x.prazo, tz)}`), nLate),
      )}.`,
    );
  }
  if (nSoon) {
    parts.push(`${nSoon === 1 ? "Vence até amanhã" : `Vencem até amanhã ${nSoon} tarefas`}: ${spokenList(withRest(t.vencendo.map((x) => `${x.tarefa}${where(x)}${who(x)}`), nSoon))}.`);
  }
  if (nBlocked) {
    parts.push(`${plural(nBlocked, "tarefa bloqueada", "tarefas bloqueadas")}: ${spokenList(withRest(t.bloqueadas.map((x) => `${x.tarefa}${where(x)}`), nBlocked))}.`);
  }
  if (!parts.length) parts.push("Nenhuma tarefa atrasada, vencendo ou bloqueada.");
  const line = (x: Task, label: string, alerta = false): BriefingItem => ({
    titulo: x.tarefa,
    detalhe: [x.projeto?.trim(), x.responsavel, label].filter(Boolean).join(" · "),
    alerta,
  });
  return {
    id: "entregas",
    rotulo: "PROJETOS · TAREFAS",
    titulo: nLate ? "Entregas atrasadas" : "Entregas",
    destaque: { valor: String(nLate), legenda: nLate === 1 ? "atrasada" : "atrasadas" },
    itens: [
      ...t.atrasadas.map((x) => line(x, `desde ${ddmm(x.prazo, tz)}`, true)),
      ...t.bloqueadas.map((x) => line(x, `bloqueada${x.motivo ? `: ${x.motivo}` : ""}`, true)),
      ...t.vencendo.map((x) => line(x, `vence ${ddmm(x.prazo, tz)}`)),
    ].slice(0, 8),
    vazio: "Nada atrasado nem vencendo até amanhã.",
    fala: parts.join(" "),
  };
}

function salesCard(c: CrmBriefing["comercial"]): BriefingCard {
  const novos = c.leads_novos_24h;
  const parts = [
    novos.quantidade
      ? `${novos.quantidade === 1 ? "Chegou um lead novo" : `Chegaram ${novos.quantidade} leads novos`} nas últimas 24 horas${novos.nomes.length ? `: ${spokenList(novos.nomes)}` : ""}.`
      : "Nenhum lead novo nas últimas 24 horas.",
    `${plural(c.em_aberto, "lead em aberto", "leads em aberto")} no funil.`,
  ];
  if (c.follow_ups_atrasados) parts.push(`${plural(c.follow_ups_atrasados, "follow-up atrasado", "follow-ups atrasados")}.`);
  return {
    id: "comercial",
    rotulo: "COMERCIAL · FUNIL",
    titulo: "Comercial",
    destaque: { valor: String(c.em_aberto), legenda: "leads em aberto" },
    itens: [
      ...novos.nomes.map((n) => ({ titulo: n, detalhe: "lead novo (24h)" })),
      ...(c.follow_ups_atrasados ? [{ titulo: plural(c.follow_ups_atrasados, "follow-up atrasado", "follow-ups atrasados"), alerta: true }] : []),
    ],
    vazio: "Sem leads novos nem follow-ups atrasados.",
    fala: parts.join(" "),
  };
}

function brainCard(pendencias: string[], inbox: number): BriefingCard | null {
  if (!pendencias.length && !inbox) return null;
  const parts: string[] = [];
  if (pendencias.length) {
    const first = pendencias.slice(0, 2);
    parts.push(`No cérebro, ${plural(pendencias.length, "pendência aberta", "pendências abertas")}. ${first.length === 1 ? "A primeira" : "As primeiras"}: ${first.join(" e ")}.`);
  }
  if (inbox) parts.push(`${plural(inbox, "nota", "notas")} na caixa de entrada para revisar.`);
  return {
    id: "cerebro",
    rotulo: "CÉREBRO · PENDÊNCIAS",
    titulo: "Pendências",
    destaque: { valor: String(pendencias.length), legenda: "em aberto" },
    itens: [...pendencias.slice(0, 6).map((p) => ({ titulo: p })), ...(inbox ? [{ titulo: plural(inbox, "nota na inbox", "notas na inbox"), detalhe: "revisar no Obsidian" }] : [])],
    fala: parts.join(" "),
  };
}

function weatherCard(w: Weather): BriefingCard {
  const rain = w.hoje.chance_de_chuva;
  const hasRange = w.hoje.minima != null && w.hoje.maxima != null;
  const city = w.cidade.replace(/\s*\(.*\)$/, "");
  return {
    id: "clima",
    rotulo: "PANORAMA · CLIMA",
    titulo: city,
    destaque: { valor: `${w.agora.temperatura}°`, legenda: w.agora.condicao },
    itens: [
      ...(hasRange ? [{ titulo: `Hoje: mínima ${w.hoje.minima}° e máxima ${w.hoje.maxima}°`, detalhe: rain != null ? `${rain}% de chance de chuva` : undefined }] : []),
      ...(w.amanha ? [{ titulo: `Amanhã: ${w.amanha.minima}° a ${w.amanha.maxima}°`, detalhe: w.amanha.condicao }] : []),
    ],
    fala:
      `Em ${city} agora faz ${w.agora.temperatura} graus, ${w.agora.condicao}.` +
      (hasRange ? ` Hoje a mínima é ${w.hoje.minima} e a máxima ${w.hoje.maxima}${rain != null ? `, com ${rain}% de chance de chuva` : ""}.` : ""),
  };
}

/** Lembretes de hoje e os que passaram da hora sem ser concluídos (esses contam como atenção). */
function remindersCard(list: Reminder[], tz: string, now: Date): BriefingCard | null {
  if (!list.length) return null;
  const fmt = (r: Reminder, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, ...opts }).format(new Date(r.quando));
  const hour = (r: Reminder) => fmt(r, { hour: "2-digit", minute: "2-digit" });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const sameDay = (r: Reminder) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(r.quando)) === today;
  const late = (r: Reminder) => Date.parse(r.quando) < now.getTime();
  const since = (r: Reminder) => (sameDay(r) ? hour(r) : `${fmt(r, { day: "2-digit", month: "2-digit" })} às ${hour(r)}`);
  const nLate = list.filter(late).length;
  return {
    id: "lembretes",
    rotulo: "AGENDA · LEMBRETES",
    titulo: nLate ? "Lembretes pedindo atenção" : "Lembretes de hoje",
    destaque: { valor: String(list.length), legenda: list.length === 1 ? "lembrete" : "lembretes" },
    itens: list.slice(0, 8).map((r) => ({ titulo: r.texto, detalhe: late(r) ? `atrasado desde ${since(r)}` : `hoje às ${hour(r)}`, alerta: late(r) })),
    fala: `${list.length === 1 ? "Você tem um lembrete" : `Você tem ${list.length} lembretes`}: ${spokenList(
      list.map((r) => `${r.texto}, ${late(r) ? `atrasado desde ${since(r)}` : `às ${hour(r)}`}`),
    )}.`,
  };
}

/** Sistemas monitorados: só fala dos que estão com problema. */
function systemsCard(list: SystemCheck[]): BriefingCard | null {
  if (!list.length) return null;
  const bad = list.filter((s) => s.status !== "ok");
  const label = (s: SystemCheck) => `${s.nome}${s.cliente ? ` (${s.cliente})` : ""}`;
  const why = (s: SystemCheck) => (s.status === "fora" ? `fora do ar, ${s.detalhe ?? "sem resposta"}` : (s.detalhe ?? "com atenção"));
  return {
    id: "sistemas",
    rotulo: "SISTEMAS · MONITOR",
    titulo: bad.length ? "Sistemas com problema" : "Sistemas no ar",
    destaque: { valor: `${list.length - bad.length}/${list.length}`, legenda: "no ar e saudáveis" },
    itens: [
      ...bad.map((s) => ({ titulo: label(s), detalhe: why(s), alerta: true })),
      ...list.filter((s) => s.status === "ok").map((s) => ({ titulo: label(s), detalhe: `ok${s.ms != null ? ` · ${s.ms} ms` : ""}${s.ssl_dias != null ? ` · HTTPS vence em ${s.ssl_dias} dias` : ""}` })),
    ].slice(0, 8),
    fala: bad.length
      ? `${bad.length === 1 ? "Um sistema pede atenção" : `${bad.length} sistemas pedem atenção`}: ${spokenList(bad.map((s) => `${label(s)}, ${why(s)}`))}.`
      : `${list.length === 1 ? "O sistema monitorado está no ar" : `Os ${list.length} sistemas monitorados estão no ar`}, sem alertas.`,
  };
}

const LEVEL: Record<Alert["nivel"], string> = { critico: "crítico", alto: "alto", medio: "médio", baixo: "baixo" };
const ICON: Record<Alert["nivel"], string> = { critico: "🔴", alto: "🟠", medio: "🟡", baixo: "🟢" };

/** Riscos registrados em _jarvis/alertas.md que ainda não foram resolvidos. */
function risksCard(list: Alert[], tz: string): BriefingCard | null {
  if (!list.length) return null;
  const since = (a: Alert) => (a.desde ? ddmm(a.desde, tz) : null);
  const top = list[0]!;
  const crit = list.filter((a) => a.nivel === "critico").length;
  return {
    id: "riscos",
    rotulo: "OPERAÇÃO · RISCOS",
    titulo: crit ? "Riscos críticos em aberto" : "Riscos em aberto",
    destaque: { valor: String(list.length), legenda: crit ? `${crit} crítico${crit > 1 ? "s" : ""}` : "em aberto" },
    itens: list.slice(0, 8).map((a) => ({
      titulo: `${ICON[a.nivel]} ${a.sistema}: ${a.descricao}`,
      detalhe: [since(a) ? `desde ${since(a)}` : null, a.acao ? `ação: ${a.acao}` : null].filter(Boolean).join(" · ") || undefined,
      alerta: a.nivel === "critico" || a.nivel === "alto",
    })),
    fala: `${list.length === 1 ? "Tem um risco em aberto" : `Tem ${list.length} riscos em aberto`}. O mais grave: ${top.sistema}, ${top.descricao}, nível ${LEVEL[top.nivel]}${
      since(top) ? `, desde ${since(top)}` : ""
    }.`,
  };
}

export interface BuildInput {
  crm: CrmBriefing | null;
  crmError?: string | null;
  crmConfigured: boolean;
  pendencias: string[];
  inbox: number;
  clima?: Weather | null;
  /** Lembretes em aberto que vencem até o fim de hoje (inclui os atrasados de outros dias). */
  lembretes?: Reminder[];
  /** Último teste dos sistemas monitorados (null = monitor indisponível). */
  sistemas?: SystemCheck[] | null;
  /** Riscos em aberto (_jarvis/alertas.md). */
  alertas?: Alert[];
  /** Rascunhos dos agentes de IA (null = não deu para ler) e as revisões do guardião. */
  agentes?: { rascunhos: AgentRun[] | null; revisoes: Review[] };
  ownerName: string;
  timeZone: string;
  now?: Date;
}

export function buildBriefing(input: BuildInput): Briefing {
  const now = input.now ?? new Date();
  const tz = input.timeZone;
  const hello = `${greeting(now, tz)}, ${input.ownerName}.`;
  const month = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, month: "long" }).format(now);
  const cards: BriefingCard[] = [];
  let atencao = 0;
  if (input.clima) cards.push(weatherCard(input.clima));
  const reminders = remindersCard(input.lembretes ?? [], tz, now);
  if (reminders) cards.push(reminders);
  const lateReminders = (input.lembretes ?? []).filter((r) => Date.parse(r.quando) < now.getTime()).length;
  const systems = systemsCard(input.sistemas ?? []);
  if (systems) cards.push(systems);
  const badSystems = (input.sistemas ?? []).filter((s) => s.status !== "ok").length;
  const risks = risksCard(input.alertas ?? [], tz);
  if (risks) cards.push(risks);

  if (input.crm) {
    const { financeiro, tarefas, comercial, sistema } = input.crm;
    cards.push(moneyCard(financeiro, tz, month), tasksCard(tarefas, tz), salesCard(comercial));
    if (sistema.erros_abertos) {
      cards.push({
        id: "sistema",
        rotulo: "SISTEMA · MONITOR",
        titulo: "Erros no CRM",
        destaque: { valor: String(sistema.erros_abertos), legenda: "abertos" },
        itens: [{ titulo: "Veja em Monitor no CRM", alerta: true }],
        fala: `O Monitor tem ${plural(sistema.erros_abertos, "erro aberto", "erros abertos")} no CRM.`,
      });
    }
    atencao =
      total(financeiro.vencidas, financeiro.vencidas_total) +
      total(tarefas.atrasadas, tarefas.atrasadas_total) +
      total(tarefas.bloqueadas, tarefas.bloqueadas_total) +
      comercial.follow_ups_atrasados +
      sistema.erros_abertos;
  } else {
    const why = input.crmConfigured
      ? `Não consegui ler o CRM agora${input.crmError ? ` (${input.crmError})` : ""}.`
      : "O CRM ainda não está conectado: falta a AMPLIIZE_API_KEY no Easypanel.";
    cards.push({ id: "crm", rotulo: "CRM · CONEXÃO", titulo: "CRM indisponível", itens: [{ titulo: why, alerta: true }], fala: why });
  }

  // Lembretes atrasados e sistemas com problema contam mesmo sem o CRM.
  atencao += lateReminders + badSystems + (input.alertas?.length ?? 0);

  const brain = brainCard(input.pendencias, input.inbox);
  if (brain) cards.push(brain);

  const abertura = input.crm
    ? atencao
      ? `${hello} Revisei o CRM e o cérebro. ${atencao === 1 ? "Um ponto pede" : `${atencao} pontos pedem`} sua atenção hoje.`
      : `${hello} Revisei o CRM e o cérebro. Nada urgente hoje.`
    : `${hello} Revisei o que consegui.${atencao ? ` ${atencao === 1 ? "Um ponto pede" : `${atencao} pontos pedem`} sua atenção.` : ""}`;
  const fechamento = atencao ? "Esse é o essencial. Quer que eu detalhe algum ponto?" : "Esse é o essencial. Bom trabalho.";
  const crm = input.crm;
  const numeros = {
    recebido_no_mes: crm ? crm.financeiro.recebido_no_mes : null,
    vencidas: crm ? total(crm.financeiro.vencidas, crm.financeiro.vencidas_total) : null,
    tarefas_atrasadas: crm ? total(crm.tarefas.atrasadas, crm.tarefas.atrasadas_total) : null,
    leads_em_aberto: crm ? crm.comercial.em_aberto : null,
    pendencias: input.pendencias.length,
    lembretes_hoje: input.lembretes?.length ?? 0,
    clima: input.clima ? { cidade: input.clima.cidade.replace(/\s*\(.*\)$/, ""), temperatura: input.clima.agora.temperatura } : null,
    sistemas: input.sistemas?.length ? { total: input.sistemas.length, ok: input.sistemas.length - badSystems } : null,
    riscos: input.alertas?.length ?? 0,
  };
  return { saudacao: hello, abertura, cards, fechamento, atencao, numeros };
}

/** Fim do dia de hoje (no fuso do dono), para filtrar os lembretes. */
const endOfToday = (now: Date, timeZone: string) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const until = (r: Reminder) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(r.quando)) <= today;
  return until;
};

/** Junta tudo o que o briefing e o monitor da operação usam (em paralelo). */
export async function gatherOperation(config: Config, brain: Brain, fetchImpl?: typeof fetch, now = new Date(), skills?: Skills): Promise<BuildInput> {
  let crmError: string | null = null;
  // CRM, clima e lembretes em paralelo; clima fora do ar não derruba o briefing.
  // Sistemas: usa o último teste (até 10 min); se precisar testar, espera no máximo 6 s.
  const systemsStatus = skills?.monitor
    ? Promise.race([skills.monitor.status(10 * 60 * 1000), new Promise<null>((r) => setTimeout(() => r(null), 6_000).unref())]).catch(() => null)
    : Promise.resolve(null);
  const guard = skills?.guard;
  const agentes = guard && config.ampliize
    ? Promise.all([guard.drafts({ dias: 7 }).catch(() => null), guard.stored().catch(() => [])]).then(([rascunhos, revisoes]) => ({ rascunhos, revisoes }))
    : Promise.resolve(undefined);
  const [crm, clima, lembretes, pendencias, inbox, sistemas, alertas, agentesData] = await Promise.all([
    config.ampliize
      ? (callResource({ ...config.ampliize, fetchImpl, timeoutMs: 15_000 }, "briefing") as Promise<CrmBriefing>).catch((err) => {
          crmError = err instanceof ResourceApiError ? err.message : "falha na consulta";
          return null;
        })
      : Promise.resolve(null),
    skills ? skills.weather.get(skills.city).catch(() => null) : Promise.resolve(null),
    skills ? skills.reminders.open().then((list) => list.filter(endOfToday(now, config.timeZone))) : Promise.resolve([]),
    brain.pendencias(),
    brain.inboxCount(),
    systemsStatus,
    skills?.alerts ? skills.alerts.open().catch(() => []) : Promise.resolve([]),
    agentes,
  ]);
  return {
    crm,
    crmError,
    crmConfigured: !!config.ampliize,
    pendencias,
    inbox,
    clima,
    lembretes,
    sistemas,
    alertas,
    agentes: agentesData,
    ownerName: config.ownerName,
    timeZone: config.timeZone,
    now,
  };
}

export async function loadBriefing(config: Config, brain: Brain, fetchImpl?: typeof fetch, now = new Date(), skills?: Skills): Promise<Briefing> {
  return buildBriefing(await gatherOperation(config, brain, fetchImpl, now, skills));
}

// ---------------------------------------------------------------- monitor da operação

export type AreaState = "ok" | "atencao" | "critico" | "sem_dados";

export interface OperationArea {
  id: string;
  nome: string;
  estado: AreaState;
  resumo: string;
  itens: string[];
}

export interface Operation {
  geral: AreaState;
  areas: OperationArea[];
  gerado_em: string;
}

const WORST: AreaState[] = ["critico", "atencao", "ok", "sem_dados"];

/**
 * Semáforo da operação inteira, área por área, com os mesmos dados do briefing.
 * Só lê: os riscos saem de _jarvis/alertas.md e os números do CRM.
 */
export function buildOperation(input: BuildInput): Operation {
  const now = input.now ?? new Date();
  const tz = input.timeZone;
  const areas: OperationArea[] = [];

  const systems = input.sistemas;
  if (!systems) areas.push({ id: "sistemas", nome: "Sistemas", estado: "sem_dados", resumo: "monitor ainda testando", itens: [] });
  else if (!systems.length) areas.push({ id: "sistemas", nome: "Sistemas", estado: "sem_dados", resumo: "nenhum sistema em _jarvis/sistemas.md", itens: [] });
  else {
    const down = systems.filter((x) => x.status === "fora");
    const warn = systems.filter((x) => x.status === "atencao");
    areas.push({
      id: "sistemas",
      nome: "Sistemas",
      estado: down.length ? "critico" : warn.length ? "atencao" : "ok",
      resumo: `${systems.length - down.length - warn.length}/${systems.length} no ar e saudáveis`,
      itens: [...down, ...warn].map((x) => `${x.nome}${x.cliente ? ` (${x.cliente})` : ""}: ${x.status === "fora" ? "fora do ar" : "atenção"}${x.detalhe ? `, ${x.detalhe}` : ""}`),
    });
  }

  const risks = input.alertas ?? [];
  const crit = risks.filter((a) => a.nivel === "critico").length;
  areas.push({
    id: "riscos",
    nome: "Riscos registrados",
    estado: crit ? "critico" : risks.length ? "atencao" : "ok",
    resumo: risks.length ? `${risks.length} em aberto${crit ? `, ${crit} crítico${crit > 1 ? "s" : ""}` : ""}` : "nenhum risco em aberto",
    itens: risks.map((a) => `${ICON[a.nivel]} ${a.sistema}: ${a.descricao}${a.desde ? ` (desde ${ddmm(a.desde, tz)})` : ""}`),
  });

  const crm = input.crm;
  if (!crm) {
    const why = input.crmConfigured ? `CRM não respondeu${input.crmError ? ` (${input.crmError})` : ""}` : "CRM não conectado";
    for (const [id, nome] of [["financeiro", "Financeiro"], ["entregas", "Entregas"], ["comercial", "Comercial"], ["crm", "Erros do CRM"]] as const) {
      areas.push({ id, nome, estado: "sem_dados", resumo: why, itens: [] });
    }
  } else {
    const f = crm.financeiro;
    const overdue = total(f.vencidas, f.vencidas_total);
    // A mais antiga das vencidas (a lista do CRM não garante ordem).
    const dues = f.vencidas.map((i) => Date.parse(`${i.vencimento.slice(0, 10)}T12:00:00Z`)).filter((t) => !Number.isNaN(t));
    const veryLate = dues.length ? now.getTime() - Math.min(...dues) > 30 * 86_400_000 : false;
    areas.push({
      id: "financeiro",
      nome: "Financeiro",
      estado: overdue ? (veryLate ? "critico" : "atencao") : "ok",
      resumo: `${brl(f.recebido_no_mes)} recebido no mês · ${plural(overdue, "cobrança vencida", "cobranças vencidas")}`,
      itens: f.vencidas.map((i) => `${i.cliente ?? "sem cliente"}: ${brl(i.valor)} vencida em ${ddmm(i.vencimento, tz)}`),
    });
    const t = crm.tarefas;
    const late = total(t.atrasadas, t.atrasadas_total);
    const blocked = total(t.bloqueadas, t.bloqueadas_total);
    areas.push({
      id: "entregas",
      nome: "Entregas",
      estado: late || blocked ? "atencao" : "ok",
      resumo: `${plural(late, "tarefa atrasada", "tarefas atrasadas")} · ${plural(blocked, "bloqueada", "bloqueadas")}`,
      itens: [...t.atrasadas.map((x) => `${x.tarefa}${x.projeto ? ` (${x.projeto.trim()})` : ""}: atrasada`), ...t.bloqueadas.map((x) => `${x.tarefa}: bloqueada`)],
    });
    const c = crm.comercial;
    areas.push({
      id: "comercial",
      nome: "Comercial",
      estado: c.follow_ups_atrasados ? "atencao" : "ok",
      resumo: `${plural(c.em_aberto, "lead em aberto", "leads em aberto")} · ${plural(c.follow_ups_atrasados, "follow-up atrasado", "follow-ups atrasados")} · ${plural(c.leads_novos_24h.quantidade, "novo em 24 h", "novos em 24 h")}`,
      itens: [],
    });
    areas.push({
      id: "crm",
      nome: "Erros do CRM",
      estado: crm.sistema.erros_abertos ? "atencao" : "ok",
      resumo: crm.sistema.erros_abertos ? `${plural(crm.sistema.erros_abertos, "erro aberto", "erros abertos")} no Monitor` : "sem erros abertos",
      itens: [],
    });
  }

  // Agentes de IA: rascunhos pendentes e o que o guardião achou deles.
  const ag = input.agentes;
  if (!ag || !ag.rascunhos) {
    areas.push({ id: "agentes", nome: "Agentes de IA", estado: "sem_dados", resumo: !input.crmConfigured ? "CRM não conectado" : "não consegui ler os rascunhos dos agentes", itens: [] });
  } else {
    const byId = new Map(ag.revisoes.map((r) => [r.id, r]));
    const AG: Record<string, string> = { sdr: "SDR", closer: "Closer", content: "Conteúdo" };
    const reviewed = ag.rascunhos.map((d) => ({ d, r: byId.get(d.id) }));
    const blocked = reviewed.filter((x) => x.r?.veredito === "bloquear");
    const adjust = reviewed.filter((x) => x.r?.veredito === "ajustar");
    const pending = reviewed.filter((x) => !x.r);
    areas.push({
      id: "agentes",
      nome: "Agentes de IA",
      estado: blocked.length ? "critico" : adjust.length || pending.length ? "atencao" : "ok",
      resumo: ag.rascunhos.length
        ? `${plural(ag.rascunhos.length, "rascunho pendente", "rascunhos pendentes")} · ${blocked.length} bloqueado(s) · ${adjust.length} para ajustar · ${pending.length} sem revisão`
        : "nenhum rascunho pendente",
      itens: [...blocked, ...adjust].map(({ d, r }) => `${r!.veredito === "bloquear" ? "🔴" : "🟡"} ${AG[d.agente] ?? d.agente}${d.lead?.nome ? ` · ${d.lead.nome}` : ""}: ${r!.resumo}`),
    });
  }

  const late = (input.lembretes ?? []).filter((r) => Date.parse(r.quando) < now.getTime());
  areas.push({
    id: "lembretes",
    nome: "Lembretes",
    estado: late.length ? "atencao" : "ok",
    resumo: late.length ? plural(late.length, "lembrete atrasado", "lembretes atrasados") : "nada atrasado",
    itens: late.map((r) => r.texto),
  });

  const geral = WORST.find((w) => w !== "sem_dados" && areas.some((a) => a.estado === w)) ?? "sem_dados";
  return { geral, areas, gerado_em: now.toISOString() };
}
