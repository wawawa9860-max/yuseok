/**
 * PHASE 13 — 공유 분리 (Master Prompt §41, §42, §29)
 *
 * §41 "계약상대방용에는 절대로 원가를 포함하지 않는다.
 *      계약상대방 상세링크에서도 PRIVATE_COST 데이터에 접근할 수 없어야 한다."
 *
 * 상세링크(/share/:token)는 로그인이 없다. 카카오톡으로 받은 사람이 바로 연다.
 * 그래서 서버는 그 요청을 최소권한(EXTERNAL) DB 세션으로 처리하고,
 * 토큰 검증과 데이터 조회 전부를 share 스키마 함수가 한다.
 * EXTERNAL 은 private_cost 에 USAGE 자체가 없으므로 (§29),
 * 이 경로 어딘가에 실수로 원가 조회를 넣으면 42501 로 즉사한다. 그게 의도다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';
import { compressHoleNumbers } from '../domain/holeRange.js';
import { externalMessage, internalMessage, type ShareStatus } from '../domain/kakaoMessage.js';

const EXTERNAL = { userId: null, role: 'EXTERNAL' as const };
const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');
const token = z.string().regex(/^[0-9a-f]{32}$/);

/* ==================================================== 본사: 발급 / 회수 */
export const shareAdminRouter = Router();
shareAdminRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

shareAdminRouter.post('/sites/:siteId/issue', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.object({
      report_date: isoDate.optional(),
      valid_days: z.number().int().min(1).max(90).default(7),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '발급 정보가 올바르지 않습니다.');
    const date = p.data.report_date ?? new Date().toISOString().slice(0, 10);

    const out = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT core.fn_issue_share($1,$2,$3) AS d',
        [siteId, date, p.data.valid_days]);
      return r.rows[0]!.d as { share_token: string };
    });
    res.status(201).json({ ...out, url: `/share/${out.share_token}` });
  } catch (e) { next(e); }
});

shareAdminRouter.post('/revoke/:token', async (req, res, next) => {
  try {
    const t = token.parse(req.params.token);
    const found = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT core.fn_revoke_share($1) AS ok', [t]);
      return r.rows[0]!.ok as boolean;
    });
    if (!found) throw notFound('토큰을 찾을 수 없습니다.');
    res.json({ revoked: true });
  } catch (e) { next(e); }
});

/** 내부 미리보기 — 보내기 전에 무엇이 나가는지 눈으로 확인한다. */
shareAdminRouter.get('/sites/:siteId/preview', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ date: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('날짜가 올바르지 않습니다.');
    const date = q.data.date ?? new Date().toISOString().slice(0, 10);

    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT share.fn_daily_status($1,$2) AS d', [siteId, date]);
      return r.rows[0]!.d as Record<string, unknown> & { today_hole_numbers: string[] };
    });
    res.json({ ...data, today_hole_range: compressHoleNumbers(data.today_hole_numbers) });
  } catch (e) { next(e); }
});

/* ============================================ §40/§41 카카오톡 메시지 (PHASE 14) */
/**
 * §41 계약상대방용 메시지 — 토큰 발급과 함께 본문을 만들어 준다.
 * 본사가 이 본문을 그대로 카카오톡에 붙여넣거나 공유한다 (§42).
 */
shareAdminRouter.post('/sites/:siteId/kakao-external', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.object({
      report_date: isoDate.optional(),
      valid_days: z.number().int().min(1).max(90).default(7),
    }).safeParse(req.body);
    if (!p.success) throw badRequest('발급 정보가 올바르지 않습니다.');
    const date = p.data.report_date ?? new Date().toISOString().slice(0, 10);

    const out = await withSession(req.actor!, async (c) => {
      const issued = (await c.query('SELECT core.fn_issue_share($1,$2,$3) AS d',
        [siteId, date, p.data.valid_days])).rows[0]!.d as { share_token: string };
      const status = (await c.query('SELECT share.fn_daily_status($1,$2) AS d',
        [siteId, date])).rows[0]!.d as ShareStatus & { today_hole_numbers: string[] };
      return { issued, status };
    });

    const base = `${req.protocol}://${req.get('host')}`;
    const url = `${base}/share/${out.issued.share_token}`;
    const range = compressHoleNumbers(out.status.today_hole_numbers);
    res.status(201).json({
      share_token: out.issued.share_token,
      url,
      message: externalMessage(out.status, range, url),
    });
  } catch (e) { next(e); }
});
/* ==================================================== 외부: 토큰 열람 (로그인 없음) */
export const sharePublicRouter = Router();

sharePublicRouter.get('/api/share/:token', async (req, res, next) => {
  try {
    const p = token.safeParse(req.params.token);
    // 형식이 틀려도, 없어도, 만료돼도 똑같이 404 다. 있는지 없는지도 알려주지 않는다.
    if (!p.success) throw notFound('열람할 수 없는 링크입니다.');

    const data = await withSession(EXTERNAL, async (c) => {
      const r = await c.query('SELECT share.fn_report_by_token($1) AS d', [p.data]);
      return r.rows[0]!.d as (Record<string, unknown> & { today_hole_numbers: string[] }) | null;
    });
    if (!data) throw notFound('열람할 수 없는 링크입니다.');
    res.json({ ...data, today_hole_range: compressHoleNumbers(data.today_hole_numbers) });
  } catch (e) { next(e); }
});

/** §41 [작업현황 상세보기] — 카카오톡 링크가 여는 페이지. 로그인 없음. */
sharePublicRouter.get('/share/:token', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>작업현황</title>
<link rel="stylesheet" href="/app/styles.css">
</head><body>
<div id="app"><p class="center muted" style="margin-top:40vh">불러오는 중…</p></div>
<script type="module" src="/app/share-view.js"></script>
</body></html>`);
});
