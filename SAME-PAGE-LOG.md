# Fase 8 — Relatórios, automações e baixa de nota (2026-11-07)

## O que mudou

- **Relatórios sob demanda:** `fechamento` (dia) e `relatorio semanal`/`relatório semanal` (semana, segunda→hoje). Corpos montados 100% em SQL: OS confirmadas, recebido, cobrado (semanal), cobranças abertas + vencidas — centavos inteiros, janela de datas em America/Sao_Paulo.
- **Alertas** nos dois relatórios, só quando pende algo: OS incompletas de dias anteriores, notas fiscais não concluídas (com referência `OS-n-NFk`) e materiais no mínimo (`saldo/mínimo unidade`).
- **Agendamento no `/automation/tick`:** a partir de `REPORT_DAILY_HOUR` (default 18, SP) envia o fechamento do dia; em `REPORT_WEEKLY_DAY` (default segunda) também o semanal. `REPORTS_ENABLED=false` desliga (default `true`). Idempotência: `report_deliveries` (`UNIQUE(kind, period_key)`, migração 202611070001) + `dedup_key` — tick duplicado/reinício não duplica.
- **Baixa de nota (complemento Fase 7):** `nota emitida OS <n> <número NFS-e>` → `AUTHORIZED` com número em `payload.nfsNumber` (auditoria `INVOICE_AUTHORIZED`); `cancelar nota OS <n>` → `CANCELED` (chama `provider.cancel` quando há id externo). Uso incorreto e OS sem solicitação respondem determinístico.
- Tick responde `reports` na contagem.

## Arquivos

- `core-api/prisma/migrations/202611070001_reports/` + `ReportDelivery` no schema.
- `core-api/src/config.ts` — `REPORTS_ENABLED`, `REPORT_DAILY_HOUR`, `REPORT_WEEKLY_DAY`.
- `core-api/src/domain.ts` — seção "Relatórios e automações", `settleInvoiceAuthorized`, `cancelInvoiceRequest`, despacho estendido.
- `core-api/src/app.ts` — `runScheduledReports` no tick.
- `core-api/test/integration.ts` — 3 cenários novos; harness roda com `REPORTS_ENABLED=false` por padrão (suite não depende da hora do dia); `reset()` trunca `report_deliveries`.
- README (seção Fase 8), `.env.example`, CHANGELOG 0.6.0.

## Decisões

- Semanal define seu período pela segunda-feira da semana corrente (`period_key = W:<segunda ISO>`) — sem dependência de lib de ISO-week.
- Alertas são estado atual (não histórico): os mesmos aparecem no diário e no semanal.
- A política de envio é só env + tabela de entregas: sem cron novo no n8n, tudo no tick que já existia.

## Verificação

- `npx tsc --noEmit` OK; `npm run verify` e smoke real pendentes no deploy desta fase.
