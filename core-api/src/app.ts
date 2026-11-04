import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { config, type Config } from './config.js';
import { processMessage } from './domain.js';
import { validHmac, sendWaha, SendFailure } from './waha.js';

type OperatorRow = { id: string };
type IdentityRow = { operator_id: string };
type EventRow = { id: string; message_db_id: string };
type OutboundRow = { id: string; reply_to: string; body: string };

type WahaEnvelope = {
  id: string;
  session: string;
  event: 'message';
  payload: { id: string; from: string; fromMe: boolean; body: string; hasMedia: boolean };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseEnvelope(raw: Buffer): WahaEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.event !== 'message' || typeof value.id !== 'string' ||
      typeof value.session !== 'string' || !isRecord(value.payload)) return null;

  const payload = value.payload;
  if (typeof payload.id !== 'string' || payload.id.length === 0 ||
      typeof payload.from !== 'string' || payload.from.length === 0 ||
      typeof payload.body !== 'string' || typeof payload.hasMedia !== 'boolean' ||
      typeof payload.fromMe !== 'boolean') return null;

  return {
    id: value.id,
    session: value.session,
    event: 'message',
    payload: { id: payload.id, from: payload.from, fromMe: payload.fromMe, body: payload.body, hasMedia: payload.hasMedia },
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

async function processPendingEvent(prisma: PrismaClient): Promise<boolean> {
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
      await processMessage(tx, event);
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

export async function buildApp(overrides: Partial<Config> = {}) {
  const cfg = { ...config(), ...overrides };
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
    const event = parseEnvelope(raw);
    if (!event) return reply.code(400).send({ error: 'invalid_envelope' });
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
        `INSERT INTO messages(operator_id, session, message_id, reply_to, body, has_media)
         VALUES($1::uuid, $2, $3, $4, $5, $6)
         ON CONFLICT(session, message_id) DO NOTHING RETURNING id`,
        identity.operator_id, event.session, message.id, message.from, message.body, message.hasMedia,
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

  app.post('/automation/tick', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${cfg.AUTOMATION_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    let processed = 0;
    let sent = await deliver(prisma, cfg);
    for (let index = 0; index < 20; index += 1) {
      if (!(await processPendingEvent(prisma))) break;
      processed += 1;
      sent += await deliver(prisma, cfg);
    }
    return { processed, sent };
  });

  app.addHook('onClose', async () => prisma.$disconnect());
  await ensureOperator(prisma, cfg);
  return app;
}
