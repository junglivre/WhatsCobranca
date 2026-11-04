import http from 'node:http';

// This server exists only in the verification overlay, never in the operational stack.
const messages = [];
const downloads = [];
// Fixed ogg scaffold: a real Ogg page header ("OggS") followed by deterministic filler.
const oggScaffold = Buffer.alloc(10 * 1024);
Buffer.from('OggS', 'binary').copy(oggScaffold, 0);
const oversizeMedia = Buffer.alloc(200 * 1024, 0x61);
Buffer.from('OggS', 'binary').copy(oversizeMedia, 0);
http.createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
  if (req.method === 'GET' && req.url === '/messages') return reply(200, messages);
  if (req.method === 'GET' && req.url === '/files') return reply(200, { downloads });
  // NOWEB media endpoint: the core extracts only the PATH of payload.media.url and
  // prefixes WAHA_BASE_URL, so any host in the original url is deliberately ignored.
  const file = /^\/api\/files\/([^/]+)\/([^/]+?)(\.[a-z0-9]+)?$/i.exec(req.url ?? '');
  if (req.method === 'GET' && file) {
    if (req.headers['x-api-key'] !== 'verify-isolated-key') return reply(401, { error: 'invalid test key' });
    const [, sessionId, fileId] = file;
    const media = fileId.startsWith('oversize') ? oversizeMedia : oggScaffold;
    downloads.push({ path: req.url, sessionId, fileId, bytes: media.length, at: new Date().toISOString() });
    res.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': String(media.length) });
    return res.end(media);
  }
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
