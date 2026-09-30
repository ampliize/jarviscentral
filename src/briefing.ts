import type { Config } from "./config.js";
import { callResource, ResourceApiError } from "./connectors/resourceApi.js";
import type { Brain } from "./memory/brain.js";

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
  numeros: { recebido_no_mes: number | null; vencidas: number | null; tarefas_atrasadas: number | null; leads_em_aberto: number | null; pendencias: number };
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

export interface BuildInput {
  crm: CrmBriefing | null;
  crmError?: string | null;
  crmConfigured: boolean;
  pendencias: string[];
  inbox: number;
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

  const brain = brainCard(input.pendencias, input.inbox);
  if (brain) cards.push(brain);

  const abertura = input.crm
    ? atencao
      ? `${hello} Revisei o CRM e o cérebro. ${atencao === 1 ? "Um ponto pede" : `${atencao} pontos pedem`} sua atenção hoje.`
      : `${hello} Revisei o CRM e o cérebro. Nada urgente hoje.`
    : `${hello} Revisei o que consegui.`;
  const fechamento = atencao ? "Esse é o essencial. Quer que eu detalhe algum ponto?" : "Esse é o essencial. Bom trabalho.";
  const crm = input.crm;
  const numeros = {
    recebido_no_mes: crm ? crm.financeiro.recebido_no_mes : null,
    vencidas: crm ? total(crm.financeiro.vencidas, crm.financeiro.vencidas_total) : null,
    tarefas_atrasadas: crm ? total(crm.tarefas.atrasadas, crm.tarefas.atrasadas_total) : null,
    leads_em_aberto: crm ? crm.comercial.em_aberto : null,
    pendencias: input.pendencias.length,
  };
  return { saudacao: hello, abertura, cards, fechamento, atencao, numeros };
}

export async function loadBriefing(config: Config, brain: Brain, fetchImpl?: typeof fetch, now?: Date): Promise<Briefing> {
  let crm: CrmBriefing | null = null;
  let crmError: string | null = null;
  if (config.ampliize) {
    try {
      crm = (await callResource({ ...config.ampliize, fetchImpl, timeoutMs: 15_000 }, "briefing")) as CrmBriefing;
    } catch (err) {
      crmError = err instanceof ResourceApiError ? err.message : "falha na consulta";
    }
  }
  const [pendencias, inbox] = await Promise.all([brain.pendencias(), brain.inboxCount()]);
  return buildBriefing({
    crm,
    crmError,
    crmConfigured: !!config.ampliize,
    pendencias,
    inbox,
    ownerName: config.ownerName,
    timeZone: config.timeZone,
    now,
  });
}
