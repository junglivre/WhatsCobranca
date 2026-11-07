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

- `npm run verify`: **58 cenários** PASS + VERIFY PASS (commit ecb2de1). Três defeitos encontrados e corrigidos no caminho: transport http/https por protocolo, fake que só aceitava o 1º token OAuth (cada execução de cobrança cria nova instância do adapter) e `efiFake` sem `close()` no `finally` (segurava o event loop e travava o `compose run` do verify).
- Deploy em produção: health ok, caminho Asaas intacto (`cobranças` respondeu). Adapter Efí inativo até `BILLING_PROVIDER=efi` + credenciais — smoke real exige conta Efí de homologação (client_id/secret, chave Pix, webhook `?token=`).

## Lacunas corrigidas pós-revisão (2026-11-07, commit 9167732)

Ao revisar a entrega contra a documentação oficial da Efí, achei três defeitos reais (não cosméticos) e corrigi todos:

1. **`docker-compose.yml` não repassava as 10 variáveis novas** (`EFI_*`, `REPORT_*`) ao container `core-api` — o `.env` tinha os valores, mas o Compose só injeta o que está listado em `environment:`. `BILLING_PROVIDER=efi` no `.env` teria subido com `EFI_CLIENT_ID=''` etc., falhando o fail-fast do registry em runtime. Criei `scripts/check-compose-env.mjs`: compara as chaves do schema `config.ts` com o `environment` do compose e falha cedo; plugado no início do `npm run verify`. Provei que o guarda pega o bug real rodando-o contra o compose do commit anterior (falhou, como esperado) e contra o corrigido (passou).
2. **Webhook Efí perdia eventos**: a Efí agrupa vários Pix recebidos num único POST (`pix: [...]`), mas a porta só devolvia `NormalizedBillingEvent | null` (um evento). Mudei a porta para `NormalizedBillingEvent[]` (Asaas/manual devolvem 0 ou 1; Efí devolve todos). A rota persiste a lista inteira numa transação. Também passei a ignorar `devolucoes` (devolução de Pix, não recebimento) e entradas sem `txid` (Pix avulso/enviado) — só recebimento vira `RECEIVED`.
3. **Não havia como cadastrar o webhook de verdade**: a Efí exige, por padrão, que o servidor valide o certificado de cliente dela já no ato do cadastro (mTLS) — um Cloudflare Tunnel comum não faz isso, e o cadastro falharia com "autenticação de TLS mútuo não configurada". Implementei `EfiBillingProvider.registerWebhook()` (usa o header oficial `x-skip-mtls-checking: true` + `?token=...&ignorar=` para a Efí não anexar `/pix` à rota) e o comando `node dist/efi-register-webhook.js <url>`.

Também corrigidos, menores: `ajuda` só listava comandos até a Fase 5 (agora lista as 6 fases); `openapi.yaml` não documentava `POST /webhooks/billing/:provider`; `AGENTS.md`/README citavam escopo e contagem de rotas desatualizados.

**Verificação:** `npm run verify` — 60 cenários PASS + VERIFY PASS (um defeito encontrado e corrigido no processo: a suíte HTTP fixava o texto antigo de `ajuda`). Deploy em produção: health ok, `ajuda` mostra as 6 fases, caminho Asaas (`cobranças`) segue respondendo sem regressão.
