# AGENTS.md

Instruções para qualquer agente de IA (humano ou não) que for alterar este repositório.

## O que este projeto é

POC de um assistente de Ordens de Serviço via WhatsApp: WAHA (existente, não gerenciado por este repo) → webhook assinado → Core API (Fastify/TypeScript/Prisma) → PostgreSQL, com n8n só como acionador de um tick durável. Sem IA/LLM na conversa — é uma máquina de estados determinística, proposital, não uma limitação temporária. Sem estoque, cobrança (Asaas) ou emissão fiscal nesta fase.

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

## Convenções

- Node.js 22, TypeScript estrito (`strict: true`), módulos ESM (`NodeNext`).
- Sem HTTP interno entre módulos de domínio dentro do mesmo processo — `customer-service`/`service-order-service`/motor de conversa são chamadas de função direta, não rotas. Só existem três rotas HTTP reais: `GET /health`, `POST /webhooks/waha` (pública) e `POST /automation/tick` (privada).
- Testes (`core-api/test/integration.ts`) rodam contra PostgreSQL real e um provedor WAHA HTTP isolado — nunca contra a API WAHA de verdade. `npm run verify` sobe um projeto Compose inteiramente separado (`whatscobranca_verify`) com bancos e portas próprios; nunca toca dados operacionais.
- Segredos só em `.env` (gitignorado, permissão 600). Nunca hardcode identidade real de operador, domínio ou chave de API em código, docs ou testes — use os placeholders já presentes (`00000000000000@lid`, `5511999999999@c.us`, `your-waha-instance.example.com`, sessão `default`).
- Scripts (`scripts/*.sh`) usam `set -euo pipefail`, nunca removem volumes/bancos operacionais, e todo script de restauração/backup recusa sobrescrever destino existente.

## Antes de abrir PR

- Rode `npm run verify` (requer Docker Compose ≥ 2.24.4) e cole a saída completa.
- Se mudar schema Prisma, inclua a migração versionada — nunca edite uma migração já aplicada em `whatscobranca_verify`/produção.
- Se adicionar um comando de conversa novo, atualize a gramática documentada no `README.md` e cubra ambiguidade/expiração/idempotência no teste de integração, não só o caminho feliz.
