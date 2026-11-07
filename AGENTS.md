# AGENTS.md

Instruções para qualquer agente de IA (humano ou não) que for alterar este repositório.

## O que este projeto é

POC de um assistente de Ordens de Serviço via WhatsApp: WAHA (existente, não gerenciado por este repo) → webhook assinado → Core API (Fastify/TypeScript/Prisma) → PostgreSQL, com n8n só como acionador de um tick durável. Notas de voz passam por Groq Whisper (STT) + Groq LLM (extração estruturada) e pré-preenchem o fluxo guiado — a gramática de TEXTO continua uma máquina de estados determinística, proposital. O escopo inclui estoque (Fase 5), cobrança por adapters Asaas/Efí/manual (Fase 6), cadastro financeiro e cancelamento de OS (6.5), fluxo fiscal sobre a porta `InvoiceProvider` (7) e relatórios agendados (8).

Leia `README.md` antes de mexer em qualquer coisa. A arquitetura e a gramática de conversa descritas lá são a fonte de verdade do comportamento esperado.

## Invariantes de domínio (não quebrar sem motivo explícito no PR)

- **Dinheiro é sempre `Int` em centavos.** Nunca `Float`/`Decimal` ponto-flutuante para valores monetários. Conversão de string para centavos é determinística (`core-api/src/types.ts`, `parseMoney`).
- **Deduplicação por `(session, payload.id)`**, nunca pelo `id` do envelope do webhook (que muda a cada redelivery). Toda inserção usa `UNIQUE` + `ON CONFLICT DO NOTHING` no banco — nunca um `SELECT` seguido de `INSERT` em passos separados (condição de corrida).
- **HMAC sobre os bytes brutos do corpo**, antes de qualquer `JSON.parse`. Comparação sempre constant-time (`crypto.timingSafeEqual`).
- **Allowlist por identidade literal**, nunca por heurística de telefone. O WAHA pode entregar `@c.us` ou `@lid` dependendo da sessão/engine — o valor configurado em `OPERATOR_LID`/`OPERATOR_PHONE` precisa ser exatamente o que a sessão real envia em `payload.from`.
- **Inbox e outbox são duráveis e retomáveis**, nunca processamento síncrono dentro do request do webhook. `webhook_events`/`outbound_messages` carregam estado explícito (`PENDING`/`LEASED`/`SENT`/`FAILED`/`UNCERTAIN`) e contador de tentativas (limite de 5 antes de `FAILED`). Uma resposta de rede perdida (timeout, socket fechado) é `UNCERTAIN`, não `FAILED` — nunca reenviada automaticamente, porque não há prova de que a mensagem anterior não chegou.
- **Serialização por operador**: o processamento usa `pg_advisory_xact_lock` por identidade, nunca lock otimista descartável — mensagens concorrentes do mesmo operador nunca podem ser descartadas ou aplicadas fora de ordem.
- **Matriz de transição de Ordem de Serviço é fechada e atômica**: toda mudança de status é um `UPDATE ... WHERE status = <esperado> RETURNING *` condicional (nunca `SELECT` seguido de `UPDATE`). `confirm`/`cancel` são idempotentes quando já aplicados (retornam sucesso, sem novo registro de auditoria). Edição de dados (`setField`) é bloqueada uma vez `CONFIRMADA`/`CANCELADA` — sem exceção silenciosa.
- **Toda transição de domínio grava `audit_logs`** na mesma transação, com ator (`OPERATOR`/`SYSTEM`) e a mensagem de origem quando houver.
- **Consultas respondem a partir do PostgreSQL**, nunca do histórico da conversa em memória.
- **Fuso horário**: "hoje" é sempre `America/Sao_Paulo`, convertido na borda da query a partir de `timestamptz` em UTC.
- **IA nunca confirma nada sozinha** (limite da seção 9.2 do plano): a saída do LLM é validada com zod e apenas pré-preenche o fluxo guiado determinístico; toda OS nasce em `AGUARDANDO_CONFIRMACAO` e só muda com `sim`/`cancelar` explícitos do operador. Nenhum campo não dito é inventado (`null`), e `due_date` só entra como `YYYY-MM-DD` válido.
- **Fallback da IA é determinístico**: JSON/schema inválido, `intent != REGISTRAR_SERVICO` ou `GROQ_API_KEY` ausente nunca bloqueiam o operador — transcrição vira descrição do fluxo guiado, intent ignorada responde escopo, sem chave responde "não configurado"; falha de rede/5xx segue a semântica durável de inbox (5 tentativas → `FAILED`).
- **Envelope autenticado estruturalmente inválido persiste com 200** (`webhook_events.state='INVALID'`, `processed_at`, sem processamento) — nunca 400, que fazia o WAHA (único emissor autenticado) esgotar retry exponencial e perder mensagem real (bug da voz com `body=null`). HMAC inválido continua 401 sem persistir.
- **Áudio nunca é persistido em disco**: nenhum byte de mídia vai para coluna, arquivo ou log — o download vive só na memória do processo e apenas `messages.transcription` (e `media_mimetype`/`media_path` como metadados text) sobrevive. Download autenticado com `X-Api-Key`, cap `WAHA_MEDIA_MAX_BYTES`, usando só o PATH de `payload.media.url` prefixado com `WAHA_BASE_URL` (nunca o host público da url).
- **Roteamento de mídia é fechado**: só `mimetype audio/*` segue para o fluxo de áudio (transcrição é autoritativa, body/caption ignorado); mídia sem mimetype ou não-audio é rejeitada (`MEDIA_UNSUPPORTED`) sem download; texto vazio sem mídia continua `EMPTY_TEXT`.

## Convenções

- Node.js 22, TypeScript estrito (`strict: true`), módulos ESM (`NodeNext`).
- Sem HTTP interno entre módulos de domínio dentro do mesmo processo — `customer-service`/`service-order-service`/motor de conversa são chamadas de função direta, não rotas. As rotas HTTP reais são `GET /health`, `POST /webhooks/waha` e `POST /webhooks/billing/:provider` (públicas, atrás do proxy webhook-only) e `POST /automation/tick` (privada). Contrato em `openapi.yaml`.
- Testes (`core-api/test/integration.ts`) rodam contra PostgreSQL real e um provedor WAHA HTTP isolado — nunca contra a API WAHA de verdade. `npm run verify` sobe um projeto Compose inteiramente separado (`whatscobranca_verify`) com bancos e portas próprios; nunca toca dados operacionais.
- Segredos só em `.env` (gitignorado, permissão 600). Nunca hardcode identidade real de operador, domínio ou chave de API em código, docs ou testes — use os placeholders já presentes (`00000000000000@lid`, `5511999999999@c.us`, `your-waha-instance.example.com`, sessão `default`).
- Scripts (`scripts/*.sh`) usam `set -euo pipefail`, nunca removem volumes/bancos operacionais, e todo script de restauração/backup recusa sobrescrever destino existente.

## Invariantes de estoque (Fase 5)

- Quantidades são `numeric(12,3)` no PostgreSQL e **string** no Node (node-postgres). Toda aritmética/comparação de saldo acontece em SQL (`quantity - $x >= 0`), nunca em Float JS. Leitura de numeric sem `::text` volta como objeto Decimal do Prisma — sempre cast `::text` na query.
- Baixa de estoque é transacional com a confirmação da OS, trava itens em ordem determinística (`ORDER BY id FOR UPDATE`), valida saldo ANTES de mover o status e responde deterministicamente quando insuficiente (estado permanece CONFIRM). Re-confirmação é idempotente: nunca duplica movement.
- `stock_movements` é o ledger completo (IN/OUT/ADJUST/RETURN com operador, mensagem de origem e OS quando aplicável). ADJUST de delta zero é no-op determinístico — movement de quantidade 0 viola CHECK.
- Item de OS sem `inventory_item_id` é pendente de classificação: não baixa estoque, citado no recibo. Materiais extraídos por áudio seguem a mesma regra — nunca criam item de catálogo automaticamente.
- Itens de OS são imutáveis após `CONFIRMADA`/`CANCELADA`; `corrigir materiais` apaga e reabre a lista APENAS em rascunho.
- Órdem de exibição dos itens usa a coluna `position` (ordem de digitação), nunca `created_at` (idêntico na mesma transação).
- `average_cost_cents` é média ponderada calculada em SQL numa única `UPDATE` (o `SET` enxerga os valores ANTIGOS de `quantity`/`average_cost_cents`, nunca a própria atualização — não precisa de CTE/`FOR UPDATE` como o `ADJUST`). `NULL` até a primeira entrada com custo; entrada sem custo nunca move a média existente.

## Invariantes de integrações (Fase 6)

- O domínio importa SÓ `src/providers/*/types.ts` + `registry.ts`. Proibido fetch a provedor fora do adapter e proibido persistir status/payload cru de provedor como estado (o adapter traduz para o vocabulário interno; o payload bruto vai só para `billing_events.payload`, para perícia).
- Toda cobrança nasce `DRAFT` com `external_reference` ANTES da chamada ao provedor. Após timeout/5xx, reconciliar via `findByExternalReference` antes de reenviar — nunca presumir falha, nunca duplicar.
- Só `RECEIVED` conta como dinheiro recebido; `RECEIVED` nunca é rebaixado por evento posterior. `CONFIRMED` não notifica o operador (ainda não é dinheiro).
- Webhook financeiro: 200 rápido, dedup por `(provider, provider_event_id)`, processamento assíncrono no tick. Token inválido → 401 sem persistir nada.
- Notificação ao operador só em transição de status, com `dedup_key` `billing:<chargeId>:<status>` (webhook e sweep de vencidas compartilham a chave — nunca aviso duplo).
- Dinheiro em `value_cents` integer; conversão para reais só dentro do adapter.
- Credenciais (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`) só no `.env` local, nunca em código, teste ou log de erro (erros do adapter truncam corpo e omitem headers).
- Webhook de provedor devolve uma LISTA de eventos (`validateAndNormalizeWebhook(...): NormalizedBillingEvent[]`): um POST pode trazer vários (Efí `pix[]`). Todos entram na mesma transação, deduplicados por `(provider, provider_event_id)`; lista vazia = 200 `ignored`. Só recebimento vira `RECEIVED` — devolução (`devolucoes`) e Pix sem `txid` são ignorados.
- Autenticação do webhook é por adapter: Asaas = header `asaas-access-token`; Efí = `?token=` na URL cadastrada (a Efí não envia header customizado), constante-time. O cadastro na Efí usa `?token=…&ignorar=` e o header `x-skip-mtls-checking: true` (`node dist/efi-register-webhook.js <url>`); a Efí NÃO é validada por mTLS atrás do túnel, então o token é a única camada — não o registre em logs.
- Toda variável do schema de `core-api/src/config.ts` precisa estar no `environment` do `core-api` em `docker-compose.yml` (o Compose não repassa o `.env` inteiro). `scripts/check-compose-env.mjs` roda no início do `npm run verify` e falha se faltar alguma.

## Invariantes fiscais e de relatórios (Fases 7 e 8)

- `invoices` nasce `READY_FOR_APPROVAL` com `externalReference` (`OS-<n>-NF<seq>`) ANTES de chamar o emissor; falha de comunicação reconcilia por `findByExternalReference` e, sem confirmação, vira `NEEDS_REVIEW` — nunca se presume perda. Só `AUTHORIZED` significa "nota emitida" (`nota emitida OS <n> <número>`). Uma solicitação ativa por OS/provedor.
- Relatórios (`fechamento`, `relatorio semanal`) são SQL puro, centavos inteiros, datas em America/Sao_Paulo. O envio agendado roda no `/automation/tick` e é idempotente por `report_deliveries(kind, period_key)` + `dedup_key` da outbox; `REPORTS_ENABLED=false` desliga o agendamento. O harness de teste roda com relatórios desligados por padrão para não depender da hora do dia.

## Invariantes de cadastro e cancelamento (Fase 6.5)

- `billing_opt_in` começa false. Só ofereça envio financeiro ao cliente se telefone e consentimento explícito existirem; use `outbound_messages` com `dedup_key` `charge-send:<chargeId>`, nunca envie direto pelo adapter WAHA.
- `cancelar OS <n>` bloqueia enquanto houver cobrança PENDING/OVERDUE. Em OS CONFIRMADA, trava os itens, recompõe o saldo e grava um RETURN por item na mesma transação que muda o status para CANCELADA. A guarda de status torna a operação idempotente.
- Dados de endereço usam os campos separados. O comando `endereco` exige `|` entre nome e endereço para nomes com espaços não terem parsing ambíguo.

## Antes de abrir PR

- Rode `npm run verify` (requer Docker Compose ≥ 2.24.4) e cole a saída completa.
- Se mudar schema Prisma, inclua a migração versionada — nunca edite uma migração já aplicada em `whatscobranca_verify`/produção.
- Se adicionar um comando de conversa novo, atualize a gramática documentada no `README.md` e cubra ambiguidade/expiração/idempotência no teste de integração, não só o caminho feliz.
