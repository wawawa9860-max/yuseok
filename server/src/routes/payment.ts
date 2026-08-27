/**
 * PHASE 10 — 공정률 / 기성 (Master Prompt §36, §37, §38, §43, §46)
 *
 * §37 의 핵심
 *   "기성가능액 ≠ 실제 제출 기성 으로 구분한다.
 *    실제 기성 제출은 본사 승인이 필요하다."
 *
 * 그래서 초안 조회(누구나)와 확정(본사)을 다른 라우터로 나눈다.
 *
 * §29 여기 나오는 금액은 전부 '계약금액' 이다. 내부 원가가 아니다.
 * 계약단가는 §44 대로 현장관리자도 볼 수 있다. private_cost 를 건드리지 않는다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';

export const progressRouter = Router();
progressRouter.use(requireAuth);

export const paymentAdminRouter = Router();
paymentAdminRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');
/** 금액은 문자열로 다뤄 부동소수점 오차를 만들지 않는다 (§46). */
const money = z.union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d+)?$/.test(v), '금액은 0 이상의 숫자여야 합니다.');

/* ============================================================ §36 공정률 */
progressRouter.get('/sites/:siteId/progress', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ date: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('날짜가 올바르지 않습니다.');

    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT core.fn_progress_full($1,$2) AS p', [siteId, q.data.date ?? null]);
      return r.rows[0]!.p as Record<string, unknown>;
    });
    res.json(data);
  } catch (e) { next(e); }
});

/* ============================================================ §37 기성 */
/** 기성가능액 초안. 저장하지 않는다. 언제 불러도 지금 값을 낸다 (§11 임의 확정 금지). */
progressRouter.get('/sites/:siteId/payment-draft', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('기간이 올바르지 않습니다.');
    const to = q.data.to ?? new Date().toISOString().slice(0, 10);
    const from = q.data.from ?? `${to.slice(0, 8)}01`;

    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT core.fn_payment_draft($1,$2,$3) AS d', [siteId, from, to]);
      return r.rows[0]!.d as Record<string, unknown>;
    });
    // 이 값은 초안이다. 화면이 '제출 기성' 으로 오해하지 않도록 이름표를 붙인다.
    res.json({ ...data, is_draft: true });
  } catch (e) { next(e); }
});

/** 기성 회차 목록. 현장관리자도 볼 수 있다 (계약금액은 §44 상 열람 가능). */
progressRouter.get('/sites/:siteId/payments', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT p.id, p.sequence_no, p.period_from, p.period_to,
                p.draft_amount, p.submitted_amount, p.adjust_reason, p.status,
                p.submitted_at, p.approved_at, p.memo,
                (SELECT count(*)::int FROM core.payment_certificate_hole h
                  WHERE h.certificate_id = p.id) AS hole_count
           FROM core.payment_certificate p
          WHERE p.site_id = $1
          ORDER BY p.sequence_no DESC`, [siteId]);
      return r.rows;
    });
    const cumulative = rows
      .filter((p: { status: string }) => ['SUBMITTED', 'APPROVED'].includes(p.status))
      .reduce((a: number, p: { submitted_amount: string | null; draft_amount: string }) =>
        a + Number(p.submitted_amount ?? p.draft_amount), 0);
    res.json({ payments: rows, count: rows.length, cumulative_amount: cumulative.toFixed(2) });
  } catch (e) { next(e); }
});

/** 회차 상세. 확정된 회차는 그 시점 근거(snapshot)를 그대로 돌려준다 (§38). */
progressRouter.get('/payments/:certificateId', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.certificateId);
    const data = await withSession(req.actor!, async (c) => {
      const p = await c.query(
        `SELECT id, site_id, sequence_no, period_from, period_to, draft_amount,
                submitted_amount, adjust_reason, status, snapshot, submitted_at,
                approved_at, memo
           FROM core.payment_certificate WHERE id=$1`, [id]);
      if (!p.rowCount) return null;
      const holes = await c.query(
        `SELECT h.hole_no, ph.contract_quantity, ph.unit_price, ph.amount, ph.construction_date
           FROM core.payment_certificate_hole ph
           JOIN core.hole_master h ON h.id = ph.hole_id
          WHERE ph.certificate_id=$1
          ORDER BY h.sort_key`, [id]);
      return { ...p.rows[0], holes: holes.rows };
    });
    if (!data) throw notFound('기성을 찾을 수 없습니다.');
    res.json(data);
  } catch (e) { next(e); }
});

/* ==================================================== 본사 전용 (§37 승인) */
paymentAdminRouter.post('/sites/:siteId/payments', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.object({
      period_from: isoDate,
      period_to: isoDate,
      memo: z.string().max(300).nullish(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '기간이 올바르지 않습니다.');
    if (p.data.period_to < p.data.period_from) throw badRequest('종료일이 시작일보다 빠릅니다.');

    const out = await withSession(req.actor!, async (c) => {
      // 만들기 전에 경고를 먼저 읽는다. 단가가 없는 공이 있으면 회차를 만든 뒤에
      // 알아채는 것보다 그 자리에서 보이는 편이 낫다.
      const draft = (await c.query('SELECT core.fn_payment_draft($1,$2,$3) AS d',
        [siteId, p.data.period_from, p.data.period_to])).rows[0]!.d as {
          issues: unknown[]; draft_amount: string; hole_count: number;
        };
      const r = await c.query('SELECT core.fn_create_payment($1,$2,$3,$4) AS id',
        [siteId, p.data.period_from, p.data.period_to, p.data.memo ?? null]);
      return {
        certificate_id: r.rows[0]!.id as string,
        status: 'DRAFT',
        draft_amount: draft.draft_amount,
        hole_count: draft.hole_count,
        issues: draft.issues,
      };
    });
    res.status(201).json(out);
  } catch (e) { next(e); }
});

/**
 * §37 실제 기성 제출. 초안과 다른 금액을 내려면 사유가 필요하다.
 * 사유 없이 다른 금액을 보내면 DB 제약조건이 거부한다.
 */
paymentAdminRouter.post('/payments/:certificateId/submit', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.certificateId);
    const p = z.object({
      submitted_amount: money,
      adjust_reason: z.string().max(300).nullish(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '금액이 올바르지 않습니다.');

    const out = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT core.fn_submit_payment($1,$2,$3) AS r',
        [id, p.data.submitted_amount, p.data.adjust_reason ?? null]);
      return r.rows[0]!.r as Record<string, unknown>;
    });
    res.json(out);
  } catch (e) { next(e); }
});

paymentAdminRouter.post('/payments/:certificateId/decide', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.certificateId);
    const p = z.object({
      approve: z.boolean(),
      memo: z.string().max(300).nullish(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest('승인 여부가 필요합니다.');

    const out = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT core.fn_decide_payment($1,$2,$3) AS r',
        [id, p.data.approve, p.data.memo ?? null]);
      return r.rows[0]!.r as Record<string, unknown>;
    });
    res.json(out);
  } catch (e) { next(e); }
});
