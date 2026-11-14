// Porta de cobrança (billing). O domínio SÓ conhece estes tipos — nunca
// payloads ou status crus de um provedor. Cada adapter traduz o provedor
// para este vocabulário. Para adicionar um provedor novo, implemente esta
// interface + registre em registry.ts (ver README, seção Integrações).
import { timingSafeEqual } from 'node:crypto';

/** Compara token de webhook sem revelar prefixo/tamanho útil ao caller. */
export function safeSecretEqual(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Conversão decimal exata usada somente nos adapters (reais -> centavos). */
export function decimalToCents(value: unknown): number | null {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(`${whole}${fraction.padEnd(2, '0')}`);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 2_147_483_647 ? cents : null;
}

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
  /** URL do PDF do boleto, quando o provedor devolve na própria criação
   *  (ex.: Asaas `bankSlipUrl`). null/undefined quando não suportado. */
  boletoUrl?: string | null;
}

export interface ProviderChargeSnapshot {
  status: ChargeStatus;
  paidValueCents: number | null;
  /** Dados só presentes quando o gateway realmente os comprova. */
  financialAt?: string | null;
  paymentReference?: string | null;
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

export type FinancialEvent = {
  direction: 'RECEIPT' | 'REFUND';
  /** Sempre positivo e já convertido para centavos pelo adapter. */
  valueCents: number;
  /** ISO-8601 fornecido pelo gateway; nunca é inferido pelo domínio. */
  occurredAt: string;
  /** Efeito econômico estável (Pix e2e, id de devolução, pagamento Asaas). */
  economicKey: string;
  paymentReference: string;
  /** Snapshots cumulativos inserem somente a diferença positiva no worker. */
  semantics: 'DELTA' | 'CUMULATIVE';
};

export interface NormalizedBillingEvent {
  /** ID único do evento NO PROVEDOR — base da deduplicação. */
  providerEventId: string;
  providerChargeId: string;
  type: BillingEventType;
  paidValueCents?: number | null;
  occurredAt?: string | null;
  financial?: FinancialEvent | null;
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

/** Rejeição determinística: a data/método está fora do contrato do gateway. */
export class ProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

/**
 * O provedor rejeitou a operação porque o cliente não tem CPF/CNPJ
 * cadastrado (ex.: Asaas exige o documento do pagador para criar cobrança).
 * Erro DETERMINÍSTICO: não adianta reconciliar nem reenviar sem antes
 * atualizar o cadastro do cliente (comando `cpf <nome> <documento>`).
 */
export class MissingFiscalIdError extends Error {
  constructor(message = 'provider requires customer CPF/CNPJ') {
    super(message);
    this.name = 'MissingFiscalIdError';
  }
}

/**
 * O provedor não suporta o método pedido (ex.: boleto num adapter só-Pix).
 * Rejeição determinística: nada foi criado — o domínio orienta o operador
 * sem reconciliar nem reenviar.
 */
export class UnsupportedMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMethodError';
  }
}

export interface BillingProvider {
  /** Chave do adapter — gravada em charges.provider. Ex.: 'asaas', 'manual'. */
  readonly name: string;

  /** Garante o cliente no provedor; retorna o external_id (idempotente). */
  ensureCustomer(input: ChargeCustomerInput): Promise<string>;

  /**
   * Atualiza o cadastro do cliente no provedor (idempotente). Chamado antes
   * de createCharge quando o domínio tem dados novos (ex.: cpfCnpj) — o
   * Asaas rejeita cobrança de cliente sem CPF/CNPJ.
   */
  updateCustomer(externalId: string, input: ChargeCustomerInput): Promise<void>;

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
   * Lança WebhookAuthError se inválido. Retorna lista vazia quando o corpo
   * não traz nenhum evento de cobrança (ex.: transferência, notificação de
   * teste do cadastro) — o caller responde 200 e ignora. Uma única chamada
   * pode trazer VÁRIOS eventos (ex.: Efí agrupa Pix em `pix[]`); cada um
   * vira uma linha deduplicada por `providerEventId`.
   */
  validateAndNormalizeWebhook(
    headers: Record<string, string | string[] | undefined>,
    query: Record<string, string | string[] | undefined>,
    rawBody: unknown,
  ): NormalizedBillingEvent[];
}
