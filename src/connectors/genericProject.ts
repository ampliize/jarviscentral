import type { ProjectConfig } from "../config.js";
import { callResource, ResourceApiError } from "./resourceApi.js";
import { toolResult, type Connector } from "./types.js";

/**
 * Conector genérico para qualquer projeto que implemente o contrato de
 * integração (POST { resource, params } com x-api-key). Dá ao Jarvis duas
 * ferramentas: descobrir os recursos e consultar um deles.
 */
export function genericProjectConnector(project: ProjectConfig, fetchImpl?: typeof fetch): Connector {
  const api = { url: project.url, key: project.key, fetchImpl };
  const safe = async (resource: string, params: Record<string, unknown>) => {
    try {
      return toolResult(true, await callResource(api, resource, params));
    } catch (err) {
      return toolResult(false, { erro: err instanceof ResourceApiError ? err.message : `Falha ao consultar ${project.name}.` });
    }
  };

  return {
    id: project.id,
    name: project.name,
    description: project.description ?? `Projeto ${project.name}.`,
    tools: [
      {
        name: `${project.id}_recursos`,
        description: `Lista o que dá para consultar no projeto ${project.name}. Use antes de ${project.id}_consultar.`,
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        run: () => safe("resources", {}),
      },
      {
        name: `${project.id}_consultar`,
        description: `Consulta um recurso do projeto ${project.name} (somente leitura).`,
        parameters: {
          type: "object",
          properties: {
            resource: { type: "string", description: `Nome do recurso, como listado por ${project.id}_recursos.` },
            params_json: {
              type: ["string", "null"],
              description: "Parâmetros do recurso como objeto JSON em texto (ex.: {\"days\": 7}). Null se não houver.",
            },
          },
          required: ["resource", "params_json"],
          additionalProperties: false,
        },
        run: async (args) => {
          let params: Record<string, unknown> = {};
          if (typeof args.params_json === "string" && args.params_json.trim()) {
            try {
              const parsed = JSON.parse(args.params_json);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed;
            } catch {
              return toolResult(false, { erro: "params_json não é um JSON válido." });
            }
          }
          return safe(String(args.resource ?? ""), params);
        },
      },
    ],
  };
}
