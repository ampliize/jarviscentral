import { toolResult, type Connector } from "./types.js";

/**
 * GitHub (somente leitura) para o modo técnico: o Jarvis lê o código dos
 * nossos sistemas para guiar o dono, explicar um erro ou planejar uma
 * mudança. O token (GITHUB_TOKEN) só é enviado para api.github.com e o
 * acesso fica limitado aos donos em GITHUB_OWNERS (padrão: ampliize).
 */
export interface GithubConfig {
  token: string;
  owners: string[];
}

const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_FILE_CHARS = 40_000;

export class GithubError extends Error {}

export class GithubClient {
  constructor(private readonly cfg: GithubConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  /** "dono/repo" permitido ou erro. Sem dono, usa o primeiro da lista. */
  repo(input: unknown): string {
    let repo = String(input ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (repo && !repo.includes("/")) repo = `${this.cfg.owners[0]}/${repo}`;
    if (!REPO_RE.test(repo) || repo.includes("..")) throw new GithubError("Repositório inválido. Use dono/nome.");
    const owner = repo.split("/")[0]!.toLowerCase();
    if (!this.cfg.owners.includes(owner)) throw new GithubError(`Só leio repositórios de: ${this.cfg.owners.join(", ")}.`);
    return repo;
  }

  async get(pathAndQuery: string): Promise<any> {
    const res = await this.fetchImpl(`${API}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Jarvis-Ampliize",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 404) throw new GithubError("Não encontrado (ou o token não tem acesso a esse repositório).");
    if (res.status === 401) throw new GithubError("GITHUB_TOKEN inválido ou expirado.");
    if (res.status === 403 || res.status === 429) throw new GithubError("GitHub limitou as consultas ou o token não tem permissão.");
    if (!res.ok) throw new GithubError(`GitHub respondeu HTTP ${res.status}.`);
    return body;
  }
}

const enc = (p: string) => p.split("/").filter((s) => s && s !== "." && s !== "..").map(encodeURIComponent).join("/");
const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function githubConnector(cfg: GithubConfig, fetchImpl?: typeof fetch): Connector {
  const gh = new GithubClient(cfg, fetchImpl);
  const wrap = (fn: (args: Record<string, unknown>) => Promise<unknown>) => async (args: Record<string, unknown>) => {
    try {
      return toolResult(true, await fn(args));
    } catch (err) {
      return toolResult(false, { erro: err instanceof GithubError ? err.message : "falha ao consultar o GitHub" });
    }
  };
  const repoParam = { type: "string", description: `Repositório "dono/nome" (ex.: ${cfg.owners[0]}/ampliize).` };
  return {
    id: "github",
    name: "GitHub (código dos sistemas)",
    description: `Leitura do código dos repositórios de ${cfg.owners.join(", ")}: arquivos, busca, PRs e commits. Somente leitura.`,
    tools: [
      {
        name: "github_repos",
        description: "Lista os repositórios que o Jarvis pode ler (nome, descrição, linguagem, último push).",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        run: wrap(async () => {
          const all = (await gh.get("/user/repos?per_page=100&sort=pushed")) as any[];
          return all
            .filter((r) => cfg.owners.includes(String(r.owner?.login ?? "").toLowerCase()))
            .map((r) => ({ repo: r.full_name, descricao: r.description, linguagem: r.language, privado: r.private, ultimo_push: r.pushed_at, branch_padrao: r.default_branch }));
        }),
      },
      {
        name: "github_arquivo",
        description: "Lê um arquivo do repositório (ou lista uma pasta). Use para entender o código antes de orientar uma mudança ou explicar um erro.",
        parameters: {
          type: "object",
          properties: {
            repo: repoParam,
            caminho: { type: "string", description: "Caminho do arquivo ou pasta ('' para a raiz)." },
            ref: { type: ["string", "null"], description: "Branch, tag ou commit (ou null para a branch padrão)." },
          },
          required: ["repo", "caminho", "ref"],
          additionalProperties: false,
        },
        run: wrap(async (args) => {
          const repo = gh.repo(args.repo);
          const ref = opt(args.ref);
          const data = await gh.get(`/repos/${repo}/contents/${enc(String(args.caminho ?? ""))}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
          if (Array.isArray(data)) return { pasta: args.caminho || "/", itens: data.map((f: any) => `${f.type === "dir" ? "📁" : "📄"} ${f.path}`) };
          if (data?.type !== "file") return { erro: "Não é um arquivo de texto." };
          const text = data.encoding === "base64" ? Buffer.from(String(data.content ?? ""), "base64").toString("utf8") : String(data.content ?? "");
          return { arquivo: data.path, tamanho: data.size, conteudo: text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n…(cortado)` : text };
        }),
      },
      {
        name: "github_buscar_codigo",
        description: "Busca um termo no código de um repositório (nome de função, tabela, texto de erro). Devolve os arquivos que contêm o termo.",
        parameters: {
          type: "object",
          properties: { repo: repoParam, termo: { type: "string", description: "O que procurar." } },
          required: ["repo", "termo"],
          additionalProperties: false,
        },
        run: wrap(async (args) => {
          const repo = gh.repo(args.repo);
          const termo = String(args.termo ?? "").replace(/["\n]/g, " ").trim().slice(0, 120);
          if (!termo) return { erro: "Diga o termo." };
          const data = await gh.get(`/search/code?per_page=20&q=${encodeURIComponent(`"${termo}" repo:${repo}`)}`);
          return { total: data.total_count, arquivos: (data.items ?? []).map((i: any) => i.path) };
        }),
      },
      {
        name: "github_atividade",
        description: "Pull requests (abertos ou recentes) e últimos commits de um repositório: o que mudou e quem mudou.",
        parameters: {
          type: "object",
          properties: { repo: repoParam, estado: { type: "string", enum: ["open", "closed", "all"], description: "PRs abertos, fechados ou todos." } },
          required: ["repo", "estado"],
          additionalProperties: false,
        },
        run: wrap(async (args) => {
          const repo = gh.repo(args.repo);
          const estado = ["open", "closed", "all"].includes(String(args.estado)) ? String(args.estado) : "open";
          const [prs, commits] = await Promise.all([
            gh.get(`/repos/${repo}/pulls?state=${estado}&per_page=15&sort=updated&direction=desc`),
            gh.get(`/repos/${repo}/commits?per_page=15`),
          ]);
          return {
            prs: (prs as any[]).map((p) => ({ numero: p.number, titulo: p.title, estado: p.merged_at ? "merged" : p.state, autor: p.user?.login, atualizado: p.updated_at, branch: p.head?.ref })),
            commits: (commits as any[]).map((c) => ({ sha: String(c.sha).slice(0, 7), mensagem: String(c.commit?.message ?? "").split("\n")[0], autor: c.commit?.author?.name, quando: c.commit?.author?.date })),
          };
        }),
      },
    ],
  };
}
