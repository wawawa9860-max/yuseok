/**
 * PHASE 9 — 작업일보 / 천공일지 (Master Prompt §33, §34, §35)
 *
 * §33 "현장관리자가 별도로 작성하지 않는다."
 *   이 파일에는 저장 API 가 없다. 이미 받아 둔 값을 문서로 만들어 줄 뿐이다 (§1-7).
 *   유일한 예외가 익일계획인데, 그것도 다음날 화면의 기본값이 되므로
 *   결국 입력을 한 번 줄여준다 (§1-5).
 *
 * §29 여기에는 금액이 없다. 함수가 private_cost 를 아예 조회하지 않는다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth } from '../http/context.js';

export const reportRouter = Router();
reportRouter.use(requireAuth);

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');

/** §33 작업일보 — 일일입력이 끝나면 아무것도 더 묻지 않고 만들어진다. */
reportRouter.get('/sites/:siteId/daily-report', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ date: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest(q.error.issues[0]?.message ?? '날짜가 올바르지 않습니다.');
    const date = q.data.date ?? new Date().toISOString().slice(0, 10);

    const report = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT core.fn_daily_report($1,$2) AS report', [siteId, date]);
      return r.rows[0]!.report as Record<string, unknown>;
    });
    res.json(report);
  } catch (e) { next(e); }
});

/**
 * 작업일보 여러 날치 (월간). 본사가 훑어볼 때 쓴다.
 * 일자 목록만 가볍게 돌려주고 상세는 위 API 로 따로 받는다.
 */
reportRouter.get('/sites/:siteId/daily-reports', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('기간이 올바르지 않습니다.');
    const to = q.data.to ?? new Date().toISOString().slice(0, 10);
    const from = q.data.from ?? `${to.slice(0, 8)}01`;

    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT w.work_date, w.status,
                count(d.hole_id)::int AS hole_count,
                COALESCE(sum(COALESCE(d.actual_depth_total, h.design_depth_total)), 0)::text
                  AS length,
                COALESCE((SELECT sum(e.man_days) FROM core.v_daily_labor_effective e
                           WHERE e.daily_work_id = w.id), 0)::text AS man_days,
                (SELECT r2.quantity_m3::text FROM core.daily_ready_mix r2
                  WHERE r2.daily_work_id = w.id) AS ready_mix_m3,
                (SELECT count(*)::int FROM core.daily_ground_note n
                  WHERE n.daily_work_id = w.id) AS special_note_count
           FROM core.daily_work w
           LEFT JOIN core.daily_work_hole d ON d.daily_work_id = w.id
           LEFT JOIN core.hole_master h ON h.id = d.hole_id
          WHERE w.site_id = $1 AND w.work_date BETWEEN $2 AND $3
          GROUP BY w.id
          ORDER BY w.work_date DESC`, [siteId, from, to]);
      return r.rows;
    });
    res.json({ from, to, reports: rows, count: rows.length });
  } catch (e) { next(e); }
});

/** §34 천공일지 — 천공번호로 찾는다. 번호 형식을 강제하지 않으므로 문자열 그대로 받는다. */
reportRouter.get('/sites/:siteId/holes/:holeNo/log', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const holeNo = String(req.params.holeNo);

    const log = await withSession(req.actor!, async (c) => {
      const h = await c.query(
        'SELECT id FROM core.hole_master WHERE site_id=$1 AND hole_no=$2', [siteId, holeNo]);
      if (!h.rowCount) return null;
      const r = await c.query('SELECT core.fn_hole_log($1) AS log', [h.rows[0]!.id]);
      return r.rows[0]!.log as Record<string, unknown>;
    });
    if (!log) throw notFound('천공번호를 찾을 수 없습니다.');
    res.json(log);
  } catch (e) { next(e); }
});

/** §35 작업도면 완료 = 천공일지 완료 = 수량산출 실적 */
reportRouter.get('/sites/:siteId/progress-consistency', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const data = await withSession(req.actor!, async (c) => {
      const rows = (await c.query(
        'SELECT * FROM core.fn_progress_consistency($1)', [siteId])).rows as
        { source: string; hole_count: number; length: string }[];
      const issues = (await c.query(
        'SELECT * FROM core.fn_check_progress_consistency($1)', [siteId])).rows;
      return { sources: rows, issues, consistent: issues.length === 0 };
    });
    res.json(data);
  } catch (e) { next(e); }
});

/** 익일계획 — 다음날 화면의 기본값이 된다 (§1-5). */
reportRouter.put('/sites/:siteId/daily-report/next-day-plan', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.object({
      work_date: isoDate,
      next_day_plan: z.string().max(500).nullish(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE core.daily_work SET next_day_plan=$3
          WHERE site_id=$1 AND work_date=$2
        RETURNING work_date, next_day_plan`,
        [siteId, p.data.work_date, p.data.next_day_plan ?? null]);
      return r.rows[0];
    });
    if (!row) throw notFound('그 날짜의 작업이 없습니다.');
    res.json(row);
  } catch (e) { next(e); }
});
