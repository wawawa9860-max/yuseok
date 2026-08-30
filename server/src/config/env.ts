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

/*
 * 운영 안전장치 (PHASE 15 Pilot).
 * 개발용 기본 비밀번호·시크릿을 그대로 두고 운영에 올리는 사고를 서버가 막는다.
 * 실제 현장 데이터(원가 포함)가 들어가는 순간부터는 봐줄 수 없는 문제다 (§29).
 */
const DEV_DEFAULTS = ['local-dev-secret-key-at-least-32-characters', 'local-dev-password',
                      'rfcip-local', 'rfcip-local-app'];
if (process.env.NODE_ENV === 'production') {
  const leaks: string[] = [];
  if (DEV_DEFAULTS.includes(env.JWT_SECRET)) leaks.push('JWT_SECRET');
  if (DEV_DEFAULTS.includes(env.APP_DB_PASSWORD)) leaks.push('APP_DB_PASSWORD');
  if (!process.env.PUBLIC_BASE_URL) leaks.push('PUBLIC_BASE_URL(카카오톡 링크 도메인)');
  if (leaks.length > 0) {
    // eslint 없음 — 콘솔로 이유를 말하고 멈춘다. 조용히 뜨는 것보다 낫다.
    console.error(
      `\n  운영(NODE_ENV=production)에서는 다음 값을 실제 값으로 바꿔야 합니다:\n`
      + leaks.map((l) => `    · ${l}`).join('\n')
      + `\n  .env 를 수정한 뒤 다시 시작해 주십시오. (docs/PILOT_GUIDE.md 2단계)\n`);
    process.exit(1);
  }
}
