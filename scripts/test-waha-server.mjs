import http from 'node:http';

// This server exists only in the verification overlay, never in the operational stack.
const messages = [];
http.createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
  if (req.method === 'GET' && req.url === '/messages') return reply(200, messages);
  if (req.method !== 'POST' || req.url !== '/api/sendText') return reply(404, { error: 'not found' });
  if (req.headers['x-api-key'] !== 'verify-isolated-key') return reply(401, { error: 'invalid test key' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65536) return reply(413, { error: 'too large' });
  }
  try {
    const request = JSON.parse(raw);
    if (request.session !== 'default' || typeof request.chatId !== 'string' || typeof request.text !== 'string') {
      return reply(400, { error: 'invalid sendText request' });
    }
    const id = `verify-provider-${messages.length + 1}`;
    messages.push({ id, ...request });
    // Match NOWEB's nested message key, not a fictional idempotency header.
    return reply(200, { key: { id, remoteJid: request.chatId, fromMe: true } });
  } catch {
    return reply(400, { error: 'invalid JSON' });
  }
}).listen(8090, '0.0.0.0');
