# WhatsCobranca — POC1

Registro de Ordens de Serviço por texto no WhatsApp, com confirmação explícita e sem duplicidade, usando uma instância [WAHA](https://waha.devlike.pro/) existente.

```text
WhatsApp → WAHA → webhook assinado (HMAC-SHA512) → inbox PostgreSQL
                                                         │
                                                         ▼
                                            n8n (acionador do tick)
                                                         │
                                                         ▼
                                   Core API (Fastify/TypeScript/Prisma)
                                                         │
                                                         ▼
                                           outbox PostgreSQL → WAHA → WhatsApp
```

Escopo desta POC: um operador autorizado, cadastro/busca de clientes, criação/correção/confirmação/cancelamento de Ordens de Serviço, consulta de histórico. **Fora de escopo:** extração por IA/LLM, transcrição de áudio, controle de estoque, cobrança (Asaas) e emissão fiscal — a conversa é 100% guiada por regras determinísticas, sem chamada a modelo de linguagem.

## Por que a conversa não usa IA

É uma escolha deliberada, não uma limitação temporária: validar a cadeia WAHA → Core API → PostgreSQL com uma máquina de estados determinística, auditável e testável antes de acoplar qualquer camada probabilística. Extração por IA é um ponto de extensão natural (ver `core-api/src/domain.ts`), mas exige sua própria validação de confiabilidade — não faz parte deste ciclo.

## Pré-requisitos

- Docker Engine com Compose **2.24.4 ou superior** (os overlays usam `!override`).
- Node.js 22+ no host (só para rodar os scripts; a aplicação roda inteira em containers).
- Uma instância WAHA já rodando, com uma sessão autenticada (ver [documentação do WAHA](https://waha.devlike.pro/docs/)).
- Um jeito de expor `POST /webhooks/waha` publicamente com HTTPS (reverse proxy, túnel Cloudflare, ngrok, etc.) — não incluso neste repositório.

## Subindo localmente

1. `npm run bootstrap:env` — gera `.env` com segredos aleatórios (`crypto.randomBytes`), permissão `600`. Não copie `.env.example` manualmente: ele só documenta o formato, os valores lá são placeholders inválidos.
2. Edite o `.env` gerado e preencha:
   - `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_SESSION` — da sua instância WAHA.
   - `OPERATOR_LID` e `OPERATOR_PHONE` — os identificadores literais do único operador autorizado (ver seção abaixo sobre `@lid`).
3. `docker compose up -d --build --wait --wait-timeout 240`.
4. Abra o n8n em `http://127.0.0.1:5678` e complete o cadastro do proprietário na primeira abertura (a versão fixada usa esse fluxo, não variáveis `N8N_BASIC_AUTH_*`).

| Serviço | Endereço local |
|---|---|
| Core API (health) | `http://127.0.0.1:8080/health` |
| n8n (editor) | `http://127.0.0.1:5678` |
| Proxy de entrada (só `POST /webhooks/waha`) | `http://127.0.0.1:8081/webhooks/waha` |
| PostgreSQL | `127.0.0.1:5433` |

Tudo publica só em loopback. Serviços persistentes usam `restart: unless-stopped`. Os volumes pertencem ao projeto Compose — nunca rode `down -v` com dados que importam.

As redes usam `10.245.210.0/24` (aplicação) e `10.245.211.0/24` (verificação) por padrão, para não disputar o pool automático de sub-redes do Docker com outros projetos no mesmo host. Em caso de conflito, defina `COMPOSE_SUBNET`/`VERIFY_SUBNET` no ambiente.

### Por que `@lid`, não só o telefone

O WAHA pode entregar o remetente como `@c.us` (telefone) ou `@lid` (identificador interno do WhatsApp), dependendo da sessão/região. **Descubra o valor real da sua sessão antes de configurar `OPERATOR_LID`**: mande uma mensagem de teste e confira `payload.from` no corpo do webhook, ou consulte `GET /api/{session}/chats/{chatId}/messages` na API do WAHA. Não assuma que o `@c.us` reconstruído a partir do telefone vai bater com o que a sessão realmente envia.

## Como funciona o n8n aqui

O Core API persiste a mensagem recebida e responde 200 imediatamente — **não** processa a conversa dentro do request do webhook. O n8n só existe para acionar `POST /automation/tick` (Bearer privado): um agendamento a cada 5 segundos recupera qualquer inbox pendente (inclusive após reinício do Core), e o próprio workflow expõe `POST /webhook/poc1-tick` para acionamento manual local. O n8n não roda nenhuma lógica de negócio — isso fica inteiramente na Core API, numa única transação por mensagem.

O `n8n-init` importa o workflow canônico (`n8n/workflows/poc1-tick.json`) e o ativa via CLI antes do `n8n` subir. Para reaplicar o workflow depois de editá-lo: pare o `n8n`, rode `docker compose run --rm n8n-init` e suba o `n8n` de novo. Não ative workflow pelo CLI com o servidor já rodando.

## Expondo o webhook publicamente

Esta POC não inclui reverse proxy público. Use o que já existir na sua infraestrutura (Cloudflare Tunnel, nginx com TLS, ngrok para teste) apontando **somente** para `http://127.0.0.1:8081` — essa porta já só aceita `POST /webhooks/waha` e devolve 404 para qualquer outro caminho/método.

Depois de ter uma URL pública com HTTPS, configure a sessão no WAHA preservando o restante da config (`PUT /api/sessions/{session}`, mesclando `config.webhooks`, nunca substituindo o objeto inteiro):

```json
{
  "config": {
    "webhooks": [
      {
        "url": "https://SEU-DOMINIO/webhooks/waha",
        "events": ["message"],
        "hmac": { "key": "o mesmo valor de WAHA_WEBHOOK_SECRET do seu .env" }
      }
    ]
  }
}
```

A API valida `X-Webhook-Hmac` (HMAC-SHA512 hexadecimal sobre os bytes **originais** do corpo, comparação constant-time) e rejeita com 401 se faltar ou não bater. Limite de corpo: 131072 bytes (128 KiB) por padrão. Envelope autenticado mas malformado: 400, sem efeito colateral. Apenas os aliases literais em `OPERATOR_LID`/`OPERATOR_PHONE` são autorizados — sessões erradas, grupos, mensagens próprias e remetentes desconhecidos são ignorados sem criar estado.

## Conversa

Sem IA — gramática fixa, em português:

- `novo` ou qualquer texto livre inicia um atendimento (o texto vira a descrição).
- Perguntas sequenciais: cliente → valor. Cliente ambíguo oferece lista numerada; cliente inexistente oferece cadastro.
- `corrigir valor 150,00`, `corrigir descrição ...` — só antes de confirmar.
- `sim` / `confirmo` / `ok` confirma a pendência atual (válida por 30 minutos); `cancelar` cancela com motivo registrado em auditoria.
- `OS 12`, `mostra as OS do <nome>`, `o que fiz hoje?`, `ajuda` — consultas, sempre respondidas a partir do PostgreSQL, nunca do histórico da conversa.

Dinheiro é sempre `Int` em centavos — nunca ponto flutuante. `150`, `150,00` e `R$ 150` são aceitos; valores negativos, ambíguos ou com mais de duas casas decimais são rejeitados sem alterar o estado.

## Verificação isolada

```sh
npm run verify
```

Roda um projeto Compose separado (`whatscobranca_verify`), ignora o `.env` real (`--env-file /dev/null`), usa um WAHA HTTP falso isolado e nunca chama a API WAHA de verdade. Cobre: HMAC/schema/allowlist, deduplicação sob concorrência, fluxo guiado completo, correção, confirmação idempotente, consulta por cliente/dia, mídia/texto vazio, expiração, workflow n8n importado e ativo processando uma inbox pendente real, recuperação após reiniciar o Core, constraints de unicidade/FK no PostgreSQL, e restauração de backup em banco novo com valores conferidos. Só reseta os três bancos nomeados **whatscobranca_verify\***, nunca o banco operacional.

## Falhas e incerteza

Inbox e outbox vivem inteiramente no PostgreSQL — reiniciar Core ou n8n não resolve uma pendência por si só. Para inspecionar:

```sh
docker compose exec postgres psql -U whatscobranca -d whatscobranca \
  -c "SELECT id, message_id, state, attempts, last_error FROM webhook_events WHERE state <> 'PROCESSED' ORDER BY position;" \
  -c "SELECT id, reply_to, status, attempts, provider_message_id, last_error FROM outbound_messages WHERE status <> 'SENT' ORDER BY position;"
```

- **Inbox** (`webhook_events`): erro de engine/DB reverte os efeitos da mensagem; depois de 5 tentativas vira `FAILED` visível. Corrija a causa antes de reabrir como `PENDING` manualmente, registrando a decisão em `audit_logs`.
- **Outbox** (`outbound_messages`): rejeição comprovada pelo provedor permite até 5 tentativas antes de `FAILED`. Timeout, socket encerrado ou lease vencida após interrupção ficam `UNCERTAIN` — isso **não comprova falha de entrega**; o sistema nunca reenvia automaticamente um `UNCERTAIN`, e uma saída não entregue (`PENDING`/`LEASED`/`FAILED`/`UNCERTAIN`) bloqueia a próxima mensagem desse operador até resolução manual.
- Para resolver um `UNCERTAIN`: pare o n8n, confira `provider_message_id`/histórico no WAHA, e atualize `status`+`sent_at` (ou reabra como `PENDING`) e grave em `audit_logs` na mesma transação, com justificativa real. Não há endpoint para isso nesta POC — é manutenção manual por SQL.

## Backup e restauração

```sh
npm run backup                                          # gera backups/*.dump (permissão 600)
npm run restore -- backups/arquivo.dump nome_banco_novo  # restaura em banco NOVO
```

O restore recusa o banco operacional, qualquer banco de sistema e **qualquer destino já existente** — nunca sobrescreve. O dump cobre só o schema `public` (domínio da aplicação); o schema `n8n` volta pelo bootstrap do workflow canônico.

## Referência da API

Ver [`openapi.yaml`](openapi.yaml) — três rotas: `GET /health`, `POST /webhooks/waha` (pública, atrás do proxy) e `POST /automation/tick` (privada, Bearer).

## Para quem for estender isto

Ver [`AGENTS.md`](AGENTS.md) para os invariantes de domínio (dinheiro em centavos, deduplicação, transações, matriz de transição de status) antes de mexer em `core-api/src/domain.ts`.

## Licença

[MIT](LICENSE).
