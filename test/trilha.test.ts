import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { musicType } from "../src/skills/music.js";

const TOKEN = "t".repeat(32);
const auth = { Authorization: `Bearer ${TOKEN}` };

test("trilha do briefing: envia, toca, troca o nome e remove", async () => {
  assert.equal(musicType("audio/mpeg"), "audio/mpeg");
  assert.equal(musicType("audio/x-m4a; codecs=aac"), "audio/mp4");
  assert.equal(musicType("text/html"), null);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jarvis-"));
  const app = await createApp({ config: loadConfig({ JARVIS_ACCESS_TOKEN: TOKEN, DATA_DIR: dataDir }), fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch });

  assert.equal((await app.request("/api/briefing/musica/info")).status, 401);
  assert.deepEqual(await (await app.request("/api/briefing/musica/info", { headers: auth })).json(), { musica: null });
  assert.equal((await app.request("/api/briefing/musica", { headers: auth })).status, 404);

  // Só áudio, com tamanho máximo.
  const bad = await app.request("/api/briefing/musica", { method: "POST", headers: { ...auth, "Content-Type": "text/html" }, body: "<script>" });
  assert.equal(bad.status, 415);
  const big = await app.request("/api/briefing/musica", { method: "POST", headers: { ...auth, "Content-Type": "audio/mpeg" }, body: new Uint8Array(15 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  const empty = await app.request("/api/briefing/musica", { method: "POST", headers: { ...auth, "Content-Type": "audio/mpeg" }, body: new Uint8Array(0) });
  assert.equal(empty.status, 400);

  const audio = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4]);
  const up = await app.request("/api/briefing/musica", {
    method: "POST",
    headers: { ...auth, "Content-Type": "audio/mpeg", "X-File-Name": encodeURIComponent("C:\\músicas\\abertura\u0007.mp3") },
    body: audio,
  });
  assert.equal(up.status, 200);
  const info = ((await up.json()) as any).musica;
  assert.equal(info.nome, "abertura.mp3");
  assert.equal(info.bytes, audio.byteLength);

  const got = await app.request("/api/briefing/musica", { headers: auth });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), audio);
  assert.equal(((await (await app.request("/api/briefing/musica/info", { headers: auth })).json()) as any).musica.nome, "abertura.mp3");
  // Não sobra arquivo temporário.
  assert.deepEqual((await readdir(path.join(dataDir, "media"))).sort(), ["briefing-musica", "briefing-musica.json"]);

  assert.equal((await app.request("/api/briefing/musica", { method: "DELETE", headers: auth })).status, 200);
  assert.equal((await app.request("/api/briefing/musica", { headers: auth })).status, 404);
  assert.equal((await app.request("/api/briefing/musica", { method: "DELETE" })).status, 401);
});
