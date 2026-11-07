// Guarda de contrato: toda variável do schema de core-api/src/config.ts precisa
// ser repassada pelo `environment` do serviço core-api em docker-compose.yml.
// O Compose NÃO repassa o .env inteiro ao container — uma variável esquecida
// vira "configuração que o operador altera e nada acontece" (bug real: as
// REPORT* e EFI_* da Fase 8/Efí ficaram de fora e o .env era ignorado).
import { readFileSync } from 'node:fs';

// Chaves intencionalmente fora do compose (default fixo do container).
const INTERNAL = new Set(['PORT', 'BODY_LIMIT_BYTES']);

const configSource = readFileSync(new URL('../core-api/src/config.ts', import.meta.url), 'utf8');
const schemaBody = /const schema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(configSource)?.[1];
if (!schemaBody) throw new Error('não encontrei z.object({...}) em config.ts');
const configKeys = [...schemaBody.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]);

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const coreApi = /^ {2}core-api:\n([\s\S]*?)^ {2}\S/m.exec(compose)?.[1];
if (!coreApi) throw new Error('não encontrei o serviço core-api em docker-compose.yml');
const environment = /^ {4}environment:\n((?: {6}.*\n)+)/m.exec(coreApi)?.[1];
if (!environment) throw new Error('não encontrei environment do core-api');
const composeKeys = new Set([...environment.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]));

const missing = configKeys.filter((key) => !composeKeys.has(key) && !INTERNAL.has(key));
const unknown = [...composeKeys].filter((key) => !configKeys.includes(key));
if (missing.length > 0) {
  console.error(`config.ts declara variáveis que o compose não repassa ao core-api: ${missing.join(', ')}`);
}
if (unknown.length > 0) {
  console.error(`compose repassa variáveis que config.ts não conhece: ${unknown.join(', ')}`);
}
if (missing.length > 0 || unknown.length > 0) process.exit(1);
console.log(`compose-env OK: ${configKeys.length - INTERNAL.size} variáveis de config repassadas ao core-api`);
