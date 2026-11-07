# Boleto com link real + correções pós-Efí (2026-11-07)

## Boleto: link do PDF em vez de "consulte o painel"

- README/CHANGELOG documentavam "boleto cria a cobrança mas não baixa o PDF (link no painel do provedor)" como limitação conhecida. A API Asaas já devolve `bankSlipUrl` (link direto do PDF) na própria resposta de `POST /payments` — confirmado contra a doc oficial (`docs.asaas.com/reference/criar-nova-cobranca`, schema `PaymentGetResponseDTO`).
- `CreatedCharge` ganhou `boletoUrl?: string | null`; o adapter Asaas captura em `createCharge` e `findByExternalReference` (reconciliação de timeout também traz o link).
- Migração `202611070002_charge_boleto_url` (`charges.boleto_url`).
- `domain.ts`: `pixBlock` virou `paymentBlock` genérico — Pix usa o copia-e-cola (como antes); boleto usa `Boleto: <link>`. A oferta de "enviar ao cliente" (telefone + `autorizar`), que só existia para Pix, agora cobre qualquer método com bloco de pagamento disponível — generalização natural, mesmo código de outbox/dedup já existente.
- Fallback honesto para o caso sem link (ex.: `BILLING_PROVIDER=manual` via `cobrar ... boleto`, que não tem boleto real): mensagem diz "link ainda não disponível; consulte o provedor" em vez de inventar.

## Verificação

- `npx tsc --noEmit` OK.
- `npm run verify`: ver resultado anexo nesta sessão. Cenário de boleto atualizado para asserir o link real persistido; cenário novo cobre boleto + telefone + consentimento → oferta de envio → entrega com link real na outbox.
