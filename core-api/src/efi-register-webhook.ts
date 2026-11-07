// Comando de instalação: cadastra na Efí o webhook Pix desta instalação.
//   docker compose run --rm --no-deps core-api \
//     node dist/efi-register-webhook.js https://SEU-DOMINIO-PUBLICO
// Usa as mesmas variáveis EFI_* do serviço (fail-fast do registry se faltar
// credencial). Imprime a URL cadastrada com o token mascarado.
import { config } from './config.js';
import { EfiBillingProvider } from './providers/billing/efi.js';
import { getBillingProvider } from './providers/registry.js';

const publicBaseUrl = process.argv[2];
if (!publicBaseUrl) {
  console.error('uso: node dist/efi-register-webhook.js https://SEU-DOMINIO-PUBLICO');
  process.exit(2);
}
try {
  const provider = getBillingProvider({ ...config(), BILLING_PROVIDER: 'efi' });
  if (!(provider instanceof EfiBillingProvider)) throw new Error('adapter efi indisponível');
  console.log(`webhook Pix cadastrado na Efí: ${await provider.registerWebhook(publicBaseUrl)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
