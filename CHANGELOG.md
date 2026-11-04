# Changelog

## 0.2.0 — Fase 4: Áudio + IA (Groq STT/LLM)

- Notas de voz (`mimetype audio/*`) entram no fluxo guiado: download de mídia via path de `payload.media.url` prefixado com `WAHA_BASE_URL` (host público da url nunca é chamado), cap `WAHA_MEDIA_MAX_BYTES` (16 MiB) → `AUDIO_TOO_LARGE`; mídia não-audio rejeitada sem download (`MEDIA_UNSUPPORTED`).
- STT Groq Whisper (`GROQ_STT_MODEL`, default `whisper-large-v3`) com transcrição persistida em `messages.transcription` na mesma transação; nenhum byte de áudio é persistido ou gravado em disco.
- Extração estruturada via Groq LLM (`GROQ_LLM_MODEL`, default `llama-3.3-70b-versatile`) com prompt de sistema versionado (`core-api/src/groq-prompt.ts`), `response_format: json_object` e validação zod — `customer_name`, `service_description`, `service_amount`, `materials_amount`, `due_date`.
- Extração pré-preenche o fluxo determinístico: resolve cliente (cadastro/lista/direto), valor em centavos com matemática inteira, `service_orders.due_date` nova coluna exibida como `Vence: DD/MM/AAAA`; sempre termina em `AGUARDANDO_CONFIRMACAO` com confirmação explícita — a IA nunca confirma nada sozinha.
- Fallbacks determinísticos: JSON/schema inválido → transcrição vira descrição no fluxo guiado ("Ouvi: ..."); `intent != REGISTRAR_SERVICO` → resposta explicando escopo (`AUDIO_INTENT_IGNORED`); `GROQ_API_KEY` ausente → `AUDIO_NOT_CONFIGURED` sem chamada externa; falha de rede/5xx → inbox `PENDING` com 5 tentativas limitadas → `FAILED`.
- Envelope autenticado mas estruturalmente inválido (incluindo voz com `body=null` — bug real que perdia mensagem por retry do WAHA) persiste raw em `webhook_events.state='INVALID'` e responde 200; HMAC inválido segue 401 sem persistir.
- Migração 3 versionada: `messages.transcription`, `messages.media_mimetype`, `messages.media_path`, `service_orders.due_date` e check constraint de `webhook_events.state` com `INVALID`.
- Novas variáveis: `GROQ_API_KEY` (opcional), `GROQ_BASE_URL`, `GROQ_STT_MODEL`, `GROQ_LLM_MODEL`, `WAHA_MEDIA_MAX_BYTES`; timeouts de 30 s (mídia/STT/LLM) via `AbortController`.
- Verificação isolada com Groq falso (`scripts/test-groq-server.mjs`: `/audio/transcriptions`, `/chat/completions`, `/scenario`, `/ledger`, `/reset`) e WAHA falso servindo mídia (`/api/files/...`, ledger `/files`); integração cobre 24 cenários contra PostgreSQL e HTTP reais.

## 0.1.0 — POC1

- Stack Docker Compose isolada com PostgreSQL, Core Fastify/TypeScript/Prisma, n8n e proxy webhook-only.
- Migração PostgreSQL para inbox/outbox duráveis, aliases autorizados, clientes, OS, conversa e auditoria.
- Webhook HMAC SHA-512 em bytes brutos, deduplicação persistente, tick autenticado, locks por operador e entrega WAHA HTTP com lease/UNCERTAIN.
- Fluxo guiado de texto, consulta, correção, confirmação/cancelamento, expiração, backup/restore e verificação integrada isolada.
- Bootstrap n8n com CLI import/activate, id estável, schema próprio e recuperação a cada cinco segundos; serviços persistentes com restart `unless-stopped`.
- Imagem Core inclui testes; overlay substitui portas com `!override`. Verificação ignora `.env` operacional e testa HTTP/n8n/reinício contra provedor isolado com ledger e provider id.
- Restore exige banco novo, recusa destino existente e compara dados reconhecíveis na prova; dump de domínio não inclui schema n8n.
- Runbook de falhas/UNCERTAIN e túnel temporário; OpenAPI explicita HMAC, body limit e Bearer do tick. Execução integrada e validação pelo aparelho cabem ao supervisor.
- Verificação executada pelo supervisor: 12 cenários comportamentais e smoke completo da stack passaram, incluindo restauração em banco novo. Entrada genuína pelo aparelho ainda aguarda o operador.
- Correções de integração: provider id NOWEB em `key.id`, sequência persistente das filas, bloqueio de conversa após entrega incerta, busca parcial e consultas sem cadastro implícito, negativa no cadastro e correções sem rascunho.
- Redes próprias configuráveis evitam esgotar o pool automático do host; testes preservam redes/volumes operacionais e o restore recusa destinos existentes.
