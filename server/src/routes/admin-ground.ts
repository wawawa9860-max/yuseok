/**
 * PHASE 3 — GROUND_TYPE / GROUND_PROFILE / 범위 일괄설정
 * Master Prompt §6~§11, §38, §46
 *
 * 세 가지 입력경로를 모두 지원한다.
 *   1) 범위 일괄적용     — 구간 내 공통 지반조건 (§10)
 *   2) 총연장 → 공당 환산 — 수량산출서가 구간 합계만 줄 때 (§11)
 *   3) 공별 원본값 적용   — 수량산출서가 공별로 다른 값을 줄 때 (§11 후단)
 *
 * 공통 규칙: **미리보기 → 사용자 확인 → 저장.** 시스템이 임의로 확정하지 않는다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';

export const adminGroundRouter = Router();
adminGroundRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const uuid = z.string().uuid();
/** 길이는 문자열로 다뤄 부동소수점 오차를 만들지 않는다 (§46). */
const length = z.union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d+)?$/.test(v), '0 이상의 숫자여야 합니다.');

/* ================================================== 지층종류 (§7) */
const groundTypeInput = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(50),
  sort_order: z.number().int().min(0).max(999).default(0),
  status: z.enum(['CONFIRMED', 'PROVISIONAL', 'RETIRED']).default('CONFIRMED'),
  note: z.string().max(300).optional(),
});

adminGroundRouter.post('/sites/:siteId/ground-types', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.union([groundTypeInput, z.array(groundTypeInput).min(1).max(50)])
      .safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '지층종류가 올바르지 않습니다.');
    const items = Array.isArray(p.data) ? p.data : [p.data];

    const rows = await withSession(req.actor!, async (c) => {
      const out = [];
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO core.ground_type (site_id, code, name, sort_order, status, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (site_id, code) DO UPDATE
             SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
                 status = EXCLUDED.status, note = EXCLUDED.note
           RETURNING id, code, name, sort_order, status, note, is_active`,
          [siteId, it.code, it.name, it.sort_order, it.status, it.note ?? null, req.actor!.userId]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ ground_types: rows });
  } catch (e) { next(e); }
});

adminGroundRouter.patch('/ground-types/:id', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const p = groundTypeInput.partial().extend({ is_active: z.boolean().optional() })
      .safeParse(req.body);
    if (!p.success) throw badRequest('수정 값이 올바르지 않습니다.');
    const fields = Object.entries(p.data).filter(([, v]) => v !== undefined);
    if (fields.length === 0) throw badRequest('수정할 항목이 없습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      const r = await c.query(
        `UPDATE core.ground_type SET ${sets} WHERE id = $1
         RETURNING id, code, name, sort_order, status, note, is_active`,
        [id, ...fields.map(([, v]) => v)]);
      return r.rows[0];
    });
    if (!row) throw notFound('지층종류를 찾을 수 없습니다.');
    res.json({ ground_type: row });
  } catch (e) { next(e); }
});

/** 사용 중인 지층종류는 삭제되지 않는다 (DB 트리거가 막는다). */
adminGroundRouter.delete('/ground-types/:id', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query('DELETE FROM core.ground_type WHERE id=$1 RETURNING code', [id]);
      return r.rows[0];
    });
    if (!row) throw notFound('지층종류를 찾을 수 없습니다.');
    res.json({ deleted: row.code });
  } catch (e) { next(e); }
});

/* ============================================ 지반조건 (§8, §9, §38) */
const layerInput = z.object({
  ground_type_code: z.string().min(1).max(20),
  planned_length: length,
});

const profileInput = z.object({
  profile_name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  depth_mode: z.enum(['DEPTH_RANGE', 'LENGTH_ONLY']).default('DEPTH_RANGE'),
  total_planned_depth: length,
  source: z.enum(['QUANTITY_SHEET', 'APPROVED_DRAWING', 'APPROVED_MANUAL']).default('QUANTITY_SHEET'),
  source_reference: z.string().max(300).optional(),
  layers: z.array(layerInput).min(1).max(20),
  /** 생성 즉시 확정할지. 확정 시 지층합계 = 총심도 가 DB에서 강제된다. */
  confirm: z.boolean().default(true),
});

/**
 * 지층 목록을 depth_mode 에 맞춰 from/to 를 계산해 저장한다.
 * LENGTH_ONLY 는 깊이구간 없이 연장만 저장한다 (§9 후단).
 */
async function insertLayers(
  c: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> },
  profileId: string, siteId: string, depthMode: string,
  layers: { ground_type_code: string; planned_length: string }[],
): Promise<void> {
  let from = 0;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    const gt = await c.query(
      'SELECT id FROM core.ground_type WHERE site_id=$1 AND code=$2', [siteId, l.ground_type_code]);
    const groundTypeId = gt.rows[0]?.id;
    if (!groundTypeId) {
      throw badRequest(`지층종류 '${l.ground_type_code}' 가 이 현장에 등록되어 있지 않습니다.`);
    }
    if (depthMode === 'DEPTH_RANGE') {
      const to = Number((from + Number(l.planned_length)).toFixed(3));
      await c.query(
        `INSERT INTO core.ground_profile_layer
           (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [profileId, i + 1, groundTypeId, from, to, l.planned_length]);
      from = to;
    } else {
      await c.query(
        `INSERT INTO core.ground_profile_layer
           (ground_profile_id, sequence, ground_type_id, planned_length)
         VALUES ($1,$2,$3,$4)`,
        [profileId, i + 1, groundTypeId, l.planned_length]);
    }
  }
}

adminGroundRouter.post('/sites/:siteId/ground-profiles', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = profileInput.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '지반조건이 올바르지 않습니다.');
    const d = p.data;

    const sum = d.layers.reduce((a, l) => a + Number(l.planned_length), 0);
    if (d.confirm && Math.abs(sum - Number(d.total_planned_depth)) > 0.001) {
      throw badRequest(
        `지층별 길이 합계 ${sum.toFixed(3)}m 가 총 계획심도 ${Number(d.total_planned_depth).toFixed(3)}m 와 다릅니다.`,
        'LAYER_SUM_MISMATCH');
    }

    const row = await withSession(req.actor!, async (c) => {
      const gp = await c.query(
        `INSERT INTO core.ground_profile
           (site_id, profile_name, revision, description, depth_mode, total_planned_depth,
            source, source_reference, status, created_by)
         VALUES ($1,$2,0,$3,$4,$5,$6,$7,'DRAFT',$8)
         RETURNING id`,
        [siteId, d.profile_name, d.description ?? null, d.depth_mode, d.total_planned_depth,
         d.source, d.source_reference ?? null, req.actor!.userId]);
      const profileId = gp.rows[0].id as string;
      await insertLayers(c, profileId, siteId, d.depth_mode, d.layers);
      if (d.confirm) {
        await c.query(
          `UPDATE core.ground_profile SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now()
            WHERE id=$1`, [profileId, req.actor!.userId]);
      }
      const out = await c.query(
        `SELECT id, profile_name, revision, depth_mode, total_planned_depth, status,
                core.fn_profile_layer_sum(id) AS layer_sum
           FROM core.ground_profile WHERE id=$1`, [profileId]);
      return out.rows[0];
    });
    res.status(201).json({ ground_profile: row });
  } catch (e) { next(e); }
});

/** 확정 — 검증을 통과해야만 성공한다 (§8) */
adminGroundRouter.post('/ground-profiles/:id/confirm', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE core.ground_profile SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now()
          WHERE id=$1 AND status='DRAFT'
         RETURNING id, profile_name, revision, status`, [id, req.actor!.userId]);
      return r.rows[0];
    });
    if (!row) throw badRequest('확정 가능한 DRAFT 상태의 지반조건이 아닙니다.');
    res.json({ ground_profile: row });
  } catch (e) { next(e); }
});

/** 검증 결과만 돌려준다 (저장 전 확인용) */
adminGroundRouter.get('/ground-profiles/:id/validate', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT * FROM core.fn_validate_ground_profile($1)', [id]);
      return r.rows as { code: string; severity: string; message: string }[];
    });
    res.json({ issues: rows, valid: rows.filter((i) => i.severity === 'ERROR').length === 0 });
  } catch (e) { next(e); }
});

/** 개정 (§38) — 확정본을 수정하지 않고 새 revision 을 만든다 */
adminGroundRouter.post('/ground-profiles/:id/revise', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const p = z.object({
      total_planned_depth: length,
      layers: z.array(layerInput).min(1).max(20),
      reason: z.string().min(1).max(500),
      reassign_holes: z.boolean().default(true),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '개정 정보가 올바르지 않습니다.');
    const d = p.data;

    const sum = d.layers.reduce((a, l) => a + Number(l.planned_length), 0);
    if (Math.abs(sum - Number(d.total_planned_depth)) > 0.001) {
      throw badRequest(
        `지층별 길이 합계 ${sum.toFixed(3)}m 가 총 계획심도 ${Number(d.total_planned_depth).toFixed(3)}m 와 다릅니다.`,
        'LAYER_SUM_MISMATCH');
    }

    const result = await withSession(req.actor!, async (c) => {
      const old = await c.query(
        'SELECT site_id, depth_mode, profile_name FROM core.ground_profile WHERE id=$1', [id]);
      if (!old.rowCount) return null;
      const { site_id: siteId, depth_mode: depthMode } = old.rows[0];

      const holes = await c.query(
        'SELECT id FROM core.hole_master WHERE ground_profile_id=$1', [id]);

      const nw = await c.query(
        'SELECT core.fn_revise_ground_profile($1,$2,$3) AS id',
        [id, d.total_planned_depth, d.reason]);
      const newId = nw.rows[0].id as string;
      await insertLayers(c, newId, siteId, depthMode, d.layers);
      await c.query(
        `UPDATE core.ground_profile SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now()
          WHERE id=$1`, [newId, req.actor!.userId]);

      let reassigned = 0;
      if (d.reassign_holes && holes.rowCount) {
        const r = await c.query(
          'SELECT core.fn_assign_ground_profile($1,$2,$3) AS n',
          [newId, holes.rows.map((h: { id: string }) => h.id), d.reason]);
        reassigned = Number(r.rows[0].n);
      }

      const out = await c.query(
        `SELECT id, profile_name, revision, total_planned_depth, status FROM core.ground_profile
          WHERE id=$1`, [newId]);
      return { ground_profile: out.rows[0], reassigned_holes: reassigned };
    });
    if (!result) throw notFound('지반조건을 찾을 수 없습니다.');
    res.status(201).json(result);
  } catch (e) { next(e); }
});
