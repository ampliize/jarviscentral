import { toolResult, type Connector } from "../connectors/types.js";
import { NewsError, type NewsService } from "./news.js";
import { parseWhen, ReminderError, type ReminderStore } from "./reminders.js";
import type { AlertBook } from "./alerts.js";
import type { AgentGuard } from "./guard.js";
import type { SystemMonitor } from "./monitor.js";
import { WeatherError, type WeatherService } from "./weather.js";

import type { CrmPanels } from "./panels.js";
import type { MissionStore } from "./missions.js";

export interface Skills {
  reminders: ReminderStore;
  weather: WeatherService;
  news: NewsService;
  /** Cidade padrão do clima (JARVIS_CITY). */
  city: string;
  timeZone: string;
  /** Monitor dos sistemas (lista em _jarvis/sistemas.md). */
  monitor?: SystemMonitor;
  /** Riscos registrados (_jarvis/alertas.md). */
  alerts?: AlertBook;
  /** Guardião dos agentes de IA do CRM. */
  guard?: AgentGuard;
  /** Painéis do HUD (agenda, financeiro, comercial), lidos do CRM. */
  panels?: CrmPanels;
  /** Missões delegadas e relatórios do Jarvis gerente. */
  missions?: MissionStore;
}

const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Lembrete com a hora no fuso do dono, para a resposta falar certo. */
const describe = (r: { id: string; texto: string; quando: string; status: string }, timeZone: string) => ({
  id: r.id,
  texto: r.texto,
  quando: new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "short", timeStyle: "short" }).format(new Date(r.quando)),
  status: r.status,
});

const failure = (err: unknown, known: (new (...a: never[]) => Error)[]) =>
  toolResult(false, { erro: known.some((K) => err instanceof K) ? (err as Error).message : "Falha na habilidade." });

/** Habilidades próprias do Jarvis (não dependem dos projetos conectados). */
export function skillsConnector(s: Skills): Connector {
  return {
    id: "habilidades",
    name: "Habilidades",
    description: "Lembretes com aviso na hora, clima, notícias e status dos sistemas (nossos e dos clientes).",
    tools: [
      {
        name: "lembrete_criar",
        description:
          "Cria um lembrete que o Jarvis avisa em voz na hora marcada. Use quando pedirem 'me lembra', 'me avisa', 'não me deixa esquecer'. Calcule a data a partir da data/hora atual informada no sistema.",
        parameters: obj({
          texto: { type: "string", description: "O que lembrar, curto e na 2ª pessoa (ex.: 'cobrar a Ruddar')." },
          quando: { type: "string", description: "Data e hora em ISO 8601 com o fuso de Aracaju, ex.: 2026-10-01T09:00:00-03:00." },
        }),
        run: async (args) => {
          try {
            const r = await s.reminders.add(String(args.texto ?? ""), parseWhen(String(args.quando ?? ""), s.timeZone));
            return toolResult(true, { criado: describe(r, s.timeZone) });
          } catch (err) {
            return failure(err, [ReminderError]);
          }
        },
      },
      {
        name: "lembrete_listar",
        description: "Lista os lembretes em aberto (os que ainda não foram concluídos, inclusive os que já passaram da hora).",
        parameters: obj({}),
        run: async () => toolResult(true, (await s.reminders.open()).map((r) => describe(r, s.timeZone))),
      },
      {
        name: "lembrete_concluir",
        description: "Marca um lembrete como concluído. Use o id que veio de lembrete_listar.",
        parameters: obj({ id: { type: "string", description: "Id do lembrete." } }),
        run: async (args) => {
          const r = await s.reminders.complete(String(args.id ?? ""));
          return r ? toolResult(true, { concluido: describe(r, s.timeZone) }) : toolResult(false, { erro: "Lembrete não encontrado." });
        },
      },
      {
        name: "clima",
        description: `Clima agora e previsão de hoje e amanhã (temperatura, condição, chance de chuva). Sem cidade, usa ${s.city}.`,
        parameters: obj({ cidade: { type: ["string", "null"], description: `Cidade (padrão: ${s.city}).` } }),
        run: async (args) => {
          try {
            return toolResult(true, await s.weather.get(typeof args.cidade === "string" && args.cidade.trim() ? args.cidade : s.city));
          } catch (err) {
            return failure(err, [WeatherError]);
          }
        },
      },
      ...(s.monitor
        ? [
            {
              name: "sistemas_status",
              description:
                "Status dos sistemas monitorados (nossos e dos clientes): no ar ou fora, tempo de resposta, validade do certificado HTTPS e disponibilidade nas últimas 24 h. A lista fica no vault em _jarvis/sistemas.md.",
              parameters: obj({ atualizar: { type: ["boolean", "null"], description: "true = testa tudo agora em vez de usar o último teste (até 5 min)." } }),
              run: async (args: Record<string, unknown>) => {
                const monitor = s.monitor!;
                const list = args.atualizar === true ? await monitor.checkAll() : await monitor.status();
                return toolResult(true, list.length ? list : { resultado: "nenhum sistema cadastrado em _jarvis/sistemas.md" });
              },
            },
          ]
        : []),
      {
        name: "noticias",
        description:
          "Manchetes recentes do Google Notícias sobre um tema (ou as principais do Brasil, sem tema). Cite a fonte de cada manchete e não invente detalhes além do título.",
        parameters: obj({ tema: { type: ["string", "null"], description: "Tema da busca (ex.: 'marketing digital', 'Aracaju'). Null = principais." } }),
        run: async (args) => {
          try {
            const items = await s.news.search(typeof args.tema === "string" ? args.tema : null);
            return toolResult(true, items.length ? items : { resultado: "nenhuma notícia encontrada" });
          } catch (err) {
            return failure(err, [NewsError]);
          }
        },
      },
    ],
  };
}
