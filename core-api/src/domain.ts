import type { JsonRecord, Tx } from './types.js';
import { formatMoney, isNo, isYes, normalize, osLabel, parseMoney } from './types.js';

type Purpose = 'CREATE' | 'QUERY';
type CustomerRow = { id: string; name: string };
type OrderRow = { id: string; number: number; description: string; amount_cents: number | null; customer: string };
type EventRow = { message_db_id: string };
type MessageRow = {
  id: string;
  operator_id: string;
  reply_to: string;
  body: string | null;
  has_media: boolean;
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
  return {
    description: typeof record.description === 'string' ? record.description : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    purpose: record.purpose === 'CREATE' || record.purpose === 'QUERY' ? record.purpose : undefined,
    candidates,
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
    `SELECT so.id, so.number, so.description, so.amount_cents, c.name AS customer
       FROM service_orders AS so JOIN customers AS c ON c.id=so.customer_id
      WHERE so.id=$1::uuid`,
    orderId,
  );
  const order = orders[0];
  if (!order) throw new Error('ORDER_NOT_FOUND');
  return `${osLabel(order.number)}\nCliente: ${order.customer}\nDescrição: ${order.description}\nValor: ${formatMoney(order.amount_cents)}\nConfirma? Responda sim ou cancelar.`;
}

async function createOrder(
  tx: Tx,
  operatorId: string,
  sourceMessageId: string,
  replyTo: string,
  description: string,
  customerId: string,
): Promise<string> {
  const orders = await tx.$queryRawUnsafe<{ id: string }[]>(
    "INSERT INTO service_orders(customer_id, description, status) VALUES($1::uuid, $2, 'AGUARDANDO_DADOS') RETURNING id",
    customerId, description,
  );
  const order = orders[0];
  if (!order) throw new Error('ORDER_NOT_CREATED');
  await audit(tx, operatorId, sourceMessageId, 'service_order', order.id, 'CREATE', null, 'AGUARDANDO_DADOS');
  await saveState(tx, operatorId, 'VALUE', { description }, order.id, replyTo);
  return order.id;
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
): Promise<void> {
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
    await createOrder(tx, operatorId, sourceMessageId, replyTo, description, customer.id);
    await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Qual é o valor do atendimento? (ex.: R$ 150,00)', 'customer');
    return;
  }
  if (matches.length === 0) {
    if (purpose === 'QUERY') {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Não encontrei cliente com esse nome: ${name}.`, 'query-missing');
      return;
    }
    await saveState(tx, operatorId, 'CUSTOMER_CREATE', { description, name, purpose }, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo, `Não encontrei “${name}”. Deseja cadastrar este cliente? Responda sim ou não.`, 'customer-none');
    return;
  }
  await saveState(tx, operatorId, 'CUSTOMER_CHOOSE', { description, name, purpose, candidates: matches }, null, replyTo);
  const choices = matches.map((customer, index) => `${index + 1}. ${customer.name}`).join('\n');
  await queueReply(tx, operatorId, sourceMessageId, replyTo, `Encontrei mais de um cliente:\n${choices}\nResponda com o número.`, 'customer-many');
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

export async function processMessage(tx: Tx, event: EventRow): Promise<void> {
  const messages = await tx.$queryRawUnsafe<MessageRow[]>(
    `SELECT m.id, m.operator_id, m.reply_to, m.body, m.has_media,
            cs.pending_action, cs.payload, cs.service_order_id, cs.expires_at
       FROM messages AS m LEFT JOIN conversation_states AS cs ON cs.operator_id=m.operator_id
      WHERE m.id=$1::uuid`,
    event.message_db_id,
  );
  const message = messages[0];
  if (!message) throw new Error('MESSAGE_NOT_FOUND');

  const body = clean(message.body ?? '');
  const replyTo = message.reply_to;
  if (message.has_media || !body) {
    await tx.$executeRawUnsafe('UPDATE messages SET skipped_reason=$2 WHERE id=$1::uuid', message.id, message.has_media ? 'MEDIA_UNSUPPORTED' : 'EMPTY_TEXT');
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Nesta POC aceito apenas mensagens de texto não vazias.', 'unsupported');
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
        await createOrder(tx, message.operator_id, message.id, replyTo, payload.description ?? '', customer.id);
        await queueReply(tx, message.operator_id, message.id, replyTo, 'Cliente cadastrado. Qual é o valor do atendimento?', 'created');
      }
      return;
    }
    await saveState(tx, message.operator_id, 'CUSTOMER_NAME', { description: payload.description }, null, replyTo);
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
      await createOrder(tx, message.operator_id, message.id, replyTo, payload.description ?? '', candidate.id);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Qual é o valor do atendimento?', 'choose');
    }
    return;
  }
  if (message.pending_action === 'VALUE') {
    const cents = parseMoney(body);
    if (cents === null) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Valor inválido. Use, por exemplo, 150 ou 150,00.', 'value-invalid');
      return;
    }
    const orders = await tx.$queryRawUnsafe<{ id: string }[]>(
      `UPDATE service_orders SET amount_cents=$2, status='AGUARDANDO_CONFIRMACAO'
        WHERE id=$1::uuid AND status='AGUARDANDO_DADOS' RETURNING id`,
      message.service_order_id, cents,
    );
    const order = orders[0];
    if (!order) throw new Error('ORDER_NOT_AWAITING_DATA');
    await audit(tx, message.operator_id, message.id, 'service_order', order.id, 'SET_VALUE', 'AGUARDANDO_DADOS', 'AGUARDANDO_CONFIRMACAO');
    await saveState(tx, message.operator_id, 'CONFIRM', payload, order.id, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, await orderSummary(tx, order.id), 'value');
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
    await queueReply(tx, message.operator_id, message.id, replyTo, order ? 'OS confirmada.' : 'Não há confirmação pendente para esta OS.', 'confirm');
    return;
  }
  throw new Error(`UNKNOWN_PENDING_ACTION:${message.pending_action}`);
}
