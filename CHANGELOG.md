# Changelog

## 0.1.0 — POC1

- Stack Docker Compose isolada com PostgreSQL, Core Fastify/TypeScript/Prisma, n8n e proxy webhook-only.
- Migração PostgreSQL para inbox/outbox duráveis, aliases autorizados, clientes, OS, conversa e auditoria.
- Webhook HMAC SHA-512 em bytes brutos, deduplicação persistente, tick autenticado, locks por operador e entrega WAHA HTTP com lease/UNCERTAIN.
- Fluxo guiado de texto, consulta, correção, confirmação/cancelamento, expiração, backup/restore e verificação integrada isolada.
- Bootstrap n8n com CLI import/activate, id estável, schema próprio e recuperação a cada cinco segundos; serviços persistentes com restart `unless-stopped`.
- Imagem Core inclui testes; overlay substitui portas com `!override`. Verificação ignora `.env` operacional e testa HTTP/n8n/reinício contra provedor isolado com ledger e provider id.
- Restore exige banco novo, recusa destino existente e compara dados reconhecíveis na prova; dump de domínio não inclui schema n8n.
- Runbook de falhas/UNCERTAIN e túnel temporário; OpenAPI explicita HMAC, body limit e Bearer do tick. Execução integrada e validação pelo aparelho cabem ao supervisor.
- Verificação executada pelo supervisor: 12 cenários comportamentais e smoke completo da stack passaram, incluindo restauração em banco novo. Entrada genuína pelo aparelho ainda aguarda o operador.
- Correções de integração: provider id NOWEB em `key.id`, sequência persistente das filas, bloqueio de conversa após entrega incerta, busca parcial e consultas sem cadastro implícito, negativa no cadastro e correções sem rascunho.
- Redes próprias configuráveis evitam esgotar o pool automático do host; testes preservam redes/volumes operacionais e o restore recusa destinos existentes.
