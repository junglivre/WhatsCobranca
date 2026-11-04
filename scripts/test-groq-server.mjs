import http from 'node:http';

// This server exists only in the verification overlay, never in the operational stack.
// It mimics the two Groq OpenAI-compatible endpoints used by the audio flow:
//   POST /audio/transcriptions (multipart: file + model)  -> { text }
//   POST /chat/completions (JSON, response_format json_object) -> { choices: [...] }
// Scenario control (queued answers and failure modes) happens over HTTP so the
// integration tests running in another container can drive it per scenario.

const MODES = ['ok', 'badjson', 'hallucinated', 'timeout', '500'];

const DEFAULT_STT_TEXT = 'Troca da bomba de agua do poo';
const DEFAULT_LLM = {
  intent: 'REGISTRAR_SERVICO',
  customer_name: 'Carlos Pereira',
  service_description: 'Troca da bomba de agua',
  service_amount: 150.5,
  materials_amount: null,
  due_date: null,
};
// Schema-invalid on purpose: due_date violates the YYYY-MM-DD contract, so the
// core must fall back to the deterministic guided flow instead of trusting it.
const HALLUCINATED_LLM = {
  intent: 'REGISTRAR_SERVICO',
  customer_name: 'Fulano Inventado',
  service_description: 'Servico que ninguem pediu',
  service_amount: 999,
  materials_amount: 1,
  due_date: 'amanha',
};

// Modes are per-endpoint: {mode:'badjson', endpoint:'llm'} must break only the
// LLM call, leaving STT healthy (real Groq failures are endpoint-scoped).
const endpointModes = { stt: 'ok', llm: 'ok' };
const sttQueue = [];
const llmQueue = [];
const ledger = [];
const downloads = []; // not used here; media ledger lives in test-waha-server.mjs

const reply = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!match) return null;
  const boundary = `--${(match[1] ?? match[2]).trim()}`;
  const parts = buffer.toString('binary').split(boundary).slice(1, -1);
  const fields = {};
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    const body = Buffer.from(part.slice(headerEnd + 4), 'binary').subarray(0, -2); // strip trailing \r\n
    const name = /name="([^"]+)"/i.exec(header)?.[1];
    if (name) fields[name] = body;
  }
  return fields;
}

const authorized = (req) => {
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer verify-isolated-key`;
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, modes: { ...endpointModes } });
  if (req.method === 'GET' && req.url === '/ledger') return reply(res, 200, { sttQueue, llmQueue, entries: ledger, downloads });
  if (req.method === 'POST' && req.url === '/reset') {
    endpointModes.stt = 'ok';
    endpointModes.llm = 'ok';
    sttQueue.length = 0;
    llmQueue.length = 0;
    ledger.length = 0;
    downloads.length = 0;
    return reply(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/scenario') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (request.mode !== undefined && !MODES.includes(request.mode)) return reply(res, 400, { error: `mode must be one of ${MODES.join('|')}` });
        if (request.mode !== undefined) {
          if (request.endpoint === 'stt' || request.endpoint === 'llm') endpointModes[request.endpoint] = request.mode;
          else { endpointModes.stt = request.mode; endpointModes.llm = request.mode; }
        }
        if (request.stt !== undefined) sttQueue.push(...(Array.isArray(request.stt) ? request.stt : [request.stt]));
        if (request.llm !== undefined) llmQueue.push(...(Array.isArray(request.llm) ? request.llm : [request.llm]));
        return reply(res, 200, { ok: true, modes: { ...endpointModes }, sttQueue: sttQueue.length, llmQueue: llmQueue.length });
      } catch {
        return reply(res, 400, { error: 'invalid JSON' });
      }
    });
    return;
  }

  if (req.method === 'POST' && (req.url === '/audio/transcriptions' || req.url === '/chat/completions')) {
    const kind = req.url === '/audio/transcriptions' ? 'stt' : 'llm';
    const mode = endpointModes[kind];
    if (!authorized(req)) return reply(res, 401, { error: 'invalid test key' });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const attempt = { kind, mode, model: null, bytes: body.length, at: new Date().toISOString() };
      if (mode === '500') {
        ledger.push(attempt);
        return reply(res, 500, { error: 'planned test failure' });
      }
      if (mode === 'timeout') {
        // Longer than the core client timeout (30s); the request aborts before this fires.
        ledger.push(attempt);
        return setTimeout(() => reply(res, 200, kind === 'stt' ? { text: DEFAULT_STT_TEXT } : { choices: [{ message: { content: '{}' } }] }), 120_000);
      }

      let model = null;
      let payload;
      if (kind === 'stt') {
        const fields = parseMultipart(body, req.headers['content-type']);
        if (!fields) return reply(res, 400, { error: 'expected multipart/form-data' });
        model = fields.model?.toString() ?? null;
        if (!model) return reply(res, 400, { error: 'missing multipart field: model' });
        payload = { text: sttQueue.length > 0 ? sttQueue.shift() : DEFAULT_STT_TEXT };
        if (typeof payload.text !== 'string' || payload.text.length === 0) return reply(res, 400, { error: 'queued STT text must be a non-empty string' });
      } else {
        let request;
        try {
          request = JSON.parse(body.toString('utf8'));
        } catch {
          return reply(res, 400, { error: 'invalid JSON' });
        }
        model = request.model ?? null;
        if (!model) return reply(res, 400, { error: 'missing field: model' });
        if (request.response_format?.type !== 'json_object') return reply(res, 400, { error: 'response_format.type must be json_object' });
        payload = { id: `chatcmpl-test-${ledger.length + 1}`, model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : mode === 'hallucinated' ? HALLUCINATED_LLM : DEFAULT_LLM) } }] };
      }
      if (mode === 'badjson') {
        // HTTP 200 with a body the core cannot parse; the core must treat it as a schema failure.
        ledger.push({ ...attempt, model });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"text": truncated');
      }
      ledger.push({ ...attempt, model });
      return reply(res, 200, payload);
    });
    return;
  }

  reply(res, 404, { error: 'not found' });
});

server.listen(8091, '0.0.0.0');
