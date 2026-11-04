import type { Config } from './config.js';
import type { JsonRecord, Tx } from './types.js';
import { formatMoney, isNo, isYes, normalize, osLabel, parseMoney } from './types.js';
import { downloadWahaMedia, MediaFailure } from './waha.js';
import { extractServiceIntent, GroqFailure, transcribeAudio, type Extraction } from './groq.js';

type Purpose = 'CREATE' | 'QUERY';
type CustomerRow = { id: string; name: string };
type OrderRow = {
  id: string;
  number: number;
  description: string;
  amount_cents: number | null;
  due_date: Date | string | null;
  customer: string;
};
type EventRow = { message_db_id: string };
type MessageRow = {
  id: string;
  message_id: string;
  operator_id: string;
  reply_to: string;
  body: string | null;
  has_media: boolean;
  media_mimetype: string | null;
  media_path: string | null;
  pending_action: string | null;
  payload: unknown;
  service_order_id: string | null;
  expires_at: Date | null;
};
type ConversationPayload = {
  description?: string;
  name?: string;
  purpose?: Purpose;
  candidates?: CustomerRow[];
  serviceAmountCents?: number;
  materialAmountCents?: number;
  dueDate?: string; // YYYY-MM-DD
};

const thirtyMinutes = () => new Date(Date.now() + 30 * 60 * 1000);
const clean = (value: string) => value.trim();

function payloadOf(value: unknown): ConversationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as JsonRecord;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.filter((candidate): candidate is CustomerRow =>
      typeof candidate === 'object' && candidate !== null &&
      typeof (candidate as JsonRecord).id === 'string' &&
      typeof (candidate as JsonRecord).name === 'string')
    : undefined;
  const positiveCents = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return {
    description: typeof record.description === 'string' ? record.description : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    purpose: record.purpose === 'CREATE' || record.purpose === 'QUERY' ? record.purpose : undefined,
    candidates,
    serviceAmountCents: positiveCents(record.serviceAmountCents),
    materialAmountCents: positiveCents(record.materialAmountCents),
    dueDate: typeof record.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.dueDate)
      ? record.dueDate
      : undefined,
  };
}

async function audit(
  tx: Tx,
  actorId: string,
  sourceMessageId: string,
  entityType: string,
  entityId: string,
  action: string,
  previousStatus: string | null,
  newStatus: string | null,
  reason: string | null = null,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs(actor_id, source_message_id, entity_type, entity_id, action, previous_status, new_status, reason)
     VALUES($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)`,
    actorId, sourceMessageId, entityType, entityId, action, previousStatus, newStatus, reason,
  );
}

async function queueReply(
  tx: Tx,
  operatorId: string,
  sourceMessageId: string,
  replyTo: string,
  body: string,
  suffix: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO outbound_messages(operator_id, correlation_message_id, reply_to, body, dedup_key)
     VALUES($1::uuid, $2::uuid, $3, $4, $5)
     ON CONFLICT (dedup_key) DO NOTHING`,
    operatorId, sourceMessageId, replyTo, body, `${sourceMessageId}:${suffix}`,
  );
}

async function saveState(
  tx: Tx,
  operatorId: string,
  action: string | null,
  payload: ConversationPayload | null,
  serviceOrderId: string | null,
  replyTo: string,
): Promise<void> {
  const expiresAt = action ? thirtyMinutes() : null;
  await tx.$executeRawUnsafe(
    `INSERT INTO conversation_states(operator_id, pending_action, payload, service_order_id, expires_at, reply_to)
     VALUES($1::uuid, $2, $3::jsonb, $4::uuid, $5, $6)
     ON CONFLICT(operator_id) DO UPDATE
       SET pending_action=EXCLUDED.pending_action, payload=EXCLUDED.payload,
           service_order_id=EXCLUDED.service_order_id, expires_at=EXCLUDED.expires_at,
           reply_to=EXCLUDED.reply_to, updated_at=now()`,
    operatorId, action, payload ? JSON.stringify(payload) : null, serviceOrderId, expiresAt, replyTo,
  );
}

async function orderSummary(tx: Tx, orderId: string): Promise<string> {
  const orders = await tx.$queryRawUnsafe<OrderRow[]>(
    `SELECT so.id, so.number, so.description, so.amount_cents, so.due_date, c.name AS customer
       FROM service_orders AS so JOIN customers AS c ON c.id=so.customer_id
      WHERE so.id=$1::uuid`,
    orderId,
  );
  const order = orders[0];
  if (!order) throw new Error('ORDER_NOT_FOUND');
  const dueIso = order.due_date instanceof Date
    ? order.due_date.toISOString().slice(0, 10)
    : order.due_date;
  const dueLine = dueIso
    ? `\nVence: ${new Date(`${dueIso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`
    : '';
  return `${osLabel(order.number)}\nCliente: ${order.customer}\nDescrição: ${order.description}\nValor: ${formatMoney(order.amount_cents)}${dueLine}\nConfirma? Responda sim ou cancelar.`;
}

type OrderExtras = {
  serviceAmountCents?: number;
  materialAmountCents?: number;
  dueDate?: string;
};

function totalCents(extras: OrderExtras): number | null {
  const service = extras.serviceAmountCents;
  const material = extras.materialAmountCents;
  if (service === undefined && material === undefined) return null;
  return (service ?? 0) + (material ?? 0);
}

async function createOrder(
  tx: Tx,
  operatorId: string,
  sourceMessageId: string,
  replyTo: string,
  description: string,
  customerId: string,
  extras: OrderExtras = {},
): Promise<{ id: string; awaitingConfirmation: boolean }> {
  const dueDate = extras.dueDate ?? null;
  const total = totalCents(extras);
  // Valor pré-extrato (áudio) nasce com a OS: um único audit CREATE já com o
  // status final. SET_VALUE como ação separada é só do fluxo guiado por texto.
  const status = total !== null ? 'AGUARDANDO_CONFIRMACAO' : 'AGUARDANDO_DADOS';
  const orders = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO service_orders(customer_id, description, status, amount_cents, due_date)
     VALUES($1::uuid, $2, $3, $4, $5::date)
     RETURNING id`,
    customerId, description, status, total, dueDate,
  );
  const order = orders[0];
  if (!order) throw new Error('ORDER_NOT_CREATED');
  await audit(tx, operatorId, sourceMessageId, 'service_order', order.id, 'CREATE', null, status);
  if (total !== null) {
    await saveState(tx, operatorId, 'CONFIRM', { description, ...extras }, order.id, replyTo);
    return { id: order.id, awaitingConfirmation: true };
  }
  await saveState(tx, operatorId, 'VALUE', { description, ...extras }, order.id, replyTo);
  return { id: order.id, awaitingConfirmation: false };
}

// Aplica o valor do serviço por UPDATE condicional atômico e move a OS para
// AGUARDANDO_CONFIRMACAO, gravando auditoria. Usado pelo fluxo guiado e pelo
// pré-preenchimento do áudio.
async function setValue(tx: Tx, operatorId: string, sourceMessageId: string, orderId: string, cents: number): Promise<void> {
  const updated = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE service_orders SET amount_cents=$2, status='AGUARDANDO_CONFIRMACAO'
      WHERE id=$1::uuid AND status='AGUARDANDO_DADOS' RETURNING id`,
    orderId, cents,
  );
  const row = updated[0];
  if (!row) throw new Error('ORDER_NOT_AWAITING_DATA');
  await audit(tx, operatorId, sourceMessageId, 'service_order', orderId, 'SET_VALUE', 'AGUARDANDO_DADOS', 'AGUARDANDO_CONFIRMACAO');
}

async function replyWithCustomerOrders(
  tx: Tx, operatorId: string, sourceMessageId: string, replyTo: string, customer: CustomerRow,
): Promise<void> {
  const orders = await tx.$queryRawUnsafe<{ number: number; status: string; description: string; amount_cents: number | null }[]>(
    'SELECT number, status, description, amount_cents FROM service_orders WHERE customer_id=$1::uuid ORDER BY number DESC',
    customer.id,
  );
  const body = orders.length
    ? `OS de ${customer.name}:\n${orders.map((order) => `${osLabel(order.number)} — ${order.status} — ${formatMoney(order.amount_cents)} — ${order.description}`).join('\n')}`
    : `Não há OS para ${customer.name}.`;
  await queueReply(tx, operatorId, sourceMessageId, replyTo, body, 'query-customer');
}

async function resolveCustomer(
  tx: Tx,
  operatorId: string,
  sourceMessageId: string,
  replyTo: string,
  description: string,
  name: string,
  purpose: Purpose = 'CREATE',
  extras: OrderExtras = {},
  prefix = '',
): Promise<void> {
  const prefixed = (body: string) => (prefix ? `${prefix}\n${body}` : body);
  const matches = await tx.$queryRawUnsafe<CustomerRow[]>(
    'SELECT id, name FROM customers WHERE strpos(normalized_name, $1)>0 ORDER BY created_at, id',
    normalize(name),
  );
  if (matches.length === 1) {
    const customer = matches[0];
    if (purpose === 'QUERY') {
      await replyWithCustomerOrders(tx, operatorId, sourceMessageId, replyTo, customer);
      return;
    }
    const order = await createOrder(tx, operatorId, sourceMessageId, replyTo, description, customer.id, extras);
    const reply = order.awaitingConfirmation
      ? await orderSummary(tx, order.id)
      : 'Qual é o valor do atendimento? (ex.: R$ 150,00)';
    await queueReply(tx, operatorId, sourceMessageId, replyTo, prefixed(reply), 'customer');
    return;
  }
  if (matches.length === 0) {
    if (purpose === 'QUERY') {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Não encontrei cliente com esse nome: ${name}.`, 'query-missing');
      return;
    }
    await saveState(tx, operatorId, 'CUSTOMER_CREATE', { description, name, purpose, ...extras }, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo, prefixed(`Não encontrei “${name}”. Deseja cadastrar este cliente? Responda sim ou não.`), 'customer-none');
    return;
  }
  await saveState(tx, operatorId, 'CUSTOMER_CHOOSE', { description, name, purpose, candidates: matches, ...extras }, null, replyTo);
  const choices = matches.map((customer, index) => `${index + 1}. ${customer.name}`).join('\n');
  await queueReply(tx, operatorId, sourceMessageId, replyTo, prefixed(`Encontrei mais de um cliente:\n${choices}\nResponda com o número.`), 'customer-many');
}

async function processQuery(
  tx: Tx, operatorId: string, sourceMessageId: string, replyTo: string, body: string,
): Promise<boolean> {
  if (/^ajuda$/i.test(body)) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Comandos: novo; OS <número>; mostra as OS do <nome>; o que fiz hoje?; corrigir valor <valor>; corrigir descrição <texto>; cancelar.', 'help');
    return true;
  }
  const os = body.match(/^OS\s+(\d+)$/i);
  if (os) {
    const rows = await tx.$queryRawUnsafe<OrderRow[]>(
      `SELECT so.id, so.number, so.status, so.description, so.amount_cents, c.name AS customer
         FROM service_orders AS so JOIN customers AS c ON c.id=so.customer_id WHERE so.number=$1`,
      Number(os[1]),
    );
    const order = rows[0] as (OrderRow & { status: string }) | undefined;
    const response = order
      ? `${osLabel(order.number)} — ${order.status}\nCliente: ${order.customer}\nDescrição: ${order.description}\nValor: ${formatMoney(order.amount_cents)}`
      : 'OS não encontrada.';
    await queueReply(tx, operatorId, sourceMessageId, replyTo, response, 'query-os');
    return true;
  }
  const customer = body.match(/^mostra\s+(?:as\s+)?OS\s+d[oa]\s+(.+?)\??$/i);
  if (customer) {
    await resolveCustomer(tx, operatorId, sourceMessageId, replyTo, '', clean(customer[1]), 'QUERY');
    return true;
  }
  if (/^(?:quais\s+(?:os\s+)?atendimentos\s+(?:(?:eu\s+)?fiz\s+|de\s+)?hoje|o\s+que\s+(?:eu\s+)?fiz\s+hoje)\??$/i.test(body)) {
    const orders = await tx.$queryRawUnsafe<{ number: number; status: string; description: string; customer: string }[]>(
      `SELECT so.number, so.status, so.description, c.name AS customer
         FROM service_orders AS so JOIN customers AS c ON c.id=so.customer_id
        WHERE (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date=(now() AT TIME ZONE 'America/Sao_Paulo')::date
        ORDER BY so.number`,
    );
    const response = orders.length
      ? `Atendimentos de hoje:\n${orders.map((order) => `${osLabel(order.number)} — ${order.customer} — ${order.status} — ${order.description}`).join('\n')}`
      : 'Não há atendimentos registrados hoje.';
    await queueReply(tx, operatorId, sourceMessageId, replyTo, response, 'query-today');
    return true;
  }
  if (/^(?:mostra|quais|quanto|hist[oó]rico|atendimentos|o que|os\b)/i.test(body)) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      "Consulte 'OS 12', 'mostra as OS do Carlos' ou 'quais atendimentos fiz hoje?'.", 'query-help');
    return true;
  }
  return false;
}

async function cancelPending(
  tx: Tx, message: MessageRow, replyTo: string,
): Promise<void> {
  if (message.service_order_id) {
    const orders = await tx.$queryRawUnsafe<{ id: string; status: string }[]>(
      `WITH previous AS MATERIALIZED (
         SELECT id, status FROM service_orders WHERE id=$1::uuid FOR UPDATE
       )
       UPDATE service_orders AS so SET status='CANCELADA', cancelled_at=now()
         FROM previous WHERE so.id=previous.id AND previous.status <> 'CANCELADA'
       RETURNING so.id, previous.status`,
      message.service_order_id,
    );
    const order = orders[0];
    if (order) {
      await audit(tx, message.operator_id, message.id, 'service_order', order.id, 'CANCEL', order.status, 'CANCELADA', 'operador cancelou');
    }
  }
  await saveState(tx, message.operator_id, null, null, null, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo, 'Operação cancelada.', 'cancel');
}

async function correctOrder(
  tx: Tx, message: MessageRow, payload: ConversationPayload, body: string, replyTo: string,
): Promise<boolean> {
  if (!message.service_order_id) return false;
  const value = body.match(/^corrigir\s+valor\s+(.+)$/i);
  if (value) {
    const cents = parseMoney(value[1]);
    if (cents === null) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Valor inválido. Use, por exemplo, 150 ou 150,00.', 'bad-money');
      return true;
    }
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE service_orders SET amount_cents=$2, status='AGUARDANDO_CONFIRMACAO'
        WHERE id=$1::uuid AND status IN ('AGUARDANDO_DADOS', 'AGUARDANDO_CONFIRMACAO') RETURNING id`,
      message.service_order_id, cents,
    );
    const order = rows[0];
    if (!order) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Esta OS não pode mais ser corrigida.', 'fix-closed');
      return true;
    }
    await audit(tx, message.operator_id, message.id, 'service_order', order.id, 'SET_VALUE',
      message.pending_action === 'VALUE' ? 'AGUARDANDO_DADOS' : 'AGUARDANDO_CONFIRMACAO', 'AGUARDANDO_CONFIRMACAO');
    await saveState(tx, message.operator_id, 'CONFIRM', payload, order.id, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, await orderSummary(tx, order.id), 'fix-value');
    return true;
  }
  const description = body.match(/^corrigir\s+descriç[aã]o\s+(.+)$/i);
  if (!description) return false;
  const corrected = clean(description[1]);
  if (!corrected) {
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Informe uma descrição válida.', 'bad-description');
    return true;
  }
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE service_orders SET description=$2
      WHERE id=$1::uuid AND status IN ('AGUARDANDO_DADOS', 'AGUARDANDO_CONFIRMACAO') RETURNING id`,
    message.service_order_id, corrected,
  );
  const order = rows[0];
  if (!order) {
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Esta OS não pode mais ser corrigida.', 'fix-closed');
    return true;
  }
  const status = message.pending_action === 'VALUE' ? 'AGUARDANDO_DADOS' : 'AGUARDANDO_CONFIRMACAO';
  await audit(tx, message.operator_id, message.id, 'service_order', order.id, 'SET_DESCRIPTION', status, status);
  const nextPayload = { ...payload, description: corrected };
  await saveState(tx, message.operator_id, message.pending_action, nextPayload, order.id, replyTo);
  const response = message.pending_action === 'CONFIRM'
    ? await orderSummary(tx, order.id)
    : 'Descrição corrigida. Qual é o valor do atendimento?';
  await queueReply(tx, message.operator_id, message.id, replyTo, response, 'fix-description');
  return true;
}

// Dinheiro chega do LLM como número em reais; converte para centavos com
// validação estrita. Valor inválido/alucinado é descartado (vira null) e o
// fluxo determinístico pergunta o valor — nunca presume.
function centsFromReal(value: number | null): number | undefined {
  if (value === null) return undefined;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : undefined;
}

function audioIntro(transcription: string, extraction: {
  customerName: string | null;
  serviceAmount: number | null;
  materialsAmount: number | null;
  dueDate: string | null;
}): string {
  const parts: string[] = [`Ouvi: "${transcription}"`];
  const interpreted: string[] = [];
  if (extraction.customerName) interpreted.push(`cliente "${extraction.customerName}"`);
  const total = (extraction.serviceAmount ?? 0) + (extraction.materialsAmount ?? 0);
  if (extraction.serviceAmount !== null || extraction.materialsAmount !== null) {
    interpreted.push(`valor R$ ${total.toFixed(2).replace('.', ',')}`);
  }
  if (extraction.dueDate) {
    interpreted.push(`vence ${new Date(`${extraction.dueDate}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`);
  }
  if (interpreted.length > 0) parts.push(`Interpretei: ${interpreted.join(', ')}.`);
  return parts.join('\n');
}

async function skipAudio(
  tx: Tx, message: MessageRow, replyTo: string, reason: string, body: string, suffix: string,
): Promise<void> {
  await tx.$executeRawUnsafe('UPDATE messages SET skipped_reason=$2 WHERE id=$1::uuid', message.id, reason);
  await queueReply(tx, message.operator_id, message.id, replyTo, body, suffix);
}

async function handleAudioMessage(tx: Tx, cfg: Config, message: MessageRow, replyTo: string): Promise<void> {
  const mimetype = message.media_mimetype ?? '';
  if (!mimetype.startsWith('audio/')) {
    await skipAudio(tx, message, replyTo, 'MEDIA_UNSUPPORTED',
      'Aceito apenas texto ou nota de voz (áudio). Imagens e documentos ficam para um próximo ciclo.', 'unsupported');
    return;
  }
  if (!cfg.GROQ_API_KEY) {
    await skipAudio(tx, message, replyTo, 'AUDIO_NOT_CONFIGURED',
      'Áudio não está configurado nesta instalação. Descreva o atendimento por texto (envie novo).', 'audio-unconfigured');
    return;
  }
  // Áudio durante pendência = o operador quer redizer o atendimento por voz:
  // a interpretação nova substitui a pendência anterior (avisando o descarte).

  const mediaPath = message.media_path ?? `/api/files/${cfg.WAHA_SESSION}/${message.message_id}.oga`;
  let media: { bytes: Buffer; contentType: string };
  try {
    media = await downloadWahaMedia(cfg, mediaPath, cfg.WAHA_MEDIA_MAX_BYTES);
  } catch (error) {
    if (error instanceof MediaFailure && error.outcome === 'REJECTED') {
      const reason = error.message.startsWith('WAHA_MEDIA_TOO_LARGE') ? 'AUDIO_TOO_LARGE' : 'AUDIO_DOWNLOAD_FAILED';
      await skipAudio(tx, message, replyTo, reason,
        'Não consegui baixar o áudio (grande demais ou indisponível). Tente gravar novamente ou envie por texto (novo).', 'audio-download');
      return;
    }
    throw error; // TRANSIENT: volta para a inbox com retry limitado.
  }
  if (!media.contentType.startsWith('audio/')) {
    await skipAudio(tx, message, replyTo, 'MEDIA_UNSUPPORTED',
      'O anexo não é um áudio suportado. Envie texto ou nota de voz.', 'unsupported');
    return;
  }

  let transcription: string;
  try {
    transcription = (await transcribeAudio(cfg, media.bytes, `${message.message_id}.oga`)).trim().slice(0, 4000);
  } catch (error) {
    if (error instanceof GroqFailure && error.outcome === 'REJECTED') {
      await skipAudio(tx, message, replyTo, 'AUDIO_STT_FAILED',
        'Não consegui transcrever o áudio. Tente gravar novamente ou envie por texto (novo).', 'audio-stt');
      return;
    }
    throw error;
  }
  await tx.$executeRawUnsafe('UPDATE messages SET transcription=$2 WHERE id=$1::uuid', message.id, transcription);
  if (transcription.length === 0) {
    await skipAudio(tx, message, replyTo, 'AUDIO_EMPTY_TRANSCRIPTION',
      'O áudio chegou sem conteúdo de fala. Grave novamente ou envie por texto (novo).', 'audio-empty');
    return;
  }
  const discardNotice = message.pending_action !== null ? 'A operação anterior foi descartada.\n' : '';

  let extraction: Extraction;
  try {
    extraction = await extractServiceIntent(cfg, transcription);
  } catch (error) {
    if (error instanceof GroqFailure && error.outcome !== 'TRANSIENT') {
      // Fallback determinístico: a transcrição vira a descrição e o fluxo
      // guiado pergunta o resto. Nunca bloqueia o operador por falha de IA.
      await saveState(tx, message.operator_id, 'CUSTOMER_NAME', { description: transcription }, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo,
        `${discardNotice}Ouvi: "${transcription}"\nNão consegui interpretar automaticamente. Vamos pelo fluxo normal: qual é o nome do cliente?`, 'audio-fallback');
      return;
    }
    throw error;
  }

  if (extraction.intent !== 'REGISTRAR_SERVICO') {
    await skipAudio(tx, message, replyTo, 'AUDIO_INTENT_IGNORED',
      `${discardNotice}${audioIntro(transcription, extraction)}\nIsto não parece um atendimento. Envie novo e descreva o serviço, ou use ajuda.`, 'audio-intent');
    return;
  }

  const extras: OrderExtras = {
    serviceAmountCents: centsFromReal(extraction.serviceAmount),
    materialAmountCents: centsFromReal(extraction.materialsAmount),
    dueDate: extraction.dueDate ?? undefined,
  };
  const intro = `${discardNotice}${audioIntro(transcription, extraction)}`;
  if (extraction.customerName) {
    await resolveCustomer(tx, message.operator_id, message.id, replyTo,
      extraction.serviceDescription ?? transcription, extraction.customerName, 'CREATE', extras, intro);
    return;
  }
  await saveState(tx, message.operator_id, 'CUSTOMER_NAME', { description: extraction.serviceDescription ?? transcription, ...extras }, null, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo, `${intro}\nQual é o nome do cliente?`, 'audio-customer');
}

// Recibo curto pós-confirmação: o operador fica com o comprovativo na conversa.
async function confirmationReceipt(tx: Tx, orderId: string): Promise<string> {
  const orders = await tx.$queryRawUnsafe<OrderRow[]>(
    `SELECT so.id, so.number, so.description, so.amount_cents, so.due_date, c.name AS customer
       FROM service_orders AS so JOIN customers AS c ON c.id=so.customer_id
      WHERE so.id=$1::uuid`,
    orderId,
  );
  const order = orders[0];
  if (!order) throw new Error('ORDER_NOT_FOUND');
  const dueIso = order.due_date instanceof Date ? order.due_date.toISOString().slice(0, 10) : order.due_date;
  const dueLine = dueIso
    ? `\nVence: ${new Date(`${dueIso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`
    : '';
  return `${osLabel(order.number)} confirmada.\nCliente: ${order.customer}\nDescrição: ${order.description}\nValor: ${formatMoney(order.amount_cents)}${dueLine}`;
}

export async function processMessage(tx: Tx, event: EventRow, cfg: Config): Promise<void> {
  const messages = await tx.$queryRawUnsafe<MessageRow[]>(
    `SELECT m.id, m.message_id, m.operator_id, m.reply_to, m.body, m.has_media,
            m.media_mimetype, m.media_path,
            cs.pending_action, cs.payload, cs.service_order_id, cs.expires_at
       FROM messages AS m LEFT JOIN conversation_states AS cs ON cs.operator_id=m.operator_id
      WHERE m.id=$1::uuid`,
    event.message_db_id,
  );
  const message = messages[0];
  if (!message) throw new Error('MESSAGE_NOT_FOUND');

  const body = clean(message.body ?? '');
  const replyTo = message.reply_to;
  if (message.has_media) {
    await handleAudioMessage(tx, cfg, message, replyTo);
    return;
  }
  if (!body) {
    await tx.$executeRawUnsafe('UPDATE messages SET skipped_reason=$2 WHERE id=$1::uuid', message.id, 'EMPTY_TEXT');
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Envie texto ou uma nota de voz descrevendo o atendimento.', 'unsupported');
    return;
  }

  const hasState = message.pending_action !== null;
  if (hasState && message.expires_at !== null && message.expires_at <= new Date()) {
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'A operação pendente expirou. Envie novo para recomeçar.', 'expired');
    return;
  }
  if (hasState && /^ajuda$/i.test(body)) {
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Há uma operação pendente. Responda ao que foi solicitado, use corrigir valor/descrição ou cancelar.', 'pending-help');
    return;
  }
  if (hasState && (/^cancelar$/i.test(body) || (message.pending_action === 'CONFIRM' && isNo(body)))) {
    await cancelPending(tx, message, replyTo);
    return;
  }
  if (!hasState && /^corrigir\b/i.test(body)) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      'Não há OS em edição. Uma OS confirmada ou cancelada não pode ser alterada nesta POC.', 'no-order-edit');
    return;
  }
  if (!hasState && await processQuery(tx, message.operator_id, message.id, replyTo, body)) return;
  if (!hasState && isYes(body)) {
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Não há confirmação pendente.', 'no-confirmation');
    return;
  }
  if (!hasState && isNo(body)) {
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Não há operação pendente para cancelar.', 'no-pending-operation');
    return;
  }
  if (!hasState) {
    if (/^novo$/i.test(body)) {
      await saveState(tx, message.operator_id, 'DESCRIPTION', {}, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Descreva o atendimento.', 'new');
      return;
    }
    await saveState(tx, message.operator_id, 'CUSTOMER_NAME', { description: body }, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Qual é o nome do cliente?', 'description');
    return;
  }

  const payload = payloadOf(message.payload);
  if (await correctOrder(tx, message, payload, body, replyTo)) return;
  if (message.pending_action === 'DESCRIPTION') {
    await saveState(tx, message.operator_id, 'CUSTOMER_NAME', { description: body }, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Qual é o nome do cliente?', 'description-next');
    return;
  }
  if (message.pending_action === 'CUSTOMER_NAME') {
    await resolveCustomer(tx, message.operator_id, message.id, replyTo, payload.description ?? '', clean(body));
    return;
  }
  if (message.pending_action === 'CUSTOMER_CREATE') {
    if (isYes(body)) {
      const name = payload.name;
      if (!name) throw new Error('CUSTOMER_NAME_MISSING');
      const customers = await tx.$queryRawUnsafe<CustomerRow[]>(
        'INSERT INTO customers(name, normalized_name) VALUES($1, $2) RETURNING id, name',
        name, normalize(name),
      );
      const customer = customers[0];
      if (!customer) throw new Error('CUSTOMER_NOT_CREATED');
      await audit(tx, message.operator_id, message.id, 'customer', customer.id, 'CREATE', null, null);
      if (payload.purpose === 'QUERY') {
        await saveState(tx, message.operator_id, null, null, null, replyTo);
        await queueReply(tx, message.operator_id, message.id, replyTo, `Cliente ${customer.name} criado; não há OS para ele.`, 'created-query');
      } else {
        const order = await createOrder(
          tx, message.operator_id, message.id, replyTo,
          payload.description ?? '', customer.id,
          { serviceAmountCents: payload.serviceAmountCents, materialAmountCents: payload.materialAmountCents, dueDate: payload.dueDate },
        );
        const reply = order.awaitingConfirmation
          ? await orderSummary(tx, order.id)
          : 'Cliente cadastrado. Qual é o valor do atendimento?';
        await queueReply(tx, message.operator_id, message.id, replyTo, reply, 'created');
      }
      return;
    }
    await saveState(tx, message.operator_id, 'CUSTOMER_NAME', { description: payload.description, ...payload }, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Informe novamente o nome do cliente.', 'customer-again');
    return;
  }
  if (message.pending_action === 'CUSTOMER_CHOOSE') {
    const choice = Number(body);
    const candidate = Number.isInteger(choice) ? payload.candidates?.[choice - 1] : undefined;
    if (!candidate) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Escolha um número da lista.', 'choose-invalid');
      return;
    }
    if (payload.purpose === 'QUERY') {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await replyWithCustomerOrders(tx, message.operator_id, message.id, replyTo, candidate);
    } else {
      const order = await createOrder(
        tx, message.operator_id, message.id, replyTo,
        payload.description ?? '', candidate.id,
        { serviceAmountCents: payload.serviceAmountCents, materialAmountCents: payload.materialAmountCents, dueDate: payload.dueDate },
      );
      const reply = order.awaitingConfirmation
        ? await orderSummary(tx, order.id)
        : 'Qual é o valor do atendimento?';
      await queueReply(tx, message.operator_id, message.id, replyTo, reply, 'choose');
    }
    return;
  }
  if (message.pending_action === 'VALUE') {
    const cents = parseMoney(body);
    if (cents === null) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Valor inválido. Use, por exemplo, 150 ou 150,00.', 'value-invalid');
      return;
    }
    if (!message.service_order_id) throw new Error('ORDER_ID_MISSING');
    await setValue(tx, message.operator_id, message.id, message.service_order_id, cents);
    await saveState(tx, message.operator_id, 'CONFIRM', payload, message.service_order_id, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, await orderSummary(tx, message.service_order_id), 'value');
    return;
  }
  if (message.pending_action === 'CONFIRM') {
    if (!isYes(body)) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Aguardo confirmação da OS: responda sim ou cancelar.', 'confirm-invalid');
      return;
    }
    const orders = await tx.$queryRawUnsafe<{ id: string }[]>(
      "UPDATE service_orders SET status='CONFIRMADA', confirmed_at=now() WHERE id=$1::uuid AND status='AGUARDANDO_CONFIRMACAO' RETURNING id",
      message.service_order_id,
    );
    const order = orders[0];
    if (!order) throw new Error('ORDER_NOT_AWAITING_CONFIRMATION');
    await audit(tx, message.operator_id, message.id, 'service_order', order.id, 'CONFIRM', 'AGUARDANDO_CONFIRMACAO', 'CONFIRMADA');
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, await confirmationReceipt(tx, order.id), 'confirm');
    return;
  }
  throw new Error(`UNKNOWN_PENDING_ACTION:${message.pending_action}`);
}
