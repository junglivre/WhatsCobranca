import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL must identify the migrated, disposable PostgreSQL test database');
assert.match(new URL(databaseUrl).pathname, /test/i, 'Refusing to reset a database without test in its name');

const settings = {
  DATABASE_URL: databaseUrl,
  WAHA_WEBHOOK_SECRET: 'integration-webhook-secret-not-for-production',
  AUTOMATION_TOKEN: 'integration-automation-token-not-for-production',
  WAHA_API_KEY: 'integration-local-provider-key',
  WAHA_SESSION: 'default',
  OPERATOR_LID: '00000000000000@lid',
  OPERATOR_PHONE: '5511999999999@c.us',
  GROQ_API_KEY: 'verify-isolated-key',
  GROQ_STT_MODEL: 'whisper-large-v3',
  GROQ_LLM_MODEL: 'llama-3.3-70b-versatile',
  WAHA_MEDIA_MAX_BYTES: '16777216',
  PORT: '8080', // Config requires a positive port; listen({ port: 0 }) selects the actual test port.
};
Object.assign(process.env, settings);

type Delivery = { session: string; chatId: string; text: string; providerId: string };
type DeliveryMode = 'accept' | 'reject400' | 'reject503' | 'lose-response';
type Payload = { id: string; timestamp: number; from: string; fromMe: boolean; body: string | null; hasMedia: boolean; media?: { url?: string; filename: string | null; mimetype: string } };
type Envelope = { id: string; timestamp: number; session: string; event: string; engine: string; payload: Payload };
type Order = { id: string; number: number; customer_id: string; description: string; amount_cents: number | null; due_date: Date | null; status: string; confirmed_at: Date | null };
type State = { pending_action: string | null; payload: Record<string, unknown> | null; service_order_id: string | null; expires_at: Date | null; updated_at: Date };
type Outbound = { id: string; body: string; status: string; attempts: number; provider_message_id: string | null; last_error: string | null; reply_to: string };
type Audit = { action: string; entity_type: string; entity_id: string; actor_id: string; source_message_id: string; previous_status: string | null; new_status: string | null; reason: string | null };

const prisma = new PrismaClient();
const deliveries: Delivery[] = [];
const providerAttempts: Array<{ mode: DeliveryMode; message: Omit<Delivery, 'providerId'> }> = [];
let deliveryMode: DeliveryMode = 'accept';
let nextProviderId = 0;
const providerErrors: unknown[] = [];
// Mirrors scripts/test-waha-server.mjs GET /api/files/:sessionId/:fileId so the
// media flow runs against the same WAHA_BASE_URL used for sendText deliveries.
const mediaDownloads: Array<{ path: string; bytes: number }> = [];
const oggScaffold = Buffer.alloc(10 * 1024);
Buffer.from('OggS', 'binary').copy(oggScaffold, 0);
const oversizeMedia = Buffer.alloc(200 * 1024, 0x61);
Buffer.from('OggS', 'binary').copy(oversizeMedia, 0);
const provider = http.createServer((request, response) => {
  const fileMatch = /^\/api\/files\/([^/]+)\/([^/]+?)(\.[a-z0-9]+)?$/i.exec(request.url ?? '');
  if (request.method === 'GET' && fileMatch) {
    if (request.headers['x-api-key'] !== settings.WAHA_API_KEY) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid test key' }));
      return;
    }
    const fileId = fileMatch[2]!;
    const media = fileId.startsWith('oversize') ? oversizeMedia : oggScaffold;
    mediaDownloads.push({ path: request.url!, bytes: media.length });
    response.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': String(media.length) });
    response.end(media);
    return;
  }
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk: string) => { raw += chunk; });
  request.on('end', () => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/sendText');
      assert.equal(request.headers['x-api-key'], settings.WAHA_API_KEY);
      const message = JSON.parse(raw) as Omit<Delivery, 'providerId'>;
      assert.equal(message.session, settings.WAHA_SESSION);
      assert.ok([settings.OPERATOR_LID, settings.OPERATOR_PHONE].includes(message.chatId));
      assert.equal(typeof message.text, 'string');
      providerAttempts.push({ mode: deliveryMode, message });
      if (deliveryMode === 'reject400' || deliveryMode === 'reject503') {
        response.writeHead(deliveryMode === 'reject400' ? 400 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'planned test rejection before delivery' }));
        return;
      }
      const providerId = `noweb-message-${++nextProviderId}`;
      deliveries.push({ ...message, providerId });
      if (deliveryMode === 'lose-response') {
        request.socket.destroy(); // Provider accepted the message, but its acknowledgement was lost.
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ key: { id: providerId, remoteJid: message.chatId, fromMe: true } }));
    } catch (error) {
      providerErrors.push(error);
      response.writeHead(500).end();
    }
  });
});

// The test owns the only provider URL used by every application instance.
let app: FastifyInstance | undefined;
let baseUrl = '';
let providerUrl = '';
let serial = 0;
const id = (label: string) => `${label}-${++serial}`;
const envelope = (messageId: string, body: string | null, extra: Partial<Payload> = {}): Envelope => ({
  id: `envelope-${messageId}`, timestamp: 1793763818, session: settings.WAHA_SESSION, event: 'message', engine: 'NOWEB',
  payload: { id: messageId, timestamp: 1793763818, from: settings.OPERATOR_LID, fromMe: false, body, hasMedia: false, ...extra },
});
// Real NOWEB voice note: body=null and media carries an absolute public url whose
// PATH the core must re-prefix with WAHA_BASE_URL (never fetching the public host).
const audioMedia = (messageId: string, opts: { mimetype?: string; url?: string; omitUrl?: boolean } = {}): Partial<Payload> => ({
  hasMedia: true,
  media: {
    ...(opts.omitUrl ? {} : { url: opts.url ?? `http://waha-test:8090/api/files/${settings.WAHA_SESSION}/${messageId}.oga` }),
    filename: null,
    mimetype: opts.mimetype ?? 'audio/ogg',
  },
});
const signature = (raw: string) => crypto.createHmac('sha512', settings.WAHA_WEBHOOK_SECRET).update(raw).digest('hex');

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  return { status: response.status, text };
}
async function postRaw(raw: string, hmac = signature(raw)) {
  return request('/webhooks/waha', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-hmac': hmac }, body: raw });
}
async function ingest(messageId: string, body: string | null, extra: Partial<Payload> = {}) {
  const response = await postRaw(JSON.stringify(envelope(messageId, body, extra)));
  assert.equal(response.status, 200, response.text);
}
async function tick() {
  const response = await request('/automation/tick', { method: 'POST', headers: { authorization: `Bearer ${settings.AUTOMATION_TOKEN}` } });
  assert.equal(response.status, 200, response.text);
}
async function outbounds(messageId: string): Promise<Outbound[]> {
  return prisma.$queryRawUnsafe<Outbound[]>(
    `SELECT o.id, o.body, o.status, o.attempts, o.provider_message_id, o.last_error, o.reply_to
       FROM outbound_messages o JOIN messages m ON m.id=o.correlation_message_id WHERE m.message_id=$1`, messageId,
  );
}
async function reply(messageId: string, expectedAttempts = 1): Promise<string> {
  const rows = await outbounds(messageId);
  assert.equal(rows.length, 1, `Exactly one reply must be correlated to ${messageId}`);
  const row = rows[0]!;
  assert.equal(row.status, 'SENT', `Reply to ${messageId}: ${row.last_error}`);
  assert.equal(row.attempts, expectedAttempts, `Unexpected delivery attempts for ${messageId}`);
  const delivered = deliveries.filter((delivery) => delivery.providerId === row.provider_message_id);
  assert.equal(delivered.length, 1, `Persist the actual NOWEB key.id for ${messageId}`);
  assert.equal(delivered[0]!.text, row.body);
  assert.equal(delivered[0]!.chatId, row.reply_to);
  return row.body;
}
async function inbound(body: string, extra: Partial<Payload> = {}): Promise<{ id: string; text: string }> {
  const messageId = id('inbound');
  await ingest(messageId, body, extra);
  await tick();
  return { id: messageId, text: await reply(messageId) };
}
async function states(): Promise<State[]> {
  // 'states' significa pendências ATIVAS: a linha do operador persiste com
  // pending_action NULL após qualquer interação (upsert, nunca delete).
  return prisma.$queryRawUnsafe<State[]>(
    'SELECT pending_action, payload, service_order_id, expires_at, updated_at FROM conversation_states WHERE pending_action IS NOT NULL ORDER BY operator_id',
  );
}
async function pending(action: string | null): Promise<State> {
  const rows = await states();
  if (action === null) {
    assert.equal(rows.length, 0, 'no active pending operation expected');
    return { pending_action: null, payload: null, service_order_id: null, expires_at: null, updated_at: new Date() };
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.pending_action, action);
  return rows[0]!;
}
async function orders(): Promise<Order[]> {
  return prisma.$queryRawUnsafe<Order[]>(
    'SELECT id, number, customer_id, description, amount_cents, due_date, status, confirmed_at FROM service_orders ORDER BY number',
  );
}
async function audioColumns(messageId: string): Promise<{ transcription: string | null; media_mimetype: string | null; media_path: string | null }> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ transcription: string | null; media_mimetype: string | null; media_path: string | null }>>(
    'SELECT transcription, media_mimetype, media_path FROM messages WHERE message_id=$1', messageId,
  );
  return row!;
}
async function eventRow(messageId: string): Promise<{ state: string; attempts: number }> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ state: string; attempts: number }>>(
    'SELECT state, attempts FROM webhook_events WHERE message_id=$1', messageId,
  );
  return row!;
}
async function audits(messageId: string): Promise<Audit[]> {
  return prisma.$queryRawUnsafe<Audit[]>(
    `SELECT a.action, a.entity_type, a.entity_id, a.actor_id, a.source_message_id, a.previous_status, a.new_status, a.reason
       FROM audit_logs a JOIN messages m ON m.id=a.source_message_id WHERE m.message_id=$1 ORDER BY a.entity_type, a.action`, messageId,
  );
}
async function counts() {
  const [row] = await prisma.$queryRawUnsafe<Array<Record<string, number>>>(
    `SELECT (SELECT count(*)::int FROM messages) AS messages,
            (SELECT count(*)::int FROM webhook_events) AS events,
            (SELECT count(*)::int FROM conversation_states) AS conversations,
            (SELECT count(*)::int FROM customers) AS customers,
            (SELECT count(*)::int FROM service_orders) AS orders,
            (SELECT count(*)::int FROM outbound_messages) AS outbox,
            (SELECT count(*)::int FROM audit_logs) AS audits`,
  );
  return row!;
}
async function seedCustomer(name: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    'INSERT INTO customers(name, normalized_name) VALUES($1, $2) RETURNING id',
    name, name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR'),
  );
  return rows[0]!.id;
}
// Quantidades sempre como texto numeric vindo do PostgreSQL (nunca Float em JS):
// '10.000' para 10, '2.500' para 2,5. Comparações exatas são feitas sobre ::text.
type ItemRow = { id: string; name: string; unit: string; quantity: string; min_quantity: string | null; active: boolean };
async function seedItem(name: string, unit: string, quantity: string, minQuantity: string | null = null): Promise<ItemRow> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; unit: string; quantity: string; min_quantity: string | null; active: boolean }>>(
    'INSERT INTO inventory_items(name, normalized_name, unit, quantity, min_quantity) VALUES($1, $2, $3, $4::numeric, $5::numeric) RETURNING id, name, unit, quantity::text AS quantity, min_quantity::text AS min_quantity, active',
    name, name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR'), unit, quantity, minQuantity,
  );
  return rows[0]!;
}
async function itemQuantity(itemId: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ quantity: string }>>(
    'SELECT quantity::text FROM inventory_items WHERE id=$1::uuid', itemId,
  );
  return rows[0]!.quantity;
}
async function seedOrder(description: string, customerName: string): Promise<{ id: string; number: number }> {
  const customerId = await seedCustomer(customerName);
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; number: number }>>(
    "INSERT INTO service_orders(customer_id, description, status) VALUES($1::uuid, $2, 'CONFIRMADA') RETURNING id, number",
    customerId, description,
  );
  return rows[0]!;
}
type MovementRow = {
  movement_type: string;
  quantity: string;
  reason: string | null;
  inventory_item_id: string;
  service_order_id: string | null;
  source_message_id: string | null;
};
async function movements(): Promise<MovementRow[]> {
  return prisma.$queryRawUnsafe<MovementRow[]>(
    `SELECT sm.movement_type, sm.quantity::text AS quantity, sm.reason,
            sm.inventory_item_id::text AS inventory_item_id, sm.service_order_id::text AS service_order_id,
            m.message_id AS source_message_id
       FROM stock_movements sm LEFT JOIN messages m ON m.id=sm.source_message_id
      ORDER BY sm.created_at, sm.id`,
  );
}
async function orderItems(orderId: string): Promise<Array<{ raw_name: string; quantity: string; inventory_item_id: string | null }>> {
  return prisma.$queryRawUnsafe<Array<{ raw_name: string; quantity: string; inventory_item_id: string | null }>>(
    'SELECT raw_name, quantity::text AS quantity, inventory_item_id::text AS inventory_item_id FROM service_order_items WHERE service_order_id=$1::uuid ORDER BY position',
    orderId,
  );
}
async function stockCounts(): Promise<{ items: number; orderItems: number; movements: number }> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ items: number; orderItems: number; movements: number }>>(
    `SELECT (SELECT count(*)::int FROM inventory_items) AS items,
            (SELECT count(*)::int FROM service_order_items) AS "orderItems",
            (SELECT count(*)::int FROM stock_movements) AS movements`,
  );
  return row!;
}
// Fluxo guiado por texto até a pergunta de materiais (valor já aplicado).
async function beginOrderToMaterials(description: string, customerName: string, value: string): Promise<Order> {
  await inbound(description);
  await inbound(customerName);
  // Cliente novo: a oferta de cadastro precisa ser aceita antes do valor.
  await inbound('sim');
  await pending('VALUE');
  const order = (await orders()).find((row) => row.description === description);
  assert.ok(order);
  const asked = await inbound(value);
  assert.match(asked.text, /materiais/i);
  assert.match(asked.text, /2 cabo, 3 disjuntor/);
  await pending('materials');
  return order;
}
async function reset() {
  // Only the disposable *_test database supplied by verify.sh can reach this operation.
  await prisma.$executeRawUnsafe('TRUNCATE audit_logs, outbound_messages, webhook_events, messages, conversation_states, service_order_items, stock_movements, billing_events, charges, invoices, report_deliveries, customer_provider_refs, service_orders, inventory_items, customers');
  await prisma.$executeRawUnsafe('ALTER SEQUENCE service_order_number_seq RESTART WITH 1');
  deliveries.length = 0;
  providerAttempts.length = 0;
  deliveryMode = 'accept';
  mediaDownloads.length = 0;
  asaasReset();
}

// ---------------------------------------------------------------------------
// Groq fake. When GROQ_BASE_URL is injected (compose verify: groq-test:8091,
// scripts/test-groq-server.mjs) the control calls below hit that service over
// HTTP; otherwise this in-process mirror with identical routes is used.
type GroqKind = 'stt' | 'llm';
type GroqMode = 'ok' | 'badjson' | 'hallucinated' | 'timeout' | '500';
type GroqLedgerEntry = { kind: GroqKind; mode: GroqMode; model: string | null; bytes: number; at: string };
type GroqLedger = { modes: Record<GroqKind, GroqMode>; sttQueue: string[]; llmQueue: unknown[]; entries: GroqLedgerEntry[] };
const groqModes: Record<GroqKind, GroqMode> = { stt: 'ok', llm: 'ok' };
const sttQueue: string[] = [];
const llmQueue: Array<Record<string, unknown>> = [];
const groqEntries: GroqLedgerEntry[] = [];
const DEFAULT_STT_TEXT = 'Troca da bomba de agua do poo';
const DEFAULT_LLM = { intent: 'REGISTRAR_SERVICO', customer_name: 'Carlos Pereira', service_description: 'Troca da bomba de agua', service_amount: 150.5, materials_amount: null, due_date: null };
// Schema-invalid on purpose: due_date violates the YYYY-MM-DD contract, so the
// core must fall back to the deterministic guided flow instead of trusting it.
const HALLUCINATED_LLM = { intent: 'REGISTRAR_SERVICO', customer_name: 'Fulano Inventado', service_description: 'Servico que ninguem pediu', service_amount: 999, materials_amount: 1, due_date: 'amanha' };

function parseMultipart(buffer: Buffer, contentType: string | undefined): Record<string, Buffer> | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!match) return null;
  const boundary = `--${(match[1] ?? match[2])!.trim()}`;
  const parts = buffer.toString('binary').split(boundary).slice(1, -1);
  const fields: Record<string, Buffer> = {};
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const name = /name="([^"]+)"/i.exec(part.slice(0, headerEnd))?.[1];
    if (name) fields[name] = Buffer.from(part.slice(headerEnd + 4), 'binary').subarray(0, -2);
  }
  return fields;
}

const groqReply = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const groqFake = http.createServer((request, response) => {
  const kind: GroqKind | null = request.url === '/audio/transcriptions' ? 'stt' : request.url === '/chat/completions' ? 'llm' : null;
  if (request.method === 'GET' && request.url === '/health') return groqReply(response, 200, { ok: true, modes: groqModes });
  if (request.method === 'GET' && request.url === '/ledger') return groqReply(response, 200, { modes: groqModes, sttQueue, llmQueue, entries: groqEntries });
  if (request.method === 'POST' && request.url === '/reset') {
    groqModes.stt = 'ok';
    groqModes.llm = 'ok';
    sttQueue.length = 0;
    llmQueue.length = 0;
    groqEntries.length = 0;
    return groqReply(response, 200, { ok: true });
  }
  if (request.method === 'POST' && request.url === '/scenario') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { mode?: GroqMode; endpoint?: GroqKind; stt?: string | string[]; llm?: Record<string, unknown> | Array<Record<string, unknown>> };
      if (body.mode !== undefined) {
        if (body.endpoint) groqModes[body.endpoint] = body.mode;
        else { groqModes.stt = body.mode; groqModes.llm = body.mode; }
      }
      if (body.stt !== undefined) sttQueue.push(...(Array.isArray(body.stt) ? body.stt : [body.stt]));
      if (body.llm !== undefined) llmQueue.push(...(Array.isArray(body.llm) ? body.llm : [body.llm]));
      groqReply(response, 200, { ok: true, modes: groqModes });
    });
    return;
  }
  if (request.method === 'POST' && kind) {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${settings.GROQ_API_KEY}`) return groqReply(response, 401, { error: 'invalid test key' });
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const mode = groqModes[kind];
      const attempt: GroqLedgerEntry = { kind, mode, model: null, bytes: body.length, at: new Date().toISOString() };
      if (mode === '500') {
        groqEntries.push(attempt);
        return groqReply(response, 500, { error: 'planned test failure' });
      }
      if (mode === 'timeout') {
        groqEntries.push(attempt);
        return setTimeout(() => groqReply(response, 200, kind === 'stt' ? { text: DEFAULT_STT_TEXT } : { choices: [{ message: { content: '{}' } }] }), 120_000).unref();
      }
      let payload: unknown;
      if (kind === 'stt') {
        const fields = parseMultipart(body, request.headers['content-type']);
        if (!fields) return groqReply(response, 400, { error: 'expected multipart/form-data' });
        attempt.model = fields.model?.toString() ?? null;
        if (!attempt.model) return groqReply(response, 400, { error: 'missing multipart field: model' });
        payload = { text: sttQueue.length > 0 ? sttQueue.shift() : DEFAULT_STT_TEXT };
      } else {
        let llmRequest: { model?: string; response_format?: { type?: string } };
        try {
          llmRequest = JSON.parse(body.toString('utf8'));
        } catch {
          return groqReply(response, 400, { error: 'invalid JSON' });
        }
        attempt.model = llmRequest.model ?? null;
        if (!attempt.model) return groqReply(response, 400, { error: 'missing field: model' });
        if (llmRequest.response_format?.type !== 'json_object') return groqReply(response, 400, { error: 'response_format.type must be json_object' });
        const extraction = llmQueue.length > 0 ? llmQueue.shift()! : mode === 'hallucinated' ? HALLUCINATED_LLM : DEFAULT_LLM;
        payload = { choices: [{ message: { role: 'assistant', content: JSON.stringify(extraction) } }] };
      }
      groqEntries.push(attempt);
      if (mode === 'badjson') {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end('{"text": truncated');
      }
      return groqReply(response, 200, payload);
    });
    return;
  }
  groqReply(response, 404, { error: 'not found' });
});

let groqBase = '';
async function groqControl(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${groqBase}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200, `groq control ${path} failed`);
  return response.json();
}
const groqReset = async () => groqControl('/reset', {});
const groqLedger = async () => groqControl('/ledger') as Promise<GroqLedger>;
// ---------------------------------------------------------------------------
// Asaas fake (Fase 6): espelha a API v3 usada pelo adapter — clientes,
// cobranças, pixQrCode e cancelamento — com ledger de chamadas para asserts
// e modo de falha injetável (create-then-500: grava a cobrança mas responde
// 500, simulando timeout/resposta perdida para testar a reconciliação).
const ASAAS_TEST_KEY = 'integration-asaas-key';
const ASAAS_TEST_WEBHOOK_TOKEN = 'integration-asaas-webhook-token';
type AsaasCustomer = { id: string; name: string; externalReference: string; cpfCnpj?: string };
type AsaasPayment = {
  id: string; customer: string; billingType: string; value: number;
  dueDate: string; description: string; externalReference: string; status: string; deleted: boolean;
};
type AsaasCall = { method: string; path: string; body: unknown };
const asaasCustomers: AsaasCustomer[] = [];
const asaasPayments: AsaasPayment[] = [];
const asaasCalls: AsaasCall[] = [];
let asaasCreateThen500 = false;
// Quando ligado, POST /payments reproduz a rejeição real do sandbox Asaas
// para cliente sem CPF/CNPJ (invalid_object "CPF ou CNPJ do cliente").
let asaasRequireFiscalId = false;
let asaasSeq = 0;
function asaasReset() {
  asaasCustomers.length = 0;
  asaasPayments.length = 0;
  asaasCalls.length = 0;
  asaasCreateThen500 = false;
  asaasRequireFiscalId = false;
  asaasSeq = 0;
}
const asaasReply = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const asaasFake = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://asaas-fake');
  const path = url.pathname;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return asaasReply(response, 400, { error: 'invalid JSON' });
      }
    }
    if (request.headers.access_token !== ASAAS_TEST_KEY) {
      return asaasReply(response, 401, { errors: [{ description: 'invalid access_token' }] });
    }
    asaasCalls.push({ method: request.method ?? '', path: `${path}${url.search}`, body });
    if (request.method === 'GET' && path === '/customers') {
      const externalReference = url.searchParams.get('externalReference');
      return asaasReply(response, 200, { object: 'list', data: asaasCustomers.filter((customer) => customer.externalReference === externalReference) });
    }
    if (request.method === 'POST' && path === '/customers') {
      const input = body as { name: string; externalReference: string; cpfCnpj?: string };
      const customer: AsaasCustomer = {
        id: `cus_test_${++asaasSeq}`, name: input.name, externalReference: input.externalReference,
        ...(input.cpfCnpj ? { cpfCnpj: input.cpfCnpj } : {}),
      };
      asaasCustomers.push(customer);
      return asaasReply(response, 200, { object: 'customer', ...customer });
    }
    const customerMatch = /^\/customers\/([^/]+)$/.exec(path);
    if (request.method === 'PUT' && customerMatch) {
      const customer = asaasCustomers.find((candidate) => candidate.id === customerMatch[1]);
      if (!customer) return asaasReply(response, 404, { errors: [{ description: 'not found' }] });
      const input = body as { name?: string; cpfCnpj?: string; email?: string; mobilePhone?: string };
      if (input.name) customer.name = input.name;
      if (input.cpfCnpj) customer.cpfCnpj = input.cpfCnpj;
      return asaasReply(response, 200, { object: 'customer', ...customer });
    }
    if (request.method === 'POST' && path === '/payments') {
      const input = body as { customer: string; billingType: string; value: number; dueDate: string; description: string; externalReference: string };
      if (asaasRequireFiscalId) {
        const customer = asaasCustomers.find((candidate) => candidate.id === input.customer);
        if (!customer?.cpfCnpj) {
          return asaasReply(response, 400, {
            errors: [{ code: 'invalid_object', description: 'Para criar esta cobrança é necessário preencher o CPF ou CNPJ do cliente.' }],
          });
        }
      }
      const payment: AsaasPayment = {
        id: `pay_test_${++asaasSeq}`, customer: input.customer, billingType: input.billingType,
        value: input.value, dueDate: input.dueDate, description: input.description,
        externalReference: input.externalReference, status: 'PENDING', deleted: false,
      };
      // Resposta perdida: a cobrança EXISTE no provedor, mas o cliente vê 500 —
      // a reconciliação por externalReference precisa adotá-la sem duplicar.
      asaasPayments.push(payment);
      if (asaasCreateThen500) {
        asaasCreateThen500 = false;
        return asaasReply(response, 500, { errors: [{ description: 'planned test failure after persisting' }] });
      }
      return asaasReply(response, 200, { object: 'payment', id: payment.id, status: payment.status });
    }
    if (request.method === 'GET' && path === '/payments') {
      const externalReference = url.searchParams.get('externalReference');
      return asaasReply(response, 200, {
        object: 'list',
        data: asaasPayments.filter((payment) => payment.externalReference === externalReference)
          .map((payment) => ({ id: payment.id, status: payment.deleted ? 'DELETED' : payment.status, value: payment.value })),
      });
    }
    const pixMatch = /^\/payments\/([^/]+)\/pixQrCode$/.exec(path);
    if (request.method === 'GET' && pixMatch) {
      const payment = asaasPayments.find((candidate) => candidate.id === pixMatch[1]);
      if (!payment) return asaasReply(response, 404, { errors: [{ description: 'not found' }] });
      return asaasReply(response, 200, {
        payload: `00020126pix-copia-e-cola-${payment.id}`,
        encodedImage: 'aW1hZ2VtLXBpeC1mYWtl',
        expirationDate: '2026-11-05 23:59:59',
      });
    }
    const paymentMatch = /^\/payments\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && paymentMatch) {
      const payment = asaasPayments.find((candidate) => candidate.id === paymentMatch[1]);
      if (!payment) return asaasReply(response, 404, { errors: [{ description: 'not found' }] });
      return asaasReply(response, 200, { id: payment.id, status: payment.deleted ? 'DELETED' : payment.status, value: payment.value });
    }
    if (request.method === 'DELETE' && paymentMatch) {
      const payment = asaasPayments.find((candidate) => candidate.id === paymentMatch[1]);
      if (!payment) return asaasReply(response, 404, { errors: [{ description: 'not found' }] });
      payment.deleted = true;
      return asaasReply(response, 200, { id: payment.id, deleted: true });
    }
    return asaasReply(response, 404, { errors: [{ description: `unhandled fake route: ${request.method} ${path}` }] });
  });
});
let asaasUrl = '';

async function startApp() {
  // Config is evaluated by buildApp only after the local provider URL is installed.
  app = await buildApp({ WAHA_BASE_URL: providerUrl });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}
// Reinicia a aplicação com variáveis de ambiente extras (ex.: provider asaas).
async function restartAppWith(env: Record<string, string>) {
  Object.assign(process.env, env);
  if (app) await app.close();
  app = undefined;
  await startApp();
}
const asaasEnv = () => ({
  BILLING_PROVIDER: 'asaas',
  ASAAS_API_KEY: ASAAS_TEST_KEY,
  ASAAS_BASE_URL: asaasUrl,
  ASAAS_WEBHOOK_TOKEN: ASAAS_TEST_WEBHOOK_TOKEN,
});
const asaasCallsTo = (method: string, pathPrefix: string) =>
  asaasCalls.filter((call) => call.method === method && call.path.startsWith(pathPrefix));
async function beginKnownOrder(description: string, customerName: string): Promise<Order> {
  await inbound(description);
  await inbound(customerName);
  await pending('VALUE');
  const current = (await orders()).find((order) => order.description === description);
  assert.ok(current);
  assert.equal(current.status, 'AGUARDANDO_DADOS');
  assert.equal(current.amount_cents, null);
  return current;
}

// ===== Helpers Fase 6 (cobrança) =====
type ChargeRow = {
  id: string; service_order_id: string; customer_id: string; provider: string;
  provider_charge_id: string | null; method: string; value_cents: number;
  due_date: string | null; status: string; external_reference: string;
  pix_copy_paste: string | null; pix_qr_url: string | null; paid_value_cents: number | null;
};
async function charges(): Promise<ChargeRow[]> {
  return prisma.$queryRawUnsafe<ChargeRow[]>(
    `SELECT id::text AS id, service_order_id::text AS service_order_id, customer_id::text AS customer_id,
            provider, provider_charge_id, method, value_cents, due_date::text AS due_date, status,
            external_reference, pix_copy_paste, pix_qr_url, paid_value_cents
       FROM charges ORDER BY created_at, id`,
  );
}

// ===== Helpers Fase 7 (emissão fiscal) =====
type InvoiceRow = {
  id: string; service_order_id: string; provider: string; provider_invoice_id: string | null;
  status: string; payload: Record<string, unknown> | null; last_error: string | null;
};
async function invoices(): Promise<InvoiceRow[]> {
  return prisma.$queryRawUnsafe<InvoiceRow[]>(
    `SELECT id::text AS id, service_order_id::text AS service_order_id, provider,
            provider_invoice_id, status, payload, last_error
       FROM invoices ORDER BY created_at, id`,
  );
}
type BillingEventRow = { provider: string; provider_event_id: string; event_type: string; charge_id: string | null; processed: boolean };
async function billingEvents(): Promise<BillingEventRow[]> {
  return prisma.$queryRawUnsafe<BillingEventRow[]>(
    'SELECT provider, provider_event_id, event_type, charge_id::text AS charge_id, processed FROM billing_events ORDER BY position',
  );
}
// Notificações espontâneas do tick (sem mensagem de correlação).
async function notices(): Promise<Outbound[]> {
  return prisma.$queryRawUnsafe<Outbound[]>(
    `SELECT id, body, status, attempts, provider_message_id, last_error, reply_to
       FROM outbound_messages WHERE correlation_message_id IS NULL ORDER BY position`,
  );
}
async function billingWebhook(provider: string, body: unknown, token: string | undefined) {
  return request(`/webhooks/billing/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'asaas-access-token': token }) },
    body: JSON.stringify(body),
  });
}
// Leva uma OS até CONFIRMADA via fluxo guiado por texto (cliente já cadastrado).
// Reusa o cliente se já existir um com esse nome exato (duplicar o seed
// tornaria o match ambíguo → CUSTOMER_CHOOSE).
async function confirmOrder(description: string, customerName: string, value: string): Promise<Order> {
  const normalized = customerName.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
  const existing = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id FROM customers WHERE normalized_name=$1', normalized,
  );
  if (!existing[0]) await seedCustomer(customerName);
  await inbound(description);
  await inbound(customerName);
  await pending('VALUE');
  await inbound(value);
  await pending('materials');
  await inbound('não');
  await pending('CONFIRM');
  const confirmed = await inbound('sim');
  assert.match(confirmed.text, /confirmada/i);
  await pending(null);
  const order = (await orders()).find((row) => row.description === description);
  assert.ok(order, `order ${description} must exist`);
  assert.equal(order.status, 'CONFIRMADA');
  return order;
}
// 'cobrar OS <n> pix <vencimento>' + 'sim' — retorna o resumo e a resposta final.
async function cobrarPixConfirm(osNumber: number, due = '10/11/2026') {
  const summary = await inbound(`cobrar OS ${osNumber} pix ${due}`);
  const done = await inbound('sim');
  await pending(null);
  return { summary, done };
}

const scenarios: Array<[string, () => Promise<void>]> = [
  ['HTTP authentication, envelope validation and literal operator allowlist', async () => {
    assert.deepEqual(await counts(), { messages: 0, events: 0, conversations: 0, customers: 0, orders: 0, outbox: 0, audits: 0 });
    assert.deepEqual(JSON.parse((await request('/health')).text), { ok: true });
    const raw = JSON.stringify(envelope('bad-hmac', 'novo'));
    for (const hmac of ['0'.repeat(128), 'not-hex', crypto.createHmac('sha256', settings.WAHA_WEBHOOK_SECRET).update(raw).digest('hex')]) {
      assert.equal((await postRaw(raw, hmac)).status, 401);
    }
    assert.equal((await request('/webhooks/waha', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status, 401);
    // Phase 4 contract: an HMAC-authenticated but structurally invalid envelope is
    // persisted as webhook_events state='INVALID' and answered with 200 — never a
    // 400, which made WAHA retry-storm and lose real voice notes (body=null bug).
    const structurallyInvalid = [
      '{', 'null', '[]', '{"bad":true}', JSON.stringify({ ...envelope('bad-schema', 'novo'), payload: { id: 1 } }),
      JSON.stringify(envelope('bad-boolean', 'novo', { hasMedia: 'yes' as unknown as boolean })),
      JSON.stringify(envelope('missing-from-me', 'novo', { fromMe: undefined })),
      JSON.stringify(envelope('invalid-from-me', 'novo', { fromMe: 'false' as unknown as boolean }))];
    for (const invalid of structurallyInvalid) {
      assert.equal((await postRaw(invalid)).status, 200, invalid);
    }
    // Raw não-parseável ('{') é respondido com 200 mas não cabe em jsonb.
    const persistableInvalid = structurallyInvalid.filter((candidate) => {
      try { JSON.parse(candidate); return true; } catch { return false; }
    });
    assert.deepEqual(
      await prisma.$queryRawUnsafe<Array<{ state: string; events: number }>>(
        `SELECT state, count(*)::int AS events FROM webhook_events WHERE state='INVALID' GROUP BY state`),
      [{ state: 'INVALID', events: persistableInvalid.length }]);
    assert.equal((await counts()).messages, 0, 'Invalid envelopes must not create messages');
    assert.equal(providerAttempts.length, 0);
    assert.equal((await groqLedger()).entries.length + deliveries.length, 0);
    const ignored = [
      { ...envelope('wrong-session', 'novo'), session: 'OtherSession' },
      envelope('from-me', 'novo', { fromMe: true }),
      envelope('group', 'novo', { from: '123456@g.us' }),
      envelope('unknown-lid', 'novo', { from: '99999999999999@lid' }),
      envelope('unknown-phone', 'novo', { from: '5511988888888@c.us' }),
      envelope('phone-lookalike', 'novo', { from: '5511999999999@lid' }),
    ];
    for (const payload of ignored) assert.equal((await postRaw(JSON.stringify(payload))).status, 200);
    await tick();
    assert.deepEqual(await counts(), { messages: 0, events: persistableInvalid.length, conversations: 0, customers: 0, orders: 0, outbox: 0, audits: 0 });
    assert.equal(providerAttempts.length, 0);

    // Whitespace is deliberate: authentication must use original bytes, not reserialized JSON.
    const spaced = JSON.stringify(envelope('raw-hmac', 'ajuda', { from: settings.OPERATOR_PHONE }), null, 2);
    assert.equal((await postRaw(spaced)).status, 200);
    const beforeUnauthorizedTick = await counts();
    for (const authorization of [undefined, 'Bearer wrong-token']) {
      assert.equal((await request('/automation/tick', { method: 'POST', headers: authorization ? { authorization } : {} })).status, 401);
    }
    assert.deepEqual(await counts(), beforeUnauthorizedTick);
    await tick();
    assert.match(await reply('raw-hmac'), /novo/i);
    assert.equal((await outbounds('raw-hmac'))[0]!.reply_to, settings.OPERATOR_PHONE);
    assert.equal((await states()).length, 0);
  }],
  ['guided creation, exact money, correction and concurrent confirmation deduplication', async () => {
    assert.match((await inbound('novo')).text, /descr/i);
    await pending('DESCRIPTION');
    assert.match((await inbound('Instalar ar condicionado')).text, /nome.*cliente/i);
    assert.equal((await orders()).length, 0);
    assert.match((await inbound('Maria Oliveira')).text, /cadastr/i);
    const missing = await pending('CUSTOMER_CREATE');
    assert.equal(missing.payload?.description, 'Instalar ar condicionado');
    assert.match((await inbound('não')).text, /nome.*cliente/i);
    const backToName = await pending('CUSTOMER_NAME');
    assert.equal(backToName.payload?.description, 'Instalar ar condicionado');
    assert.equal((await counts()).customers, 0);
    await inbound('Maria Oliveira');
    const created = await inbound('sim');
    assert.match(created.text, /valor/i);
    assert.deepEqual((await audits(created.id)).map((audit) => [audit.entity_type, audit.action]), [['customer', 'CREATE'], ['service_order', 'CREATE']]);
    const [order] = await orders();
    assert.ok(order);
    assert.equal(order.description, 'Instalar ar condicionado');
    assert.equal(order.amount_cents, null);
    assert.equal(order.status, 'AGUARDANDO_DADOS');
    const stateBeforeInvalid = await states();
    for (const invalid of ['-1', '150,005', '1.500', '1,000.00', 'Infinity', 'NaN', '1e2', '21474836,48', '999999999999999999999999999999999999']) {
      const rejected = await inbound(invalid);
      assert.match(rejected.text, /inválido|invalido/i);
      assert.deepEqual(await states(), stateBeforeInvalid, `Invalid money must preserve the pending operation: ${invalid}`);
      assert.equal((await orders())[0]!.amount_cents, null);
      assert.equal((await audits(rejected.id)).length, 0);
    }
    // Fase 5: responder o valor pergunta materiais; 'não' fecha o draft vazio e traz o resumo.
    await inbound('0');
    const zero = await inbound('não');
    assert.match(zero.text, /R\$ 0,00/);
    assert.equal((await orders())[0]!.amount_cents, 0);
    await pending('CONFIRM');
    for (const [value, cents] of [['150', 15000], ['150,00', 15000], ['R$ 150', 15000], ['0001,2', 120], ['21474836,47', 2147483647], ['150,37', 15037]] as const) {
      const correction = await inbound(`corrigir valor ${value}`);
      assert.equal((await orders())[0]!.amount_cents, cents);
      assert.equal((await orders())[0]!.id, order.id);
      assert.deepEqual((await audits(correction.id)).map((audit) => audit.action), ['SET_VALUE']);
    }
    const beforeInvalidCorrectionState = await states();
    const beforeInvalidCorrectionOrder = await orders();
    const invalidCorrection = await inbound('corrigir valor 21474836,48');
    assert.match(invalidCorrection.text, /inválido|invalido/i);
    assert.deepEqual(await states(), beforeInvalidCorrectionState);
    assert.deepEqual(await orders(), beforeInvalidCorrectionOrder);
    assert.equal((await audits(invalidCorrection.id)).length, 0);
    const descriptionCorrection = await inbound('corrigir descrição Instalação completa');
    assert.match(descriptionCorrection.text, /Instalação completa/);
    assert.equal((await orders())[0]!.description, 'Instalação completa');
    assert.deepEqual((await audits(descriptionCorrection.id)).map((audit) => audit.action), ['SET_DESCRIPTION']);
    const confirmId = id('duplicate-confirm');
    const confirmation = envelope(confirmId, 'sim');
    const retriedEnvelope = { ...confirmation, id: `${confirmation.id}-redelivery` };
    const responses = await Promise.all([postRaw(JSON.stringify(confirmation)), postRaw(JSON.stringify(retriedEnvelope)), postRaw(JSON.stringify(confirmation))]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
    await Promise.all([tick(), tick(), tick()]);
    await tick();
    assert.match(await reply(confirmId), /confirmada/i);
    const duplicateCounts = await prisma.$queryRawUnsafe<Array<{ messages: number; events: number }>>(
      `SELECT (SELECT count(*)::int FROM messages WHERE message_id=$1) AS messages,
              (SELECT count(*)::int FROM webhook_events WHERE message_id=$1) AS events`, confirmId,
    );
    assert.deepEqual(duplicateCounts, [{ messages: 1, events: 1 }]);
    const confirmAudit = await audits(confirmId);
    assert.equal(confirmAudit.length, 1);
    assert.equal(confirmAudit[0]!.action, 'CONFIRM');
    assert.equal(confirmAudit[0]!.entity_id, order.id);
    assert.equal(confirmAudit[0]!.previous_status, 'AGUARDANDO_CONFIRMACAO');
    assert.equal(confirmAudit[0]!.new_status, 'CONFIRMADA');
    const [actor] = await prisma.$queryRawUnsafe<Array<{ operator_id: string; id: string }>>('SELECT operator_id, id FROM messages WHERE message_id=$1', confirmId);
    assert.equal(confirmAudit[0]!.actor_id, actor!.operator_id);
    assert.equal(confirmAudit[0]!.source_message_id, actor!.id);
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    assert.ok((await orders())[0]!.confirmed_at instanceof Date);
    await pending(null);
    const beforeSecondYes = await orders();
    const secondYes = await inbound('sim');
    assert.match(secondYes.text, /não há confirmação|nenhuma confirmação/i);
    assert.deepEqual(await orders(), beforeSecondYes);
    assert.equal((await audits(secondYes.id)).length, 0);
    const query = await inbound(`OS ${order.number}`);
    assert.match(query.text, /CONFIRMADA/);
    assert.match(query.text, /Maria Oliveira/);
    assert.match(query.text, /Instalação completa/);
    assert.match(query.text, /R\$ 150,37/);
    assert.deepEqual(await orders(), beforeSecondYes);
    const beforeClosedCorrection = await states();
    const closedCorrection = await inbound('corrigir valor 99,99');
    assert.equal((await audits(closedCorrection.id)).length, 0);
    assert.deepEqual(await orders(), beforeSecondYes);
    assert.deepEqual(await states(), beforeClosedCorrection, 'A correction without a draft must not start a new service');
  }],
  ['partial case-insensitive customer resolution and query isolation', async () => {
    const missingBeforeConversation = await inbound('mostra as OS do Cliente Ausente');
    assert.match(missingBeforeConversation.text, /não encontr|nenhum|não há/i);
    assert.equal((await states()).length, 0);
    assert.equal((await counts()).customers, 0);
    assert.equal((await orders()).length, 0);
    const anaLima = await seedCustomer('Ana Lima');
    const anaLuz = await seedCustomer('Ana Luz');
    await inbound('Limpeza detalhada');
    const ambiguous = await inbound('aNA');
    assert.match(ambiguous.text, /Ana Lima/);
    assert.match(ambiguous.text, /Ana Luz/);
    const choice = await pending('CUSTOMER_CHOOSE');
    assert.equal(choice.payload?.description, 'Limpeza detalhada');
    const candidates = choice.payload?.candidates as Array<{ id: string; name: string }>;
    assert.deepEqual(new Set(candidates.map((customer) => customer.id)), new Set([anaLima, anaLuz]));
    const beforeInvalidChoice = await states();
    assert.match((await inbound('99')).text, /número|numero/i);
    assert.deepEqual(await states(), beforeInvalidChoice);
    assert.equal((await orders()).length, 0);
    const selected = candidates.findIndex((customer) => customer.id === anaLuz) + 1;
    assert.match((await inbound(String(selected))).text, /valor/i);
    assert.equal((await orders())[0]!.customer_id, anaLuz);
    assert.equal((await orders())[0]!.description, 'Limpeza detalhada');
    await inbound('1,01');
    await inbound('não');
    await inbound('ok');
    const beforeQueries = await orders();
    const beforeQueryState = await states();
    const beforeQueryCustomers = (await counts()).customers;
    const missing = await inbound('mostra as OS do Cliente Que Nao Existe');
    assert.match(missing.text, /não encontr|nenhum|não há/i);
    assert.deepEqual(await states(), beforeQueryState, 'A query miss must not create or alter conversation state');
    assert.equal((await counts()).customers, beforeQueryCustomers);
    assert.deepEqual(await orders(), beforeQueries);
    const partial = await inbound('mostra as OS do nA LuZ');
    assert.match(partial.text, /Ana Luz/);
    assert.match(partial.text, /Limpeza detalhada/);
    assert.deepEqual(await states(), beforeQueryState);
    const many = await inbound('mostra as OS do ANA');
    assert.match(many.text, /Ana Lima/);
    assert.match(many.text, /Ana Luz/);
    const queryChoice = await pending('CUSTOMER_CHOOSE');
    assert.equal(queryChoice.payload?.purpose, 'QUERY');
    const queryCandidates = queryChoice.payload?.candidates as Array<{ id: string }>;
    const queryAnswer = await inbound(String(queryCandidates.findIndex((candidate) => candidate.id === anaLuz) + 1));
    assert.match(queryAnswer.text, /Limpeza detalhada/);
    await pending(null);
    assert.deepEqual(await orders(), beforeQueries);
    assert.equal((await counts()).customers, beforeQueryCustomers);
    const unknown = await inbound('quais atendimentos fiz no mês passado?');
    assert.match(unknown.text, /OS\s+\d+|ajuda|comando|consulte|não reconhe|não entendi/i);
    await pending(null);
    assert.deepEqual(await orders(), beforeQueries);
  }],
  ['all today-query variants use the Sao Paulo calendar day', async () => {
    const customer = await seedCustomer('Cliente Calendário');
    for (const [description, interval] of [
      ['EXCLUDE_PREVIOUS_DAY', "- interval '1 microsecond'"],
      ['INCLUDE_DAY_START', "+ interval '0 seconds'"],
      ['INCLUDE_DAY_END', "+ interval '1 day' - interval '1 microsecond'"],
      ['EXCLUDE_NEXT_DAY', "+ interval '1 day'"],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO service_orders(customer_id, description, amount_cents, status, created_at)
         VALUES($1::uuid, $2, 123, 'CONFIRMADA',
           (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') ${interval}) AT TIME ZONE 'America/Sao_Paulo')`, customer, description,
      );
    }
    for (const query of ['quais atendimentos fiz hoje?', 'quais os atendimentos de hoje?', 'o que fiz hoje?']) {
      const result = await inbound(query);
      assert.match(result.text, /INCLUDE_DAY_START/);
      assert.match(result.text, /INCLUDE_DAY_END/);
      assert.doesNotMatch(result.text, /EXCLUDE_PREVIOUS_DAY|EXCLUDE_NEXT_DAY/);
      assert.equal((await states()).length, 0);
      assert.equal((await audits(result.id)).length, 0);
    }
    assert.equal((await orders()).length, 4);
  }],
  ['media, empty text, expiry and cancellation preserve exact domain state', async () => {
    await seedCustomer('Cliente Estado');
    const expiring = await beginKnownOrder('Atendimento expirado', 'Cliente Estado');
    const beforeUnsupportedState = await states();
    const beforeUnsupportedOrder = await orders();
    for (const [body, extra, reason] of [
      ['legenda de imagem', { hasMedia: true }, 'MEDIA_UNSUPPORTED'],
      ['   ', {}, 'EMPTY_TEXT'],
    ] as const) {
      const unsupported = await inbound(body, extra);
      assert.match(unsupported.text, /texto/i);
      assert.deepEqual(await states(), beforeUnsupportedState);
      assert.deepEqual(await orders(), beforeUnsupportedOrder);
      const rows = await prisma.$queryRawUnsafe<Array<{ skipped_reason: string }>>('SELECT skipped_reason FROM messages WHERE message_id=$1', unsupported.id);
      assert.deepEqual(rows, [{ skipped_reason: reason }]);
      assert.equal((await audits(unsupported.id)).length, 0);
    }
    const correctedDuringCollection = await inbound('corrigir descrição Atendimento ainda pendente');
    assert.match(correctedDuringCollection.text, /valor/i);
    await pending('VALUE');
    assert.equal((await orders())[0]!.description, 'Atendimento ainda pendente');
    assert.equal((await orders())[0]!.amount_cents, null);
    await inbound('10,01');
    await prisma.$executeRawUnsafe("UPDATE conversation_states SET expires_at=now()-interval '1 second' WHERE service_order_id=$1::uuid", expiring.id);
    const expiredOrder = await orders();
    const late = await inbound('sim');
    assert.match(late.text, /expir/i);
    assert.deepEqual(await orders(), expiredOrder);
    assert.equal((await audits(late.id)).length, 0);
    await pending(null);
    const consult = await inbound(`OS ${expiring.number}`);
    assert.match(consult.text, /AGUARDANDO_CONFIRMACAO/);
    const cancelOrder = await beginKnownOrder('Atendimento cancelado', 'Cliente Estado');
    await inbound('22');
    const cancellation = await inbound('cancelar');
    assert.match(cancellation.text, /cancelad/i);
    const cancelled = (await orders()).find((order) => order.id === cancelOrder.id)!;
    assert.equal(cancelled.status, 'CANCELADA');
    assert.equal(cancelled.amount_cents, 2200);
    const cancellationAudit = await audits(cancellation.id);
    assert.equal(cancellationAudit.length, 1);
    assert.equal(cancellationAudit[0]!.action, 'CANCEL');
    assert.equal(cancellationAudit[0]!.entity_id, cancelOrder.id);
    assert.equal(cancellationAudit[0]!.previous_status, 'AGUARDANDO_CONFIRMACAO');
    assert.equal(cancellationAudit[0]!.new_status, 'CANCELADA');
    assert.match(cancellationAudit[0]!.reason ?? '', /cancel/i);
    await pending(null);
    const afterCancel = await orders();
    await inbound('sim');
    assert.deepEqual(await orders(), afterCancel);
  }],
  ['rapid distinct messages stay FIFO under concurrent ticks and operator aliases', async () => {
    const customerId = await seedCustomer('Cliente Fluxo');
    const input = [
      [id('fifo-description'), 'Revisão FIFO', settings.OPERATOR_LID],
      [id('fifo-customer'), 'Cliente Fluxo', settings.OPERATOR_PHONE],
      [id('fifo-value'), '123,45', settings.OPERATOR_LID],
      [id('fifo-materials'), 'não', settings.OPERATOR_PHONE],
      [id('fifo-confirm'), 'confirmo', settings.OPERATOR_LID],
    ] as const;
    // Persist the intended ordering; concurrent consumers, not network arrival races, are under test.
    for (const [messageId, body, from] of input) await ingest(messageId, body, { from });
    await Promise.all([tick(), tick(), tick(), tick(), tick()]);
    await tick();
    const rows = await orders();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.customer_id, customerId);
    assert.equal(rows[0]!.description, 'Revisão FIFO');
    assert.equal(rows[0]!.amount_cents, 12345);
    assert.equal(rows[0]!.status, 'CONFIRMADA');
    await pending(null);
    const expectedProviderIds: string[] = [];
    for (const [messageId] of input) {
      await reply(messageId);
      expectedProviderIds.push((await outbounds(messageId))[0]!.provider_message_id!);
    }
    assert.deepEqual(deliveries.map((delivery) => delivery.providerId), expectedProviderIds);
    assert.deepEqual((await audits(input[0][0])).map((audit) => audit.action), []);
    assert.deepEqual((await audits(input[1][0])).map((audit) => audit.action), ['CREATE']);
    assert.deepEqual((await audits(input[2][0])).map((audit) => audit.action), ['SET_VALUE']);
    assert.deepEqual((await audits(input[3][0])).map((audit) => audit.action), [], 'closing an empty materials draft audits nothing');
    assert.deepEqual((await audits(input[4][0])).map((audit) => audit.action), ['CONFIRM']);
    const inbox = await prisma.$queryRawUnsafe<Array<{ state: string; attempts: number; last_error: string | null }>>('SELECT state, attempts, last_error FROM webhook_events ORDER BY created_at');
    assert.deepEqual(inbox, input.map(() => ({ state: 'PROCESSED', attempts: 0, last_error: null })));
    assert.equal(providerAttempts.length, 5);
  }],
  ['restart resumes persisted draft and inbox without duplicate effects', async () => {
    const customerId = await seedCustomer('Cliente Reinício');
    await inbound('Manutenção persistente');
    const beforeRestart = await states();
    const messageId = id('restart-customer');
    await ingest(messageId, 'Cliente Reinício');
    const [eventBefore] = await prisma.$queryRawUnsafe<Array<{ state: string }>>('SELECT state FROM webhook_events WHERE message_id=$1', messageId);
    assert.equal(eventBefore!.state, 'PENDING');
    assert.equal((await outbounds(messageId)).length, 0);
    await app!.close();
    app = undefined;
    await startApp();
    assert.deepEqual(await states(), beforeRestart);
    await tick();
    assert.match(await reply(messageId), /valor/i);
    assert.equal((await orders()).length, 1);
    assert.equal((await orders())[0]!.customer_id, customerId);
    assert.equal((await orders())[0]!.description, 'Manutenção persistente');
    await inbound('0,01');
    await inbound('não');
    await inbound('sim');
    assert.equal((await orders())[0]!.amount_cents, 1);
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    const deliveredBefore = providerAttempts.length;
    await app!.close();
    app = undefined;
    await startApp();
    await ingest(messageId, 'Cliente Reinício');
    await tick();
    assert.equal(providerAttempts.length, deliveredBefore);
    assert.equal((await orders()).length, 1);
    assert.deepEqual((await audits(messageId)).map((audit) => audit.action), ['CREATE']);
  }],
  ['a rejected send resumes from the persistent outbox after restart', async () => {
    deliveryMode = 'reject503';
    const messageId = id('retry-after-restart');
    await ingest(messageId, 'ajuda');
    await tick();
    const [rejected] = await outbounds(messageId);
    assert.ok(rejected);
    assert.equal(rejected.status, 'PENDING');
    assert.equal(rejected.attempts, 1);
    assert.equal(rejected.provider_message_id, null);
    assert.match(rejected.last_error ?? '', /503/);
    assert.equal(deliveries.length, 0);
    await app!.close();
    app = undefined;
    deliveryMode = 'accept';
    await startApp();
    await tick();
    assert.match(await reply(messageId, 2), /novo/i);
    assert.equal((await outbounds(messageId))[0]!.id, rejected.id);
    assert.equal(providerAttempts.length, 2);
    assert.equal(deliveries.length, 1);
    await tick();
    assert.equal(providerAttempts.length, 2);
  }],
  ['an expired delivery lease is UNCERTAIN rather than retried after restart', async () => {
    deliveryMode = 'reject503';
    const messageId = id('expired-lease');
    await ingest(messageId, 'ajuda');
    await tick();
    const [outbound] = await outbounds(messageId);
    assert.ok(outbound);
    assert.equal(outbound.status, 'PENDING');
    await prisma.$executeRawUnsafe(
      "UPDATE outbound_messages SET status='LEASED', lease_until=now()-interval '1 second' WHERE id=$1::uuid", outbound.id,
    );
    await app!.close();
    app = undefined;
    deliveryMode = 'accept';
    await startApp();
    await tick();
    const [recovered] = await outbounds(messageId);
    assert.equal(recovered!.status, 'UNCERTAIN');
    assert.equal(recovered!.attempts, 1);
    assert.equal(recovered!.provider_message_id, null);
    assert.equal(providerAttempts.length, 1);
    assert.equal(deliveries.length, 0);
    await tick();
    assert.equal(providerAttempts.length, 1);
  }],
  ['audio happy path: STT, LLM extraction, cadastro, due_date and confirmation', async () => {
    await groqControl('/scenario', { stt: 'Troca da bomba de agua do poo', llm: { intent: 'REGISTRAR_SERVICO', customer_name: 'Carlos Pereira', service_description: 'Troca da bomba de agua', service_amount: 150.5, materials_amount: null, due_date: '2026-11-10' } });
    const audioId = id('audio-happy');
    await ingest(audioId, null, audioMedia(audioId));
    await tick();
    const offered = await reply(audioId);
    assert.match(offered, /cadastr/i);
    const create = await pending('CUSTOMER_CREATE');
    assert.equal(create.payload?.description, 'Troca da bomba de agua');
    const audio = await audioColumns(audioId);
    assert.equal(audio.transcription, 'Troca da bomba de agua do poo');
    assert.equal(audio.media_mimetype, 'audio/ogg');
    assert.equal(audio.media_path, `/api/files/${settings.WAHA_SESSION}/${audioId}.oga`);
    assert.deepEqual(mediaDownloads.map((download) => download.path), [`/api/files/${settings.WAHA_SESSION}/${audioId}.oga`]);
    const created = await inbound('sim');
    assert.match(created.text, /R\$ 150,50/);
    assert.match(created.text, /Vence: 10\/11\/2026/);
    assert.match(created.text, /Carlos Pereira/);
    const [order] = await orders();
    assert.equal(order.description, 'Troca da bomba de agua');
    assert.equal(order.amount_cents, 15050);
    assert.equal(order.due_date instanceof Date ? order.due_date.toISOString().slice(0, 10) : order.due_date, '2026-11-10');
    assert.equal(order.status, 'AGUARDANDO_CONFIRMACAO');
    assert.deepEqual(await audits(created.id).then((rows) => rows.map((row) => [row.entity_type, row.action])), [['customer', 'CREATE'], ['service_order', 'CREATE']]);
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    await pending(null);
    const ledger = await groqLedger();
    assert.deepEqual(ledger.entries.filter((entry) => entry.kind === 'stt').map((entry) => entry.model), [settings.GROQ_STT_MODEL]);
    assert.deepEqual(ledger.entries.filter((entry) => entry.kind === 'llm').map((entry) => entry.model), [settings.GROQ_LLM_MODEL]);
    assert.equal(ledger.entries.length, 2);
  }],
  ['ambiguous audio customer lands in CUSTOMER_CHOOSE preserving extraction', async () => {
    const anaLima = await seedCustomer('Ana Lima');
    const anaLuz = await seedCustomer('Ana Luz');
    await groqControl('/scenario', { stt: 'Troca de resistencia do chuveiro', llm: { intent: 'REGISTRAR_SERVICO', customer_name: 'Ana', service_description: 'Troca de resistencia', service_amount: null, materials_amount: null, due_date: '2026-11-12' } });
    const audioId = id('audio-ambiguous');
    await ingest(audioId, null, audioMedia(audioId));
    await tick();
    const choose = await reply(audioId);
    assert.match(choose, /Ana Lima/);
    assert.match(choose, /Ana Luz/);
    const state = await pending('CUSTOMER_CHOOSE');
    assert.equal(state.payload?.description, 'Troca de resistencia');
    const candidates = state.payload?.candidates as Array<{ id: string; name: string }>;
    assert.deepEqual(new Set(candidates.map((customer) => customer.id)), new Set([anaLima, anaLuz]));
    const selected = candidates.findIndex((candidate) => candidate.id === anaLuz) + 1;
    assert.match((await inbound(String(selected))).text, /valor/i);
    assert.equal((await orders()).length, 1);
    assert.equal((await orders())[0]!.customer_id, anaLuz);
    await inbound('80');
    await inbound('não');
    await pending('CONFIRM');
    const summary = (await orders())[0]!;
    assert.equal(summary.status, 'AGUARDANDO_CONFIRMACAO');
    assert.equal(summary.amount_cents, 8000);
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    assert.match(confirmed.text, /Vence: 12\/11\/2026/);
    const confirmedOrder = (await orders())[0]!;
    assert.equal(confirmedOrder.due_date instanceof Date ? confirmedOrder.due_date.toISOString().slice(0, 10) : confirmedOrder.due_date, '2026-11-12');
    assert.equal(confirmedOrder.status, 'CONFIRMADA');
    await pending(null);
  }],
  ['audio without value asks VALUE; audio with value goes straight to confirmation', async () => {
    await seedCustomer('Cliente Audio Valor');
    await groqControl('/scenario', { stt: 'Limpeza da piscina', llm: { intent: 'REGISTRAR_SERVICO', customer_name: 'Cliente Audio Valor', service_description: 'Limpeza da piscina', service_amount: null, materials_amount: null, due_date: null } });
    const withoutValue = id('audio-no-value');
    await ingest(withoutValue, null, audioMedia(withoutValue));
    await tick();
    const asked = await reply(withoutValue);
    assert.match(asked, /valor/i);
    await pending('VALUE');
    assert.equal((await orders())[0]!.description, 'Limpeza da piscina');
    assert.equal((await orders())[0]!.amount_cents, null);
    const first = await inbound('45,90');
    assert.match(first.text, /materiais/i);
    const firstSummary = await inbound('não');
    assert.match(firstSummary.text, /R\$ 45,90/);
    await pending('CONFIRM');
    await inbound('sim');
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    await pending(null);
    // Second voice note carries an amount: no VALUE step and no materials
    // question — the summary comes straight from the LLM extraction.
    // This one also exercises the media fallback (no payload.media.url at all).
    await groqControl('/scenario', { stt: 'Troca de compressor', llm: { intent: 'REGISTRAR_SERVICO', customer_name: 'Cliente Audio Valor', service_description: 'Troca de compressor', service_amount: 300, materials_amount: null, due_date: null } });
    const withValue = id('audio-with-value');
    await ingest(withValue, null, audioMedia(withValue, { omitUrl: true }));
    await tick();
    const summary = await reply(withValue);
    assert.match(summary, /R\$ 300,00/);
    assert.match(summary, /AGUARDANDO_CONFIRMACAO|confirm/i);
    await pending('CONFIRM');
    assert.equal((await orders()).length, 2);
    assert.equal((await orders())[1]!.amount_cents, 30000);
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    await pending(null);
  }],
  ['invalid or hallucinated LLM output falls back to the deterministic guided flow', async () => {
    const transcription = 'Instalacao de ar condicionado na sala';
    await groqControl('/scenario', { stt: transcription });
    await groqControl('/scenario', { mode: 'badjson', endpoint: 'llm' });
    const badJson = id('audio-badjson');
    await ingest(badJson, null, audioMedia(badJson));
    await tick();
    const fallback = await reply(badJson);
    assert.match(fallback, /Ouvi: "Instalacao de ar condicionado na sala"/);
    assert.match(fallback, /nome.*cliente/i);
    const state = await pending('CUSTOMER_NAME');
    assert.equal(state.payload?.description, transcription);
    assert.equal((await orders()).length, 0);
    assert.equal((await counts()).customers, 0);
    // Hallucinated extraction: valid JSON envelope, schema-invalid due_date ('amanha')
    // must be rejected by zod, never invented as an OS field. STT is queued again:
    // the fake provider serves the default text when its queue runs dry.
    await groqControl('/scenario', { stt: transcription, mode: 'hallucinated', endpoint: 'llm' });
    const hallucinated = id('audio-hallucinated');
    await ingest(hallucinated, null, audioMedia(hallucinated));
    await tick();
    const fallbackTwo = await reply(hallucinated);
    assert.match(fallbackTwo, /Ouvi: "Instalacao de ar condicionado na sala"/);
    assert.match(fallbackTwo, /nome.*cliente/i);
    assert.equal((await pending('CUSTOMER_NAME')).payload?.description, transcription);
    assert.equal((await orders()).length, 0);
    // The transcription becomes the description of the normal guided flow.
    await seedCustomer('Cliente Fallback');
    const named = await inbound('Cliente Fallback');
    assert.match(named.text, /valor/i);
    const [order] = await orders();
    assert.equal(order.description, transcription);
    assert.equal(order.status, 'AGUARDANDO_DADOS');
  }],
  ['LLM intent OUTRO answers deterministically and creates nothing', async () => {
    await groqControl('/scenario', { stt: ' Qual o horario de funcionamento?', llm: { intent: 'OUTRO', customer_name: null, service_description: null, service_amount: null, materials_amount: null, due_date: null } });
    const audioId = id('audio-outro');
    await ingest(audioId, null, audioMedia(audioId));
    await tick();
    const answered = await reply(audioId);
    assert.match(answered, /OS|texto|comando|ajuda/i);
    const row = await eventRow(audioId);
    assert.equal(row.state, 'PROCESSED');
    const skipped = await prisma.$queryRawUnsafe<Array<{ skipped_reason: string }>>('SELECT skipped_reason FROM messages WHERE message_id=$1', audioId);
    assert.deepEqual(skipped, [{ skipped_reason: 'AUDIO_INTENT_IGNORED' }]);
    assert.deepEqual(await counts(), { messages: 1, events: 1, conversations: 0, customers: 0, orders: 0, outbox: 1, audits: 0 });
  }],
  ['STT 5xx exhausts bounded inbox retries into a visible FAILED', async () => {
    await groqControl('/scenario', { mode: '500', endpoint: 'stt' });
    const audioId = id('audio-stt-500');
    await ingest(audioId, null, audioMedia(audioId));
    await tick();
    const first = await eventRow(audioId);
    assert.equal(first.state, 'PENDING');
    assert.ok(first.attempts >= 1);
    for (let attempt = 0; attempt < 7; attempt += 1) await tick();
    const exhausted = await eventRow(audioId);
    assert.equal(exhausted.state, 'FAILED');
    assert.equal(exhausted.attempts, 5);
    assert.equal((await groqLedger()).entries.filter((entry) => entry.kind === 'stt').length, 5, 'The provider must receive exactly the bounded attempts');
    assert.equal((await outbounds(audioId)).length, 0);
    assert.equal((await orders()).length, 0);
    assert.equal((await states()).length, 0);
  }],
  ['missing GROQ_API_KEY answers deterministic not-configured without any provider call', async () => {
    await app!.close();
    app = undefined;
    delete process.env.GROQ_API_KEY;
    await startApp();
    const audioId = id('audio-unconfigured');
    await ingest(audioId, null, audioMedia(audioId));
    await tick();
    const answered = await reply(audioId);
    assert.match(answered, /não está configurad|nao esta configurad|não configurad/i);
    const row = await eventRow(audioId);
    assert.equal(row.state, 'PROCESSED');
    const skipped = await prisma.$queryRawUnsafe<Array<{ skipped_reason: string }>>('SELECT skipped_reason FROM messages WHERE message_id=$1', audioId);
    assert.deepEqual(skipped, [{ skipped_reason: 'AUDIO_NOT_CONFIGURED' }]);
    assert.deepEqual((await groqLedger()).entries, []);
    process.env.GROQ_API_KEY = settings.GROQ_API_KEY;
    await app!.close();
    app = undefined;
    await startApp();
  }],
  ['body null without media is EMPTY_TEXT, not a 400 loss', async () => {
    const audioId = id('audio-null-body');
    const response = await postRaw(JSON.stringify(envelope(audioId, null)));
    assert.equal(response.status, 200, 'Regression: the real voice-note bug answered 400 and WAHA dropped the message');
    await tick();
    assert.match(await reply(audioId), /texto/i);
    const row = await eventRow(audioId);
    assert.equal(row.state, 'PROCESSED');
    const skipped = await prisma.$queryRawUnsafe<Array<{ skipped_reason: string }>>('SELECT skipped_reason FROM messages WHERE message_id=$1', audioId);
    assert.deepEqual(skipped, [{ skipped_reason: 'EMPTY_TEXT' }]);
    assert.deepEqual((await groqLedger()).entries, []);
    assert.equal((await states()).length, 0);
  }],
  ['authenticated structurally invalid envelope persists INVALID with 200 and no side effects', async () => {
    const broken = JSON.stringify({ ...envelope('audio-broken', null), payload: { timestamp: 1793763818, from: settings.OPERATOR_LID } });
    assert.equal((await postRaw(broken)).status, 200);
    assert.deepEqual(
      await prisma.$queryRawUnsafe<Array<{ state: string; events: number }>>(
        `SELECT state, count(*)::int AS events FROM webhook_events WHERE state='INVALID' GROUP BY state`),
      [{ state: 'INVALID', events: 1 }]);
    assert.deepEqual(await counts(), { messages: 0, events: 1, conversations: 0, customers: 0, orders: 0, outbox: 0, audits: 0 });
    assert.deepEqual((await groqLedger()).entries, []);
    assert.equal(mediaDownloads.length, 0);
    await tick();
    assert.equal(providerAttempts.length, 0);
    assert.deepEqual(await counts(), { messages: 0, events: 1, conversations: 0, customers: 0, orders: 0, outbox: 0, audits: 0 });
  }],
  ['non-audio media is rejected without any download', async () => {
    const imageId = id('audio-image');
    await ingest(imageId, 'veja a foto', audioMedia(imageId, { mimetype: 'image/jpeg', url: `http://waha-test:8090/api/files/${settings.WAHA_SESSION}/${imageId}.jpg` }));
    await tick();
    assert.match(await reply(imageId), /texto/i);
    const skipped = await prisma.$queryRawUnsafe<Array<{ skipped_reason: string }>>('SELECT skipped_reason FROM messages WHERE message_id=$1', imageId);
    assert.deepEqual(skipped, [{ skipped_reason: 'MEDIA_UNSUPPORTED' }]);
    assert.equal(mediaDownloads.length, 0, 'Non-audio media must not be downloaded');
    assert.deepEqual((await groqLedger()).entries, []);
    assert.equal((await states()).length, 0);
    assert.equal((await orders()).length, 0);
  }],
  ['media above the byte cap rejects AUDIO_TOO_LARGE before any STT call', async () => {
    await app!.close();
    app = undefined;
    process.env.WAHA_MEDIA_MAX_BYTES = '65536';
    await startApp();
    const oversizeId = 'oversize-audio-note';
    await ingest(oversizeId, null, audioMedia(oversizeId));
    await tick();
    const answered = await reply(oversizeId);
    assert.match(answered, /grand|tamanho|limite/i);
    const skipped = await prisma.$queryRawUnsafe<Array<{ skipped_reason: string }>>('SELECT skipped_reason FROM messages WHERE message_id=$1', oversizeId);
    assert.deepEqual(skipped, [{ skipped_reason: 'AUDIO_TOO_LARGE' }]);
    assert.equal(mediaDownloads.length, 1);
    assert.ok(mediaDownloads[0]!.bytes > 65536);
    assert.deepEqual((await groqLedger()).entries, [], 'No STT call may happen after the size cap rejects the media');
    process.env.WAHA_MEDIA_MAX_BYTES = settings.WAHA_MEDIA_MAX_BYTES;
    await app!.close();
    app = undefined;
    await startApp();
  }],
  ['redelivered audio envelope deduplicates transcription and orders', async () => {
    await seedCustomer('Cliente Audio Duplicado');
    await groqControl('/scenario', { stt: 'Reparo do portao eletronico', llm: { intent: 'REGISTRAR_SERVICO', customer_name: 'Cliente Audio Duplicado', service_description: 'Reparo do portao eletronico', service_amount: 120, materials_amount: null, due_date: null } });
    const audioId = id('audio-duplicate');
    const first = JSON.stringify(envelope(audioId, null, audioMedia(audioId)));
    const redelivery = JSON.stringify({ ...envelope(audioId, null, audioMedia(audioId)), id: `${audioId}-redelivery` });
    assert.deepEqual((await Promise.all([postRaw(first), postRaw(redelivery)])).map((response) => response.status), [200, 200]);
    await Promise.all([tick(), tick()]);
    await tick();
    assert.match(await reply(audioId), /R\$ 120,00/);
    const transcriptions = await prisma.$queryRawUnsafe<Array<{ transcription: string | null }>>('SELECT transcription FROM messages WHERE message_id=$1', audioId);
    assert.equal(transcriptions.length, 1);
    assert.equal(transcriptions[0]!.transcription, 'Reparo do portao eletronico');
    assert.equal((await orders()).length, 1);
    const ledger = await groqLedger();
    assert.equal(ledger.entries.filter((entry) => entry.kind === 'stt').length, 1, 'Dedup happens before any provider call');
    assert.equal(ledger.entries.filter((entry) => entry.kind === 'llm').length, 1);
    assert.equal(mediaDownloads.length, 1);
    await inbound('sim');
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    await pending(null);
  }],
  ...(['reject400', 'reject503'] as const).map((mode): [string, () => Promise<void>] => [
    `${mode} has bounded retries and a persistent FAILED ledger`, async () => {
      deliveryMode = mode;
      const messageId = id(mode);
      await ingest(messageId, 'ajuda');
      for (let attempt = 0; attempt < 7; attempt += 1) await tick();
      const rows = await outbounds(messageId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, 'FAILED');
      assert.equal(rows[0]!.attempts, 5);
      assert.equal(rows[0]!.provider_message_id, null);
      assert.match(rows[0]!.last_error ?? '', mode === 'reject400' ? /400/ : /503/);
      assert.equal(providerAttempts.length, 5);
      assert.equal(deliveries.length, 0);
      const beforeRecovery = await outbounds(messageId);
      deliveryMode = 'accept';
      await app!.close();
      app = undefined;
      await startApp();
      await tick();
      assert.deepEqual(await outbounds(messageId), beforeRecovery);
      assert.equal(providerAttempts.length, 5, 'FAILED is terminal, not an endless retry loop');
      const [processed] = await prisma.$queryRawUnsafe<Array<{ state: string }>>('SELECT state FROM webhook_events WHERE message_id=$1', messageId);
      assert.equal(processed!.state, 'PROCESSED');
      assert.equal((await states()).length, 0);
    },
  ]),
  ['lost provider acknowledgement becomes UNCERTAIN and blocks dependent replies across restart', async () => {
    await seedCustomer('Cliente Incerto');
    deliveryMode = 'lose-response';
    const descriptionId = id('uncertain-description');
    await ingest(descriptionId, 'Serviço com entrega incerta');
    await tick();
    const [uncertain] = await outbounds(descriptionId);
    assert.ok(uncertain);
    assert.equal(uncertain.status, 'UNCERTAIN');
    assert.equal(uncertain.attempts, 1);
    assert.equal(uncertain.provider_message_id, null);
    assert.equal(typeof uncertain.last_error, 'string');
    assert.equal(deliveries.length, 1, 'Provider accepted exactly one delivery before dropping its response');
    assert.match(deliveries[0]!.text, /nome.*cliente/i);
    const beforeBlockedState = await states();
    assert.equal(beforeBlockedState[0]!.pending_action, 'CUSTOMER_NAME');
    const dependent = id('blocked-customer');
    await ingest(dependent, 'Cliente Incerto');
    deliveryMode = 'accept';
    await Promise.all([tick(), tick()]);
    await app!.close();
    app = undefined;
    await startApp();
    await tick();
    assert.equal(providerAttempts.length, 1, 'Neither UNCERTAIN nor its dependent question may be resent');
    assert.equal(deliveries.length, 1);
    assert.deepEqual(await states(), beforeBlockedState);
    assert.equal((await orders()).length, 0);
    assert.equal((await outbounds(dependent)).length, 0);
    assert.equal((await audits(dependent)).length, 0);
    const [blocked] = await prisma.$queryRawUnsafe<Array<{ state: string; attempts: number }>>('SELECT state, attempts FROM webhook_events WHERE message_id=$1', dependent);
    assert.deepEqual(blocked, { state: 'PENDING', attempts: 0 });
      assert.deepEqual(await outbounds(descriptionId), [uncertain]);
  }],

  // -------------------------------------------------------------------------
  // Fase 5 — estoque/materiais. Quantidades chegam como texto numeric do
  // PostgreSQL ('2.500'); toda comparação de saldo é SQL, nunca texto de reply.
  // -------------------------------------------------------------------------
  ['material novo guided flow creates item, opening balance movement and audit', async () => {
    assert.deepEqual(await stockCounts(), { items: 0, orderItems: 0, movements: 0 });
    assert.match((await inbound('material novo')).text, /nome/i);
    const nameState = await pending('matNome');
    assert.equal(nameState.payload?.matName, undefined);
    assert.match((await inbound('Cabo Flexível 2,5mm')).text, /unidade/i);
    const unitState = await pending('matUnidade');
    assert.equal(unitState.payload?.matName, 'Cabo Flexível 2,5mm');
    assert.match((await inbound('m')).text, /saldo/i);
    await pending('matSaldo');
    // Quantidade inválida não avança e não muda estado (mensagem determinística).
    const invalid = await inbound('abc');
    assert.match(invalid.text, /Quantidade inválida\. Use, por exemplo, 2 ou 2,5\./);
    const stillSaldo = await pending('matSaldo');
    assert.equal(stillSaldo.payload?.matName, 'Cabo Flexível 2,5mm');
    assert.equal(stillSaldo.payload?.matUnit, 'm');
    assert.deepEqual(await stockCounts(), { items: 0, orderItems: 0, movements: 0 });
    assert.match((await inbound('10')).text, /mínimo/i);
    const saldoState = await pending('matMinimo');
    assert.equal(saldoState.payload?.matSaldo, '10');
    // '-' pula o mínimo opcional (fica NULL).
    const resumed = await inbound('-');
    assert.match(resumed.text, /Cabo Flexível 2,5mm/);
    assert.match(resumed.text, /10 m/);
    assert.match(resumed.text, /—/);
    const confirmState = await pending('MATERIAL_CONFIRM');
    assert.equal(confirmState.payload?.matName, 'Cabo Flexível 2,5mm');
    assert.equal(confirmState.payload?.matSaldo, '10');
    const created = await inbound('sim');
    await pending(null);
    assert.deepEqual(await stockCounts(), { items: 1, orderItems: 0, movements: 1 });
    const items = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; unit: string; quantity: string; min_quantity: string | null; active: boolean }>>(
      'SELECT id, name, unit, quantity::text AS quantity, min_quantity::text AS min_quantity, active FROM inventory_items',
    );
    const item = items[0]!;
    assert.equal(item.name, 'Cabo Flexível 2,5mm');
    assert.equal(item.unit, 'm');
    assert.equal(item.quantity, '10.000', 'numeric must arrive as exact SQL text');
    assert.equal(item.min_quantity, null);
    assert.equal(item.active, true);
    const [movement] = await movements();
    assert.equal(movement.movement_type, 'IN');
    assert.equal(movement.quantity, '10.000');
    assert.equal(movement.reason, 'Saldo inicial');
    assert.equal(movement.inventory_item_id, item.id);
    assert.equal(movement.service_order_id, null);
    assert.equal(movement.source_message_id, created.id);
    assert.ok(
      (await audits(created.id)).some((entry) => entry.action === 'CREATE' && entry.entity_id === item.id),
      'material creation must be audited against the new item',
    );
    const saldoReply = await inbound('saldo cabo');
    assert.match(saldoReply.text, /Cabo Flexível 2,5mm: 10 m/);
    assert.equal(saldoReply.text.includes('mínimo'), false, 'null minimum must not render a minimum part');
    // O upsert da conversation_state mantém a linha do operador com
    // pending_action NULL após limpar — semântica dos cenários legados.
    await pending(null);
    // 'cancelar' aborta o fluxo guiado sem criar nada.
    assert.match((await inbound('material novo')).text, /nome/i);
    await inbound('Parafuso galvanizado');
    await pending('matUnidade');
    const cancelled = await inbound('cancelar');
    assert.match(cancelled.text, /cancelad/i);
    await pending(null);
    assert.deepEqual(await stockCounts(), { items: 1, orderItems: 0, movements: 1 });
  }],
  ['entrada posts balance, rejects missing material and negated or ambiguous drafts', async () => {
    const cabo = await seedItem('Cabo', 'm', '10', '2');
    const okAsk = await inbound('entrada 20 cabo');
    assert.match(okAsk.text, /Entrada de 20 m de Cabo/);
    await pending('MATERIAL_CONFIRM');
    const ok = await inbound('sim');
    assert.match(ok.text, /Saldo: 30 m/);
    await pending(null);
    assert.equal(await itemQuantity(cabo.id), '30.000');
    let ledger = await movements();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.movement_type, 'IN');
    assert.equal(ledger[0]!.quantity, '20.000');
    assert.equal(ledger[0]!.inventory_item_id, cabo.id);
    assert.equal(ledger[0]!.service_order_id, null);
    // Material inexistente responde determinístico e NUNCA cria item.
    const missing = await inbound('entrada 5 parafuso cego');
    assert.match(missing.text, /Não encontrei material "parafuso cego"\./);
    assert.match(missing.text, /material novo/);
    assert.equal((await states()).length, 0);
    assert.deepEqual(await stockCounts(), { items: 1, orderItems: 0, movements: 1 });
    // Quantidade inválida (0) nem abre confirmação.
    const invalid = await inbound('entrada 0 cabo');
    assert.match(invalid.text, /Quantidade inválida\. Use, por exemplo, 2 ou 2,5\./);
    assert.equal((await states()).length, 0);
    assert.equal(await itemQuantity(cabo.id), '30.000');
    // Confirmação negada não altera saldo nem gera movement.
    await inbound('entrada 7 cabo');
    await pending('MATERIAL_CONFIRM');
    const denied = await inbound('não');
    assert.match(denied.text, /cancelad/i);
    await pending(null);
    assert.equal(await itemQuantity(cabo.id), '30.000');
    assert.equal((await movements()).length, 1);
    // Ambígua: disambiguação preserva a quantidade do comando original.
    const solda = await seedItem('Cabo Solda', 'kg', '4');
    const ambiguous = await inbound('entrada 2,5 cabo');
    assert.match(ambiguous.text, /Cabo/);
    assert.match(ambiguous.text, /Cabo Solda/);
    const choose = await pending('AWAITING_DISAMBIGUATION');
    assert.equal(choose.payload?.purpose, 'MATERIAL');
    assert.equal(choose.payload?.name, 'cabo');
    assert.equal(choose.payload?.entryQuantity, '2.5');
    const candidates = choose.payload?.candidates as Array<{ id: string; name: string }>;
    assert.deepEqual(new Set(candidates.map((candidate) => candidate.id)), new Set([cabo.id, solda.id]));
    const selected = candidates.findIndex((candidate) => candidate.id === solda.id) + 1;
    // Escolha em comando de estoque executa a entrada imediatamente.
    const posted = await inbound(String(selected));
    assert.match(posted.text, /Entrada registrada: Cabo Solda \+2,5 kg\. Saldo: 6,5 kg\./);
    await pending(null);
    assert.equal(await itemQuantity(solda.id), '6.500');
    ledger = await movements();
    assert.equal(ledger.length, 2);
    const last = ledger[ledger.length - 1]!;
    assert.equal(last.movement_type, 'IN');
    assert.equal(last.quantity, '2.500');
    assert.equal(last.inventory_item_id, solda.id);
    assert.equal(last.source_message_id, posted.id);
    assert.equal(await itemQuantity(cabo.id), '30.000');
  }],
  ['ajustar moves balance up and down with confirmation and exact delta ledger', async () => {
    const disjuntor = await seedItem('Disjuntor', 'un', '5', '1');
    const missing = await inbound('ajustar torneira para 2');
    assert.match(missing.text, /Não encontrei material "torneira"\./);
    assert.match(missing.text, /material novo/);
    assert.equal((await states()).length, 0);
    assert.deepEqual(await stockCounts(), { items: 1, orderItems: 0, movements: 0 });
    const upAsk = await inbound('ajustar disjuntor para 12');
    assert.match(upAsk.text, /Ajustar Disjuntor de 5 un para 12 un\? Responda sim ou cancelar\./);
    await pending('MATERIAL_CONFIRM');
    const up = await inbound('sim');
    assert.match(up.text, /Ajuste registrado: Disjuntor agora com 12 un \(\+7\)\./);
    await pending(null);
    assert.equal(await itemQuantity(disjuntor.id), '12.000');
    const downAsk = await inbound('ajustar disjuntor para 3');
    assert.match(downAsk.text, /Ajustar Disjuntor de 12 un para 3 un\? Responda sim ou cancelar\./);
    await pending('MATERIAL_CONFIRM');
    const down = await inbound('sim');
    assert.match(down.text, /Ajuste registrado: Disjuntor agora com 3 un \(-9\)\./);
    await pending(null);
    assert.equal(await itemQuantity(disjuntor.id), '3.000');
    // Decimal com vírgula: delta 0,75 e saldo 3,750 exatos no SQL.
    const decimalAsk = await inbound('ajustar disjuntor para 3,75');
    assert.match(decimalAsk.text, /Ajustar Disjuntor de 3 un para 3,75 un/);
    await pending('MATERIAL_CONFIRM');
    const decimal = await inbound('sim');
    assert.match(decimal.text, /Ajuste registrado: Disjuntor agora com 3,75 un \(\+0,75\)\./);
    await pending(null);
    assert.equal(await itemQuantity(disjuntor.id), '3.750');
    const ledger = await movements();
    assert.deepEqual(ledger.map((entry) => [entry.movement_type, entry.quantity, entry.reason]), [
      ['ADJUST', '7.000', 'Ajuste para 12 un'],
      ['ADJUST', '9.000', 'Ajuste para 3 un'],
      ['ADJUST', '0.750', 'Ajuste para 3,75 un'],
    ]);
    // Ajuste para o saldo atual: delta 0 vira no-op determinístico (nunca um
    // movement de quantidade 0, que violaria o CHECK quantity>0).
    const noopAsk = await inbound('ajustar disjuntor para 3,75');
    assert.match(noopAsk.text, /Ajustar Disjuntor de 3,75 un para 3,75 un/);
    await pending('MATERIAL_CONFIRM');
    const noop = await inbound('sim');
    assert.match(noop.text, /Saldo de Disjuntor já é 3,75 un\. Nada a ajustar\./);
    await pending(null);
    assert.equal(await itemQuantity(disjuntor.id), '3.750');
    assert.equal((await movements()).length, 3);
    // 'não' na confirmação do ajuste cancela sem tocar saldo ou ledger.
    await inbound('ajustar disjuntor para 9');
    await pending('MATERIAL_CONFIRM');
    const denied = await inbound('não');
    assert.match(denied.text, /cancelad/i);
    await pending(null);
    assert.equal(await itemQuantity(disjuntor.id), '3.750');
    assert.equal((await movements()).length, 3);
  }],
  ['devolver posts RETURN tied to the OS; unknown OS is rejected deterministically', async () => {
    const fita = await seedItem('Fita Isolante', 'un', '10');
    const order = await seedOrder('Troca de tomada', 'Cliente Devolução');
    const ask = await inbound(`devolver 2 fita OS ${order.number}`);
    assert.match(ask.text, /Devolução de 2 un de Fita Isolante \(OS \d{6}\)\? Responda sim ou cancelar\./);
    await pending('MATERIAL_CONFIRM');
    const posted = await inbound('sim');
    assert.match(posted.text, /Devolução registrada: Fita Isolante \+2 un\. Saldo: 12 un\./);
    await pending(null);
    assert.equal(await itemQuantity(fita.id), '12.000');
    const [movement] = await movements();
    assert.equal(movement.movement_type, 'RETURN');
    assert.equal(movement.quantity, '2.000');
    assert.equal(movement.inventory_item_id, fita.id);
    assert.equal(movement.service_order_id, order.id);
    assert.equal(movement.source_message_id, posted.id);
    // OS inexistente: mensagem determinística, nenhum estado, nenhum movement.
    const missing = await inbound('devolver 1 fita OS 999');
    assert.match(missing.text, /OS não encontrada\./);
    assert.equal((await states()).length, 0);
    assert.equal(await itemQuantity(fita.id), '12.000');
    assert.equal((await movements()).length, 1);
    // OS cancelada também aceita devolução (qualquer status) — devolve para a mesma OS.
    await prisma.$executeRawUnsafe("UPDATE service_orders SET status='CANCELADA' WHERE id=$1::uuid", order.id);
    await inbound(`devolver 1 fita OS ${order.number}`);
    await pending('MATERIAL_CONFIRM');
    await inbound('sim');
    await pending(null);
    const ledger = await movements();
    assert.equal(ledger.length, 2);
    assert.equal(ledger[1]!.movement_type, 'RETURN');
    assert.equal(ledger[1]!.service_order_id, order.id);
    assert.equal(await itemQuantity(fita.id), '13.000');
  }],
  ['saldo and estoque answer from SQL with single, ambiguous and empty results', async () => {
    const empty = await inbound('estoque');
    assert.match(empty.text, /Estoque vazio\./);
    assert.equal((await states()).length, 0);
    const cabo = await seedItem('Cabo', 'm', '10', '2');
    const solda = await seedItem('Cabo Solda', 'kg', '4');
    const disjuntor = await seedItem('Disjuntor', 'un', '5', '1');
    const inactive = await seedItem('Antiga Fita', 'un', '9');
    await prisma.$executeRawUnsafe('UPDATE inventory_items SET active=false WHERE id=$1::uuid', inactive.id);
    const noMatch = await inbound('saldo zinco');
    assert.match(noMatch.text, /Não encontrei material com esse nome: zinco\./);
    assert.equal((await states()).length, 0);
    const single = await inbound('saldo disjuntor');
    assert.match(single.text, /Disjuntor: 5 un \(mínimo 1 un\)/);
    assert.equal((await states()).length, 0);
    // Ambíguo lista TODOS os saldos, sem pedir escolha.
    const ambiguous = await inbound('saldo cabo');
    assert.match(ambiguous.text, /Cabo: 10 m \(mínimo 2 m\)/);
    assert.match(ambiguous.text, /Cabo Solda: 4 kg/);
    assert.equal((await states()).length, 0);
    const listing = await inbound('estoque');
    const caboAt = listing.text.indexOf('Cabo — 10 m');
    const soldaAt = listing.text.indexOf('Cabo Solda — 4 kg');
    const disjuntorAt = listing.text.indexOf('Disjuntor — 5 un');
    assert.ok(caboAt >= 0 && soldaAt > caboAt && disjuntorAt > soldaAt, 'estoque must list active items ordered by name');
    assert.equal(listing.text.includes('Antiga Fita'), false, 'inactive items must not appear in estoque');
    assert.equal((await states()).length, 0);
    assert.deepEqual([cabo.quantity, solda.quantity, disjuntor.quantity], ['10.000', '4.000', '5.000']);
    assert.equal((await movements()).length, 0, 'queries never post movements');
  }],
  ['order with materials: confirm posts one OUT per item and re-confirmation never duplicates', async () => {
    const cabo = await seedItem('Cabo', 'm', '10');
    const disjuntor = await seedItem('Disjuntor', 'un', '5');
    const order = await beginOrderToMaterials('Instalação de quadro', 'Cliente Materiais', '100');
    const ask = await inbound('2.5 cabo, 3 disjuntor');
    assert.match(ask.text, /Materiais: 2,5 Cabo, 3 Disjuntor/);
    await pending('CONFIRM');
    assert.equal((await orders())[0]!.status, 'AGUARDANDO_CONFIRMACAO');
    // Itens nascem na mesma transação do fechamento do draft, antes do resumo.
    assert.deepEqual(await orderItems(order.id), [
      { raw_name: 'cabo', quantity: '2.500', inventory_item_id: cabo.id },
      { raw_name: 'disjuntor', quantity: '3.000', inventory_item_id: disjuntor.id },
    ]);
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    assert.match(confirmed.text, /Materiais: 2,5 Cabo, 3 Disjuntor/);
    await pending(null);
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    assert.deepEqual(await orderItems(order.id), [
      { raw_name: 'cabo', quantity: '2.500', inventory_item_id: cabo.id },
      { raw_name: 'disjuntor', quantity: '3.000', inventory_item_id: disjuntor.id },
    ]);
    const ledger = await movements();
    assert.equal(ledger.length, 2, 'exactly one OUT per item');
    const caboOut = ledger.find((entry) => entry.inventory_item_id === cabo.id)!;
    const disjuntorOut = ledger.find((entry) => entry.inventory_item_id === disjuntor.id)!;
    for (const [entry, quantity] of [[caboOut, '2.500'], [disjuntorOut, '3.000']] as const) {
      assert.equal(entry.movement_type, 'OUT');
      assert.equal(entry.quantity, quantity);
      assert.equal(entry.service_order_id, order.id);
      assert.equal(entry.source_message_id, confirmed.id);
    }
    assert.equal(await itemQuantity(cabo.id), '7.500');
    assert.equal(await itemQuantity(disjuntor.id), '2.000');
    assert.deepEqual((await audits(confirmed.id)).map((entry) => entry.action), ['CONFIRM']);
    // Idempotência da baixa: re-confirmação não duplica movements nem itens.
    const second = await inbound('sim');
    assert.match(second.text, /Não há confirmação pendente/);
    assert.equal((await movements()).length, 2);
    assert.deepEqual(await orderItems(order.id).then((rows) => rows.length), 2);
    assert.equal(await itemQuantity(cabo.id), '7.500');
    assert.equal(await itemQuantity(disjuntor.id), '2.000');
    assert.equal((await audits(second.id)).length, 0);
  }],
  ['insufficient stock blocks CONFIRM deterministically; entrada then sim completes', async () => {
    const rolo = await seedItem('Rolo', 'un', '2');
    const order = await beginOrderToMaterials('Troca de rolo completo', 'Cliente Estoque Baixo', '80');
    await inbound('5 rolo');
    await pending('CONFIRM');
    const blocked = await inbound('sim');
    assert.match(blocked.text, /Estoque insuficiente para confirmar: rolo \(disponível: 2 un\)\./);
    assert.match(blocked.text, /ou ajuste e confirme novamente\./);
    await pending('CONFIRM');
    assert.equal((await orders())[0]!.status, 'AGUARDANDO_CONFIRMACAO', 'state stays awaiting confirmation');
    assert.deepEqual(await orderItems(order.id), [{ raw_name: 'rolo', quantity: '5.000', inventory_item_id: rolo.id }]);
    assert.equal(await itemQuantity(rolo.id), '2.000', 'blocked confirm must not touch the balance');
    assert.equal((await movements()).length, 0);
    // 'entrada' resolve o estoque durante CONFIRM e devolve o resumo da OS:
    // o estado de confirmação sobrevive e o 'sim' seguinte confirma a OS.
    const entradaDuring = await inbound('entrada 4 rolo');
    assert.match(entradaDuring.text, /Entrada de 4 un de Rolo/);
    await pending('MATERIAL_CONFIRM');
    const posted = await inbound('sim');
    assert.match(posted.text, /Entrada registrada: Rolo \+4 un\. Saldo: 6 un\./);
    assert.match(posted.text, /Troca de rolo completo/);
    assert.match(posted.text, /Confirma\? Responda sim ou cancelar\./);
    await pending('CONFIRM');
    assert.equal(await itemQuantity(rolo.id), '6.000');
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    await pending(null);
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    const ledger = await movements();
    assert.equal(ledger.length, 2);
    const out = ledger.find((entry) => entry.movement_type === 'OUT')!;
    assert.equal(out.quantity, '5.000');
    assert.equal(out.service_order_id, order.id);
    assert.equal(await itemQuantity(rolo.id), '1.000');
  }],
  ['unclassified material is quoted in receipt and never posts stock', async () => {
    const cabo = await seedItem('Cabo', 'm', '10');
    const order = await beginOrderToMaterials('Instalação de tela', 'Cliente Pendente', '120');
    const ask = await inbound('2 cabo, 3 tela metalica');
    assert.match(ask.text, /Materiais: 2 Cabo, 3 tela metalica \(pendente de cadastro\)/);
    assert.match(ask.text, /Pendente de cadastro: tela metalica/);
    await pending('CONFIRM');
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    assert.match(confirmed.text, /Pendente de cadastro: tela metalica/);
    await pending(null);
    assert.deepEqual(await orderItems(order.id), [
      { raw_name: 'cabo', quantity: '2.000', inventory_item_id: cabo.id },
      { raw_name: 'tela metalica', quantity: '3.000', inventory_item_id: null },
    ]);
    const ledger = await movements();
    assert.equal(ledger.length, 1, 'unclassified item must not post any movement');
    assert.equal(ledger[0]!.movement_type, 'OUT');
    assert.equal(ledger[0]!.inventory_item_id, cabo.id);
    assert.equal(ledger[0]!.quantity, '2.000');
    assert.equal(await itemQuantity(cabo.id), '8.000');
  }],
  ['audio extraction fills materialsDraft, skips the question; without materials it asks', async () => {
    const cabo = await seedItem('Cabo', 'm', '10');
    await seedCustomer('Cliente Audio Materiais');
    // Entradas inválidas do LLM (nome vazio, quantidade negativa) são descartadas pelo zod.
    await groqControl('/scenario', {
      stt: 'Instalacao de tela de protecao',
      llm: {
        intent: 'REGISTRAR_SERVICO', customer_name: 'Cliente Audio Materiais', service_description: 'Instalacao de tela',
        service_amount: 80, materials_amount: null, due_date: null,
        materials: [{ name: 'cabo', quantity: 2 }, { name: 'tela metalica', quantity: 1 }],
      },
    });
    const audioId = id('audio-materials');
    await ingest(audioId, null, audioMedia(audioId));
    await tick();
    const offered = await reply(audioId);
    assert.match(offered, /Materiais: 2 Cabo, 1 tela metalica \(pendente de cadastro\)/);
    assert.match(offered, /Pendente de cadastro: tela metalica/);
    const state = await pending('CONFIRM');
    const draft = state.payload?.materialsDraft as Array<{ rawName: string; quantity: string }>;
    assert.deepEqual(draft.map((entry) => entry.rawName), ['cabo', 'tela metalica']);
    const order = (await orders())[0]!;
    assert.equal(order.status, 'AGUARDANDO_CONFIRMACAO');
    assert.equal(order.amount_cents, 8000);
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    await pending(null);
    const ledger = await movements();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.movement_type, 'OUT');
    assert.equal(ledger[0]!.inventory_item_id, cabo.id);
    assert.equal(ledger[0]!.quantity, '2.000');
    assert.equal(await itemQuantity(cabo.id), '8.000');
    const ledgerEntries = await groqLedger();
    assert.equal(ledgerEntries.entries.filter((entry) => entry.kind === 'stt').length, 1);
    assert.equal(ledgerEntries.entries.filter((entry) => entry.kind === 'llm').length, 1);
    // Material malformado na extração (quantidade <= 0) invalida a extração
    // INTEIRA — fallback determinístico, igual à regra do due_date.
    await groqControl('/scenario', {
      stt: 'Troca de pecas com material ruim',
      llm: {
        intent: 'REGISTRAR_SERVICO', customer_name: null, service_description: 'Troca de pecas',
        service_amount: null, materials_amount: null, due_date: null,
        materials: [{ name: 'cabo', quantity: -3 }],
      },
    });
    const badMaterialsId = id('audio-bad-materials');
    await ingest(badMaterialsId, null, audioMedia(badMaterialsId));
    await tick();
    const fallback = await reply(badMaterialsId);
    assert.match(fallback, /Ouvi: "Troca de pecas com material ruim"/);
    assert.match(fallback, /não consegui interpretar/i);
    const fallbackState = await pending('CUSTOMER_NAME');
    // Extração rejeitada = nada do LLM é confiável: a TRANSCRIÇÃO inteira
    // vira a descrição do fluxo guiado (contrato da Fase 4).
    assert.equal(fallbackState.payload?.description, 'Troca de pecas com material ruim');
    assert.equal((await orders()).length, 1, 'no order may be created from a rejected extraction');
    await inbound('cancelar');
    await pending(null);
    // Sem materials extraídos E sem valor, o fluxo PERGUNTA materiais na
    // mesma gramática do texto (após responder o valor).
    await seedCustomer('Cliente Audio Sem Materiais');
    await groqControl('/scenario', {
      stt: 'Reparo de portao',
      llm: {
        intent: 'REGISTRAR_SERVICO', customer_name: 'Cliente Audio Sem Materiais', service_description: 'Reparo de portao',
        service_amount: null, materials_amount: null, due_date: null,
      },
    });
    const plainAudioId = id('audio-no-materials');
    await ingest(plainAudioId, null, audioMedia(plainAudioId));
    await tick();
    assert.match(await reply(plainAudioId), /valor/i);
    await pending('VALUE');
    const asked = await inbound('60');
    assert.match(asked.text, /materiais/i);
    assert.match(asked.text, /2 cabo, 3 disjuntor/);
    await pending('materials');
    const declined = await inbound('não');
    assert.match(declined.text, /R\$ 60,00/);
    assert.doesNotMatch(declined.text, /Materiais:/);
    await pending('CONFIRM');
    const plain = await inbound('sim');
    assert.match(plain.text, /confirmada/i);
    await pending(null);
    assert.deepEqual(await stockCounts(), { items: 1, orderItems: 2, movements: 1 });
  }],
  ['malformed materials list re-asks preserving state; corrigir materiais clears the draft', async () => {
    const cabo = await seedItem('Cabo', 'm', '10');
    const disjuntor = await seedItem('Disjuntor', 'un', '5');
    const order = await beginOrderToMaterials('Reforma de quadro', 'Cliente Correção', '100');
    // Segmento sem quantidade re-pergunta com o estado intacto (nada inserido).
    const malformed = await inbound('2 cabo, so cabo');
    assert.match(malformed.text, /Não entendi a lista\. Use "quantidade nome" por item, separado por vírgula\./);
    assert.match(malformed.text, /Ex\.: 2.5 cabo, 3 disjuntor/);
    await pending('materials');
    assert.deepEqual(await orderItems(order.id), []);
    assert.equal((await orders())[0]!.amount_cents, 10000);
    const good = await inbound('2 cabo, 1 disjuntor');
    assert.match(good.text, /Materiais: 2 Cabo, 1 Disjuntor/);
    await pending('CONFIRM');
    assert.equal((await orderItems(order.id)).length, 2);
    // 'corrigir materiais' limpa o draft (itens apagados) e re-pergunta.
    const corrected = await inbound('corrigir materiais');
    assert.match(corrected.text, /materiais/i);
    assert.match(corrected.text, /2 cabo, 3 disjuntor/);
    await pending('materials');
    assert.deepEqual(await orderItems(order.id), [], 'clearing the draft must remove the drafted items');
    const declined = await inbound('não');
    assert.match(declined.text, /Confirma|confirma/);
    assert.doesNotMatch(declined.text, /Materiais:/);
    await pending('CONFIRM');
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    await pending(null);
    assert.deepEqual(await stockCounts(), { items: 2, orderItems: 0, movements: 0 });
    assert.equal(await itemQuantity(cabo.id), '10.000');
    assert.equal(await itemQuantity(disjuntor.id), '5.000');
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
  }],
  ['confirmed orders are immutable: no items, balances or movements change afterwards', async () => {
    const cabo = await seedItem('Cabo', 'm', '10');
    const order = await beginOrderToMaterials('Troca de cabo queimado', 'Cliente Imutável', '90');
    await inbound('1 cabo');
    await pending('CONFIRM');
    const confirmed = await inbound('sim');
    assert.match(confirmed.text, /confirmada/i);
    await pending(null);
    const itemsBefore = await orderItems(order.id);
    assert.equal(await itemQuantity(cabo.id), '9.000');
    assert.equal((await movements()).length, 1);
    // 'corrigir materiais' sem OS em edição não pode reabrir nada.
    const noEdit = await inbound('corrigir materiais');
    assert.match(noEdit.text, /Não há OS em edição/);
    await pending(null);
    // Texto solto pós-confirmação nunca altera itens da OS confirmada.
    const loose = await inbound('2 cabo');
    assert.match(loose.text, /nome do cliente/i);
    await pending('CUSTOMER_NAME');
    assert.deepEqual(await orderItems(order.id), itemsBefore);
    assert.equal(await itemQuantity(cabo.id), '9.000');
    assert.equal((await movements()).length, 1);
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    await inbound('cancelar');
    await pending(null);
    assert.deepEqual(await orderItems(order.id), itemsBefore);
  }],
  ['concurrent messages with a materials answer stay FIFO without reordering stock', async () => {
    const cabo = await seedItem('Cabo', 'm', '10');
    await seedCustomer('Cliente FIFO');
    const input = [
      [id('fifo-mat-description'), 'Troca FIFO com materiais', settings.OPERATOR_LID],
      [id('fifo-mat-customer'), 'Cliente FIFO', settings.OPERATOR_PHONE],
      [id('fifo-mat-value'), '50', settings.OPERATOR_LID],
      [id('fifo-mat-materials'), '2 cabo', settings.OPERATOR_PHONE],
      [id('fifo-mat-confirm'), 'confirmo', settings.OPERATOR_LID],
    ] as const;
    for (const [messageId, body, from] of input) await ingest(messageId, body, { from });
    await Promise.all([tick(), tick(), tick(), tick(), tick()]);
    await tick();
    assert.match(await reply(input[0][0]), /nome do cliente/i);
    assert.match(await reply(input[1][0]), /valor/i);
    assert.match(await reply(input[2][0]), /materiais/i);
    assert.match(await reply(input[3][0]), /Materiais: 2 Cabo/);
    assert.match(await reply(input[4][0]), /confirmada/i);
    const rows = await orders();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'CONFIRMADA');
    assert.equal(rows[0]!.amount_cents, 5000);
    assert.deepEqual(await orderItems(rows[0]!.id), [{ raw_name: 'cabo', quantity: '2.000', inventory_item_id: cabo.id }]);
    const ledger = await movements();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.movement_type, 'OUT');
    assert.equal(ledger[0]!.quantity, '2.000');
    assert.equal(ledger[0]!.service_order_id, rows[0]!.id);
    assert.equal(await itemQuantity(cabo.id), '8.000');
    await pending(null);
  }],
  ['cobrar pix happy path: aprovação, customer sync, pix copia-e-cola e charge PENDING', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Instalar tomada', 'Cliente Pix', '150');
    assert.equal(order.number, 1);
    const summary = await inbound('cobrar OS 1 pix 10/11/2026');
    assert.match(summary.text, /Cobrança Pix de R\$ 150,00 para Cliente Pix \(OS 000001\), vencimento 10\/11\/2026\. Confirma\?/);
    await pending('CHARGE_CONFIRM');
    const done = await inbound('sim');
    await pending(null);
    const charge = (await charges())[0]!;
    assert.match(done.text, /Cobrança criada: OS 000001 · Pix · R\$ 150,00 · vencimento 10\/11\/2026\./);
    assert.match(done.text, /Pix copia-e-cola:\n00020126pix-copia-e-cola-/);
    assert.equal(charge.status, 'PENDING');
    assert.equal(charge.provider, 'asaas');
    assert.equal(charge.method, 'PIX');
    assert.equal(charge.value_cents, 15000);
    assert.equal(charge.external_reference, 'OS-1-C1');
    assert.equal(charge.pix_copy_paste, `00020126pix-copia-e-cola-${charge.provider_charge_id}`);
    assert.equal(charge.pix_qr_url, 'data:image/png;base64,aW1hZ2VtLXBpeC1mYWtl');
    // Customer sync idempotente: uma só criação de cliente no provedor.
    assert.equal(asaasCallsTo('POST', '/customers').length, 1);
    assert.equal(asaasCallsTo('GET', '/customers').length, 1);
    assert.equal(asaasCallsTo('POST', '/payments').length, 1);
    assert.equal(asaasCallsTo('GET', `/payments/${charge.provider_charge_id}/pixQrCode`).length, 1);
    const refs = await prisma.$queryRawUnsafe<Array<{ external_id: string }>>(
      "SELECT external_id FROM customer_provider_refs WHERE provider='asaas'",
    );
    assert.equal(refs.length, 1);
    // Segunda OS: ensureCustomer reusa a referência persistida (nenhum POST novo).
    const second = await confirmOrder('Trocar disjuntor', 'Cliente Pix', '80');
    await cobrarPixConfirm(second.number);
    assert.equal(asaasCallsTo('POST', '/customers').length, 1);
    assert.equal((await charges()).length, 2);
  }],
  ['webhook RECEIVED atualiza para RECEIVED, notifica operador uma vez e deduplica reenvio idêntico', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico webhook', 'Cliente Webhook', '150');
    await cobrarPixConfirm(order.number);
    const charge = (await charges())[0]!;
    const event = { id: 'evt-received-1', event: 'PAYMENT_RECEIVED', payment: { id: charge.provider_charge_id, value: 150 } };
    const accepted = await billingWebhook('asaas', event, ASAAS_TEST_WEBHOOK_TOKEN);
    assert.equal(accepted.status, 200, accepted.text);
    assert.deepEqual(JSON.parse(accepted.text), { accepted: true });
    await tick();
    const updated = (await charges())[0]!;
    assert.equal(updated.status, 'RECEIVED');
    assert.equal(updated.paid_value_cents, 15000);
    const noticesAfterFirst = await notices();
    assert.equal(noticesAfterFirst.length, 1);
    assert.equal(noticesAfterFirst[0]!.status, 'SENT');
    assert.match(noticesAfterFirst[0]!.body, /Cobrança OS 000001 recebida: R\$ 150,00/);
    // Reenvio idêntico: dedup por (provider, provider_event_id) — nada muda.
    assert.equal((await billingWebhook('asaas', event, ASAAS_TEST_WEBHOOK_TOKEN)).status, 200);
    await tick();
    assert.equal((await billingEvents()).length, 1);
    assert.equal((await charges())[0]!.status, 'RECEIVED');
    assert.equal((await notices()).length, 1);
    // Evento NOVO do mesmo tipo para cobrança já RECEIVED: processado, no-op.
    const again = { id: 'evt-received-2', event: 'PAYMENT_RECEIVED', payment: { id: charge.provider_charge_id, value: 150 } };
    assert.equal((await billingWebhook('asaas', again, ASAAS_TEST_WEBHOOK_TOKEN)).status, 200);
    await tick();
    assert.equal((await billingEvents()).length, 2);
    assert.equal((await charges())[0]!.status, 'RECEIVED');
    assert.equal((await notices()).length, 1, 'RECEIVED nunca é rebaixado nem notificado de novo');
  }],
  ['webhook com token inválido recebe 401 e nada persiste', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico token', 'Cliente Token', '150');
    await cobrarPixConfirm(order.number);
    const charge = (await charges())[0]!;
    const event = { id: 'evt-bad-token', event: 'PAYMENT_RECEIVED', payment: { id: charge.provider_charge_id, value: 150 } };
    for (const token of ['wrong-token', '']) {
      const response = await billingWebhook('asaas', event, token);
      assert.equal(response.status, 401, token);
      assert.deepEqual(JSON.parse(response.text), { error: 'invalid_token' });
    }
    assert.equal((await billingWebhook('asaas', event, undefined)).status, 401);
    // Provider divergente do configurado: 404.
    assert.equal((await billingWebhook('manual', event, ASAAS_TEST_WEBHOOK_TOKEN)).status, 404);
    await tick();
    assert.equal((await billingEvents()).length, 0);
    assert.equal((await charges())[0]!.status, 'PENDING');
    assert.equal((await notices()).length, 0);
  }],
  ['webhook de cobrança desconhecida persiste o evento, não quebra e não notifica', async () => {
    await restartAppWith(asaasEnv());
    const event = { id: 'evt-unknown-charge', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_inexistente', value: 42 } };
    assert.equal((await billingWebhook('asaas', event, ASAAS_TEST_WEBHOOK_TOKEN)).status, 200);
    await tick();
    const events = await billingEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event_type, 'RECEIVED');
    assert.equal(events[0]!.processed, true);
    assert.equal(events[0]!.charge_id, null);
    assert.equal((await charges()).length, 0);
    assert.equal((await notices()).length, 0);
    // Evento sem payment.id (ex.: transferência): aceito e ignorado, nada persiste.
    const ignored = await billingWebhook('asaas', { id: 'evt-transfer', event: 'TRANSFER_DONE' }, ASAAS_TEST_WEBHOOK_TOKEN);
    assert.equal(ignored.status, 200);
    assert.deepEqual(JSON.parse(ignored.text), { accepted: true, ignored: true });
    assert.equal((await billingEvents()).length, 1);
  }],
  ['tick marca cobrança vencida como OVERDUE e notifica uma única vez em ticks repetidos', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico vencido', 'Cliente Vencido', '150');
    await cobrarPixConfirm(order.number, '01/01/2020');
    // O sweep roda no mesmo tick que cria a cobrança já vencida: transição
    // PENDING → OVERDUE com exatamente um aviso ao operador.
    const overdue = (await charges())[0]!;
    assert.equal(overdue.status, 'OVERDUE');
    const noticesAfterSweep = await notices();
    assert.equal(noticesAfterSweep.length, 1);
    assert.match(noticesAfterSweep[0]!.body, /Cobrança OS 000001 vencida \(R\$ 150,00, venceu 01\/01\)/);
    await tick();
    await tick();
    assert.equal((await notices()).length, 1, 'ticks repetidos não notificam de novo');
    assert.equal((await charges())[0]!.status, 'OVERDUE');
    // Webhook OVERDUE posterior (mesma transição) também não duplica o aviso.
    const event = { id: 'evt-overdue-1', event: 'PAYMENT_OVERDUE', payment: { id: overdue.provider_charge_id } };
    assert.equal((await billingWebhook('asaas', event, ASAAS_TEST_WEBHOOK_TOKEN)).status, 200);
    await tick();
    assert.equal((await notices()).length, 1);
  }],
  ['recebi com cobrança pendente marca RECEIVED; webhook RECEIVED posterior é no-op', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico recebido', 'Cliente Recebido', '150');
    await cobrarPixConfirm(order.number);
    const confirm = await inbound('recebi OS 1 150 dinheiro');
    assert.match(confirm.text, /Registrar recebimento de R\$ 150,00 da OS 000001 \(dinheiro\)\? Responda sim ou cancelar\./);
    await pending('RECEIPT_CONFIRM');
    const done = await inbound('sim');
    await pending(null);
    assert.match(done.text, /Recebimento registrado: OS 000001, R\$ 150,00 \(dinheiro\)\./);
    const charge = (await charges())[0]!;
    assert.equal(charge.status, 'RECEIVED');
    assert.equal(charge.paid_value_cents, 15000);
    assert.equal((await notices()).length, 0);
    // Webhook RECEIVED posterior do provedor: no-op (não rebaixa, não notifica).
    const event = { id: 'evt-late-received', event: 'PAYMENT_RECEIVED', payment: { id: charge.provider_charge_id, value: 150 } };
    assert.equal((await billingWebhook('asaas', event, ASAAS_TEST_WEBHOOK_TOKEN)).status, 200);
    await tick();
    assert.equal((await charges())[0]!.status, 'RECEIVED');
    assert.equal((await charges())[0]!.paid_value_cents, 15000);
    assert.equal((await notices()).length, 0);
    // Nem webhook OVERDUE rebaixa RECEIVED.
    const lateOverdue = { id: 'evt-late-overdue', event: 'PAYMENT_OVERDUE', payment: { id: charge.provider_charge_id } };
    assert.equal((await billingWebhook('asaas', lateOverdue, ASAAS_TEST_WEBHOOK_TOKEN)).status, 200);
    await tick();
    assert.equal((await charges())[0]!.status, 'RECEIVED');
    assert.equal((await notices()).length, 0);
  }],
  ['recebi sem cobrança cria registro manual RECEIVED (dinheiro e pix externo)', async () => {
    const order = await confirmOrder('Servico externo', 'Cliente Externo', '150');
    const cashConfirm = await inbound(`recebi OS ${order.number} 150`);
    assert.match(cashConfirm.text, /\(dinheiro\)/);
    const cash = await inbound('sim');
    assert.match(cash.text, /Recebimento registrado: OS 000001, R\$ 150,00 \(dinheiro\)\./);
    const pixConfirm = await inbound(`recebi OS ${order.number} 80 pix`);
    assert.match(pixConfirm.text, /Registrar recebimento de R\$ 80,00 da OS 000001 \(pix\)/);
    const pix = await inbound('sim');
    assert.match(pix.text, /Recebimento registrado: OS 000001, R\$ 80,00 \(pix\)\./);
    const rows = await charges();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.provider, 'manual');
    assert.equal(rows[0]!.method, 'CASH');
    assert.equal(rows[0]!.status, 'RECEIVED');
    assert.equal(rows[0]!.paid_value_cents, 15000);
    assert.equal(rows[0]!.external_reference, 'OS-1-C1');
    assert.equal(rows[1]!.method, 'EXTERNAL_PIX');
    assert.equal(rows[1]!.paid_value_cents, 8000);
    assert.equal(rows[1]!.external_reference, 'OS-1-C2');
    assert.match(rows[0]!.provider_charge_id!, /^manual-charge-/);
    assert.equal(asaasCalls.length, 0, 'recebi nunca fala com o provedor de cobrança');
    // Valor inválido e OS inexistente: rejeições determinísticas.
    assert.match((await inbound('recebi OS 1 abc')).text, /Valor inválido/);
    assert.match((await inbound('recebi OS 99 100')).text, /OS não encontrada/);
    assert.match((await inbound('recebi OS 1')).text, /Use: recebi OS/);
    assert.equal((await charges()).length, 2);
  }],
  ['timeout na criação reconcilia por externalReference sem duplicar cobrança no provedor', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico timeout', 'Cliente Timeout', '150');
    asaasCreateThen500 = true; // a cobrança é gravada no provedor, mas a resposta se perde
    const summary = await inbound(`cobrar OS ${order.number} pix 10/11/2026`);
    assert.match(summary.text, /Confirma\?/);
    const done = await inbound('sim');
    assert.match(done.text, /Cobrança criada: OS 000001/);
    assert.match(done.text, /Pix copia-e-cola/);
    // UMA cobrança no provedor: o 500 foi reconciliado via findByExternalReference.
    assert.equal(asaasPayments.length, 1);
    assert.equal(asaasCallsTo('POST', '/payments').length, 1);
    assert.equal(asaasCallsTo('GET', '/payments?externalReference=OS-1-C1').length, 1);
    const charge = (await charges())[0]!;
    assert.equal(charge.status, 'PENDING');
    assert.equal(charge.provider_charge_id, asaasPayments[0]!.id);
    assert.equal(charge.external_reference, 'OS-1-C1');
  }],
  ['cancelar cobrança chama DELETE no provedor e marca CANCELED', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico cancelado', 'Cliente Cancelado', '150');
    await cobrarPixConfirm(order.number);
    const charge = (await charges())[0]!;
    const withoutActive = await inbound(`cancelar cobrança OS ${order.number}`);
    assert.match(withoutActive.text, /Cancelar a cobrança PIX de R\$ 150,00 da OS 000001\? Responda sim ou cancelar\./);
    await pending('CANCEL_CHARGE_CONFIRM');
    const done = await inbound('sim');
    await pending(null);
    assert.match(done.text, /Cobrança da OS 000001 cancelada\./);
    assert.equal((await charges())[0]!.status, 'CANCELED');
    assert.equal(asaasCallsTo('DELETE', `/payments/${charge.provider_charge_id}`).length, 1);
    assert.equal(asaasPayments[0]!.deleted, true);
    // Segunda tentativa: não há mais cobrança ativa.
    assert.match((await inbound(`cancelar cobrança OS ${order.number}`)).text, /Não há cobrança ativa/);
    assert.equal(asaasCallsTo('DELETE', '/payments').length, 1);
  }],
  ['provider none responde determinístico e recebi continua funcionando', async () => {
    // Sem BILLING_PROVIDER no ambiente (padrão 'none').
    const order = await confirmOrder('Servico sem provider', 'Cliente Sem Provider', '150');
    const cobrar = await inbound(`cobrar OS ${order.number} pix`);
    assert.match(cobrar.text, /Cobrança automática não configurada \(BILLING_PROVIDER=none\)\. Use 'recebi OS <n> <valor>' para registrar pagamento externo\./);
    await pending(null);
    assert.equal((await charges()).length, 0);
    assert.match((await inbound('cobrar OS 1')).text, /BILLING_PROVIDER=none/);
    await inbound(`recebi OS ${order.number} 150 dinheiro`);
    const done = await inbound('sim');
    assert.match(done.text, /Recebimento registrado: OS 000001, R\$ 150,00 \(dinheiro\)\./);
    const charge = (await charges())[0]!;
    assert.equal(charge.provider, 'manual');
    assert.equal(charge.status, 'RECEIVED');
  }],
  ['cobrar rejeita OS não confirmada, OS sem valor e OS com cobrança ativa', async () => {
    await restartAppWith(asaasEnv());
    // OS não confirmada (AGUARDANDO_DADOS) — seed direto, sem conversa pendente.
    const pendingCustomerId = await seedCustomer('Cliente Pendente');
    await prisma.$executeRawUnsafe(
      "INSERT INTO service_orders(customer_id, description, status) VALUES($1::uuid, 'Servico pendente', 'AGUARDANDO_DADOS')",
      pendingCustomerId,
    );
    const rejected = await inbound('cobrar OS 1 pix');
    assert.match(rejected.text, /A OS 000001 não está confirmada \(status: AGUARDANDO_DADOS\)/);
    await pending(null);
    assert.equal((await charges()).length, 0);
    // OS confirmada sem valor.
    await seedOrder('Servico sem valor', 'Cliente Sem Valor'); // OS 2, CONFIRMADA, amount null
    const noValue = await inbound('cobrar OS 2 pix');
    assert.match(noValue.text, /A OS 000002 não tem valor definido; não é possível cobrar\./);
    await pending(null);
    // OS com cobrança ativa.
    const third = await confirmOrder('Servico duplo', 'Cliente Duplo', '100'); // OS 3
    await cobrarPixConfirm(third.number);
    const active = await inbound('cobrar OS 3 pix');
    assert.match(active.text, /Já há cobrança ativa para a OS 000003: PIX R\$ 100,00 vence 10\/11\/2026 \(PENDING\)/);
    await pending(null);
    assert.equal((await charges()).length, 1);
    assert.equal(asaasCallsTo('POST', '/payments').length, 1);
  }],
  ['cobrar boleto cria BOLETO sem buscar dados pix', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico boleto', 'Cliente Boleto', '200');
    // Fluxo guiado completo: método perguntado, vencimento com default.
    const askMethod = await inbound(`cobrar OS ${order.number}`);
    assert.match(askMethod.text, /Método da cobrança\? Responda pix ou boleto\./);
    await pending('CHARGE_METHOD');
    const askDue = await inbound('boleto');
    assert.match(askDue.text, /Vencimento\? Responda DD\/MM\/AAAA, \+Nd ou - para usar/);
    await pending('CHARGE_DUE');
    const summary = await inbound('20/11/2026');
    assert.match(summary.text, /Cobrança Boleto de R\$ 200,00 para Cliente Boleto \(OS 000001\), vencimento 20\/11\/2026\. Confirma\?/);
    await pending('CHARGE_CONFIRM');
    const done = await inbound('sim');
    await pending(null);
    assert.match(done.text, /Cobrança criada: OS 000001 · Boleto · R\$ 200,00 · vencimento 20\/11\/2026\./);
    assert.match(done.text, /link disponível no painel Asaas\./);
    assert.doesNotMatch(done.text, /copia-e-cola/);
    const charge = (await charges())[0]!;
    assert.equal(charge.method, 'BOLETO');
    assert.equal(charge.status, 'PENDING');
    assert.equal(charge.pix_copy_paste, null);
    assert.equal(charge.pix_qr_url, null);
    assert.equal(asaasPayments[0]!.billingType, 'BOLETO');
    assert.equal(asaasCallsTo('GET', `/payments/${charge.provider_charge_id}/pixQrCode`).length, 0, 'boleto não busca pix');
  }],
  ['cobrar sem CPF/CNPJ recebe orientação determinística; após comando cpf a cobrança é criada', async () => {
    await restartAppWith(asaasEnv());
    const order = await confirmOrder('Servico fiscal', 'Cliente Fiscal', '150');
    asaasRequireFiscalId = true; // reproduz a rejeição real do sandbox Asaas
    const summary = await inbound(`cobrar OS ${order.number} pix 10/11/2026`);
    assert.match(summary.text, /Confirma\?/);
    const failed = await inbound('sim');
    await pending(null);
    assert.match(failed.text, /O provedor exige o CPF\/CNPJ do cliente para cobrar\. Informe com: cpf Cliente Fiscal <número> e tente novamente\./);
    const rejected = (await charges())[0]!;
    assert.equal(rejected.status, 'ERROR');
    assert.equal(rejected.external_reference, 'OS-1-C1');
    assert.equal(rejected.provider_charge_id, null);
    assert.equal(asaasPayments.length, 0, 'rejeição determinística não cria cobrança no provedor');
    // Comando cpf: grava o documento e audita.
    const cpfReply = await inbound('cpf Cliente Fiscal 529.982.247-25');
    assert.match(cpfReply.text, /CPF\/CNPJ de Cliente Fiscal atualizado\. Tente a cobrança novamente\./);
    const [customerRow] = await prisma.$queryRawUnsafe<Array<{ cpf_cnpj: string | null }>>(
      "SELECT cpf_cnpj FROM customers WHERE name='Cliente Fiscal'",
    );
    assert.equal(customerRow!.cpf_cnpj, '52998224725', 'documento gravado sem pontuação');
    assert.deepEqual((await audits(cpfReply.id)).map((entry) => [entry.entity_type, entry.action]), [['customer', 'SET_CPF_CNPJ']]);
    // Retry: updateCustomer (PUT) sincroniza o documento e a cobrança é criada.
    const retry = await inbound(`cobrar OS ${order.number} pix 10/11/2026`);
    assert.match(retry.text, /Confirma\?/);
    const done = await inbound('sim');
    await pending(null);
    assert.match(done.text, /Cobrança criada: OS 000001/);
    assert.match(done.text, /Pix copia-e-cola/);
    const rows = await charges();
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.status, 'PENDING');
    assert.equal(rows[1]!.external_reference, 'OS-1-C2');
    assert.equal(asaasCallsTo('PUT', '/customers/').length, 1, 'documento sincronizado via PUT');
    assert.equal(asaasCustomers[0]!.cpfCnpj, '52998224725');
    assert.equal(asaasCallsTo('POST', '/payments').length, 2, 'uma rejeição + uma criação');
    assert.equal(asaasPayments.length, 1);
    assert.equal(asaasCallsTo('POST', '/customers').length, 1, 'cliente reusa a referência persistida');
  }],
  ['cpf com nome ambíguo lista opções; documento inválido é rejeitado determinísticamente', async () => {
    await seedCustomer('Cliente Ambíguo Um');
    await seedCustomer('Cliente Ambíguo Dois');
    const ambiguous = await inbound('cpf Cliente Ambíguo 12.345.678/0001-95');
    assert.match(ambiguous.text, /Encontrei mais de um cliente:\n1\. Cliente Ambíguo Um\n2\. Cliente Ambíguo Dois\nResponda com o número\./);
    await pending('CPF_CHOOSE');
    const chosen = await inbound('2');
    await pending(null);
    assert.match(chosen.text, /CPF\/CNPJ de Cliente Ambíguo Dois atualizado\. Tente a cobrança novamente\./);
    const docs = await prisma.$queryRawUnsafe<Array<{ name: string; cpf_cnpj: string | null }>>(
      'SELECT name, cpf_cnpj FROM customers ORDER BY created_at, id',
    );
    assert.deepEqual(docs, [
      { name: 'Cliente Ambíguo Um', cpf_cnpj: null },
      { name: 'Cliente Ambíguo Dois', cpf_cnpj: '12345678000195' },
    ]);
    assert.deepEqual((await audits(chosen.id)).map((entry) => [entry.entity_type, entry.action]), [['customer', 'SET_CPF_CNPJ']]);
    // Documento inválido: rejeição determinística, nada gravado, sem pendência.
    for (const invalid of ['cpf Cliente Ambíguo Um 123', 'cpf Cliente Ambíguo Um 5299822472', 'cpf Cliente Ambíguo Um 1234567800019A', 'cpf Cliente Ambíguo Um 123456789012345']) {
      const rejected = await inbound(invalid);
      assert.match(rejected.text, /Documento inválido\. Informe CPF \(11 dígitos\) ou CNPJ \(14 dígitos\)/);
      await pending(null);
    }
    const after = await prisma.$queryRawUnsafe<Array<{ cpf_cnpj: string | null }>>(
      "SELECT cpf_cnpj FROM customers WHERE name='Cliente Ambíguo Um'",
    );
    assert.equal(after[0]!.cpf_cnpj, null);
    // Nome sem match e uso incorreto: respostas determinísticas.
    assert.match((await inbound('cpf Ninguem Aqui 52998224725')).text, /Não encontrei cliente com esse nome: Ninguem Aqui\./);
    assert.match((await inbound('cpf')).text, /Use: cpf <nome do cliente> <documento>/);
    await pending(null);
  }],
  ['emitir NF pelo adapter manual registra NEEDS_REVIEW, exige CPF/CNPJ e deduplica solicitação', async () => {
    await restartAppWith({ INVOICE_PROVIDER: 'manual' });
    const order = await confirmOrder('Servico com nota', 'Cliente Nota', '150');
    // Sem CPF/CNPJ: a solicitação só é recusada depois do 'sim' (nada persistido).
    const first = await inbound(`emitir NF OS ${order.number} 1.02`);
    assert.match(first.text, /Solicitar emissão fiscal da OS 000001 para Cliente Nota, R\$ 150,00, código 1\.02\? Responda sim ou cancelar\./);
    await pending('INVOICE_CONFIRM');
    const missing = await inbound('sim');
    await pending(null);
    assert.match(missing.text, /A emissão exige CPF\/CNPJ do tomador\. Informe com: cpf Cliente Nota <número>\./);
    assert.equal((await invoices()).length, 0);
    // Abortar antes do 'sim' não cria nada.
    const asked = await inbound(`emitir NF OS ${order.number} 1.02`);
    await pending('INVOICE_CONFIRM');
    assert.match((await inbound('cancelar')).text, /Operação cancelada\./);
    await pending(null);
    assert.equal((await invoices()).length, 0);
    // Documento informado: solicitação registrada como pendência humana.
    await inbound('cpf Cliente Nota 52998224725');
    const confirm = await inbound(`emitir NF OS ${order.number} 1.02`);
    await pending('INVOICE_CONFIRM');
    const done = await inbound('sim');
    await pending(null);
    assert.match(done.text, /Solicitação fiscal da OS 000001 registrada para emissão humana \(referência OS-1-NF1\)\./);
    const rows = await invoices();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provider, 'manual');
    assert.equal(rows[0]!.status, 'NEEDS_REVIEW');
    assert.equal(rows[0]!.provider_invoice_id, null);
    assert.equal(rows[0]!.payload!.externalReference, 'OS-1-NF1');
    assert.equal(rows[0]!.payload!.serviceCode, '1.02');
    assert.equal(rows[0]!.payload!.valueCents, 15000);
    assert.equal((rows[0]!.payload!.customer as Record<string, unknown>).cpfCnpj, '52998224725');
    assert.deepEqual((await audits(done.id)).map((entry) => [entry.entity_type, entry.action, entry.previous_status, entry.new_status]),
      [['invoice', 'REQUEST_INVOICE', 'READY_FOR_APPROVAL', 'NEEDS_REVIEW']]);
    // Deduplicação: solicitação ativa bloqueia nova emissão.
    const dup = await inbound(`emitir NF OS ${order.number} 1.02`);
    await pending('INVOICE_CONFIRM');
    const dupDone = await inbound('sim');
    await pending(null);
    assert.match(dupDone.text, /Já há solicitação fiscal da OS 000001 no estado NEEDS_REVIEW\./);
    assert.equal((await invoices()).length, 1);
    void dup;
    // Uso incorreto e OS inexistente: respostas determinísticas.
    assert.match((await inbound('emitir NF OS 99 1.02')).text, /OS não encontrada\./);
    assert.match((await inbound('emitir NF OS 1')).text, /Use: emitir NF OS <número> <código-do-serviço>\./);
    await pending(null);
    // Listagem só existe enquanto pendente.
    const list = await inbound('notas');
    assert.match(list.text, /Solicitações fiscais:\nOS 000001 · Cliente Nota · NEEDS_REVIEW · manual/);
  }],
  ['emissor none e OS inválidas respondem determinístico sem persistir nota', async () => {
    // INVOICE_PROVIDER=none (padrão): comando responde sem criar nada.
    const order = await confirmOrder('Servico sem nota', 'Cliente Sem Nota', '150');
    const none = await inbound(`emitir NF OS ${order.number} 14.01`);
    assert.match(none.text, /Emissão fiscal automática não configurada \(INVOICE_PROVIDER=none\)\./);
    await pending(null);
    assert.equal((await invoices()).length, 0);
    // OS não confirmada e sem valor: rejeitadas antes da confirmação.
    const pendingCustomerId = await seedCustomer('Cliente Nota Pendente');
    await prisma.$executeRawUnsafe(
      "INSERT INTO service_orders(customer_id, description, status) VALUES($1::uuid, 'Servico nota pendente', 'AGUARDANDO_DADOS')",
      pendingCustomerId,
    );
    await restartAppWith({ INVOICE_PROVIDER: 'manual' });
    const unconfirmed = await inbound('emitir NF OS 2 1.02');
    assert.match(unconfirmed.text, /A OS 000002 não está confirmada ou não tem valor para emissão fiscal\./);
    await pending(null);
    assert.equal((await invoices()).length, 0);
    await seedOrder('Servico nota sem valor', 'Cliente Nota Sem Valor'); // OS 3, CONFIRMADA, amount null
    const noValue = await inbound('emitir NF OS 3 1.02');
    assert.match(noValue.text, /A OS 000003 não está confirmada ou não tem valor para emissão fiscal\./);
    await pending(null);
    // Lista vazia funciona mesmo sem provedor.
    delete process.env.INVOICE_PROVIDER;
    await restartAppWith({});
    assert.match((await inbound('notas')).text, /Nenhuma solicitação fiscal pendente\./);
  }],
  ['nota emitida registra AUTHORIZED com número; cancelar nota fecha a solicitação', async () => {
    await restartAppWith({ INVOICE_PROVIDER: 'manual' });
    const order = await confirmOrder('Servico baixa nota', 'Cliente Baixa Nota', '150');
    await inbound('cpf Cliente Baixa Nota 52998224725');
    await inbound(`emitir NF OS ${order.number} 1.02`);
    await pending('INVOICE_CONFIRM');
    await inbound('sim');
    await pending(null);
    // Uso incorreto e OS sem solicitação: determinístico.
    assert.match((await inbound('nota emitida OS 1')).text, /Use: nota emitida OS <número> <número da NFS-e>/);
    assert.match((await inbound('cancelar nota OS 99')).text, /Não há solicitação fiscal ativa para a OS 000099\./);
    // Baixa com o número da nota emitida no Portal Nacional.
    const settled = await inbound(`nota emitida OS ${order.number} 1024`);
    await pending(null);
    assert.match(settled.text, /Nota da OS 000001 registrada como emitida \(nº 1024\)\./);
    const rows = await invoices();
    assert.equal(rows[0]!.status, 'AUTHORIZED');
    assert.equal((rows[0]!.payload as Record<string, unknown>).nfsNumber, '1024');
    assert.deepEqual((await audits(settled.id)).map((entry) => [entry.entity_type, entry.action, entry.new_status, entry.reason]),
      [['invoice', 'INVOICE_AUTHORIZED', 'AUTHORIZED', '1024']]);
    // Autorizada sai da lista de pendências; repetir a baixa não acha ativa.
    assert.match((await inbound('notas')).text, /Nenhuma solicitação fiscal pendente\./);
    assert.match((await inbound(`nota emitida OS ${order.number} 1025`)).text, /Não há solicitação fiscal ativa/);
    // Nova solicitação pode ser cancelada antes da emissão.
    const second = await confirmOrder('Servico cancela nota', 'Cliente Cancela Nota', '90');
    await inbound('cpf Cliente Cancela Nota 12345678000195');
    await inbound(`emitir NF OS ${second.number} 1.02`);
    await pending('INVOICE_CONFIRM');
    await inbound('sim');
    await pending(null);
    const dropped = await inbound(`cancelar nota OS ${second.number}`);
    await pending(null);
    assert.match(dropped.text, /Solicitação fiscal da OS 000002 cancelada\./);
    const after = await invoices();
    assert.equal(after[1]!.status, 'CANCELED');
    assert.deepEqual((await audits(dropped.id)).map((entry) => [entry.action, entry.previous_status, entry.new_status]),
      [['INVOICE_CANCELED', 'NEEDS_REVIEW', 'CANCELED']]);
    assert.match((await inbound('notas')).text, /Nenhuma solicitação fiscal pendente\./);
  }],
  ['fechamento e relatorio semanal sob demanda somam centavos e listam alertas', async () => {
    await restartAppWith({ INVOICE_PROVIDER: 'manual' });
    const order = await confirmOrder('Servico fechamento', 'Cliente Fechamento', '180');
    // Recebimento manual hoje (dinheiro) alimenta recebido e cobrado.
    await inbound(`recebi OS ${order.number} 100 dinheiro`);
    await inbound('sim');
    // Material abaixo do mínimo.
    await prisma.$executeRawUnsafe(
      "INSERT INTO inventory_items(name, normalized_name, unit, quantity, min_quantity) VALUES('cabo', 'cabo', 'm', 2, 5)",
    );
    // OS incompleta de dois dias atrás.
    const customerId = await seedCustomer('Cliente Antigo');
    await prisma.$executeRawUnsafe(
      "INSERT INTO service_orders(customer_id, description, status, created_at) VALUES($1::uuid, 'Servico antigo', 'AGUARDANDO_DADOS', now() - interval '2 days')",
      customerId,
    );
    // Nota fiscal pendente de emissão humana.
    await inbound('cpf Cliente Fechamento 52998224725');
    await inbound(`emitir NF OS ${order.number} 1.02`);
    await pending('INVOICE_CONFIRM');
    await inbound('sim');
    await pending(null);
    const close = await inbound('fechamento');
    assert.match(close.text, /^Fechamento \d{2}\/\d{2}\/\d{4}/);
    assert.match(close.text, /OS confirmadas: 1 · R\$ 180,00/);
    assert.match(close.text, /Recebido: 1 · R\$ 100,00/);
    assert.match(close.text, /Cobranças abertas: 0 · R\$ 0,00/);
    assert.match(close.text, /OS incompletas: OS 000002 \(de \d{2}\/\d{2}\)/);
    assert.match(close.text, /Notas fiscais pendentes: OS 000001 NEEDS_REVIEW \(OS-1-NF1\)/);
    assert.match(close.text, /Estoque mínimo: cabo 2\/5 m/);
    const weekly = await inbound('relatorio semanal');
    assert.match(weekly.text, /^Relatório semanal \d{2}\/\d{2}\/\d{4}–\d{2}\/\d{2}\/\d{4}/);
    assert.match(weekly.text, /OS confirmadas: 1 · R\$ 180,00/);
    assert.match(weekly.text, /Cobrado: 1 · R\$ 100,00/);
    assert.match(weekly.text, /Recebido: 1 · R\$ 100,00/);
    assert.match(weekly.text, /Estoque mínimo: cabo 2\/5 m/);
    // Acento na escrita alternativa também resolve.
    assert.match((await inbound('relatório semanal')).text, /^Relatório semanal/);
  }],
  ['fechamento agendado pelo tick é único por dia e semana; desligar para de enviar', async () => {
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date()),
    );
    await restartAppWith({
      REPORTS_ENABLED: 'true', REPORT_DAILY_HOUR: '0', REPORT_WEEKLY_DAY: String(weekday),
    });
    await tick();
    let sent = (await notices()).map((notice) => notice.body);
    assert.equal(sent.length, 2, 'fechamento diário + relatório semanal no mesmo tick');
    assert.match(sent[0]!, /^Fechamento \d{2}\/\d{2}\/\d{4}/);
    assert.match(sent[1]!, /^Relatório semanal /);
    // Tick repetido não duplica (report_deliveries + dedup_key).
    await tick();
    await tick();
    sent = (await notices()).map((notice) => notice.body);
    assert.equal(sent.length, 2);
    const deliveries = await prisma.$queryRawUnsafe<Array<{ kind: string; period_key: string }>>(
      'SELECT kind, period_key FROM report_deliveries ORDER BY kind',
    );
    assert.equal(deliveries.length, 2);
    assert.match(deliveries[0]!.period_key, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(deliveries[1]!.period_key, /^W:\d{4}-\d{2}-\d{2}$/);
    // Hora ainda não atingida: nada é enviado (usa hora 23 como corte futuro).
    await prisma.$executeRawUnsafe('DELETE FROM report_deliveries');
    await prisma.$executeRawUnsafe('DELETE FROM outbound_messages WHERE correlation_message_id IS NULL');
    await restartAppWith({ REPORTS_ENABLED: 'true', REPORT_DAILY_HOUR: '23', REPORT_WEEKLY_DAY: String(weekday) });
    const before = (new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date()));
    if (Number(before) < 23) {
      await tick();
      assert.equal((await notices()).length, 0, 'antes de REPORT_DAILY_HOUR nada é enviado');
    }
    // Desligado por política: nunca envia.
    await restartAppWith({ REPORTS_ENABLED: 'false', REPORT_DAILY_HOUR: '0', REPORT_WEEKLY_DAY: String(weekday) });
    await tick();
    assert.equal((await notices()).length, 0);
  }],
];

let passed = 0;
const listen = (server: http.Server) => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  return promise;
};
try {
  await listen(provider);
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.WAHA_BASE_URL = providerUrl;
  await listen(asaasFake);
  asaasUrl = `http://127.0.0.1:${(asaasFake.address() as AddressInfo).port}`;
  // In the compose verify overlay GROQ_BASE_URL points at the groq-test service
  // (scripts/test-groq-server.mjs); without it, run the in-process mirror.
  if (!process.env.GROQ_BASE_URL) {
    await listen(groqFake);
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${(groqFake.address() as AddressInfo).port}`;
  }
  groqBase = process.env.GROQ_BASE_URL;
  for (const [name, scenario] of scenarios) {
    await reset();
    await groqReset();
    // Every scenario starts from the canonical settings; scenarios that need a
    // different configuration mutate and restart, then must restore it.
    process.env.GROQ_API_KEY = settings.GROQ_API_KEY;
    process.env.WAHA_MEDIA_MAX_BYTES = settings.WAHA_MEDIA_MAX_BYTES;
    delete process.env.BILLING_PROVIDER;
    delete process.env.ASAAS_API_KEY;
    delete process.env.ASAAS_BASE_URL;
    delete process.env.ASAAS_WEBHOOK_TOKEN;
    delete process.env.INVOICE_PROVIDER;
    delete process.env.REPORTS_ENABLED;
    delete process.env.REPORT_DAILY_HOUR;
    delete process.env.REPORT_WEEKLY_DAY;
    // Cenários que não tratam de relatórios rodam com envio desligado: o
    // fechamento agendado default (18h) faria o suite depender da hora do dia.
    process.env.REPORTS_ENABLED = 'false';
    if (app) await app.close();
    app = undefined;
    await startApp();
    try {
      await scenario();
      assert.deepEqual(providerErrors, [], 'The local provider must receive valid authenticated requests');
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (cause) {
      throw new Error(`Integration scenario failed: ${name}`, { cause });
    }
  }
  console.log(`integration PASS: ${passed} PostgreSQL and real HTTP behavioral scenarios; isolated NOWEB/Groq providers only`);
} finally {
  // Nested finally blocks ensure a failed assertion or app shutdown cannot leak other services.
  try {
    if (app) await app.close();
  } finally {
    try {
      provider.closeAllConnections();
      asaasFake.closeAllConnections();
      if (provider.listening) await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      if (asaasFake.listening) {
        const closed = Promise.withResolvers<void>();
        asaasFake.close((error) => error ? closed.reject(error) : closed.resolve());
        await closed.promise;
      }
    } finally {
      try {
        if (groqFake.listening) await new Promise<void>((resolve, reject) => groqFake.close((error) => error ? reject(error) : resolve()));
      } finally {
        await prisma.$disconnect();
      }
    }
  }
}
