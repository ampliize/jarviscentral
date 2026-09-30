# OpenJarvis (guia @marcondes.ai) × Jarvis da Ampliize

O guia "Jarvis Local" instala o **OpenJarvis** (Stanford) no computador:
Ollama + Gemma 4 para pensar, faster-whisper para ouvir, Kokoro (voz
`pf_dora`) para falar e um comando extra que abre a conversa com duas palmas.

| | OpenJarvis local (guia) | Jarvis da Ampliize (este repositório) |
|---|---|---|
| Onde roda | No seu PC (precisa ficar ligado) | Na VPS (Easypanel), 24 h |
| Dados da empresa | Não conhece o CRM | Lê o CRM pela `integration-api` e outros projetos |
| Cérebro (modelo) | Gemma 4 local, grátis, ~9,6 GB | `gpt-4.1` (ou Ollama via `OPENAI_BASE_URL`) |
| Ouvir | faster-whisper local | Whisper / gpt-4o-transcribe (OpenAI) |
| Falar | Kokoro `pf_dora`, grátis | tts-1 / gpt-4o-mini-tts (OpenAI), com a voz do aparelho como reserva |
| Ativação | Duas palmas (script extra) | Duas palmas no navegador (modo palmas) |
| Memória | Local, sem Obsidian | Vault Obsidian em Git (`ampliize-brain`) |
| Acesso pelo celular | Não | Sim (navegador) |
| Custo | R$ 0 (energia do PC) | Centavos por conversa na OpenAI |

## O que aproveitamos
- **Modo palmas** com sensibilidade ajustável (no guia: `JARVIS_CLAP_THRESH`).
- **Voz em português** de ponta a ponta, com opção gratuita de reserva (voz do aparelho).
- **Modelo local opcional**: `OPENAI_BASE_URL` aceita o Ollama, como no guia.
- A regra de segurança do guia: chave de API só em variável de ambiente, nunca digitada no navegador.

## O que não adotamos (e por quê)
- **Rodar tudo no PC**: o Jarvis precisa ficar no ar para o celular, o time e
  os briefings automáticos, e precisa alcançar o CRM. A VPS resolve isso.
- **Gemma na VPS como padrão**: sem GPU fica lento, e modelos pequenos erram
  mais ao usar as ferramentas do CRM. Continua disponível como opção.

## Caminho híbrido (se quiser o melhor dos dois)
Instale o OpenJarvis no PC como "terminal de voz" (palmas + Kokoro grátis) e
use o Jarvis da VPS como cérebro de negócio, pela API `POST /api/chat`. É um
passo seguinte: basta um pequeno comando no PC que manda o texto ouvido para
a API e fala a resposta.
