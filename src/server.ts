import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApp({ config });

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  const conectores = [config.ampliize ? "ampliize" : null, ...config.projects.map((p) => p.id), "memoria"].filter(Boolean);
  console.log(`Jarvis no ar na porta ${info.port} · modelo ${config.openaiModel} · conectores: ${conectores.join(", ")}`);
});
