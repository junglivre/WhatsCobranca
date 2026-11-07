import type { Config } from './config.js';
import type { JsonRecord, Tx } from './types.js';
import { formatMoney, formatQty, isNo, isYes, normalize, osLabel, parseMoney, parseQuantity } from './types.js';
import { downloadWahaMedia, MediaFailure } from './waha.js';
import { extractServiceIntent, GroqFailure, transcribeAudio, type Extraction } from './groq.js';
import { getBillingProvider, getInvoiceProvider } from './providers/registry.js';
import { MissingFiscalIdError } from './providers/billing/types.js';
import type { CreatedCharge } from './providers/billing/types.js';
import type { InvoiceRequestResult } from './providers/invoices/types.js';

type Purpose = 'CREATE' | 'QUERY' | 'MATERIAL';
type CustomerRow = { id: string; name: string };
type MaterialRow = { id: string; name: string; unit: string; quantity: string; min_quantity: string | null };
type OrderRow = {
  id: string;
  number: number;
  description: string;
  amount_cents: number | null;
  due_date: Date | string | null;
  customer: string;
};
type OrderItemRow = { id: string; raw_name: string; quantity: string; inventory_item_id: string | null; unit: string | null; item_name: string | null };
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
// Quantidade de item é string numeric (12,3) — nunca Float em JS.
type MaterialDraft = { rawName: string; quantity: string; inventoryItemId?: string };
type ConversationPayload = {
  description?: string;
  name?: string;
  purpose?: Purpose;
  candidates?: Array<{ id: string; name: string }>;
  serviceAmountCents?: number;
  materialAmountCents?: number;
  dueDate?: string;
  materialsDraft?: MaterialDraft[];
  materialsPending?: Array<{ quantity: string; rawName: string }>;
  matName?: string;
  matUnit?: string;
  matSaldo?: string;
  matMinimo?: string;
  entryQuantity?: string;
  adjustQuantity?: string;
  returnQuantity?: string;
  returnOsNumber?: number;
  // Comandos de estoque executados durante CONFIRM restauram o estado da OS
  // depois de executar (snapshot do payload de confirmação + orderId).
  restoreConfirm?: { payload: ConversationPayload; orderId: string };
  // ===== Fase 6 (cobrança) — a OS referenciada fica SÓ no payload
  // (chargeOsId), nunca em conversation_states.service_order_id: cancelar a
  // conversa de cobrança não pode cancelar a OS (cancelPending cancela a OS
  // quando service_order_id está preenchido).
  chargeOsId?: string;
  chargeOsNumber?: number;
  chargeCustomerName?: string;
  chargeMethod?: 'PIX' | 'BOLETO';
  chargeDueDate?: string;
  chargeValueCents?: number;
  chargeDbId?: string;
  receiptCents?: number;
  receiptMethod?: 'CASH' | 'EXTERNAL_PIX';
  // Alterações de cadastro aguardando escolha quando o nome é ambíguo.
  customerUpdate?: {
    kind: 'PHONE' | 'EMAIL' | 'ADDRESS' | 'BILLING_OPT_IN';
    value: string | boolean | CustomerAddress;
  };
  cancelOrderId?: string;
  cancelOrderNumber?: number;
  chargeSendTo?: string;
  chargeSendBody?: string;
  chargeSendId?: string;
  invoiceOrderId?: string;
  invoiceOsNumber?: number;
  invoiceServiceCode?: string;
  // Comando `cpf <nome> <documento>` com nome ambíguo: o documento já
  // validado viaja no payload enquanto o operador escolhe o cliente.
  cpfDoc?: string;
};

type CustomerAddress = {
  street: string;
  number: string;
  district: string;
  city: string;
  state: string;
  zip: string;
};

type CustomerContactRow = CustomerRow & {
  cpf_cnpj: string | null;
  phone: string | null;
  email: string | null;
  address_street: string | null;
  address_number: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
  billing_opt_in: boolean;
};

type CancelOrderRow = {
  id: string;
  number: number;
  status: string;
  customer: string;
  amount_cents: number | null;
};

type ChargeSendRow = {
  id: string;
  number: number;
  customer: string;
  description: string;
  phone: string;
  billing_opt_in: boolean;
  amount_cents: number;
  due_date: Date | string | null;
  pix_copy_paste: string | null;
};


const thirtyMinutes = () => new Date(Date.now() + 30 * 60 * 1000);
const clean = (value: string) => value.trim();

function payloadOf(value: unknown): ConversationPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as JsonRecord;
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.filter((candidate): candidate is { id: string; name: string } =>
      typeof candidate === 'object' && candidate !== null &&
      typeof (candidate as JsonRecord).id === 'string' &&
      typeof (candidate as JsonRecord).name === 'string')
    : undefined;
  const positiveCents = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const quantityString = (value: unknown): string | undefined =>
    typeof value === 'string' && /^\d{1,9}(?:\.\d{1,3})?$/.test(value) ? value : undefined;
  const isMaterialDraft = (entry: unknown): entry is MaterialDraft => {
    if (typeof entry !== 'object' || entry === null) return false;
    const draft = entry as JsonRecord;
    return typeof draft.rawName === 'string' && draft.rawName.length > 0 && quantityString(draft.quantity) !== undefined;
  };
  const materialsDraft = Array.isArray(record.materialsDraft)
    ? record.materialsDraft.filter(isMaterialDraft).map((draft) => ({
      rawName: draft.rawName,
      quantity: draft.quantity as string,
      ...(typeof (draft as JsonRecord).inventoryItemId === 'string'
        ? { inventoryItemId: (draft as JsonRecord).inventoryItemId as string }
        : {}),
    }))
    : undefined;
  const materialsPending = Array.isArray(record.materialsPending)
    ? record.materialsPending.filter(isMaterialDraft).map((draft) => ({
      quantity: draft.quantity as string,
      rawName: draft.rawName,
    }))
    : undefined;
  return {
    description: typeof record.description === 'string' ? record.description : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    purpose: record.purpose === 'CREATE' || record.purpose === 'QUERY' || record.purpose === 'MATERIAL' ? record.purpose : undefined,
    candidates,
    serviceAmountCents: positiveCents(record.serviceAmountCents),
    materialAmountCents: positiveCents(record.materialAmountCents),
    dueDate: typeof record.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.dueDate)
      ? record.dueDate
      : undefined,
    materialsDraft,
    materialsPending,
    matName: typeof record.matName === 'string' ? record.matName : undefined,
    matUnit: typeof record.matUnit === 'string' ? record.matUnit : undefined,
    matSaldo: quantityString(record.matSaldo),
    matMinimo: typeof record.matMinimo === 'string' && record.matMinimo.length <= 12 ? record.matMinimo : undefined,
    entryQuantity: quantityString(record.entryQuantity),
    adjustQuantity: quantityString(record.adjustQuantity),
    returnQuantity: quantityString(record.returnQuantity),
    returnOsNumber: typeof record.returnOsNumber === 'number' && Number.isSafeInteger(record.returnOsNumber)
      ? record.returnOsNumber
      : undefined,
    restoreConfirm: (() => {
      const restore = record.restoreConfirm;
      if (typeof restore !== 'object' || restore === null) return undefined;
      const inner = (restore as JsonRecord).payload;
      const orderId = (restore as JsonRecord).orderId;
      if (typeof orderId !== 'string' || orderId.length === 0 || typeof inner !== 'object' || inner === null) return undefined;
      return { payload: payloadOf(inner), orderId };
    })(),
    chargeOsId: typeof record.chargeOsId === 'string' && record.chargeOsId.length > 0 ? record.chargeOsId : undefined,
    chargeOsNumber: typeof record.chargeOsNumber === 'number' && Number.isSafeInteger(record.chargeOsNumber) && record.chargeOsNumber > 0
      ? record.chargeOsNumber
      : undefined,
    chargeCustomerName: typeof record.chargeCustomerName === 'string' ? record.chargeCustomerName : undefined,
    chargeMethod: record.chargeMethod === 'PIX' || record.chargeMethod === 'BOLETO' ? record.chargeMethod : undefined,
    chargeDueDate: typeof record.chargeDueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.chargeDueDate)
      ? record.chargeDueDate
      : undefined,
    chargeValueCents: positiveCents(record.chargeValueCents),
    chargeDbId: typeof record.chargeDbId === 'string' && record.chargeDbId.length > 0 ? record.chargeDbId : undefined,
    receiptCents: positiveCents(record.receiptCents),
    receiptMethod: record.receiptMethod === 'CASH' || record.receiptMethod === 'EXTERNAL_PIX' ? record.receiptMethod : undefined,
    cpfDoc: typeof record.cpfDoc === 'string' && /^\d{11}(?:\d{3})?$/.test(record.cpfDoc) ? record.cpfDoc : undefined,
    customerUpdate: (() => {
      const update = record.customerUpdate;
      if (typeof update !== 'object' || update === null) return undefined;
      const kind = (update as JsonRecord).kind;
      const updateValue = (update as JsonRecord).value;
      if (kind === 'PHONE' || kind === 'EMAIL') {
        return typeof updateValue === 'string' && updateValue.length > 0 ? { kind, value: updateValue } : undefined;
      }
      if (kind === 'BILLING_OPT_IN') {
        return typeof updateValue === 'boolean' ? { kind, value: updateValue } : undefined;
      }
      if (kind === 'ADDRESS' && typeof updateValue === 'object' && updateValue !== null) {
        const address = updateValue as JsonRecord;
        const fields = ['street', 'number', 'district', 'city', 'state', 'zip'] as const;
        if (fields.every((field) => typeof address[field] === 'string' && (address[field] as string).length > 0)) {
          return {
            kind,
            value: {
              street: address.street as string, number: address.number as string, district: address.district as string,
              city: address.city as string, state: address.state as string, zip: address.zip as string,
            },
          };
        }
      }
      return undefined;
    })(),
    cancelOrderId: typeof record.cancelOrderId === 'string' && record.cancelOrderId.length > 0 ? record.cancelOrderId : undefined,
    cancelOrderNumber: typeof record.cancelOrderNumber === 'number' && Number.isSafeInteger(record.cancelOrderNumber) && record.cancelOrderNumber > 0
      ? record.cancelOrderNumber
      : undefined,
    chargeSendTo: typeof record.chargeSendTo === 'string' && /^\d{10,13}@c\.us$/.test(record.chargeSendTo) ? record.chargeSendTo : undefined,
    chargeSendBody: typeof record.chargeSendBody === 'string' && record.chargeSendBody.length > 0 ? record.chargeSendBody : undefined,
    chargeSendId: typeof record.chargeSendId === 'string' && record.chargeSendId.length > 0 ? record.chargeSendId : undefined,
    invoiceOrderId: typeof record.invoiceOrderId === 'string' && record.invoiceOrderId.length > 0 ? record.invoiceOrderId : undefined,
    invoiceOsNumber: typeof record.invoiceOsNumber === 'number' && Number.isSafeInteger(record.invoiceOsNumber) && record.invoiceOsNumber > 0
      ? record.invoiceOsNumber
      : undefined,
    invoiceServiceCode: typeof record.invoiceServiceCode === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(record.invoiceServiceCode)
      ? record.invoiceServiceCode
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

// Notificação espontânea ao operador (sem mensagem de correlação) — usada
// pelo /automation/tick para avisar transições financeiras (cobrança
// recebida/vencida/cancelada/estornada). dedup_key obrigatória e única por
// transição: ON CONFLICT DO NOTHING garante notificação única mesmo com
// webhook reenviado, sweep repetido ou eventos duplicados.
export async function queueNotice(
  tx: Tx,
  operatorId: string,
  replyTo: string,
  body: string,
  dedupKey: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO outbound_messages(operator_id, correlation_message_id, reply_to, body, dedup_key)
     VALUES($1::uuid, NULL, $2, $3, $4)
     ON CONFLICT (dedup_key) DO NOTHING`,
    operatorId, replyTo, body, dedupKey,
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

async function orderItemsText(tx: Tx, orderId: string): Promise<string> {
  const items = await tx.$queryRawUnsafe<Array<{ raw_name: string; quantity: string; inventory_item_id: string | null; unit: string | null; item_name: string | null }>>(
    `SELECT soi.raw_name, soi.quantity, soi.inventory_item_id, ii.unit, ii.name AS item_name
       FROM service_order_items soi
       LEFT JOIN inventory_items ii ON ii.id=soi.inventory_item_id
      WHERE soi.service_order_id=$1::uuid ORDER BY soi.position`,
    orderId,
  );
  if (items.length === 0) return '';
  const lines = items.map((item) =>
    `${formatQty(item.quantity)} ${item.item_name ?? item.raw_name}${item.inventory_item_id === null ? ' (pendente de cadastro)' : ''}`);
  const pending = items.filter((item) => item.inventory_item_id === null).map((item) => item.raw_name);
  const pendNote = pending.length > 0 ? `\nPendente de cadastro: ${pending.join(', ')}` : '';
  return `\nMateriais: ${lines.join(', ')}${pendNote}`;
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
  const materials = await orderItemsText(tx, orderId);
  return `${osLabel(order.number)}\nCliente: ${order.customer}\nDescrição: ${order.description}\nValor: ${formatMoney(order.amount_cents)}${dueLine}${materials}\nConfirma? Responda sim ou cancelar.`;
}

type OrderExtras = {
  serviceAmountCents?: number;
  materialAmountCents?: number;
  dueDate?: string;
  materialsDraft?: MaterialDraft[];
};

function totalCents(extras: OrderExtras): number | null {
  const service = extras.serviceAmountCents;
  const material = extras.materialAmountCents;
  if (service === undefined && material === undefined) return null;
  return (service ?? 0) + (material ?? 0);
}

async function insertOrderItems(tx: Tx, orderId: string, draft: MaterialDraft[]): Promise<void> {
  for (const entry of draft) {
    await tx.$executeRawUnsafe(
      `INSERT INTO service_order_items(service_order_id, inventory_item_id, raw_name, quantity)
       VALUES($1::uuid, ${entry.inventoryItemId ? '$2::uuid' : 'NULL'}, ${entry.inventoryItemId ? '$3' : '$2'}, ${entry.inventoryItemId ? '$4' : '$3'}::numeric)`,
      orderId, ...(entry.inventoryItemId ? [entry.inventoryItemId] : []), entry.rawName, entry.quantity,
    );
  }
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
  if (extras.materialsDraft && extras.materialsDraft.length > 0) {
    await insertOrderItems(tx, order.id, extras.materialsDraft);
  }
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
    await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Comandos: novo; OS <número>; mostra as OS do <nome>; o que fiz hoje?; corrigir valor <valor>; corrigir descrição <texto>; corrigir materiais; cancelar; material novo; entrada <qtd> <material>; ajustar <material> para <qtd>; devolver <qtd> <material> OS <n>; saldo <material>; estoque.', 'help');
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
    // Materiais extraídos pelo LLM: cada nome resolve contra o catálogo
    // (match único ganha id; ambíguo/inexistente fica pendente de classificação
    // e o resumo avisa). Nenhum material é criado automaticamente.
    materialsDraft: extraction.materials.length > 0
      ? (await Promise.all(extraction.materials.map(async (material) => {
        const quantity = material.quantity.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
        const matches = await searchMaterials(tx, material.name);
        const inventoryItemId = matches.length === 1 ? matches[0]!.id : undefined;
        return { rawName: material.name, quantity, ...(inventoryItemId ? { inventoryItemId } : {}) };
      })))
      : undefined,
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
  const materials = await orderItemsText(tx, orderId);
  return `${osLabel(order.number)} confirmada.\nCliente: ${order.customer}\nDescrição: ${order.description}\nValor: ${formatMoney(order.amount_cents)}${dueLine}${materials}`;
}

// ===== Estoque (Fase 5) =====

async function searchMaterials(tx: Tx, term: string): Promise<MaterialRow[]> {
  return tx.$queryRawUnsafe<MaterialRow[]>(
    'SELECT id, name, unit, quantity::text AS quantity, min_quantity::text AS min_quantity FROM inventory_items WHERE active AND strpos(normalized_name, $1)>0 ORDER BY created_at, id',
    normalize(term),
  );
}

async function insertMovement(
  tx: Tx, itemId: string, type: 'IN' | 'OUT' | 'ADJUST' | 'RETURN', quantity: string,
  operatorId: string, sourceMessageId: string, reason: string | null, serviceOrderId: string | null,
): Promise<void> {
  // Placeholders numerados não podem pular número: renumera conforme a OS.
  await tx.$executeRawUnsafe(
    `INSERT INTO stock_movements(inventory_item_id, movement_type, quantity, reason, service_order_id, operator_id, source_message_id)
     VALUES($1::uuid, $2, $3::numeric, $4, ${serviceOrderId ? '$5::uuid' : 'NULL'}, ${serviceOrderId ? '$6' : '$5'}::uuid, ${serviceOrderId ? '$7' : '$6'}::uuid)`,
    itemId, type, quantity, reason, ...(serviceOrderId ? [serviceOrderId] : []), operatorId, sourceMessageId,
  );
}

// Fluxo de material novo: sequência matNome → matUnidade → matSaldo → matMinimo
// → confirmação. Cada passo é um AWAITING_FIELD com payload acumulando.
async function handleMaterialCreationStep(
  tx: Tx, message: MessageRow, payload: ConversationPayload, body: string, replyTo: string,
): Promise<void> {
  const field = message.pending_action;
  if (field === 'matNome') {
    await saveState(tx, message.operator_id, 'matUnidade', { ...payload, matName: clean(body) }, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `Unidade de "${clean(body)}"? (ex.: un, m, kg, l, cx)`, 'mat-unit');
    return;
  }
  if (field === 'matUnidade') {
    const unit = clean(body);
    if (!/^[a-zA-Z]{1,6}$/.test(unit)) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Unidade inválida. Use até 6 letras (ex.: un, m, kg, l, cx).', 'mat-unit-invalid');
      return;
    }
    await saveState(tx, message.operator_id, 'matSaldo', { ...payload, matUnit: unit }, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Saldo inicial? (número, ou 0)', 'mat-saldo');
    return;
  }
  if (field === 'matSaldo') {
    const saldo = parseQuantity(body);
    if (saldo === null) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Quantidade inválida. Use, por exemplo, 2 ou 2,5.', 'mat-saldo-invalid');
      return;
    }
    await saveState(tx, message.operator_id, 'matMinimo', { ...payload, matSaldo: saldo }, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Estoque mínimo? (número, ou - para pular)', 'mat-min');
    return;
  }
  if (field === 'matMinimo') {
    const minimo = body.trim() === '-' ? null : parseQuantity(body);
    if (body.trim() !== '-' && minimo === null) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Quantidade inválida. Use, por exemplo, 2 ou 2,5, ou - para pular.', 'mat-min-invalid');
      return;
    }
    const summary = `Nome: ${payload.matName}\nUnidade: ${payload.matUnit}\nSaldo inicial: ${formatQty(payload.matSaldo ?? '0')} ${payload.matUnit}\nMínimo: ${minimo === null ? '—' : `${formatQty(minimo)} ${payload.matUnit}`}\nConfirma? Responda sim ou cancelar.`;
    await saveState(tx, message.operator_id, 'MATERIAL_CONFIRM', { ...payload, matMinimo: minimo ?? undefined }, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, summary, 'mat-confirm');
    return;
  }
}

async function confirmMaterialCreation(tx: Tx, message: MessageRow, payload: ConversationPayload, replyTo: string): Promise<void> {
  const name = payload.matName;
  const unit = payload.matUnit;
  if (!name || !unit) throw new Error('MATERIAL_FIELDS_MISSING');
  const saldo = payload.matSaldo ?? '0';
  const items = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO inventory_items(name, normalized_name, unit, quantity, min_quantity)
     VALUES($1, $2, $3, $4::numeric, ${payload.matMinimo ? '$5::numeric' : 'NULL'})
     RETURNING id`,
    name, normalize(name), unit, saldo, ...(payload.matMinimo ? [payload.matMinimo] : []),
  );
  const item = items[0];
  if (!item) throw new Error('MATERIAL_NOT_CREATED');
  await audit(tx, message.operator_id, message.id, 'material', item.id, 'CREATE', null, null);
  if (saldo !== '0') {
    await insertMovement(tx, item.id, 'IN', saldo, message.operator_id, message.id, 'Saldo inicial', null);
  }
  await saveState(tx, message.operator_id, null, null, null, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo,
    `Material ${name} cadastrado (${formatQty(saldo)} ${unit}${payload.matMinimo ? `, mínimo ${formatQty(payload.matMinimo)}` : ''}).`, 'mat-created');
}

// Fila de materiais da OS: resolve cada pendente (catalogado, pendente de
// cadastro ou ambíguo) e insere os itens quando a fila termina.
async function processMaterialsQueue(
  tx: Tx, message: MessageRow, payload: ConversationPayload, replyTo: string, discardNotice = '',
): Promise<void> {
  const orderId = message.service_order_id;
  if (!orderId) throw new Error('ORDER_ID_MISSING');
  let draft = payload.materialsDraft ?? [];
  const pending = [...(payload.materialsPending ?? [])];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const matches = await searchMaterials(tx, current.rawName);
    if (matches.length === 1) {
      draft = [...draft, { rawName: current.rawName, quantity: current.quantity, inventoryItemId: matches[0]!.id }];
      continue;
    }
    if (matches.length === 0) {
      draft = [...draft, { rawName: current.rawName, quantity: current.quantity }];
      continue;
    }
    const choices = matches.map((material, index) => `${index + 1}. ${material.name} (${formatQty(material.quantity)} ${material.unit})`).join('\n');
    await saveState(tx, message.operator_id, 'AWAITING_DISAMBIGUATION', {
      ...payload, purpose: 'MATERIAL', materialsDraft: draft,
      materialsPending: pending, candidates: matches.map((material) => ({ id: material.id, name: material.name })),
      name: current.rawName,
    }, orderId, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `${discardNotice}Materiais: encontrei mais de um para "${current.rawName}":\n${choices}\nResponda com o número.`, 'mat-many');
    return;
  }
  await insertOrderItems(tx, orderId, draft);
  await saveState(tx, message.operator_id, 'CONFIRM', { description: payload.description, ...payload, materialsDraft: draft, materialsPending: [] }, orderId, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo, `${discardNotice}${await orderSummary(tx, orderId)}`, 'materials-done');
}

async function handleMaterialsStep(
  tx: Tx, message: MessageRow, payload: ConversationPayload, body: string, replyTo: string,
): Promise<void> {
  if (isNo(body)) {
    const orderId = message.service_order_id;
    if (!orderId) throw new Error('ORDER_ID_MISSING');
    await saveState(tx, message.operator_id, 'CONFIRM', { description: payload.description, ...payload, materialsDraft: [], materialsPending: [] }, orderId, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, await orderSummary(tx, orderId), 'materials-none');
    return;
  }
  const parseItem = (segment: string): { quantity: string; rawName: string } | null => {
    const match = segment.trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    const quantity = match ? parseQuantity(match[1]!) : null;
    if (!match || quantity === null || match[2]!.trim().length === 0) return null;
    return { quantity, rawName: match[2]!.trim() };
  };
  // Lista separada por vírgula; vírgula DECIMAL entre número e material é
  // rejoinada ('2,5 cabo' → um item). Decimais com ponto também funcionam.
  const merged: string[] = [];
  for (const rawSegment of body.split(',')) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    if (/^\d+(?:\.\d{1,3})?$/.test(segment) && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]},${segment}`;
      continue;
    }
    merged.push(segment);
  }
  const parsed: Array<{ quantity: string; rawName: string }> = [];
  for (const segment of merged) {
    const item = parseItem(segment);
    if (item === null) {
      await queueReply(tx, message.operator_id, message.id, replyTo,
        'Não entendi a lista. Use "quantidade nome" por item, separado por vírgula. Ex.: 2.5 cabo, 3 disjuntor.', 'materials-invalid');
      return;
    }
    parsed.push(item);
  }
  await processMaterialsQueue(tx, message, { ...payload, materialsDraft: [], materialsPending: parsed }, replyTo);
}

// ===== Comandos de estoque sem pendência =====
async function handleStockCommand(
  tx: Tx, message: MessageRow, body: string, replyTo: string,
  restore?: { payload: ConversationPayload; orderId: string },
): Promise<void> {
  const operatorId = message.operator_id;
  const sourceMessageId = message.id;
  const entrada = body.match(/^entrada\s+(\S+)\s+(.+)$/i);
  if (entrada) {
    const quantity = parseQuantity(entrada[1]!);
    const term = clean(entrada[2]!);
    if (quantity === null) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Quantidade inválida. Use, por exemplo, 2 ou 2,5.', 'qty-invalid');
      return;
    }
    const matches = await searchMaterials(tx, term);
    if (matches.length === 0) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Não encontrei material "${term}". Cadastre com 'material novo'.`, 'stock-missing');
      return;
    }
    if (matches.length > 1) {
      const choices = matches.map((material, index) => `${index + 1}. ${material.name} (${formatQty(material.quantity)} ${material.unit})`).join('\n');
      await saveState(tx, operatorId, 'AWAITING_DISAMBIGUATION', {
        purpose: 'MATERIAL', candidates: matches.map((material) => ({ id: material.id, name: material.name })), ...(restore ? { restoreConfirm: restore } : {}),
        name: term, entryQuantity: quantity,
      }, null, replyTo);
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Encontrei mais de um material para "${term}":\n${choices}\nResponda com o número.`, 'mat-many');
      return;
    }
    const material = matches[0]!;
    await saveState(tx, operatorId, 'MATERIAL_CONFIRM', { purpose: 'MATERIAL', entryQuantity: quantity, name: term, matName: material.name, matUnit: material.unit, ...(restore ? { restoreConfirm: restore } : {}) }, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Entrada de ${formatQty(quantity)} ${material.unit} de ${material.name}? Responda sim ou cancelar.`, 'entry-confirm');
    return;
  }
  const ajustar = body.match(/^ajustar\s+(.+?)\s+para\s+(\S+)$/i);
  if (ajustar) {
    const term = clean(ajustar[1]!);
    const quantity = parseQuantity(ajustar[2]!);
    if (quantity === null) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Quantidade inválida. Use, por exemplo, 2 ou 2,5.', 'qty-invalid');
      return;
    }
    const matches = await searchMaterials(tx, term);
    if (matches.length === 0) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Não encontrei material "${term}". Cadastre com 'material novo'.`, 'stock-missing');
      return;
    }
    if (matches.length > 1) {
      const choices = matches.map((material, index) => `${index + 1}. ${material.name} (${formatQty(material.quantity)} ${material.unit})`).join('\n');
      await saveState(tx, operatorId, 'AWAITING_DISAMBIGUATION', {
        purpose: 'MATERIAL', candidates: matches.map((material) => ({ id: material.id, name: material.name })), ...(restore ? { restoreConfirm: restore } : {}),
        name: term, adjustQuantity: quantity,
      }, null, replyTo);
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Encontrei mais de um material para "${term}":\n${choices}\nResponda com o número.`, 'mat-many');
      return;
    }
    const material = matches[0]!;
    await saveState(tx, operatorId, 'MATERIAL_CONFIRM', { purpose: 'MATERIAL', adjustQuantity: quantity, name: term, matName: material.name, matUnit: material.unit, ...(restore ? { restoreConfirm: restore } : {}) }, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Ajustar ${material.name} de ${formatQty(material.quantity)} ${material.unit} para ${formatQty(quantity)} ${material.unit}? Responda sim ou cancelar.`, 'adjust-confirm');
    return;
  }
  const devolver = body.match(/^devolver\s+(\S+)\s+(.+?)\s+OS\s+(\d+)$/i);
  if (devolver) {
    const quantity = parseQuantity(devolver[1]!);
    const term = clean(devolver[2]!);
    const osNumber = Number(devolver[3]);
    if (quantity === null) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Quantidade inválida. Use, por exemplo, 2 ou 2,5.', 'qty-invalid');
      return;
    }
    const orders = await tx.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM service_orders WHERE number=$1', osNumber,
    );
    if (!orders[0]) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'OS não encontrada.', 'dev-os-missing');
      return;
    }
    const matches = await searchMaterials(tx, term);
    if (matches.length === 0) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Não encontrei material "${term}". Cadastre com 'material novo'.`, 'stock-missing');
      return;
    }
    if (matches.length > 1) {
      const choices = matches.map((material, index) => `${index + 1}. ${material.name} (${formatQty(material.quantity)} ${material.unit})`).join('\n');
      await saveState(tx, operatorId, 'AWAITING_DISAMBIGUATION', {
        purpose: 'MATERIAL', candidates: matches.map((material) => ({ id: material.id, name: material.name })), ...(restore ? { restoreConfirm: restore } : {}),
        name: term, returnQuantity: quantity, returnOsNumber: osNumber,
      }, null, replyTo);
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Encontrei mais de um material para "${term}":\n${choices}\nResponda com o número.`, 'mat-many');
      return;
    }
    const material = matches[0]!;
    await saveState(tx, operatorId, 'MATERIAL_CONFIRM', {
      purpose: 'MATERIAL', returnQuantity: quantity, returnOsNumber: osNumber, ...(restore ? { restoreConfirm: restore } : {}),
      name: term, matName: material.name, matUnit: material.unit,
    }, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Devolução de ${formatQty(quantity)} ${material.unit} de ${material.name} (OS ${String(osNumber).padStart(6, '0')})? Responda sim ou cancelar.`, 'return-confirm');
    return;
  }
  const saldo = body.match(/^saldo\s+(.+)$/i);
  if (saldo) {
    const matches = await searchMaterials(tx, clean(saldo[1]!));
    if (matches.length === 0) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, `Não encontrei material com esse nome: ${clean(saldo[1]!)}.`, 'saldo-missing');
      return;
    }
    const lines = matches.map((material) =>
      `${material.name}: ${formatQty(material.quantity)} ${material.unit}${material.min_quantity ? ` (mínimo ${formatQty(material.min_quantity)} ${material.unit})` : ''}`);
    await queueReply(tx, operatorId, sourceMessageId, replyTo, lines.join('\n'), 'saldo');
    return;
  }
  if (/^estoque$/i.test(body)) {
    const materials = await tx.$queryRawUnsafe<MaterialRow[]>(
      'SELECT name, unit, quantity::text AS quantity FROM inventory_items WHERE active ORDER BY name LIMIT 20',
    );
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      materials.length > 0
        ? `Estoque:\n${materials.map((material) => `${material.name} — ${formatQty(material.quantity)} ${material.unit}`).join('\n')}`
        : 'Estoque vazio.', 'stock-list');
    return;
  }
  await queueReply(tx, operatorId, sourceMessageId, replyTo,
    "Comandos de estoque: 'material novo', 'entrada 10 cabo', 'ajustar cabo para 20', 'devolver 2 cabo OS 5', 'saldo cabo', 'estoque'.", 'stock-help');
}

// ===== Confirm de material (entrada/ajuste/devolução) e steps guiados =====

// ===== Execução de entrada/ajuste/devolução após confirmação =====
async function confirmMaterialOperation(
  tx: Tx, message: MessageRow, payload: ConversationPayload, replyTo: string, chosenItemId?: string,
): Promise<void> {
  const operatorId = message.operator_id;
  const sourceMessageId = message.id;
  const restore = payload.restoreConfirm;
  let itemId = chosenItemId;
  let material: MaterialRow | undefined;
  if (itemId) {
    const rows = await tx.$queryRawUnsafe<MaterialRow[]>(
      'SELECT id, name, unit, quantity::text AS quantity, min_quantity::text AS min_quantity FROM inventory_items WHERE id=$1::uuid',
      itemId,
    );
    material = rows[0];
  }
  let replyBody: string;
  let suffix: string;
  if (payload.entryQuantity !== undefined) {
    if (!itemId) {
      const rows = await searchMaterials(tx, payload.matName ?? payload.name ?? '');
      itemId = rows[0]?.id;
      material = rows[0];
    }
    if (!itemId || !material) throw new Error('MATERIAL_NOT_FOUND');
    await tx.$queryRawUnsafe('UPDATE inventory_items SET quantity=quantity+$2::numeric WHERE id=$1::uuid', itemId, payload.entryQuantity);
    await insertMovement(tx, itemId, 'IN', payload.entryQuantity, operatorId, sourceMessageId, 'Entrada manual', null);
    const after = await tx.$queryRawUnsafe<MaterialRow[]>('SELECT quantity::text AS quantity FROM inventory_items WHERE id=$1::uuid', itemId);
    suffix = 'entry-done';
    replyBody = `Entrada registrada: ${material.name} +${formatQty(payload.entryQuantity)} ${material.unit}. Saldo: ${formatQty(after[0]?.quantity ?? null)} ${material.unit}.`;
  } else if (payload.adjustQuantity !== undefined) {
    if (!itemId) {
      const rows = await searchMaterials(tx, payload.matName ?? payload.name ?? '');
      itemId = rows[0]?.id;
      material = rows[0];
    }
    if (!itemId || !material) throw new Error('MATERIAL_NOT_FOUND');
    if (formatQty(material.quantity) === formatQty(payload.adjustQuantity)) {
      replyBody = `Saldo de ${material.name} já é ${formatQty(material.quantity)} ${material.unit}. Nada a ajustar.`;
      suffix = 'adjust-noop';
    } else {
      // RETURNING de UPDATE enxerga o valor NOVO: capturar o antigo via CTE
      // para o delta sair com sinal e magnitude corretos.
      const delta = await tx.$queryRawUnsafe<{ delta: string }[]>(
        `WITH old AS (SELECT quantity FROM inventory_items WHERE id=$1::uuid FOR UPDATE)
         UPDATE inventory_items SET quantity=$2::numeric
          FROM old WHERE inventory_items.id=$1::uuid
         RETURNING (inventory_items.quantity - old.quantity)::text AS delta`,
        itemId, payload.adjustQuantity,
      );
      const deltaAbs = delta[0]!.delta.replace('-', '');
      const sign = delta[0]!.delta.startsWith('-') ? '-' : '+';
      await insertMovement(tx, itemId, 'ADJUST', deltaAbs, operatorId, sourceMessageId, `Ajuste para ${formatQty(payload.adjustQuantity)} ${material.unit}`, null);
      suffix = 'adjust-done';
      replyBody = `Ajuste registrado: ${material.name} agora com ${formatQty(payload.adjustQuantity)} ${material.unit} (${sign}${formatQty(deltaAbs)}).`;
    }
  } else if (payload.returnQuantity !== undefined && payload.returnOsNumber !== undefined) {
    if (!itemId) {
      const rows = await searchMaterials(tx, payload.matName ?? payload.name ?? '');
      itemId = rows[0]?.id;
      material = rows[0];
    }
    if (!itemId || !material) throw new Error('MATERIAL_NOT_FOUND');
    const orders = await tx.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM service_orders WHERE number=$1', payload.returnOsNumber,
    );
    const orderId = orders[0]?.id ?? null;
    await tx.$queryRawUnsafe('UPDATE inventory_items SET quantity=quantity+$2::numeric WHERE id=$1::uuid', itemId, payload.returnQuantity);
    await insertMovement(tx, itemId, 'RETURN', payload.returnQuantity, operatorId, sourceMessageId, `Devolução OS ${payload.returnOsNumber}`, orderId);
    const after = await tx.$queryRawUnsafe<MaterialRow[]>('SELECT quantity::text AS quantity FROM inventory_items WHERE id=$1::uuid', itemId);
    suffix = 'return-done';
    replyBody = `Devolução registrada: ${material.name} +${formatQty(payload.returnQuantity)} ${material.unit}. Saldo: ${formatQty(after[0]?.quantity ?? null)} ${material.unit}.`;
  } else {
    throw new Error('MATERIAL_OPERATION_UNKNOWN');
  }
  if (restore) {
    // Executado durante a confirmação de uma OS: restaura o estado CONFIRM e
    // reapresenta o resumo para o operador confirmar com o próximo 'sim'.
    await saveState(tx, operatorId, 'CONFIRM', restore.payload, restore.orderId, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo, `${replyBody}\n${await orderSummary(tx, restore.orderId)}`, suffix);
    return;
  }
  await saveState(tx, operatorId, null, null, null, replyTo);
  await queueReply(tx, operatorId, sourceMessageId, replyTo, replyBody, suffix);
}

// ===== Emissão fiscal (Fase 7) =====
//
// A conversa fala exclusivamente com InvoiceProvider. O adapter manual
// transforma a solicitação em NEEDS_REVIEW para emissão humana; adapters de
// Portal Nacional ou terceiros mantêm a mesma intenção persistida e a mesma
// reconciliação por externalReference.
type InvoiceOrderRow = {
  id: string;
  number: number;
  status: string;
  amount_cents: number | null;
  description: string;
  customer: string;
  cpf_cnpj: string | null;
  email: string | null;
  address_street: string | null;
  address_number: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
  address_zip: string | null;
};

async function findOrderForInvoice(tx: Tx, number: number): Promise<InvoiceOrderRow | undefined> {
  return tx.$queryRawUnsafe<InvoiceOrderRow[]>(
    `SELECT so.id, so.number, so.status, so.amount_cents, so.description, c.name AS customer,
            c.cpf_cnpj, c.email, c.address_street, c.address_number, c.address_district,
            c.address_city, c.address_state, c.address_zip
       FROM service_orders so JOIN customers c ON c.id=so.customer_id
      WHERE so.number=$1`,
    number,
  ).then((rows) => rows[0]);
}

async function executeInvoiceRequest(
  tx: Tx, message: MessageRow, payload: ConversationPayload, replyTo: string, cfg: Config,
): Promise<void> {
  const provider = getInvoiceProvider(cfg);
  const orderId = payload.invoiceOrderId;
  const serviceCode = payload.invoiceServiceCode;
  if (!orderId || !serviceCode) throw new Error('INVOICE_FIELDS_MISSING');
  if (!provider) {
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      "Emissão fiscal automática não configurada (INVOICE_PROVIDER=none).", 'invoice-none');
    return;
  }
  const order = await tx.$queryRawUnsafe<InvoiceOrderRow[]>(
    `SELECT so.id, so.number, so.status, so.amount_cents, so.description, c.name AS customer,
            c.cpf_cnpj, c.email, c.address_street, c.address_number, c.address_district,
            c.address_city, c.address_state, c.address_zip
       FROM service_orders so JOIN customers c ON c.id=so.customer_id
      WHERE so.id=$1::uuid`,
    orderId,
  ).then((rows) => rows[0]);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'CONFIRMADA' || !order.amount_cents || order.amount_cents <= 0) {
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `A ${osLabel(order.number)} não está mais apta para emissão fiscal (status: ${order.status}, valor: ${formatMoney(order.amount_cents)}).`, 'invoice-stale');
    return;
  }
  if (!order.cpf_cnpj) {
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `A emissão exige CPF/CNPJ do tomador. Informe com: cpf ${order.customer} <número>.`, 'invoice-fiscal-id');
    return;
  }
  const existing = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    `SELECT status FROM invoices
      WHERE service_order_id=$1::uuid AND provider=$2 AND status NOT IN ('CANCELED','REJECTED')
      ORDER BY created_at DESC LIMIT 1`,
    order.id, provider.name,
  );
  if (existing[0]) {
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `Já há solicitação fiscal da ${osLabel(order.number)} no estado ${existing[0].status}.`, 'invoice-already-requested');
    return;
  }
  const sequence = await tx.$queryRawUnsafe<Array<{ seq: number }>>(
    'SELECT count(*)::int + 1 AS seq FROM invoices WHERE service_order_id=$1::uuid',
    order.id,
  );
  const externalReference = `OS-${order.number}-NF${sequence[0]?.seq ?? 1}`;
  const input = {
    serviceOrderNumber: order.number,
    externalReference,
    customer: {
      name: order.customer,
      cpfCnpj: order.cpf_cnpj,
      email: order.email,
      address: {
        street: order.address_street, number: order.address_number, district: order.address_district,
        city: order.address_city, state: order.address_state, zip: order.address_zip,
      },
    },
    serviceCode,
    valueCents: order.amount_cents,
    description: order.description,
  };
  const created = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO invoices(service_order_id, provider, status, payload)
     VALUES($1::uuid, $2, 'READY_FOR_APPROVAL', $3::jsonb) RETURNING id`,
    order.id, provider.name, JSON.stringify(input),
  );
  const invoiceId = created[0]?.id;
  if (!invoiceId) throw new Error('INVOICE_NOT_CREATED');
  let result: InvoiceRequestResult | null | undefined;
  let failure = '';
  try {
    result = await provider.request(input);
  } catch (error) {
    failure = error instanceof Error ? error.message : 'erro desconhecido';
    result = await provider.findByExternalReference(externalReference);
  }
  if (!result) {
    await tx.$executeRawUnsafe(
      "UPDATE invoices SET status='NEEDS_REVIEW', last_error=$2, updated_at=now() WHERE id=$1::uuid",
      invoiceId, `reconciliação pendente: ${failure || 'sem confirmação do emissor'}`,
    );
    await audit(tx, message.operator_id, message.id, 'invoice', invoiceId, 'REQUEST_INVOICE_REVIEW', 'READY_FOR_APPROVAL', 'NEEDS_REVIEW', externalReference);
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `A solicitação fiscal da ${osLabel(order.number)} ficou em revisão; não reenvie antes de conferir o emissor.`, 'invoice-needs-review');
    return;
  }
  await tx.$executeRawUnsafe(
    'UPDATE invoices SET provider_invoice_id=$2, status=$3, updated_at=now() WHERE id=$1::uuid',
    invoiceId, result.providerInvoiceId, result.status,
  );
  await audit(tx, message.operator_id, message.id, 'invoice', invoiceId, 'REQUEST_INVOICE', 'READY_FOR_APPROVAL', result.status, externalReference);
  await saveState(tx, message.operator_id, null, null, null, replyTo);
  const text = result.status === 'NEEDS_REVIEW'
    ? `Solicitação fiscal da ${osLabel(order.number)} registrada para emissão humana (referência ${externalReference}).`
    : `Solicitação fiscal da ${osLabel(order.number)} enviada ao emissor (status: ${result.status}).`;
  await queueReply(tx, message.operator_id, message.id, replyTo, text, 'invoice-requested');
}

async function handleInvoiceCommand(
  tx: Tx, message: MessageRow, body: string, replyTo: string, cfg: Config,
): Promise<void> {
  const settle = /^nota\s+emitida\s+OS\s+(\d+)\s+(\d{1,32})$/i.exec(body);
  if (settle) {
    await settleInvoiceAuthorized(tx, message, replyTo, Number(settle[1]), settle[2]!);
    return;
  }
  const drop = /^cancelar\s+nota\s+OS\s+(\d+)$/i.exec(body);
  if (drop) {
    await cancelInvoiceRequest(tx, message, replyTo, cfg, Number(drop[1]));
    return;
  }
  if (/^nota emitida\b/i.test(body)) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      'Use: nota emitida OS <número> <número da NFS-e>. Ex.: nota emitida OS 3 1024.', 'invoice-settle-usage');
    return;
  }
  if (/^cancelar nota\b/i.test(body)) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      'Use: cancelar nota OS <número>. Ex.: cancelar nota OS 3.', 'invoice-cancel-usage');
    return;
  }
  if (/^notas$/i.test(body)) {
    const rows = await tx.$queryRawUnsafe<Array<{ number: number; customer: string; status: string; provider: string }>>(
      `SELECT so.number, c.name AS customer, i.status, i.provider
         FROM invoices i JOIN service_orders so ON so.id=i.service_order_id
         JOIN customers c ON c.id=so.customer_id
        WHERE i.status NOT IN ('AUTHORIZED','CANCELED')
        ORDER BY i.created_at DESC LIMIT 10`,
    );
    await queueReply(tx, message.operator_id, message.id, replyTo,
      rows.length === 0 ? 'Nenhuma solicitação fiscal pendente.'
        : `Solicitações fiscais:\n${rows.map((row) => `${osLabel(row.number)} · ${row.customer} · ${row.status} · ${row.provider}`).join('\n')}`,
      rows.length === 0 ? 'invoices-none' : 'invoices-list');
    return;
  }
  const issue = /^emitir\s+(?:NF|NFS-?e)\s+OS\s+(\d+)\s+([A-Za-z0-9.-]{1,64})$/i.exec(body);
  if (!issue) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      'Use: emitir NF OS <número> <código-do-serviço>. Ex.: emitir NF OS 3 1.02.', 'invoice-usage');
    return;
  }
  if (!getInvoiceProvider(cfg)) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      "Emissão fiscal automática não configurada (INVOICE_PROVIDER=none).", 'invoice-none');
    return;
  }
  const order = await findOrderForInvoice(tx, Number(issue[1]));
  if (!order) {
    await queueReply(tx, message.operator_id, message.id, replyTo, 'OS não encontrada.', 'invoice-os-missing');
    return;
  }
  if (order.status !== 'CONFIRMADA' || !order.amount_cents || order.amount_cents <= 0) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `A ${osLabel(order.number)} não está confirmada ou não tem valor para emissão fiscal.`, 'invoice-os-invalid');
    return;
  }
  await saveState(tx, message.operator_id, 'INVOICE_CONFIRM', {
    invoiceOrderId: order.id, invoiceOsNumber: order.number, invoiceServiceCode: issue[2]!,
  }, null, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo,
    `Solicitar emissão fiscal da ${osLabel(order.number)} para ${order.customer}, ${formatMoney(order.amount_cents)}, código ${issue[2]}? Responda sim ou cancelar.`,
    'invoice-confirm');
}

// `nota emitida OS <n> <número>`: o operador registrou a NFS-e no Portal
// Nacional (adapter manual) ou ela foi autorizada no emissor — fecha a
// solicitação ativa como AUTHORIZED guardando o número da nota.
async function settleInvoiceAuthorized(
  tx: Tx, message: MessageRow, replyTo: string, osNumber: number, nfsNumber: string,
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; status: string; number: number }>>(
    `SELECT i.id, i.status, so.number
       FROM invoices i JOIN service_orders so ON so.id=i.service_order_id
      WHERE so.number=$1 AND i.status NOT IN ('AUTHORIZED','CANCELED')
      ORDER BY i.created_at DESC LIMIT 1`,
    osNumber,
  );
  const invoice = rows[0];
  if (!invoice) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `Não há solicitação fiscal ativa para a ${osLabel(osNumber)}.`, 'invoice-settle-none');
    return;
  }
  const changed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE invoices
        SET status='AUTHORIZED', updated_at=now(),
            payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{nfsNumber}', to_jsonb($2::text))
      WHERE id=$1::uuid AND status NOT IN ('AUTHORIZED','CANCELED') RETURNING id`,
    invoice.id, nfsNumber,
  );
  if (!changed[0]) throw new Error('INVOICE_SETTLE_STATE_CHANGED');
  await audit(tx, message.operator_id, message.id, 'invoice', invoice.id, 'INVOICE_AUTHORIZED', invoice.status, 'AUTHORIZED', nfsNumber);
  await queueReply(tx, message.operator_id, message.id, replyTo,
    `Nota da ${osLabel(invoice.number)} registrada como emitida (nº ${nfsNumber}).`, 'invoice-settled');
}

// `cancelar nota OS <n>`: desiste da solicitação ativa (cancela no emissor
// quando há id externo e o adapter configurado é o mesmo).
async function cancelInvoiceRequest(
  tx: Tx, message: MessageRow, replyTo: string, cfg: Config, osNumber: number,
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; status: string; number: number; provider: string; provider_invoice_id: string | null }>>(
    `SELECT i.id, i.status, i.provider, i.provider_invoice_id, so.number
       FROM invoices i JOIN service_orders so ON so.id=i.service_order_id
      WHERE so.number=$1 AND i.status NOT IN ('AUTHORIZED','CANCELED')
      ORDER BY i.created_at DESC LIMIT 1`,
    osNumber,
  );
  const invoice = rows[0];
  if (!invoice) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `Não há solicitação fiscal ativa para a ${osLabel(osNumber)}.`, 'invoice-cancel-none');
    return;
  }
  const provider = getInvoiceProvider(cfg);
  if (invoice.provider_invoice_id && provider && provider.name === invoice.provider) {
    await provider.cancel(invoice.provider_invoice_id);
  }
  const changed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE invoices SET status='CANCELED', updated_at=now()
      WHERE id=$1::uuid AND status NOT IN ('AUTHORIZED','CANCELED') RETURNING id`,
    invoice.id,
  );
  if (!changed[0]) throw new Error('INVOICE_CANCEL_STATE_CHANGED');
  await audit(tx, message.operator_id, message.id, 'invoice', invoice.id, 'INVOICE_CANCELED', invoice.status, 'CANCELED', 'operador');
  await queueReply(tx, message.operator_id, message.id, replyTo,
    `Solicitação fiscal da ${osLabel(invoice.number)} cancelada.`, 'invoice-canceled');
}

// ===== Cobrança (Fase 6) =====
//
// Gramática determinística (o domínio fala SÓ com a porta BillingProvider +
// registry — nunca com um provedor direto, nunca com status cru):
//   cobrar OS <n> [pix|boleto] [vencimento DD/MM/AAAA | +Nd]
//     Validações em ordem: OS existe e está CONFIRMADA; amount_cents > 0;
//     sem cobrança PENDING/OVERDUE ativa para a mesma OS. Incompleto →
//     pergunta guiada (método → vencimento; default de vencimento = due_date
//     da OS, senão hoje) → resumo → pending CHARGE_CONFIRM → 'sim': INSERT
//     DRAFT + external_reference OS-<n>-C<seq> ANTES de chamar o provedor →
//     ensureCustomer (persistindo customer_provider_refs) → createCharge →
//     falha (timeout/5xx): reconciliar via findByExternalReference antes de
//     qualquer retry — achou, adota; senão status ERROR + mensagem
//     determinística. Sucesso → PENDING + provider_charge_id; PIX busca
//     getPixData e responde com o copia-e-cola.
//   cobranças — lista PENDING/OVERDUE.
//   vencidas — só OVERDUE + total.
//   recebi OS <n> <valor> [pix|dinheiro] — confirmação → se há cobrança
//     PENDING/OVERDUE da OS: transaciona para RECEIVED + paid_value_cents
//     (webhook posterior do provedor vira no-op: RECEIVED nunca é rebaixado);
//     senão INSERT charge via provider 'manual' (CASH/EXTERNAL_PIX) RECEIVED.
//   cancelar cobrança OS <n> — exige PENDING/OVERDUE; confirmação →
//     provider.cancelCharge → status CANCELED.
// BILLING_PROVIDER=none → 'cobrar' responde determinístico; 'recebi' segue
// funcionando (provider manual).

type ChargeOrderRow = {
  id: string;
  number: number;
  status: string;
  amount_cents: number | null;
  due_date: Date | string | null;
  customer_id: string;
  customer: string;
  customer_cpf_cnpj: string | null;
  description: string;
};
type ChargeRow = {
  id: string;
  service_order_id: string;
  provider: string;
  provider_charge_id: string | null;
  method: string;
  value_cents: number;
  due_date: Date | string | null;
  status: string;
};

// Dia de calendário em America/Sao_Paulo (vencimentos são datas, não instantes).
const todaySp = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

function dueIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

const formatDue = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

// DD/MM/AAAA ou +Nd (relativo ao dia de hoje em America/Sao_Paulo) → YYYY-MM-DD.
function parseDueInput(input: string): string | null {
  const absolute = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input.trim());
  if (absolute) {
    const iso = `${absolute[3]}-${absolute[2]}-${absolute[1]}`;
    const date = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
  }
  const relative = /^\+(\d{1,3})d$/i.exec(input.trim());
  if (relative) {
    const base = new Date(`${todaySp()}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + Number(relative[1]));
    return base.toISOString().slice(0, 10);
  }
  return null;
}

async function findOrderForCharge(tx: Tx, osNumber: number): Promise<ChargeOrderRow | undefined> {
  const orders = await tx.$queryRawUnsafe<ChargeOrderRow[]>(
    `SELECT so.id, so.number, so.status, so.amount_cents, so.due_date, so.customer_id, so.description, c.name AS customer, c.cpf_cnpj AS customer_cpf_cnpj
       FROM service_orders AS so JOIN customers AS c ON c.id=so.customer_id
      WHERE so.number=$1`,
    osNumber,
  );
  return orders[0];
}

async function findActiveCharge(tx: Tx, orderId: string): Promise<ChargeRow | undefined> {
  const rows = await tx.$queryRawUnsafe<ChargeRow[]>(
    `SELECT id, service_order_id, provider, provider_charge_id, method, value_cents, due_date, status
       FROM charges WHERE service_order_id=$1::uuid AND status IN ('PENDING','OVERDUE')
      ORDER BY created_at LIMIT 1`,
    orderId,
  );
  return rows[0];
}

// Validações do 'cobrar' em ordem; retorna a linha da OS apta ou null (já respondendo).
async function validateChargeTarget(
  tx: Tx, operatorId: string, sourceMessageId: string, replyTo: string, osNumber: number,
): Promise<ChargeOrderRow | null> {
  const order = await findOrderForCharge(tx, osNumber);
  if (!order) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo, 'OS não encontrada.', 'charge-os-missing');
    return null;
  }
  if (order.status !== 'CONFIRMADA') {
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `A ${osLabel(order.number)} não está confirmada (status: ${order.status}). Só é possível cobrar OS confirmada.`, 'charge-os-not-confirmed');
    return null;
  }
  if (order.amount_cents === null || order.amount_cents <= 0) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `A ${osLabel(order.number)} não tem valor definido; não é possível cobrar.`, 'charge-os-no-value');
    return null;
  }
  const active = await findActiveCharge(tx, order.id);
  if (active) {
    const due = dueIso(active.due_date);
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Já há cobrança ativa para a ${osLabel(order.number)}: ${active.method} ${formatMoney(active.value_cents)}${due ? ` vence ${formatDue(due)}` : ''} (${active.status}). Use 'cancelar cobrança OS ${order.number}' antes de criar outra.`,
      'charge-already-active');
    return null;
  }
  return order;
}

function chargeSummary(payload: ConversationPayload): string {
  const method = payload.chargeMethod === 'PIX' ? 'Pix' : 'Boleto';
  return `Cobrança ${method} de ${formatMoney(payload.chargeValueCents ?? null)} para ${payload.chargeCustomerName} (${osLabel(payload.chargeOsNumber ?? 0)}), vencimento ${formatDue(payload.chargeDueDate ?? todaySp())}. Confirma? Responda sim ou cancelar.`;
}

// Execução do 'sim' em CHARGE_CONFIRM: DRAFT primeiro, provedor depois,
// reconciliação por external_reference em caso de falha (nunca duplicar).
async function executeChargeCreation(
  tx: Tx, message: MessageRow, payload: ConversationPayload, replyTo: string, cfg: Config,
): Promise<void> {
  const operatorId = message.operator_id;
  const provider = getBillingProvider(cfg);
  if (!provider) {
    await saveState(tx, operatorId, null, null, null, replyTo);
    await queueReply(tx, operatorId, message.id, replyTo,
      "Cobrança automática não configurada (BILLING_PROVIDER=none). Use 'recebi OS <n> <valor>' para registrar pagamento externo.", 'charge-none');
    return;
  }
  const orderId = payload.chargeOsId;
  const method = payload.chargeMethod;
  const dueDate = payload.chargeDueDate;
  if (!orderId || !method || !dueDate) throw new Error('CHARGE_FIELDS_MISSING');
  // Revalidação no 'sim': a OS pode ter mudado durante a conversa guiada.
  const order = await tx.$queryRawUnsafe<ChargeOrderRow[]>(
    `SELECT so.id, so.number, so.status, so.amount_cents, so.due_date, so.customer_id, so.description, c.name AS customer, c.cpf_cnpj AS customer_cpf_cnpj
       FROM service_orders AS so JOIN customers AS c ON c.id=so.customer_id WHERE so.id=$1::uuid`,
    orderId,
  ).then((rows) => rows[0]);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'CONFIRMADA' || order.amount_cents === null || order.amount_cents <= 0) {
    await saveState(tx, operatorId, null, null, null, replyTo);
    await queueReply(tx, operatorId, message.id, replyTo,
      `A ${osLabel(order.number)} não está mais apta para cobrança (status: ${order.status}, valor: ${formatMoney(order.amount_cents)}).`, 'charge-stale');
    return;
  }
  const active = await findActiveCharge(tx, order.id);
  if (active) {
    await saveState(tx, operatorId, null, null, null, replyTo);
    await queueReply(tx, operatorId, message.id, replyTo,
      `Já há cobrança ativa para a ${osLabel(order.number)} (${active.method} ${formatMoney(active.value_cents)}, ${active.status}). Nada foi criado.`, 'charge-already-active');
    return;
  }
  const seqRows = await tx.$queryRawUnsafe<Array<{ seq: number }>>(
    'SELECT count(*)::int + 1 AS seq FROM charges WHERE service_order_id=$1::uuid', order.id,
  );
  const externalReference = `OS-${order.number}-C${seqRows[0]?.seq ?? 1}`;
  // Intenção ANTES da chamada: a linha DRAFT com external_reference é a âncora
  // de reconciliação se a resposta do provedor se perder.
  const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO charges(service_order_id, customer_id, provider, method, value_cents, due_date, status, external_reference)
     VALUES($1::uuid, $2::uuid, $3, $4, $5, $6::date, 'DRAFT', $7) RETURNING id`,
    order.id, order.customer_id, provider.name, method, order.amount_cents, dueDate, externalReference,
  );
  const chargeId = inserted[0]?.id;
  if (!chargeId) throw new Error('CHARGE_NOT_CREATED');

  let created: CreatedCharge | null = null;
  let failureName = 'erro';
  let fiscalIdMissing = false;
  try {
    const refs = await tx.$queryRawUnsafe<Array<{ external_id: string }>>(
      'SELECT external_id FROM customer_provider_refs WHERE customer_id=$1::uuid AND provider=$2',
      order.customer_id, provider.name,
    );
    let externalId = refs[0]?.external_id;
    if (!externalId) {
      externalId = await provider.ensureCustomer({ customerId: order.customer_id, name: order.customer });
      await tx.$executeRawUnsafe(
        `INSERT INTO customer_provider_refs(customer_id, provider, external_id)
         VALUES($1::uuid, $2, $3) ON CONFLICT (customer_id, provider) DO NOTHING`,
        order.customer_id, provider.name, externalId,
      );
    }
    // O Asaas rejeita cobrança de cliente sem CPF/CNPJ: sincroniza o
    // documento (idempotente) ANTES de criar a cobrança.
    if (order.customer_cpf_cnpj) {
      await provider.updateCustomer(externalId, {
        customerId: order.customer_id, name: order.customer, cpfCnpj: order.customer_cpf_cnpj,
      });
    }
    created = await provider.createCharge({
      providerCustomerId: externalId,
      method,
      valueCents: order.amount_cents,
      dueDate,
      description: `${osLabel(order.number)} — ${order.description}`,
      externalReference,
    });
  } catch (error) {
    fiscalIdMissing = error instanceof MissingFiscalIdError;
    failureName = fiscalIdMissing ? 'CPF/CNPJ ausente'
      : error instanceof Error && error.name === 'ProviderTimeoutError' ? 'timeout' : 'erro';
  }
  if (!created && fiscalIdMissing) {
    // Rejeição determinística do provedor: nada foi criado lá — reconciliar
    // ou reenviar sem o documento não resolve. Orienta o comando `cpf`.
    await tx.$executeRawUnsafe("UPDATE charges SET status='ERROR', updated_at=now() WHERE id=$1::uuid", chargeId);
    await saveState(tx, operatorId, null, null, null, replyTo);
    await queueReply(tx, operatorId, message.id, replyTo,
      `O provedor exige o CPF/CNPJ do cliente para cobrar. Informe com: cpf ${order.customer} <número> e tente novamente.`,
      'charge-fiscal-id');
    return;
  }
  if (!created) {
    // Timeout/5xx: NUNCA presumir falha — consultar o provedor pela referência
    // antes de qualquer retry para não duplicar a cobrança.
    created = await provider.findByExternalReference(externalReference);
  }
  if (!created) {
    await tx.$executeRawUnsafe("UPDATE charges SET status='ERROR', updated_at=now() WHERE id=$1::uuid", chargeId);
    await saveState(tx, operatorId, null, null, null, replyTo);
    await queueReply(tx, operatorId, message.id, replyTo,
      `Falha ao criar a cobrança no provedor (${failureName}) e a reconciliação por ${externalReference} não encontrou cobrança lá. A intenção foi marcada como ERROR; tente novamente.`,
      'charge-error');
    return;
  }
  await tx.$executeRawUnsafe(
    'UPDATE charges SET provider_charge_id=$2, status=$3, updated_at=now() WHERE id=$1::uuid',
    chargeId, created.providerChargeId, created.status,
  );
  let pixBlock = '';
  if (method === 'PIX') {
    try {
      const pix = await provider.getPixData(created.providerChargeId);
      await tx.$executeRawUnsafe(
        'UPDATE charges SET pix_copy_paste=$2, pix_qr_url=$3 WHERE id=$1::uuid',
        chargeId, pix.copyPaste, pix.qrImageUrl ?? null,
      );
      pixBlock = `\nPix copia-e-cola:\n${pix.copyPaste}`;
    } catch (error) {
      // QR indisponível no momento: a cobrança segue PENDING; dados pix podem
      // ser buscados depois pelo painel do provedor. Nunca silencioso: o
      // operador precisa conseguir diagnosticar pelo log do container.
      console.error(
        `[billing] getPixData falhou para ${created.providerChargeId}:`,
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
    }
  }
  const base = `Cobrança criada: ${osLabel(order.number)} · ${method === 'PIX' ? 'Pix' : 'Boleto'} · ${formatMoney(order.amount_cents)} · vencimento ${formatDue(dueDate)}.`;
  const extra = method === 'PIX'
    ? pixBlock
    : `\nBoleto ${created.providerChargeId}: link disponível no painel Asaas.`;
  const contact = method === 'PIX' && pixBlock
    ? (await tx.$queryRawUnsafe<Array<{ phone: string | null; billing_opt_in: boolean }>>(
      'SELECT phone, billing_opt_in FROM customers WHERE id=$1::uuid', order.customer_id,
    ))[0]
    : undefined;
  if (contact?.phone && contact.billing_opt_in) {
    const to = `${contact.phone}@c.us`;
    const customerBody = `Olá ${order.customer}! Cobrança referente à ${osLabel(order.number)} — ${order.description}: ${formatMoney(order.amount_cents)}, vencimento ${formatDue(dueDate)}.\nPix copia-e-cola:\n${pixBlock.slice('\nPix copia-e-cola:\n'.length)}`;
    await saveState(tx, operatorId, 'CHARGE_SEND_CONFIRM', {
      chargeSendTo: to, chargeSendBody: customerBody, chargeSendId: chargeId,
    }, null, replyTo);
    await queueReply(tx, operatorId, message.id, replyTo,
      `${base}${extra}\nEnviar a cobrança de ${formatMoney(order.amount_cents)} ao cliente ${order.customer} (${formatPhone(contact.phone)})? Responda sim ou não.`,
      'charge-send-ask');
    return;
  }
  await saveState(tx, operatorId, null, null, null, replyTo);
  await queueReply(tx, operatorId, message.id, replyTo, `${base}${extra}`, 'charge-created');
}

// Execução do 'sim' em RECEIPT_CONFIRM: baixa de cobrança ativa OU registro
// manual (CASH/EXTERNAL_PIX) — nunca rebaixa RECEIVED.
async function executeReceipt(
  tx: Tx, message: MessageRow, payload: ConversationPayload, replyTo: string, cfg: Config,
): Promise<void> {
  const operatorId = message.operator_id;
  const orderId = payload.chargeOsId;
  const osNumber = payload.chargeOsNumber;
  const cents = payload.receiptCents;
  const method = payload.receiptMethod;
  if (!orderId || !osNumber || !cents || !method) throw new Error('RECEIPT_FIELDS_MISSING');
  const label = method === 'CASH' ? 'dinheiro' : 'pix';
  const received = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE charges SET status='RECEIVED', paid_value_cents=$2, updated_at=now()
      WHERE service_order_id=$1::uuid AND status IN ('PENDING','OVERDUE') RETURNING id`,
    orderId, cents,
  );
  if (!received[0]) {
    // Sem cobrança ativa: pagamento externo vira charge do provider 'manual'
    // (o domínio fala com a porta; o adapter manual nasce RECEIVED).
    const order = await tx.$queryRawUnsafe<Array<{ customer_id: string }>>(
      'SELECT customer_id FROM service_orders WHERE id=$1::uuid', orderId,
    ).then((rows) => rows[0]);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    const manual = getBillingProvider({ ...cfg, BILLING_PROVIDER: 'manual' });
    if (!manual) throw new Error('MANUAL_PROVIDER_UNAVAILABLE');
    const seqRows = await tx.$queryRawUnsafe<Array<{ seq: number }>>(
      'SELECT count(*)::int + 1 AS seq FROM charges WHERE service_order_id=$1::uuid', orderId,
    );
    const externalReference = `OS-${osNumber}-C${seqRows[0]?.seq ?? 1}`;
    const created = await manual.createCharge({
      providerCustomerId: `manual-${order.customer_id}`,
      method,
      valueCents: cents,
      dueDate: todaySp(),
      description: `${osLabel(osNumber)} — recebimento externo`,
      externalReference,
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO charges(service_order_id, customer_id, provider, provider_charge_id, method, value_cents, status, external_reference, paid_value_cents)
       VALUES($1::uuid, $2::uuid, 'manual', $3, $4, $5, 'RECEIVED', $6, $5)`,
      orderId, order.customer_id, created.providerChargeId, method, cents, externalReference,
    );
  }
  await saveState(tx, operatorId, null, null, null, replyTo);
  await queueReply(tx, operatorId, message.id, replyTo,
    `Recebimento registrado: ${osLabel(osNumber)}, ${formatMoney(cents)} (${label}).`, 'receipt-done');
}

// Execução do 'sim' em CANCEL_CHARGE_CONFIRM.
async function executeChargeCancel(
  tx: Tx, message: MessageRow, payload: ConversationPayload, replyTo: string, cfg: Config,
): Promise<void> {
  const operatorId = message.operator_id;
  const chargeDbId = payload.chargeDbId;
  if (!chargeDbId) throw new Error('CHARGE_ID_MISSING');
  const rows = await tx.$queryRawUnsafe<Array<ChargeRow & { number: number }>>(
    `SELECT ch.id, ch.service_order_id, ch.provider, ch.provider_charge_id, ch.method, ch.value_cents, ch.due_date, ch.status, so.number
       FROM charges AS ch JOIN service_orders AS so ON so.id=ch.service_order_id
      WHERE ch.id=$1::uuid AND ch.status IN ('PENDING','OVERDUE')`,
    chargeDbId,
  );
  const charge = rows[0];
  await saveState(tx, operatorId, null, null, null, replyTo);
  if (!charge) {
    await queueReply(tx, operatorId, message.id, replyTo, 'A cobrança não está mais ativa; nada foi cancelado.', 'charge-cancel-stale');
    return;
  }
  const provider = getBillingProvider(cfg);
  if (charge.provider_charge_id && provider && provider.name === charge.provider) {
    await provider.cancelCharge(charge.provider_charge_id);
  }
  await tx.$executeRawUnsafe(
    "UPDATE charges SET status='CANCELED', updated_at=now() WHERE id=$1::uuid AND status IN ('PENDING','OVERDUE')",
    charge.id,
  );
  await queueReply(tx, operatorId, message.id, replyTo,
    `Cobrança da ${osLabel(charge.number)} cancelada.`, 'charge-canceled');
}

// `cpf <nome> <documento>`: grava o CPF/CNPJ do cliente (o Asaas exige o
// documento do pagador para criar cobrança). Documento: 11 (CPF) ou 14
// (CNPJ) dígitos após remover pontuação — dígito verificador NÃO é validado
// nesta fase. Nome ambíguo → lista numerada (estado CPF_CHOOSE).
async function updateCustomerFiscalId(
  tx: Tx, operatorId: string, sourceMessageId: string, replyTo: string,
  customer: CustomerRow, doc: string,
): Promise<void> {
  await tx.$executeRawUnsafe('UPDATE customers SET cpf_cnpj=$2 WHERE id=$1::uuid', customer.id, doc);
  await audit(tx, operatorId, sourceMessageId, 'customer', customer.id, 'SET_CPF_CNPJ', null, null);
  await saveState(tx, operatorId, null, null, null, replyTo);
  await queueReply(tx, operatorId, sourceMessageId, replyTo,
    `CPF/CNPJ de ${customer.name} atualizado. Tente a cobrança novamente.`, 'cpf-updated');
}

async function handleCpfCommand(
  tx: Tx, message: MessageRow, body: string, replyTo: string,
): Promise<void> {
  const operatorId = message.operator_id;
  const sourceMessageId = message.id;
  const parsed = /^cpf\s+(.+?)\s+(\S+)\s*$/i.exec(body);
  if (!parsed) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      'Use: cpf <nome do cliente> <documento>. Ex.: cpf Carlos 529.982.247-25.', 'cpf-usage');
    return;
  }
  const name = clean(parsed[1]!);
  const doc = parsed[2]!.replace(/\D/g, '');
  if (!/^\d{11}(?:\d{3})?$/.test(doc)) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      'Documento inválido. Informe CPF (11 dígitos) ou CNPJ (14 dígitos), com ou sem pontuação.', 'cpf-invalid');
    return;
  }
  const matches = await tx.$queryRawUnsafe<CustomerRow[]>(
    'SELECT id, name FROM customers WHERE strpos(normalized_name, $1)>0 ORDER BY created_at, id',
    normalize(name),
  );
  if (matches.length === 0) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Não encontrei cliente com esse nome: ${name}.`, 'cpf-customer-missing');
    return;
  }
  if (matches.length > 1) {
    await saveState(tx, operatorId, 'CPF_CHOOSE', { candidates: matches, cpfDoc: doc }, null, replyTo);
    const choices = matches.map((customer, index) => `${index + 1}. ${customer.name}`).join('\n');
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Encontrei mais de um cliente:\n${choices}\nResponda com o número.`, 'cpf-customer-many');
    return;
  }
  await updateCustomerFiscalId(tx, operatorId, sourceMessageId, replyTo, matches[0]!, doc);
}

// Fase 6.5: dados do tomador/consentimento. O mesmo mecanismo de escolha do
// CPF é usado para evitar gravar no primeiro resultado ambíguo.
async function customerMatches(tx: Tx, name: string): Promise<CustomerRow[]> {
  return tx.$queryRawUnsafe<CustomerRow[]>(
    'SELECT id, name FROM customers WHERE strpos(normalized_name, $1)>0 ORDER BY created_at, id',
    normalize(name),
  );
}

function formatPhone(phone: string | null): string {
  if (!phone) return 'sem telefone cadastrado';
  return `+${phone}`;
}

function formatAddress(customer: CustomerContactRow): string {
  if (!customer.address_street || !customer.address_number || !customer.address_district
    || !customer.address_city || !customer.address_state || !customer.address_zip) return 'não cadastrado';
  return `${customer.address_street}, ${customer.address_number} — ${customer.address_district}, ${customer.address_city}/${customer.address_state}, CEP ${customer.address_zip}`;
}

async function applyCustomerUpdate(
  tx: Tx, message: MessageRow, replyTo: string, customer: CustomerRow,
  update: NonNullable<ConversationPayload['customerUpdate']>,
): Promise<void> {
  if (update.kind === 'PHONE') {
    await tx.$executeRawUnsafe('UPDATE customers SET phone=$2 WHERE id=$1::uuid', customer.id, update.value);
    await audit(tx, message.operator_id, message.id, 'customer', customer.id, 'SET_PHONE', null, null);
    await queueReply(tx, message.operator_id, message.id, replyTo, `Telefone de ${customer.name} atualizado.`, 'customer-phone');
  } else if (update.kind === 'EMAIL') {
    await tx.$executeRawUnsafe('UPDATE customers SET email=$2 WHERE id=$1::uuid', customer.id, update.value);
    await audit(tx, message.operator_id, message.id, 'customer', customer.id, 'SET_EMAIL', null, null);
    await queueReply(tx, message.operator_id, message.id, replyTo, `E-mail de ${customer.name} atualizado.`, 'customer-email');
  } else if (update.kind === 'BILLING_OPT_IN') {
    const allowed = update.value === true;
    await tx.$executeRawUnsafe('UPDATE customers SET billing_opt_in=$2 WHERE id=$1::uuid', customer.id, allowed);
    await audit(tx, message.operator_id, message.id, 'customer', customer.id, 'SET_BILLING_OPTIN', null, null);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      allowed
        ? `Cliente ${customer.name} autorizado a receber cobranças no WhatsApp (${formatPhone((await tx.$queryRawUnsafe<{ phone: string | null }[]>('SELECT phone FROM customers WHERE id=$1::uuid', customer.id))[0]?.phone ?? null)}).`
        : `Autorização de ${customer.name} revogada.`,
      allowed ? 'customer-opt-in' : 'customer-opt-out');
  } else {
    const address = update.value as CustomerAddress;
    await tx.$executeRawUnsafe(
      `UPDATE customers SET address_street=$2, address_number=$3, address_district=$4,
       address_city=$5, address_state=$6, address_zip=$7 WHERE id=$1::uuid`,
      customer.id, address.street, address.number, address.district, address.city, address.state, address.zip,
    );
    await audit(tx, message.operator_id, message.id, 'customer', customer.id, 'SET_ADDRESS', null, null);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `Endereço de ${customer.name} atualizado: ${address.street}, ${address.number} — ${address.district}, ${address.city}/${address.state}, CEP ${address.zip}.`,
      'customer-address');
  }
  await saveState(tx, message.operator_id, null, null, null, replyTo);
}

async function beginCustomerUpdate(
  tx: Tx, message: MessageRow, replyTo: string, name: string,
  update: NonNullable<ConversationPayload['customerUpdate']>,
): Promise<void> {
  const matches = await customerMatches(tx, name);
  if (matches.length === 0) {
    await queueReply(tx, message.operator_id, message.id, replyTo, `Não encontrei "${name}".`, 'customer-update-missing');
    return;
  }
  if (matches.length === 1) {
    await applyCustomerUpdate(tx, message, replyTo, matches[0]!, update);
    return;
  }
  await saveState(tx, message.operator_id, 'CUSTOMER_UPDATE_CHOOSE', { candidates: matches, customerUpdate: update }, null, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo,
    `Encontrei mais de um cliente:\n${matches.map((customer, index) => `${index + 1}. ${customer.name}`).join('\n')}\nResponda com o número.`,
    'customer-update-many');
}

async function customerProfile(tx: Tx, message: MessageRow, replyTo: string, name: string): Promise<void> {
  const matches = await customerMatches(tx, name);
  if (matches.length === 0) {
    await queueReply(tx, message.operator_id, message.id, replyTo, `Não encontrei "${name}".`, 'customer-profile-missing');
    return;
  }
  if (matches.length > 1) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `Encontrei mais de um cliente:\n${matches.map((customer, index) => `${index + 1}. ${customer.name}`).join('\n')}\nRefine o nome para consultar a ficha.`,
      'customer-profile-many');
    return;
  }
  const customer = (await tx.$queryRawUnsafe<CustomerContactRow[]>(
    `SELECT id, name, cpf_cnpj, phone, email, address_street, address_number, address_district,
            address_city, address_state, address_zip, billing_opt_in
       FROM customers WHERE id=$1::uuid`, matches[0]!.id,
  ))[0];
  if (!customer) throw new Error('CUSTOMER_NOT_FOUND');
  const totals = (await tx.$queryRawUnsafe<Array<{ orders: bigint; charged: bigint; received: bigint }>>(
    `SELECT COUNT(DISTINCT so.id) AS orders,
            COALESCE(SUM(ch.value_cents) FILTER (WHERE ch.status NOT IN ('CANCELED', 'ERROR')), 0) AS charged,
            COALESCE(SUM(ch.paid_value_cents) FILTER (WHERE ch.status='RECEIVED'), 0) AS received
       FROM service_orders so LEFT JOIN charges ch ON ch.service_order_id=so.id
      WHERE so.customer_id=$1::uuid`, customer.id,
  ))[0];
  await queueReply(tx, message.operator_id, message.id, replyTo,
    `Cliente: ${customer.name}\nCPF/CNPJ: ${customer.cpf_cnpj ?? 'não cadastrado'}\nTelefone: ${formatPhone(customer.phone)}\nE-mail: ${customer.email ?? 'não cadastrado'}\nEndereço: ${formatAddress(customer)}\nCobranças por WhatsApp: ${customer.billing_opt_in ? 'autorizado' : 'não autorizado'}\nOS: ${totals?.orders ?? 0}\nCobrado: ${formatMoney(Number(totals?.charged ?? 0))}\nRecebido: ${formatMoney(Number(totals?.received ?? 0))}`,
    'customer-profile');
}

async function customerHistory(tx: Tx, message: MessageRow, replyTo: string, name: string): Promise<void> {
  const matches = await customerMatches(tx, name);
  if (matches.length !== 1) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      matches.length === 0 ? `Não encontrei "${name}".` : 'Encontrei mais de um cliente; refine o nome para consultar o histórico.',
      'customer-history-match');
    return;
  }
  const customer = matches[0]!;
  const rows = await tx.$queryRawUnsafe<Array<{ number: number; created_at: Date | string; amount_cents: number | null; status: string; charge_status: string | null }>>(
    `SELECT so.number, so.created_at, so.amount_cents, so.status,
            (SELECT ch.status FROM charges ch WHERE ch.service_order_id=so.id ORDER BY ch.created_at DESC LIMIT 1) AS charge_status
       FROM service_orders so WHERE so.customer_id=$1::uuid ORDER BY so.number DESC LIMIT 5`,
    customer.id,
  );
  const response = rows.length === 0
    ? `Nenhuma OS para ${customer.name}.`
    : `Histórico de ${customer.name}:\n${rows.map((row) => {
      const iso = dueIso(row.created_at);
      return `${osLabel(row.number)} · ${iso ? formatDue(iso).slice(0, 5) : '—'} · ${formatMoney(row.amount_cents)} · ${row.status} · cobrança ${row.charge_status ?? '—'}`;
    }).join('\n')}`;
  await queueReply(tx, message.operator_id, message.id, replyTo, response, 'customer-history');
}

async function handleCustomerCommand(tx: Tx, message: MessageRow, body: string, replyTo: string): Promise<boolean> {
  const phone = /^telefone\s+(.+?)\s+(\S+)\s*$/i.exec(body);
  if (phone) {
    const value = phone[2]!.replace(/\D/g, '');
    if (!/^\d{10,13}$/.test(value)) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Telefone inválido. Informe 10 a 13 dígitos com DDI.', 'phone-invalid');
      return true;
    }
    await beginCustomerUpdate(tx, message, replyTo, clean(phone[1]!), { kind: 'PHONE', value });
    return true;
  }
  const email = /^email\s+(.+?)\s+(\S+)\s*$/i.exec(body);
  if (email) {
    const value = email[2]!.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'E-mail inválido.', 'email-invalid');
      return true;
    }
    await beginCustomerUpdate(tx, message, replyTo, clean(email[1]!), { kind: 'EMAIL', value });
    return true;
  }
  const address = /^endere[cç]o\s+(.+?)\s*\|\s*(.+)$/i.exec(body);
  if (address) {
    const parts = address[2]!.split(',').map(clean);
    const cityState = parts.length === 5 ? /^(.+)\/([A-Za-z]{2})$/.exec(parts[3]!) : null;
    const zip = parts.length === 5 ? parts[4]!.replace(/\D/g, '') : '';
    if (!cityState || !/^\d{8}$/.test(zip) || parts.some((part) => !part)) {
      await queueReply(tx, message.operator_id, message.id, replyTo,
        'Formato: endereco <nome> | <rua>, <número>, <bairro>, <cidade>/<UF>, <CEP>', 'address-invalid');
      return true;
    }
    await beginCustomerUpdate(tx, message, replyTo, clean(address[1]!), {
      kind: 'ADDRESS',
      value: { street: parts[0]!, number: parts[1]!, district: parts[2]!, city: clean(cityState[1]!), state: cityState[2]!.toUpperCase(), zip },
    });
    return true;
  }
  if (/^endere[cç]o\b/i.test(body)) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      'Formato: endereco <nome> | <rua>, <número>, <bairro>, <cidade>/<UF>, <CEP>', 'address-usage');
    return true;
  }
  const optIn = /^(autorizar|revogar)\s+(.+)$/i.exec(body);
  if (optIn) {
    await beginCustomerUpdate(tx, message, replyTo, clean(optIn[2]!), { kind: 'BILLING_OPT_IN', value: /^autorizar$/i.test(optIn[1]!) });
    return true;
  }
  const profile = /^cliente\s+(.+)$/i.exec(body);
  if (profile) {
    await customerProfile(tx, message, replyTo, clean(profile[1]!));
    return true;
  }
  const history = /^hist[oó]rico\s+(.+)$/i.exec(body);
  if (history) {
    await customerHistory(tx, message, replyTo, clean(history[1]!));
    return true;
  }
  return false;
}

async function executeOrderCancellation(
  tx: Tx, message: MessageRow, orderId: string, orderNumber: number, replyTo: string,
): Promise<void> {
  const orders = await tx.$queryRawUnsafe<CancelOrderRow[]>(
    `SELECT so.id, so.number, so.status, c.name AS customer, so.amount_cents
       FROM service_orders so JOIN customers c ON c.id=so.customer_id
      WHERE so.id=$1::uuid FOR UPDATE`, orderId,
  );
  const order = orders[0];
  if (!order) throw new Error('CANCEL_ORDER_NOT_FOUND');
  if (order.status === 'CANCELADA') {
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, `A ${osLabel(orderNumber)} já está cancelada.`, 'order-cancelled');
    return;
  }
  const active = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
    "SELECT id, status FROM charges WHERE service_order_id=$1::uuid AND status IN ('PENDING','OVERDUE') LIMIT 1 FOR UPDATE",
    order.id,
  );
  if (active[0]) {
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `A ${osLabel(order.number)} tem cobrança ${active[0].status} — cancele a cobrança antes (cancelar cobrança OS ${order.number}).`,
      'order-cancel-active-charge');
    return;
  }
  const items = order.status === 'CONFIRMADA'
    ? await tx.$queryRawUnsafe<Array<{ item_id: string; quantity: string }>>(
      `SELECT soi.inventory_item_id AS item_id, soi.quantity::text AS quantity
         FROM service_order_items soi JOIN inventory_items ii ON ii.id=soi.inventory_item_id
        WHERE soi.service_order_id=$1::uuid AND soi.inventory_item_id IS NOT NULL
        ORDER BY soi.inventory_item_id FOR UPDATE OF ii`, order.id,
    )
    : [];
  const changed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE service_orders SET status='CANCELADA', cancelled_at=now()
      WHERE id=$1::uuid AND status IN ('AGUARDANDO_DADOS','AGUARDANDO_CONFIRMACAO','CONFIRMADA')
      RETURNING id`, order.id,
  );
  if (!changed[0]) throw new Error('ORDER_CANCEL_STATE_CHANGED');
  if (order.status === 'CONFIRMADA') {
    for (const item of items) {
      await tx.$executeRawUnsafe('UPDATE inventory_items SET quantity=quantity+$2::numeric WHERE id=$1::uuid', item.item_id, item.quantity);
      await insertMovement(tx, item.item_id, 'RETURN', item.quantity, message.operator_id, message.id, 'cancelamento da OS', order.id);
    }
  }
  await audit(tx, message.operator_id, message.id, 'service_order', order.id, 'CANCEL_ORDER', order.status, 'CANCELADA', 'operador');
  await saveState(tx, message.operator_id, null, null, null, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo,
    order.status === 'CONFIRMADA' && items.length > 0
      ? `${osLabel(order.number)} cancelada. ${items.length} item(ns) estornado(s) ao estoque.`
      : `${osLabel(order.number)} cancelada.`,
    'order-cancelled');
}

async function handleOrderLifecycleCommand(tx: Tx, message: MessageRow, body: string, replyTo: string): Promise<boolean> {
  const parsed = /^cancelar\s+OS\s+(\d+)$/i.exec(body);
  if (!parsed) return false;
  const rows = await tx.$queryRawUnsafe<CancelOrderRow[]>(
    `SELECT so.id, so.number, so.status, c.name AS customer, so.amount_cents
       FROM service_orders so JOIN customers c ON c.id=so.customer_id WHERE so.number=$1`,
    Number(parsed[1]),
  );
  const order = rows[0];
  if (!order) {
    await queueReply(tx, message.operator_id, message.id, replyTo, 'OS não encontrada.', 'order-cancel-missing');
    return true;
  }
  if (order.status === 'CANCELADA') {
    await queueReply(tx, message.operator_id, message.id, replyTo, `A ${osLabel(order.number)} já está cancelada.`, 'order-cancelled');
    return true;
  }
  const active = await tx.$queryRawUnsafe<Array<{ status: string }>>(
    "SELECT status FROM charges WHERE service_order_id=$1::uuid AND status IN ('PENDING','OVERDUE') LIMIT 1",
    order.id,
  );
  if (active[0]) {
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `A ${osLabel(order.number)} tem cobrança ${active[0].status} — cancele a cobrança antes (cancelar cobrança OS ${order.number}).`,
      'order-cancel-active-charge');
    return true;
  }
  const stocked = (await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT COUNT(*) AS count FROM service_order_items WHERE service_order_id=$1::uuid AND inventory_item_id IS NOT NULL', order.id,
  ))[0]?.count ?? 0n;
  await saveState(tx, message.operator_id, 'CANCEL_ORDER_CONFIRM', { cancelOrderId: order.id, cancelOrderNumber: order.number }, null, replyTo);
  await queueReply(tx, message.operator_id, message.id, replyTo,
    `Cancelar a ${osLabel(order.number)} (${order.customer}, ${formatMoney(order.amount_cents)}, status ${order.status})?${order.status === 'CONFIRMADA' && stocked > 0n ? ' Materiais serão estornados ao estoque.' : ''} Responda sim ou cancelar.`,
    'order-cancel-confirm');
  return true;
}

// Comandos de cobrança sem pendência ativa (!hasState).
async function handleBillingCommand(
  tx: Tx, message: MessageRow, body: string, replyTo: string, cfg: Config,
): Promise<void> {
  const operatorId = message.operator_id;
  const sourceMessageId = message.id;

  if (/^cpf\b/i.test(body)) {
    await handleCpfCommand(tx, message, body, replyTo);
    return;
  }

  if (/^cobran[çc]as$/i.test(body)) {
    const rows = await tx.$queryRawUnsafe<Array<{ number: number; customer: string; value_cents: number; due_date: Date | string | null; status: string }>>(
      `SELECT so.number, c.name AS customer, ch.value_cents, ch.due_date, ch.status
         FROM charges AS ch
         JOIN service_orders AS so ON so.id=ch.service_order_id
         JOIN customers AS c ON c.id=ch.customer_id
        WHERE ch.status IN ('PENDING','OVERDUE')
        ORDER BY ch.due_date NULLS LAST, so.number`,
    );
    const response = rows.length === 0
      ? 'Nenhuma cobrança aberta.'
      : `Cobranças abertas:\n${rows.map((row) => {
        const due = dueIso(row.due_date);
        return `${osLabel(row.number)} · ${row.customer} · ${formatMoney(row.value_cents)} · vence ${due ? formatDue(due).slice(0, 5) : '—'} · ${row.status}`;
      }).join('\n')}`;
    await queueReply(tx, operatorId, sourceMessageId, replyTo, response, 'charges-list');
    return;
  }

  if (/^vencidas$/i.test(body)) {
    const rows = await tx.$queryRawUnsafe<Array<{ number: number; customer: string; value_cents: number; due_date: Date | string | null }>>(
      `SELECT so.number, c.name AS customer, ch.value_cents, ch.due_date
         FROM charges AS ch
         JOIN service_orders AS so ON so.id=ch.service_order_id
         JOIN customers AS c ON c.id=ch.customer_id
        WHERE ch.status='OVERDUE'
        ORDER BY ch.due_date, so.number`,
    );
    if (rows.length === 0) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Nenhuma cobrança vencida.', 'charges-overdue-none');
      return;
    }
    const total = rows.reduce((sum, row) => sum + row.value_cents, 0);
    const header = rows.length === 1
      ? `1 cobrança vencida, total ${formatMoney(total)}:`
      : `${rows.length} cobranças vencidas, total ${formatMoney(total)}:`;
    const lines = rows.map((row) => {
      const due = dueIso(row.due_date);
      return `${osLabel(row.number)} · ${row.customer} · ${formatMoney(row.value_cents)} · venceu ${due ? formatDue(due).slice(0, 5) : '—'}`;
    });
    await queueReply(tx, operatorId, sourceMessageId, replyTo, `${header}\n${lines.join('\n')}`, 'charges-overdue');
    return;
  }

  const recebi = /^recebi\s+OS\s+(\d+)\s+(\S+?)(?:\s+(pix|dinheiro))?$/i.exec(body);
  if (recebi) {
    const osNumber = Number(recebi[1]);
    const cents = parseMoney(recebi[2]!);
    if (cents === null || cents <= 0) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Valor inválido. Use, por exemplo, 150 ou 150,00.', 'receipt-bad-money');
      return;
    }
    const order = await findOrderForCharge(tx, osNumber);
    if (!order) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'OS não encontrada.', 'receipt-os-missing');
      return;
    }
    const method: 'CASH' | 'EXTERNAL_PIX' = recebi[3]?.toLowerCase() === 'pix' ? 'EXTERNAL_PIX' : 'CASH';
    const label = method === 'CASH' ? 'dinheiro' : 'pix';
    await saveState(tx, operatorId, 'RECEIPT_CONFIRM', {
      chargeOsId: order.id, chargeOsNumber: order.number, receiptCents: cents, receiptMethod: method,
    }, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Registrar recebimento de ${formatMoney(cents)} da ${osLabel(order.number)} (${label})? Responda sim ou cancelar.`, 'receipt-confirm');
    return;
  }
  if (/^recebi\b/i.test(body)) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Use: recebi OS <número> <valor> [pix|dinheiro]. Ex.: recebi OS 3 150,00 pix.', 'receipt-usage');
    return;
  }

  const cancelCharge = /^cancelar\s+cobran[çc]a\s+OS\s+(\d+)$/i.exec(body);
  if (cancelCharge) {
    const osNumber = Number(cancelCharge[1]);
    const order = await findOrderForCharge(tx, osNumber);
    if (!order) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'OS não encontrada.', 'charge-cancel-os-missing');
      return;
    }
    const active = await findActiveCharge(tx, order.id);
    if (!active) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo,
        `Não há cobrança ativa (PENDING ou OVERDUE) para a ${osLabel(order.number)}.`, 'charge-cancel-none');
      return;
    }
    await saveState(tx, operatorId, 'CANCEL_CHARGE_CONFIRM', {
      chargeDbId: active.id, chargeOsId: order.id, chargeOsNumber: order.number,
    }, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo,
      `Cancelar a cobrança ${active.method} de ${formatMoney(active.value_cents)} da ${osLabel(order.number)}? Responda sim ou cancelar.`, 'charge-cancel-confirm');
    return;
  }

  const cobrar = /^cobrar\s+OS\s+(\d+)(?:\s+(pix|boleto))?(?:\s+(\d{2}\/\d{2}\/\d{4}|\+\d{1,3}d))?$/i.exec(body);
  if (cobrar) {
    if (!getBillingProvider(cfg)) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo,
        "Cobrança automática não configurada (BILLING_PROVIDER=none). Use 'recebi OS <n> <valor>' para registrar pagamento externo.", 'charge-none');
      return;
    }
    const order = await validateChargeTarget(tx, operatorId, sourceMessageId, replyTo, Number(cobrar[1]));
    if (!order) return;
    const defaultDue = dueIso(order.due_date) ?? todaySp();
    const basePayload: ConversationPayload = {
      chargeOsId: order.id,
      chargeOsNumber: order.number,
      chargeCustomerName: order.customer,
      chargeValueCents: order.amount_cents ?? undefined,
      chargeDueDate: defaultDue,
    };
    const method = cobrar[2]?.toLowerCase() === 'pix' ? 'PIX' as const : cobrar[2]?.toLowerCase() === 'boleto' ? 'BOLETO' as const : undefined;
    if (!method) {
      await saveState(tx, operatorId, 'CHARGE_METHOD', basePayload, null, replyTo);
      await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Método da cobrança? Responda pix ou boleto.', 'charge-ask-method');
      return;
    }
    const withMethod = { ...basePayload, chargeMethod: method };
    const dueInput = cobrar[3];
    if (!dueInput) {
      await saveState(tx, operatorId, 'CHARGE_DUE', withMethod, null, replyTo);
      await queueReply(tx, operatorId, sourceMessageId, replyTo,
        `Vencimento? Responda DD/MM/AAAA, +Nd ou - para usar ${formatDue(defaultDue)}.`, 'charge-ask-due');
      return;
    }
    const dueDate = parseDueInput(dueInput);
    if (!dueDate) {
      await queueReply(tx, operatorId, sourceMessageId, replyTo,
        `Data inválida. Use DD/MM/AAAA ou +Nd (ex.: 10/11/2026, +7d).`, 'charge-bad-due');
      return;
    }
    const finalPayload = { ...withMethod, chargeDueDate: dueDate };
    await saveState(tx, operatorId, 'CHARGE_CONFIRM', finalPayload, null, replyTo);
    await queueReply(tx, operatorId, sourceMessageId, replyTo, chargeSummary(finalPayload), 'charge-confirm');
    return;
  }
  if (/^cobrar\b/i.test(body)) {
    await queueReply(tx, operatorId, sourceMessageId, replyTo, 'Use: cobrar OS <número> [pix|boleto] [DD/MM/AAAA | +Nd]. Ex.: cobrar OS 3 pix +7d.', 'charge-usage');
    return;
  }

  await queueReply(tx, operatorId, sourceMessageId, replyTo,
    "Comandos de cobrança: 'cobrar OS 3 pix +7d', 'cobranças', 'vencidas', 'recebi OS 3 150,00 pix', 'cancelar cobrança OS 3'.", 'billing-help');
}

// Steps guiados da cobrança (CHARGE_METHOD → CHARGE_DUE → CHARGE_CONFIRM) e
// confirmações de recebimento/cancelamento. Retorna true quando tratou.
async function handleBillingStep(
  tx: Tx, message: MessageRow, payload: ConversationPayload, body: string, replyTo: string, cfg: Config,
): Promise<boolean> {
  if (message.pending_action === 'INVOICE_CONFIRM') {
    if (!isYes(body)) {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Operação cancelada.', 'invoice-abort');
      return true;
    }
    await executeInvoiceRequest(tx, message, payload, replyTo, cfg);
    return true;
  }
  if (message.pending_action === 'CUSTOMER_UPDATE_CHOOSE') {
    const choice = Number(body);
    const candidate = Number.isInteger(choice) ? payload.candidates?.[choice - 1] : undefined;
    if (!candidate || !payload.customerUpdate) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Escolha um número da lista.', 'choose-invalid');
      return true;
    }
    await applyCustomerUpdate(tx, message, replyTo, candidate, payload.customerUpdate);
    return true;
  }
  if (message.pending_action === 'CHARGE_SEND_CONFIRM') {
    if (!isYes(body)) {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Ok, cobrança só com você.', 'charge-send-skip');
      return true;
    }
    if (!payload.chargeSendTo || !payload.chargeSendBody || !payload.chargeSendId) throw new Error('CHARGE_SEND_FIELDS_MISSING');
    await queueNotice(tx, message.operator_id, payload.chargeSendTo, payload.chargeSendBody, `charge-send:${payload.chargeSendId}`);
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Cobrança enviada ao cliente.', 'charge-send-confirmed');
    return true;
  }
  if (message.pending_action === 'CANCEL_ORDER_CONFIRM') {
    if (!isYes(body)) {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Operação cancelada.', 'order-cancel-abort');
      return true;
    }
    if (!payload.cancelOrderId || !payload.cancelOrderNumber) throw new Error('CANCEL_ORDER_FIELDS_MISSING');
    await executeOrderCancellation(tx, message, payload.cancelOrderId, payload.cancelOrderNumber, replyTo);
    return true;
  }
  if (message.pending_action === 'CPF_CHOOSE') {
    const choice = Number(body);
    const candidate = Number.isInteger(choice) ? payload.candidates?.[choice - 1] : undefined;
    if (!candidate || !payload.cpfDoc) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Escolha um número da lista.', 'choose-invalid');
      return true;
    }
    await updateCustomerFiscalId(tx, message.operator_id, message.id, replyTo, candidate, payload.cpfDoc);
    return true;
  }
  if (message.pending_action === 'CHARGE_METHOD') {
    const method = /^pix$/i.test(body) ? 'PIX' as const : /^boleto$/i.test(body) ? 'BOLETO' as const : null;
    if (!method) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Responda pix ou boleto.', 'charge-method-invalid');
      return true;
    }
    const next = { ...payload, chargeMethod: method };
    await saveState(tx, message.operator_id, 'CHARGE_DUE', next, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      `Vencimento? Responda DD/MM/AAAA, +Nd ou - para usar ${formatDue(payload.chargeDueDate ?? todaySp())}.`, 'charge-ask-due');
    return true;
  }
  if (message.pending_action === 'CHARGE_DUE') {
    const fallback = payload.chargeDueDate ?? todaySp();
    const dueDate = body.trim() === '-' ? fallback : parseDueInput(body);
    if (!dueDate) {
      await queueReply(tx, message.operator_id, message.id, replyTo,
        `Data inválida. Use DD/MM/AAAA, +Nd ou - para usar ${formatDue(fallback)}.`, 'charge-due-invalid');
      return true;
    }
    const next = { ...payload, chargeDueDate: dueDate };
    await saveState(tx, message.operator_id, 'CHARGE_CONFIRM', next, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, chargeSummary(next), 'charge-confirm');
    return true;
  }
  if (message.pending_action === 'CHARGE_CONFIRM') {
    if (!isYes(body)) {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Operação cancelada.', 'charge-cancel');
      return true;
    }
    await executeChargeCreation(tx, message, payload, replyTo, cfg);
    return true;
  }
  if (message.pending_action === 'RECEIPT_CONFIRM') {
    if (!isYes(body)) {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Operação cancelada.', 'receipt-cancel');
      return true;
    }
    await executeReceipt(tx, message, payload, replyTo, cfg);
    return true;
  }
  if (message.pending_action === 'CANCEL_CHARGE_CONFIRM') {
    if (!isYes(body)) {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Operação cancelada.', 'charge-cancel-abort');
      return true;
    }
    await executeChargeCancel(tx, message, payload, replyTo, cfg);
    return true;
  }
  return false;
}

// ===== Relatórios e automações (Fase 8) =====
//
// Fechamento diário e relatório semanal nascem de SQL puro (centavos
// inteiros, datas em America/Sao_Paulo) e são entregues pela outbox:
// sob demanda (`fechamento`, `relatorio semanal`) ou agendados no
// /automation/tick (report_deliveries decide "já enviado" por período).

/** Agora em America/Sao_Paulo: date ISO, hora 0-23 e dia da semana 0-6. */
export function spNowParts(): { date: string; hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const hour = Number(pick('hour')) % 24;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(pick('weekday'));
  return { date, hour, weekday };
}

/** Segunda-feira (ISO) da semana do dia informado. */
export function mondayOf(dayIso: string): string {
  const date = new Date(`${dayIso}T12:00:00Z`);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const brDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

type TotalsRow = { count: bigint; total: bigint };

async function dayTotals(tx: Tx, sql: string, from: string, to: string): Promise<TotalsRow> {
  return (await tx.$queryRawUnsafe<TotalsRow[]>(sql, from, to))[0]!;
}

// Cobranças abertas agora (estado, não período) — aparece nos dois relatórios.
async function openChargesLine(tx: Tx): Promise<string> {
  const rows = await tx.$queryRawUnsafe<Array<{ open: bigint; overdue: bigint; total: bigint }>>(
    `SELECT count(*) AS open,
            count(*) FILTER (WHERE status='OVERDUE') AS overdue,
            COALESCE(sum(value_cents), 0) AS total
       FROM charges WHERE status IN ('PENDING','OVERDUE')`,
  );
  const row = rows[0]!;
  const overdue = Number(row.overdue);
  return `Cobranças abertas: ${Number(row.open)} · ${formatMoney(Number(row.total))}${overdue > 0 ? ` (${overdue} vencida${overdue > 1 ? 's' : ''})` : ''}`;
}

// Alertas de estado (atuais, não do período): OS incompletas antigas,
// notas fiscais pendentes e estoque no mínimo. Retorna '' se nada pende.
async function alertsSection(tx: Tx, todayIso: string): Promise<string> {
  const parts: string[] = [];
  const incomplete = await tx.$queryRawUnsafe<Array<{ number: number; day: string }>>(
    `SELECT number, to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM') AS day
       FROM service_orders
      WHERE status IN ('AGUARDANDO_DADOS','AGUARDANDO_CONFIRMACAO')
        AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date < $1::date
      ORDER BY number LIMIT 5`,
    todayIso,
  );
  if (incomplete.length > 0) {
    parts.push(`OS incompletas: ${incomplete.map((row) => `${osLabel(row.number)} (de ${row.day})`).join(', ')}`);
  }
  const fiscal = await tx.$queryRawUnsafe<Array<{ number: number; status: string; ref: string }>>(
    `SELECT so.number, i.status, COALESCE(i.payload->>'externalReference', '—') AS ref
       FROM invoices i JOIN service_orders so ON so.id=i.service_order_id
      WHERE i.status NOT IN ('AUTHORIZED','CANCELED')
      ORDER BY i.created_at LIMIT 5`,
  );
  if (fiscal.length > 0) {
    parts.push(`Notas fiscais pendentes: ${fiscal.map((row) => `${osLabel(row.number)} ${row.status} (${row.ref})`).join(', ')}`);
  }
  const low = await tx.$queryRawUnsafe<Array<{ name: string; quantity: string; min_quantity: string; unit: string }>>(
    `SELECT name, quantity::text, min_quantity::text, unit FROM inventory_items
      WHERE min_quantity IS NOT NULL AND quantity <= min_quantity
      ORDER BY name LIMIT 8`,
  );
  if (low.length > 0) {
    parts.push(`Estoque mínimo: ${low.map((row) => `${row.name} ${formatQty(row.quantity)}/${formatQty(row.min_quantity)} ${row.unit}`).join(', ')}`);
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

export async function dailyCloseBody(tx: Tx, dayIso: string): Promise<string> {
  const orders = await dayTotals(tx,
    `SELECT count(*) AS count, COALESCE(sum(amount_cents), 0) AS total
       FROM service_orders
      WHERE status='CONFIRMADA' AND (confirmed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date`,
    dayIso, dayIso);
  const receipts = await dayTotals(tx,
    `SELECT count(*) AS count, COALESCE(sum(paid_value_cents), 0) AS total
       FROM charges
      WHERE status='RECEIVED' AND (updated_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date`,
    dayIso, dayIso);
  const alerts = await alertsSection(tx, dayIso);
  return `Fechamento ${brDay(dayIso)}\n` +
    `OS confirmadas: ${Number(orders.count)} · ${formatMoney(Number(orders.total))}\n` +
    `Recebido: ${Number(receipts.count)} · ${formatMoney(Number(receipts.total))}\n` +
    `${await openChargesLine(tx)}${alerts}`;
}

export async function weeklyReportBody(tx: Tx, mondayIso: string, todayIso: string): Promise<string> {
  const orders = await dayTotals(tx,
    `SELECT count(*) AS count, COALESCE(sum(amount_cents), 0) AS total
       FROM service_orders
      WHERE status='CONFIRMADA' AND (confirmed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date`,
    mondayIso, todayIso);
  const receipts = await dayTotals(tx,
    `SELECT count(*) AS count, COALESCE(sum(paid_value_cents), 0) AS total
       FROM charges
      WHERE status='RECEIVED' AND (updated_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date`,
    mondayIso, todayIso);
  const charged = await dayTotals(tx,
    `SELECT count(*) AS count, COALESCE(sum(value_cents), 0) AS total
       FROM charges
      WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1::date AND $2::date`,
    mondayIso, todayIso);
  const alerts = await alertsSection(tx, todayIso);
  return `Relatório semanal ${brDay(mondayIso)}–${brDay(todayIso)}\n` +
    `OS confirmadas: ${Number(orders.count)} · ${formatMoney(Number(orders.total))}\n` +
    `Cobrado: ${Number(charged.count)} · ${formatMoney(Number(charged.total))}\n` +
    `Recebido: ${Number(receipts.count)} · ${formatMoney(Number(receipts.total))}\n` +
    `${await openChargesLine(tx)}${alerts}`;
}

// `fechamento` e `relatorio semanal` sob demanda. Retorna true quando tratou.
async function handleReportCommand(tx: Tx, message: MessageRow, body: string, replyTo: string): Promise<boolean> {
  if (/^fechamento$/i.test(body)) {
    const { date } = spNowParts();
    await queueReply(tx, message.operator_id, message.id, replyTo, await dailyCloseBody(tx, date), 'report-daily');
    return true;
  }
  if (/^relat[óo]rio\s+semanal$/i.test(body)) {
    const { date } = spNowParts();
    await queueReply(tx, message.operator_id, message.id, replyTo, await weeklyReportBody(tx, mondayOf(date), date), 'report-weekly');
    return true;
  }
  return false;
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
  if (!hasState && /^material\s+novo$/i.test(body)) {
    await saveState(tx, message.operator_id, 'matNome', {}, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, 'Nome do material?', 'mat-new');
    return;
  }
  if (!hasState && /^(saldo|entrada|ajustar|devolver|estoque)\b/i.test(body)) {
    await handleStockCommand(tx, message, body, replyTo);
    return;
  }
  if (!hasState && await handleCustomerCommand(tx, message, body, replyTo)) return;
  if (!hasState && await handleOrderLifecycleCommand(tx, message, body, replyTo)) return;
  if (!hasState && await handleReportCommand(tx, message, body, replyTo)) return;
  if (!hasState && /^(emitir\s+NF|notas|nota\s+emitida|cancelar\s+nota)\b/i.test(body)) {
    await handleInvoiceCommand(tx, message, body, replyTo, cfg);
    return;
  }
  if (!hasState && /^(cobrar|cobran[çc]as|vencidas|recebi|cancelar\s+cobran[çc]a|cpf)\b/i.test(body)) {
    await handleBillingCommand(tx, message, body, replyTo, cfg);
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
  if (message.pending_action === 'CONFIRM' && /^corrigir\s+materiais$/i.test(body)) {
    if (!message.service_order_id) throw new Error('ORDER_ID_MISSING');
    // Itens do draft fechado anteriormente são apagados — a nova lista
    // substitui integralmente (nunca duplica).
    await tx.$executeRawUnsafe('DELETE FROM service_order_items WHERE service_order_id=$1::uuid', message.service_order_id);
    await saveState(tx, message.operator_id, 'materials', { ...payload, materialsDraft: [], materialsPending: [] }, message.service_order_id, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      'Usou materiais? Liste "quantidade nome" separado por vírgula ou responda não. (Ex.: 2 cabo, 3 disjuntor)', 'materials-reask');
    return;
  }
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
  if (message.pending_action === 'matNome' || message.pending_action === 'matUnidade'
    || message.pending_action === 'matSaldo' || message.pending_action === 'matMinimo') {
    await handleMaterialCreationStep(tx, message, payload, body, replyTo);
    return;
  }
  if (message.pending_action === 'MATERIAL_CONFIRM') {
    if (!isYes(body)) {
      await saveState(tx, message.operator_id, null, null, null, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Operação cancelada.', 'material-cancel');
      return;
    }
    if (payload.matName && payload.matUnit
      && payload.entryQuantity === undefined && payload.adjustQuantity === undefined
      && payload.returnQuantity === undefined) {
      // Confirmação do cadastro guiado 'material novo'.
      await confirmMaterialCreation(tx, message, payload, replyTo);
      return;
    }
    await confirmMaterialOperation(tx, message, payload, replyTo);
    return;
  }
  if (message.pending_action === 'materials') {
    await handleMaterialsStep(tx, message, payload, body, replyTo);
    return;
  }
  if (message.pending_action === 'AWAITING_DISAMBIGUATION' && payload.purpose === 'MATERIAL') {
    const choice = Number(body);
    const candidate = Number.isInteger(choice) ? payload.candidates?.[choice - 1] : undefined;
    if (!candidate) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Escolha um número da lista.', 'choose-invalid');
      return;
    }
    if (payload.materialsDraft || payload.materialsPending) {
      // Fluxo de OS: resolve o pendente atual e continua a fila.
      const draft = [...(payload.materialsDraft ?? [])];
      const pendingRest = [...(payload.materialsPending ?? [])];
      const current = pendingRest.shift();
      if (!current) throw new Error('MATERIAL_QUEUE_EMPTY');
      draft.push({ rawName: current.rawName, quantity: current.quantity, inventoryItemId: candidate.id });
      await processMaterialsQueue(
        tx,
        { ...message, service_order_id: message.service_order_id },
        { ...payload, materialsDraft: draft, materialsPending: pendingRest },
        replyTo,
      );
      return;
    }
    await confirmMaterialOperation(tx, message, payload, replyTo, candidate.id);
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
          { serviceAmountCents: payload.serviceAmountCents, materialAmountCents: payload.materialAmountCents, dueDate: payload.dueDate, materialsDraft: payload.materialsDraft },
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
        { serviceAmountCents: payload.serviceAmountCents, materialAmountCents: payload.materialAmountCents, dueDate: payload.dueDate, materialsDraft: payload.materialsDraft },
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
    if (payload.materialsDraft && payload.materialsDraft.length > 0) {
      // Materiais já vieram pré-preenchidos (áudio): direto para confirmação.
      await saveState(tx, message.operator_id, 'CONFIRM', payload, message.service_order_id, replyTo);
      await queueReply(tx, message.operator_id, message.id, replyTo, await orderSummary(tx, message.service_order_id), 'value');
      return;
    }
    await saveState(tx, message.operator_id, 'materials', payload, message.service_order_id, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo,
      'Usou materiais? Liste "quantidade nome" separado por vírgula ou responda não. (Ex.: 2 cabo, 3 disjuntor)', 'materials-ask');
    return;
  }
  if (message.pending_action === 'CONFIRM') {
    // Comandos de estoque funcionam durante a confirmação: entrada/ajuste/
    // devolução executam e RESTAURAM o estado CONFIRM da OS (contrato item 9);
    // saldo/estoque são read-only.
    if (/^(entrada|ajustar|devolver|saldo|estoque)\b/i.test(body)) {
      if (!message.service_order_id) throw new Error('ORDER_ID_MISSING');
      await handleStockCommand(tx, message, body, replyTo, { payload: payload, orderId: message.service_order_id });
      return;
    }
    if (!isYes(body)) {
      await queueReply(tx, message.operator_id, message.id, replyTo, 'Aguardo confirmação da OS: responda sim ou cancelar.', 'confirm-invalid');
      return;
    }
    if (!message.service_order_id) throw new Error('ORDER_ID_MISSING');
    const orderId = message.service_order_id;
    // Baixa transacional: trava os itens de estoque em ordem determinística e
    // valida saldo ANTES de mover o status. Estoque insuficiente é feedback
    // determinístico (estado permanece CONFIRM), não erro de engine.
    const items = await tx.$queryRawUnsafe<Array<{ item_id: string; raw_name: string; quantity: string; unit: string; available: string }>>(
      `SELECT soi.inventory_item_id AS item_id, soi.raw_name, soi.quantity::text AS quantity, ii.unit, ii.quantity::text AS available
         FROM service_order_items soi
         JOIN inventory_items ii ON ii.id = soi.inventory_item_id
        WHERE soi.service_order_id = $1::uuid AND soi.inventory_item_id IS NOT NULL
        ORDER BY soi.id
        FOR UPDATE OF ii`,
      orderId,
    );
    const shortfalls = items.filter((item) => Number(item.available) < Number(item.quantity));
    if (shortfalls.length > 0) {
      await queueReply(tx, message.operator_id, message.id, replyTo,
        `Estoque insuficiente para confirmar: ${shortfalls.map((item) => `${item.raw_name} (disponível: ${formatQty(item.available)} ${item.unit})`).join('; ')}. Dê entrada ('entrada <qtd> <material>') ou ajuste e confirme novamente.`, 'confirm-stock');
      return;
    }
    const orders = await tx.$queryRawUnsafe<{ id: string }[]>(
      "UPDATE service_orders SET status='CONFIRMADA', confirmed_at=now() WHERE id=$1::uuid AND status='AGUARDANDO_CONFIRMACAO' RETURNING id",
      orderId,
    );
    const order = orders[0];
    if (!order) {
      // Idempotência: OS já confirmada em confirmação anterior — o estoque já
      // foi baixado; responde com o recibo sem deduzir nem auditar de novo.
      const current = await tx.$queryRawUnsafe<{ status: string }[]>(
        'SELECT status FROM service_orders WHERE id=$1::uuid', orderId,
      );
      if (current[0]?.status === 'CONFIRMADA') {
        await saveState(tx, message.operator_id, null, null, null, replyTo);
        await queueReply(tx, message.operator_id, message.id, replyTo, await confirmationReceipt(tx, orderId), 'confirm');
        return;
      }
      throw new Error('ORDER_NOT_AWAITING_CONFIRMATION');
    }
    await audit(tx, message.operator_id, message.id, 'service_order', order.id, 'CONFIRM', 'AGUARDANDO_CONFIRMACAO', 'CONFIRMADA');
    for (const item of items) {
      await tx.$queryRawUnsafe(
        'UPDATE inventory_items SET quantity=quantity-$2::numeric WHERE id=$1::uuid AND quantity-$2::numeric>=0',
        item.item_id, item.quantity,
      );
      await insertMovement(tx, item.item_id, 'OUT', item.quantity, message.operator_id, message.id, null, orderId);
    }
    await saveState(tx, message.operator_id, null, null, null, replyTo);
    await queueReply(tx, message.operator_id, message.id, replyTo, await confirmationReceipt(tx, orderId), 'confirm');
    return;
  }
  if (await handleBillingStep(tx, message, payload, body, replyTo, cfg)) return;
  throw new Error(`UNKNOWN_PENDING_ACTION:${message.pending_action}`);
}
