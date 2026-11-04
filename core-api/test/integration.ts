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
  return prisma.$queryRawUnsafe<State[]>(
    'SELECT pending_action, payload, service_order_id, expires_at, updated_at FROM conversation_states ORDER BY operator_id',
  );
}
async function pending(action: string | null): Promise<State> {
  const rows = await states();
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
async function reset() {
  // Only the disposable *_test database supplied by verify.sh can reach this operation.
  await prisma.$executeRawUnsafe('TRUNCATE audit_logs, outbound_messages, webhook_events, messages, conversation_states, service_orders, customers');
  await prisma.$executeRawUnsafe('ALTER SEQUENCE service_order_number_seq RESTART WITH 1');
  deliveries.length = 0;
  providerAttempts.length = 0;
  deliveryMode = 'accept';
  mediaDownloads.length = 0;
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
async function startApp() {
  // Config is evaluated by buildApp only after the local provider URL is installed.
  app = await buildApp({ WAHA_BASE_URL: providerUrl });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
}
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
    const zero = await inbound('0');
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
      [id('fifo-confirm'), 'confirmo', settings.OPERATOR_PHONE],
    ] as const;
    // Persist the intended ordering; concurrent consumers, not network arrival races, are under test.
    for (const [messageId, body, from] of input) await ingest(messageId, body, { from });
    await Promise.all([tick(), tick(), tick(), tick()]);
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
    assert.deepEqual((await audits(input[3][0])).map((audit) => audit.action), ['CONFIRM']);
    const inbox = await prisma.$queryRawUnsafe<Array<{ state: string; attempts: number; last_error: string | null }>>('SELECT state, attempts, last_error FROM webhook_events ORDER BY created_at');
    assert.deepEqual(inbox, input.map(() => ({ state: 'PROCESSED', attempts: 0, last_error: null })));
    assert.equal(providerAttempts.length, 4);
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
    assert.match(first.text, /R\$ 45,90/);
    await inbound('sim');
    assert.equal((await orders())[0]!.status, 'CONFIRMADA');
    await pending(null);
    // Second voice note carries an amount: no VALUE step, direct confirmation summary.
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
      if (provider.listening) await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    } finally {
      try {
        if (groqFake.listening) await new Promise<void>((resolve, reject) => groqFake.close((error) => error ? reject(error) : resolve()));
      } finally {
        await prisma.$disconnect();
      }
    }
  }
}
