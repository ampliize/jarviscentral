# Jarvis

Assistente de IA pessoal do Davy e da Ampliize. Roda como um **serviço
separado** (VPS com Easypanel) e conversa por **API** com o CRM da Ampliize
e com outros projetos. Não guarda cópia dos dados dos projetos: pergunta a
cada um, na hora, pelo endpoint de integração deles.

```
                ┌──────────────────────── VPS (Easypanel) ───────────────────────┐
 Você ──HTTPS──▶│  Jarvis (este repositório, Docker)                             │
 (web / app)    │   ├─ /api/chat ──▶ OpenAI (tool calling)                        │
                │   ├─ conectores ─┬─▶ Ampliize CRM  (integration-api, leitura) │
                │   │              └─▶ outros projetos (mesmo contrato)          │
                │   └─ /data (volume): memória em Markdown + histórico           │
                └────────────────────────────────────────────────────────────────┘
```

## O que ele faz hoje (v0.2)

- **Chat** em `/` (interface provisória, será trocada pelo frontend definitivo)
  e na API `POST /api/chat`.
- **Ampliize CRM** (somente leitura): panorama da operação, clientes, ficha
  360º de um cliente, projetos, linha do tempo de atualizações, melhorias de
  processo (falhas e acertos), financeiro do mês, funil comercial e erros do
  sistema.
- **Outros projetos**: qualquer sistema que exponha o mesmo contrato de
  integração entra só com configuração (`JARVIS_PROJECTS`).
- **Memória** em Markdown (compatível com Obsidian) em `/data/brain`. O
  Jarvis busca nas notas e, quando você pede para anotar algo, grava uma
  proposta em `brain/inbox/` para você revisar.
- **Histórico** das conversas em `/data/conversations` (um arquivo por conversa).
- **Voz**: botão de microfone (para sozinho quando você fica em silêncio),
  resposta falada e **modo palmas** (duas palmas e ele começa a ouvir). O
  áudio vira texto e a resposta vira voz pela API da OpenAI; o microfone e o
  alto-falante são os do seu aparelho (PC ou celular).
- **Cérebro no Obsidian**: a memória é um vault Git privado. Você escreve no
  Obsidian, o Jarvis lê; o que você pede para ele anotar cai na `inbox/` do
  vault. O arquivo `_jarvis/contexto.md` vai em toda conversa.
- **Modelo local opcional**: aponte `OPENAI_BASE_URL` para um Ollama.

Regras de segurança do assistente: fatos só vêm das ferramentas (nada
inventado), resultados de ferramentas são tratados como dados e não como
instruções, e ele não altera nada nos projetos (só lê).

## Rodar no Easypanel

1. **Chave do CRM**: no CRM da Ampliize, entre como proprietário → aba
   **Monitor** → **Chaves de API** → nome "Jarvis" → **Gerar chave**. Copie a
   chave (ela aparece uma única vez).
2. **Senha do Jarvis**: gere uma senha longa, por exemplo com
   `openssl rand -hex 24`, ou use um gerador de senhas com 40+ caracteres.
3. No Easypanel: **Create → App** (no projeto que preferir) → nome `jarvis`.
4. **Source → GitHub**: repositório `ampliize/jarviscentral`, branch `main`.
   **Build → Dockerfile** (caminho `Dockerfile`).
5. **Environment** — cole e preencha:
   ```
   JARVIS_ACCESS_TOKEN=<senha do passo 2>
   OPENAI_API_KEY=<sua chave da OpenAI>
   OPENAI_MODEL=gpt-4.1
   AMPLIIZE_API_URL=https://eiqkinagduvfbiayiqtr.supabase.co/functions/v1/integration-api
   AMPLIIZE_API_KEY=<chave do passo 1>
   JARVIS_OWNER_NAME=Davy
   ```
6. **Mounts → Volume**: nome `jarvis-data`, caminho **`/data`**. Sem isso a
   memória e o histórico somem a cada deploy.
7. **Domains**: adicione um domínio (ex.: `jarvis.ampliize.com`) apontando
   para a porta **3000** com HTTPS ligado. No seu DNS, crie o registro `A`
   (ou `CNAME`) desse subdomínio para o IP da VPS.
8. **Deploy**. Em **Logs** deve aparecer `Jarvis no ar na porta 3000 ...
   conectores: ampliize, memoria`. Abra o domínio, digite a senha e pergunte:
   *"Como está a operação hoje?"*.

Para atualizar: cada push na `main` → **Deploy** no Easypanel (ou ligue o
auto-deploy do GitHub no próprio app).

## Voz

1. Abra o Jarvis pelo domínio com **HTTPS** (o navegador só libera o
   microfone em HTTPS).
2. Toque no 🎙, fale, e fique em silêncio: ele envia sozinho e responde
   falando. Marque **falar respostas** para ouvir também as respostas às
   perguntas digitadas.
3. **Modo palmas**: marque, permita o microfone e bata duas palmas. Ajuste
   **sens.** se disparar sozinho (arraste para a direita) ou não pegar (para
   a esquerda). Funciona com a aba aberta; no celular, com a tela ligada.

Voz padrão: `onyx` (grave). Troque em `OPENAI_TTS_VOICE` (alloy, echo, fable,
nova, shimmer). Para mais naturalidade: `OPENAI_TTS_MODEL=gpt-4o-mini-tts`
e `OPENAI_STT_MODEL=gpt-4o-mini-transcribe`. Custo típico: centavos por
conversa. Se a voz da OpenAI falhar, a interface usa a voz do próprio aparelho.

## Cérebro no Obsidian (memória blindada)

O Jarvis e o seu Obsidian usam o **mesmo vault**, guardado num repositório
Git privado. Tudo são arquivos `.md`: você lê, edita e tem histórico de tudo.

1. **Crie o repositório** vazio e privado no GitHub: `ampliize/ampliize-brain`
   (sem README).
2. **Crie um token** só para ele: GitHub → Settings → Developer settings →
   *Fine-grained tokens* → *Generate new token* → Repository access: *Only
   select repositories* → `ampliize-brain` → Permissions → **Contents: Read
   and write** → gerar e copiar.
3. **No Easypanel** (Environment do Jarvis):
   ```
   BRAIN_GIT_URL=https://github.com/ampliize/ampliize-brain.git
   BRAIN_GIT_TOKEN=<token do passo 2>
   ```
   Deploy. No primeiro start o Jarvis cria a estrutura do vault
   (`clientes/`, `decisoes/`, `processos/`, `reunioes/`, `inbox/`,
   `_jarvis/contexto.md`) e envia para o repositório. Notas que ele já tinha
   gravado antes vão junto para a `inbox/`.
4. **No computador**: clone o repositório (GitHub Desktop → *Clone* →
   `ampliize-brain`) e, no Obsidian, *Open folder as vault* nessa pasta.
5. **Plugin Git no Obsidian**: Settings → Community plugins → procure **Git**
   (de Vinzent) → instale e ative → nas opções: *Pull on startup* ligado,
   *Auto pull interval* = 5 e *Auto commit-and-sync interval* = 5.
6. **Celular**: no Android o mesmo plugin funciona. No iPhone, use o app
   *Working Copy* para clonar o repositório e abra a pasta no Obsidian.
7. Escreva em **`_jarvis/contexto.md`** quem você é, suas prioridades e como
   gosta das respostas. Vai em toda conversa.

Como ele usa: busca nas notas quando a pergunta pede contexto
(`memoria_buscar`), cita a nota usada e, quando você pede "anota que...",
grava em `inbox/` e envia na hora. O Jarvis puxa o que você escreveu a cada
5 minutos (`BRAIN_SYNC_MINUTES`) e pode ser forçado em `POST /api/brain/sync`.
Ele nunca apaga nem reescreve notas suas.

## Modelo local (opcional)

Como no guia do OpenJarvis, dá para rodar o modelo de graça com o Ollama:
suba um serviço Ollama no Easypanel (ou num PC com placa de vídeo), baixe
o modelo (`ollama pull gemma4:e4b`) e configure:

```
OPENAI_BASE_URL=http://ollama:11434/v1
OPENAI_MODEL=gemma4:e4b
```

Se o endpoint pedir chave, use `LLM_API_KEY`. A `OPENAI_API_KEY` nunca é
enviada para um endpoint que não seja o da OpenAI.

Atenção: modelos locais pequenos usam as ferramentas do CRM com menos
precisão que o `gpt-4.1`, e uma VPS sem GPU responde devagar. A voz continua
pela OpenAI (`OPENAI_VOICE_API_KEY`, ou a própria `OPENAI_API_KEY`).

## Conectar outro projeto

O projeto precisa expor um endpoint no mesmo contrato do CRM:

```
POST <url>
x-api-key: <chave>
{ "resource": "<nome>", "params": { ... } }   →   { "resource": "...", "data": ... }
```

e responder `resource: "resources"` com a lista do que dá para consultar.
Depois é só acrescentar em `JARVIS_PROJECTS` (JSON):

```
JARVIS_PROJECTS=[{"id":"bateponto","name":"Bate-ponto","url":"https://.../integration-api","key":"...","description":"Controle de ponto da equipe"}]
```

O modelo ganha as ferramentas `bateponto_recursos` e `bateponto_consultar`.
A edge function `integration-api` do CRM da Ampliize serve de modelo.

## API

Todas as rotas `/api/*` exigem `Authorization: Bearer <JARVIS_ACCESS_TOKEN>`.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/health` | Saúde do serviço (público) |
| POST | `/api/chat` | `{ message, conversationId? }` → `{ conversationId, answer, tools, usage, model }` |
| GET | `/api/conversations` | Conversas recentes |
| GET | `/api/conversations/:id` | Mensagens de uma conversa |
| GET | `/api/connectors` | Projetos conectados e ferramentas |
| GET | `/api/status` | Modelo, voz e estado do cérebro (Obsidian) |
| POST | `/api/voice/transcribe` | Corpo = áudio (webm/ogg/mp4/m4a/mp3/wav, até 10 MB) → `{ text }` |
| POST | `/api/voice/speak` | `{ text }` → `audio/mpeg` |
| POST | `/api/brain/sync` | Puxa agora o que mudou no vault |

Para um frontend em outro domínio, libere a origem em `JARVIS_CORS_ORIGINS`.

## Desenvolvimento

```bash
cp .env.example .env   # preencha
npm install
npm run dev            # http://localhost:3000
npm test               # testes com OpenAI e CRM simulados
npm run typecheck
```

## Próximos passos

1. Frontend definitivo do Jarvis (a partir dos repositórios de referência).
2. Respostas em streaming (SSE) e voz em tempo real.
3. Briefing diário automático (agendado) e alertas proativos.
4. Busca semântica no vault (embeddings).
5. Conectores dos outros projetos.

Comparação com o OpenJarvis (guia do @marcondes.ai) em
[docs/openjarvis.md](docs/openjarvis.md).
