import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

const envCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(process.cwd(), '../../../.env'),
];
for (const path of envCandidates) {
  if (existsSync(path)) {
    dotenvConfig({ path });
    break;
  }
}
dotenvConfig();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_NAME: z.string().default('Inbox Flow'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:3001'),
  API_PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  ENCRYPTION_KEY: z.string().min(32),
  SMTP_HOST: z.string().default('smtp.hostinger.com'),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null || v === '') return true;
      if (typeof v === 'boolean') return v;
      return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
    }),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().default('noreply@inboxflow.io'),
  EMAIL_FROM_ADDRESS: z.string().optional().default(''),
  EMAIL_FROM_NAME: z.string().optional().default(''),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('inboxflow'),
  S3_REGION: z.string().default('us-east-1'),
  S3_PUBLIC_URL: z.string().default('http://localhost:9000/inboxflow'),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  DEFAULT_SEND_RATE: z.coerce.number().default(14),
  MAX_RETRY_ATTEMPTS: z.coerce.number().default(3),
  BATCH_SIZE: z.coerce.number().default(100),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  WEBHOOK_BASE_URL: z.string().default('http://localhost:3001'),
  WEBHOOK_SECRET: z.string().optional().default(''),
  ALLOW_PUBLIC_REGISTER: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null || v === '') return false;
      if (typeof v === 'boolean') return v;
      return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
    }),
  ENABLE_API_DOCS: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v === 'boolean') return v;
      return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
    }),
  COOKIE_SECURE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v === 'boolean') return v;
      return ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
    }),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  if (process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
}

export const env = parsed.success
  ? parsed.data
  : (envSchema.parse({
      DATABASE_URL: 'postgresql://inboxflow:inboxflow@localhost:5432/inboxflow',
      JWT_ACCESS_SECRET: 'dev-access-secret-change-me-32chars!!',
      JWT_REFRESH_SECRET: 'dev-refresh-secret-change-me-32chars!',
      ENCRYPTION_KEY: 'dev-encryption-key-32-characters!',
    }) as z.infer<typeof envSchema>);

export type Env = z.infer<typeof envSchema>;
