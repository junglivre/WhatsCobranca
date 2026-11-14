import { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { formatMoney, type Tx } from './types.js';
import { applyPreparedAudio, queueNotice, queueReply, type MessageRow, type PreparedAudio } from './domain.js';
import { downloadWahaMedia, MediaFailure } from './waha.js';
import { extractServiceIntent, GroqFailure, transcribeAudio } from './groq.js';
import { getEnabledBillingProvider, getInvoiceProvider } from './providers/registry.js';
import { MissingFiscalIdError, ProviderTimeoutError, ProviderValidationError, UnsupportedMethodError } from './providers/billing/types.js';
import type { BillingProvider, CreatedCharge } from './providers/billing/types.js';

type OperationRow = {
  id: string;
  source_message_id: string;
  webhook_event_id: string;
  operator_id: string;
  kind: 'CHARGE_CREATE' | 'CHARGE_CANCEL' | 'INVOICE_REQUEST' | 'INVOICE_CANCEL' | 'AUDIO_PROCESS';
  provider: string | null;
  charge_id: string | null;
  invoice_id: string | null;
  external_reference: string;
  payload: unknown;
  reconciliation_only: boolean;
};

type ChargeWorkRow = {
  id: string; provider: string; method: 'PIX' | 'BOLETO'; value_cents: number;
  due_date: Date | string | null; external_reference: string; provider_charge_id: string | null;
  service_order_id: string; customer_id: string; number: number; description: string;
  customer: string; cpf_cnpj: string | null; status: string;
};

type OperationPayload = { replyTo?: string };

const payloadOf = (value: unknown): OperationPayload =>
  typeof value === 'object' && value !== null ? value as OperationPayload : {};

function replyTo(operation: OperationRow): string {
  const value = payloadOf(operation.payload).replyTo;
  if (!value) throw new Error('OPERATION_REPLY_TO_MISSING');
  return value;
}

async function systemActor(tx: Tx): Promise<string> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    "SELECT id FROM operators WHERE label='system-financial-worker'",
  );
  if (!rows[0]) throw new Error('SYSTEM_ACTOR_MISSING');
  return rows[0].id;
}

async function systemAudit(
  tx: Tx, entityType: string, entityId: string, action: string,
  previousStatus: string | null, newStatus: string | null, reason: string | null,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs(actor_id, source_message_id, entity_type, entity_id, action, previous_status, new_status, reason)
     VALUES($1::uuid, NULL, $2, $3, $4, $5, $6, $7)`,
    await systemActor(tx), entityType, entityId, action, previousStatus, newStatus, reason,
  );
}

async function claimOperation(prisma: PrismaClient): Promise<OperationRow | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE financial_operations
          SET state=CASE WHEN reconciliation_only THEN 'UNCERTAIN' ELSE 'PENDING' END,
              lease_until=NULL
        WHERE state='LEASED' AND lease_until < now()`,
    );
    const rows = await tx.$queryRawUnsafe<OperationRow[]>(
      `SELECT id, source_message_id, webhook_event_id, operator_id, kind, provider, charge_id, invoice_id,
              external_reference, payload, reconciliation_only
         FROM financial_operations
        WHERE state IN ('PENDING','UNCERTAIN') AND next_attempt_at <= now()
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const operation = rows[0];
    if (!operation) return null;
    await tx.$executeRawUnsafe(
      `UPDATE financial_operations SET state='LEASED', attempts=attempts+1,
          lease_until=now()+interval '45 seconds', last_error=NULL WHERE id=$1::uuid`, operation.id,
    );
    return operation;
  });
}

async function finishMessage(
  tx: Tx, operation: OperationRow, state: 'DONE' | 'ERROR' | 'UNCERTAIN' | 'NEEDS_REVIEW',
  body: string, suffix: string, error: string | null = null,
): Promise<boolean> {
  const changed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE financial_operations SET state=$2, lease_until=NULL, finished_at=CASE WHEN $2 IN ('DONE','ERROR','NEEDS_REVIEW') THEN now() ELSE NULL END,
        last_error=$3, next_attempt_at=CASE WHEN $2='UNCERTAIN' THEN now()+interval '1 minute' ELSE next_attempt_at END
      WHERE id=$1::uuid AND state='LEASED' RETURNING id`, operation.id, state, error,
  );
  if (!changed[0]) return false;
  await tx.$executeRawUnsafe(
    "UPDATE webhook_events SET state='PROCESSED', processed_at=now(), last_error=NULL WHERE id=$1::uuid AND state='WAITING_EXTERNAL'",
    operation.webhook_event_id,
  );
  await tx.$executeRawUnsafe(
    `UPDATE conversation_states SET pending_action=NULL, payload=NULL, service_order_id=NULL,
       expires_at=NULL, updated_at=now() WHERE operator_id=$1::uuid`, operation.operator_id,
  );
  await queueReply(tx, operation.operator_id, operation.source_message_id, replyTo(operation), body, suffix);
  return true;
}

async function finishSilent(tx: Tx, operation: OperationRow, state: 'DONE' | 'ERROR', error: string | null = null): Promise<boolean> {
  const changed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE financial_operations SET state=$2, lease_until=NULL, finished_at=now(), last_error=$3
      WHERE id=$1::uuid AND state='LEASED' RETURNING id`, operation.id, state, error,
  );
  if (!changed[0]) return false;
  await tx.$executeRawUnsafe(
    "UPDATE webhook_events SET state='PROCESSED', processed_at=now(), last_error=NULL WHERE id=$1::uuid AND state='WAITING_EXTERNAL'",
    operation.webhook_event_id,
  );
  return true;
}

async function loadCharge(prisma: PrismaClient, chargeId: string): Promise<ChargeWorkRow | null> {
  const rows = await prisma.$queryRawUnsafe<ChargeWorkRow[]>(
    `SELECT ch.id, ch.provider, ch.method, ch.value_cents, ch.due_date, ch.external_reference, ch.provider_charge_id,
            ch.service_order_id, ch.customer_id, so.number, so.description, c.name AS customer, c.cpf_cnpj
       FROM charges ch JOIN service_orders so ON so.id=ch.service_order_id
       JOIN customers c ON c.id=ch.customer_id WHERE ch.id=$1::uuid`, chargeId,
  );
  return rows[0] ?? null;
}

function dueDate(value: Date | string | null): string {
  if (!value) throw new Error('CHARGE_DUE_DATE_MISSING');
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

async function reconcileCreate(provider: BillingProvider, reference: string): Promise<CreatedCharge | null> {
  return provider.findByExternalReference(reference);
}

async function createRemotely(provider: BillingProvider, charge: ChargeWorkRow): Promise<CreatedCharge> {
  const refs = await prismaForWorker.$queryRawUnsafe<Array<{ external_id: string }>>(
    'SELECT external_id FROM customer_provider_refs WHERE customer_id=$1::uuid AND provider=$2', charge.customer_id, provider.name,
  );
  let externalId = refs[0]?.external_id;
  if (!externalId) {
    externalId = await provider.ensureCustomer({ customerId: charge.customer_id, name: charge.customer, cpfCnpj: charge.cpf_cnpj });
    await prismaForWorker.$executeRawUnsafe(
      `INSERT INTO customer_provider_refs(customer_id, provider, external_id)
       VALUES($1::uuid, $2, $3) ON CONFLICT(customer_id, provider) DO NOTHING`, charge.customer_id, provider.name, externalId,
    );
  }
  if (charge.cpf_cnpj) {
    await provider.updateCustomer(externalId, { customerId: charge.customer_id, name: charge.customer, cpfCnpj: charge.cpf_cnpj });
  }
  return provider.createCharge({
    providerCustomerId: externalId, method: charge.method, valueCents: charge.value_cents,
    dueDate: dueDate(charge.due_date), description: `OS ${String(charge.number).padStart(6, '0')} — ${charge.description}`,
    externalReference: charge.external_reference,
  });
}

// The instance is assigned by processFinancialOperations. Keeping remote calls
// outside an interactive transaction is intentional; these short database
// lookups do not hold locks while the provider is contacted.
let prismaForWorker: PrismaClient;

async function completeChargeCreate(prisma: PrismaClient, operation: OperationRow, cfg: Config): Promise<void> {
  if (!operation.charge_id || !operation.provider) throw new Error('CHARGE_OPERATION_FIELDS_MISSING');
  const charge = await loadCharge(prisma, operation.charge_id);
  if (!charge) throw new Error('CHARGE_NOT_FOUND');
  const provider = getEnabledBillingProvider(cfg, operation.provider);
  if (!provider) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("UPDATE charges SET status='ERROR', updated_at=now() WHERE id=$1::uuid AND status='DRAFT'", charge.id);
      await systemAudit(tx, 'charge', charge.id, 'CREATE_PROVIDER_UNAVAILABLE', 'DRAFT', 'ERROR', operation.provider);
      await finishMessage(tx, operation, 'ERROR', `Não foi possível criar a cobrança: o provider histórico ${operation.provider} não está habilitado/configurado. Nenhuma cobrança foi marcada como criada.`, 'charge-provider-unavailable');
    });
    return;
  }
  let created: CreatedCharge | null = null;
  try {
    created = operation.reconciliation_only
      ? await reconcileCreate(provider, charge.external_reference)
      : await createRemotely(provider, charge);
  } catch (error) {
    if (error instanceof MissingFiscalIdError || error instanceof UnsupportedMethodError || error instanceof ProviderValidationError) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("UPDATE charges SET status='ERROR', updated_at=now() WHERE id=$1::uuid AND status='DRAFT'", charge.id);
        await systemAudit(tx, 'charge', charge.id, 'CREATE_REJECTED', 'DRAFT', 'ERROR', error.message);
        await finishMessage(tx, operation, 'ERROR', `${error.message} A intenção foi marcada como ERROR; nenhuma nova tentativa automática será feita.`, 'charge-rejected', error.message);
      });
      return;
    }
    try { created = await reconcileCreate(provider, charge.external_reference); } catch { /* segue para estado incerto */ }
    if (!created) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('UPDATE charges SET reconciliation_required=true, updated_at=now() WHERE id=$1::uuid', charge.id);
        await systemAudit(tx, 'charge', charge.id, 'CREATE_UNCERTAIN', 'DRAFT', 'DRAFT', 'reconciliation-only; no blind POST');
        await finishMessage(tx, operation, 'UNCERTAIN', `A criação da cobrança ${charge.external_reference} teve resultado incerto. Ela ficou somente em reconciliação; o sistema não enviará outro POST automaticamente.`, 'charge-uncertain', error instanceof Error ? error.name : 'provider_error');
      });
      return;
    }
  }
  if (!created) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('UPDATE charges SET reconciliation_required=true WHERE id=$1::uuid', charge.id);
      await finishMessage(tx, operation, 'UNCERTAIN', `A cobrança ${charge.external_reference} ainda não apareceu na reconciliação. Nenhum novo POST será feito automaticamente.`, 'charge-uncertain');
    });
    return;
  }
  let pixCopyPaste: string | null = null;
  let pixProblem = '';
  if (charge.method === 'PIX') {
    try { pixCopyPaste = (await provider.getPixData(created.providerChargeId)).copyPaste; }
    catch { pixProblem = ' Pix criada, mas o copia-e-cola ainda não está disponível; consulte o provider sem reenviar a criação.'; }
  }
  await prisma.$transaction(async (tx) => {
    const previous = 'DRAFT';
    await tx.$executeRawUnsafe(
      `UPDATE charges SET provider_charge_id=$2, status=$3, issued_at=now(), reconciliation_required=false,
          pix_copy_paste=COALESCE($4, pix_copy_paste), updated_at=now() WHERE id=$1::uuid`,
      charge.id, created!.providerChargeId, created!.status, pixCopyPaste,
    );
    await systemAudit(tx, 'charge', charge.id, 'CREATE_RECONCILED', previous, created!.status, charge.external_reference);
    const intro = created!.status === 'RECEIVED'
      ? `A cobrança ${charge.external_reference} já consta recebida no gateway, mas sem movimento financeiro datado verificável; ela foi mantida para conciliação e não foi contada como dinheiro.`
      : `Cobrança criada: OS ${String(charge.number).padStart(6, '0')} · ${charge.method === 'PIX' ? 'Pix' : 'Boleto'} · ${formatMoney(charge.value_cents)}.`;
    const payment = pixCopyPaste ? `\nPix copia-e-cola:\n${pixCopyPaste}` : pixProblem;
    await finishMessage(tx, operation, 'DONE', `${intro}${payment}`, 'charge-created');
  });
}

async function completeChargeCancel(prisma: PrismaClient, operation: OperationRow, cfg: Config): Promise<void> {
  if (!operation.charge_id) throw new Error('CHARGE_CANCEL_FIELDS_MISSING');
  const charge = await loadCharge(prisma, operation.charge_id);
  if (!charge) throw new Error('CHARGE_NOT_FOUND');
  const provider = getEnabledBillingProvider(cfg, charge.provider);
  if (!provider && charge.provider !== 'manual') {
    await prisma.$transaction(async (tx) => {
      await finishMessage(tx, operation, 'ERROR', `A cobrança usa ${charge.provider}, que não está habilitado com credenciais nesta instalação. O estado foi preservado; configure o provider histórico antes de cancelar.`, 'charge-cancel-provider-missing');
    });
    return;
  }
  try {
    if (charge.provider_charge_id && provider) await provider.cancelCharge(charge.provider_charge_id);
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await systemAudit(tx, 'charge', charge.id, 'CANCEL_UNCERTAIN', charge.provider, charge.provider, 'provider cancellation did not confirm');
      await finishMessage(tx, operation, 'UNCERTAIN', `O cancelamento da cobrança da OS ${String(charge.number).padStart(6, '0')} não foi confirmado pelo provider. O estado foi preservado e não haverá cancelamento local falso.`, 'charge-cancel-uncertain', error instanceof Error ? error.name : 'provider_error');
    });
    return;
  }
  await prisma.$transaction(async (tx) => {
    const changed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      "UPDATE charges SET status='CANCELED', updated_at=now() WHERE id=$1::uuid AND status IN ('PENDING','OVERDUE','CONFIRMED','PARTIALLY_PAID') RETURNING id", charge.id,
    );
    if (changed[0]) await systemAudit(tx, 'charge', charge.id, 'CANCEL_PROVIDER', charge.status, 'CANCELED', charge.provider);
    await finishMessage(tx, operation, 'DONE', `Cobrança da OS ${String(charge.number).padStart(6, '0')} cancelada.`, 'charge-canceled');
  });
}

async function completeInvoiceRequest(prisma: PrismaClient, operation: OperationRow, cfg: Config): Promise<void> {
  if (!operation.invoice_id || !operation.provider) throw new Error('INVOICE_OPERATION_FIELDS_MISSING');
  const invoiceRows = await prisma.$queryRawUnsafe<Array<{ id: string; payload: unknown; service_order_id: string }>>(
    'SELECT id, payload, service_order_id FROM invoices WHERE id=$1::uuid', operation.invoice_id,
  );
  const invoice = invoiceRows[0];
  if (!invoice || typeof invoice.payload !== 'object' || invoice.payload === null) throw new Error('INVOICE_NOT_FOUND');
  const provider = getInvoiceProvider(cfg);
  if (!provider || provider.name !== operation.provider) {
    await prisma.$transaction(async (tx) => {
      await finishMessage(tx, operation, 'ERROR', 'O emissor fiscal configurado não corresponde à solicitação histórica; o estado foi preservado para revisão.', 'invoice-provider-unavailable');
    });
    return;
  }
  let result;
  try {
    result = await provider.request(invoice.payload as never);
  } catch (error) {
    try { result = await provider.findByExternalReference(operation.external_reference); } catch { result = null; }
    if (!result) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("UPDATE invoices SET status='NEEDS_REVIEW', last_error='reconciliação pendente', updated_at=now() WHERE id=$1::uuid", invoice.id);
        await systemAudit(tx, 'invoice', invoice.id, 'REQUEST_NEEDS_REVIEW', 'READY_FOR_APPROVAL', 'NEEDS_REVIEW', 'external outcome uncertain');
        await finishMessage(tx, operation, 'NEEDS_REVIEW', 'A solicitação fiscal ficou em revisão; não reenvie antes de conferir o emissor.', 'invoice-needs-review');
      });
      return;
    }
  }
  if (!result) throw new Error('INVOICE_PROVIDER_EMPTY_RESULT');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('UPDATE invoices SET provider_invoice_id=$2, status=$3, updated_at=now() WHERE id=$1::uuid', invoice.id, result.providerInvoiceId, result.status);
    await systemAudit(tx, 'invoice', invoice.id, 'REQUEST', 'READY_FOR_APPROVAL', result.status, operation.external_reference);
    await finishMessage(tx, operation, 'DONE', result.status === 'NEEDS_REVIEW'
      ? `Solicitação fiscal registrada para emissão humana (referência ${operation.external_reference}).`
      : `Solicitação fiscal enviada ao emissor (status: ${result.status}).`, 'invoice-requested');
  });
}

async function loadAudioMessage(prisma: PrismaClient, operation: OperationRow): Promise<MessageRow | null> {
  const rows = await prisma.$queryRawUnsafe<MessageRow[]>(
    `SELECT m.id, m.message_id, m.operator_id, m.reply_to, m.body, m.has_media, m.media_mimetype, m.media_path,
            cs.pending_action, cs.payload, cs.service_order_id, cs.expires_at
       FROM messages m LEFT JOIN conversation_states cs ON cs.operator_id=m.operator_id
      WHERE m.id=$1::uuid`, operation.source_message_id,
  );
  return rows[0] ?? null;
}

async function prepareAudio(cfg: Config, message: MessageRow): Promise<PreparedAudio> {
  const mimetype = message.media_mimetype ?? '';
  if (!mimetype.startsWith('audio/')) {
    return { kind: 'SKIP', reason: 'MEDIA_UNSUPPORTED', body: 'Aceito apenas texto ou nota de voz (áudio). Imagens e documentos ficam para um próximo ciclo.', suffix: 'unsupported' };
  }
  const mediaPath = message.media_path ?? `/api/files/${cfg.WAHA_SESSION}/${message.message_id}.oga`;
  let media: { bytes: Buffer; contentType: string };
  try { media = await downloadWahaMedia(cfg, mediaPath, cfg.WAHA_MEDIA_MAX_BYTES); }
  catch (error) {
    if (error instanceof MediaFailure && error.outcome === 'REJECTED') {
      return { kind: 'SKIP', reason: error.message.startsWith('WAHA_MEDIA_TOO_LARGE') ? 'AUDIO_TOO_LARGE' : 'AUDIO_DOWNLOAD_FAILED', body: 'Não consegui baixar o áudio (grande demais ou indisponível). Tente gravar novamente ou envie por texto (novo).', suffix: 'audio-download' };
    }
    throw error;
  }
  if (!media.contentType.startsWith('audio/')) {
    return { kind: 'SKIP', reason: 'MEDIA_UNSUPPORTED', body: 'O anexo não é um áudio suportado. Envie texto ou nota de voz.', suffix: 'unsupported' };
  }
  let transcription: string;
  try { transcription = (await transcribeAudio(cfg, media.bytes, `${message.message_id}.oga`)).trim().slice(0, 4000); }
  catch (error) {
    if (error instanceof GroqFailure && error.outcome === 'REJECTED') {
      return { kind: 'SKIP', reason: 'AUDIO_STT_FAILED', body: 'Não consegui transcrever o áudio. Tente gravar novamente ou envie por texto (novo).', suffix: 'audio-stt' };
    }
    throw error;
  }
  if (!transcription) return { kind: 'SKIP', reason: 'AUDIO_EMPTY_TRANSCRIPTION', body: 'O áudio chegou sem conteúdo de fala. Grave novamente ou envie por texto (novo).', suffix: 'audio-empty' };
  try {
    const extraction = await extractServiceIntent(cfg, transcription);
    return extraction.intent === 'REGISTRAR_SERVICO'
      ? { kind: 'APPLY', transcription, extraction }
      : { kind: 'INTENT_IGNORED', transcription, extraction };
  } catch (error) {
    if (error instanceof GroqFailure && error.outcome === 'REJECTED') return { kind: 'FALLBACK', transcription };
    throw error;
  }
}

async function completeAudio(prisma: PrismaClient, operation: OperationRow, cfg: Config): Promise<void> {
  const message = await loadAudioMessage(prisma, operation);
  if (!message) throw new Error('AUDIO_MESSAGE_NOT_FOUND');
  const prepared = await prepareAudio(cfg, message);
  await prisma.$transaction(async (tx) => {
    await applyPreparedAudio(tx, message, replyTo(operation), prepared);
    await systemAudit(tx, 'financial_operation', operation.id, 'AUDIO_APPLIED', 'LEASED', 'DONE', prepared.kind);
    await finishSilent(tx, operation, 'DONE');
  });
}

async function retryOperation(prisma: PrismaClient, operation: OperationRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.name : 'external_error';
  await prisma.$transaction(async (tx) => {
    const attempts = await tx.$queryRawUnsafe<Array<{ attempts: number }>>(
      'SELECT attempts FROM financial_operations WHERE id=$1::uuid FOR UPDATE', operation.id,
    );
    if ((attempts[0]?.attempts ?? 0) >= 5) {
      await finishMessage(tx, operation, 'ERROR', 'A operação externa falhou após 5 tentativas e ficou visível para revisão. Nenhum efeito externo adicional será presumido.', 'operation-failed', message);
      return;
    }
    await tx.$executeRawUnsafe(
      `UPDATE financial_operations SET state='PENDING', lease_until=NULL, last_error=$2,
          next_attempt_at=now()+interval '15 seconds' WHERE id=$1::uuid AND state='LEASED'`, operation.id, message,
    );
  });
}

export async function processFinancialOperations(prisma: PrismaClient, cfg: Config): Promise<number> {
  prismaForWorker = prisma;
  let processed = 0;
  for (let index = 0; index < 20; index += 1) {
    const operation = await claimOperation(prisma);
    if (!operation) break;
    try {
      if (operation.kind === 'CHARGE_CREATE') await completeChargeCreate(prisma, operation, cfg);
      else if (operation.kind === 'CHARGE_CANCEL') await completeChargeCancel(prisma, operation, cfg);
      else if (operation.kind === 'INVOICE_REQUEST') await completeInvoiceRequest(prisma, operation, cfg);
      else if (operation.kind === 'AUDIO_PROCESS') await completeAudio(prisma, operation, cfg);
      else await prisma.$transaction(async (tx) => {
        await finishMessage(tx, operation, 'NEEDS_REVIEW', 'A operação externa requer revisão; nenhum efeito foi presumido.', 'operation-needs-review');
      });
    } catch (error) {
      await retryOperation(prisma, operation, error);
    }
    processed += 1;
  }
  return processed;
}
