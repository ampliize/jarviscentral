import { toolResult, type Connector, type Tool } from "../connectors/types.js";
import type { ToolRunResult } from "../llm/openai.js";
import { ActionError, BIDDINGS, MATCH_TYPES } from "./actions.js";
import type { ProposalView, TrafficManager } from "./service.js";
import { TrafficError } from "./store.js";
import { AdsError, type StatsLevel } from "./types.js";

/**
 * Ferramentas do agente de tráfego para o Jarvis (chat e missões).
 * Só LER e PROPOR. Aprovar e dar permissão não existem aqui: é o dono, no
 * HUD ou no WhatsApp, por rotas que a IA não alcança.
 */

const schema = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const keywordList = (description: string) => ({
  type: "array",
  description,
  items: schema({ texto: str("A palavra-chave, em minúsculas."), correspondencia: { type: "string", enum: MATCH_TYPES, description: "ampla, frase ou exata." } }),
});
const motivo = str("Por que fazer isso, com os números que justificam (gasto, cliques, conversões, CPC, período).");

const failure = (err: unknown): ToolRunResult => {
  if (err instanceof ActionError || err instanceof AdsError || err instanceof TrafficError) return toolResult(false, { erro: err.message });
  console.error("tráfego: falha inesperada:", err);
  return toolResult(false, { erro: "falha inesperada no agente de tráfego" });
};

/** Resultado da proposta para o modelo: deixa claro se já foi aplicada ou se espera o dono. */
function proposed(p: ProposalView): ToolRunResult {
  const applied = p.status === "executada";
  const out = toolResult(true, {
    proposta: { id: p.id, status: p.status, resumo: p.resumo, resultado: p.resultado },
    observacao: applied
      ? "Aplicada sozinha porque o dono deu permissão para este tipo de ação. Avise o que foi feito."
      : p.status === "falhou"
        ? `A plataforma recusou: ${p.resultado}`
        : `NÃO foi aplicada. Espera o dono aprovar no HUD (Tráfego) ou respondendo "APROVAR ${p.id}" no WhatsApp. Não diga que foi feito.`,
  });
  if (p.status === "pendente") out.links = [{ rotulo: "Revisar e aprovar", url: `jarvis:trafego/${p.id}` }];
  return out;
}

export function trafficConnector(traffic: TrafficManager): Connector {
  const tools: Tool[] = [
    {
      name: "trafego_status",
      description:
        "Agente de tráfego: contas conectadas (Google Ads, Meta Ads), teto de orçamento, propostas esperando o dono e as permissões que ele deu. Use antes de propor ou quando perguntarem do tráfego.",
      parameters: schema({}),
      run: async () => {
        try {
          const o = await traffic.overview();
          return toolResult(true, {
            plataformas: o.plataformas,
            teto_orcamento_dia: o.teto_orcamento_dia,
            pendentes: o.pendentes.map((p) => ({ id: p.id, resumo: p.resumo, criada_em: p.criada_em })),
            recentes: o.recentes.slice(0, 8).map((p) => ({ id: p.id, resumo: p.resumo, status: p.status, resultado: p.resultado })),
            permissoes_do_dono: o.permissoes.map((g) => ({ titulo: g.titulo, expira_em: g.expira_em })),
          });
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      name: "trafego_desempenho",
      description:
        "Números dos anúncios: gasto, impressões, cliques, CTR, CPC, conversões (Meta: conversas iniciadas) e custo por conversão. Níveis: campanha, grupo (Google), conjunto (Meta), anuncio, palavras (Google) e termos (o que as pessoas pesquisaram no Google: base para negativas).",
      parameters: schema({
        plataforma: { type: "string", enum: ["google", "meta"], description: "google ou meta." },
        nivel: { type: "string", enum: ["campanha", "grupo", "conjunto", "anuncio", "palavras", "termos"], description: "Nível do relatório." },
        dias: { type: ["integer", "null"], description: "Últimos N dias (1 a 90, padrão 7)." },
      }),
      run: async (args) => {
        try {
          const rows = await traffic.stats(args.plataforma as "google" | "meta", args.nivel as StatsLevel, typeof args.dias === "number" ? args.dias : 7);
          const total = rows.reduce((acc, r) => ({ gasto: acc.gasto + r.gasto, cliques: acc.cliques + r.cliques, conversoes: acc.conversoes + r.conversoes }), { gasto: 0, cliques: 0, conversoes: 0 });
          return toolResult(true, { total: { ...total, gasto: Math.round(total.gasto * 100) / 100 }, linhas: rows.slice(0, 80) });
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      name: "trafego_propor_campanha_google",
      description:
        "PROPÕE criar uma campanha de pesquisa no Google Ads (orçamento, locais, palavras-chave, negativas e um anúncio responsivo). Não cria nada: vai para o dono aprovar. Por padrão nasce pausada. Títulos até 30 caracteres (3 a 15), descrições até 90 (2 a 4). Nunca prometa resultado nem preço no anúncio.",
      parameters: schema({
        nome: str("Nome da campanha (ex.: \"Pesquisa · Sites para clínicas · Aracaju\")."),
        orcamento_dia: { type: "number", description: "Orçamento diário em reais." },
        lance: { type: "string", enum: BIDDINGS, description: "maximizar_cliques (início, sem histórico), maximizar_conversoes (com conversões medidas) ou cpc_manual." },
        cpc_max: { type: ["number", "null"], description: "Só com cpc_manual: lance máximo por clique em reais." },
        locais: { type: "array", items: { type: "string" }, description: "Cidades/estados (ex.: [\"Aracaju\", \"Sergipe\"]) ou [\"Brasil\"]." },
        grupo: { type: ["string", "null"], description: "Nome do grupo de anúncios (null = automático)." },
        palavras_chave: keywordList("Palavras-chave com intenção de compra (prefira frase e exata no início)."),
        negativas: keywordList("Palavras negativas (ex.: grátis, curso, emprego, vaga)."),
        titulos: { type: "array", items: { type: "string" }, description: "3 a 15 títulos de até 30 caracteres." },
        descricoes: { type: "array", items: { type: "string" }, description: "2 a 4 descrições de até 90 caracteres." },
        url_final: str("Página de destino https://."),
        caminho1: { type: ["string", "null"], description: "Caminho exibido 1 (até 15 caracteres) ou null." },
        caminho2: { type: ["string", "null"], description: "Caminho exibido 2 (até 15 caracteres) ou null." },
        iniciar_ativa: { type: "boolean", description: "true só se o dono pediu para já rodar; padrão false (nasce pausada)." },
        motivo,
      }),
      run: async (args) => {
        try {
          const p = await traffic.propose(
            "criar_campanha_pesquisa",
            {
              campanha: {
                nome: args.nome,
                orcamento_dia: args.orcamento_dia,
                lance: args.lance,
                cpc_max: args.cpc_max,
                locais: args.locais,
                grupo: args.grupo,
                palavras_chave: args.palavras_chave,
                negativas: args.negativas,
                anuncio: { titulos: args.titulos, descricoes: args.descricoes, url_final: args.url_final, caminho1: args.caminho1, caminho2: args.caminho2 },
                iniciar_ativa: args.iniciar_ativa,
              },
            },
            args.motivo,
            "agente",
          );
          return proposed(p);
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      name: "trafego_propor_orcamento",
      description: "PROPÕE mudar o orçamento diário de uma campanha (Google ou Meta) ou de um conjunto (Meta). Use o id do relatório de desempenho.",
      parameters: schema({
        plataforma: { type: "string", enum: ["google", "meta"], description: "google ou meta." },
        nivel: { type: "string", enum: ["campanha", "conjunto"], description: "campanha (Google e Meta) ou conjunto (Meta)." },
        id: str("Id numérico do item."),
        novo_orcamento_dia: { type: "number", description: "Novo orçamento diário em reais." },
        motivo,
      }),
      run: async (args) => {
        try {
          return proposed(await traffic.propose("alterar_orcamento", { plataforma: args.plataforma, nivel: args.nivel, id: args.id, novo_orcamento_dia: args.novo_orcamento_dia }, args.motivo, "agente"));
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      name: "trafego_propor_status",
      description: "PROPÕE pausar ou ativar uma campanha, grupo (Google), conjunto (Meta) ou anúncio. Anúncio do Google usa o id no formato grupo~anuncio.",
      parameters: schema({
        plataforma: { type: "string", enum: ["google", "meta"], description: "google ou meta." },
        acao: { type: "string", enum: ["pausar", "ativar"], description: "pausar ou ativar." },
        nivel: { type: "string", enum: ["campanha", "grupo", "conjunto", "anuncio"], description: "Nível do item." },
        id: str("Id do item."),
        motivo,
      }),
      run: async (args) => {
        try {
          return proposed(await traffic.propose(args.acao, { plataforma: args.plataforma, nivel: args.nivel, id: args.id }, args.motivo, "agente"));
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      name: "trafego_propor_palavras",
      description:
        "PROPÕE adicionar palavras-chave num grupo do Google (tipo palavras_chave, id = grupo) ou palavras negativas numa campanha do Google (tipo negativas, id = campanha). Negativas vêm dos termos de pesquisa ruins (nivel termos).",
      parameters: schema({
        tipo: { type: "string", enum: ["palavras_chave", "negativas"], description: "palavras_chave ou negativas." },
        id: str("Id do grupo (palavras_chave) ou da campanha (negativas)."),
        palavras: keywordList("As palavras."),
        motivo,
      }),
      run: async (args) => {
        try {
          const tipo = args.tipo === "negativas" ? "adicionar_negativas" : "adicionar_palavras_chave";
          const raw = tipo === "adicionar_negativas" ? { campanha_id: args.id, palavras: args.palavras } : { grupo_id: args.id, palavras: args.palavras };
          return proposed(await traffic.propose(tipo, raw, args.motivo, "agente"));
        } catch (err) {
          return failure(err);
        }
      },
    },
    {
      name: "trafego_propostas",
      description: "Lista as propostas do agente de tráfego: as que esperam o dono (pendente) ou todas, com status e resultado.",
      parameters: schema({ status: { type: "string", enum: ["pendente", "todas"], description: "pendente ou todas." } }),
      run: async (args) => {
        try {
          const list = await traffic.list(args.status === "todas" ? "todas" : "pendente", 20);
          return toolResult(true, { propostas: list.map((p) => ({ id: p.id, status: p.status, resumo: p.resumo, motivo: p.motivo, resultado: p.resultado, criada_em: p.criada_em })) });
        } catch (err) {
          return failure(err);
        }
      },
    },
  ];
  return {
    id: "trafego",
    name: "Agente de tráfego (Google Ads e Meta Ads)",
    description: "Lê o desempenho dos anúncios e PROPÕE mudanças. Nada é aplicado sem o dono aprovar, salvo as permissões que ele mesmo deu.",
    tools,
  };
}
