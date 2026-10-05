/**
 * Ações do agente de tráfego (Google Ads e Meta Ads).
 *
 * O agente só PROPÕE. Cada proposta vira uma ação normalizada, validada aqui
 * (limites, formato dos anúncios, teto de orçamento) e descrita em português
 * para o dono aprovar. Nada daqui chama as plataformas.
 */

export type Platform = "google" | "meta";
export const PLATFORMS: Platform[] = ["google", "meta"];

export type ActionType =
  | "criar_campanha_pesquisa"
  | "alterar_orcamento"
  | "pausar"
  | "ativar"
  | "adicionar_palavras_chave"
  | "adicionar_negativas";
export const ACTION_TYPES: ActionType[] = [
  "criar_campanha_pesquisa",
  "alterar_orcamento",
  "pausar",
  "ativar",
  "adicionar_palavras_chave",
  "adicionar_negativas",
];

/** Google: campanha, grupo, anuncio (id "grupo~anuncio"). Meta: campanha, conjunto, anuncio. */
export type Level = "campanha" | "grupo" | "conjunto" | "anuncio";
const LEVELS: Record<Platform, Level[]> = { google: ["campanha", "grupo", "anuncio"], meta: ["campanha", "conjunto", "anuncio"] };

export type MatchType = "ampla" | "frase" | "exata";
export const MATCH_TYPES: MatchType[] = ["ampla", "frase", "exata"];

export type Bidding = "maximizar_cliques" | "maximizar_conversoes" | "cpc_manual";
export const BIDDINGS: Bidding[] = ["maximizar_cliques", "maximizar_conversoes", "cpc_manual"];

export interface Keyword {
  texto: string;
  correspondencia: MatchType;
}

export interface SearchCampaign {
  nome: string;
  orcamento_dia: number;
  lance: Bidding;
  /** Só com cpc_manual: lance máximo por clique (R$). */
  cpc_max: number | null;
  /** Nomes das cidades/regiões, como o dono escreveu. */
  locais: string[];
  /** geoTargetConstants resolvidos na hora da proposta (Google). */
  locais_ids?: Array<{ nome: string; id: string }>;
  grupo: string;
  palavras_chave: Keyword[];
  negativas: Keyword[];
  anuncio: {
    titulos: string[];
    descricoes: string[];
    url_final: string;
    caminho1: string | null;
    caminho2: string | null;
  };
  /** false = a campanha nasce pausada (padrão). */
  iniciar_ativa: boolean;
}

export type Action =
  | { tipo: "criar_campanha_pesquisa"; plataforma: "google"; campanha: SearchCampaign }
  | { tipo: "alterar_orcamento"; plataforma: Platform; nivel: Level; id: string; nome?: string; antes?: number | null; novo_orcamento_dia: number }
  | { tipo: "pausar" | "ativar"; plataforma: Platform; nivel: Level; id: string; nome?: string; orcamento_dia?: number | null }
  | { tipo: "adicionar_palavras_chave"; plataforma: "google"; grupo_id: string; nome?: string; palavras: Keyword[] }
  | { tipo: "adicionar_negativas"; plataforma: "google"; campanha_id: string; nome?: string; palavras: Keyword[] };

export class ActionError extends Error {}

export interface Limits {
  /** Teto de orçamento diário por campanha/conjunto (R$), vale mesmo com aprovação. */
  maxDailyBudget: number;
}

const ID_RE = /^\d{1,20}$/;
const AD_ID_RE = /^\d{1,20}~\d{1,20}$/;
const s = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const money = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
export const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function budget(v: unknown, limits: Limits, label = "Orçamento diário"): number {
  const n = money(v);
  if (!(n >= 1)) throw new ActionError(`${label} inválido: informe em reais, a partir de R$ 1,00.`);
  if (n > limits.maxDailyBudget) {
    throw new ActionError(`${label} de ${brl(n)} passa do teto de ${brl(limits.maxDailyBudget)} por dia (TRAFEGO_ORCAMENTO_MAX_DIA).`);
  }
  return n;
}

function keywords(raw: unknown, max: number, label: string, required: boolean): Keyword[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Keyword[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const k = (item ?? {}) as Record<string, unknown>;
    const texto = s(typeof item === "string" ? item : k.texto, 80).toLowerCase();
    // Palavra-chave do Google: até 80 caracteres e 10 palavras, sem símbolos de operador.
    if (!texto || texto.split(" ").length > 10 || /[!@%^*()=<>,;"[\]{}|\\]/.test(texto)) continue;
    const correspondencia = MATCH_TYPES.includes(k.correspondencia as MatchType) ? (k.correspondencia as MatchType) : "frase";
    const key = `${correspondencia}:${texto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ texto, correspondencia });
  }
  if (required && !out.length) throw new ActionError(`Informe ao menos uma ${label} válida.`);
  if (out.length > max) throw new ActionError(`No máximo ${max} ${label}s por proposta.`);
  return out;
}

function texts(raw: unknown, min: number, max: number, maxLen: number, label: string): string[] {
  const list = (Array.isArray(raw) ? raw : []).map((t) => s(t, 200)).filter(Boolean);
  const long = list.find((t) => t.length > maxLen);
  if (long) throw new ActionError(`${label} com mais de ${maxLen} caracteres: "${long}".`);
  const unique = [...new Set(list)];
  if (unique.length < min || unique.length > max) throw new ActionError(`Informe de ${min} a ${max} ${label}s diferentes.`);
  return unique;
}

function level(p: Platform, v: unknown): Level {
  const l = v as Level;
  if (!LEVELS[p].includes(l)) throw new ActionError(`Nível inválido para ${p === "google" ? "o Google" : "o Meta"}: use ${LEVELS[p].join(", ")}.`);
  return l;
}

function objectId(p: Platform, l: Level, v: unknown): string {
  const id = s(v, 45);
  const ok = p === "google" && l === "anuncio" ? AD_ID_RE.test(id) : ID_RE.test(id);
  if (!ok) throw new ActionError(p === "google" && l === "anuncio" ? "Id do anúncio no formato grupo~anuncio (números)." : "Id inválido: use o número do item na plataforma.");
  return id;
}

function platform(v: unknown): Platform {
  if (!PLATFORMS.includes(v as Platform)) throw new ActionError("Plataforma inválida: google ou meta.");
  return v as Platform;
}

/** Valida e normaliza a ação proposta (lança ActionError explicando o que corrigir). */
export function parseAction(tipo: unknown, raw: Record<string, unknown>, limits: Limits): Action {
  switch (tipo) {
    case "criar_campanha_pesquisa": {
      const c = (raw.campanha ?? raw) as Record<string, unknown>;
      const nome = s(c.nome, 120);
      if (nome.length < 3) throw new ActionError("Dê um nome à campanha.");
      const lance = BIDDINGS.includes(c.lance as Bidding) ? (c.lance as Bidding) : "maximizar_cliques";
      const cpc = c.cpc_max == null ? null : money(c.cpc_max);
      if (lance === "cpc_manual" && !(cpc! > 0)) throw new ActionError("Com CPC manual, informe o lance máximo por clique (cpc_max).");
      const locais = (Array.isArray(c.locais) ? c.locais : []).map((l) => s(l, 80)).filter(Boolean).slice(0, 20);
      if (!locais.length) throw new ActionError("Informe onde os anúncios aparecem (cidades, estados ou Brasil).");
      const a = (c.anuncio ?? {}) as Record<string, unknown>;
      const url = s(a.url_final, 500);
      let host = "";
      try {
        const u = new URL(url);
        if (u.protocol === "https:") host = u.hostname;
      } catch {
        /* inválida */
      }
      if (!host) throw new ActionError("O anúncio precisa de uma URL final https:// (a página para onde o clique vai).");
      const path = (v: unknown) => {
        const p = s(v, 30).replace(/[\s/]+/g, "-");
        if (p.length > 15) throw new ActionError(`Caminho de URL com mais de 15 caracteres: "${p}".`);
        return p || null;
      };
      return {
        tipo: "criar_campanha_pesquisa",
        plataforma: "google",
        campanha: {
          nome,
          orcamento_dia: budget(c.orcamento_dia, limits),
          lance,
          cpc_max: lance === "cpc_manual" ? cpc : null,
          locais,
          grupo: s(c.grupo, 120) || `${nome} · grupo 1`,
          palavras_chave: keywords(c.palavras_chave, 80, "palavra-chave", true),
          negativas: keywords(c.negativas, 200, "palavra negativa", false),
          anuncio: {
            // Anúncio responsivo de pesquisa: 3 a 15 títulos (30) e 2 a 4 descrições (90).
            titulos: texts(a.titulos, 3, 15, 30, "título"),
            descricoes: texts(a.descricoes, 2, 4, 90, "descrição"),
            url_final: url,
            caminho1: path(a.caminho1),
            caminho2: path(a.caminho2),
          },
          iniciar_ativa: c.iniciar_ativa === true,
        },
      };
    }
    case "alterar_orcamento": {
      const p = platform(raw.plataforma);
      const nivel = level(p, raw.nivel ?? "campanha");
      if (nivel === "anuncio" || (p === "google" && nivel !== "campanha")) {
        throw new ActionError(p === "google" ? "No Google o orçamento é da campanha." : "No Meta o orçamento é da campanha ou do conjunto.");
      }
      return { tipo: "alterar_orcamento", plataforma: p, nivel, id: objectId(p, nivel, raw.id), novo_orcamento_dia: budget(raw.novo_orcamento_dia, limits, "Novo orçamento diário") };
    }
    case "pausar":
    case "ativar": {
      const p = platform(raw.plataforma);
      const nivel = level(p, raw.nivel ?? "campanha");
      return { tipo, plataforma: p, nivel, id: objectId(p, nivel, raw.id) };
    }
    case "adicionar_palavras_chave": {
      if (raw.plataforma && raw.plataforma !== "google") throw new ActionError("Palavras-chave só existem no Google.");
      return { tipo, plataforma: "google", grupo_id: objectId("google", "grupo", raw.grupo_id ?? raw.id), palavras: keywords(raw.palavras, 50, "palavra-chave", true) };
    }
    case "adicionar_negativas": {
      if (raw.plataforma && raw.plataforma !== "google") throw new ActionError("Palavras negativas só existem no Google.");
      return { tipo, plataforma: "google", campanha_id: objectId("google", "campanha", raw.campanha_id ?? raw.id), palavras: keywords(raw.palavras, 200, "palavra negativa", true) };
    }
    default:
      throw new ActionError(`Tipo de ação inválido: use ${ACTION_TYPES.join(", ")}.`);
  }
}

const LEVEL_LABEL: Record<Level, string> = { campanha: "campanha", grupo: "grupo de anúncios", conjunto: "conjunto de anúncios", anuncio: "anúncio" };
const PLATFORM_LABEL: Record<Platform, string> = { google: "Google Ads", meta: "Meta Ads" };
const MATCH_LABEL: Record<MatchType, string> = { ampla: "ampla", frase: "frase", exata: "exata" };
export const kw = (k: Keyword) => (k.correspondencia === "exata" ? `[${k.texto}]` : k.correspondencia === "frase" ? `"${k.texto}"` : k.texto);
const named = (nome: string | undefined, id: string) => (nome ? `"${nome}" (${id})` : id);

/** Uma linha para o dono decidir (WhatsApp e HUD). */
export function describeAction(a: Action): string {
  const where = PLATFORM_LABEL[a.plataforma];
  switch (a.tipo) {
    case "criar_campanha_pesquisa": {
      const c = a.campanha;
      return `${where}: criar a campanha de pesquisa "${c.nome}" com ${brl(c.orcamento_dia)}/dia em ${c.locais.join(", ")}, ${c.palavras_chave.length} palavras-chave, ${c.anuncio.titulos.length} títulos — ${c.iniciar_ativa ? "começa a rodar ao criar" : "criada PAUSADA"}`;
    }
    case "alterar_orcamento":
      return `${where}: orçamento da ${LEVEL_LABEL[a.nivel]} ${named(a.nome, a.id)} de ${a.antes != null ? brl(a.antes) : "?"} para ${brl(a.novo_orcamento_dia)} por dia`;
    case "pausar":
      return `${where}: pausar ${LEVEL_LABEL[a.nivel]} ${named(a.nome, a.id)}`;
    case "ativar":
      return `${where}: ativar ${LEVEL_LABEL[a.nivel]} ${named(a.nome, a.id)}${a.orcamento_dia != null ? ` (${brl(a.orcamento_dia)}/dia)` : ""}`;
    case "adicionar_palavras_chave":
      return `${where}: adicionar ${a.palavras.length} palavras-chave no grupo ${named(a.nome, a.grupo_id)}: ${a.palavras.slice(0, 8).map(kw).join(", ")}${a.palavras.length > 8 ? "…" : ""}`;
    case "adicionar_negativas":
      return `${where}: adicionar ${a.palavras.length} negativas na campanha ${named(a.nome, a.campanha_id)}: ${a.palavras.slice(0, 8).map(kw).join(", ")}${a.palavras.length > 8 ? "…" : ""}`;
  }
}

/** Quanto a ação pode aumentar o gasto por dia (R$); 0 quando só reduz ou não mexe em gasto. */
export function dailySpendIncrease(a: Action): number {
  if (a.tipo === "criar_campanha_pesquisa") return a.campanha.iniciar_ativa ? a.campanha.orcamento_dia : 0;
  if (a.tipo === "alterar_orcamento") return a.antes != null ? Math.max(0, a.novo_orcamento_dia - a.antes) : a.novo_orcamento_dia;
  if (a.tipo === "ativar") return a.orcamento_dia ?? 0;
  return 0;
}

export { MATCH_LABEL };

// ---------------------------------------------------------------- permissões do dono

/**
 * Autonomia que o dono concede: ações deste tipo, dentro destes limites,
 * rodam sem esperar aprovação (ele é avisado depois). Sem permissão, tudo
 * espera o "aprovar".
 */
export interface Grant {
  id: string;
  preset: string;
  titulo: string;
  tipos: ActionType[];
  plataforma: Platform | "todas";
  /** Orçamento: variação máxima em % sobre o atual (só reduz se 0). */
  max_variacao_pct: number | null;
  /** Orçamento diário máximo depois da ação (R$). */
  max_orcamento_dia: number | null;
  /** Ações automáticas por dia nesta permissão. */
  max_por_dia: number;
  criada_em: string;
  expira_em: string | null;
}

export interface GrantPreset {
  preset: string;
  titulo: string;
  explicacao: string;
  tipos: ActionType[];
  max_variacao_pct: number | null;
  /** true = usa o teto TRAFEGO_ORCAMENTO_MAX_DIA como limite de orçamento. */
  usa_teto: boolean;
  max_por_dia: number;
}

export const GRANT_PRESETS: GrantPreset[] = [
  {
    preset: "pausar",
    titulo: "Pausar o que está ruim",
    explicacao: "Pausar campanhas, grupos e anúncios sem me perguntar (pausar só reduz gasto).",
    tipos: ["pausar"],
    max_variacao_pct: null,
    usa_teto: false,
    max_por_dia: 10,
  },
  {
    preset: "negativas",
    titulo: "Negativar buscas ruins",
    explicacao: "Adicionar palavras negativas no Google sem me perguntar.",
    tipos: ["adicionar_negativas"],
    max_variacao_pct: null,
    usa_teto: false,
    max_por_dia: 10,
  },
  {
    preset: "orcamento20",
    titulo: "Ajustar orçamento até 20%",
    explicacao: "Subir ou baixar o orçamento diário em até 20% por vez, dentro do teto por campanha.",
    tipos: ["alterar_orcamento"],
    max_variacao_pct: 20,
    usa_teto: true,
    max_por_dia: 4,
  },
  {
    preset: "palavras",
    titulo: "Adicionar palavras-chave",
    explicacao: "Adicionar palavras-chave em grupos que já existem no Google.",
    tipos: ["adicionar_palavras_chave"],
    max_variacao_pct: null,
    usa_teto: false,
    max_por_dia: 5,
  },
];

export const presetById = (id: string) => GRANT_PRESETS.find((p) => p.preset === id) ?? null;

/** A permissão cobre esta ação? (null = cobre; texto = por que não cobre). */
export function grantBlocks(g: Grant, a: Action, now: Date): string | null {
  if (g.expira_em && Date.parse(g.expira_em) <= now.getTime()) return "permissão vencida";
  if (!g.tipos.includes(a.tipo)) return "tipo fora da permissão";
  if (g.plataforma !== "todas" && g.plataforma !== a.plataforma) return "plataforma fora da permissão";
  if (a.tipo === "alterar_orcamento") {
    if (a.antes == null || !(a.antes > 0)) return "orçamento atual desconhecido";
    const pct = (Math.abs(a.novo_orcamento_dia - a.antes) / a.antes) * 100;
    if (g.max_variacao_pct != null && pct > g.max_variacao_pct + 1e-9) return `variação de ${pct.toFixed(0)}% passa de ${g.max_variacao_pct}%`;
    if (g.max_orcamento_dia != null && a.novo_orcamento_dia > g.max_orcamento_dia) return `orçamento passa de ${brl(g.max_orcamento_dia)}`;
  }
  if (a.tipo === "ativar" || a.tipo === "criar_campanha_pesquisa") {
    const inc = dailySpendIncrease(a);
    if (g.max_orcamento_dia != null && inc > g.max_orcamento_dia) return `gasto de ${brl(inc)}/dia passa de ${brl(g.max_orcamento_dia)}`;
  }
  return null;
}
