import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Senha de acesso do Jarvis. Se JARVIS_ACCESS_TOKEN não foi definida, gera
 * uma no primeiro start, guarda em DATA_DIR/.access-token (só o dono lê) e
 * mostra UMA vez nos logs do Easypanel. Nos starts seguintes reaproveita.
 */
export async function ensureAccessToken(dataDir: string, configured: string, log: (msg: string) => void = console.log) {
  if (configured) return { token: configured, generated: false };
  const file = path.join(dataDir, ".access-token");
  // Só gera uma nova se o arquivo não existir: qualquer outro erro de leitura
  // para a subida, para não trocar a senha que o dono já guardou.
  const saved = (
    await fs.readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw new Error(`Não consegui ler ${file}: ${err.message}`);
    })
  ).trim();
  if (saved.length >= 24) return { token: saved, generated: false };
  if (saved) throw new Error(`${file} está corrompido: apague o arquivo para gerar outra senha.`);

  const token = randomBytes(24).toString("base64url");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, `${token}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  log(
    [
      "",
      "================================================================",
      "  SENHA DE ACESSO DO JARVIS (gerada agora, guarde num lugar seguro)",
      `  ${token}`,
      `  Fica salva em ${file} (monte um volume em /data para não perder).`,
      "  Para usar outra, defina JARVIS_ACCESS_TOKEN.",
      "================================================================",
      "",
    ].join("\n"),
  );
  return { token, generated: true };
}
