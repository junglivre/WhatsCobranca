# Boleto com link real + correções pós-Efí (2026-11-07)

---

# Continuar OS (2026-11-07)

Fecha a última limitação documentada do README: "não há comando para retomar um rascunho abandonado".

`continuar OS <n>` reconstrói o próximo passo só a partir de `service_orders.status`/`amount_cents` — nunca do `conversation_states` que expirou (contrato: a OS sobrevive, a pendência não). `AGUARDANDO_DADOS` reabre `VALUE`; `AGUARDANDO_CONFIRMACAO` mostra o resumo pronto para `sim`. `CONFIRMADA`/`CANCELADA`/inexistente respondem determinístico.

**Verificação:** `npm run verify` 63/63 + VERIFY PASS (commit a8b5462).

**Incidente operacional durante o smoke (não é bug de produto):** o `--force-recreate` do `core-api` trocou o IP interno do container; `webhook-proxy` (nginx) manteve a resolução DNS antiga em cache e passou a devolver 502 para todo `POST /webhooks/waha` — mensagens reais do WhatsApp real ficaram represadas sem erro visível no WAHA. Corrigido com `docker compose restart webhook-proxy`. Lição para o próximo deploy: reiniciar o proxy junto, ou trocar para `depends_on` com healthcheck de verdade. Também vazei variáveis `DATABASE_URL`/`POSTGRES_*`/`AUTOMATION_TOKEN` etc. de uma sessão de debug isolada (`DATABASE_URL` apontando para `whatscobranca_verify`) para o shell persistente, o que quebrou um primeiro `docker compose up` em produção (auth falhou contra `whatscobranca_verify` em vez de `whatscobranca`) — sem efeito em dados reais porque a migração nunca chegou a autenticar; corrigido com `unset` das variáveis antes do redeploy.

**Smoke real:** OS 000006 criada → `VALUE` expirado manualmente (simulando os 30 min) → `continuar OS 6` → "Retomando a OS 000006. Qual é o valor do atendimento?" → `65` → materiais `não` → `sim` → "OS 000006 confirmada... Valor: R$ 65,00".

---

# Custo médio de material (2026-11-07)

Fecha a limitação "custo médio do material não é calculado" (citada duas vezes no README). `entrada <qtd> <material> [custo <valor>]` + passo opcional no `material novo` (só com saldo>0); média ponderada em SQL puro numa única UPDATE.

Bug pré-existente achado no caminho: `parseQuantity('0')` sempre rejeitava literal `0` no prompt "Saldo inicial? (número, ou 0)" — a feature prometida pelo próprio texto nunca funcionou. Corrigido (tratamento especial de `'0'` antes de `parseQuantity`), pré-requisito para o branch "saldo zero pula a pergunta de custo" ser alcançável.

**Verificação:** `npm run verify` 62/62 + VERIFY PASS (commit 841b532). Smoke real em produção: `material novo` com saldo 15 + custo R$4,50 → resumo mostra "Custo médio: R$ 4,50/m" → `entrada 10 ... custo 7,00` → "Entrada registrada... Custo médio: R$ 5,50/m" (confere: (15×450+10×700)/25=550) → `saldo` mostra "· custo médio R$ 5,50/m". Deploy com migração `202611070003_material_average_cost` aplicada.

## Boleto: link do PDF em vez de "consulte o painel"

- README/CHANGELOG documentavam "boleto cria a cobrança mas não baixa o PDF (link no painel do provedor)" como limitação conhecida. A API Asaas já devolve `bankSlipUrl` (link direto do PDF) na própria resposta de `POST /payments` — confirmado contra a doc oficial (`docs.asaas.com/reference/criar-nova-cobranca`, schema `PaymentGetResponseDTO`).
- `CreatedCharge` ganhou `boletoUrl?: string | null`; o adapter Asaas captura em `createCharge` e `findByExternalReference` (reconciliação de timeout também traz o link).
- Migração `202611070002_charge_boleto_url` (`charges.boleto_url`).
- `domain.ts`: `pixBlock` virou `paymentBlock` genérico — Pix usa o copia-e-cola (como antes); boleto usa `Boleto: <link>`. A oferta de "enviar ao cliente" (telefone + `autorizar`), que só existia para Pix, agora cobre qualquer método com bloco de pagamento disponível — generalização natural, mesmo código de outbox/dedup já existente.
- Fallback honesto para o caso sem link (ex.: `BILLING_PROVIDER=manual` via `cobrar ... boleto`, que não tem boleto real): mensagem diz "link ainda não disponível; consulte o provedor" em vez de inventar.

## Achado real ao cobrir isso em teste

O cenário novo ("boleto com telefone...") travou com timeout de 20s no `tick()`. Isolei rodando `tsx test/integration.ts` direto contra o Postgres do `verify` que ficou de pé (porta 55433 exposta), com um array de cenários reduzido a só o que falhava — revelou `AssertionError: 'PENDING' !== 'SENT'`, não timeout. Causa: o mock WAHA local (`core-api/test/integration.ts`) só aceitava `sendText` para o `chatId` do PRÓPRIO operador (`assert.ok([OPERATOR_LID, OPERATOR_PHONE].includes(message.chatId))`) — nenhum cenário no arquivo inteiro jamais exercitava o envio ao CLIENTE (telefone+autorizar), só validado manualmente contra WAHA real em sessões anteriores. `deliver()` processa a fila em ordem de `position`; ao tentar enviar o aviso ao cliente (posição anterior à resposta ao operador) o mock rejeitava com 500, e a política "uma falha por tick" (`break` em `app.ts`) deixava a resposta do operador pendurada em `PENDING` até o próximo tick — daí o timeout do teste (esperava 1 tick, levaria 2). Corrigi o mock para aceitar qualquer `\d{10,13}@c.us`, espelhando a validação real do domínio (`payloadOf`).

## Verificação e smoke real

- `npm run verify`: 61 cenários PASS + VERIFY PASS (commit cb14d50).
- Produção: `cobrar OS 4 boleto +5d` → confirmação → `Cobrança criada... Boleto: https://sandbox.asaas.com/b/pdf/nn5xbkhbvz36fxzt` → oferta de envio → `sim` → cliente recebeu a mensagem com o link real; operador recebeu "Cobrança enviada ao cliente." Health ok.
