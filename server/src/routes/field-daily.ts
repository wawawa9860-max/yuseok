/**
 * PHASE 6 — 모바일 오늘 작업입력 (Master Prompt §15, §16, §18, §19, §20, §46)
 *
 * 현장관리자가 하루 1~3분 안에 끝내야 한다 (§0, §52).
 * 그래서 화면 하나에서 다음만 묻는다.
 *
 *   1. 오늘 뚫은 번호 범위          (시작 / 종료 / 제외)
 *   2. 계획심도와 동일합니까?        [예] / [아니오]
 *   3. 지반조건에 다른 점 있었습니까? [없음] / [있음]
 *   4. [입력완료]
 *
 * 지층별 수량·공정률·누계는 전부 자동집계한다. 다시 묻지 않는다 (§20).
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession, type SessionClient } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth } from '../http/context.js';
import { claim, findStored, remember, requestId } from '../http/idempotency.js';

export const fieldRouter = Router();
fieldRouter.use(requireAuth);

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');

/** 수량은 문자열로 다뤄 부동소수점 오차를 만들지 않는다 (§46). */
const amount = (label: string) => z.union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d+)?$/.test(v), `${label}은(는) 0 이상의 숫자여야 합니다.`);

interface ProgressRow {
  total_holes: number; completed_holes: number; today_holes: number; remaining_holes: number;
  total_quantity: string; completed_quantity: string; remaining_quantity: string;
  progress_rate: string;
  /** CONTRACT_QUANTITY = 계약수량 기준(§36) / DESIGN_DEPTH = 계약수량 미연결로 계획심도 대용 */
  quantity_basis: 'CONTRACT_QUANTITY' | 'DESIGN_DEPTH' | 'NONE';
}

async function loadProgress(c: SessionClient, siteId: string, date: string): Promise<ProgressRow> {
  const r = await c.query('SELECT * FROM core.fn_site_progress($1,$2)', [siteId, date]);
  return r.rows[0] as unknown as ProgressRow;
}

/* ============================================================ §18 메인화면 */
/**
 * 오늘 화면에 필요한 것을 한 번에 준다.
 * 화면 이동을 줄이기 위해서다 (§47: 화면을 여러 번 이동하는 구조를 피한다).
 */
fieldRouter.get('/sites/:siteId/today', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const date = isoDate.optional().parse(req.query.date as string | undefined)
      ?? new Date().toISOString().slice(0, 10);

    const data = await withSession(req.actor!, async (c) => {
      const site = await c.query(
        'SELECT id, site_code, site_name, status FROM core.site WHERE id=$1', [siteId]);
      if (!site.rowCount) return null;

      const progress = await loadProgress(c, siteId, date);

      const work = await c.query(
        `SELECT id, work_date, status, next_day_plan, memo, submitted_at
           FROM core.daily_work WHERE site_id=$1 AND work_date=$2`, [siteId, date]);

      // 어제 입력한 익일계획을 오늘의 기본값으로 보여준다 (§1-5 전일값 재사용)
      const prev = await c.query(
        `SELECT work_date, next_day_plan FROM core.daily_work
          WHERE site_id=$1 AND work_date < $2 AND next_day_plan IS NOT NULL
          ORDER BY work_date DESC LIMIT 1`, [siteId, date]);

      // 다음에 뚫을 번호 = 미시공 중 가장 앞선 것 (§1-5 기본값 제안)
      const nextHole = await c.query(
        `SELECT hole_no FROM core.hole_master
          WHERE site_id=$1 AND status='NOT_STARTED'
          ORDER BY drawing_sequence NULLS LAST, sort_key LIMIT 1`, [siteId]);

      const todayHoles = await c.query(
        `SELECT h.hole_no, h.design_depth_total, d.depth_same_as_plan, d.actual_depth_total
           FROM core.daily_work_hole d
           JOIN core.hole_master h ON h.id = d.hole_id
           JOIN core.daily_work w ON w.id = d.daily_work_id
          WHERE w.site_id=$1 AND w.work_date=$2
          ORDER BY h.drawing_sequence NULLS LAST, h.sort_key`, [siteId, date]);

      let layerSummary: unknown[] = [];
      if (todayHoles.rowCount) {
        const ids = await c.query(
          `SELECT d.hole_id FROM core.daily_work_hole d
             JOIN core.daily_work w ON w.id = d.daily_work_id
            WHERE w.site_id=$1 AND w.work_date=$2`, [siteId, date]);
        const s = await c.query('SELECT * FROM core.fn_daily_layer_summary($1)',
          [ids.rows.map((x: { hole_id: string }) => x.hole_id)]);
        layerSummary = s.rows;
      }

      return {
        site: site.rows[0], date,
        progress, daily_work: work.rows[0] ?? null,
        today_holes: todayHoles.rows,
        today_layer_summary: layerSummary,
        previous_next_day_plan: prev.rows[0]?.next_day_plan ?? null,
        suggested_start_hole_no: nextHole.rows[0]?.hole_no ?? null,
      };
    });
    if (!data) throw notFound('현장을 찾을 수 없습니다.');
    res.json(data);
  } catch (e) { next(e); }
});

/* ====================================================== §19/§20 범위 자동집계 */
const rangeInput = z.object({
  work_date: isoDate.optional(),
  from: z.string().min(1).max(60),
  to: z.string().min(1).max(60).optional(),
  exclude: z.array(z.string().max(60)).max(500).optional(),
  hole_type_code: z.string().max(20).optional(),
});

/**
 * 범위를 고르면 즉시 계산해서 보여준다. 저장하지 않는다.
 * "금일 공수 / 금일 천공연장 / 지층별 수량 / 누계 / 잔여 / 공정률" (§19)
 */
fieldRouter.post('/sites/:siteId/daily-work/preview', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = rangeInput.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');
    const date = p.data.work_date ?? new Date().toISOString().slice(0, 10);

    const data = await withSession(req.actor!, async (c) => {
      const rows = await c.query(
        'SELECT * FROM core.fn_resolve_hole_range($1,$2,$3,$4,$5)',
        [siteId, p.data.from, p.data.to ?? p.data.from,
         p.data.exclude ?? null, p.data.hole_type_code ?? null]);
      const holes = rows.rows as unknown as {
        hole_id: string; hole_no: string; design_depth_total: string | null;
        current_profile_id: string | null }[];

      // 이미 완료된 번호는 다시 세지 않는다 (중복입력 방지, §1-2)
      const done = await c.query(
        `SELECT h.id, h.hole_no, h.construction_date
           FROM core.hole_master h
          WHERE h.id = ANY($1) AND h.status='COMPLETED'`,
        [holes.map((h) => h.hole_id)]);
      const doneIds = new Set(done.rows.map((x: { id: string }) => x.id));
      const fresh = holes.filter((h) => !doneIds.has(h.hole_id));

      const layer = await c.query('SELECT * FROM core.fn_daily_layer_summary($1)',
        [fresh.map((h) => h.hole_id)]);
      const progress = await loadProgress(c, siteId, date);

      return { holes, fresh, done: done.rows, layer: layer.rows, progress };
    });

    const issues: { code: string; severity: string; message: string }[] = [];
    if (data.holes.length === 0) {
      issues.push({ code: 'NO_HOLE_IN_RANGE', severity: 'ERROR', message: '선택한 범위에 천공번호가 없습니다.' });
    }
    if (data.done.length > 0) {
      issues.push({
        code: 'ALREADY_COMPLETED', severity: 'WARN',
        message: `${data.done.length}개는 이미 완료된 번호라 제외했습니다: `
          + data.done.slice(0, 10).map((d: { hole_no: string }) => d.hole_no).join(', '),
      });
    }
    const noProfile = data.fresh.filter((h) => !h.current_profile_id);
    if (noProfile.length > 0) {
      issues.push({
        code: 'HOLE_WITHOUT_PROFILE', severity: 'WARN',
        message: `${noProfile.length}개는 지반조건이 없어 지층별 수량이 집계되지 않습니다.`,
      });
    }

    const todayLength = data.fresh.reduce((a, h) => a + Number(h.design_depth_total ?? 0), 0);
    const p2 = data.progress;

    res.json({
      work_date: p.data.work_date ?? new Date().toISOString().slice(0, 10),
      today_hole_count: data.fresh.length,
      today_hole_numbers: data.fresh.map((h) => h.hole_no),
      today_planned_length: Number(todayLength.toFixed(3)),
      layer_summary: data.layer,
      excluded_already_done: data.done.map((d: { hole_no: string }) => d.hole_no),
      // 누계는 오늘 입력분을 더한 예상치다 (§19)
      cumulative_hole_count: p2.completed_holes + data.fresh.length,
      cumulative_quantity: Number((Number(p2.completed_quantity) + todayLength).toFixed(3)),
      remaining_hole_count: p2.remaining_holes - data.fresh.length,
      remaining_quantity: Number((Number(p2.remaining_quantity) - todayLength).toFixed(3)),
      total_hole_count: p2.total_holes,
      quantity_basis: p2.quantity_basis,
      progress_rate_after: Number(p2.total_quantity) === 0 ? 0
        : Number((((Number(p2.completed_quantity) + todayLength)
            / Number(p2.total_quantity)) * 100).toFixed(1)),
      issues,
      can_save: issues.filter((i) => i.severity === 'ERROR').length === 0,
    });
  } catch (e) { next(e); }
});

/* ====================================================== 저장 (§15, §16) */
const saveInput = rangeInput.extend({
  /** §16 계획심도와 동일합니까? — 기본은 '예'. 예외만 따로 받는다. */
  /**
   * §16 계획심도까지 뚫었습니까?
   *
   * 현장은 숫자를 적지 않는다. '갔다 / 못 갔다' 만 고른다 (사용자 확인 2026-08-27).
   * 계획심도는 천공조서에 이미 있고, 평면도 넘버링으로 공이 정해져 있다.
   * 못 간 공만 골라서 사유를 남긴다.
   */
  depth_same_as_plan: z.boolean().default(true),
  depth_exceptions: z.array(z.object({
    hole_no: z.string().min(1).max(60),
    /**
     * 미달이면 어디까지 갔는지. 이것이 없으면 수량이 계획심도로 잡혀 과다계상된다.
     * 예외 경로에서만 묻는 값이라 현장 부담은 늘지 않는다.
     */
    actual_depth_total: z.union([z.number(), z.string()])
      .transform((v) => String(v))
      .refine((v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0, '실제심도는 0보다 커야 합니다.'),
    /** 왜 계획심도까지 못 갔는지. 없으면 저장을 막는다 (DB 제약조건). */
    shortfall_reason: z.string().min(1).max(100),
  })).max(500).nullish(),
  /** §15 지반조건에 다른 점이 있었습니까? — 기본은 '없음'. */
  ground_notes: z.array(z.object({
    note_type: z.string().min(1).max(50),
    memo: z.string().max(500).optional(),
    hole_nos: z.array(z.string().max(60)).max(200).optional(),
  })).max(20).nullish(),
  next_day_plan: z.string().max(300).optional(),
  memo: z.string().max(500).optional(),
  /** true 면 입력완료(SUBMITTED) 상태로 만든다 */
  submit: z.boolean().default(true),
  /** 오프라인 큐 재전송 시 중복 저장을 막는 요청 ID */
  client_request_id: z.string().uuid().optional(),

  /** §21 오늘 인원은 기본설정과 동일합니까? 아니오일 때만 변경분을 받는다. */
  labor_same_as_default: z.boolean().default(true),
  labor_changes: z.array(z.object({
    role_name: z.string().min(1).max(50),
    headcount: amount('인원').optional(),
    /** 출력일보 공수. 1=하루, 0.5=반일, 0=미출력. 안 보내면 기본값(보통 1일)을 쓴다. */
    work_days: amount('공수').optional(),
    absence_reason: z.string().max(100).nullish(),
    note: z.string().max(200).optional(),
  })).max(50).nullish(),

  /** §22 오늘 장비는 기본설정과 동일합니까? 변경만 입력한다. */
  equipment_same_as_default: z.boolean().default(true),
  equipment_changes: z.array(z.object({
    equipment_name: z.string().min(1).max(50),
    quantity: amount('수량').optional(),
    /** 장비가동일보 가동일수. 1=하루, 0.5=반일, 0=미가동(대기·기상·불가항력). */
    operating_days: amount('가동일수').optional(),
    idle_reason: z.string().max(100).nullish(),
    charge_type: z.enum(['DAILY', 'MONTHLY', 'OTHER']).optional(),
    note: z.string().max(200).optional(),
  })).max(50).nullish(),

  /**
   * §23 레미콘. 타설이 없는 날도 있으므로 없어도 된다.
   * 화면이 빈 값을 null 로 보내는 경우까지 '없음' 으로 받는다.
   */
  ready_mix: z.object({
    quantity_m3: amount('반입량'),
    has_delay: z.boolean().default(false),
    delay_minutes: z.number().int().positive().max(1440).optional(),
    delay_reason: z.string().max(50).optional(),
    memo: z.string().max(300).optional(),
  }).nullish(),
});

fieldRouter.post('/sites/:siteId/daily-work', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = saveInput.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');
    const d = p.data;
    const date = d.work_date ?? new Date().toISOString().slice(0, 10);
    const reqId = requestId(req);

    const result = await withSession(req.actor!, async (c) => {
      // 오프라인 큐가 같은 요청을 다시 보냈다면 처음 처리한 응답을 그대로 돌려준다.
      // 이것이 없으면 재전송 때마다 레미콘·공수가 두 배로 쌓인다.
      if (reqId) {
        await claim(c, reqId);   // 동시에 온 같은 요청을 줄 세운다
        const stored = await findStored(c, reqId);
        if (stored) return { ...(stored.body as object), replayed: true };
      }

      const rows = await c.query(
        'SELECT * FROM core.fn_resolve_hole_range($1,$2,$3,$4,$5)',
        [siteId, d.from, d.to ?? d.from, d.exclude ?? null, d.hole_type_code ?? null]);
      const all = rows.rows as unknown as { hole_id: string; hole_no: string }[];
      if (all.length === 0) throw badRequest('선택한 범위에 천공번호가 없습니다.', 'NO_HOLE_IN_RANGE');

      const done = await c.query(
        `SELECT id FROM core.hole_master WHERE id = ANY($1) AND status='COMPLETED'`,
        [all.map((h) => h.hole_id)]);
      const doneIds = new Set(done.rows.map((x: { id: string }) => x.id));
      const fresh = all.filter((h) => !doneIds.has(h.hole_id));
      if (fresh.length === 0) {
        throw badRequest('선택한 번호가 모두 이미 완료되었습니다.', 'ALL_ALREADY_COMPLETED');
      }

      const work = await c.query(
        `INSERT INTO core.daily_work
           (site_id, work_date, status, next_day_plan, memo,
            labor_same_as_default, equipment_same_as_default, created_by)
         VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7)
         ON CONFLICT (site_id, work_date) DO UPDATE
           SET next_day_plan = COALESCE(EXCLUDED.next_day_plan, core.daily_work.next_day_plan),
               memo = COALESCE(EXCLUDED.memo, core.daily_work.memo),
               labor_same_as_default = EXCLUDED.labor_same_as_default,
               equipment_same_as_default = EXCLUDED.equipment_same_as_default
         RETURNING id`,
        [siteId, date, d.next_day_plan ?? null, d.memo ?? null,
         d.labor_same_as_default, d.equipment_same_as_default, req.actor!.userId]);
      const workId = work.rows[0]!.id as string;

      const exceptions = new Map(
        (d.depth_exceptions ?? []).map((e) =>
          [e.hole_no, { actual: e.actual_depth_total ?? null, reason: e.shortfall_reason }]));
      const unknownHoleNos = [...exceptions.keys()]
        .filter((n) => !fresh.some((h) => h.hole_no === n));
      if (unknownHoleNos.length > 0) {
        throw badRequest(
          `미달로 표시한 ${unknownHoleNos.join(', ')} 이(가) 오늘 선택범위에 없습니다.`,
          'DEPTH_EXCEPTION_NOT_IN_RANGE');
      }

      for (const h of fresh) {
        const ex = exceptions.get(h.hole_no);
        // 고른 공만 미달이다. 나머지는 계획심도까지 간 것으로 본다.
        // 날짜 단위 [아니오] 는 입력칸을 여는 스위치일 뿐, 모든 공이 미달이라는 뜻이 아니다.
        const reached = ex === undefined;
        await c.query(
          `INSERT INTO core.daily_work_hole
             (daily_work_id, hole_id, depth_same_as_plan, actual_depth_total, shortfall_reason)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (daily_work_id, hole_id) DO UPDATE
             SET depth_same_as_plan = EXCLUDED.depth_same_as_plan,
                 actual_depth_total = EXCLUDED.actual_depth_total,
                 shortfall_reason   = EXCLUDED.shortfall_reason`,
          [workId, h.hole_id, reached, ex?.actual ?? null, ex?.reason ?? null]);
      }

      // §15 특이사항은 '있음' 일 때만 저장된다
      for (const n of d.ground_notes ?? []) {
        const note = await c.query(
          `INSERT INTO core.daily_ground_note (daily_work_id, note_type, memo, created_by)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [workId, n.note_type, n.memo ?? null, req.actor!.userId]);
        for (const holeNo of n.hole_nos ?? []) {
          const hole = fresh.find((h) => h.hole_no === holeNo);
          if (hole) {
            await c.query(
              `INSERT INTO core.daily_ground_note_hole (note_id, hole_id)
               VALUES ($1,$2) ON CONFLICT DO NOTHING`, [note.rows[0]!.id, hole.hole_id]);
          }
        }
      }

      // §21 인원 — '동일합니다' 면 변경행을 남기지 않는다
      if (d.labor_same_as_default) {
        await c.query('DELETE FROM core.daily_labor WHERE daily_work_id=$1', [workId]);
      } else {
        for (const l of d.labor_changes ?? []) {
          // 인원만 바꾸는 날도 있고 공수만 바꾸는 날도 있다 (반일 출력).
          // 안 보낸 값은 기본설정에서 가져오고, 이미 적어둔 값이 있으면 그것을 지킨다.
          await c.query(
            `INSERT INTO core.daily_labor
               (daily_work_id, role_name, headcount, work_days, absence_reason, note)
             SELECT $1, $2,
                    COALESCE($3::numeric, sl.headcount, 1),
                    COALESCE($4::numeric, sl.default_work_days, 1),
                    $5, $6
               FROM (SELECT 1) x
               LEFT JOIN core.site_default_labor sl
                      ON sl.site_id = (SELECT w.site_id FROM core.daily_work w WHERE w.id = $1)
                     AND sl.role_name = $2 AND sl.is_active
             ON CONFLICT (daily_work_id, role_name) DO UPDATE
               SET headcount      = COALESCE($3::numeric, core.daily_labor.headcount),
                   work_days      = COALESCE($4::numeric, core.daily_labor.work_days),
                   absence_reason = COALESCE($5, core.daily_labor.absence_reason),
                   note           = COALESCE($6, core.daily_labor.note)`,
            [workId, l.role_name, l.headcount ?? null, l.work_days ?? null,
             l.absence_reason ?? null, l.note ?? null]);
        }
      }

      // §22 장비 — 변경만 입력한다
      if (d.equipment_same_as_default) {
        await c.query('DELETE FROM core.daily_equipment WHERE daily_work_id=$1', [workId]);
      } else {
        for (const e of d.equipment_changes ?? []) {
          await c.query(
            `INSERT INTO core.daily_equipment
               (daily_work_id, equipment_name, quantity, operating_days,
                charge_type, idle_reason, note)
             SELECT $1, $2,
                    COALESCE($3::numeric, se.quantity, 1),
                    COALESCE($4::numeric, se.default_operating_days, 1),
                    $5, $6, $7
               FROM (SELECT 1) x
               LEFT JOIN core.site_default_equipment se
                      ON se.site_id = (SELECT w.site_id FROM core.daily_work w WHERE w.id = $1)
                     AND se.equipment_name = $2 AND se.is_active
             ON CONFLICT (daily_work_id, equipment_name) DO UPDATE
               SET quantity       = COALESCE($3::numeric, core.daily_equipment.quantity),
                   operating_days = COALESCE($4::numeric, core.daily_equipment.operating_days),
                   charge_type    = COALESCE($5, core.daily_equipment.charge_type),
                   idle_reason    = COALESCE($6, core.daily_equipment.idle_reason),
                   note           = COALESCE($7, core.daily_equipment.note)`,
            [workId, e.equipment_name, e.quantity ?? null, e.operating_days ?? null,
             e.charge_type ?? null, e.idle_reason ?? null, e.note ?? null]);
        }
      }

      // §23 레미콘
      let readyMix: Record<string, unknown> | null = null;
      if (d.ready_mix) {
        const rm = d.ready_mix;
        if (rm.has_delay && rm.delay_minutes === undefined) {
          throw badRequest('공급지연이 있으면 지연시간을 입력해야 합니다.', 'DELAY_MINUTES_REQUIRED');
        }
        const r = await c.query(
          `INSERT INTO core.daily_ready_mix
             (daily_work_id, quantity_m3, has_delay, delay_minutes, delay_reason, memo, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (daily_work_id) DO UPDATE
             SET quantity_m3 = EXCLUDED.quantity_m3, has_delay = EXCLUDED.has_delay,
                 delay_minutes = EXCLUDED.delay_minutes, delay_reason = EXCLUDED.delay_reason,
                 memo = EXCLUDED.memo
           RETURNING id, quantity_m3, has_delay, delay_minutes, delay_reason`,
          [workId, rm.quantity_m3, rm.has_delay,
           rm.has_delay ? rm.delay_minutes ?? null : null,
           rm.has_delay ? rm.delay_reason ?? null : null,
           rm.memo ?? null, req.actor!.userId]);
        readyMix = r.rows[0] ?? null;
      }

      const applied = await c.query('SELECT core.fn_apply_daily_work($1) AS n', [workId]);

      if (d.submit) {
        await c.query(
          `UPDATE core.daily_work SET status='SUBMITTED', submitted_at=now(), submitted_by=$2
            WHERE id=$1`, [workId, req.actor!.userId]);
      }

      const layer = await c.query('SELECT * FROM core.fn_daily_layer_summary($1)',
        [fresh.map((h) => h.hole_id)]);
      const progress = await loadProgress(c, siteId, date);

      const payload = {
        daily_work_id: workId, work_date: date,
        status: d.submit ? 'SUBMITTED' : 'DRAFT',
        today_hole_count: Number(applied.rows[0]!.n),
        today_hole_numbers: fresh.map((h) => h.hole_no),
        skipped_already_done: all.length - fresh.length,
        layer_summary: layer.rows,
        ready_mix: readyMix,
        labor: (await c.query(
          `SELECT role_name, headcount, work_days, man_days, absence_reason, is_override
             FROM core.v_daily_labor_effective
            WHERE daily_work_id=$1 ORDER BY sort_order, role_name`, [workId])).rows,
        equipment: (await c.query(
          `SELECT equipment_name, quantity, operating_days, unit_days, idle_reason,
                  charge_type, is_override
             FROM core.v_daily_equipment_effective
            WHERE daily_work_id=$1 ORDER BY sort_order, equipment_name`, [workId])).rows,
        progress,
      };

      if (reqId) {
        await remember(c, reqId, req.actor!.userId, 'POST /field/daily-work', 201, payload);
      }
      return payload;
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/** 특이사항 선택지 — 현장별 지층종류에서 만들어 준다. 하드코딩하지 않는다 (§7, §15). */
fieldRouter.get('/sites/:siteId/ground-note-options', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT code, name, status FROM core.ground_type
          WHERE site_id=$1 AND is_active ORDER BY sort_order, code`, [siteId]);
      return r.rows as { code: string; name: string; status: string }[];
    });
    const options = [
      ...rows.map((g) => ({
        note_type: `${g.name}구간 차이`,
        hint: g.status === 'PROVISIONAL' ? '계획수량 0인 미확정 지층' : null,
      })),
      { note_type: '예상 외 지층', hint: null },
      { note_type: '지하수', hint: null },
      { note_type: '기타', hint: null },
    ];
    res.json({ options });
  } catch (e) { next(e); }
});

/** 오늘 입력 취소 — 잘못 넣었을 때 되돌린다 (§47 [수정]) */
fieldRouter.delete('/sites/:siteId/daily-work/:date', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const date = isoDate.parse(req.params.date);
    const result = await withSession(req.actor!, async (c) => {
      const work = await c.query(
        'SELECT id FROM core.daily_work WHERE site_id=$1 AND work_date=$2', [siteId, date]);
      if (!work.rowCount) return null;
      const workId = work.rows[0]!.id as string;

      // 완료 처리했던 천공번호를 미시공으로 되돌린다
      const reverted = await c.query(
        `UPDATE core.hole_master h
            SET status='NOT_STARTED', construction_date=NULL, actual_depth_total=NULL
           FROM core.daily_work_hole d
          WHERE d.daily_work_id=$1 AND h.id=d.hole_id
          RETURNING h.hole_no`, [workId]);
      await c.query('DELETE FROM core.daily_work WHERE id=$1', [workId]);
      return { reverted: reverted.rows.length };
    });
    if (!result) throw notFound('해당 날짜의 입력이 없습니다.');
    res.json({ work_date: date, reverted_holes: result.reverted });
  } catch (e) { next(e); }
});

/* ============================================ §21/§22 기본 인원·장비 조회 */
/**
 * 일일 화면이 "기본설정과 동일합니까?" 를 묻기 위해 필요한 목록.
 * 단가는 들어있지 않다 (§29).
 */
fieldRouter.get('/sites/:siteId/defaults', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const data = await withSession(req.actor!, async (c) => {
      const labor = await c.query(
        `SELECT role_name, headcount, default_work_days, note FROM core.site_default_labor
          WHERE site_id=$1 AND is_active ORDER BY sort_order, role_name`, [siteId]);
      const equipment = await c.query(
        `SELECT equipment_name, charge_type, quantity, default_operating_days, note
           FROM core.site_default_equipment
          WHERE site_id=$1 AND is_active ORDER BY sort_order, equipment_name`, [siteId]);
      return { labor: labor.rows, equipment: equipment.rows };
    });
    res.json(data);
  } catch (e) { next(e); }
});

/* ================================================ 출력일보 / 장비가동일보 (§26) */
/*
 * 금액은 없다. 공수와 가동일수만 있다.
 * 현금으로 지급하지 않아도 1일 / 0.5일 은 반드시 남아야 하고,
 * 투입비는 본사가 이 값에 단가를 곱해서 계산한다 (§25, §26, §29).
 * PHASE 9 작업일보가 이 API 를 그대로 재사용한다 (§1-7).
 */
const logRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function monthRange(q: { from?: string; to?: string }): { from: string; to: string } {
  const to = q.to ?? new Date().toISOString().slice(0, 10);
  return { from: q.from ?? `${to.slice(0, 8)}01`, to };
}

fieldRouter.get('/sites/:siteId/labor-log', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = logRange.safeParse(req.query);
    if (!q.success) throw badRequest('기간이 올바르지 않습니다.');
    const { from, to } = monthRange(q.data);

    const data = await withSession(req.actor!, async (c) => {
      const days = await c.query(
        `SELECT work_date, role_name, headcount, work_days, man_days,
                absence_reason, is_override
           FROM core.v_labor_log
          WHERE site_id=$1 AND work_date BETWEEN $2 AND $3
          ORDER BY work_date, sort_order, role_name`, [siteId, from, to]);
      const byRole = await c.query(
        `SELECT role_name, sum(man_days)::text AS man_days,
                count(*) FILTER (WHERE work_days > 0)::int AS work_day_count
           FROM core.v_labor_log
          WHERE site_id=$1 AND work_date BETWEEN $2 AND $3
          GROUP BY role_name, sort_order ORDER BY sort_order, role_name`, [siteId, from, to]);
      const total = await c.query(
        `SELECT COALESCE(sum(man_days), 0)::text AS man_days
           FROM core.v_labor_log
          WHERE site_id=$1 AND work_date BETWEEN $2 AND $3`, [siteId, from, to]);
      return { days: days.rows, by_role: byRole.rows, total_man_days: total.rows[0]!.man_days };
    });
    res.json({ from, to, ...data });
  } catch (e) { next(e); }
});

fieldRouter.get('/sites/:siteId/equipment-log', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = logRange.safeParse(req.query);
    if (!q.success) throw badRequest('기간이 올바르지 않습니다.');
    const { from, to } = monthRange(q.data);

    const data = await withSession(req.actor!, async (c) => {
      const days = await c.query(
        `SELECT work_date, equipment_name, charge_type, quantity,
                operating_days, unit_days, idle_reason, is_override
           FROM core.v_equipment_log
          WHERE site_id=$1 AND work_date BETWEEN $2 AND $3
          ORDER BY work_date, sort_order, equipment_name`, [siteId, from, to]);
      const byEquip = await c.query(
        `SELECT equipment_name, charge_type, sum(unit_days)::text AS unit_days,
                count(*) FILTER (WHERE operating_days > 0)::int AS operating_day_count,
                count(*) FILTER (WHERE operating_days = 0)::int AS idle_day_count
           FROM core.v_equipment_log
          WHERE site_id=$1 AND work_date BETWEEN $2 AND $3
          GROUP BY equipment_name, charge_type, sort_order
          ORDER BY sort_order, equipment_name`, [siteId, from, to]);
      return { days: days.rows, by_equipment: byEquip.rows };
    });
    res.json({ from, to, ...data });
  } catch (e) { next(e); }
});

/**
 * §16 계획심도 미달 사유 선택지 (사용자 확인 2026-08-27).
 * 현장은 숫자를 적지 않고 '못 갔다' 를 고른 뒤 사유를 누른다.
 */
fieldRouter.get('/shortfall-reasons', requireAuth, async (req, res, next) => {
  try {
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT reason, sort_order FROM core.fn_shortfall_reasons() ORDER BY sort_order');
      return r.rows as { reason: string }[];
    });
    res.json({ reasons: rows.map((x) => x.reason) });
  } catch (e) { next(e); }
});

/** §23 공급지연 선택지. 시스템이 목록을 강제하지 않도록 한곳에 모아 둔다. */
fieldRouter.get('/ready-mix-options', requireAuth, (_req, res) => {
  res.json({
    delay_minutes: [30, 60, 90, 120],
    delay_reasons: ['레미콘공장', '원도급', '검측', '현장조건', '기타'],
  });
});

/**
 * 계획 레미콘량 (§23, §46)
 * 산출근거 방식 그대로: (π × D²)/4 × 연장 × (1 + 할증률)
 * π·직경·할증률은 현장 설계 파라미터를 쓴다.
 */
fieldRouter.get('/sites/:siteId/planned-ready-mix', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const length = z.coerce.number().nonnegative().parse(req.query.length ?? 0);
    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT * FROM core.fn_planned_ready_mix($1,$2)', [siteId, length]);
      return r.rows[0];
    });
    res.json(row);
  } catch (e) { next(e); }
});
