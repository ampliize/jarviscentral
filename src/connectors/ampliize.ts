import { callResource, dropNulls, ResourceApiError, type ResourceApiOptions } from "./resourceApi.js";
import { toolResult, type Connector, type Tool } from "./types.js";

const nullableString = (description: string) => ({ type: ["string", "null"], description });
const nullableInt = (description: string) => ({ type: ["integer", "null"], description });

const schema = (properties: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * Conector do CRM da Ampliize (edge function integration-api, somente leitura).
 * Cada ferramenta é um recurso da API, com nome e descrição que orientam o modelo.
 */
export function ampliizeConnector(api: ResourceApiOptions): Connector {
  const tool = (name: string, description: string, resource: string, properties: Record<string, unknown> = {}): Tool => ({
    name,
    description,
    parameters: schema(properties),
    run: async (args) => {
      try {
        return toolResult(true, await callResource(api, resource, dropNulls(args)));
      } catch (err) {
        const message = err instanceof ResourceApiError ? err.message : "Falha ao consultar o CRM.";
        return toolResult(false, { erro: message });
      }
    },
  });

  return {
    id: "ampliize",
    name: "Ampliize CRM",
    description: "CRM da agência Ampliize: clientes, projetos, financeiro, comercial, erros e melhorias de processo.",
    tools: [
      tool(
        "ampliize_panorama",
        "Panorama geral da operação da Ampliize agora: clientes, receita recorrente, cobranças vencidas, projetos atrasados, tarefas bloqueadas, funil comercial, erros do sistema e melhorias. Use primeiro em perguntas do tipo 'como está a operação?'.",
        "overview",
      ),
      tool("ampliize_clientes", "Lista os clientes da Ampliize com mensalidade ativa e número de projetos.", "clients", {
        status: nullableString("Filtrar por status do cliente (ex.: active). Null para todos."),
      }),
      tool(
        "ampliize_cliente",
        "Ficha completa de UM cliente: contratos, faturas, projetos, tarefas bloqueadas/atrasadas e atualizações dos últimos 30 dias. Informe o id ou parte do nome.",
        "client",
        {
          id: nullableString("UUID do cliente, se souber."),
          nome: nullableString("Nome ou empresa do cliente (mínimo 2 letras)."),
        },
      ),
      tool("ampliize_projetos", "Projetos com prazo, líder e andamento das tarefas.", "projects", {
        status: nullableString("active (padrão), completed ou archived."),
      }),
      tool(
        "ampliize_atividades",
        "Linha do tempo do que aconteceu na operação e no comercial: mudanças de tarefas, comentários, interações com leads e mudanças de etapa.",
        "activity",
        { days: nullableInt("Quantos dias para trás (1 a 60, padrão 7).") },
      ),
      tool(
        "ampliize_melhorias",
        "Melhorias de processo: falhas encontradas (problema, causa, impacto) e acertos (solução e resultado).",
        "improvements",
        { status: nullableString("aberta, em_andamento, implementada ou descartada. Null para todas.") },
      ),
      tool("ampliize_financeiro", "Financeiro de um mês: faturado, recebido, a receber, vencido, contas e saldo.", "finance", {
        mes: nullableString("Mês no formato AAAA-MM. Null para o mês atual."),
      }),
      tool("ampliize_comercial", "Funil comercial: leads por etapa e origem, follow-ups atrasados e fechamentos dos últimos 30 dias.", "pipeline"),
      tool("ampliize_erros", "Erros abertos no sistema (Monitor do CRM).", "errors"),
      tool(
        "ampliize_agenda",
        "Agenda do CRM (a agenda da Ampliize): reuniões marcadas, prazos de tarefas, cobranças, contas a pagar e follow-ups de leads, dia a dia. Use para 'quais meus compromissos?', 'o que tenho hoje/amanhã/essa semana?', 'quando é a próxima reunião?'.",
        "agenda",
        { dias: nullableInt("Quantos dias a partir de hoje (1 a 31, padrão 7). Para 'hoje' use 1.") },
      ),
      tool(
        "ampliize_financeiro_historico",
        "Financeiro mês a mês por competência (faturado, recebido, custos, resultado) com a previsão dos próximos meses e a receita recorrente. Use para tendência, comparação entre meses e projeção de caixa.",
        "finance_history",
        { meses: nullableInt("Quantos meses para trás (3 a 24, padrão 12).") },
      ),
      tool(
        "ampliize_comercial_historico",
        "Comercial mês a mês: leads novos, reuniões, ganhos, perdidos, valor ganho e conversão.",
        "sales_history",
        { meses: nullableInt("Quantos meses para trás (3 a 24, padrão 6).") },
      ),
    ],
  };
}
