# Correções da revisão de 12/11/2026

## Foco
Corrigir integridade financeira e de estoque, segurança, integrações e operação do WhatsCobranca em homologação, mantendo cobrança e emissão fiscal independentes e permitindo operar cobranças históricas após trocar o gateway padrão.

Executor: Codex CLI, modelo `gpt-5.6-terra`, esforço `xhigh`. Coordenador: esta sessão. Diagnóstico/evidências: `SAME-PAGE-LOG.md`, seção Revisão geral (2026-11-12). Os achados são hipóteses estáticas a confirmar no código; corrigir a causa, não contornar os exemplos.

## Limites obrigatórios
- Somente desenvolvimento e verificação isolada. Não alterar `.env`, credenciais, dados/containers operacionais, webhooks existentes, túnel ou sessões WhatsApp; não enviar mensagens nem chamar provedores reais.
- Nunca ler/imprimir segredos. Não acessar MCPs administrativos, GLPI ou WhatsApp para este ciclo. Não fazer SSH.
- Sem commits/push/deploy pelo executor. O coordenador pode registrar baseline apenas de documentação/planejamento conhecidos, antes da implementação. Commit de código depende do usuário.
- Migrações incrementais, sem apagar histórico financeiro/estoque. Sem reset ou down -v do projeto operacional. Os dois projetos Compose e seus volumes são distintos.
- Reusar portas e padrões existentes. Nenhum acoplamento obrigatório ao Asaas. Não ampliar para multioperador, painel, outro framework, boleto Efí ou emissão automática NFS-e neste ciclo.
- Não introduzir shims, mocks em produção, retries cegos de cobrança, silenciamento de falhas ou fallbacks que anunciem sucesso inexistente.
- O executor implementa todos os seis blocos antes de rodar build/lint/testes/formatadores. O coordenador executa a prova integrada uma vez ao final. Em correções da prova, executar apenas a verificação que cobre a falha.
- Atualizar documentação e contratos conforme o comportamento implementado, preservando fatos históricos. Só afirmar homologação real Efí se houver prova real; este ciclo não dispõe de credenciais/certificado Efí autorizados para uso.

## Rock 1 — Intenções duráveis e I/O fora da transação
Achados: FIN-01, FIN-05, FIN-06 e parte FIN-04.
Arquivos centrais: core-api/src/app.ts, domain.ts, providers/billing/types.ts, providers/registry.ts, schema/migrations e testes.
- Persistir intenção e referência estável antes de qualquer efeito externo. Claim e finalização em transações curtas; chamadas WAHA/Groq/gateways/emissor fora da transação da inbox. Não aumentar simplesmente o timeout Prisma.
- Reinício/timeout não pode perder intenção nem enviar outro POST antes de reconciliar a mesma referência. Resolver resultados incertos de forma explícita e observável; não tratar consulta falha como ausência comprovada.
- Manter FIFO por operador, dedup persistente, garantia contra ticks concorrentes e a política UNCERTAIN da outbox.
- Não finalizar definitivamente evento de cobrança ainda não associável. Evitar que um evento desconhecido bloqueie os eventos associáveis seguintes. Preservar payload/evidência para conciliação.
- Snapshots de criação/reconciliação incluem valor efetivamente recebido e data financeira quando disponíveis; adotar cobrança já RECEIVED não pode contabilizar zero nem anunciar cobrança nova aberta.
Pronto: atraso externo superior a cinco segundos e reinício entre etapas não duplicam cobrança, não perdem estado e não deixam transação longa aberta; áudio lento também completa ou registra falha recuperável.
Prova na execução integrada: cenários determinísticos de create-accepted/response-delayed, retomada da intenção, dois ticks concorrentes, callback antes da associação e snapshot já recebido.

## Rock 2 — Estados financeiros, parcelas e troca de gateway
Achados: FIN-02, FIN-03, FIN-04, lacunas de estorno e valores financeiros.
- Unificar critérios de obrigação/saldo e cobrança ativa. CONFIRMED, PARTIALLY_PAID e recebimentos existentes devem impedir nova cobrança integral duplicada. OS com pagamento identificado ou obrigação externa ainda ativa não deve ser cancelada como se estivesse livre.
- `recebi OS n valor` registra parcela confirmada e auditada; manter o saldo devedor visível até quitação. Parcela complementar acumula sem apagar o histórico; rejeitar valor manual acima do saldo com explicação, não truncar silenciosamente.
- Preservar contrato de reconciliação: uma baixa manual de uma cobrança e seu callback posterior de quitação não contam duas vezes o mesmo pagamento. Distinguir parcela manual incremental de snapshots cumulativos do gateway. Documentar a semântica escolhida; sinalizar ambiguidades materiais no review antes de implementar.
- Sem cobrança externa, pagamentos manuais também preservam a relação com o total da OS e o saldo restante. Cobrar um saldo após pagamento parcial não pode cobrar o valor integral de novo.
- Estorno confirmado após RECEIVED é movimento financeiro legítimo: registrar data/valor e refletir saldo líquido/estado sem aceitar regressões por eventos antigos PENDING/OVERDUE. Deduplicar recebimentos/estornos por origem; não inventar pagamento integral quando o evento tiver valor inválido/ausente.
- Separar provider padrão de criação dos providers habilitados para operar histórico. Webhooks antigos continuam autenticados quando o padrão muda; cancelamento resolve pelo provider persistido. Sem credenciais do provider histórico, responder erro acionável e preservar estado, nunca sucesso local falso.
Pronto: parcial de R$50 numa OS de R$150 deixa R$100 em aberto, complemento quita, callback de confirmação não duplica valores; pagamento confirmado bloqueia duplicação; troca de Asaas para Efí conserva callbacks/cancelamento Asaas; estorno reduz recebido líquido.
Prova integrada: CONFIRMED→cobrar/cancelar OS, parcelas/complemento/callback, manual sem gateway, saldo após parcial, reembolso/reentrega/evento antigo, troca de padrão e credenciais históricas ausentes.

## Rock 3 — Estoque e retomada consistentes
Achados: EST-01, EST-02, EST-03; UX de retomada/fallback Pix.
- Agregar consumo pelo material; bloquear insuficiência total; só registrar OUT se a baixa correspondente ocorreu. Cancelamento só devolve consumo efetivo ainda não devolvido. Material repetido não infla saldo nem ledger.
- Persistir corretamente item atual/quantidade durante a escolha de material ambíguo; não perder nem deslocar o próximo item da fila.
- Retomar OS a partir de dados persistidos sem reinserir materiais preexistentes. A primeira mensagem `continuar OS n` depois da expiração deve executar o comando, não exigir repetição; não reutilizar payload vencido.
- Fallback de Pix deve identificar Pix e a indisponibilidade, não anunciar boleto.
Pronto: saldo 10 + lista 6 cabo/6 cabo bloqueia; caso viável baixa total e devolve uma vez; escolha ambígua preserva itens; áudio com materiais sem valor sobrevive à expiração e confirmação sem duplicar.
Prova integrada: regressões acima, incluindo material ambíguo único/seguido de outro, devolução parcial seguida de cancelamento, retomada após expiração com itens existentes.

## Rock 4 — Efí aderente ao contrato e identidade segura
Achados: EFI-01, SEG-01, SEG-03.
- Base Pix homologação `https://pix-h.api.efipay.com.br` em config, Compose, exemplo e docs. Não apontar para produção.
- Certificado/chave Efí do ambiente obrigatórios e válidos no boot quando provider habilitado. Fake deve exercitar HTTPS/mTLS com certificado de teste isolado, não exigir exceção de produção para testes.
- OAuth Basic/client_credentials conforme contrato oficial; usar corpo JSON documentado. Cancelamento `REMOVIDA_PELO_USUARIO_RECEBEDOR`; mapear também `REMOVIDA_PELO_PSP`; não converter estados desconhecidos em sucesso financeiro.
- Expiração efetiva e vencimento exibido não devem divergir silenciosamente: rejeitar datas fora da faixa suportada ou usar recurso correto, com mensagem determinística.
- Validar payload financeiro e centavos; dados inválidos não podem quitar pelo fallback value_cents. Preservar eventos para diagnóstico sem segredos.
- Sincronizar aliases configurados para que a troca de operador revogue os anteriores, sem perder auditoria/histórico.
- Redigir token/query nos logs de proxy/API e nas mensagens de erro. Manter autenticação constant-time e formato oficial de registro de webhook; skip-mTLS de entrada não dispensa mTLS de saída.
Fontes: https://dev.efipay.com.br/docs/api-pix/credenciais ; https://dev.efipay.com.br/docs/api-pix/status ; https://dev.efipay.com.br/docs/api-pix/cobrancas-imediatas ; https://dev.efipay.com.br/docs/api-pix/webhooks .
Pronto: fake baseado no contrato real prova OAuth/certificado/criar/consultar/callback/cancelar e rejeita o protocolo anterior; aliases antigos deixam de autorizar. Documentação distingue essa prova da homologação real ainda indisponível.
Prova integrada: HTTPS/mTLS isolado, par de certificado ausente/inválido, cancelamento/mapeamento oficial, valores malformados, datas fora da faixa, rotação de identidade, ausência de token nos logs capturados com segredo fictício.

## Rock 5 — Relatórios financeiros e entrega atômica
Achados: REL-01, REL-02, REL-03.
- Marcador do período e outbox na mesma transação; falha intermediária permite recuperação, sem duplicação.
- Relatórios usam datas financeiras persistidas, não updated_at. Parcelas e estornos entram no período correto e no total líquido, inclusive callback atrasado.
- “Cobrado” distingue cobrança válida de tentativa ERROR/DRAFT/cancelada; não somar registros manuais e gateway como obrigações duplicadas da mesma OS. Explicitar bruto/líquido conforme necessário, sem números enganosos.
- Comando semanal sob demanda pode continuar parcial da semana atual. Agendamento semanal fecha a semana anterior completa, com período e chave explícitos em America/Sao_Paulo.
Pronto: falha entre reserva e enqueue não suprime relatório; atraso de callback e fronteiras de semana não mudam a data financeira; totais batem com parcelas/estornos e não contam tentativas inválidas.
Prova integrada: rollback antes da outbox, tick repetido, limites domingo/segunda com relógio controlado, ERROR/CANCELED e pagamentos parciais/reembolso.

## Rock 6 — Dependências e operação isolada
Achados: SEG-02, OPS-01, OPS-02, OPS-03, OPS-04.
- Atualizar Fastify/Zod e imagem n8n para versões mantidas que eliminem os avisos aplicáveis conhecidos. Revisar compatibilidade dos parsers, CLI de import/ativação, variável do token no workflow e agendamento; não usar audit fix --force. Atualizar outros componentes vulneráveis se o levantamento direcionado exigir, sem upgrade indiscriminado.
- Nginx deve resolver DNS Docker em runtime após recriar core-api sem reiniciar proxy; preservar allowlist de caminhos/métodos, query Efí e segredo fora dos logs.
- Backup/restore não executam source do arquivo Compose. Configuração por um mecanismo consistente, preservando dólares/quoting sem imprimir credenciais; restore continua recusando banco existente/operacional/sistema.
- Verificação neutraliza todos os providers/segredos operacionais herdados e só usa os fakes; implementar prova com ambiente herdado adverso. Nunca exportar variáveis de debug no shell persistente do coordenador.
- Fornecer agendamento/retencão de backup configurável e seguro com destino externo configurável sem impor serviço terceiro. Não configurar cron/serviço no host nem inventar destino fora do host; testar em diretório descartável e documentar a configuração exigida para armazenamento externo, permissões e recuperação.
Pronto: `npm run verify` prova cadeia HTTP/n8n, recriação DNS (não só restart com mesmo IP), backup/restore com valores especiais e isolamento adverso; auditoria direcionada atualizada e limites residuais explicados.
Prova final: `npm run verify` no projeto isolado, `npm audit --omit=dev --json` e smoke do agendamento/retenção em destino descartável. Nada toca a stack operacional.

## Prova e entrega
O executor NÃO roda checks no meio das alterações nem duplica a prova do coordenador. Entrega inventário de arquivos, migrações, decisões, desvios, lista de cenários adicionados e comandos exatos a executar. O coordenador verifica a implementação e roda a prova integrada após todos os blocos; corrigirá falhas pelo mesmo thread, até duas rodadas consolidadas.

Atualizar README/OpenAPI/CHANGELOG e o diagnóstico com status por ID. Separar bug corrigido/prova automatizada de validação Efí real e configuração externa de backup ainda dependentes do ambiente. Não apresentar uma melhoria documentada como funcionalidade executada. Sem código stub, placeholder ou TODO para itens deste plano.

## Decisões de conciliação e precisão após revisão 1

Estas regras complementam os seis blocos e resolvem as objeções do integrador; prevalecem sobre qualquer expressão ambígua acima.

1. **Origem explícita, escolhida pelo usuário:** quando `recebi` encontra cobrança externa, o próprio fluxo pergunta se é recebimento por fora ou confirmação de pagamento do gateway. Para confirmar o mesmo dinheiro do gateway, exigir vínculo verificável ao pagamento/snapshot com identificação estável e valor/data do provedor; sem comprovação, registrar pendência de revisão sem quitar. O callback posterior deve deduplicar pelo mesmo vínculo. Não confundir uma afirmação manual com prova de recebimento externo.
2. **Pagamento por fora é distinto:** parcela externa soma como movimento próprio e reduz saldo devedor da OS, mas não cancela silenciosamente cobrança no gateway. Se esta permanece aberta por valor maior que o saldo, alertar de forma explícita e exigir cancelamento/ajuste antes de nova cobrança. Um pagamento posterior realmente distinto do gateway soma como novo dinheiro; mostrar eventual excedente/crédito, sem truncar. Nada disso autoriza operar contas reais neste ciclo.
3. **Worker financeiro durável:** operação vinculada de forma única à mensagem/ação de confirmação, referência alocada atomicamente no banco (não count+1), estados/claim/lease/erros e finalização condicional. A inbox/FIFO da ação permanece bloqueada até enfileirar a resposta final, sem transação aberta durante I/O. Claim expirado recupera por reconciliação; resultado externo ambíguo fica reconciliation-only/UNCERTAIN, sem novo POST automático, mesmo se a consulta retornar vazia antes de consistência.
4. **Ledger financeiro imutável:** direção RECEIPT/REFUND, centavos positivos, data financeira verificável, origem, vínculo ao pagamento/cobrança e chave idempotente por efeito econômico. Eventos carregam valor, data, identificador e semântica delta/cumulativa; cada adapter deve normalizar esses conceitos. Não inferir recebimento integral nem usar now/updated_at como data financeira ausente. Payload insuficiente vai para revisão, preservando evidências e não bloqueando eventos associáveis.
5. **Efí devoluções:** normalizar cada devolução confirmada por identificador, valor/data e vínculo ao Pix; suportar estorno parcial/integral/replay sem descartar a entrada original nem reaplicar recebimento ao receber uma notificação de devolução.
6. **Providers habilitados:** configurar explicitamente o conjunto habilitado para webhooks/operações históricas, separado do padrão de novas cobranças. Conservar compatibilidade da configuração existente com apenas o padrão. Credencial histórica ausente não permite cancelamento falso nem aceitação sem autenticação; resposta acionável e estado preservado. Não exigir credenciais de gateways que não estão habilitados.
7. **Eventos ainda sem vínculo:** estado durável, claim/lease e próxima tentativa sem espera bloqueante. Seleção prioriza eventos associáveis; estacionados desconhecidos não bloqueiam a fila nem são descartados definitivamente.
8. **SQL e estoque legado:** agregação GROUP BY/SUM e cálculos no SQL numeric; locks em ordem estável e baixa/ledger na mesma transação. Cancelamento devolve apenas consumo líquido comprovado, descontadas devoluções anteriores. Dados anteriores ao fix não comprovam a baixa real quando atingidos pelo defeito: preservar saldos e registros, marcar proveniência/necessidade de revisão e bloquear somente restituição automática não comprovável. Documentar procedimento auditado de reconciliação manual; nunca inventar correção retroativa nem devolver com base apenas em OUT legado suspeito.
9. **Auditoria:** worker, webhook, reconciliação, parcela e estorno registram transições/movimentos na mesma transação com ator SYSTEM distinguível do operador, origem e referência; nenhuma identidade SYSTEM pode ganhar permissão WhatsApp.
10. **Relatórios sem falsa precisão:** renomear/modelar `report_deliveries` como reserva/enfileiramento, ou separar queued_at de sent_at real; só chamar entregue após SENT da outbox. Métrica “Cobrado” = emissões externas válidas efetivamente criadas, com data de criação verificada, sem ERROR/DRAFT/CANCELED nem lançamentos manuais de recebimento; distinguir dessa métrica o valor das OS e o saldo atual. Emissões múltiplas históricas da mesma obrigação não podem duplicar saldo devedor. Recebimentos/estornos usam o ledger, sem contar snapshots repetidos.
11. **Legado financeiro:** preservar valores e estado conhecidos, sem inferir data a partir de updated_at. Recuperar dados apenas de evidências persistidas suficientes e verificáveis; registrar origem da migração. Sem prova de data/parcelas, manter parcela histórica não datada identificada como “legado a conciliar”, fora de totais por período e visível separadamente no saldo/resumo. Não zerar dinheiro conhecido nem apresentar totals parciais como completos.
12. **Autenticação:** comparação constant-time para tokens Asaas e Efí, com rejeição sem persistência. Não limitar o fix a Efí.
13. **Retenção:** diretório explicitamente configurado, arquivo gerado com prefixo/formato próprios, escrita temporária seguida de rename atômico, permissões restritas; retenção só remove backups produzidos pelo mecanismo naquele diretório. Não seguir symlinks nem remover arquivos arbitrários. Falha de dump não promove arquivo incompleto nem elimina último backup válido.
