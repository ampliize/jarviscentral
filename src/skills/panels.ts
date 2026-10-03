import { callResource, ResourceApiError, type ResourceApiOptions } from "../connectors/resourceApi.js";
import { toolResult, type Connector } from "../connectors/types.js";

/**
 * Painéis do HUD (agenda, financeiro e comercial). Tudo vem do CRM da
 * Ampliize pela integration-api; o Jarvis só organiza, não inventa número.
 */
export type PanelKind = "agenda" | "financeiro" | "comercial";
export const PANEL_KINDS: PanelKind[] = ["agenda", "financeiro", "comercial"];

export interface AgendaEvent {
  tipo: "reuniao" | "prazo" | "cobranca" | "pagamento" | "follow_up";
  data: string;
  hora: string | null;
  titulo: string;
  detalhe: string | null;
  valor?: number;
  local?: string | null;
  link?: string | null;
  status?: string | null;
}

export interface Agenda {
  de: string;
  ate: string;
  dias: number;
  proxima_reuniao: AgendaEvent | null;
  contagem: { reunioes: number; prazos: number; cobrancas: number; pagamentos: number; follow_ups: number };
  eventos: AgendaEvent[];
}

export interface FinanceMonth {
  mes: string;
  previsto: boolean;
  faturado: number;
  recebido: number;
  a_receber: number;
  vencido: number;
  custos: number;
  custos_pagos: number;
  resultado: number;
  resultado_previsto: number;
}

export interface FinanceHistory {
  mes_atual: string;
  receita_recorrente_mensal: number;
  contratos_recorrentes: number;
  custos_por_categoria_mes_atual: Record<string, number>;
  serie: FinanceMonth[];
}

export interface SalesMonth {
  mes: string;
  leads_novos: number;
  reunioes: number;
  ganhos: number;
  perdidos: number;
  valor_ganho_estimado: number;
  conversao: number | null;
}

export interface SalesHistory {
  mes_atual: string;
  funil_aberto: { quantidade: number; valor_estimado: number; por_etapa: Record<string, number> };
  origem_dos_leads_no_periodo: Record<string, number>;
  serie: SalesMonth[];
}

export class PanelError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const RESOURCE: Record<PanelKind, { resource: string; params: Record<string, unknown> }> = {
  agenda: { resource: "agenda", params: { dias: 7 } },
  financeiro: { resource: "finance_history", params: { meses: 12, futuros: 2 } },
  comercial: { resource: "sales_history", params: { meses: 6 } },
};

const CACHE_MS = 60_000;

export class CrmPanels {
  private cache = new Map<string, { at: number; data: Promise<unknown> }>();

  constructor(private readonly api: ResourceApiOptions | null, private readonly fetchImpl?: typeof fetch) {}

  get configured() {
    return !!this.api;
  }

  private async load(resource: string, params: Record<string, unknown>) {
    if (!this.api) throw new PanelError(503, "O CRM não está conectado (AMPLIIZE_API_URL e AMPLIIZE_API_KEY).");
    const key = `${resource}:${JSON.stringify(params)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const data = callResource({ ...this.api, fetchImpl: this.fetchImpl, timeoutMs: 15_000 }, resource, params).catch((err) => {
      this.cache.delete(key); // erro não fica guardado
      if (err instanceof ResourceApiError) {
        // 404 = o CRM ainda não tem o recurso (função antiga no Supabase).
        throw new PanelError(err.status === 404 ? 501 : 502, err.status === 404 ? "O CRM ainda não tem este painel: publique a integration-api nova." : `O CRM não respondeu: ${err.message}`);
      }
      throw new PanelError(502, "O CRM não respondeu.");
    });
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  panel(kind: PanelKind): Promise<Agenda | FinanceHistory | SalesHistory> {
    const r = RESOURCE[kind];
    return this.load(r.resource, r.params) as Promise<Agenda | FinanceHistory | SalesHistory>;
  }

}

/** Resumo curto para a IA (o HUD busca o painel completo): poupa contexto. */
export function panelSummary(kind: PanelKind, data: Agenda | FinanceHistory | SalesHistory): unknown {
  if (kind === "agenda") {
    const a = data as Agenda;
    return { de: a.de, ate: a.ate, contagem: a.contagem, proxima_reuniao: a.proxima_reuniao, primeiros: (a.eventos ?? []).slice(0, 12) };
  }
  if (kind === "financeiro") {
    const f = data as FinanceHistory;
    const serie = f.serie ?? [];
    return {
      receita_recorrente_mensal: f.receita_recorrente_mensal,
      mes_atual: serie.find((m) => m.mes === f.mes_atual) ?? null,
      mes_anterior: serie.filter((m) => m.mes < f.mes_atual).at(-1) ?? null,
      previsao: serie.filter((m) => m.previsto),
    };
  }
  const s = data as SalesHistory;
  const serie = s.serie ?? [];
  return { funil_aberto: s.funil_aberto, mes_atual: serie.find((m) => m.mes === s.mes_atual) ?? null, ultimos_meses: serie.slice(-3) };
}

const LABEL: Record<PanelKind, string> = { agenda: "Abrir agenda", financeiro: "Abrir painel financeiro", comercial: "Abrir painel comercial" };

/**
 * Ferramenta para o modelo abrir um painel no HUD quando o dono pedir
 * ("abre meu painel financeiro", "mostra minha agenda da semana").
 */
export function panelsConnector(panels: CrmPanels): Connector {
  return {
    id: "paineis",
    name: "Painéis do HUD",
    description: "Abre painéis com gráficos no HUD: agenda, financeiro e comercial, com dados do CRM.",
    tools: [
      {
        name: "hud_abrir_painel",
        description:
          "Abre um painel no HUD com os dados do CRM: 'agenda' (reuniões, prazos, cobranças, contas e follow-ups dos próximos 7 dias), 'financeiro' (12 meses de faturado, recebido, custos e resultado, mais a previsão) ou 'comercial' (leads, reuniões, ganhos e conversão por mês). Use quando pedirem para abrir, mostrar ou ver um painel, a agenda ou os compromissos. Responda com um resumo curto do que o painel mostra.",
        parameters: {
          type: "object",
          properties: { painel: { type: "string", enum: PANEL_KINDS, description: "Qual painel abrir." } },
          required: ["painel"],
          additionalProperties: false,
        },
        run: async (args) => {
          const kind = String(args.painel) as PanelKind;
          if (!PANEL_KINDS.includes(kind)) return toolResult(false, { erro: "Painel desconhecido." });
          try {
            const data = await panels.panel(kind);
            return { ...toolResult(true, { painel: kind, aberto_no_hud: true, resumo: panelSummary(kind, data) }), links: [{ rotulo: LABEL[kind], url: `jarvis:painel/${kind}` }] };
          } catch (err) {
            return toolResult(false, { erro: err instanceof Error ? err.message : "Falha ao abrir o painel." });
          }
        },
      },
    ],
  };
}
