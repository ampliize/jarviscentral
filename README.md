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

## O que ele faz hoje (v0.7)

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
- **Música do Jarvis**: quando você fala com ele, a trilha entra (cheia enquanto ele pensa), fica baixinha enquanto ele responde e some quando ele termina; no briefing ela abre em volume cheio. Diga "desliga a música" para parar, "pode tocar a música" para voltar, ou "... sem música" para uma resposta só. Em GERENCIAR HUD → *Escolher música* você envia o seu arquivo (mp3, m4a, ogg ou wav, até 15 MB; fica no volume `/data`). Sem arquivo, toca uma vinheta própria. Dá para desligar ou mudar o volume ali.
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
| Rever um card | no PC, clique na linha dele em **Jarvis · Canal ativo**; no celular, na doca embaixo |
| Segunda tela (outro monitor) | botão **TELAS** (canto inferior esquerdo) ou abra `/?tela=1` |
| Ligar/desligar voz e música | ícones do canto inferior direito (ou GERENCIAR HUD) |
| Voz, modo palmas, configuração, nova conversa, sair | **GERENCIAR HUD** |

### Jarvis gerente: missões delegadas e relatórios

Você delega uma responsabilidade e o Jarvis executa sozinho no horário, sem precisar ser cobrado. No fim ele entrega um relatório com:
- resumo e achados;
- **ordens para o time** (pessoas e agentes, com prazo);
- **o que precisa de você**;
- os entregáveis (calendário de posts, roteiros, mensagens em rascunho).

| Como | O que acontece |
|---|---|
| "a partir de agora, toda segunda às 7h você planeja os posts dos clientes" | O Jarvis prepara a missão e mostra o card com **Ativar**. Missão criada pela conversa só roda depois do seu toque (proteção contra instrução vinda dos dados). |
| GERENCIAR HUD → **Missões** → **Ativar pacote do gerente** | Cinco missões prontas, ativadas pelo seu toque: rotina do gerente (dias úteis 07:45), plano de conteúdo da semana (segunda 07:00), founder-led growth do Davy (domingo 18:00), projeto agentes de IA e funil (quarta 09:00) e revisão da semana (sexta 17:00) |
| "minhas missões" · "relatórios" | Lista com próxima execução, resultado da última e botões Executar, Pausar e Abrir |
| Briefing da manhã | Card **Relatórios novos**, com o que pede a sua decisão |

**Como uma missão é executada:**
- Em missão o Jarvis só **lê**: CRM, cérebro, notícias e rascunhos dos agentes.
- Ficam de fora tudo o que cria, anota, publica ou consulta o GitHub.
- Ele escreve o relatório no HUD e no Obsidian, em `relatorios/AAAA-MM/`.
- Nada é enviado a cliente. As ordens para os agentes (SDR, Closer, Conteúdo) ficam no relatório e o time executa no CRM, onde o agente gera o rascunho e uma pessoa envia.

**Manual da operação:** o Jarvis lê `_jarvis/operacao.md` (quem faz o quê, ritmo da semana, conteúdo dos clientes, regras) e `_jarvis/plano-agentes.md` (o roadmap dos agentes e do funil). Edite essas notas para mudar como ele gerencia.

**Custo:** cada execução usa a IA (OpenAI). O teto diário é `JARVIS_MISSOES_MAX_DIA`, com padrão de 12. Ele fica gravado e vale mesmo depois de reiniciar o servidor. Missão vencida sem orçamento roda no dia seguinte, às 06:00.

### WhatsApp: lead respondeu, o Jarvis avisa

O envio e o recebimento ficam no CRM (Evolution API, sem n8n; guia em `docs/agentes/WHATSAPP-EVOLUTION.md` no repositório do CRM). O Jarvis só lê o recurso `whatsapp_inbox` da integration-api, sem telefone:
- quando um lead responde e está esperando resposta nossa, o HUD mostra o card, apita e avisa por voz (checa a cada minuto);
- a rotina do gerente transforma cada lead esperando em ordem de responder no mesmo dia, com o próximo passo para fechar;
- a missão de agentes e funil mede a taxa de resposta;
- no chat: "quem respondeu no WhatsApp?" usa `ampliize_whatsapp_conversas`.
- reunião marcada pelo atendente de IA do WhatsApp: "quem marcou reunião?" / "me prepara para a reunião" usa `ampliize_reunioes_agendadas` (com o dossiê do lead), e o aviso chega no seu WhatsApp pelo fluxo de avisos.

O texto do lead é tratado como dado, nunca como instrução. O envio é sempre feito por uma pessoa na Fila SDR do CRM.

### WhatsApp do Jarvis (n8n + Evolution)

Você conversa com o Jarvis pelo WhatsApp: texto ou áudio, delegar missões e receber relatórios. Fica em dois fluxos no n8n, que chamam a API do Jarvis:

| Fluxo no n8n | O que faz |
|---|---|
| **Jarvis · WhatsApp (entrada)** | Instância `jarvis` da Evolution → webhook. Só o seu número é atendido e a resposta sempre volta para ele. Áudio vira texto (Whisper). `ATIVAR m_xxxxxxxxxxxx` ativa uma missão sem passar pela IA. `nova conversa` zera o contexto. O resto vai para `/api/chat`. |
| **Jarvis · WhatsApp (avisos)** | A cada 5 minutos, das 7h às 22h: relatórios das missões (`/api/relatorios/avisos`) leads que responderam no WhatsApp da Ampliize (`/api/whatsapp/avisos`) e reuniões marcadas pelo atendente de IA, com o dossiê (`/api/reunioes/avisos`). |

Para ligar:
1. Evolution: crie a instância `jarvis`, conecte o número do Jarvis pelo QR e aponte o webhook para a URL de produção do fluxo de entrada (evento `MESSAGES_UPSERT`, Base64 ligado).
2. n8n: preencha o nó **Configuração** dos dois fluxos (seu número, endereço do Jarvis e da Evolution).
3. n8n: crie as credenciais **Jarvis · token de acesso** (Bearer com o `JARVIS_ACCESS_TOKEN`) e **Evolution API · apikey** (Header Auth, nome `apikey`).
4. Ative os dois fluxos.

### Painéis do CRM: agenda, financeiro e comercial

Tudo vem do CRM da Ampliize (recursos `agenda`, `finance_history` e `sales_history` da integration-api). O Jarvis não guarda nem estima número.

| Comando | O que abre |
|---|---|
| "minha agenda" · "abre a agenda" | Próximos 7 dias: reuniões (agendamentos do CRM), prazos de tarefas, cobranças, contas a pagar e follow-ups, com a próxima reunião em destaque e botão **Entrar** quando tem link |
| "abre meu painel financeiro" | 12 meses por competência (recebido × custos pagos) + os 2 próximos meses já lançados (hachurados, "previsto"), receita recorrente, a receber, vencido e resultado |
| "mostra o painel comercial" | 6 meses de leads novos e de ganhos × perdidos, funil aberto e conversão |

Perguntas como "o que tenho amanhã?" ou "quando é minha próxima reunião?" vão para a IA, que consulta a agenda do CRM e os lembretes. Ela também pode abrir o painel. O briefing da manhã ganhou o card **Agenda · hoje**. Na segunda tela, abas **Agenda tática** e **Financeiro**. Cada gráfico tem tooltip (mouse e teclado) e **Ver tabela** com todos os números.

Em GERENCIAR HUD → **Fontes de dados**, cada fonte aparece com o estado real: *respondendo*, *chave configurada*, *ainda não consultado*, *com falha*, *desligado* ou *ainda não integrado* (WhatsApp, e-mail). Também mostra a variável que liga cada uma.

### Central de comando (PC, a partir de 1100 px)

Inspirada em jarvis.lucasvictor.ai, com uma regra: **o Jarvis organiza, mas não inventa dados**.
Todo número na tela é medido ou vem da API; o que não existe aparece como "off" ou "—".

- **Barra de cima**: relógio, *Sistema online/Sem conexão* (resposta real do servidor) e *Voice link* (estado da voz agora).
- **Coluna esquerda**: *Sinal · Entrada* e *Sinal · Espectro* desenham o áudio de verdade (microfone quando ele ouve, a voz dele quando fala; parado = linha reta); *Voz · Leitura* é quanto da resposta ele já leu; *Núcleo · Serviços* vem do `/api/status` e do navegador (microfone, reconhecimento de voz); *Ampliize · Pulso* são os números do CRM.
- **Coluna direita**: *Sensores · Clima* (Open-Meteo: temperatura, sensação, umidade no anel, mínima, máxima e chuva) e *Canal ativo* (o que você pediu e o que ele respondeu; clique para reabrir o card).
- **Briefing**: abre com a sequência *Presença detectada → Acesso validado → Dados do dia lidos → Briefing iniciado → Panorama do dia*; cada passo só acende quando aconteceu.
- **Segunda tela** (`/?tela=1`): abas *Centro de comando* (monitor da operação + agenda), *Radar de notícias* (Google Notícias por tema), *Núcleo do sistema* (serviços, sistemas monitorados e auditoria das últimas 24 h) e *Espelho* (cada card da tela principal aparece ali). Atualiza a cada 5 min ou em **Atualizar dados**. Não ouve, não fala e não toca música.

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

## Braço direito (v0.7)

### Guardião dos agentes de IA
Os agentes do CRM (SDR, Closer e Conteúdo) só geram rascunhos. Antes de alguém
usar um rascunho, o Jarvis revisa campo por campo em duas camadas:

1. **Regras fixas**, que valem sempre:
   - placeholder esquecido (`[nome]`, `{{...}}`);
   - preço no SDR ou no Conteúdo;
   - promessa de resultado;
   - CPF, CNPJ ou cartão no texto;
   - link fora da lista permitida;
   - mensagem longa demais para WhatsApp;
   - emojis demais;
   - erros de digitação: espaço duplo, espaço antes da pontuação, pontuação ou palavra repetida.
2. **Revisão por IA** contra `_jarvis/regras-dos-agentes.md` e o contexto do vault: fato inventado, tom, oferta fora do catálogo e personalização.

Cada rascunho recebe um veredito: **aprovado**, **ajustar** ou **bloquear**. Junto vêm o trecho exato e a correção pronta. O Jarvis só aponta: não altera nem envia nada no CRM. A revisão fica guardada e só é refeita se o texto ou as regras mudarem. No **MONITOR**, a área "Agentes de IA" fica vermelha quando há rascunho bloqueado.

Peça com: "revise os rascunhos dos agentes" ou "o SDR saiu da linha?".

As regras ficam em `_jarvis/regras-dos-agentes.md`, com seções `## Proibido` (bloqueia), `## Evitar` (pede ajuste) e `## Links permitidos`. Um item entre barras, como `/desconto de \d+%/`, vale como expressão regular.

Depende do recurso `agent_runs` da integration-api do CRM, que é somente leitura.

### Estúdio de sites
Diga, por exemplo: "cria uma landing page com scroll animation para a clínica X". O Jarvis produz o site inteiro no mesmo fluxo da landing da Nova Esplanada, em segundo plano. Leva alguns minutos e um site por vez.

**Motor:** quem estrutura a ideia e escreve o código é a **OpenAI** (`STUDIO_OPENAI_MODEL`, padrão `gpt-4.1`), com a mesma chave que o Jarvis já usa. Quando a `ANTHROPIC_API_KEY` for colocada, o estúdio passa a usar o **Claude** automaticamente, sem mudar mais nada.

1. **Referências.** O Jarvis **pesquisa sozinho**: o motor escolhe 3 ou 4 termos de busca e ele busca as fotos.
   - **Openverse:** gratuito e sem chave; é sempre consultado.
   - **Pexels e Unsplash:** chaves gratuitas em `PEXELS_API_KEY` e `UNSPLASH_ACCESS_KEY`; fotos melhores.
   - **Pinterest:** ele não pesquisa no Pinterest, porque não há acesso público para busca e as regras do site proíbem raspar. Se você mandar uma pasta **pública** ou links, eles também entram.

   São até 12 imagens, baixadas só por https, de endereços públicos, com no máximo 4 MB cada. As referências servem só para o motor entender o estilo e nunca vão para o site.
2. **Conceito.** O motor (Claude `claude-opus-5-5` ou OpenAI) olha as referências e devolve a estrutura do site: a ideia, a paleta, as fontes, a cena da sequência de frames, os prompts de imagem e de vídeo, as seções com textos e animações e o SEO.
3. **Imagens.** São geradas pela OpenAI (`gpt-image-1`, em WebP): o início da sequência no desktop e no celular, mais até 4 imagens das seções.
4. **Frames.** O ffmpeg monta a sequência que anda com o scroll: 1920x1080 no desktop e 720x1280 no celular. Sem vídeo, faz uma aproximação suave sobre a imagem principal. Com o vídeo enviado no card, tira 128 frames do vídeo. O vídeo pode ser gerado no Google Flow com o prompt que o Claude escreveu.
5. **Código.** O motor escreve o HTML completo: GSAP + ScrollTrigger, canvas com os frames, `prefers-reduced-motion`, versão para celular, SEO, WhatsApp e UTM.
6. **Revisão.** Uma conferência automática olha doctype, viewport, title, description, h1, GSAP, frames, imagens, placeholders e lorem ipsum. O que falhar volta para o motor corrigir.
7. **Entrega.** O card do HUD traz **Ver prévia**, **Baixar HTML**, **Copiar prompt do Lovable** e **Abrir Lovable**. O prompt é o mesmo formato da Nova Esplanada: portar o HTML aprovado com fidelidade total. Uma nota com tudo vai para a inbox do vault.

Detalhes técnicos:
- A prévia fica em `/estudio/<id>/`. O id é impossível de adivinhar, e a página roda isolada (`CSP sandbox`): o código gerado não alcança a senha do HUD.
- Os frames e as imagens podem ser carregados por outros domínios. Por isso o site no Lovable usa as URLs do Jarvis; defina `JARVIS_PUBLIC_URL`.

Variáveis do estúdio:
- `OPENAI_API_KEY`: já usada pelo Jarvis; é o motor padrão e gera as imagens.
- `ANTHROPIC_API_KEY`: opcional; quando existir, o motor passa a ser o Claude.
- `PEXELS_API_KEY` e `UNSPLASH_ACCESS_KEY`: opcionais e gratuitas; melhoram a pesquisa de referências.
- `STUDIO_OPENAI_MODEL`: opcional; o padrão é `gpt-4.1`.
- `JARVIS_PUBLIC_URL`: por exemplo, `https://jarvis.ampliize.com`.
- `OPENAI_IMAGE_MODEL`: opcional; o padrão é `gpt-image-1`.

### Criar site com animação de scroll (roteiro rápido)
Peça com: "cria uma landing page com scroll animation para a clínica X".

O Jarvis monta o roteiro do site:
- seções e textos prontos;
- a animação de cada seção (GSAP + ScrollTrigger + Lenis: pin, scrub, parallax e revelação de texto);
- identidade visual e SEO;
- um bloco técnico fixo: `prefers-reduced-motion`, versão mobile, performance, captura de UTM e botão de WhatsApp.

A resposta vem com o botão **Criar no Lovable**, um link do recurso *Build with URL* do Lovable. O site só é criado quando você abre esse link na sua conta, então o Jarvis não gasta crédito sozinho. O roteiro fica na inbox do vault.

### Mentor técnico (GitHub, somente leitura)
Com `GITHUB_TOKEN`, o Jarvis lê o código dos nossos repositórios: lista os repositórios, lê arquivos, busca no código e mostra os PRs e commits recentes. Com isso ele explica erros, orienta mudanças citando arquivo e trecho, aponta riscos de segurança e entrega o próximo passo, inclusive um prompt pronto para o Claude Code ou o Lovable.
- Use um token *fine-grained* só de leitura: *Contents*, *Metadata*, *Pull requests* e *Issues* em **Read-only**.
- `GITHUB_OWNERS` limita quais donos de repositório ele pode ler. O padrão é `ampliize`.
- O token só é enviado para `api.github.com`.

### Auditoria
Toda ferramenta que o Jarvis usa fica registrada em `DATA_DIR/auditoria/AAAA-MM.jsonl`: o que usou, com quais parâmetros (resumidos, sem segredos), se deu certo e quanto tempo levou. Pergunte "o que você fez hoje?" ou consulte `GET /api/auditoria?dias=7`.

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
| GET | `/api/status` | Modelo, voz, estado do cérebro (Obsidian) e `servicos` (motor, CRM, fala, estúdio, GitHub, sistemas) |
| GET · POST · DELETE | `/api/missoes`, `/api/missoes/pacote`, `/api/missoes/:id/executar`, `/api/missoes/:id/ativa`, `/api/missoes/:id` | Missões delegadas (listar, ativar o pacote, executar agora, ativar ou pausar, excluir) |
| GET · POST | `/api/relatorios`, `/api/relatorios/avisos?desde=`, `/api/relatorios/:id`, `/api/relatorios/:id/lido` | Relatórios das missões |
| GET | `/api/whatsapp/avisos?desde=` | Leads que responderam no WhatsApp e esperam resposta nossa (do CRM, cache de 30 s) |
| GET | `/api/reunioes/avisos?desde=` | Reuniões marcadas pelo atendente de IA desde o cursor, com o dossiê (do CRM) |
| GET | `/api/painel/:tipo` | Painel do HUD (`agenda`, `financeiro` ou `comercial`), lido do CRM (cache de 60 s) |
| GET | `/api/clima` | Clima agora, hoje e amanhã na cidade do `JARVIS_CITY` |
| GET | `/api/noticias` | Manchetes recentes (`?tema=`, até 80 caracteres) |
| GET | `/api/briefing` | Briefing do dia: `{ saudacao, abertura, cards[], fechamento, atencao, numeros }` |
| GET · POST · DELETE | `/api/briefing/musica` | Trilha de abertura do briefing (POST com o áudio no corpo, `Content-Type: audio/*`, `X-File-Name` opcional) |
| GET | `/api/briefing/musica/info` | `{ musica: { nome, tipo, bytes, enviado_em } \| null }` |
| GET | `/api/lembretes` | Lembretes em aberto |
| GET | `/api/lembretes/avisos` | Lembretes que venceram (marca como avisados; a HUD chama a cada 30 s) |
| POST | `/api/lembretes/:id/concluir` | Conclui um lembrete |
| GET | `/api/sistemas` | Status dos sistemas monitorados (`?atualizar=1` testa agora) |
| GET | `/api/skills` | Skills (processos) disponíveis |
| POST | `/api/voice/transcribe` | Corpo = áudio (webm/ogg/mp4/m4a/mp3/wav, até 10 MB) → `{ text }` |
| POST | `/api/voice/speak` | `{ text }` → `audio/mpeg` |
| POST | `/api/brain/sync` | Puxa agora o que mudou no vault |
| GET | `/api/auditoria?dias=1` | Tudo o que o Jarvis consultou/fez (ferramenta, parâmetros resumidos, ok, ms) |
| POST | `/api/agentes/revisar` | Guardião: revisa os rascunhos pendentes dos agentes de IA do CRM |
| POST | `/api/estudio` | Estúdio: começa a produzir um site (`nome`, `objetivo`, `publico`, `cliente`, `estilo`, `secoes`, `whatsapp`, `pinterest`, `referencias[]`) |
| GET | `/api/estudio` · `/api/estudio/:id` | Andamento dos sites (etapa, avisos, prévia, prompt do Lovable) |
| POST | `/api/estudio/:id/video` | Vídeo (mp4/webm/mov, até 100 MB) para a sequência de frames; refaz frames, código e revisão |
| GET | `/estudio/:id/` · `/estudio/:id/baixar` | Prévia pública (isolada) e download do HTML |
| GET | `/api/agentes/revisoes` | Revisões guardadas (veredito, problemas, correções) |

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
