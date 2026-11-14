import { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { formatMoney, osLabel, type Tx } from './types.js';
import { queueNotice } from './domain.js';
import type { NormalizedBillingEvent } from './providers/billing/types.js';

type EventRow = { id: string; provider: string; payload: unknown };
type ChargeRow = { id: string; service_order_id: string; value_cents: number; status: string; number: number };

async function systemAudit(tx: Tx, entityId: string, action: string, previous: string | null, next: string | null, reason: string | null): Promise<void> {
  const actor = await tx.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM operators WHERE label='system-financial-worker'");
  if (!actor[0]) throw new Error('SYSTEM_ACTOR_MISSING');
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs(actor_id, entity_type, entity_id, action, previous_status, new_status, reason)
     VALUES($1::uuid, 'billing_event', $2, $3, $4, $5, $6)`,
    actor[0].id, entityId, action, previous, next, reason,
  );
}

async function claim(prisma: PrismaClient): Promise<EventRow | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("UPDATE billing_events SET state='PENDING', lease_until=NULL WHERE state='LEASED' AND lease_until < now()");
    const rows = await tx.$queryRawUnsafe<EventRow[]>(
      `SELECT id, provider, payload FROM billing_events
        WHERE state='PENDING' AND next_attempt_at <= now()
        ORDER BY position FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!rows[0]) return null;
    await tx.$executeRawUnsafe(
      "UPDATE billing_events SET state='LEASED', attempts=attempts+1, lease_until=now()+interval '30 seconds' WHERE id=$1::uuid", rows[0].id,
    );
    return rows[0];
  });
}

function notice(status: string, number: number, value: number): string {
  if (status === 'RECEIVED') return `Cobrança ${osLabel(number)} recebida: ${formatMoney(value)}`;
  if (status === 'PARTIALLY_PAID') return `Cobrança ${osLabel(number)} recebeu pagamento parcial: ${formatMoney(value)}.`;
  if (status === 'REFUNDED') return `Cobrança ${osLabel(number)} foi estornada; saldo financeiro recalculado.`;
  return `Cobrança ${osLabel(number)} atualizada: ${status}.`;
}

async function processOne(prisma: PrismaClient, cfg: Config, event: EventRow): Promise<void> {
  const normalized = event.payload as NormalizedBillingEvent;
  await prisma.$transaction(async (tx) => {
    const charges = await tx.$queryRawUnsafe<ChargeRow[]>(
      `SELECT ch.id, ch.service_order_id, ch.value_cents, ch.status, so.number
         FROM charges ch JOIN service_orders so ON so.id=ch.service_order_id
        WHERE ch.provider=$1 AND ch.provider_charge_id=$2 FOR UPDATE`, event.provider, normalized.providerChargeId,
    );
    const charge = charges[0];
    if (!charge) {
      // Eventos ainda não associáveis não bloqueiam outros callbacks. A prova
      // fica durável e ganha nova tentativa, sem fingir que foi processada.
      await tx.$executeRawUnsafe(
        `UPDATE billing_events SET state='PENDING', lease_until=NULL, next_attempt_at=now()+interval '1 minute',
          last_error='charge not associated yet' WHERE id=$1::uuid`, event.id,
      );
      return;
    }
    if ((normalized.type === 'RECEIVED' || normalized.type === 'REFUNDED') && !normalized.financial) {
      await tx.$executeRawUnsafe(
        `UPDATE billing_events SET charge_id=$2::uuid, state='NEEDS_REVIEW', processed=true, processed_at=now(),
          lease_until=NULL, last_error='financial value/date/identity missing' WHERE id=$1::uuid`, event.id, charge.id,
      );
      await systemAudit(tx, event.id, 'FINANCIAL_EVENT_NEEDS_REVIEW', null, null, 'missing verified financial fields');
      return;
    }
    let changedStatus: string | null = null;
    let net = 0;
    if (normalized.financial) {
      let value = normalized.financial.valueCents;
      if (normalized.financial.semantics === 'CUMULATIVE') {
        const prior = await tx.$queryRawUnsafe<Array<{ value: bigint }>>(
          `SELECT COALESCE(SUM(value_cents) FILTER (WHERE direction='RECEIPT'),0) AS value
             FROM financial_ledger WHERE charge_id=$1::uuid AND provider=$2 AND provider_payment_id=$3`,
          charge.id, event.provider, normalized.financial.paymentReference,
        );
        value -= Number(prior[0]?.value ?? 0n);
      }
      if (value > 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO financial_ledger(service_order_id, charge_id, direction, value_cents, financial_at, origin,
             economic_key, provider, provider_payment_id, billing_event_id, actor_id, metadata)
           VALUES($1::uuid, $2::uuid, $3, $4, $5::timestamptz, 'GATEWAY_EVENT', $6, $7, $8, $9::uuid, $10::uuid, $11::jsonb)
           ON CONFLICT(economic_key) DO NOTHING`,
          charge.service_order_id, charge.id, normalized.financial.direction, value, normalized.financial.occurredAt,
          normalized.financial.economicKey, event.provider, normalized.financial.paymentReference, event.id,
          (await tx.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM operators WHERE label='system-financial-worker'"))[0]?.id,
          JSON.stringify({ semantics: normalized.financial.semantics, providerEventId: normalized.providerEventId }),
        );
      }
      const totals = await tx.$queryRawUnsafe<Array<{ net: bigint }>>(
        `SELECT COALESCE(SUM(CASE WHEN direction='RECEIPT' THEN value_cents ELSE -value_cents END),0) AS net
           FROM financial_ledger WHERE charge_id=$1::uuid`, charge.id,
      );
      net = Number(totals[0]?.net ?? 0n);
      const targetStatus = net <= 0 ? 'REFUNDED' : net < charge.value_cents ? 'PARTIALLY_PAID' : 'RECEIVED';
      const updated = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        `UPDATE charges SET status=$2, paid_value_cents=$3, updated_at=now()
          WHERE id=$1::uuid AND status IS DISTINCT FROM $2 RETURNING status`, charge.id, targetStatus, Math.max(0, net),
      );
      if (updated[0]) {
        changedStatus = targetStatus;
        await systemAudit(tx, charge.id, normalized.financial.direction === 'REFUND' ? 'REFUND_APPLIED' : 'RECEIPT_APPLIED', charge.status, targetStatus, normalized.financial.economicKey);
      }
    } else if (normalized.type === 'CONFIRMED' || normalized.type === 'OVERDUE' || normalized.type === 'CANCELED') {
      const next = normalized.type === 'CANCELED' ? 'CANCELED' : normalized.type;
      const updated = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE charges SET status=$2, updated_at=now()
          WHERE id=$1::uuid AND status IN ('PENDING','OVERDUE','CONFIRMED') AND status <> $2 RETURNING id`, charge.id, next,
      );
      if (updated[0]) changedStatus = next;
    }
    await tx.$executeRawUnsafe(
      `UPDATE billing_events SET charge_id=$2::uuid, processed=true, processed_at=now(), state='PROCESSED',
          lease_until=NULL, last_error=NULL WHERE id=$1::uuid`, event.id, charge.id,
    );
    if (changedStatus) {
      const operator = await tx.$queryRawUnsafe<Array<{ id: string }>>("SELECT id FROM operators WHERE label='operador-poc1'");
      if (operator[0]) await queueNotice(tx, operator[0].id, cfg.OPERATOR_LID, notice(changedStatus, charge.number, net), `billing:${charge.id}:${changedStatus}`);
    }
  });
}

export async function processBillingEventQueue(prisma: PrismaClient, cfg: Config): Promise<number> {
  let processed = 0;
  for (let index = 0; index < 50; index += 1) {
    const event = await claim(prisma);
    if (!event) break;
    await processOne(prisma, cfg, event);
    processed += 1;
  }
  return processed;
}
