# Estado do projeto

## Revisão geral (2026-11-12)

### Situação observada

Ambiente de **homologação**: `BILLING_PROVIDER=asaas`, base Asaas sandbox, `INVOICE_PROVIDER=manual`. Não houve troca de gateway, deploy, emissão, cobrança ou envio WhatsApp nesta revisão.

- Core API, PostgreSQL e n8n com health saudável; `/health` retornou `{"ok":true}`.
- Proxy local retornou 401 para webhook WAHA sem assinatura.
- Inbox: 104 `PROCESSED`; outbox: 113 `SENT`; nenhuma linha pendente, falha ou incerta nessas filas.
- Eventos financeiros: 11 Asaas, todos processados. Isso confirma o processamento local, não uma conciliação com o gateway.
- OS: quatro confirmadas e duas canceladas. Cobranças: uma recebida, uma pendente, três canceladas e uma `ERROR`; não foram alteradas.
- Fiscal: uma solicitação manual `AUTHORIZED`. Esse estado registra a baixa do operador, não comprova emissão eletrônica pelo sistema.
- Dez migrações aplicadas, nenhuma incompleta; workflow de tick ativo.
- Um dump no diretório local `backups/`, de 04/11/2026. Não foram inspecionados backups externos.

O histórico abaixo registra 63 cenários aprovados em 07/11. **Não reexecutamos a suíte nesta análise.** Foram consultados código, contrato oficial Efí, serviços, agregados do banco em transação READ ONLY e avisos de dependências. Nenhum cenário financeiro adverso foi executado contra os dados da homologação.

### Bugs e riscos priorizados

P1 = corrigir antes de ampliar o uso financeiro ou considerar a integração homologada. P2 = confiabilidade, relatórios e manutenção. **[INFERENCE]** Os efeitos condicionais abaixo derivam da inspeção do código; não representam incidentes reproduzidos nesta revisão. A exceção é o 502 do proxy, já registrado no smoke anterior.

#### Financeiro e integrações

| ID | Prioridade | Evidência e efeito | Correção / prova necessária |
|---|---|---|---|
| FIN-01 | P1 | `app.ts:102-150` chama `processMessage` dentro da transação; `domain.ts:1658-1698` insere DRAFT e chama o gateway antes do commit. Timeout padrão Prisma de 5s é menor que os limites HTTP dos provedores. Uma cobrança aceita externamente pode sobreviver ao rollback da intenção e receber novo POST no retry Asaas. | Confirmar intenção/claim em transação curta, executar I/O fora dela e finalizar depois. Provar criação aceita com resposta atrasada e reinício sem duplicação. A mesma transação longa afeta áudio/Groq. |
| FIN-02 | P1 | `findActiveCharge`, `domain.ts:1570-1574`, só considera PENDING/OVERDUE. `PAYMENT_CONFIRMED` tira a cobrança desses filtros; outra cobrança integral passa. Cancelamento de OS usa proteção equivalente. | Proteger pagamentos identificados/obrigações já existentes com critério único. Testar CONFIRMED seguido de cobrar/cancelar OS. |
| FIN-03 | P1 | `domain.ts:1801-1804` grava RECEIVED para qualquer valor informado em `recebi`; R$50 sobre cobrança de R$150 encerra a pendência de R$100. | Registrar parcelas e saldo devedor; só quitar pelo total. Testar parcial, complemento e notificação posterior, evitando contar duas vezes o mesmo recebimento. |
| FIN-04 | P1 | `app.ts:455-457` só aceita o webhook do gateway ativo. `domain.ts:1857-1866` pula o cancelamento externo de cobrança de outro gateway, mas grava CANCELED e anuncia sucesso. | Separar gateway padrão para novas cobranças dos adapters habilitados para cobranças históricas. Resolver operações pelo provider persistido; nunca anunciar cancelamento não executado. |
| FIN-05 | P1 | Reconciliação em `domain.ts:1738-1740` adota status RECEIVED sem preencher `paid_value_cents`. `app.ts:283` não completa cobrança já recebida; relatórios somam zero para esse caso. | Transportar valor efetivamente recebido no snapshot de reconciliação e completar dados financeiros sem duplicar avisos. |
| FIN-06 | P2 | `app.ts:310-312` marca evento sem cobrança associada como processado. Um webhook que chegue antes do commit da criação pode perder a associação; o UNIQUE impede reprocessar a reentrega. | Manter evento não associado reconciliável e testar callback anterior à visibilidade da cobrança. |
| EFI-01 | P1 | `config.ts:35`/Compose usam base incompatível com a API Pix oficial; `efi.ts:101-104` permite mTLS ausente; `efi.ts:49-50,188` usa estados REMOVIDA_BY_* inexistentes no contrato. O fake reproduz essas suposições e não prova conformidade. | Usar homologação `https://pix-h.api.efipay.com.br`, exigir certificado/chave do ambiente e usar REMOVIDA_PELO_USUARIO_RECEBEDOR/REMOVIDA_PELO_PSP. Depois validar OAuth, Pix, callback e cancelamento na conta Efí de homologação. |

Fontes Efí: [credenciais, certificado e rotas](https://dev.efipay.com.br/docs/api-pix/credenciais), [estados](https://dev.efipay.com.br/docs/api-pix/status), [revisão de cobrança](https://dev.efipay.com.br/docs/api-pix/cobrancas-imediatas). OAuth Basic e endpoint `/oauth/token` estão de acordo com a documentação; a aceitação de corpo form-urlencoded, em vez do JSON dos exemplos, ainda não foi validada na conta real.

#### Estoque e retomada

| ID | Prioridade | Evidência e efeito | Correção / prova necessária |
|---|---|---|---|
| EST-01 | P1 | `domain.ts:2897,2922-2927` compara linhas separadas com o mesmo saldo e ignora o resultado de cada baixa. Saldo 10 com `6 cabo, 6 cabo` permite registrar OUT=12 com baixa real de 6; o cancelamento pode devolver 12. | Agregar consumo por material, validar o total e exigir sucesso da baixa. Testar repetição do mesmo item e cancelamento subsequente. |
| EST-02 | P1 | `processMaterialsQueue`, `domain.ts:910,922-924`, retira o item ambíguo antes de salvar a fila; o consumidor faz outro shift em `:2782-2785`. Um único material ambíguo lança MATERIAL_QUEUE_EMPTY; com próximo item, usa nome/quantidade errados. | Preservar o item atual na persistência. Testar item ambíguo único e ambíguo seguido de outro; a falha persistente pode bloquear o FIFO do operador. |
| EST-03 | P1 | Retomada sem valor salva VALUE com payload vazio (`domain.ts:2188`); materiais vindos de áudio já podem existir em `service_order_items`. O fluxo pergunta de novo e pode acrescentar a mesma lista novamente (`:2859-2867`). | Reconstruir o checkpoint a partir dos itens persistidos e substituir/reusar o conjunto sem duplicação. Testar áudio com materiais, sem valor, expiração e retomada. |

#### Segurança e operação

| ID | Prioridade | Evidência e efeito | Correção / prova necessária |
|---|---|---|---|
| SEG-01 | P1 | `ensureOperator`, `app.ts:92-94`, só acrescenta aliases; a autorização consulta identidades persistidas. Trocar OPERATOR_LID/PHONE não revoga os anteriores. | Sincronizar o conjunto autorizado ou implementar revogação explícita na troca. Testar identidade antiga rejeitada e nova aceita. |
| SEG-02 | P1 | Runtime n8n 1.112.5 está em faixa afetada por RCE autenticado no editor de workflows. `npm audit --omit=dev --json` reportou dois pacotes de produção com severidade alta: Fastify 5.3.3 e Zod 3.24.4. | Atualizar versões com análise de compatibilidade e executar a prova isolada. Não rodar `audit fix --force`. O n8n está publicado em loopback; não foi demonstrada exploração de qualquer advisory no projeto. |
| SEG-03 | P1 antes de ativar Efí | Efí autentica webhook por segredo na query; `nginx/webhook-only.conf` não define log que remova a query. O log padrão pode registrar o token. | Redigir query/segredos em todos os proxies e logs da API antes do cadastro real; validar sem expor o token. Não foi procurado nem constatado vazamento em logs. |
| OPS-01 | P1 | `nginx/webhook-only.conf:5,12` resolve upstream estaticamente. O smoke anterior registrou 502 após recriar Core com outro IP. `depends_on` não atualiza DNS nem reinicia nginx. | Resolver upstream via DNS Docker em runtime e provar recriação da API mantendo o webhook acessível. Até corrigir, reiniciar webhook-proxy após recriar core-api. |
| OPS-02 | P2 | `backup.sh:6` e `restore.sh:9` executam source do arquivo Compose. `$`, quoting e outras construções não têm a mesma semântica no shell; chaves com dólar podem sofrer expansão. | Remover source e usar um único mecanismo de leitura de configuração. Provar round-trip com valores especiais sem imprimi-los. |
| OPS-03 | P2 | `verify.sh:9-19` fixa WAHA/Groq/DB, mas não neutraliza BILLING_PROVIDER/ASAAS_*/EFI_*/INVOICE_PROVIDER/REPORT_* herdados; o overlay herda essas variáveis do Compose base. | Fixar integrações desligadas/fakes no overlay e testar ambiente herdado adverso. A suíte in-process limpa essas variáveis por cenário; isso não protege o boot da stack HTTP isolada. |
| OPS-04 | P2 | Repositório fornece backup/restore manual, sem política de agendamento/retenção; só um dump local encontrado. | Agendar, manter cópia fora do host e praticar restauração. Validar eventual mecanismo externo antes de afirmar ausência de backup. |

Fontes de segurança: [n8n GHSA-vpcf-gvg4-6qwr](https://github.com/n8n-io/n8n/security/advisories/GHSA-vpcf-gvg4-6qwr), [Fastify GHSA-jx2c-rxcm-jvmq](https://github.com/advisories/GHSA-jx2c-rxcm-jvmq), [Zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). O audit indica pacotes afetados, não comprova que todas as condições de exploração estão presentes.

#### Relatórios

| ID | Prioridade | Evidência e efeito | Correção / prova necessária |
|---|---|---|---|
| REL-01 | P2 | `app.ts:359-377` confirma report_deliveries antes de gerar/enfileirar a mensagem. Uma interrupção entre essas etapas suprime o relatório daquele período. | Gravar marcador e outbox na mesma transação; testar falha intermediária e recuperação. |
| REL-02 | P2 | `domain.ts:2595,2613` usa updated_at como data de recebimento; callbacks atrasados entram no dia/semana do processamento. | Persistir data financeira específica normalizada pelo adapter; testar recebimento atravessando dia/semana. |
| REL-03 | P2 | `domain.ts:2615-2618` soma todas as linhas de charges em “Cobrado”, incluindo ERROR/CANCELED. O semanal padrão de segunda cobre apenas a semana iniciada naquele dia (`app.ts:377`). | Definir emissão válida vs tentativa e fechamento da semana anterior vs parcial atual; separar esses conceitos no relatório e cobrir os limites de período. |

### Funcionalidades ainda pendentes

- **NFS-e direta pelo Portal Nacional:** não há adapter de emissão automática. Existe porta independente da cobrança, solicitação persistida e baixa manual. Implementar integração fiscal, parametrização, consulta/reconciliação e cancelamento com prova no ambiente de testes do emissor; não vincular essa etapa ao Asaas.
- **Efí boleto:** não implementado; adapter atual cobre apenas Pix. Credenciais/certificado de homologação ainda são necessários para prova real depois dos ajustes de contrato.
- **Parciais e estornos:** PARTIALLY_PAID existe no vocabulário, mas o consumidor não faz essa transição. REFUNDED após RECEIVED é ignorado; Efí também descarta devoluções. O saldo financeiro ainda não representa esse ciclo completo.
- **Recuperação operacional:** UNCERTAIN/FAILED requer intervenção SQL auditada. Falta procedimento assistido que preserve a decisão sobre entrega sem reenviar no escuro; não é motivo para reenvio automático.
- **UX:** primeira mensagem após expiração apenas encerra a pendência; continuar OS precisa ser repetido. Falha ao buscar Pix usa texto de fallback de boleto (`domain.ts:1767`).
- **Manutenção:** domain.ts concentra conversa, estoque, cobrança, fiscal e relatórios. Extrair módulos por responsabilidade durante as correções, preservando as portas e o fluxo transacional; não trocar tudo por um framework novo.

### Ordem recomendada

1. Corrigir durabilidade/reconciliação de cobrança, estados financeiros e consistência de estoque; incluir regressões dos gatilhos acima.
2. Revogar aliases antigos, atualizar dependências e corrigir DNS/logs do proxy, mantendo homologação.
3. Corrigir contrato Efí e fake, depois provar OAuth → criação → callback → cancelamento na homologação real.
4. Corrigir relatórios, isolamento do verify e backup/restore.
5. Implementar emissão direta pelo Portal Nacional como adapter fiscal independente.

### Documentação alterada nesta revisão

README agora distingue funcionalidade existente, limitação e integração futura; corrige caminhos públicos, enum de providers, contrato de envelope inválido, limites de retomada, pré-requisitos Efí e ressalvas financeiras/operacionais. OpenAPI documenta 200 com invalid=true, body nullable e media opcional. Changelog não deve afirmar que a retomada encerrou todas as limitações.

Esta revisão **não corrigiu o código dos bugs listados**, não atualizou dependências nem mudou configurações em execução. O resultado é diagnóstico e documentação para orientar as próximas alterações.

---

## Histórico: boleto com link real + correções pós-Efí (2026-11-07)

---

## Continuar OS (2026-11-07)

Adiciona retomada de rascunho, antes ausente. A revisão de 12/11 acima registra limitações e bugs ainda pendentes.

`continuar OS <n>` reconstrói o próximo passo só a partir de `service_orders.status`/`amount_cents` — nunca do `conversation_states` que expirou (contrato: a OS sobrevive, a pendência não). `AGUARDANDO_DADOS` reabre `VALUE`; `AGUARDANDO_CONFIRMACAO` mostra o resumo pronto para `sim`. `CONFIRMADA`/`CANCELADA`/inexistente respondem determinístico.

**Verificação:** `npm run verify` 63/63 + VERIFY PASS (commit a8b5462).

**Incidente operacional durante o smoke de homologação:** recriar `core-api` trocou seu IP interno, mas nginx manteve o endereço antigo e devolveu 502 aos webhooks. Reiniciar `webhook-proxy` restabeleceu a entrada; a correção permanente do DNS segue pendente. `depends_on` com healthcheck não resolve esse cache. Variáveis de debug da stack isolada também contaminaram o shell do redeploy e causaram falha de autenticação no banco; limpar essas variáveis permitiu subir a configuração correta. A autenticação falhou antes de qualquer migração.

**Smoke real:** OS 000006 criada → `VALUE` expirado manualmente (simulando os 30 min) → `continuar OS 6` → "Retomando a OS 000006. Qual é o valor do atendimento?" → `65` → materiais `não` → `sim` → "OS 000006 confirmada... Valor: R$ 65,00".

---

## Custo médio de material (2026-11-07)

Fecha a limitação "custo médio do material não é calculado" (citada duas vezes no README). `entrada <qtd> <material> [custo <valor>]` + passo opcional no `material novo` (só com saldo>0); média ponderada em SQL puro numa única UPDATE.

Bug pré-existente achado no caminho: `parseQuantity('0')` sempre rejeitava literal `0` no prompt "Saldo inicial? (número, ou 0)" — a feature prometida pelo próprio texto nunca funcionou. Corrigido (tratamento especial de `'0'` antes de `parseQuantity`), pré-requisito para o branch "saldo zero pula a pergunta de custo" ser alcançável.

**Verificação histórica:** `npm run verify` 62/62 + VERIFY PASS (commit 841b532). Smoke em homologação: material com saldo 15 e custo R$4,50; entrada de 10 a R$7,00; saldo final 25 e média R$5,50. Migração `202611070003_material_average_cost` aplicada.

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
- Homologação Asaas sandbox: boleto da OS 4 criado com link PDF real e enviado ao contato de teste após confirmação. Health ok naquele smoke.
