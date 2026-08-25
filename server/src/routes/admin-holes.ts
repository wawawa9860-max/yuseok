/**
 * PHASE 2 — HOLE_MASTER 생성·수정 (Master Prompt §17 STEP 5, §14, §38)
 *
 * 천공번호는 작업도면(PDF)에 표기된 것을 기준으로 한다.
 * 시스템은 번호 형식을 강제하지 않으며, 두 가지 입력방법을 제공한다.
 *   LIST  : 도면에서 읽은 번호를 그대로 붙여넣기  ← 기본
 *   RANGE : 규칙적인 현장을 위한 편의기능
 *
 * 반드시 "미리보기 → 확인 → 저장" 순서로 동작한다 (§12 정신).
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';
import {
  generateHoleNumbers, HoleNumberError, parseNumberList, sortHoleNumbers,
  type HoleNumberSpec,
} from '../domain/holeNumbering.js';

export const adminHoleRouter = Router();
adminHoleRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const uuid = z.string().uuid();
const decimal = z.union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d+)?$/.test(v), '0 이상의 숫자여야 합니다.');

const specSchema = z.union([
  z.object({
    mode: z.literal('LIST'),
    /** 배열로 주거나, 줄바꿈/쉼표로 구분된 한 덩어리 문자열로 줘도 된다. */
    numbers: z.union([z.array(z.string()), z.string()]),
  }),
  z.object({
    mode: z.literal('RANGE'),
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    digits: z.number().int().min(0).max(10).optional(),
    step: z.number().int().min(1).max(100).optional(),
    exclude: z.array(z.union([z.string(), z.number()])).optional(),
  }),
]);

const bulkBody = z.object({
  spec: specSchema,
  hole_type_code: z.string().max(20).optional(),
  section: z.string().max(100).optional(),
  design_depth_total: decimal.optional(),
  contract_quantity: decimal.optional(),
  contract_unit: z.string().max(20).optional(),
  contract_unit_price: decimal.optional(),
  planned_ready_mix_quantity: decimal.optional(),
  /** 도면 표기 순번을 번호 순서대로 자동 부여할지 (PHASE 5 도면 연결 대비) */
  assign_drawing_sequence: z.boolean().default(false),
  drawing_sequence_start: z.number().int().min(1).default(1),
});

function toSpec(input: z.infer<typeof specSchema>): HoleNumberSpec {
  if (input.mode === 'LIST') {
    const numbers = typeof input.numbers === 'string'
      ? parseNumberList(input.numbers)
      : input.numbers;
    return { mode: 'LIST', numbers };
  }
  return input;
}

/**
 * 미리보기 — 저장하지 않는다.
 * 생성될 번호, 중복 충돌, 개수를 먼저 보여준다.
 */
adminHoleRouter.post('/sites/:siteId/holes/preview', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = bulkBody.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');

    let numbers: string[];
    try {
      numbers = sortHoleNumbers(generateHoleNumbers(toSpec(p.data.spec)));
    } catch (e) {
      if (e instanceof HoleNumberError) throw badRequest(e.message, 'HOLE_NUMBER_INVALID');
      throw e;
    }

    const conflicts = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT * FROM core.fn_check_hole_numbers($1,$2)', [siteId, numbers]);
      return r.rows as { hole_no: string; issue: string }[];
    });

    res.json({
      count: numbers.length,
      hole_numbers: numbers,
      first: numbers[0],
      last: numbers[numbers.length - 1],
      conflicts,
      can_save: conflicts.length === 0,
    });
  } catch (e) { next(e); }
});

/** 실제 생성. 충돌이 하나라도 있으면 전부 저장하지 않는다. */
adminHoleRouter.post('/sites/:siteId/holes/bulk', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = bulkBody.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');
    const d = p.data;

    let numbers: string[];
    try {
      numbers = sortHoleNumbers(generateHoleNumbers(toSpec(d.spec)));
    } catch (e) {
      if (e instanceof HoleNumberError) throw badRequest(e.message, 'HOLE_NUMBER_INVALID');
      throw e;
    }

    const result = await withSession(req.actor!, async (c) => {
      const conflicts = await c.query(
        'SELECT * FROM core.fn_check_hole_numbers($1,$2)', [siteId, numbers]);
      if (conflicts.rowCount) {
        return { conflicts: conflicts.rows, created: 0, holes: [] as unknown[] };
      }

      let holeTypeId: string | null = null;
      if (d.hole_type_code) {
        const ht = await c.query(
          'SELECT id FROM core.site_hole_type WHERE site_id=$1 AND code=$2',
          [siteId, d.hole_type_code]);
        if (!ht.rowCount) {
          throw badRequest(`천공종류 '${d.hole_type_code}' 가 이 현장에 등록되어 있지 않습니다.`);
        }
        holeTypeId = ht.rows[0].id;
      }

      const holes: unknown[] = [];
      let seq = d.drawing_sequence_start;
      for (const holeNo of numbers) {
        const r = await c.query(
          `INSERT INTO core.hole_master
             (site_id, hole_no, section, hole_type_id, design_depth_total,
              contract_quantity, contract_unit, contract_unit_price,
              planned_ready_mix_quantity, drawing_sequence, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'NOT_STARTED',$11)
           RETURNING id, hole_no, sort_key, drawing_sequence, status`,
          [siteId, holeNo, d.section ?? null, holeTypeId,
           d.design_depth_total ?? null, d.contract_quantity ?? null,
           d.contract_unit ?? null, d.contract_unit_price ?? null,
           d.planned_ready_mix_quantity ?? null,
           d.assign_drawing_sequence ? seq++ : null, req.actor!.userId]);
        // 원계약 상태를 REV 0 으로 즉시 보존한다 (§38)
        await c.query(
          `SELECT core.fn_snapshot_hole_revision($1,'ORIGINAL_CONTRACT','천공번호 생성')`,
          [r.rows[0].id]);
        holes.push(r.rows[0]);
      }

      await c.query(
        `UPDATE core.site SET setup_step = GREATEST(setup_step, 5) WHERE id = $1`, [siteId]);
      return { conflicts: [], created: holes.length, holes };
    });

    if (result.conflicts.length > 0) {
      return res.status(409).json({
        error: 'HOLE_NUMBER_CONFLICT',
        message: '중복된 천공번호가 있어 저장하지 않았습니다.',
        conflicts: result.conflicts,
      });
    }
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/** 개별 수정. 계획값을 바꾸면 이전 상태를 revision 으로 보존한다 (§38). */
const holePatch = z.object({
  section: z.string().max(100).nullable().optional(),
  hole_type_code: z.string().max(20).nullable().optional(),
  design_depth_total: decimal.nullable().optional(),
  ground_profile_id: z.string().uuid().nullable().optional(),
  contract_quantity: decimal.nullable().optional(),
  contract_unit: z.string().max(20).nullable().optional(),
  contract_unit_price: decimal.nullable().optional(),
  planned_ready_mix_quantity: decimal.nullable().optional(),
  drawing_sequence: z.number().int().min(1).nullable().optional(),
  drawing_ref: z.string().max(200).nullable().optional(),
  status: z.enum(['NOT_STARTED', 'COMPLETED', 'ON_HOLD', 'CHANGED', 'NEEDS_CHECK']).optional(),
  change_review_required: z.boolean().optional(),
  /** 계획값 변경 시 필수 — 왜 바뀌는지 남긴다. */
  revision_reason: z.string().max(500).optional(),
});

/** 계획값(설계변경 대상) 컬럼. 이 값이 바뀌면 revision 을 남긴다. */
const PLAN_FIELDS = [
  'design_depth_total', 'ground_profile_id', 'contract_quantity',
  'contract_unit', 'contract_unit_price', 'planned_ready_mix_quantity',
] as const;

adminHoleRouter.patch('/holes/:holeId', async (req, res, next) => {
  try {
    const holeId = uuid.parse(req.params.holeId);
    const p = holePatch.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '수정 값이 올바르지 않습니다.');

    const { hole_type_code, revision_reason, ...rest } = p.data;
    const fields = Object.entries(rest).filter(([, v]) => v !== undefined);
    if (fields.length === 0 && hole_type_code === undefined) {
      throw badRequest('수정할 항목이 없습니다.');
    }

    const planChanged = fields.some(([k]) => (PLAN_FIELDS as readonly string[]).includes(k));
    if (planChanged && !revision_reason) {
      throw badRequest('계획값을 변경할 때는 변경사유(revision_reason)가 필요합니다.', 'REASON_REQUIRED');
    }

    const row = await withSession(req.actor!, async (c) => {
      const cur = await c.query('SELECT site_id FROM core.hole_master WHERE id=$1', [holeId]);
      if (!cur.rowCount) return null;

      // 변경 "전" 상태를 먼저 보존한다 (§1-11 원본 덮어쓰기 금지)
      if (planChanged) {
        await c.query(
          `SELECT core.fn_snapshot_hole_revision($1,'DESIGN_CHANGE',$2)`,
          [holeId, revision_reason]);
      }

      const sets: string[] = [];
      const params: unknown[] = [holeId];
      for (const [k, v] of fields) { params.push(v); sets.push(`${k} = $${params.length}`); }

      if (hole_type_code !== undefined) {
        if (hole_type_code === null) {
          sets.push('hole_type_id = NULL');
        } else {
          const ht = await c.query(
            'SELECT id FROM core.site_hole_type WHERE site_id=$1 AND code=$2',
            [cur.rows[0].site_id, hole_type_code]);
          if (!ht.rowCount) throw badRequest(`천공종류 '${hole_type_code}' 가 등록되어 있지 않습니다.`);
          params.push(ht.rows[0].id);
          sets.push(`hole_type_id = $${params.length}`);
        }
      }

      const r = await c.query(
        `UPDATE core.hole_master SET ${sets.join(', ')} WHERE id=$1
         RETURNING id, hole_no, sort_key, drawing_sequence, section, design_depth_total,
                   ground_profile_id, contract_quantity, contract_unit, contract_unit_price,
                   planned_ready_mix_quantity, status, current_revision`, params);
      return r.rows[0];
    });
    if (!row) throw notFound('천공번호를 찾을 수 없습니다.');
    res.json({ hole: row });
  } catch (e) { next(e); }
});

/** Revision 이력 조회 — 원계약 / 설계변경 전·후를 모두 추적한다 (§38) */
adminHoleRouter.get('/holes/:holeId/revisions', async (req, res, next) => {
  try {
    const holeId = uuid.parse(req.params.holeId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT revision_no, revision_type, design_depth_total, contract_quantity,
                contract_unit, contract_unit_price, ground_profile_id,
                reason, effective_date, is_current, created_at
           FROM core.hole_revision WHERE hole_id=$1 ORDER BY revision_no`, [holeId]);
      return r.rows;
    });
    res.json({ revisions: rows });
  } catch (e) { next(e); }
});

/** 미시공 상태의 천공번호만 삭제할 수 있다. 시공이력이 있으면 삭제 대신 보류/변경. */
adminHoleRouter.delete('/holes/:holeId', async (req, res, next) => {
  try {
    const holeId = uuid.parse(req.params.holeId);
    const deleted = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `DELETE FROM core.hole_master
          WHERE id=$1 AND status='NOT_STARTED' AND construction_date IS NULL
          RETURNING hole_no`, [holeId]);
      return r.rows[0];
    });
    if (!deleted) {
      throw badRequest('시공이력이 있는 천공번호는 삭제할 수 없습니다. 상태를 보류/변경으로 바꾸십시오.',
        'HOLE_NOT_DELETABLE');
    }
    res.json({ deleted: deleted.hole_no });
  } catch (e) { next(e); }
});
