// Porta de cobrança (billing). O domínio SÓ conhece estes tipos — nunca
// payloads ou status crus de um provedor. Cada adapter traduz o provedor
// para este vocabulário. Para adicionar um provedor novo, implemente esta
// interface + registre em registry.ts (ver README, seção Integrações).

/** Métodos de cobrança suportados pelo domínio (espelho do CHECK no banco). */
export type ChargeMethod = 'PIX' | 'BOLETO' | 'CASH' | 'EXTERNAL_PIX';

/**
 * Estados financeiros INTERNOS. Não presumir equivalência exata com os
 * estados de nenhum provedor — o adapter mapeia e documenta o mapeamento.
 */
export type ChargeStatus =
  | 'DRAFT'           // intenção persistida, ainda não enviada ao provedor
  | 'PENDING'         // criada no provedor, aguardando pagamento
  | 'OVERDUE'         // vencida e ainda pendente
  | 'CONFIRMED'       // pagamento identificado, ainda NÃO é saldo disponível
  | 'RECEIVED'        // recebido/liquidado — único estado que conta como dinheiro
  | 'PARTIALLY_PAID'
  | 'CANCELED'
  | 'REFUNDED'
  | 'ERROR';

export interface ChargeCustomerInput {
  /** UUID interno do cliente — vai em externalReference do cliente no provedor. */
  customerId: string;
  name: string;
  cpfCnpj?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface CreateChargeInput {
  /** external_id do cliente JÁ resolvido via ensureCustomer. */
  providerCustomerId: string;
  method: ChargeMethod;
  valueCents: number;
  /** YYYY-MM-DD (dia de calendário America/Sao_Paulo). */
  dueDate: string;
  description: string;
  /** 'OS-<numero>-C<seq>' — chave de reconciliação de timeout. */
  externalReference: string;
}

export interface CreatedCharge {
  providerChargeId: string;
  status: ChargeStatus;
}

export interface ProviderChargeSnapshot {
  status: ChargeStatus;
  paidValueCents: number | null;
}

export interface PixData {
  /** BR Code copia-e-cola. */
  copyPaste: string;
  /** URL ou data-URL da imagem QR, quando o provedor oferece. */
  qrImageUrl?: string | null;
  expirationDate?: string | null;
}

/** Tipos de evento normalizados de webhook. */
export type BillingEventType =
  | 'CREATED' | 'CONFIRMED' | 'RECEIVED' | 'OVERDUE'
  | 'CANCELED' | 'REFUNDED' | 'PARTIAL' | 'OTHER';

export interface NormalizedBillingEvent {
  /** ID único do evento NO PROVEDOR — base da deduplicação. */
  providerEventId: string;
  providerChargeId: string;
  type: BillingEventType;
  paidValueCents?: number | null;
  occurredAt?: string | null;
}

export class WebhookAuthError extends Error {
  constructor(message = 'webhook authentication failed') {
    super(message);
    this.name = 'WebhookAuthError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(message = 'provider call timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export interface BillingProvider {
  /** Chave do adapter — gravada em charges.provider. Ex.: 'asaas', 'manual'. */
  readonly name: string;

  /** Garante o cliente no provedor; retorna o external_id (idempotente). */
  ensureCustomer(input: ChargeCustomerInput): Promise<string>;

  createCharge(input: CreateChargeInput): Promise<CreatedCharge>;

  /** Estado atual da cobrança no provedor (reconciliação). */
  getCharge(providerChargeId: string): Promise<ProviderChargeSnapshot>;

  /**
   * Busca por externalReference — OBRIGATÓRIO para reconciliar timeout:
   * após ProviderTimeoutError na criação, consultar ANTES de reenviar.
   */
  findByExternalReference(ref: string): Promise<CreatedCharge | null>;

  /** Dados Pix (copia-e-cola + QR). Só precisa existir se method PIX é suportado. */
  getPixData(providerChargeId: string): Promise<PixData>;

  cancelCharge(providerChargeId: string): Promise<void>;

  /**
   * Valida a autenticidade do webhook (token/assinatura) e normaliza.
   * Lança WebhookAuthError se inválido. Retorna null quando o evento não
   * se refere a uma cobrança (ex.: evento de transferência) — o caller
   * responde 200 e ignora.
   */
  validateAndNormalizeWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: unknown,
  ): NormalizedBillingEvent | null;
}
