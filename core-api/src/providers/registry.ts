// Registry: o ÚNICO lugar que conhece adapters concretos. O padrão para novas
// cobranças e o conjunto habilitado para histórico são deliberadamente
// separados: trocar BILLING_PROVIDER nunca desliga silenciosamente webhook ou
// cancelamento de uma cobrança já gravada.
import type { Config } from '../config.js';
import type { BillingProvider } from './billing/types.js';
import { ManualBillingProvider } from './billing/manual.js';
import { AsaasBillingProvider } from './billing/asaas.js';
import { EfiBillingProvider } from './billing/efi.js';
import type { InvoiceProvider } from './invoices/types.js';
import { ManualInvoiceProvider } from './invoices/manual.js';

export type BillingProviderName = 'manual' | 'asaas' | 'efi';

function configuredNames(cfg: Config): BillingProviderName[] {
  const explicit = cfg.BILLING_ENABLED_PROVIDERS
    .split(',').map((name) => name.trim()).filter(Boolean);
  const names = explicit.length > 0
    ? explicit
    : (cfg.BILLING_PROVIDER === 'none' ? [] : [cfg.BILLING_PROVIDER]);
  const valid = new Set<BillingProviderName>();
  for (const name of names) {
    if (name !== 'manual' && name !== 'asaas' && name !== 'efi') {
      throw new Error(`BILLING_ENABLED_PROVIDERS contém provider inválido: ${name}`);
    }
    valid.add(name);
  }
  if (cfg.BILLING_PROVIDER !== 'none' && !valid.has(cfg.BILLING_PROVIDER)) {
    throw new Error('BILLING_PROVIDER precisa constar em BILLING_ENABLED_PROVIDERS quando a lista é explícita');
  }
  return [...valid];
}

function providerFor(cfg: Config, name: BillingProviderName): BillingProvider {
  switch (name) {
    case 'manual': return new ManualBillingProvider();
    case 'asaas':
      if (!cfg.ASAAS_API_KEY || !cfg.ASAAS_WEBHOOK_TOKEN) {
        throw new Error('provider Asaas habilitado exige ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN não-vazios');
      }
      return new AsaasBillingProvider(cfg);
    case 'efi':
      if (!cfg.EFI_CLIENT_ID || !cfg.EFI_CLIENT_SECRET || !cfg.EFI_PIX_KEY || !cfg.EFI_WEBHOOK_TOKEN
        || !cfg.EFI_CERT_BASE64 || !cfg.EFI_KEY_BASE64) {
        throw new Error('provider Efí habilitado exige EFI_CLIENT_ID, EFI_CLIENT_SECRET, EFI_PIX_KEY, EFI_WEBHOOK_TOKEN, EFI_CERT_BASE64 e EFI_KEY_BASE64 não-vazios');
      }
      return new EfiBillingProvider(cfg);
  }
}

/** Instancia somente providers explicitamente habilitados. */
export function getBillingProviders(cfg: Config): Map<string, BillingProvider> {
  return new Map(configuredNames(cfg).map((name) => [name, providerFor(cfg, name)]));
}

/** Provider padrão de NOVAS cobranças; null mantém a configuração mínima. */
export function getBillingProvider(cfg: Config): BillingProvider | null {
  if (cfg.BILLING_PROVIDER === 'none') return null;
  return providerFor(cfg, cfg.BILLING_PROVIDER);
}

/** Histórico só opera com adapter habilitado e credenciais verificadas. */
export function getEnabledBillingProvider(cfg: Config, name: string): BillingProvider | null {
  return getBillingProviders(cfg).get(name) ?? null;
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
