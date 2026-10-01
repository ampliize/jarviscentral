import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp, safeLinks } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CreativeModel } from "../src/studio/claude.js";
import { framesFromImages, framesFromVideo, type Runner } from "../src/studio/frames.js";
import { safeDownload } from "../src/studio/net.js";
import { checkHtml, extractHtml } from "../src/studio/quality.js";
import { parseRssImages, pinterestRssUrl } from "../src/studio/references.js";
import type { Concept } from "../src/studio/studio.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };
const tmp = () => mkdtemp(path.join(os.tmpdir(), "jarvis-estudio-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pinterest: pasta vira feed RSS e os pins viram imagens grandes", () => {
  assert.equal(pinterestRssUrl("https://br.pinterest.com/davy/landing-imobiliaria/"), "https://www.pinterest.com/davy/landing-imobiliaria.rss");
  assert.equal(pinterestRssUrl("https://www.pinterest.com/davy/luxo?invite=1"), "https://www.pinterest.com/davy/luxo.rss");
  assert.equal(pinterestRssUrl("https://br.pinterest.com/pin/12345/"), null);
  assert.equal(pinterestRssUrl("https://evil.com/davy/x/"), null);
  const xml = `<rss><item><description>&lt;img src="https://i.pinimg.com/236x/aa/bb/cc.jpg"&gt;</description></item>
    <item><description><![CDATA[<img src="https://i.pinimg.com/236x/dd/ee/ff.png">]]></description></item>
    <item><description><img src="https://i.pinimg.com/236x/aa/bb/cc.jpg"></description></item></rss>`;
  assert.deepEqual(parseRssImages(xml), ["https://i.pinimg.com/736x/aa/bb/cc.jpg", "https://i.pinimg.com/736x/dd/ee/ff.png"]);
});

test("download seguro: só https público, checa cada redirecionamento e o tamanho", async () => {
  const lookup = async (host: string) => (host === "interno.com" ? ["10.0.0.5"] : ["93.184.216.34"]);
  const fetchImpl = (async (url: URL | string) => {
    const u = String(url);
    if (u.includes("/redir")) return new Response(null, { status: 302, headers: { location: "https://interno.com/x.png" } });
    if (u.includes("/grande")) return new Response(new Uint8Array(2000), { headers: { "content-type": "image/png" } });
    if (u.includes("/html")) return new Response("<html>", { headers: { "content-type": "text/html" } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const opts = { maxBytes: 1000, accept: /^image\// };
  assert.deepEqual([...(await safeDownload("https://ok.com/a.png", opts, { fetchImpl, lookup })).data], [1, 2, 3]);
  await assert.rejects(safeDownload("http://ok.com/a.png", opts, { fetchImpl, lookup }), /https/);
  await assert.rejects(safeDownload("https://interno.com/a.png", opts, { fetchImpl, lookup }), /interno/);
  await assert.rejects(safeDownload("https://ok.com/redir", opts, { fetchImpl, lookup }), /interno/);
  await assert.rejects(safeDownload("https://ok.com/grande", opts, { fetchImpl, lookup }), /grande/);
  await assert.rejects(safeDownload("https://ok.com/html", opts, { fetchImpl, lookup }), /tipo/);
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("frames: imagem vira aproximação e vídeo vira sequência (ffmpeg de verdade)", { skip: !hasFfmpeg && "sem ffmpeg" }, async () => {
  const dir = await tmp();
  const img = path.join(dir, "d.png");
  const imgM = path.join(dir, "m.png");
  const video = path.join(dir, "v.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360", "-frames:v", "1", img]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=360x640", "-frames:v", "1", imgM]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "2", "-pix_fmt", "yuv420p", video]);
  const pub = path.join(dir, "public");
  const a = await framesFromImages(img, imgM, pub, 12);
  assert.deepEqual([a.count, a.origem], [12, "imagem"]);
  const files = (await readdir(path.join(pub, "frames", "d"))).sort();
  assert.equal(files[0], "f_000.webp");
  assert.equal(files.at(-1), "f_011.webp");
  const b = await framesFromVideo(video, pub, 20);
  assert.equal(b.origem, "video");
  assert.ok(b.count >= 18 && b.count <= 20, `frames do vídeo: ${b.count}`);
  // Celular sai em 720x1280.
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(pub, "frames", "m", "f_000.webp")]).toString().trim();
  assert.equal(probe, "720,1280");
});

test("revisão automática: aponta o que falta e tira o HTML do bloco de código", () => {
  const frames = { count: 12, desktopUrl: "https://j.com/estudio/x/frames/d/", mobileUrl: "https://j.com/estudio/x/frames/m/" };
  const issues = checkHtml({ html: "<html><body><h1>Oi</h1>lorem ipsum [nome]</body></html>", frames, imageUrls: ["https://j.com/a.webp"] });
  for (const re of [/DOCTYPE/, /lang="pt-BR"/, /viewport/, /description/, /GSAP/, /reduced-motion/, /lorem/, /placeholder/, /canvas/, /12 frames/, /não foram usadas/]) {
    assert.ok(issues.some((i) => re.test(i)), `faltou apontar ${re}`);
  }
  assert.equal(extractHtml("Aqui está:\n```html\n<!DOCTYPE html>\n<html></html>\n```\nfim"), "<!DOCTYPE html>\n<html></html>");
});

/** HTML bom o bastante para passar na revisão automática. */
function goodHtml(manifest: string) {
  const urls = [...manifest.matchAll(/https?:\/\/\S+?\.webp|https?:\/\/\S+?\/frames\/[dm]\//g)].map((m) => m[0]);
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clínica Sorriso — Aracaju</title><meta name="description" content="Agende sua avaliação na Clínica Sorriso pelo WhatsApp em poucos minutos.">
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
<style>@media (prefers-reduced-motion: reduce){*{animation:none}}</style></head>
<body><h1>Seu sorriso, sem medo</h1><canvas id="seq"></canvas>
${urls.map((u) => `<img src="${u}" alt="Foto">`).join("\n")}
<script>gsap.registerPlugin(ScrollTrigger); const FRAMES = 12;</script>
${"<p>Texto da seção com conteúdo real da clínica.</p>\n".repeat(200)}
</body></html>`;
}

const concept: Concept = {
  titulo: "Clínica Sorriso",
  conceito: "Do medo ao sorriso confiante, contado no scroll.",
  analise_referencias: "Luz suave e tons claros das referências.",
  tom_de_voz: "acolhedor",
  identidade: { paleta: [{ nome: "Azul", hex: "#0A4DFF", uso: "CTA" }], fonte_titulos: "Playfair Display", fonte_texto: "Inter", estilo_visual: "clean" },
  sequencia: { cena: "câmera entra no consultório", prompt_desktop: "bright dental clinic", prompt_mobile: "bright dental clinic vertical", prompt_video: "slow dolly into a bright clinic" },
  imagens: [{ id: "Equipe 1!", uso: "equipe", prompt: "dentists smiling", formato: "paisagem" }],
  secoes: [{ nome: "Hero", objetivo: "atenção", textos: "Seu sorriso, sem medo", animacao: "pin + scrub dos frames" }],
  seo: { title: "Clínica Sorriso", description: "Agende sua avaliação" },
};

/** Claude, OpenAI, rede e ffmpeg falsos. */
function fakes() {
  const calls = { json: [] as unknown[], text: [] as string[] };
  const creative: CreativeModel = {
    json: async (opts) => {
      // Primeiro pedido: termos de busca das referências.
      if ((opts.schema as any).properties?.termos) return { termos: ["bright dental clinic", "smiling patient"] } as never;
      calls.json.push(opts.content);
      return structuredClone(concept) as never;
    },
    text: async (opts) => {
      const content = String(opts.content);
      calls.text.push(content);
      // Primeira versão sem meta description: a revisão pede a correção.
      const html = goodHtml(content);
      return calls.text.length === 1 ? "```html\n" + html.replace(/<meta name="description"[^>]*>/, "") + "\n```" : "```html\n" + html + "\n```";
    },
  };
  const runner: Runner = async (cmd, args) => {
    if (cmd === "ffprobe") return "4.0\n";
    const out = args.at(-1)!;
    await fs.mkdir(path.dirname(out), { recursive: true });
    for (let i = 0; i < 12; i++) await fs.writeFile(out.replace("%03d", String(i).padStart(3, "0")), "webp");
    return "";
  };
  const net = {
    lookup: async () => ["93.184.216.34"],
    fetchImpl: (async (url: URL | string) => {
      const u = String(url);
      if (u.endsWith(".rss")) return new Response(`<img src="https://i.pinimg.com/236x/a/b/c.jpg"><img src="https://i.pinimg.com/236x/d/e/f.jpg">`, { headers: { "content-type": "application/rss+xml" } });
      if (u.startsWith("https://api.openverse.org/v1/images/")) {
        const q = new URL(u).searchParams.get("q")!.replace(/\s+/g, "-");
        return Response.json({ results: [{ thumbnail: `https://api.openverse.org/thumb/${q}-1.jpg` }, { thumbnail: `https://api.openverse.org/thumb/${q}-2.jpg` }] });
      }
      return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch,
  };
  const image = async () => Buffer.from("RIFFwebp");
  return { creative, runner, net, image, calls };
}

async function waitDone(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, id: string) {
  for (let i = 0; i < 100; i++) {
    const t = ((await (await app.request(`/api/estudio/${id}`, { headers: auth })).json()) as any).trabalho;
    if (t.etapa === "pronto" || t.etapa === "erro") return t;
    await sleep(30);
  }
  throw new Error("estúdio não terminou");
}

test("estúdio: do briefing ao site pronto, com prévia isolada e prompt do Lovable", async () => {
  const dataDir = await tmp();
  const f = fakes();
  const app = await createApp({
    config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir, JARVIS_PUBLIC_URL: "https://jarvis.ampliize.com" }),
    fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    studioOptions: f,
  });
  assert.equal((await app.request("/api/estudio", { method: "POST" })).status, 401);
  const bad = await app.request("/api/estudio", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ nome: "" }) });
  assert.equal(bad.status, 400);

  const res = await app.request("/api/estudio", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ nome: "Clínica Sorriso", objetivo: "Agendamentos no WhatsApp", whatsapp: "(79) 99999-0000", pinterest: "https://br.pinterest.com/davy/clinica/", referencias: ["https://site.com/ref.jpg", "http://inseguro.com/x.jpg"] }),
  });
  assert.equal(res.status, 202);
  const { trabalho } = (await res.json()) as any;
  assert.match(trabalho.id, /^[a-f0-9]{24}$/);
  const t = await waitDone(app, trabalho.id);
  assert.equal(t.etapa, "pronto", t.erro);
  assert.equal(t.referencias, 7, "2 pins + 1 link https (o http é ignorado) + 4 pesquisadas no Openverse");
  assert.deepEqual(t.pesquisa, { termos: ["bright dental clinic", "smiling patient"], fontes: { openverse: 4 } });
  assert.equal(t.imagens, 3, "sequência desktop + celular + 1 da seção");
  assert.deepEqual(t.frames, { quantidade: 12, origem: "imagem" });
  assert.deepEqual(t.problemas_restantes, []);
  assert.equal(f.calls.text.length, 2, "código + uma correção da revisão");
  assert.equal(t.previa_url, `https://jarvis.ampliize.com/estudio/${t.id}/`);
  assert.match(t.lovable_prompt, /FIDELIDADE TOTAL/);
  assert.ok(t.lovable_prompt.includes(`https://jarvis.ampliize.com/estudio/${t.id}/frames/d/`));
  // O motor recebeu as 7 referências como imagem.
  const content = f.calls.json[0] as Array<{ type: string }>;
  assert.equal(content.filter((b) => b.type === "image").length, 7);
  // O código usa a URL da imagem da seção com id saneado.
  assert.ok(f.calls.text[0]!.includes(`/estudio/${t.id}/assets/equipe-1-.webp`));
  // Nota na inbox do vault.
  assert.match(t.nota, /^inbox\/.*site-clinica-sorriso\.md$/);

  // Prévia pública, isolada (sandbox) e liberada para outros domínios carregarem os frames.
  const page = await app.request(`/estudio/${t.id}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts/);
  assert.match(await page.text(), /<!DOCTYPE html>/);
  const frame = await app.request(`/estudio/${t.id}/frames/d/f_011.webp`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(frame.headers.get("content-type"), "image/webp");
  assert.match((await app.request(`/estudio/${t.id}/baixar`)).headers.get("content-disposition") ?? "", /attachment/);
  for (const p of [`/estudio/${t.id}/job.json`, `/estudio/${t.id}/..%2Fjob.json`, `/estudio/${t.id}/frames/d/../../../job.json`, `/estudio/nao-e-id/`]) {
    assert.equal((await app.request(p)).status, 404, p);
  }

  // Vídeo do Google Flow: refaz frames (do vídeo), código e revisão.
  const vid = await app.request(`/api/estudio/${t.id}/video`, { method: "POST", headers: { ...auth, "Content-Type": "video/mp4" }, body: new Uint8Array([0, 0, 0, 24]) });
  assert.equal(vid.status, 202);
  assert.equal((await app.request(`/api/estudio/${t.id}/video`, { method: "POST", headers: { ...auth, "Content-Type": "image/png" }, body: new Uint8Array([1]) })).status, 415);
  const t2 = await waitDone(app, t.id);
  assert.equal(t2.etapa, "pronto", t2.erro);
  assert.deepEqual(t2.frames, { quantidade: 12, origem: "video" });
  assert.equal(f.calls.json.length, 1, "o conceito não é refeito");

  // A ferramenta do chat devolve o link que o HUD acompanha.
  const connectors = (await (await app.request("/api/connectors", { headers: auth })).json()) as any[];
  assert.deepEqual(connectors.find((c) => c.id === "estudio").ferramentas, ["site_produzir", "estudio_status"]);
  assert.deepEqual(safeLinks([{ rotulo: "Acompanhar produção", url: `jarvis:estudio/${t.id}` }, { rotulo: "x", url: "jarvis:outra-coisa" }]).length, 1);
});

test("estúdio sem motor (sem OpenAI nem Claude) explica o que falta", async () => {
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: await tmp() }), fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });
  const res = await app.request("/api/estudio", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ nome: "X", objetivo: "Y" }) });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /OPENAI_API_KEY.*ANTHROPIC_API_KEY/);
});

test("revisão de código: origem só de requisição autenticada, etapa do erro e vídeo sem Content-Length", async () => {
  const dataDir = await tmp();
  const f = fakes();
  // Claude falha no código: o erro aponta a etapa certa.
  f.creative.text = async () => {
    throw new Error("Claude fora do ar");
  };
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir }), fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch, studioOptions: f });
  // Sem senha, o Host não muda o endereço dos sites.
  await app.request("/api/estudio", { headers: { host: "evil.example" } });
  await app.request("/", { headers: { host: "evil.example" } });
  const res = await app.request("/api/estudio", {
    method: "POST",
    headers: { ...auth, host: "jarvis.ampliize.com", "x-forwarded-proto": "https", "Content-Type": "application/json" },
    body: JSON.stringify({ nome: "Loja", objetivo: "Vendas" }),
  });
  const id = ((await res.json()) as any).trabalho.id;
  const t = await waitDone(app, id);
  assert.equal(t.etapa, "erro");
  assert.equal(t.passo, 4, "parou em 'Claude escrevendo o site'");
  assert.match(t.erro, /Escrevendo o site/);
  const job = JSON.parse(await fs.readFile(path.join(dataDir, "estudio", id, "job.json"), "utf8"));
  assert.equal(job.previa_url, `https://jarvis.ampliize.com/estudio/${id}/`);

  // Envio em pedaços sem Content-Length acima do limite: recusado sem ler tudo.
  let sent = 0;
  const big = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent > 101 * 1024 * 1024) return ctrl.close();
      sent += 4 * 1024 * 1024;
      ctrl.enqueue(new Uint8Array(4 * 1024 * 1024));
    },
  });
  const up = await app.request(`/api/estudio/${id}/video`, { method: "POST", headers: { ...auth, "Content-Type": "video/mp4" }, body: big, duplex: "half" } as RequestInit);
  assert.equal(up.status, 413);
  assert.ok(sent < 110 * 1024 * 1024);

  // Download de verdade (sem fetch injetado) bloqueia IP interno antes de conectar.
  await assert.rejects(safeDownload("https://127.0.0.1/x.png", { maxBytes: 10 }), /interno/);
});

test("pesquisa de referências: Pexels com chave, Openverse sem chave, sem repetir", async () => {
  const { searchImages, searchReferences } = await import("../src/studio/search.js");
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, auth: new Headers(init?.headers).get("authorization") });
    if (u.startsWith("https://api.pexels.com/")) return Response.json({ photos: [{ src: { large: "https://images.pexels.com/1.jpg" } }] });
    if (u.startsWith("https://api.openverse.org/")) return Response.json({ results: [{ thumbnail: "https://api.openverse.org/t/1" }, { thumbnail: "https://api.openverse.org/t/2" }] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const deps = { fetchImpl, lookup: async () => ["93.184.216.34"] };
  const r = await searchImages("luxury lot", 3, { pexels: "pk" }, deps);
  assert.deepEqual(r.hits.map((h) => h.fonte), ["pexels", "openverse", "openverse"]);
  assert.equal(seen.find((x) => x.url.includes("pexels"))!.auth, "pk");
  assert.equal(seen.find((x) => x.url.includes("openverse"))!.auth, null, "Openverse sem chave");
  const all = await searchReferences(["a", "b"], 4, {}, deps);
  assert.deepEqual(all.hits.map((h) => h.url), ["https://api.openverse.org/t/1", "https://api.openverse.org/t/2"], "sem repetir entre termos");
});

test("motor OpenAI: imagens viram data URL, JSON estruturado e erros claros", async () => {
  const { OpenAICreative, toOpenAIContent } = await import("../src/studio/openai-creative.js");
  assert.deepEqual(toOpenAIContent([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "oi" }]), [
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "low" } },
    { type: "text", text: "oi" },
  ]);
  let body: any = null;
  const ok = new OpenAICreative("sk-test", "gpt-4.1", "https://api.openai.com/v1", (async (_u: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: '{"termos":["a"]}' }, finish_reason: "stop" }] });
  }) as typeof fetch);
  const schema = { type: "object", properties: { termos: { type: "array", items: { type: "string" } } }, required: ["termos"], additionalProperties: false };
  assert.deepEqual(await ok.json({ system: "s", content: "c", schema }), { termos: ["a"] });
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.max_completion_tokens, 32000);
  const broke = new OpenAICreative("sk", "gpt-4.1", "https://api.openai.com/v1", (async () => Response.json({ error: { code: "insufficient_quota" } }, { status: 429 })) as typeof fetch);
  await assert.rejects(broke.text({ system: "s", content: "c" }), /sem créditos/);
  const cut = new OpenAICreative("sk", "gpt-4.1", "https://api.openai.com/v1", (async () => Response.json({ choices: [{ message: { content: "<html" }, finish_reason: "length" }] })) as typeof fetch);
  await assert.rejects(cut.text({ system: "s", content: "c" }), /tamanho máximo/);
});

test("sem Claude, o estúdio começa com a OpenAI (motor openai)", async () => {
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: await tmp(), OPENAI_API_KEY: "sk-test" }), fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });
  const res = await app.request("/api/estudio", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ nome: "X", objetivo: "Y" }) });
  assert.equal(res.status, 202);
  assert.equal(((await res.json()) as any).trabalho.motor, "openai");
});

test("download seguro: a chave da API não segue redirecionamento para outro domínio", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    if (String(url).startsWith("https://api.pexels.com/")) return new Response(null, { status: 302, headers: { location: "https://outro.com/x.json" } });
    return Response.json({ ok: true });
  }) as typeof fetch;
  await safeDownload("https://api.pexels.com/v1/search?q=a", { maxBytes: 1000, accept: /json/, headers: { Authorization: "segredo" } }, { fetchImpl, lookup: async () => ["93.184.216.34"] });
  assert.deepEqual(seen.map((x) => x.auth), ["segredo", null]);
});
