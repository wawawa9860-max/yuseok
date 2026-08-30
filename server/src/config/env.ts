import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  ADMIN_DATABASE_URL: z.string().min(1),
  DATABASE_NAME: z.string().min(1).default('rfcip'),
  /** 비우면 ADMIN_DATABASE_URL 의 호스트로 자동 조립한다 (클라우드 배포 단순화) */
  DATABASE_URL: z.string().optional(),
  APP_DB_USER: z.string().min(1).default('rfcip_app'),
  APP_DB_PASSWORD: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 은 32자 이상이어야 합니다.'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  PORT: z.coerce.number().int().positive().default(3000),
  STORAGE_BACKEND: z.enum(['LOCAL', 'S3', 'GCS', 'AZURE']).default('LOCAL'),
  STORAGE_LOCAL_ROOT: z.string().default('../storage'),
});

const parsed = schema.parse(process.env);

/*
 * 클라우드 배포 단순화 (PHASE 15).
 * 비전문가가 접속 URL 을 손으로 조립하는 일이 없도록,
 * DATABASE_URL 을 비우면 ADMIN_DATABASE_URL 의 호스트/포트에
 * 앱 계정(rfcip_app)과 앱 DB 이름을 끼워 자동으로 만든다.
 */
function deriveAppUrl(): string {
  if (parsed.DATABASE_URL) return parsed.DATABASE_URL;
  const u = new URL(parsed.ADMIN_DATABASE_URL);
  u.username = parsed.APP_DB_USER;
  u.password = parsed.APP_DB_PASSWORD;
  u.pathname = `/${parsed.DATABASE_NAME}`;
  return u.toString();
}

export const env = { ...parsed, DATABASE_URL: deriveAppUrl() };
export type Env = typeof env;

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
  // Railway/Render 는 배포 도메인을 환경변수로 준다 — 있으면 자동으로 쓴다
  if (!process.env.PUBLIC_BASE_URL) {
    const auto = process.env.RAILWAY_PUBLIC_DOMAIN ?? process.env.RENDER_EXTERNAL_HOSTNAME;
    if (auto) process.env.PUBLIC_BASE_URL = `https://${auto}`;
    else leaks.push('PUBLIC_BASE_URL(카카오톡 링크 도메인)');
  }
  if (leaks.length > 0) {
    // eslint 없음 — 콘솔로 이유를 말하고 멈춘다. 조용히 뜨는 것보다 낫다.
    console.error(
      `\n  운영(NODE_ENV=production)에서는 다음 값을 실제 값으로 바꿔야 합니다:\n`
      + leaks.map((l) => `    · ${l}`).join('\n')
      + `\n  .env 를 수정한 뒤 다시 시작해 주십시오. (docs/PILOT_GUIDE.md 2단계)\n`);
    process.exit(1);
  }
}
