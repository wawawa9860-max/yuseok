import pg from 'pg';
import { env } from '../config/env.js';

/**
 * 수량·금액은 문자열로 받아 애플리케이션에서 결정론적으로 다룬다 (§46).
 * float 변환으로 인한 오차를 만들지 않는다.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export type AppRole = 'HEAD_OFFICE' | 'FIELD_MANAGER' | 'EXTERNAL';

const DB_ROLE: Record<AppRole, string> = {
  HEAD_OFFICE: 'rfcip_head_office',
  FIELD_MANAGER: 'rfcip_field_manager',
  EXTERNAL: 'rfcip_external',
};

export interface SessionActor {
  userId: string | null;
  role: AppRole;
}

export interface SessionClient {
  query: pg.ClientBase['query'];
}

/**
 * 모든 요청은 이 함수를 통해서만 DB에 접근한다.
 *
 * 1) 트랜잭션마다 DB 역할을 강등한다 (SET LOCAL ROLE).
 *    → 애플리케이션 코드에 버그가 있어도 DB가 마지막 방어선이 된다 (§29).
 * 2) app.user_id / app.role GUC 를 주입한다 → RLS 정책의 기준값.
 */
export async function withSession<T>(
  actor: SessionActor,
  fn: (client: SessionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${DB_ROLE[actor.role]}`);
    await client.query("SELECT set_config('app.user_id', $1, true)", [actor.userId ?? '']);
    await client.query("SELECT set_config('app.role', $1, true)", [actor.role]);
    const result = await fn(client as unknown as SessionClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 인증(로그인) 단계 전용.
 * 아직 인증된 사용자가 없으므로 최소권한 역할(EXTERNAL)로 접속하고,
 * 로그인 조회는 SECURITY DEFINER 함수(app.fn_login_lookup)만 사용한다.
 * 절대 본사 권한으로 승격하지 않는다.
 */
export async function withAuthLookup<T>(fn: (client: SessionClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE rfcip_external');
    await client.query("SELECT set_config('app.role', 'ANONYMOUS', true)");
    const result = await fn(client as unknown as SessionClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
