# Ciclo Codex — correções de 12/11/2026

Modelo solicitado e encontrado no catálogo local: gpt-5.6-terra. CLI instalado: 0.166.0. O default global é gpt-6.1-sol; este ciclo usará override explícito gpt-5.6-terra/xhigh, sem alterar configuração global.

Arquivos RF-* evitam sobrescrever SAME-PAGE-LOG.md, que já contém diagnóstico/histórico de trabalho. Alterações pré-existentes conhecidas são as quatro documentações da revisão anterior (README, CHANGELOG, SAME-PAGE-LOG, OpenAPI), produzidas pelo coordenador nesta conversa.

O usuário autorizou coordenar as correções existentes. Novas integrações Portal Nacional/boleto Efí não fazem parte desse pedido de correções. Apenas documentação/planejamento poderão receber commit de baseline; código não será commitado/pushed/deployed sem autorização.

Adaptação de execução: o executor não duplica builds/testes nem executa checks durante as mudanças; o coordenador fará a prova final integrada. Não serão usados bypass de sandbox, acesso a segredos, MCPs administrativos ou recursos operacionais.

## Revisão do plano

Revisão concluída em duas rodadas; plano aprovado para implementação.

## Round 1

### Integrator findings (verbatim)

- [FIX] A intenção DRAFT não define claim, lease, recuperação ou vínculo à inbox -> adicionar operação durável por mensagem com estados/lease/erros e finalização condicional, mantendo o evento FIFO bloqueado até enfileirar a resposta final.
- [FIX] Timeout após POST aceito pode retornar consulta vazia antes de a cobrança ficar visível -> proibir novo POST automático após resultado ambíguo; manter reconciliação-only/UNCERTAIN até confirmação segura.
- [FIX] `count(*) + 1` gera `external_reference` dependente da serialização atual -> alocar referência/attempt id atomicamente no banco e vinculá-lo unicamente à mensagem de confirmação.
- [FIX] `charges.paid_value_cents` não preserva parcelas, estornos nem origem -> migrar para ledger financeiro imutável com direção, valor, data, origem/idempotência e agregados de saldo calculados transacionalmente.
- [CLARIFY] Uma parcela manual e um callback cumulativo posterior não têm identificador comum -> qual regra deve provar que são o mesmo dinheiro: exigir vínculo do recebimento manual, bloquear a baixa manual de cobrança externa, ou tratar o snapshot do gateway como autoridade com conflito explícito?
- [FIX] O contrato atual não carrega nem persiste data financeira, delta/cumulativo ou valor de estorno verificável -> definir esses campos validados nas portas, ordenar eventos antigos e estacionar eventos sem valor/data suficientes sem usar `now()` como data financeira.
- [FIX] O normalizador Efí atualmente descarta `devolucoes` -> incluir evento de estorno por identificador da devolução, valor e data válidos, cobrindo parcial, integral, replay e payload inválido.
- [FIX] `BILLING_PROVIDER` e o registry só materializam o gateway padrão -> definir providers habilitados para histórico, resolução por `charges.provider` e resposta para callback/cancelamento quando a credencial histórica estiver ausente.
- [FIX] Eventos financeiros sem cobrança associada não possuem lease, retry agendado ou seleção anti-starvation -> adicionar estado/claim e reprocessamento reconciliável que priorize eventos associáveis sem perder os desconhecidos.
- [FIX] A agregação de estoque pode violar o invariant de `numeric` se feita no Node -> exigir `GROUP BY`/`SUM` em SQL, locks em ordem estável, baixa confirmada antes do movement e retorno pelo saldo líquido do ledger da OS.
- [CLARIFY] Dados já processados pelo defeito EST-01 podem ter OUT registrado sem baixa real, algo irrecuperável só com o estado atual -> definir política de reconciliação manual/legado; não gerar RETURNS ou correções automáticas.
- [FIX] O plano não exige audit `SYSTEM` para transições de worker, webhook, reconciliação e estorno -> incluir esses registros na mesma transação dos movimentos e transições financeiras.
- [FIX] `report_deliveries.sent_at` é gravado antes de a outbox ser enviada -> modelar a linha como reserva/enfileiramento ou rastrear `SENT` separadamente; não chamar uma reserva de entrega.
- [CLARIFY] “Cobrado” continua semanticamente indeterminado entre obrigação da OS, emissão externa e pagamento manual -> fixar métrica, status, data e regra de uma obrigação por OS para cada relatório.
- [CLARIFY] Cobranças históricas RECEIVED não têm data financeira nem parcelas recuperáveis -> definir migração e comportamento de relatório para legado sem inferir data a partir de `updated_at`.
- [FIX] O token Asaas é comparado com `!==`, contrariando a exigência de autenticação constant-time -> centralizar comparação segura para Asaas e Efí e cobrir rejeição sem persistência.
- [FIX] Retenção configurável pode apagar arquivos fora do escopo se não houver contrato de destino -> limitar remoção a diretório explícito e arquivos gerados, com escrita atômica, permissões e prova de restauração isolada.

VERDICT: NOT YET

### Coordinator response

- ACCEPTED: claim/lease/vínculo FIFO -> decisão 3 do plano.
- ACCEPTED: consulta vazia após efeito ambíguo não autoriza POST -> decisão 3, reconciliation-only.
- ACCEPTED: referência não usa count+1 -> decisão 3, alocação atômica única.
- ACCEPTED: ledger financeiro imutável -> decisão 4.
- ACCEPTED/USER DECISION: usuário escolheu `explicit_origin` no formulário: o fluxo pergunta pagamento por fora vs confirmação do gateway; só concilia o mesmo dinheiro com vínculo verificável -> decisões 1 e 2.
- ACCEPTED: valores/datas/semântica delta-cumulativa obrigatórios ou revisão -> decisão 4.
- ACCEPTED: devoluções Efí normalizadas por efeito econômico -> decisão 5.
- ACCEPTED: conjunto de providers habilitados distinto do padrão -> decisão 6.
- ACCEPTED: callback não associado reconciliável e anti-starvation -> decisão 7.
- ACCEPTED: agregação/locks/retorno líquido em SQL -> decisão 8.
- ACCEPTED: legado de estoque preservado e sem restituição automática não comprovada -> decisão 8; documentar reconciliação auditada.
- ACCEPTED: auditoria SYSTEM sem permissão WhatsApp -> decisão 9.
- ACCEPTED: reserva não é entrega -> decisão 10.
- ACCEPTED: Cobrado mede emissões externas válidas, separado de OS/recebimentos/saldo -> decisão 10.
- ACCEPTED: legado financeiro sem data não entra em período inventado; visível para conciliação -> decisão 11.
- ACCEPTED: tokens Asaas/Efí constant-time -> decisão 12.
- ACCEPTED: retenção só de arquivos próprios em destino explícito, com escrita atômica -> decisão 13.

### Execução

CLI 0.166.0. Primeira chamada terminou antes de abrir thread; segunda concluiu. Thread de review: `01a1d252-0a2d-70c3-b7f5-039b46d69d1e`. Baseline documental registrado em `c28cfc4`, sem código.

## Round 2

### Integrator findings (verbatim)

VERDICT: SAME PAGE

### Coordinator response

- ACCEPTED: plano aprovado; os 17 pontos da primeira rodada e a decisão explícita do usuário integram o contrato.
- Ajuste de ferramenta: o shell não preservou a função snap entre chamadas assíncronas. A segunda rodada reportou esse erro antes de executar Codex; a chamada permaneceu read-only e concluiu com aprovação. Nas próximas chamadas todo setup será definido no próprio comando, sem depender de funções/arrays anteriores.
- Execução em sandbox workspace-write, sem MCPs administrativos e com rede apenas para metadados/pacotes públicos/documentação. O modelo permanece gpt-5.6-terra; nada será aplicado à stack operacional.
- Prova final a cargo do coordenador, após os seis blocos integrados. Nenhum commit de código autorizado.
