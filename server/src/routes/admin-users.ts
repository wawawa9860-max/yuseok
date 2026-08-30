/**
 * 계정 관리 (본사 전용) — PHASE 15 운영 보완
 *
 * "전체적으로 어떤 파일을 들어가서 어떻게 셋팅하는지 이해가 안 간다" (사용자, 2026-08-30)
 * → 파일을 만질 일이 없어야 한다. 계정 생성·비밀번호 재설정·중지 전부 웹 화면에서 한다.
 *   psql 도, 시드 파일도 필요 없다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';
import { hashPassword } from '../auth/password.js';

export const adminUserRouter = Router();
adminUserRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const uuid = z.string().uuid();
/** 아이디는 단순하게 — 현장에서 부르기 쉬운 짧은 영문/숫자 */
const loginId = z.string().regex(/^[a-z0-9_-]{3,30}$/,
  '아이디는 영문 소문자·숫자 3~30자입니다.');
const password = z.string().min(8, '비밀번호는 8자 이상입니다.').max(100);

adminUserRouter.get('/', async (req, res, next) => {
  try {
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT u.id, u.login_id, u.display_name, u.phone, u.role, u.is_active,
                u.last_login_at,
                COALESCE((SELECT array_agg(s.site_name ORDER BY s.site_name)
                            FROM core.user_site_access a
                            JOIN core.site s ON s.id = a.site_id
                           WHERE a.user_id = u.id), '{}') AS sites
           FROM core.app_user u
          ORDER BY u.role, u.login_id`);
      return r.rows;
    });
    res.json({ users: rows, count: rows.length });
  } catch (e) { next(e); }
});

adminUserRouter.post('/', async (req, res, next) => {
  try {
    const p = z.object({
      login_id: loginId,
      password,
      display_name: z.string().min(1).max(50),
      phone: z.string().max(20).nullish(),
      role: z.enum(['HEAD_OFFICE', 'FIELD_MANAGER', 'EXTERNAL']),
      /** 현장관리자면 바로 현장을 배정할 수 있다 (한 번에 끝낸다) */
      site_ids: z.array(uuid).max(20).nullish(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '계정 정보가 올바르지 않습니다.');
    const d = p.data;

    const hash = await hashPassword(d.password);
    const row = await withSession(req.actor!, async (c) => {
      const dup = await c.query('SELECT 1 FROM core.app_user WHERE login_id=$1', [d.login_id]);
      if (dup.rowCount) throw badRequest('이미 있는 아이디입니다.', 'DUPLICATE_LOGIN_ID');
      const r = await c.query(
        `INSERT INTO core.app_user (login_id, password_hash, display_name, phone, role)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, login_id, display_name, role, is_active`,
        [d.login_id, hash, d.display_name, d.phone ?? null, d.role]);
      for (const siteId of d.site_ids ?? []) {
        await c.query(
          `INSERT INTO core.user_site_access (user_id, site_id, granted_by)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [r.rows[0]!.id, siteId, req.actor!.userId]);
      }
      return r.rows[0];
    });
    res.status(201).json({ user: row });
  } catch (e) { next(e); }
});

/** 비밀번호 재설정 — 현장관리자가 잊었을 때 본사가 새로 정해준다 */
adminUserRouter.post('/:userId/reset-password', async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    const p = z.object({ password }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '비밀번호가 올바르지 않습니다.');
    const hash = await hashPassword(p.data.password);
    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE core.app_user SET password_hash=$2 WHERE id=$1
         RETURNING id, login_id`, [userId, hash]);
      return r.rows[0];
    });
    if (!row) throw notFound('계정을 찾을 수 없습니다.');
    res.json({ ok: true, login_id: row.login_id });
  } catch (e) { next(e); }
});

/** 중지/재개 — 퇴사자 계정은 지우지 않고 중지한다 (§38 기록 보존) */
adminUserRouter.patch('/:userId', async (req, res, next) => {
  try {
    const userId = uuid.parse(req.params.userId);
    const p = z.object({ is_active: z.boolean() }).safeParse(req.body);
    if (!p.success) throw badRequest('활성 여부가 필요합니다.');
    // 마지막 본사 계정을 스스로 잠그는 사고를 막는다
    const row = await withSession(req.actor!, async (c) => {
      if (!p.data.is_active) {
        const others = await c.query(
          `SELECT count(*)::int AS n FROM core.app_user
            WHERE role='HEAD_OFFICE' AND is_active AND id <> $1`, [userId]);
        if (others.rows[0].n === 0) {
          throw badRequest('마지막 본사 계정은 중지할 수 없습니다.', 'LAST_HEAD_OFFICE');
        }
      }
      const r = await c.query(
        `UPDATE core.app_user SET is_active=$2 WHERE id=$1
         RETURNING id, login_id, is_active`, [userId, p.data.is_active]);
      return r.rows[0];
    });
    if (!row) throw notFound('계정을 찾을 수 없습니다.');
    res.json({ user: row });
  } catch (e) { next(e); }
});
