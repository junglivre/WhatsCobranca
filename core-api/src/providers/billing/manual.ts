// Adapter de cobrança 'manual': nenhum HTTP, nenhum provedor externo.
// Representa dinheiro que JÁ entrou fora do sistema (dinheiro em espécie,
// Pix feito direto na conta): toda cobrança criada nasce RECEIVED.
//
// Este é o ADAPTER DE REFERÊNCIA para quem plugar um provedor novo:
// implemente BillingProvider (types.ts), registre em registry.ts e pronto —
// o domínio nunca fala com o provedor diretamente.
import { randomUUID } from 'node:crypto';
import type {
  BillingProvider, ChargeCustomerInput, CreateChargeInput, CreatedCharge,
  NormalizedBillingEvent, PixData, ProviderChargeSnapshot,
} from './types.js';

export class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';

  /** Sem provedor externo: a "referência" é derivada do id interno. */
  async ensureCustomer(input: ChargeCustomerInput): Promise<string> {
    return `manual-${input.customerId}`;
  }

  /** Sem provedor externo, não há cadastro a atualizar: no-op. */
  async updateCustomer(_externalId: string, _input: ChargeCustomerInput): Promise<void> {}

  /** O pagamento externo já aconteceu — nasce RECEIVED. */
  async createCharge(input: CreateChargeInput): Promise<CreatedCharge> {
    void input;
    return { providerChargeId: `manual-charge-${randomUUID()}`, status: 'RECEIVED' };
  }

  async getCharge(_providerChargeId: string): Promise<ProviderChargeSnapshot> {
    return { status: 'RECEIVED', paidValueCents: null };
  }

  /** Nada externo a reconciliar: timeout aqui é impossível. */
  async findByExternalReference(_ref: string): Promise<CreatedCharge | null> {
    return null;
  }

  async getPixData(_providerChargeId: string): Promise<PixData> {
    throw new Error('manual provider has no pix');
  }

  /** Cancelamento manual é no-op: o banco já marca CANCELED. */
  async cancelCharge(_providerChargeId: string): Promise<void> {}

  /** Provedor manual não envia webhooks. */
  validateAndNormalizeWebhook(
    _headers: Record<string, string | string[] | undefined>,
    _rawBody: unknown,
  ): NormalizedBillingEvent | null {
    return null;
  }
}
