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
    return this.request("GET", pathAndQuery);
  }

  async request(method: "GET" | "POST" | "PUT", pathAndQuery: string, body?: unknown): Promise<any> {
    const res = await this.fetchImpl(`${API}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Jarvis-Ampliize",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 404) throw new GithubError("Não encontrado (ou o token não tem acesso a esse repositório).");
    if (res.status === 401) throw new GithubError("GITHUB_TOKEN inválido ou expirado.");
    if (res.status === 403 || res.status === 429) throw new GithubError("GitHub limitou as consultas ou o token não tem permissão (para o executor: Issues e Pull requests em Read and write).");
    if (res.status === 405 || res.status === 409) throw new GithubError(String(data?.message ?? "O GitHub não aceitou (PR com conflito ou checagens pendentes)."));
    if (!res.ok) throw new GithubError(`GitHub respondeu HTTP ${res.status}.`);
    return data;
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

/**
 * Executor: o Jarvis abre uma ORDEM DE SERVIÇO (issue com o rótulo "jarvis") e o Claude Code, rodando
 * no GitHub Actions do repositório, faz o trabalho e entrega um pull request. Nada vai ao ar sem o
 * dono aprovar o merge (APROVAR PR <número> no WhatsApp): a IA não tem ferramenta de merge.
 */
export const EXECUTOR_ROTULO = "jarvis";

export interface ExecutorConfig {
  repos: string[];
  maxPorDia: number;
}

const hojeBR = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Maceio" }).format(now);

export function executorConnector(cfg: GithubConfig, ex: ExecutorConfig, fetchImpl?: typeof fetch): Connector {
  const gh = new GithubClient(cfg, fetchImpl);
  const wrap = (fn: (args: Record<string, unknown>) => Promise<unknown>) => async (args: Record<string, unknown>) => {
    try {
      return toolResult(true, await fn(args));
    } catch (err) {
      return toolResult(false, { erro: err instanceof GithubError ? err.message : "falha ao falar com o GitHub" });
    }
  };
  const repoDoExecutor = (input: unknown) => {
    const repo = gh.repo(input);
    if (!ex.repos.includes(repo.toLowerCase())) throw new GithubError(`O executor só trabalha em: ${ex.repos.join(", ")}.`);
    return repo;
  };
  return {
    id: "executor",
    name: "Executor (Claude Code no GitHub)",
    description: `Faz qualquer trabalho de código, banco, automação, site ou landing page nos repositórios ${ex.repos.join(", ")}: você escreve a ordem de serviço e o Claude Code entrega um pull request.`,
    tools: [
      {
        name: "executor_ordem",
        description:
          "EXECUTOR: quando o pedido precisa de algo que você não tem ferramenta para fazer (criar ou mudar sistema, tela, função, automação, landing page, integração, relatório novo, corrigir bug), abra uma ordem de serviço. O Claude Code executa sozinho no GitHub e abre um pull request; o dono aprova o merge respondendo APROVAR PR <número>. Escreva a especificação completa: objetivo, contexto (o que você já leu do CRM/código), o que entregar, critérios de aceite e o que NÃO fazer. Uma ordem por assunto. Custa dinheiro por ordem: não abra para o que suas outras ferramentas já resolvem.",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: `Onde trabalhar: ${ex.repos.join(" ou ")} (CRM, site e funções = ampliize/ampliize; o próprio Jarvis = ampliize/jarviscentral).` },
            titulo: { type: "string", description: "Título curto da ordem (até 90 caracteres)." },
            especificacao: { type: "string", description: "Especificação completa em Markdown." },
          },
          required: ["repo", "titulo", "especificacao"],
          additionalProperties: false,
        },
        run: wrap(async (args) => {
          const repo = repoDoExecutor(args.repo);
          const titulo = String(args.titulo ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
          const spec = String(args.especificacao ?? "").trim().slice(0, 20_000);
          if (titulo.length < 5 || spec.length < 80) return { erro: "Título (5+) e especificação detalhada (80+ caracteres) são obrigatórios." };
          const hoje = hojeBR();
          const ja = await gh.get(`/search/issues?per_page=1&q=${encodeURIComponent(`repo:${repo} is:issue label:${EXECUTOR_ROTULO} created:>=${hoje}`)}`);
          if (Number(ja?.total_count ?? 0) >= ex.maxPorDia) {
            return { erro: `Limite de ${ex.maxPorDia} ordens por dia neste repositório atingido (EXECUTOR_MAX_DIA). Junte pedidos ou deixe para amanhã.` };
          }
          const corpo = `${spec}\n\n---\n_Ordem aberta pelo Jarvis em ${hoje}. Entregue em um pull request que feche esta issue. Não faça merge._`;
          const issue = await gh.request("POST", `/repos/${repo}/issues`, { title: titulo, body: corpo, labels: [EXECUTOR_ROTULO] });
          return {
            ordem: issue.number,
            url: issue.html_url,
            aviso: "Ordem aberta. O Claude Code começa em instantes e abre um pull request (leva de 5 a 30 minutos). Nada vai ao ar até o dono responder APROVAR PR <número do PR>. Não diga que está pronto.",
          };
        }),
      },
      {
        name: "executor_status",
        description: "Ordens de serviço do executor (abertas e recentes) e os pull requests que ele entregou, com estado (aberto, aguardando merge, merged).",
        parameters: { type: "object", properties: { repo: { type: "string", description: ex.repos.join(" ou ") } }, required: ["repo"], additionalProperties: false },
        run: wrap(async (args) => {
          const repo = repoDoExecutor(args.repo);
          const [issues, prs] = await Promise.all([
            gh.get(`/repos/${repo}/issues?labels=${EXECUTOR_ROTULO}&state=all&per_page=10&sort=updated`),
            gh.get(`/repos/${repo}/pulls?state=all&per_page=20&sort=updated&direction=desc`),
          ]);
          const doExecutor = (prs as any[]).filter((p) => /^claude\//.test(String(p.head?.ref ?? "")) || /\(#?\d+\)|closes #|fixes #|resolve #/i.test(String(p.body ?? "")));
          return {
            ordens: (issues as any[]).filter((i) => !i.pull_request).map((i) => ({ numero: i.number, titulo: i.title, estado: i.state, comentarios: i.comments, atualizado: i.updated_at })),
            prs: doExecutor.map((p) => ({ numero: p.number, titulo: p.title, estado: p.merged_at ? "merged" : p.state === "open" ? "aguardando APROVAR PR" : "fechado", url: p.html_url })),
          };
        }),
      },
    ],
  };
}

/** Merge pedido pelo DONO (APROVAR PR <n> no WhatsApp). Não é ferramenta da IA. */
export async function mesclarPr(cfg: GithubConfig, ex: ExecutorConfig, repoIn: string, numero: number, fetchImpl?: typeof fetch) {
  const gh = new GithubClient(cfg, fetchImpl);
  const repo = gh.repo(repoIn);
  if (!ex.repos.includes(repo.toLowerCase())) throw new GithubError(`Só faço merge em: ${ex.repos.join(", ")}.`);
  if (!Number.isInteger(numero) || numero <= 0) throw new GithubError("Número de PR inválido.");
  const pr = await gh.get(`/repos/${repo}/pulls/${numero}`);
  if (pr.merged_at) return { repo, numero, titulo: pr.title, estado: "já estava merged" };
  if (pr.state !== "open") throw new GithubError("Esse PR está fechado.");
  const r = await gh.request("PUT", `/repos/${repo}/pulls/${numero}/merge`, { merge_method: "squash", sha: pr.head?.sha });
  return { repo, numero, titulo: pr.title, estado: r?.merged ? "merged" : "não mesclado", url: pr.html_url };
}
