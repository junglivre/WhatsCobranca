// Porta fiscal (NFS-e). Cobrança e nota fiscal são objetos INDEPENDENTES:
// a nota pode ser emitida sem pagamento, conforme a obrigação fiscal.
// Implementações: 'manual' (pendência para emissão humana — padrão desta
// fase), 'asaas' (Fase 7), 'portal-nacional' (futuro, direto, sem terceiro).

/** Estados fiscais INTERNOS (espelho do CHECK no banco). */
export type InvoiceStatus =
  | 'NOT_REQUESTED'
  | 'AWAITING_DATA'        // faltam dados fiscais do tomador
  | 'READY_FOR_APPROVAL'   // prévia montada, esperando aprovação explícita
  | 'SUBMITTED'            // enviada ao emissor
  | 'PROCESSING'
  | 'AUTHORIZED'           // único estado que significa "nota emitida"
  | 'REJECTED'
  | 'CANCELED'
  | 'NEEDS_REVIEW';

/** Dados fiscais mínimos do tomador para emissão. */
export interface InvoiceCustomerInput {
  name: string;
  cpfCnpj?: string | null;
  email?: string | null;
  address?: {
    street?: string | null;
    number?: string | null;
    district?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | null;
}

export interface InvoiceRequestInput {
  serviceOrderNumber: number;
  /** Referência determinística persistida antes da chamada; permite
   * reconciliação depois de timeout sem emitir a mesma nota duas vezes. */
  externalReference: string;
  customer: InvoiceCustomerInput;
  /** Código de serviço municipal/nacional APROVADO previamente (parametrizado,
   *  nunca fixado em código — ver Regra 8.9 do plano: IBS/CBS 2027). */
  serviceCode: string;
  valueCents: number;
  description: string;
}

export interface InvoiceRequestResult {
  /** null quando o provedor não cria nada externo (ex.: manual). */
  providerInvoiceId: string | null;
  status: InvoiceStatus;
}

export interface InvoiceProvider {
  /** Chave do adapter — gravada em invoices.provider. */
  readonly name: string;

  /**
   * Solicita a emissão. O domínio SEMPRE persiste a intenção (invoices)
   * antes de chamar este método.
   */
  request(input: InvoiceRequestInput): Promise<InvoiceRequestResult>;

  /**
   * Reconciliação pós-timeout: nunca presumir falha; consultar o emissor
   * antes de qualquer nova tentativa.
   */
  getStatus(providerInvoiceId: string): Promise<InvoiceStatus>;

  /**
   * Localiza a solicitação por referência persistida após timeout/5xx.
   * Retorna null somente quando o emissor confirma que nada foi criado.
   */
  findByExternalReference(externalReference: string): Promise<InvoiceRequestResult | null>;

  cancel(providerInvoiceId: string): Promise<void>;
}
