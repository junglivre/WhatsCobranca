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
