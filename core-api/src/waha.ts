import crypto from 'node:crypto';
import type { Config } from './config.js';

export function validHmac(raw: Buffer, header: string | undefined, secret: string) {
  if (!header || !/^[a-fA-F0-9]{128}$/.test(header)) return false;
  const expected = crypto.createHmac('sha512', secret).update(raw).digest();
  const supplied = Buffer.from(header, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
export class SendFailure extends Error {
  constructor(message: string, readonly outcome: 'REJECTED' | 'UNCERTAIN') {
    super(message);
    this.name = 'SendFailure';
  }
}

export async function sendWaha(cfg: Config, chatId: string, text: string): Promise<{ id: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${cfg.WAHA_BASE_URL.replace(/\/$/, '')}/api/sendText`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'X-Api-Key': cfg.WAHA_API_KEY },
      body: JSON.stringify({ session: cfg.WAHA_SESSION, chatId, text }),
    });
    if (!response.ok) throw new SendFailure(`WAHA_HTTP_${response.status}`, 'REJECTED');
    const json = await response.json() as { id?: unknown; messageId?: unknown; key?: { id?: unknown } };
    const id = json.id ?? json.messageId ?? json.key?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new SendFailure('WAHA accepted a message without a provider ID', 'UNCERTAIN');
    }
    return { id };
  } catch (error) {
    if (error instanceof SendFailure) throw error;
    // A lost response cannot prove that WhatsApp did not accept the send.
    // Retrying it automatically would risk a second copy of the same prompt.
    throw new SendFailure(error instanceof Error ? error.name : 'WAHA_NETWORK_ERROR', 'UNCERTAIN');
  } finally {
    clearTimeout(timer);
  }
}
