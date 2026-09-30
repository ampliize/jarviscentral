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

## O que ele faz hoje (v0.1)

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
2. Respostas em streaming (SSE) e voz.
3. Briefing diário automático (agendado) e alertas proativos.
4. Memória sincronizada com o vault do Obsidian via git (`ampliize-brain`) e
   busca semântica.
5. Conectores dos outros projetos.
