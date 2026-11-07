// Registry: o ÚNICO lugar que conhece os adapters concretos. O domínio e as
// rotas pedem o provider por aqui e falam só com as portas (types.ts de cada
// pasta) — trocar de provedor é mudar config, nunca o domínio.
import type { Config } from '../config.js';
import type { BillingProvider } from './billing/types.js';
import { ManualBillingProvider } from './billing/manual.js';
import { AsaasBillingProvider } from './billing/asaas.js';
import { EfiBillingProvider } from './billing/efi.js';
import type { InvoiceProvider } from './invoices/types.js';
import { ManualInvoiceProvider } from './invoices/manual.js';

/** null quando BILLING_PROVIDER=none (cobrança automática desligada). */
export function getBillingProvider(cfg: Config): BillingProvider | null {
  switch (cfg.BILLING_PROVIDER) {
    case 'none':
      return null;
    case 'manual':
      return new ManualBillingProvider();
    case 'asaas':
      // Fail-fast no boot: credencial faltando é erro de operação, não de runtime.
      if (!cfg.ASAAS_API_KEY || !cfg.ASAAS_WEBHOOK_TOKEN) {
        throw new Error('BILLING_PROVIDER=asaas exige ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN não-vazios');
      }
      return new AsaasBillingProvider(cfg);
    case 'efi':
      if (!cfg.EFI_CLIENT_ID || !cfg.EFI_CLIENT_SECRET || !cfg.EFI_PIX_KEY || !cfg.EFI_WEBHOOK_TOKEN) {
        throw new Error('BILLING_PROVIDER=efi exige EFI_CLIENT_ID, EFI_CLIENT_SECRET, EFI_PIX_KEY e EFI_WEBHOOK_TOKEN não-vazios');
      }
      return new EfiBillingProvider(cfg);
  }
}

/** null quando INVOICE_PROVIDER=none. */
export function getInvoiceProvider(cfg: Config): InvoiceProvider | null {
  switch (cfg.INVOICE_PROVIDER) {
    case 'none':
      return null;
    case 'manual':
      return new ManualInvoiceProvider();
  }
}
