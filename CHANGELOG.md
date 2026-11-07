# Changelog

## 0.8.0 — Custo médio de material (fecha limitação da Fase 5)

- `inventory_items.average_cost_cents`: custo médio ponderado, `NULL` até a primeira entrada com custo informado — nunca inventa zero.
- `entrada <qtd> <material> [custo <valor>]`: com custo, pondera pela quantidade existente (`(saldo×custo_atual + qtd×novo)/(saldo+qtd)`, arredondado ao centavo, calculado em SQL); sem custo, a média existente não muda. `material novo` ganhou o passo opcional "Custo médio inicial?", só perguntado quando o saldo inicial é > 0.
- `saldo`/`estoque` mostram o custo médio quando conhecido.
- Corrigido bug pré-existente descoberto no caminho: `parseQuantity('0')` rejeitava literal `0` no "Saldo inicial?" (prompt oferecia "ou 0", mas sempre respondia "Quantidade inválida") — bloqueava justamente o caso que decide se a pergunta de custo aparece.
- 1 cenário novo cobrindo a lacuna, mais a atualização dos dois cenários existentes de estoque afetados (62 no total).

## 0.7.1 — Correções pós-Efí e boleto com link real

- `docker-compose.yml` não repassava as 10 variáveis novas (`EFI_*`, `REPORT_*`) ao container `core-api`. Novo guard `scripts/check-compose-env.mjs` (compara `config.ts` × compose) roda no início do `npm run verify` e falha cedo se faltar alguma.
- Porta `BillingProvider.validateAndNormalizeWebhook` devolve lista de eventos (Efí agrupa vários Pix por POST); a rota persiste todos numa transação. Devoluções e Pix sem `txid` são ignorados.
- `EfiBillingProvider.registerWebhook()` + comando `efi-register-webhook.js`: cadastra o webhook real na Efí com `x-skip-mtls-checking` e `?token=...&ignorar=` (a Efí exige mTLS no cadastro por padrão, incompatível com túnel).
- Boleto Asaas: o link do PDF (`bankSlipUrl`) agora é capturado na criação/reconciliação e devolvido na resposta — nada mais de "consulte o painel Asaas". A oferta de enviar a cobrança ao cliente (telefone + `autorizar`) passou a cobrir boleto, não só Pix.
- `ajuda` lista todos os comandos das 6 fases; `openapi.yaml`/`AGENTS.md`/README atualizados. 3 cenários novos (61 no total).

## 0.7.0 — Integração Efí Pay (cobrança Pix plugável)

- Terceiro adapter da porta `BillingProvider`: `BILLING_PROVIDER=efi` — cobrança Pix via API Pix padrão BCB (`PUT /v2/cob/{txid}`), txid determinístico derivado da `externalReference` (26–35 alfanuméricos). Registry fail-fast sem credenciais.
- OAuth2 `client_credentials` com cache em memória; transport próprio http/https com mTLS opcional (`EFI_CERT_BASE64`/`EFI_KEY_BASE64`, exigido em produção Pix).
- Webhook Efí com token na query (`/webhooks/billing/efi?token=...`, comparação constant-time) — a porta ganhou `query` em `validateAndNormalizeWebhook`; payload `{pix:[...]}` normalizado para `RECEIVED` com dedup por `endToEndId`.
- `UnsupportedMethodError` na porta: `cobrar OS n boleto` com Efí responde determinístico e a intenção fica `ERROR` (boleto fora do adapter).
- Timeout/5xx na criação reconcilia por `GET /v2/cob/{txid}` antes de reenviar (mesma regra do Asaas); cancelamento via `PATCH` `REMOVIDA_BY_USUARIO`.
- Fake Efí no teste de integração (oauth/PUT/GET/PATCH com ledger e create-then-500) + 3 cenários (58 no total). Validação contra a Efí real fica pendente de credenciais de homologação.

## 0.6.0 — Fase 8: Relatórios, automações e baixa de nota

- `fechamento` e `relatorio semanal` sob demanda: OS confirmadas, recebido, cobrado (semanal) e cobranças abertas — SQL puro, centavos inteiros, janelas em America/Sao_Paulo.
- Alertas automáticos nos relatórios: OS incompletas de dias anteriores, notas fiscais não concluídas (com referência) e materiais no mínimo.
- Agendamento no `/automation/tick`: fechamento diário a partir de `REPORT_DAILY_HOUR` (default 18 SP) e semanal em `REPORT_WEEKLY_DAY` (default segunda); `REPORTS_ENABLED=false` desliga. Idempotência por `report_deliveries` (`UNIQUE(kind, period_key)`) + dedup_key — reinício/tick duplicado nunca reenvia.
- Baixa da nota (Fase 7): `nota emitida OS <n> <número NFS-e>` → `AUTHORIZED` (número auditado em `payload.nfsNumber`); `cancelar nota OS <n>` → `CANCELED` (cancela no emissor quando há id externo).
- Migração `202611070001_reports`. 3 cenários novos (55 no total); o harness de teste roda com relatórios desligados por padrão para não depender da hora do dia.


## 0.5.0 — Fase 7: Fluxo fiscal plugável

- Porta `InvoiceProvider` virou fluxo de conversa determinístico: `emitir NF OS <n> <código-do-serviço>` (resumo → confirmação → solicitação) e `notas` (pendências).
- Intenção persistida antes de falar com o emissor (`READY_FOR_APPROVAL` + `externalReference` = `OS-<n>-NF<seq>`); a porta ganha `findByExternalReference` — falha nunca presume perda: sem confirmação, a solicitação fica `NEEDS_REVIEW` com `last_error`.
- Adapter `manual` (referência): toda solicitação → `NEEDS_REVIEW` para emissão humana no Portal Nacional; `INVOICE_PROVIDER=none` responde determinístico sem criar nada.
- Regras: só OS `CONFIRMADA` com valor; CPF/CNPJ do tomador obrigatório (orienta `cpf`); dedup de solicitação ativa por OS/provedor; auditoria `REQUEST_INVOICE`.
- Sem migração de banco — `invoices` já comportava o fluxo. 2 cenários novos (52 no total). Smoke real: OS 4 → `NEEDS_REVIEW` ref. `OS-4-NF1`, auditoria e `notas` conferidas.

## 0.4.1 — Cadastro financeiro e cancelamento de OS

- Clientes passam a guardar telefone, e-mail, endereço e consentimento financeiro explícito. Comandos: `telefone`, `email`, `endereco`, `autorizar`, `revogar`, `cliente` e `histórico`.
- Pix só oferece envio ao cliente após telefone cadastrado e autorização explícita. O envio usa a outbox existente e deduplica por cobrança.
- `cancelar OS <n>` bloqueia cobrança aberta e estorna os materiais confirmados com movimentos RETURN na mesma transação.

## 0.4.0 — Fase 6: Financeiro plugável

- Portas `BillingProvider`/`InvoiceProvider` + registry por env (`BILLING_PROVIDER`, `INVOICE_PROVIDER`): provedores são adapters trocáveis, nunca acoplados ao domínio. Adapter `manual` é a referência mínima para novos provedores; NFS-e fica pronta para adapter do Portal Nacional direto (sem terceiro) ou Asaas (Fase 7).
- Adapter Asaas (sandbox): sync idempotente de clientes por `externalReference`, cobranças Pix/boleto, QR copia-e-cola, cancelamento, reconciliação de timeout por `externalReference`.
- Comandos: `cobrar OS n [pix|boleto] [vencimento]`, `cobranças`, `vencidas`, `recebi OS n <valor> [pix|dinheiro]`, `cancelar cobrança OS n`.
- Webhook `/webhooks/billing/:provider`: token, 200 rápido, dedup por `(provider, provider_event_id)`, processamento FIFO no tick; sweep diário de vencidas; notificações ao operador com dedup por transição. `RECEIVED` nunca é rebaixado; só `RECEIVED` conta como dinheiro.
- Intenção `DRAFT` persistida antes de qualquer chamada ao provedor; erro nunca é presumido sem reconciliar.
- 12 cenários novos (48 no total).
- Pós-smoke sandbox: `customers.cpf_cnpj` + comando `cpf <nome> <documento>` — o Asaas exige CPF/CNPJ do cliente para cobrar; `updateCustomer` na porta sincroniza antes de criar; erro de fiscal-id vira orientação determinística (50 cenários).

## 0.3.0 — Fase 5: Estoque/materiais

- `inventory_items` + `service_order_items` (reintroduzida) + `stock_movements` (IN/OUT/ADJUST/RETURN) com quantidades `numeric(12,3)` — aritmética sempre no SQL, nunca Float em JS.
- Comandos: `material novo` (guiado), `entrada`, `ajustar … para` (com confirmação), `devolver … OS n`, `saldo`, `estoque`.
- OS pergunta materiais ("quantidade nome" por vírgula; decimal com ponto na lista), resolve contra o catálogo, material inexistente fica pendente de classificação (sem baixa, citado no recibo).
- Baixa transacional na confirmação: trava itens em ordem determinística, valida saldo antes de mover status, 1 OUT por item, re-confirmação nunca duplica. Estoque insuficiente responde determinístico e mantém CONFIRM.
- Áudio com lista de materiais do LLM resolve contra o catálogo (match único ganha id; ambíguo/inexistente pendente).
- `corrigir materiais` apaga e reabre a lista do rascunho. Ajuste sem delta é no-op determinístico.

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
