# Controle do ciclo de correções

Escopo autorizado: correções do diagnóstico de 12/11/2026, via Codex `gpt-5.6-terra`, somente desenvolvimento/homologação. Plano canônico: RF-PLAN.md.

## Dentro do ciclo

- FIN-01: intenção durável e I/O fora da transação (alto).
- FIN-02: estados identificados bloqueiam cobrança duplicada (alto).
- FIN-03: parcelas e saldo devedor (alto).
- FIN-04: operar cobranças históricas pelo gateway persistido (alto).
- FIN-05: adotar recebimento com valor/data (alto).
- FIN-06: callback anterior à associação não se perde (médio).
- EST-01: consumo agregado e devolução correta (alto).
- EST-02: escolha ambígua não perde material/quantidade (alto).
- EST-03: retomada não duplica itens (alto).
- EFI-01: URL/certificado/OAuth/estados e fake aderente (alto).
- SEG-01: revogar aliases antigos (alto).
- SEG-02: dependências vulneráveis (alto).
- SEG-03: token Efí fora de logs (alto antes de ativar).
- OPS-01: DNS dinâmico do proxy (alto).
- OPS-02: configuração segura do backup/restore (médio).
- OPS-03: isolamento de ambiente herdado no verify (médio).
- OPS-04: agendamento/retenção configuráveis e prova de restauração (médio).
- REL-01: marcador e outbox atômicos (médio).
- REL-02: datas financeiras nos relatórios (médio).
- REL-03: totais sem tentativas inválidas e período semanal fechado (médio).
- UX vinculada: continuar após expiração numa mensagem e fallback Pix correto (médio).
- Ciclo financeiro vinculado: estornos/deduplicação/dados inválidos (alto).

## Fora deste ciclo de correções

- Nova integração de emissão automática NFS-e direta pelo Portal Nacional. A porta fiscal deve permanecer independente de Asaas; implementar essa integração exige ciclo próprio, contrato oficial e credenciais de teste.
- Nova integração boleto Efí, multioperador, painel ou troca de stack.
- Prova real Efí sem credenciais/certificado autorizados. Este ciclo deve corrigir e provar protocolo no ambiente isolado, sem chamar contas reais.
- Instalar cron/serviço no host ou configurar cópia externa de backup sem destino definido. Entregar mecanismo configurável e provar em diretório isolado; registrar que cópia externa real depende da configuração do ambiente.
- Automação de reenvio de UNCERTAIN: proibida; preservar revisão humana/auditoria. Ferramenta assistida nova de recuperação não integra este ciclo.

## Novos pedidos durante a execução

Registrar aqui para revisão; não alterar o escopo silenciosamente.

## Disposição da implementação (ciclo 12/11/2026)

Implementado no código e migração `202611120001_correction_cycle`:

- FIN-01, FIN-02, FIN-03, FIN-04, FIN-05 e FIN-06: worker com intenção/claim/lease, provider histórico habilitado separadamente, ledger imutável com origem explícita e eventos não associados reprocessáveis.
- EST-01, EST-02, EST-03 e UX vinculada: agregação/validação SQL, retorno líquido comprovado, fila ambígua persistida e retomada na primeira mensagem após expiração.
- EFI-01, SEG-01 e SEG-03: base Pix homologação, par mTLS obrigatório, OAuth/cancelamento normalizados, aliases sincronizados e proxy sem access log de query.
- REL-01, REL-02 e REL-03: reserva/outbox atômicas, data financeira no ledger, emissão externa válida e semanal agendado fechado.
- SEG-02 e OPS-01 a OPS-04: versões declaradas atualizadas, DNS runtime, parser seguro de env, isolamento explícito no verify e backup/retenção configuráveis.

Dependências externas que permanecem `PENDING` por desenho: homologação Efí real com certificado/conta autorizados; configuração de destino externo e agendador de backup no ambiente. Portal Nacional direto, boleto Efí, multioperador e UI administrativa continuam fora do ciclo.

## Prova integrada (coordenador, 12/11/2026)

`npm run verify`: 63 cenários PASS + VERIFY PASS (exit 0) — integração PostgreSQL, cadeia HTTP local real, webhook n8n importado e ativo, recuperação após reinício do Core, isolamento do proxy, enforcement de unique/FK e restore exato em banco novo.

Correções residuais do coordenador sobre a saída do Codex (todas cobertas pela prova):

- Compilação: exports `MessageRow`/`queueReply` + `PreparedAudio`/`applyPreparedAudio` em `domain.ts`; `ChargeWorkRow.status`; shorthand `expiracao` em `efi.ts`.
- `reset()` do teste: TRUNCATE incluía `financial_operations` e `financial_ledger` (FKs novas).
- `billing-event-worker.ts`: notificação enfileirada só quando o status da cobrança muda de fato (RECEIVED sobre já-RECEIVED não notifica de novo).
- Contratos de teste atualizados ao comportamento novo: datas futuras (10/12/2026; `paymentDate`/`horario` nos webhooks — sem data o evento vai a NEEDS_REVIEW por desenho), evento não associável permanece durável com retry (não finge processado), devolução Efí gera evento `REFUNDED` e estorna saldo no ledger.
