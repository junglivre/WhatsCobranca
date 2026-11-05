import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8080),
  WAHA_WEBHOOK_SECRET: z.string().min(16),
  AUTOMATION_TOKEN: z.string().min(16),
  WAHA_BASE_URL: z.string().url(),
  WAHA_API_KEY: z.string().min(1),
  WAHA_SESSION: z.string().min(1).default('default'),
  OPERATOR_LID: z.string().min(1),
  OPERATOR_PHONE: z.string().min(1),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().max(1048576).default(131072),
  // Groq é opcional: sem chave, mensagens de áudio recebem resposta
  // determinística informando que o recurso não está configurado.
  GROQ_API_KEY: z.string().trim().default(''),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  GROQ_STT_MODEL: z.string().min(1).default('whisper-large-v3'),
  GROQ_LLM_MODEL: z.string().min(1).default('llama-3.3-70b-versatile'),
  WAHA_MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(16777216),
  // Fase 6 — financeiro plugável. 'none' desliga a cobrança automática (o
  // comando 'recebi' continua registrando recebimento externo via provider
  // manual); 'asaas' exige ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN (registry
  // falha no boot se faltar).
  BILLING_PROVIDER: z.enum(['none', 'manual', 'asaas']).default('none'),
  ASAAS_API_KEY: z.string().trim().default(''),
  ASAAS_BASE_URL: z.string().url().default('https://api-sandbox.asaas.com/v3'),
  ASAAS_WEBHOOK_TOKEN: z.string().trim().default(''),
  // Fase 6 — porta fiscal: só o adapter 'manual' (pendência para emissão
  // humana) existe nesta fase; fluxo de conversa fiscal é Fase 7.
  INVOICE_PROVIDER: z.enum(['none', 'manual']).default('none'),
});
export type Config = z.infer<typeof schema>;
export const config = (env = process.env): Config => schema.parse(env);
