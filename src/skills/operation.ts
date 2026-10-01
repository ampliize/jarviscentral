import type { Operation } from "../briefing.js";
import { toolResult, type Connector } from "../connectors/types.js";
import type { AlertBook } from "./alerts.js";

/** Monitor da operação inteira (semáforo por área) e riscos registrados. */
export function operationConnector(getOperation: () => Promise<Operation>, alerts: AlertBook): Connector {
  return {
    id: "operacao",
    name: "Monitor da operação",
    description: "Semáforo da operação (sistemas, riscos, financeiro, entregas, comercial, erros do CRM, agentes de IA, lembretes) e riscos registrados em _jarvis/alertas.md.",
    tools: [
      {
        name: "operacao_status",
        description:
          "Semáforo da operação inteira, área por área (ok, atenção, crítico): sistemas no ar, riscos registrados, cobranças vencidas, entregas atrasadas, follow-ups, erros do CRM, rascunhos dos agentes de IA barrados pelo guardião e lembretes atrasados. Use PRIMEIRO em 'como está a operação?', 'o que preciso ver?', 'tem algo pegando fogo?'.",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        run: async () => toolResult(true, await getOperation()),
      },
      {
        name: "riscos_listar",
        description:
          "Riscos em aberto registrados pelo dono em _jarvis/alertas.md (segurança, sistemas de clientes, entregas), do mais grave ao mais leve, com a ação combinada. Apenas informe: não sugira executar correções que o dono não autorizou.",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        run: async () => {
          const list = await alerts.open();
          return toolResult(true, list.length ? list : { resultado: "nenhum risco em aberto" });
        },
      },
    ],
  };
}
