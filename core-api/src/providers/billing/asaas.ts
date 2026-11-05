// Adapter Asaas (API v3). ÚNICO ponto do código que fala com asaas.com:
// o domínio só conhece a porta BillingProvider (types.ts). Status crus do
// Asaas são traduzidos aqui para o vocabulário interno e NUNCA persistidos.
//
// Mapa de status Asaas → interno (charge/payment.status):
//   PENDING             → PENDING
//   CONFIRMED           → CONFIRMED
//   RECEIVED,
//   RECEIVED_IN_CASH    → RECEIVED
//   OVERDUE             → OVERDUE
//   REFUNDED,
//   REFUND_REQUESTED    → REFUNDED
//   DELETED             → CANCELED
//   qualquer outro      → PENDING (conservador: não presume pagamento)
//
// Mapa de eventos de webhook → interno:
//   PAYMENT_CREATED   → CREATED
//   PAYMENT_CONFIRMED → CONFIRMED
//   PAYMENT_RECEIVED  → RECEIVED
//   PAYMENT_OVERDUE   → OVERDUE
//   PAYMENT_DELETED   → CANCELED
//   PAYMENT_REFUNDED  → REFUNDED
//   desconhecido      → OTHER
//
// Dinheiro: o Asaas trabalha em reais (Number); a conversão centavos→reais
// acontece SÓ aqui ((cents/100).toFixed(2) → Number), e reais→centavos na
// volta com Math.round(value*100).
import type { Config } from '../../config.js';
import type {
  BillingProvider, ChargeCustomerInput, ChargeStatus, CreateChargeInput,
  CreatedCharge, NormalizedBillingEvent, PixData, ProviderChargeSnapshot,
} from './types.js';
import { ProviderTimeoutError, WebhookAuthError } from './types.js';
import type { BillingEventType } from './types.js';

const TIMEOUT_MS = 10_000;

function mapStatus(status: unknown): ChargeStatus {
  switch (status) {
    case 'CONFIRMED': return 'CONFIRMED';
    case 'RECEIVED':
    case 'RECEIVED_IN_CASH': return 'RECEIVED';
    case 'OVERDUE': return 'OVERDUE';
    case 'REFUNDED':
    case 'REFUND_REQUESTED': return 'REFUNDED';
    case 'DELETED': return 'CANCELED';
    case 'PENDING':
    default: return 'PENDING';
  }
}

export class AsaasBillingProvider implements BillingProvider {
  readonly name = 'asaas';

  constructor(private readonly cfg: Config) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.cfg.ASAAS_BASE_URL}${path}`, {
        method,
        headers: {
          access_token: this.cfg.ASAAS_API_KEY,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new ProviderTimeoutError(`asaas ${method} ${path} timed out`);
      }
      throw error;
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      // NUNCA incluir headers nem credenciais no erro — só status e corpo truncado.
      throw new Error(`asaas ${method} ${path} failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Idempotente: reusa cliente existente pela externalReference (id interno). */
  async ensureCustomer(input: ChargeCustomerInput): Promise<string> {
    const found = await this.request<{ data?: Array<{ id?: string }> }>(
      'GET', `/customers?externalReference=${encodeURIComponent(input.customerId)}`,
    );
    const existing = found.data?.[0]?.id;
    if (existing) return existing;
    const created = await this.request<{ id: string }>('POST', '/customers', {
      name: input.name,
      externalReference: input.customerId,
      ...(input.cpfCnpj ? { cpfCnpj: input.cpfCnpj } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.phone ? { mobilePhone: input.phone } : {}),
    });
    return created.id;
  }

  async createCharge(input: CreateChargeInput): Promise<CreatedCharge> {
    // CASH/EXTERNAL_PIX nunca chegam aqui — o domínio usa o provider manual.
    const body = await this.request<{ id: string; status?: string }>('POST', '/payments', {
      customer: input.providerCustomerId,
      billingType: input.method === 'PIX' ? 'PIX' : 'BOLETO',
      value: Number((input.valueCents / 100).toFixed(2)),
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.externalReference,
    });
    return { providerChargeId: body.id, status: mapStatus(body.status) };
  }

  async getCharge(providerChargeId: string): Promise<ProviderChargeSnapshot> {
    const body = await this.request<{ status?: string; value?: number }>(
      'GET', `/payments/${encodeURIComponent(providerChargeId)}`,
    );
    return {
      status: mapStatus(body.status),
      paidValueCents: typeof body.value === 'number' ? Math.round(body.value * 100) : null,
    };
  }

  /** OBRIGATÓRIO para reconciliar timeout: consultar ANTES de qualquer retry. */
  async findByExternalReference(ref: string): Promise<CreatedCharge | null> {
    const found = await this.request<{ data?: Array<{ id?: string; status?: string }> }>(
      'GET', `/payments?externalReference=${encodeURIComponent(ref)}`,
    );
    const payment = found.data?.[0];
    if (!payment?.id) return null;
    return { providerChargeId: payment.id, status: mapStatus(payment.status) };
  }

  async getPixData(providerChargeId: string): Promise<PixData> {
    const body = await this.request<{ payload?: string; encodedImage?: string; expirationDate?: string }>(
      'GET', `/payments/${encodeURIComponent(providerChargeId)}/pixQrCode`,
    );
    return {
      copyPaste: body.payload ?? '',
      qrImageUrl: body.encodedImage ? `data:image/png;base64,${body.encodedImage}` : null,
      expirationDate: body.expirationDate ?? null,
    };
  }

  async cancelCharge(providerChargeId: string): Promise<void> {
    await this.request('DELETE', `/payments/${encodeURIComponent(providerChargeId)}`);
  }

  validateAndNormalizeWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: unknown,
  ): NormalizedBillingEvent | null {
    const header = headers['asaas-access-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (token !== this.cfg.ASAAS_WEBHOOK_TOKEN) throw new WebhookAuthError();
    const body = rawBody as {
      id?: unknown;
      event?: unknown;
      payment?: { id?: unknown; value?: unknown } | null;
    } | null;
    const paymentId = typeof body?.payment?.id === 'string' ? body.payment.id : null;
    if (!paymentId) return null; // evento não relacionado a cobrança: caller responde 200 e ignora
    const eventName = typeof body?.event === 'string' ? body.event : '';
    const type: BillingEventType = (() => {
      switch (eventName) {
        case 'PAYMENT_CREATED': return 'CREATED';
        case 'PAYMENT_CONFIRMED': return 'CONFIRMED';
        case 'PAYMENT_RECEIVED': return 'RECEIVED';
        case 'PAYMENT_OVERDUE': return 'OVERDUE';
        case 'PAYMENT_DELETED': return 'CANCELED';
        case 'PAYMENT_REFUNDED': return 'REFUNDED';
        default: return 'OTHER';
      }
    })();
    const providerEventId = typeof body?.id === 'string' && body.id.length > 0
      ? body.id
      : `${eventName}:${paymentId}`; // dedup determinístico quando o provedor omite o id do evento
    const value = body?.payment?.value;
    return {
      providerEventId,
      providerChargeId: paymentId,
      type,
      paidValueCents: typeof value === 'number' ? Math.round(value * 100) : null,
    };
  }
}
