// Adapter Efí Pay (cobrança Pix via API Pix padrão BCB — "cob" com txid).
// ÚNICO ponto do código que fala com a Efí: o domínio só conhece a porta
// BillingProvider (types.ts). Status crus da Efí são traduzidos aqui e
// NUNCA persistidos.
//
// Escopo desta implementação: PIX (cob imediata com txid). Boleto lançaria
// mão de outro esquema de auth (Basic + HMAC) e fica fora — createCharge
// com BOLETO lança UnsupportedMethodError (rejeição determinística).
//
// Mapa de status Efí (cob.status) → interno:
//   ATIVA               → PENDING
//   CONCLUIDA           → RECEIVED
//   REMOVIDA_PELO_USUARIO_RECEBEDOR → CANCELED
//   REMOVIDA_PELO_PSP                → CANCELED
//
// Auth: OAuth2 client_credentials (POST /oauth/token, Basic) com cache em
// memória. Produção Pix exige mTLS: informe EFI_CERT_BASE64/EFI_KEY_BASE64
// (certificado ICP-Brasil) e o transport usa client TLS. Webhook: a Efí não
// envia headers customizados — a URL cadastrada deve levar ?token=<segredo>
// (EFI_WEBHOOK_TOKEN), validado aqui em comparação constant-time.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { Config } from '../../config.js';
import type {
  BillingProvider, ChargeCustomerInput, ChargeStatus, CreateChargeInput,
  CreatedCharge, NormalizedBillingEvent, PixData, ProviderChargeSnapshot,
} from './types.js';
import { decimalToCents, ProviderTimeoutError, ProviderValidationError, safeSecretEqual, UnsupportedMethodError, WebhookAuthError } from './types.js';

const TIMEOUT_MS = 30_000;
/** BCB: txid de cob é 26–35 caracteres alfanuméricos. */
const TXID_SIZE = 30;

/** externalReference 'OS-12-C3' → txid '00000000000000000000OS12C3'. */
export function efiTxid(externalReference: string): string {
  return externalReference.replace(/[^a-zA-Z0-9]/g, '').padStart(TXID_SIZE, '0');
}

/** Segundos até o fim do dia de vencimento (SP), entre 1h e 30d. */
function expirationFor(dueDate: string): number | null {
  const end = new Date(`${dueDate}T23:59:59-03:00`).getTime();
  const seconds = Math.ceil((end - Date.now()) / 1000);
  return seconds >= 3_600 && seconds <= 2_592_000 ? seconds : null;
}

function mapStatus(status: string): ChargeStatus {
  switch (status) {
    case 'CONCLUIDA': return 'RECEIVED';
    case 'REMOVIDA_PELO_USUARIO_RECEBEDOR':
    case 'REMOVIDA_PELO_PSP': return 'CANCELED';
    default: return 'PENDING';
  }
}

const centsToValue = (cents: number) => (cents / 100).toFixed(2);
type Json = Record<string, unknown>;

/** POST/PUT/PATCH/GET JSON sobre node:https — client TLS opcional (mTLS). */
function efiFetch(
  base: URL, path: string, method: string, headers: Record<string, string>,
  body: string | null, timeoutMs: number, mTls: { cert: string; key: string } | null,
): Promise<{ status: number; body: Json | null }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const options: RequestOptions = {
      method, headers: { ...headers, ...(body === null ? {} : { 'content-length': String(Buffer.byteLength(body)) }) },
      timeout: timeoutMs,
      ...(mTls ? { cert: mTls.cert, key: mTls.key } : {}),
    };
  const req = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        let parsed: Json | null = null;
        try {
          parsed = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json : null;
        } catch {
          parsed = null;
        }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new ProviderTimeoutError(`efi ${method} ${path} excedeu ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

export class EfiBillingProvider implements BillingProvider {
  readonly name = 'efi';
  private token: { value: string; expiresAt: number } | null = null;
  private readonly mTls: { cert: string; key: string } | null;

  constructor(private readonly cfg: Config) {
    this.mTls = cfg.EFI_CERT_BASE64 && cfg.EFI_KEY_BASE64
      ? { cert: Buffer.from(cfg.EFI_CERT_BASE64, 'base64').toString('utf8'), key: Buffer.from(cfg.EFI_KEY_BASE64, 'base64').toString('utf8') }
      : null;
    if (!this.mTls || !this.mTls.cert.includes('BEGIN CERTIFICATE') || !this.mTls.key.includes('BEGIN')) {
      throw new Error('EFI_CERT_BASE64 e EFI_KEY_BASE64 precisam conter um par PEM válido quando Efí está habilitada');
    }
  }

  private base(): URL {
    return new URL(this.cfg.EFI_BASE_URL);
  }

  /** OAuth2 client_credentials com cache (skew de 60s). */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.EFI_CLIENT_ID}:${this.cfg.EFI_CLIENT_SECRET}`).toString('base64');
    const body = JSON.stringify({ grant_type: 'client_credentials' });
    const response = await efiFetch(this.base(), '/oauth/token', 'POST', {
      authorization: `Basic ${basic}`, 'content-type': 'application/json',
    }, body, TIMEOUT_MS, this.mTls);
    const token = typeof response.body?.access_token === 'string' ? response.body.access_token : null;
    const expiresIn = Number(response.body?.expires_in);
    if (response.status !== 200 || !token) throw new Error(`EFI_AUTH_FAILED(${response.status})`);
    this.token = { value: token, expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 300_000) };
    return token;
  }

  private async call(
    method: string, path: string, payload: Json | null, extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: Json | null }> {
    const token = await this.accessToken();
    return efiFetch(this.base(), path, method, {
      authorization: `Bearer ${token}`,
      ...(payload === null ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    }, payload === null ? null : JSON.stringify(payload), TIMEOUT_MS, this.mTls);
  }

  /** Pix cob não precisa de cadastro de pagador — id determinístico local. */
  async ensureCustomer(input: ChargeCustomerInput): Promise<string> {
    return `efi-${input.customerId}`;
  }

  async updateCustomer(_externalId: string, _input: ChargeCustomerInput): Promise<void> {}

  async createCharge(input: CreateChargeInput): Promise<CreatedCharge> {
    if (input.method !== 'PIX') {
      throw new UnsupportedMethodError('Boleto não suportado pelo adapter Efí — use pix ou troque BILLING_PROVIDER.');
    }
    const expiration = expirationFor(input.dueDate);
    if (expiration === null) {
      throw new ProviderValidationError('Vencimento Pix Efí deve ficar entre uma hora e trinta dias; escolha uma data suportada.');
    }
    const txid = efiTxid(input.externalReference);
    const response = await this.call('PUT', `/v2/cob/${txid}`, {
      calendario: { expiracao: expiration },
      valor: { original: centsToValue(input.valueCents) },
      chave: this.cfg.EFI_PIX_KEY,
      solicitacaoPagador: input.description.slice(0, 140),
    });
    const status = typeof response.body?.status === 'string' ? response.body.status : null;
    if (response.status >= 500) throw new ProviderTimeoutError(`efi createCharge ${response.status}`);
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`EFI_CREATE_FAILED(${response.status})`);
    }
    return { providerChargeId: txid, status: mapStatus(status ?? 'ATIVA') };
  }

  async getCharge(providerChargeId: string): Promise<ProviderChargeSnapshot> {
    const response = await this.call('GET', `/v2/cob/${providerChargeId}`, null);
    const status = typeof response.body?.status === 'string' ? response.body.status : null;
    if (response.status !== 200 || !status) throw new Error(`EFI_GET_FAILED(${response.status})`);
    return { status: mapStatus(status), paidValueCents: null };
  }

  async findByExternalReference(ref: string): Promise<CreatedCharge | null> {
    const txid = efiTxid(ref);
    const response = await this.call('GET', `/v2/cob/${txid}`, null);
    if (response.status === 404) return null;
    if (response.status === 200 && typeof response.body?.status === 'string') {
      return { providerChargeId: txid, status: mapStatus(response.body.status) };
    }
    throw new Error(`EFI_FIND_FAILED(${response.status})`);
  }

  async getPixData(providerChargeId: string): Promise<PixData> {
    const response = await this.call('GET', `/v2/cob/${providerChargeId}`, null);
    const copyPaste = typeof response.body?.pixCopiaECola === 'string' ? response.body.pixCopiaECola : null;
    if (response.status !== 200 || !copyPaste) throw new Error(`EFI_PIX_DATA_FAILED(${response.status})`);
    return { copyPaste, qrImageUrl: null, expirationDate: null };
  }

  async cancelCharge(providerChargeId: string): Promise<void> {
    const response = await this.call('PATCH', `/v2/cob/${providerChargeId}`, { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' });
    if (response.status !== 204 && response.status !== 200 && response.status !== 201) {
      throw new Error(`EFI_CANCEL_FAILED(${response.status})`);
    }
  }

  /**
   * Cadastra o webhook Pix na Efí para a chave configurada. Fica fora da
   * porta: é operação de instalação, específica da Efí.
   *
   * - URL cadastrada com `?token=<EFI_WEBHOOK_TOKEN>&ignorar=`: o token é a
   *   autenticação (a Efí não envia header customizado) e `ignorar=` impede
   *   a Efí de acrescentar `/pix` ao caminho — a rota real é
   *   /webhooks/billing/efi.
   * - Header `x-skip-mtls-checking: true`: sem ele a Efí exige, já no
   *   cadastro, que o servidor público valide o certificado de cliente dela —
   *   o que um Cloudflare Tunnel/proxy comum não faz. Com o skip, a
   *   autenticação fica a cargo do token na URL.
   * Retorna a URL cadastrada com o token mascarado (segura para log).
   */
  async registerWebhook(publicBaseUrl: string): Promise<string> {
    const route = new URL('/webhooks/billing/efi', publicBaseUrl);
    if (route.protocol !== 'https:') {
      throw new Error('EFI_WEBHOOK_URL_NOT_HTTPS: a Efí só aceita webhook com HTTPS');
    }
    const registered = `${route.href}?token=${encodeURIComponent(this.cfg.EFI_WEBHOOK_TOKEN)}&ignorar=`;
    const response = await this.call(
      'PUT', `/v2/webhook/${encodeURIComponent(this.cfg.EFI_PIX_KEY)}`, { webhookUrl: registered },
      { 'x-skip-mtls-checking': 'true' },
    );
    if (response.status !== 200 && response.status !== 201) {
      const reason = typeof response.body?.mensagem === 'string' ? response.body.mensagem : 'sem detalhe';
      throw new Error(`EFI_WEBHOOK_REGISTER_FAILED(${response.status}): ${reason}`);
    }
    return `${route.href}?token=***&ignorar=`;
  }

  /**
   * Webhook Pix da Efí: POST {pix: [{endToEndId, txid, valor, ...}, ...]}.
   * Autenticação: token na query (?token=...), constant-time. Cada entrada é
   * um evento; só vira RECEIVED o que é recebimento de cobrança — Pix sem
   * txid (cobrança estática/envio) e entradas com `devolucoes` (devolução de
   * valor já pago) são ignorados. Corpos sem `pix` (notificação de teste do
   * cadastro, `info` de recebimento recusado) devolvem lista vazia.
   */
  validateAndNormalizeWebhook(
    _headers: Record<string, string | string[] | undefined>,
    query: Record<string, string | string[] | undefined>,
    rawBody: unknown,
  ): NormalizedBillingEvent[] {
    const provided = Array.isArray(query.token) ? query.token[0] : query.token;
    const expected = this.cfg.EFI_WEBHOOK_TOKEN;
    if (!safeSecretEqual(provided, expected)) {
      throw new WebhookAuthError('invalid efi webhook token');
    }
    const entries: unknown[] = typeof rawBody === 'object' && rawBody !== null && 'pix' in rawBody
      && Array.isArray(rawBody.pix) ? rawBody.pix : [];
    const events: NormalizedBillingEvent[] = [];
    for (const entry of entries) {
      const field = (name: string): unknown =>
        typeof entry === 'object' && entry !== null && name in entry
          ? (entry as Record<string, unknown>)[name] : undefined;
      const txid = field('txid');
      const endToEndId = field('endToEndId');
      const refunds = field('devolucoes');
      if (typeof txid !== 'string' || typeof endToEndId !== 'string') continue;
      if (Array.isArray(refunds) && refunds.length > 0) {
        for (const refund of refunds) {
          const record = typeof refund === 'object' && refund !== null ? refund as Record<string, unknown> : {};
          const refundId = typeof record.id === 'string' ? record.id : typeof record.rtrId === 'string' ? record.rtrId : null;
          const dateRaw = record.horario ?? record.data ?? field('horario');
          const occurredAt = typeof dateRaw === 'string' && !Number.isNaN(Date.parse(dateRaw)) ? dateRaw : null;
          const cents = decimalToCents(record.valor);
          if (!refundId || (record.status !== undefined && record.status !== 'DEVOLVIDO')) continue;
          events.push({
            type: 'REFUNDED', providerChargeId: txid, providerEventId: `refund:${refundId}`,
            paidValueCents: cents, occurredAt,
            financial: cents !== null && occurredAt ? {
              direction: 'REFUND', valueCents: cents, occurredAt,
              economicKey: `efi:refund:${refundId}`, paymentReference: endToEndId, semantics: 'DELTA',
            } : null,
          });
        }
        continue;
      }
      const cents = decimalToCents(field('valor'));
      const dateRaw = field('horario');
      const occurredAt = typeof dateRaw === 'string' && !Number.isNaN(Date.parse(dateRaw)) ? dateRaw : null;
      events.push({
        type: 'RECEIVED',
        providerChargeId: txid,
        providerEventId: endToEndId,
        paidValueCents: cents,
        occurredAt,
        financial: cents !== null && occurredAt ? {
          direction: 'RECEIPT', valueCents: cents, occurredAt,
          economicKey: `efi:receipt:${endToEndId}`, paymentReference: endToEndId, semantics: 'DELTA',
        } : null,
      });
    }
    return events;
  }
}
