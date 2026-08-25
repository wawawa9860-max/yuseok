import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  ADMIN_DATABASE_URL: z.string().min(1),
  DATABASE_NAME: z.string().min(1).default('rfcip'),
  DATABASE_URL: z.string().min(1),
  APP_DB_USER: z.string().min(1).default('rfcip_app'),
  APP_DB_PASSWORD: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 은 32자 이상이어야 합니다.'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  PORT: z.coerce.number().int().positive().default(3000),
  STORAGE_BACKEND: z.enum(['LOCAL', 'S3', 'GCS', 'AZURE']).default('LOCAL'),
  STORAGE_LOCAL_ROOT: z.string().default('../storage'),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
