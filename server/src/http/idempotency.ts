/**
 * 재전송 안전장치 — 오프라인 큐의 핵심
 *
 * 현장은 통신이 자주 끊긴다. 끊긴 입력은 기기에 쌓아 두었다가 나중에 다시 보내는데,
 * 이때 **같은 요청이 두 번 도착해도 두 번 저장되면 안 된다.**
 * (레미콘 91㎥ 가 182㎥ 가 되는 사고를 막는다)
 *
 * 클라이언트가 만든 요청 ID 를 키로, 처음 처리한 응답을 그대로 돌려준다.
 */
import type { Request } from 'express';
import { z } from 'zod';
import type { SessionClient } from '../db/pool.js';
import { badRequest } from './errors.js';

const uuid = z.string().uuid();

/** 요청 헤더 또는 본문에서 클라이언트 요청 ID 를 꺼낸다. 없으면 null. */
export function requestId(req: Request): string | null {
  const raw = req.header('x-client-request-id')
    ?? (req.body as { client_request_id?: unknown } | undefined)?.client_request_id;
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = uuid.safeParse(raw);
  if (!parsed.success) throw badRequest('client_request_id 는 UUID 여야 합니다.', 'BAD_REQUEST_ID');
  return parsed.data;
}

export interface StoredResponse { status: number; body: unknown }

/** 이미 처리한 요청이면 저장해 둔 응답을 돌려준다. */
export async function findStored(
  c: SessionClient, id: string,
): Promise<StoredResponse | null> {
  const r = await c.query(
    'SELECT status_code, response_body FROM core.idempotency_key WHERE client_request_id=$1', [id]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as { status_code: number; response_body: unknown };
  return { status: row.status_code, body: row.response_body };
}

/**
 * 처리 결과를 기록한다.
 * 같은 트랜잭션 안에서 저장하므로, 본 작업이 롤백되면 이 기록도 함께 사라진다.
 * → 실패한 요청은 재전송하면 다시 시도된다.
 */
export async function remember(
  c: SessionClient, id: string, userId: string | null,
  endpoint: string, status: number, body: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO core.idempotency_key
       (client_request_id, user_id, endpoint, status_code, response_body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (client_request_id) DO NOTHING`,
    [id, userId, endpoint, status, JSON.stringify(body)]);
}
