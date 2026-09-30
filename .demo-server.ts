import { serve } from "@hono/node-server";
import { createApp } from "./src/app.js";
import { loadConfig } from "./src/config.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(os.tmpdir(), "jarvis-demo-"));
mkdirSync(path.join(dir, "brain", "inbox"), { recursive: true });
writeFileSync(path.join(dir, "brain", "pendencias.md"), "- [ ] Cobrar a **Ruddar**\n- [ ] Cadastrar Nova Esplanada\n");
const crm = { data_referencia: "2026-09-30",
  financeiro: { recebido_no_mes: 12880, vencidas: [{ cliente: "Ruddar", valor: 1500, vencimento: "2026-09-01" }], vencidas_total: 1, a_vencer_7_dias: [{ cliente: "Essencial Group", valor: 3000, vencimento: "2026-10-03" }], contas_a_pagar_7_dias: [] },
  tarefas: { atrasadas: [{ tarefa: "Conteúdos&Posts", projeto: "EssêncialGroup", responsavel: "Miguel", prazo: "2026-09-28T17:50:00+00:00" }], vencendo: [], bloqueadas: [] },
  comercial: { leads_novos_24h: { quantidade: 0, nomes: [] }, em_aberto: 89, follow_ups_atrasados: 0 }, sistema: { erros_abertos: 0 } };
const fetchImpl = (async (url: RequestInfo | URL) => String(url).startsWith("https://crm.demo") ? new Response(JSON.stringify({ resource: "briefing", data: crm })) : new Response("{}", { status: 500 })) as typeof fetch;
const config = loadConfig({ DATA_DIR: dir, JARVIS_ACCESS_TOKEN: "demo-token-demo-token-demo-token", AMPLIIZE_API_URL: "https://crm.demo/api", AMPLIIZE_API_KEY: "amp_x" });
const app = await createApp({ config, fetchImpl });
serve({ fetch: app.fetch, port: 3999 }, () => console.log("demo on 3999"));
