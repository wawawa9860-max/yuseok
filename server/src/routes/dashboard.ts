/**
 * PHASE 12 — 본사 대시보드 (Master Prompt §39, §29)
 *
 * §39 "현장별 한 줄 위주의 단순 화면. 이상현장만 클릭해 상세를 본다."
 *
 * §29 여기서 처음으로 원가 '합계' 가 화면에 나온다. 그래서 이 라우터 전체가
 * 본사 전용이고, DB 함수도 rfcip_head_office 에만 GRANT 되어 있다.
 * API 를 뚫어도 DB 가 한 번 더 막는다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');

/** §39 전 현장 한 줄씩 */
dashboardRouter.get('/', async (req, res, next) => {
  try {
    const q = z.object({ date: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('날짜가 올바르지 않습니다.');
    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT core.fn_dashboard($1) AS d', [q.data.date ?? null]);
      return r.rows[0]!.d as Record<string, unknown>;
    });
    res.json(data);
  } catch (e) { next(e); }
});

/** 이상현장 클릭 → 상세. 원가 합계는 여기서만 나온다 (§29). */
dashboardRouter.get('/sites/:siteId', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ date: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('날짜가 올바르지 않습니다.');
    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT core.fn_dashboard_site($1,$2) AS d', [siteId, q.data.date ?? null]);
      return r.rows[0]!.d as Record<string, unknown>;
    });
    res.json(data);
  } catch (e) { next(e); }
});
