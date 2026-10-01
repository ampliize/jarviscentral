import { toolResult, type Connector } from "../connectors/types.js";
import { STAGES, type Studio, StudioError, type StudioJob } from "./studio.js";

/** Resumo do trabalho para o modelo e para o HUD (sem caminhos internos). */
export function jobView(job: StudioJob) {
  // Em erro, o passo é o da última etapa que começou (onde parou).
  const at = job.etapa === "erro" ? [...job.historico].reverse().find((h) => STAGES.some((s) => s.id === h.etapa))?.etapa ?? job.etapa : job.etapa;
  return {
    id: job.id,
    nome: job.brief.nome,
    etapa: job.etapa,
    etapa_nome: job.etapa === "pronto" ? "Pronto" : job.etapa === "erro" ? "Erro" : job.etapa === "fila" ? "Na fila" : STAGES.find((s) => s.id === job.etapa)?.nome ?? job.etapa,
    passo: job.etapa === "pronto" ? STAGES.length : Math.max(0, STAGES.findIndex((s) => s.id === at)),
    total_passos: STAGES.length,
    criado_em: job.criado_em,
    atualizado_em: job.atualizado_em,
    referencias: job.referencias,
    imagens: job.imagens.length,
    frames: job.frames ? { quantidade: job.frames.count, origem: job.frames.origem } : null,
    conceito: job.conceito ? { titulo: job.conceito.titulo, ideia: job.conceito.conceito, secoes: job.conceito.secoes.map((s) => s.nome) } : null,
    prompt_video_flow: job.conceito?.sequencia.prompt_video ?? null,
    avisos: job.avisos.slice(-8),
    problemas_restantes: job.problemas_restantes,
    erro: job.erro,
    previa_url: job.etapa === "pronto" ? job.previa_url : null,
    download_url: job.etapa === "pronto" ? job.download_url : null,
    lovable_prompt: job.etapa === "pronto" ? job.lovable_prompt : null,
    nota: job.nota,
  };
}

export function studioConnector(studio: Studio, origin: () => string): Connector {
  return {
    id: "estudio",
    name: "Estúdio de sites (Jarvis + Claude)",
    description: "Produz a landing page inteira com o Claude: referências do Pinterest, conceito, imagens, frames do scroll, HTML com GSAP, revisão e prompt para o Lovable.",
    tools: [
      {
        name: "site_produzir",
        description:
          "Produz o site completo com animação de scroll, de verdade: baixa as referências (pasta do Pinterest e links), o Claude estrutura a ideia, gera as imagens, monta a sequência de frames, o Claude escreve o HTML com GSAP e revisa. Leva alguns minutos e roda em segundo plano; no fim entrega prévia, HTML e o prompt do Lovable. Use quando pedirem para CRIAR/FAZER/PRODUZIR um site ou landing page. Pergunte antes só o essencial (nome, objetivo); referências e estilo ajudam muito.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do site/negócio." },
            objetivo: { type: "string", description: "O que o site precisa gerar (ex.: leads de lotes no WhatsApp)." },
            publico: { type: ["string", "null"], description: "Público (ou null)." },
            cliente: { type: ["string", "null"], description: "Cliente da Ampliize (ou null se for da Ampliize)." },
            estilo: { type: ["string", "null"], description: "Estilo, cores, sensação (ou null)." },
            secoes: { type: ["string", "null"], description: "Conteúdos/seções que o dono pediu (ou null)." },
            whatsapp: { type: ["string", "null"], description: "Número do WhatsApp dos botões (ou null)." },
            pinterest: { type: ["string", "null"], description: "Link de uma pasta pública do Pinterest com as referências (ou null)." },
            referencias: { type: "array", items: { type: "string" }, description: "Links https de imagens de referência (pode ser vazio)." },
          },
          required: ["nome", "objetivo", "publico", "cliente", "estilo", "secoes", "whatsapp", "pinterest", "referencias"],
          additionalProperties: false,
        },
        run: async (args) => {
          try {
            const job = await studio.start(args as Record<string, never>, origin());
            return {
              ...toolResult(true, {
                ...jobView(job),
                observacao: "A produção começou em segundo plano (alguns minutos). Diga isso em uma frase; o HUD mostra o andamento e avisa quando ficar pronto. Não diga que o site já está pronto.",
              }),
              links: [{ rotulo: "Acompanhar produção", url: `jarvis:estudio/${job.id}` }],
            };
          } catch (err) {
            return toolResult(false, { erro: err instanceof StudioError ? err.message : "não consegui começar a produção" });
          }
        },
      },
      {
        name: "estudio_status",
        description: "Andamento dos sites em produção no estúdio (ou de um específico): etapa, avisos, prévia e prompt do Lovable quando pronto.",
        parameters: {
          type: "object",
          properties: { id: { type: ["string", "null"], description: "Id do trabalho (ou null para os últimos)." } },
          required: ["id"],
          additionalProperties: false,
        },
        run: async (args) => {
          if (typeof args.id === "string" && args.id) {
            const job = await studio.get(args.id);
            return job ? toolResult(true, jobView(job)) : toolResult(false, { erro: "trabalho não encontrado" });
          }
          const list = await studio.list(5);
          return toolResult(true, list.length ? list.map(jobView) : { resultado: "nenhum site produzido ainda" });
        },
      },
    ],
  };
}
