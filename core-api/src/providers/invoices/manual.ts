// Adapter fiscal 'manual': nenhum emissor externo. Toda solicitação vira
// NEEDS_REVIEW — pendência para emissão humana no Portal Nacional de NFS-e.
//
// ADAPTER DE REFERÊNCIA da porta fiscal: um futuro PortalNacionalProvider
// (direto, sem terceiro) ou AsaasInvoiceProvider (Fase 7) implementa esta
// mesma interface sem que o domínio precise mudar.
import type {
  InvoiceProvider, InvoiceRequestInput, InvoiceRequestResult, InvoiceStatus,
} from './types.js';

export class ManualInvoiceProvider implements InvoiceProvider {
  readonly name = 'manual';

  /** Nada é criado fora: a pendência fica registrada em invoices. */
  async request(input: InvoiceRequestInput): Promise<InvoiceRequestResult> {
    void input;
    return { providerInvoiceId: null, status: 'NEEDS_REVIEW' };
  }

  async getStatus(_providerInvoiceId: string): Promise<InvoiceStatus> {
    return 'NEEDS_REVIEW';
  }

  async findByExternalReference(_externalReference: string): Promise<InvoiceRequestResult | null> {
    return null;
  }

  /** Sem emissor externo, cancelar é no-op (o banco marca CANCELED). */
  async cancel(_providerInvoiceId: string): Promise<void> {}
}
