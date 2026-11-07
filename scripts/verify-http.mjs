import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.env.POSTGRES_DB, 'whatscobranca_verify', 'Run only through npm run verify');
const composeArgs = ['compose', '--env-file', '/dev/null', '-f', 'docker-compose.yml', '-f', 'docker-compose.verify.yml', '--project-name', 'whatscobranca_verify'];
function compose(args, options = {}) {
  const result = spawnSync('docker', [...composeArgs, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Compose ${args[0]} failed: ${result.stderr?.toString()}`);
  return result.stdout;
}
function sql(query, database = 'whatscobranca_verify') {
  return compose(['exec', '-T', 'postgres', 'psql', '-U', 'whatscobranca', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query]).trim();
}
async function request(url, options = {}, expected = 200) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  assert.equal(response.status, expected, `${options.method ?? 'GET'} ${url}: ${text}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
async function until(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
function signed(body) {
  return { 'content-type': 'application/json', 'x-webhook-hmac': createHmac('sha512', process.env.WAHA_WEBHOOK_SECRET).update(body).digest('hex') };
}
async function inbound(body = 'ajuda', requirePending = true) {
  const id = `verify-http-${randomUUID()}`;
  const raw = JSON.stringify({ id: `envelope-${id}`, timestamp: Date.now(), session: 'default', event: 'message', engine: 'NOWEB', payload: { id, timestamp: Math.floor(Date.now() / 1000), from: '00000000000000@lid', fromMe: false, body, hasMedia: false } });
  await request('http://127.0.0.1:18081/webhooks/waha', { method: 'POST', headers: signed(raw), body: raw });
  if (requirePending) assert.equal(sql(`SELECT state FROM webhook_events WHERE message_id='${id}'`), 'PENDING', 'Inbound must commit before n8n processes it');
  return id;
}
async function delivered(id) {
  return until(async () => {
    const row = sql(`SELECT e.state || '|' || o.status || '|' || COALESCE(o.provider_message_id,'') FROM webhook_events e JOIN outbound_messages o ON o.correlation_message_id=e.message_db_id WHERE e.message_id='${id}'`);
    if (!row.startsWith('PROCESSED|SENT|verify-provider-')) return false;
    const providerId = row.split('|')[2];
    const ledger = await request('http://127.0.0.1:18090/messages');
    const found = ledger.find(item => item.id === providerId);
    assert.ok(found, 'Provider ledger must contain the exact persisted provider id');
    assert.equal(found.chatId, '00000000000000@lid');
    assert.equal(found.session, 'default');
    assert.match(found.text, /Atendimento:.*novo/s, 'The requested help must reach the provider');
    return row;
  }, `n8n delivery of ${id}`);
}

assert.deepEqual(await request('http://127.0.0.1:18082/health'), { ok: true });
await request('http://127.0.0.1:18082/automation/tick', { method: 'POST' }, 401);
for (const path of ['/health', '/automation/tick', '/webhook/poc1-tick', '/webhooks/waha/extra']) {
  await request(`http://127.0.0.1:18081${path}`, { method: 'POST' }, 404);
}
await request('http://127.0.0.1:18081/webhooks/waha', {}, 404);
await request('http://127.0.0.1:18081/webhooks/waha', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-hmac': '00' }, body: '{}' }, 401);
// Fase 4: envelope autenticado malformado persiste INVALID e confirma 200
// (400 fazia o WAHA esgotar retry e perder a mensagem real).
await request('http://127.0.0.1:18081/webhooks/waha', { method: 'POST', headers: signed('{}'), body: '{}' }, 200);
assert.equal(sql(`SELECT count(*) FROM webhook_events WHERE state='INVALID'`), '1', 'Authenticated malformed envelope must be parked as INVALID');
assert.equal(sql(`SELECT active::text FROM n8n.workflow_entity WHERE id='WhatsCobrancaPoc1Tick'`), 'true', 'Imported canonical workflow must be active');
assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='workflow_entity'"), '0', 'n8n must not use the domain schema');

// Stop orchestration to prove an actual pending inbox row, then invoke its production webhook.
compose(['stop', 'n8n']);
const webhookId = await inbound();
compose(['start', 'n8n']);
await until(async () => (await fetch('http://127.0.0.1:15678/healthz/readiness', { signal: AbortSignal.timeout(2000) })).ok, 'n8n readiness');
let proofId = webhookId;
let webhookProcessed = false;
for (let attempt = 0; attempt < 5; attempt += 1) {
  // n8n readiness can precede registration of active workflow routes.
  const tick = await until(
    () => request('http://127.0.0.1:15678/webhook/poc1-tick', { method: 'POST' }),
    'active n8n production webhook',
  );
  if (tick.processed >= 1 && tick.sent >= 1) {
    webhookProcessed = true;
    break;
  }
  // A scheduled tick may win a startup race. Prove that delivery before trying
  // the production webhook with another real message, never fake a count.
  await delivered(proofId);
  proofId = await inbound('ajuda', false);
}
assert.ok(webhookProcessed, 'The production n8n webhook must process and send an actual pending inbound');
await delivered(proofId);

// Enqueue with n8n stopped, restart Core, and let only the active schedule recover it.
compose(['stop', 'n8n']);
const restartId = await inbound();
compose(['restart', 'core-api']);
await until(async () => (await request('http://127.0.0.1:18082/health')).ok, 'Core restart health');
assert.equal(sql(`SELECT state FROM webhook_events WHERE message_id='${restartId}'`), 'PENDING');
compose(['start', 'n8n']);
await delivered(restartId);
assert.equal(sql(`SELECT count(*) FROM messages WHERE message_id='${restartId}'`), '1');
assert.equal(sql(`SELECT count(*) FROM outbound_messages o JOIN messages m ON m.id=o.correlation_message_id WHERE m.message_id='${restartId}'`), '1');

function constraint(query, state) {
  const result = spawnSync('docker', [...composeArgs, 'exec', '-T', 'postgres', 'psql', '-U', 'whatscobranca', '-d', 'whatscobranca_verify', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', `BEGIN; ${query}; ROLLBACK;`], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'Database must reject invalid data');
  assert.match(result.stderr, new RegExp(state), 'Expected PostgreSQL constraint SQLSTATE');
}
constraint(`INSERT INTO messages (id,operator_id,session,message_id,reply_to,body,has_media) SELECT gen_random_uuid(),operator_id,session,message_id,reply_to,body,has_media FROM messages WHERE message_id='${restartId}'`, '23505');
constraint("INSERT INTO service_orders (id,number,customer_id,description,status) VALUES (gen_random_uuid(),987653,'00000000-0000-0000-0000-000000000001','invalid FK','RASCUNHO')", '23503');

const marker = `Restore proof ${randomUUID()}`;
sql(`WITH customer AS (INSERT INTO customers (name,normalized_name) VALUES ('${marker}','${marker.toLowerCase()}') RETURNING id) INSERT INTO service_orders (number,customer_id,description,amount_cents,status) SELECT 987654,id,'Recognizable restored service',14987,'CONFIRMADA' FROM customer`);
const expected = `${marker}|Recognizable restored service|14987|CONFIRMADA`;
const restoredValue = "SELECT c.name || '|' || s.description || '|' || s.amount_cents || '|' || s.status FROM service_orders s JOIN customers c ON c.id=s.customer_id WHERE s.number=987654";
assert.equal(sql(restoredValue), expected);
const temp = mkdtempSync(join(tmpdir(), 'whatscobranca-verify-'));
try {
  const dump = join(temp, 'domain.dump');
  writeFileSync(dump, compose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'whatscobranca', '-Fc', '--schema=public', 'whatscobranca_verify'], { encoding: null }), { mode: 0o600 });
  const envFile = join(temp, 'verify.env');
  const keys = ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'AUTOMATION_TOKEN', 'WAHA_WEBHOOK_SECRET', 'WAHA_API_KEY', 'WAHA_BASE_URL', 'WAHA_SESSION', 'OPERATOR_LID', 'OPERATOR_PHONE', 'N8N_ENCRYPTION_KEY'];
  writeFileSync(envFile, keys.map(key => `${key}='${process.env[key]}'`).join('\n') + '\n', { mode: 0o600 });
  const restoreEnv = { ...process.env, WHATSCOBRANCA_ENV_FILE: envFile, COMPOSE_PROJECT_NAME: 'whatscobranca_verify', COMPOSE_FILE: `${resolve('docker-compose.yml')}:${resolve('docker-compose.verify.yml')}` };
  const restore = () => spawnSync('bash', ['scripts/restore.sh', dump, 'whatscobranca_verify_restore'], { encoding: 'utf8', env: restoreEnv });
  const first = restore();
  assert.equal(first.status, 0, `NEW database restore failed: ${first.stderr}`);
  assert.equal(sql(restoredValue, 'whatscobranca_verify_restore'), expected, 'Restored values must match seeded data exactly');
  const second = restore();
  assert.equal(second.status, 2, 'Restore must refuse an existing target');
  assert.equal(sql(restoredValue, 'whatscobranca_verify_restore'), expected, 'Refusal must preserve restored data');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('HTTP/DB evidence passed: authenticated ingestion, n8n webhook and scheduled restart recovery, exact provider ledger, proxy, constraints, safe restore.');
