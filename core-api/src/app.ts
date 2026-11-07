import Fastify from 'fastify';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { config, type Config } from './config.js';
import { dailyCloseBody, mondayOf, processMessage, queueNotice, spNowParts, weeklyReportBody } from './domain.js';
import { validHmac, sendWaha, SendFailure } from './waha.js';
import { formatMoney, osLabel } from './types.js';
import { getBillingProvider } from './providers/registry.js';
import { WebhookAuthError, type NormalizedBillingEvent } from './providers/billing/types.js';

type OperatorRow = { id: string };
type IdentityRow = { operator_id: string };
type EventRow = { id: string; message_db_id: string };
type OutboundRow = { id: string; reply_to: string; body: string };

const envelopeSchema = z.object({
  id: z.string().min(1),
  session: z.string(),
  event: z.literal('message'),
  payload: z.object({
    id: z.string().min(1),
    from: z.string().min(1),
    fromMe: z.boolean(),
    // body pode ser null em mensagens de mídia sem legenda (verificado em produção).
    body: z.string().nullable(),
    hasMedia: z.boolean(),
    media: z.object({ url: z.string().min(1), mimetype: z.string() }).partial().nullish(),
  }),
});

type WahaEnvelope = {
  id: string;
  session: string;
  payload: {
    id: string;
    from: string;
    fromMe: boolean;
    body: string; // normalizado: null (mídia sem legenda) vira ''
    hasMedia: boolean;
    mediaMimetype: string | null;
    mediaPath: string | null; // path de media.url, para download interno
  };
};

function parseEnvelope(raw: Buffer): { parseOk: boolean; envelope: WahaEnvelope | null } {
  let json: unknown;
  let parseOk = true;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    parseOk = false;
  }
  if (!parseOk) return { parseOk, envelope: null };
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return { parseOk, envelope: null };
  const { id, session, payload } = parsed.data;
  let mediaPath: string | null = null;
  if (payload.media?.url) {
    try {
      mediaPath = new URL(payload.media.url).pathname;
    } catch {
      mediaPath = null;
    }
  }
  return {
    parseOk,
    envelope: {
      id,
      session,
      payload: {
        id: payload.id,
        from: payload.from,
        fromMe: payload.fromMe,
        body: payload.body ?? '',
        hasMedia: payload.hasMedia,
        mediaMimetype: payload.media?.mimetype ?? null,
        mediaPath,
      },
    },
  };
}

async function ensureOperator(prisma: PrismaClient, cfg: Config): Promise<void> {
  const created = await prisma.$queryRawUnsafe<OperatorRow[]>(
    "INSERT INTO operators(label) VALUES('operador-poc1') ON CONFLICT (label) DO NOTHING RETURNING id",
  );
  const operator = created[0] ?? (await prisma.$queryRawUnsafe<OperatorRow[]>(
    "SELECT id FROM operators WHERE label='operador-poc1'",
  ))[0];
  if (!operator) throw new Error('POC operator was not created');

  for (const value of [cfg.OPERATOR_LID, cfg.OPERATOR_PHONE]) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO whatsapp_identities(value, operator_id) VALUES($1, $2::uuid) ON CONFLICT(value) DO NOTHING',
      value,
      operator.id,
    );
  }
}

async function processPendingEvent(prisma: PrismaClient, cfg: Config): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // The POC has one operator. A transaction-scoped mutex serializes inbox
    // state changes without keeping a transaction open during provider I/O.
    const [lock] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
      'SELECT pg_try_advisory_xact_lock(1913782947) AS locked',
    );
    if (!lock?.locked) return false;
    const events = await tx.$queryRawUnsafe<EventRow[]>(
      `SELECT event.id, event.message_db_id
         FROM webhook_events AS event
         JOIN messages AS message ON message.id=event.message_db_id
        WHERE event.state='PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM webhook_events AS earlier
              JOIN messages AS previous ON previous.id=earlier.message_db_id
             WHERE previous.operator_id=message.operator_id
               AND earlier.position < event.position AND earlier.state <> 'PROCESSED'
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbound_messages AS reply
             WHERE reply.operator_id=message.operator_id AND reply.status <> 'SENT'
          )
        ORDER BY event.position FOR UPDATE OF event SKIP LOCKED LIMIT 1`,
    );
    const event = events[0];
    if (!event) return false;

    await tx.$executeRawUnsafe('SAVEPOINT message_processing');
    try {
      await processMessage(tx, event, cfg);
      await tx.$executeRawUnsafe(
        "UPDATE webhook_events SET state='PROCESSED', processed_at=now(), last_error=NULL WHERE id=$1::uuid",
        event.id,
      );
      return true;
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT message_processing');
      const message = error instanceof Error ? error.message : 'engine_error';
      await tx.$executeRawUnsafe(
        `UPDATE webhook_events
           SET attempts=attempts+1, last_error=$2,
               state=CASE WHEN attempts+1 >= 5 THEN 'FAILED' ELSE 'PENDING' END
         WHERE id=$1::uuid`,
        event.id,
        message,
      );
      return false;
    }
  });
}

async function claimOutbound(prisma: PrismaClient): Promise<OutboundRow | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE outbound_messages SET status='UNCERTAIN', lease_until=NULL,
         last_error='Delivery worker interrupted; verify provider before retry'
       WHERE status='LEASED' AND lease_until < now()`,
    );
    const rows = await tx.$queryRawUnsafe<OutboundRow[]>(
      `SELECT outbound.id, outbound.reply_to, outbound.body
         FROM outbound_messages AS outbound
        WHERE outbound.status='PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM outbound_messages AS earlier
             WHERE earlier.operator_id=outbound.operator_id
               AND earlier.position < outbound.position
               AND earlier.status <> 'SENT'
          )
        ORDER BY outbound.position FOR UPDATE OF outbound SKIP LOCKED LIMIT 1`,
    );
    const outbound = rows[0];
    if (!outbound) return null;
    await tx.$executeRawUnsafe(
      "UPDATE outbound_messages SET status='LEASED', lease_until=now()+interval '30 seconds', attempts=attempts+1 WHERE id=$1::uuid",
      outbound.id,
    );
    return outbound;
  });
}

async function deliver(prisma: PrismaClient, cfg: Config): Promise<number> {
  let sent = 0;
  for (let index = 0; index < 50; index += 1) {
    const outbound = await claimOutbound(prisma);
    if (!outbound) break;
    try {
      const result = await sendWaha(cfg, outbound.reply_to, outbound.body);
      await prisma.$executeRawUnsafe(
        "UPDATE outbound_messages SET status='SENT', provider_message_id=$2, sent_at=now(), lease_until=NULL WHERE id=$1::uuid",
        outbound.id,
        result.id,
      );
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'send_error';
      const status = error instanceof SendFailure && error.outcome === 'REJECTED' ? 'PENDING' : 'UNCERTAIN';
      await prisma.$executeRawUnsafe(
        `UPDATE outbound_messages
            SET status=CASE WHEN $2='PENDING' AND attempts>=5 THEN 'FAILED' ELSE $2 END,
                last_error=$3, lease_until=NULL
          WHERE id=$1::uuid`,
        outbound.id,
        status,
        message,
      );
      // At most one attempt per tick; future sends for this operator remain
      // blocked until this prompt has a known delivery outcome.
      break;
    }
  }
  return sent;
}

// ===== Fase 6: processamento assíncrono de billing_events no tick =====
//
// O webhook só persiste (dedup por UNIQUE(provider, provider_event_id)) e
// responde 200; o tick aplica as transições em ordem `position`:
//   RECEIVED  ← PENDING/OVERDUE/CONFIRMED (grava paid_value_cents)
//   OVERDUE   ← PENDING
//   CONFIRMED ← PENDING/OVERDUE
//   CANCELED/REFUNDED ← qualquer estado exceto RECEIVED
// RECEIVED nunca é rebaixado (UPDATE condicional não casa) — um 'recebi'
// manual anterior torna o webhook RECEIVED posterior um no-op.
// Notificação ao operador SÓ quando o status muda para RECEIVED/OVERDUE/
// CANCELED/REFUNDED, com dedup_key por transição (webhook + sweep não
// duplicam aviso).

type BillingEventRow = { id: string; provider: string; event_type: string; payload: unknown };
type ChargeNoticeRow = {
  id: string;
  service_order_id: string;
  value_cents: number;
  paid_value_cents: number | null;
  due_date: Date | string | null;
  number: number;
};

function dueShort(value: Date | string | null): string {
  if (value === null) return '—';
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' }).slice(0, 5);
}

function billingNoticeBody(status: string, charge: ChargeNoticeRow): string {
  const label = osLabel(charge.number);
  switch (status) {
    case 'RECEIVED':
      return `Cobrança ${label} recebida: ${formatMoney(charge.paid_value_cents ?? charge.value_cents)}`;
    case 'OVERDUE':
      return `Cobrança ${label} vencida (${formatMoney(charge.value_cents)}, venceu ${dueShort(charge.due_date)})`;
    case 'CANCELED':
      return `Cobrança ${label} cancelada.`;
    default:
      return `Cobrança ${label} estornada (${formatMoney(charge.value_cents)}).`;
  }
}

async function processBillingEvents(prisma: PrismaClient, cfg: Config, operator: OperatorRow): Promise<number> {
  const events = await prisma.$queryRawUnsafe<BillingEventRow[]>(
    'SELECT id, provider, event_type, payload FROM billing_events WHERE NOT processed ORDER BY position LIMIT 20',
  );
  let processed = 0;
  for (const event of events) {
    const normalized = event.payload as NormalizedBillingEvent;
    await prisma.$transaction(async (tx) => {
      const charges = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM charges WHERE provider=$1 AND provider_charge_id=$2',
        event.provider, normalized.providerChargeId,
      );
      const charge = charges[0];
      const returning = `RETURNING id, service_order_id, value_cents, paid_value_cents, due_date,
                   (SELECT number FROM service_orders WHERE id=charges.service_order_id) AS number`;
      // [novo status, transição permitida de...] — UPDATE condicional: sem
      // linha retornada o evento é no-op (RECEIVED nunca é rebaixado).
      let newStatus: 'RECEIVED' | 'OVERDUE' | 'CONFIRMED' | 'CANCELED' | 'REFUNDED' | null = null;
      let transitioned: ChargeNoticeRow | undefined;
      if (charge && normalized.type === 'RECEIVED') {
        newStatus = 'RECEIVED';
        transitioned = (await tx.$queryRawUnsafe<ChargeNoticeRow[]>(
          `UPDATE charges SET status='RECEIVED',
                  paid_value_cents=COALESCE($2, paid_value_cents, value_cents), updated_at=now()
            WHERE id=$1::uuid AND status IN ('PENDING','OVERDUE','CONFIRMED') ${returning}`,
          charge.id, normalized.paidValueCents ?? null,
        ))[0];
      } else if (charge && normalized.type === 'OVERDUE') {
        newStatus = 'OVERDUE';
        transitioned = (await tx.$queryRawUnsafe<ChargeNoticeRow[]>(
          `UPDATE charges SET status='OVERDUE', updated_at=now()
            WHERE id=$1::uuid AND status='PENDING' ${returning}`,
          charge.id,
        ))[0];
      } else if (charge && normalized.type === 'CONFIRMED') {
        newStatus = 'CONFIRMED';
        transitioned = (await tx.$queryRawUnsafe<ChargeNoticeRow[]>(
          `UPDATE charges SET status='CONFIRMED', updated_at=now()
            WHERE id=$1::uuid AND status IN ('PENDING','OVERDUE') ${returning}`,
          charge.id,
        ))[0];
      } else if (charge && (normalized.type === 'CANCELED' || normalized.type === 'REFUNDED')) {
        newStatus = normalized.type;
        transitioned = (await tx.$queryRawUnsafe<ChargeNoticeRow[]>(
          `UPDATE charges SET status=$2, updated_at=now()
            WHERE id=$1::uuid AND status <> 'RECEIVED' AND status <> $2 ${returning}`,
          charge.id, normalized.type,
        ))[0];
      }
      // CREATED/PARTIAL/OTHER (e cobrança desconhecida): persistidos para
      // perícia, sem transição e sem notificação.
      await tx.$executeRawUnsafe(
        'UPDATE billing_events SET charge_id=$2::uuid, processed=true, processed_at=now() WHERE id=$1::uuid',
        event.id, charge?.id ?? null,
      );
      // CONFIRMED não notifica: ainda não é dinheiro recebido.
      if (transitioned && newStatus && newStatus !== 'CONFIRMED') {
        await queueNotice(
          tx, operator.id, cfg.OPERATOR_LID,
          billingNoticeBody(newStatus, transitioned),
          `billing:${transitioned.id}:${newStatus}`,
        );
      }
    });
    processed += 1;
  }
  return processed;
}

// Sweep de vencidas: PENDING com due_date anterior ao dia de hoje em
// America/Sao_Paulo vira OVERDUE, uma notificação por cobrança que
// transicionou (dedup_key compartilhada com o webhook OVERDUE).
async function sweepOverdueCharges(prisma: PrismaClient, cfg: Config, operator: OperatorRow): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<ChargeNoticeRow[]>(
      `UPDATE charges SET status='OVERDUE', updated_at=now()
        WHERE status='PENDING' AND due_date IS NOT NULL
          AND due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        RETURNING id, service_order_id, value_cents, paid_value_cents, due_date,
                  (SELECT number FROM service_orders WHERE id=charges.service_order_id) AS number`,
    );
    for (const row of rows) {
      await queueNotice(tx, operator.id, cfg.OPERATOR_LID, billingNoticeBody('OVERDUE', row), `billing:${row.id}:OVERDUE`);
    }
    return rows.length;
  });
}

// ===== Fase 8: relatórios agendados no tick =====
//
// A partir de REPORT_DAILY_HOUR (America/Sao_Paulo) o tick envia o
// fechamento do dia; no REPORT_WEEKLY_DAY, também o semanal. O INSERT em
// report_deliveries com ON CONFLICT DO NOTHING decide de forma atômica se o
// período ainda não foi enviado — tick duplicado ou Core reiniciado no meio
// nunca gera segunda mensagem (a dedup_key da outbox reforça).
async function runScheduledReports(prisma: PrismaClient, cfg: Config, operator: OperatorRow): Promise<number> {
  if (cfg.REPORTS_ENABLED !== 'true') return 0;
  const { date, hour, weekday } = spNowParts();
  let queued = 0;
  if (hour >= cfg.REPORT_DAILY_HOUR) {
    const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO report_deliveries(kind, period_key) VALUES('DAILY_CLOSE', $1)
       ON CONFLICT (kind, period_key) DO NOTHING RETURNING id`,
      date,
    );
    if (inserted[0]) {
      await queueNotice(prisma, operator.id, cfg.OPERATOR_LID, await dailyCloseBody(prisma, date), `report:DAILY_CLOSE:${date}`);
      queued += 1;
    }
  }
  if (weekday === cfg.REPORT_WEEKLY_DAY && hour >= cfg.REPORT_DAILY_HOUR) {
    const weekKey = `W:${mondayOf(date)}`;
    const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO report_deliveries(kind, period_key) VALUES('WEEKLY', $1)
       ON CONFLICT (kind, period_key) DO NOTHING RETURNING id`,
      weekKey,
    );
    if (inserted[0]) {
      await queueNotice(prisma, operator.id, cfg.OPERATOR_LID, await weeklyReportBody(prisma, mondayOf(date), date), `report:WEEKLY:${weekKey}`);
      queued += 1;
    }
  }
  return queued;
}

export async function buildApp(overrides: Partial<Config> = {}) {
  const cfg = { ...config(), ...overrides };
  // Fail-fast no boot: BILLING_PROVIDER=asaas sem credencial é erro de
  // operação — o serviço não sobe pela metade.
  const billing = getBillingProvider(cfg);
  const prisma = new PrismaClient();
  const app = Fastify({ logger: false, bodyLimit: cfg.BODY_LIMIT_BYTES });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.get('/health', async () => {
    await prisma.$queryRawUnsafe('SELECT 1');
    return { ok: true };
  });

  app.post('/webhooks/waha', async (request, reply) => {
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) return reply.code(400).send({ error: 'invalid_envelope' });
    const header = request.headers['x-webhook-hmac'];
    if (!validHmac(raw, Array.isArray(header) ? header[0] : header, cfg.WAHA_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'invalid_hmac' });
    }
    const { parseOk, envelope: event } = parseEnvelope(raw);
    if (!event) {
      // Envelope autenticado (HMAC válido) mas estruturalmente inválido:
      // persiste para perícia e confirma com 200. Responder 400 faria o WAHA
      // esgotar o retry exponencial e perder a mensagem (bug real da Fase 3).
      // Raw não-JSON não tem valor forense e não cabe em jsonb: só 200.
      if (parseOk) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO webhook_events(session, message_id, message_db_id, state, raw, processed_at)
           VALUES(NULL, NULL, NULL, 'INVALID', $1::jsonb, now())`,
          raw.toString('utf8'),
        );
      }
      return { accepted: true, ignored: true, invalid: true };
    }
    const message = event.payload;
    if (event.session !== cfg.WAHA_SESSION || message.fromMe || message.from.endsWith('@g.us')) {
      return { accepted: true, ignored: true };
    }
    const identities = await prisma.$queryRawUnsafe<IdentityRow[]>(
      'SELECT operator_id FROM whatsapp_identities WHERE value=$1',
      message.from,
    );
    const identity = identities[0];
    if (!identity) return { accepted: true, ignored: true };

    await prisma.$transaction(async (tx) => {
      const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO messages(operator_id, session, message_id, reply_to, body, has_media, media_mimetype, media_path)
         VALUES($1::uuid, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(session, message_id) DO NOTHING RETURNING id`,
        identity.operator_id, event.session, message.id, message.from,
        message.body, message.hasMedia, message.mediaMimetype, message.mediaPath,
      );
      const stored = inserted[0];
      if (!stored) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO webhook_events(session, message_id, message_db_id, raw)
         VALUES($1, $2, $3::uuid, $4::jsonb)
         ON CONFLICT(session, message_id) DO NOTHING`,
        event.session, message.id, stored.id, raw.toString('utf8'),
      );
    });
    return { accepted: true };
  });

  // Webhook financeiro: resposta 200 rápida, dedup por
  // UNIQUE(provider, provider_event_id), processamento assíncrono no tick.
  app.post('/webhooks/billing/:provider', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!billing || provider !== billing.name) {
      return reply.code(404).send({ error: 'unknown_provider' });
    }
    let parsed: unknown = null;
    const raw = request.body;
    if (Buffer.isBuffer(raw)) {
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        parsed = null; // corpo inválido: adapter devolve null → 200 + ignored
      }
    }
    let event: NormalizedBillingEvent | null;
    try {
      event = billing.validateAndNormalizeWebhook(request.headers, request.query as Record<string, string | string[] | undefined>, parsed);
    } catch (error) {
      if (error instanceof WebhookAuthError) {
        return reply.code(401).send({ error: 'invalid_token' });
      }
      throw error;
    }
    if (!event) return { accepted: true, ignored: true };
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_events(provider, provider_event_id, event_type, payload)
       VALUES($1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      provider, event.providerEventId, event.type, JSON.stringify(event),
    );
    return { accepted: true };
  });

  app.post('/automation/tick', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${cfg.AUTOMATION_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    let processed = 0;
    let sent = await deliver(prisma, cfg);
    for (let index = 0; index < 20; index += 1) {
      if (!(await processPendingEvent(prisma, cfg))) break;
      processed += 1;
      sent += await deliver(prisma, cfg);
    }
    // Fase 6: billing_events FIFO + sweep de vencidas; notificações entram
    // na outbox e são entregues neste mesmo tick.
    const operators = await prisma.$queryRawUnsafe<OperatorRow[]>(
      "SELECT id FROM operators WHERE label='operador-poc1'",
    );
    const operator = operators[0];
    if (!operator) throw new Error('POC operator was not created');
    const billingProcessed = await processBillingEvents(prisma, cfg, operator);
    const overdue = await sweepOverdueCharges(prisma, cfg, operator);
    const reports = await runScheduledReports(prisma, cfg, operator);
    if (billingProcessed > 0 || overdue > 0 || reports > 0) {
      sent += await deliver(prisma, cfg);
    }
    return { processed, sent, billingProcessed, overdue, reports };
  });

  app.addHook('onClose', async () => prisma.$disconnect());
  await ensureOperator(prisma, cfg);
  return app;
}
