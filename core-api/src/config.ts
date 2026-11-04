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
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().max(1048576).default(131072)
});
export type Config = z.infer<typeof schema>;
export const config = (env = process.env): Config => schema.parse(env);
