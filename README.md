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

## O que ele faz hoje (v0.5)

- **HUD com o camaleão da Ampliize** em `/`: um holograma do camaleão do logo
  que reage à voz (o maxilar abre quando ele fala, pisca, muda de cor quando
  está ouvindo ou pensando), respostas em cards, cards anteriores numa doca,
  legenda sincronizada com a fala e o painel "Pulso" com os números do dia.
- **Briefing do dia**: diga ou escreva "bom dia" (ou toque em BRIEFING). Ele
  lê o CRM e o cérebro e apresenta, card por card e falando: dinheiro
  (recebido no mês, cobranças vencidas e da semana, contas a pagar), entregas
  (tarefas atrasadas, vencendo e bloqueadas), comercial (leads novos,
  follow-ups) e as pendências de `pendencias.md` no vault. Os números saem
  direto dos dados, sem IA, então funciona mesmo sem a chave da OpenAI.
- **Chamar por "Jarvis"** (mãos livres): com a aba aberta no Chrome/Edge, diga
  "Jarvis, como está a operação?" ou só "Jarvis" e depois a pergunta.
- **Habilidades**: lembretes com aviso em voz na hora, clima (Open-Meteo) e
  notícias (Google Notícias), além do CRM e do cérebro. Lista completa em
  GERENCIAR HUD → Habilidades.
- **Skills da empresa**: os processos da Ampliize escritos em Markdown no vault
  (`_jarvis/skills/`). O Jarvis vê a lista em toda conversa e segue o passo a
  passo certo (cobrança, proposta, revisão semanal…).
- **Monitor de sistemas**: testa a cada 5 min os sistemas listados em
  `_jarvis/sistemas.md` (no ar, tempo de resposta, validade do HTTPS, 24 h de
  disponibilidade) e avisa no "bom dia".
- **Volume da voz** ajustável (até 3×, com compressor para não distorcer).
- **Chat** também pela API `POST /api/chat`.
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

## Rodar no Easypanel (uns 15 minutos)

Você só precisa de 3 coisas prontas: **um token do GitHub**, **a chave do
CRM** e **a sua chave da OpenAI**. O resto o Jarvis configura sozinho.

### 1. GitHub (uma vez)
1. Crie o repositório do cérebro: github.com/new → dono `ampliize` → nome
   **`ampliize-brain`** → **Private** → sem README → Create.
2. Crie **um** token que serve para tudo: GitHub → Settings → Developer
   settings → *Fine-grained tokens* → *Generate new token* →
   - Resource owner: `ampliize` · Expiration: 1 ano
   - Repository access: *Only select repositories* → **`jarviscentral`** e
     **`ampliize-brain`**
   - Permissions → Repository → **Contents: Read and write**
   - Gerar e copiar (começa com `github_pat_`).

### 2. CRM
Monitor → **Chaves de API** → nome `Jarvis` → **Gerar chave** → copiar.

### 3. Easypanel
1. **Settings → GitHub**: cole o token do passo 1 (é assim que o Easypanel
   lê o repositório privado).
2. **Create project** → nome `jarvis`.
3. No projeto: **+ Service → App** → nome `jarvis`.
4. **Source → GitHub**: Owner `ampliize` · Repository `jarviscentral` ·
   Branch `main` · Build path `/` → Save.
5. **Build → Dockerfile** (arquivo `Dockerfile`) → Save.
6. **Environment** → cole, trocando os `<...>`, e Save:
   ```
   OPENAI_API_KEY=<sua chave sk-...>
   AMPLIIZE_API_URL=https://eiqkinagduvfbiayiqtr.supabase.co/functions/v1/integration-api
   AMPLIIZE_API_KEY=<chave do CRM, passo 2>
   BRAIN_GIT_URL=https://github.com/ampliize/ampliize-brain.git
   BRAIN_GIT_TOKEN=<token do GitHub, passo 1>
   JARVIS_OWNER_NAME=Davy
   ```
7. **Mounts → Add Volume**: Name `data` · Mount path **`/data`** → Save.
8. **Domains**: o Easypanel já cria um endereço com HTTPS
   (`...easypanel.host`). Confira se aponta para a **porta 3000**. Se quiser
   um domínio próprio (ex.: `jarvis.ampliize.com`), adicione aqui e crie o
   registro `A` no DNS apontando para o IP da VPS.
9. **Deploy**. Abra **Logs**: vai aparecer a **SENHA DE ACESSO DO JARVIS**
   (só no primeiro start). Guarde num gerenciador de senhas.
10. Abra o domínio, digite a senha. A tela **configuração** mostra ✅/⚠️
    para OpenAI, CRM e Obsidian. Com tudo ✅, pergunte: *"Como está a
    operação hoje?"*

Atualizações: cada push na `main` → **Deploy** (ou ligue o *Auto Deploy*).

### 4. Obsidian no seu computador (depois que o Jarvis subiu)
O Jarvis já criou a estrutura no `ampliize-brain`. Agora ligue o seu Obsidian:
1. Instale o **Git** para Windows (git-scm.com → Download → next, next) e o
   **GitHub Desktop** (desktop.github.com), entrando com a conta `ampliize`.
2. GitHub Desktop → *File → Clone repository* → `ampliize/ampliize-brain` →
   escolha uma pasta (ex.: `Documentos\ampliize-brain`).
3. Obsidian → *Open folder as vault* → essa pasta.
4. Obsidian → Settings → Community plugins → *Turn on* → Browse → **Git**
   (de Vinzent) → Install → Enable. Nas opções do plugin:
   *Auto commit-and-sync interval* = **5** · *Auto pull interval* = **5** ·
   *Pull on startup* = **ligado**.
5. Abra **`_jarvis/contexto.md`** e escreva quem você é, suas prioridades e
   como quer as respostas. Em até 5 minutos o Jarvis passa a usar.

No Mac é igual (Git já vem com o Xcode Command Line Tools).

## Interface (HUD)

| Ação | Como |
|---|---|
| Briefing do dia | "bom dia", "boa tarde", "briefing" ou botão **BRIEFING** |
| Chamar por voz | "**Jarvis**, …" (liga/desliga em GERENCIAR HUD → Chamar por “Jarvis”) |
| Falar | botão do microfone ou tecla **espaço**; para sozinho quando você fica em silêncio |
| Interromper a fala | **Esc** (ou começar a falar de novo) |
| Rever um card | clique nele na doca (coluna à direita no PC, fileira embaixo no celular) |
| Voz, modo palmas, configuração, nova conversa, sair | **GERENCIAR HUD** |

O holograma é desenhado no navegador (canvas) a partir de `public/camaleao.png`,
a silhueta do camaleão do logo. Para trocar o desenho, substitua esse PNG
(fundo transparente, camaleão em branco) mantendo a proporção.

## Habilidades

| Habilidade | Exemplos | De onde vem |
|---|---|---|
| Briefing do dia | "bom dia", "briefing" | CRM + clima + lembretes + `pendencias.md` |
| CRM da Ampliize | "quem está com parcela vencida?", "como estão os projetos?" | integration-api (leitura) |
| Lembretes | "me lembra de cobrar a Ruddar amanhã às 9h", "quais meus lembretes?", "conclui o lembrete X" | `/data/lembretes.json` |
| Clima | "vai chover hoje?", "como está o tempo em Maceió?" | Open-Meteo (sem chave) |
| Notícias | "notícias de marketing digital", "o que saiu sobre Aracaju?" | Google Notícias RSS (sem chave) |
| Cérebro | "o que eu anotei sobre a Souza Gneri?", "anota que …" | vault do Obsidian |

O aviso dos lembretes aparece na HUD (card + bip + voz) com a aba aberta; se
ela estiver fechada, o lembrete avisa assim que você abrir e entra no card de
lembretes do "bom dia". A cidade padrão do clima é `JARVIS_CITY` (Aracaju).

**Chamar por "Jarvis"** vem desligado: no primeiro acesso aparece o card "Quer
me chamar pelo nome?" com o botão **Ativar** (ou ligue em GERENCIAR HUD). Usa o
reconhecimento de voz do próprio navegador (Chrome/Edge; o áudio passa pelo
serviço de voz do navegador enquanto a opção estiver ligada). Enquanto ele
fala, o reconhecimento pausa para não ouvir a própria voz. A pergunta feita
assim vai direto, sem passar pelo Whisper, então a resposta sai mais rápido.
A resposta em voz é gerada em pedaços: a primeira frase começa a tocar
enquanto o resto ainda está sendo gerado.

## Skills (processos da empresa)

Cada arquivo em `_jarvis/skills/` do vault é uma skill:

```markdown
---
nome: Cobrança de cliente
quando_usar: pedirem para cobrar alguém, ver quem está devendo ou preparar mensagem de cobrança
---
1. Veja as parcelas vencidas com ampliize_financeiro …
```

O nome e o "quando usar" vão para o prompt; quando o pedido combina, o Jarvis
chama `skill_abrir` e segue os passos com as ferramentas que tem. Editou no
Obsidian ou no GitHub, vale na próxima pergunta (cache de 30 s). As regras de
segurança do Jarvis continuam acima de qualquer skill.

## Monitor de sistemas

Uma linha por sistema em `_jarvis/sistemas.md`:

```markdown
- CRM da Ampliize | https://ampliize.lovable.app | Ampliize
- API do Reutiliize | https://xxxx.supabase.co/rest/v1/ | Reutiliize
```

- **ok**: respondeu (2xx/3xx, ou 401/403 de API que pede chave) em até 3 s e
  o HTTPS vence em mais de 14 dias.
- **atenção**: lento, respondeu 4xx ou o certificado vence em menos de 14 dias.
- **fora**: erro 5xx, sem resposta em 10 s, domínio não encontrado ou
  certificado vencido.

Só aceita `https://` de endereços públicos e não segue redirecionamentos
(endereços de rede interna são recusados). Pergunte "como estão os sistemas?"
ou veja o card no "bom dia".

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

O Jarvis e o seu Obsidian usam o **mesmo vault**, guardado no repositório Git
privado `ampliize-brain` (configuração nos passos 1 e 4 acima). Tudo são
arquivos `.md`, com histórico de cada mudança.

- `clientes/`, `decisoes/`, `processos/`, `reunioes/`: você escreve, o Jarvis lê
  e cita a nota quando usa.
- `inbox/`: quando você diz "anota que...", o Jarvis grava aqui e envia na
  hora. Revise e mova para a pasta certa.
- `_jarvis/contexto.md`: vai em toda conversa.

O Jarvis puxa o que você escreveu a cada 5 minutos (`BRAIN_SYNC_MINUTES`) e
nunca apaga nem reescreve notas suas. Se o primeiro clone falhar (ex.: token
errado), ele guarda as notas no servidor e tenta de novo a cada ciclo.
No celular: Android usa o mesmo plugin Git; no iPhone, o app *Working Copy*.

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
| GET | `/api/briefing` | Briefing do dia: `{ saudacao, abertura, cards[], fechamento, atencao, numeros }` |
| GET | `/api/lembretes` | Lembretes em aberto |
| GET | `/api/lembretes/avisos` | Lembretes que venceram (marca como avisados; a HUD chama a cada 30 s) |
| POST | `/api/lembretes/:id/concluir` | Conclui um lembrete |
| GET | `/api/sistemas` | Status dos sistemas monitorados (`?atualizar=1` testa agora) |
| GET | `/api/skills` | Skills (processos) disponíveis |
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
