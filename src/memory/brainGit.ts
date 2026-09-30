import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BrainGitConfig } from "../config.js";

const exec = promisify(execFile);

/** Arquivos criados num vault novo (só os que ainda não existem). */
const SEED: Record<string, string> = {
  "README.md": `# Cérebro do Jarvis

Vault do Obsidian compartilhado entre você e o Jarvis (sincronizado por Git).

- \`clientes/\` — uma nota por cliente: combinados, preferências, histórico que não está no CRM
- \`decisoes/\` — decisões de negócio e o porquê (ex.: \`2026-09-decisoes-funis.md\`)
- \`processos/\` — como a Ampliize faz cada coisa
- \`reunioes/\` — anotações de reuniões (\`AAAA-MM-DD-cliente.md\`)
- \`inbox/\` — o Jarvis grava aqui o que você pedir para ele anotar. Revise e mova para a pasta certa.
- \`_jarvis/contexto.md\` — o que o Jarvis deve saber SEMPRE sobre você (vai em toda conversa)

Regras: o Jarvis lê tudo, mas só escreve na \`inbox/\`.
`,
  "_jarvis/contexto.md": `# Contexto permanente

<!--
Escreva abaixo o que o Jarvis deve saber em TODA conversa. Ex.:
- Quem você é, seus projetos e prioridades do trimestre
- Como gosta de receber respostas (curtas, com números, etc.)
- Pessoas-chave do time e o papel de cada uma
Tudo que estiver dentro deste comentário é ignorado.
-->
`,
  "clientes/.gitkeep": "",
  "decisoes/.gitkeep": "",
  "processos/.gitkeep": "",
  "reunioes/.gitkeep": "",
  "inbox/.gitkeep": "",
};

const parseAuthor = (author: string) => {
  const m = /^\s*(.+?)\s*<([^>]+)>\s*$/.exec(author);
  return m ? { name: m[1]!, email: m[2]! } : { name: author.trim() || "Jarvis", email: "jarvis@localhost" };
};

/**
 * Mantém DATA_DIR/brain como um clone Git do vault do Obsidian:
 * clona (ou cria a estrutura num repositório vazio), puxa de tempos em
 * tempos e envia as notas que o Jarvis grava na inbox.
 * O token vai só em memória (header HTTP), nunca no .git/config nem nos logs.
 */
export class BrainGit {
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  lastSync: { at: string; ok: boolean; message?: string } | null = null;

  constructor(
    private readonly root: string,
    private readonly cfg: BrainGitConfig,
  ) {}

  private secrets() {
    if (!this.cfg.token) return [];
    return [this.cfg.token, Buffer.from(`x-access-token:${this.cfg.token}`).toString("base64")];
  }

  private redact(text: string) {
    return this.secrets().reduce((acc, s) => acc.split(s).join("***"), text);
  }

  private baseArgs() {
    const { name, email } = parseAuthor(this.cfg.author);
    const args = ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "core.quotepath=false"];
    if (this.cfg.token) {
      const basic = Buffer.from(`x-access-token:${this.cfg.token}`).toString("base64");
      args.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
    }
    return args;
  }

  private async git(args: string[], cwd = this.root) {
    try {
      const { stdout } = await exec("git", [...this.baseArgs(), ...args], {
        cwd,
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(this.redact((e.stderr || e.message || "git falhou").trim()).slice(0, 500));
    }
  }

  /** Executa operações Git uma de cada vez. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async hasCommits(cwd = this.root) {
    try {
      await this.git(["rev-parse", "--verify", "HEAD"], cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** O vault já está clonado e pronto? */
  async isReady() {
    return fs.stat(path.join(this.root, ".git")).then(() => true, () => false);
  }

  /** Copia arquivos .md de `from` para `to` sem sobrescrever nada que já exista. */
  private async mergeMarkdown(from: string, to: string) {
    const entries = await fs.readdir(from, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(dst, { recursive: true });
        await this.mergeMarkdown(src, dst);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL).catch(() => undefined);
      }
    }
  }

  /**
   * Clona o vault (ou cria a estrutura num repositório vazio) e deixa tudo
   * sincronizado. O clone é feito numa pasta temporária: a memória atual só é
   * trocada depois que ele dá certo, e nenhuma nota local se perde.
   */
  setup() {
    return this.serial(async () => {
      if (await this.isReady()) {
        if (await this.hasCommits()) {
          await this.git(["pull", "--rebase", "--autostash", "origin", await this.git(["rev-parse", "--abbrev-ref", "HEAD"])]);
        }
      } else {
        const parent = path.dirname(this.root);
        const staging = `${this.root}.clone-${Date.now()}`;
        await fs.mkdir(parent, { recursive: true });
        try {
          await this.git(["clone", this.cfg.url, staging], parent);
          if (!(await this.hasCommits(staging))) await this.git(["symbolic-ref", "HEAD", "refs/heads/main"], staging);
          // Traz as notas que o Jarvis já tinha gravado localmente.
          await this.mergeMarkdown(this.root, staging);
          const backup = `${this.root}.local-${Date.now()}`;
          const hadLocal = await fs.stat(this.root).then(() => true, () => false);
          if (hadLocal) await fs.rename(this.root, backup);
          await fs.rename(staging, this.root);
          // Nota gravada durante a troca: mais uma passada para não perder nada.
          if (hadLocal) {
            await this.mergeMarkdown(backup, this.root);
            await fs.rm(backup, { recursive: true, force: true });
          }
        } finally {
          await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      for (const [rel, content] of Object.entries(SEED)) {
        const file = path.join(this.root, rel);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, { flag: "wx" }).catch(() => undefined);
      }
      await this.commitAndPushUnsafe("Jarvis: estrutura do cérebro");
      this.lastSync = { at: new Date().toISOString(), ok: true };
    });
  }

  private async commitAndPushUnsafe(message: string) {
    await this.git(["add", "-A"]);
    const staged = await this.git(["diff", "--cached", "--name-only"]);
    if (staged) await this.git(["commit", "-m", message]);
    if (!(await this.hasCommits())) return;
    const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    try {
      await this.git(["push", "-u", "origin", branch]);
    } catch {
      // Alguém editou pelo Obsidian ao mesmo tempo: integra e tenta de novo uma vez.
      await this.git(["pull", "--rebase", "--autostash", "origin", branch]);
      await this.git(["push", "-u", "origin", branch]);
    }
  }

  /** Grava e envia o que mudou (ex.: nota nova na inbox). */
  commitAndPush(message: string) {
    return this.serial(async () => {
      if (!(await this.isReady())) throw new Error("vault ainda não clonado; a nota fica no servidor e sobe na próxima sincronização");
      await this.commitAndPushUnsafe(message);
      this.lastSync = { at: new Date().toISOString(), ok: true };
    });
  }

  /** Traz o que você escreveu no Obsidian. */
  pull() {
    return this.serial(async () => {
      if (!(await this.isReady()) || !(await this.hasCommits())) return;
      const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
      await this.git(["pull", "--rebase", "--autostash", "origin", branch]);
      this.lastSync = { at: new Date().toISOString(), ok: true };
    });
  }

  /** Puxa periodicamente; falhas só vão para o log e para o status. */
  start(onError: (err: Error) => void = (e) => console.error("cérebro: sincronização falhou:", e.message)) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Sem clone ainda (ex.: token errado no primeiro start): tenta de novo.
      // Com clone: puxa o que veio do Obsidian e envia o que ficou pendente.
      this.isReady()
        .then((ready) => (ready ? this.pull().then(() => this.commitAndPush("Jarvis: sincronização")) : this.setup()))
        .catch((err: Error) => {
        this.lastSync = { at: new Date().toISOString(), ok: false, message: err.message };
        onError(err);
      });
    }, this.cfg.syncMinutes * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
