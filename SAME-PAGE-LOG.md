# Integração Efí — cobrança Pix (2026-11-07)

## O que mudou

- Adapter `EfiBillingProvider` (`core-api/src/providers/billing/efi.ts`), selecionado por `BILLING_PROVIDER=efi` (registry fail-fast se faltar credencial). Terceiro adapter da porta — domínio intocado no essencial.
- **Escopo: Pix** (cob imediata com txid, API Pix padrão BCB). Boleto não suportado: `UnsupportedMethodError` nova na porta → `cobrar OS n boleto` responde determinístico e a intenção fica `ERROR`.
- txid determinístico derivado da `externalReference` (`OS-12-C3` → 30 chars alfanuméricos com zero-padding) — cumpre a regra BCB (26–35) e mantém a reconciliação por referência.
- OAuth2 `client_credentials` (Basic) com cache em memória; transport próprio sobre node:http/https escolhido pelo protocolo, com mTLS opcional (`EFI_CERT_BASE64`/`EFI_KEY_BASE64`, exigido em produção Pix).
- Timeout/5xx na criação → reconciliação por `GET /v2/cob/{txid}` antes de qualquer reenvio (mesma regra do Asaas). Cancelamento → `PATCH` `REMOVIDA_BY_USUARIO`.
- Porta ganhou `query` em `validateAndNormalizeWebhook`: a Efí não suporta headers customizados — o token viaja na query (`/webhooks/billing/efi?token=...`), comparado constant-time. Payload `{pix:[{endToEndId, txid, valor}]}` → `RECEIVED` com dedup por `endToEndId`.
- Fake Efí no integration test (oauth/PUT/GET/PATCH cob com ledger + create-then-500) e 3 cenários: happy path com oauth único e reconciliação de timeout; webhook (baixa, dedup, 401, txid desconhecido); cancelamento + boleto determinístico.

## Arquivos

- `core-api/src/providers/billing/efi.ts` (novo), `types.ts` (query + `UnsupportedMethodError`), `asaas.ts` (assinatura), `registry.ts`, `config.ts` (7 envs `EFI_*`), `domain.ts` (branch unsupported), `app.ts` (passa query), `test/integration.ts` (fake + cenários + cleanup de env), README, `.env.example`, CHANGELOG 0.7.0.

## Decisões

- Sem cobrança de cliente na Efí (cob não precisa de cadastro de pagador): `ensureCustomer` devolve id local determinístico.
- `expiracao` da cob = segundos até 23:59:59 do vencimento (SP), piso 1h, teto 30d — mantém a semântica de vencimento do domínio no modelo de expiração do Pix imediato.
- Validação contra a Efí REAL fica pendente de credenciais da conta (homologação): o fake cobre o contrato do adapter, não o servidor da Efí.

## Verificação

- `npx tsc --noEmit` OK; `npm run verify` rodando (58 cenários esperados). Smoke real só quando houver conta Efí — produção segue no Asaas.
