# Fase 7 — Fluxo fiscal plugável (2026-11-05)

## O que mudou

- Porta fiscal `InvoiceProvider` virou fluxo de conversa determinístico:
  - `emitir NF OS <n> <código>` — resumo → confirmação → solicitação.
  - `notas` — solicitações não concluídas.
- `InvoiceRequestInput` ganhou `externalReference` (`OS-<n>-NF<seq>`, sequência por OS) e a porta ganhou `findByExternalReference` — reconciliação obrigatória após falha, igual à porta de cobrança. Sem confirmação do emissor, a solicitação fica `NEEDS_REVIEW` com `last_error`.
- Adapter `manual` (referência): toda solicitação → `NEEDS_REVIEW` para emissão humana no Portal Nacional. `INVOICE_PROVIDER=none` (padrão) responde determinístico sem criar nada.
- Regras no domínio: só OS `CONFIRMADA` com valor; CPF/CNPJ do tomador obrigatório (orienta `cpf`); uma solicitação ativa por OS/provedor deduplica novas emissões.
- Auditoria `REQUEST_INVOICE` (READY_FOR_APPROVAL → status do adapter) e `REQUEST_INVOICE_REVIEW` no caminho incerto.

## Arquivos

- `core-api/src/domain.ts` — bloco "Emissão fiscal (Fase 7)", step `INVOICE_CONFIRM`, payload `invoice*`, despacho `emitir NF|notas`.
- `core-api/src/providers/invoices/types.ts` + `manual.ts` — contrato estendido.
- `core-api/test/integration.ts` — helpers `invoices()` + 2 cenários (manual happy path/dedup/aborto; none e OS inválidas).
- README — seção "Emissão fiscal (Fase 7)".

## Decisões

- NFS-e continua objeto independente da cobrança (pode emitir sem pagamento).
- Código de serviço sempre digitado pelo operador — nunca fixado em código (IBS/CBS 2027).
- Sem migração de banco: `invoices` já comportava o fluxo (payload jsonb + status).

## Verificação

- `npm run verify`: 52 cenários PASS + VERIFY PASS (commit 94a5198).
- Smoke real (WhatsApp, produção): `emitir NF OS 4 1.02` → confirmação → `NEEDS_REVIEW` com referência `OS-4-NF1`; `notas` lista `OS 000004 · NEEDS_REVIEW · manual`; banco confirma payload (20000 cents) e auditoria `REQUEST_INVOICE`.
