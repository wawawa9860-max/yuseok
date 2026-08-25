import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../auth/token.js';
import { forbidden, unauthorized } from './errors.js';
import { pool, type AppRole, type SessionActor } from '../db/pool.js';

declare module 'express-serve-static-core' {
  interface Request { actor?: SessionActor & { name: string } }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    const p = verifyToken(header.slice(7));
    req.actor = { userId: p.sub, role: p.role, name: p.name };
    next();
  } catch {
    next(unauthorized('인증 토큰이 유효하지 않습니다.'));
  }
}

/**
 * 역할 게이트. 단, 이것은 1차 방어선일 뿐이다.
 * 최종 차단은 DB 역할 GRANT + RLS 에서 이루어진다 (§29).
 */
export function requireRole(...roles: AppRole[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const actor = req.actor;
    if (!actor) return next(unauthorized());
    if (!roles.includes(actor.role)) {
      await logAccessDenied(req, `역할 ${actor.role} 는 ${roles.join('/')} 전용 자원에 접근할 수 없습니다.`);
      return next(forbidden());
    }
    next();
  };
}

/** §43 : 외부 사용자의 PRIVATE_COST 접근시도를 기록한다. */
export async function logAccessDenied(req: Request, reason: string): Promise<void> {
  const actor = req.actor;
  try {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE rfcip_head_office');
      await client.query(
        `INSERT INTO audit.access_denied_log (user_id, role_name, method, path, reason, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [actor?.userId ?? null, actor?.role ?? 'ANONYMOUS', req.method,
         req.originalUrl, reason, req.ip ?? null],
      );
      await client.query('RESET ROLE');
    } finally {
      client.release();
    }
  } catch {
    // 로깅 실패가 요청 처리를 막지 않는다.
  }
}
