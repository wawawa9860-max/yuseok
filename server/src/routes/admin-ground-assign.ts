/**
 * PHASE 3 — 천공번호 범위별 지반조건 일괄설정
 * Master Prompt §10, §11, §19, §38, §46
 *
 * "현장에서 수백 개 천공번호를 하나씩 입력하게 해서는 안 된다. 반드시 범위 지정 기능을 만든다." (§10)
 * "반드시 사용자에게 계산 결과를 보여주고 확인을 받은 후 저장한다." (§11)
 *
 * 모든 저장 API 는 대응하는 미리보기 API 를 가진다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession, type SessionClient } from '../db/pool.js';
import { badRequest } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';

export const groundAssignRouter = Router();
groundAssignRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const uuid = z.string().uuid();
const length = z.union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d+)?$/.test(v), '0 이상의 숫자여야 합니다.');

const rangeSpec = z.object({
  from: z.string().max(60).optional(),
  to: z.string().max(60).optional(),
  exclude: z.array(z.string().max(60)).max(2000).optional(),
  hole_type_code: z.string().max(20).optional(),
});

interface RangeHole {
  hole_id: string; hole_no: string;
  design_depth_total: string | null;
  current_profile_id: string | null; current_profile_name: string | null;
}

async function resolveRange(
  c: SessionClient, siteId: string, spec: z.infer<typeof rangeSpec>,
): Promise<RangeHole[]> {
  const r = await c.query(
    'SELECT * FROM core.fn_resolve_hole_range($1,$2,$3,$4,$5)',
    [siteId, spec.from ?? null, spec.to ?? null, spec.exclude ?? null, spec.hole_type_code ?? null]);
  return r.rows as unknown as RangeHole[];
}

function summarize(holes: RangeHole[]) {
  return {
    hole_count: holes.length,
    first: holes[0]?.hole_no ?? null,
    last: holes[holes.length - 1]?.hole_no ?? null,
    hole_numbers: holes.map((h) => h.hole_no),
    already_assigned: holes.filter((h) => h.current_profile_id).map((h) => ({
      hole_no: h.hole_no, current_profile: h.current_profile_name,
    })),
  };
}

/* ============================================================ 1) 범위 일괄적용 (§10) */
const bulkAssign = rangeSpec.extend({
  profile_name: z.string().min(1).max(200),
  depth_mode: z.enum(['DEPTH_RANGE', 'LENGTH_ONLY']).default('DEPTH_RANGE'),
  total_planned_depth: length,
  source: z.enum(['QUANTITY_SHEET', 'APPROVED_DRAWING', 'APPROVED_MANUAL']).default('QUANTITY_SHEET'),
  source_reference: z.string().max(300).optional(),
  layers: z.array(z.object({
    ground_type_code: z.string().min(1).max(20),
    planned_length: length,
  })).min(1).max(20),
  reason: z.string().max(500).optional(),
});

/** 검증 결과를 계산만 한다. 저장하지 않는다. */
function checkLayers(d: z.infer<typeof bulkAssign>) {
  const sum = d.layers.reduce((a, l) => a + Number(l.planned_length), 0);
  const total = Number(d.total_planned_depth);
  const issues: { code: string; severity: string; message: string }[] = [];
  if (Math.abs(sum - total) > 0.001) {
    issues.push({
      code: 'LAYER_SUM_MISMATCH', severity: 'ERROR',
      message: `지층별 길이 합계 ${sum.toFixed(3)}m 가 총 계획심도 ${total.toFixed(3)}m 와 다릅니다.`,
    });
  }
  const codes = d.layers.map((l) => l.ground_type_code);
  if (new Set(codes).size !== codes.length) {
    issues.push({
      code: 'DUPLICATE_GROUND_TYPE', severity: 'ERROR',
      message: '같은 지층종류가 두 번 이상 지정되었습니다.',
    });
  }
  return { layer_sum: Number(sum.toFixed(3)), total_planned_depth: total, issues };
}

groundAssignRouter.post('/sites/:siteId/ground-assignments/preview', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = bulkAssign.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');

    const check = checkLayers(p.data);
    const holes = await withSession(req.actor!, async (c) => resolveRange(c, siteId, p.data));
    const summary = summarize(holes);

    const issues = [...check.issues];
    if (summary.hole_count === 0) {
      issues.push({ code: 'NO_HOLE_IN_RANGE', severity: 'ERROR', message: '지정한 범위에 천공번호가 없습니다.' });
    }
    if (summary.already_assigned.length > 0) {
      issues.push({
        code: 'WILL_OVERWRITE', severity: 'WARN',
        message: `${summary.already_assigned.length}개 천공번호에 이미 지반조건이 있습니다. `
          + '기존 값은 Revision 으로 보존된 뒤 교체됩니다.',
      });
    }

    res.json({
      ...summary,
      layer_sum: check.layer_sum,
      total_planned_depth: check.total_planned_depth,
      total_planned_length: Number((check.total_planned_depth * summary.hole_count).toFixed(3)),
      layer_totals: p.data.layers.map((l) => ({
        ground_type_code: l.ground_type_code,
        per_hole: Number(l.planned_length),
        total: Number((Number(l.planned_length) * summary.hole_count).toFixed(3)),
      })),
      issues,
      can_save: issues.filter((i) => i.severity === 'ERROR').length === 0,
    });
  } catch (e) { next(e); }
});

groundAssignRouter.post('/sites/:siteId/ground-assignments/apply', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = bulkAssign.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');
    const d = p.data;

    const check = checkLayers(d);
    if (check.issues.some((i) => i.severity === 'ERROR')) {
      throw badRequest(check.issues[0]!.message, check.issues[0]!.code);
    }

    const result = await withSession(req.actor!, async (c) => {
      const holes = await resolveRange(c, siteId, d);
      if (holes.length === 0) throw badRequest('지정한 범위에 천공번호가 없습니다.', 'NO_HOLE_IN_RANGE');

      // 같은 이름의 지반조건이 이미 있으면 그 revision 을 이어간다.
      const existing = await c.query(
        `SELECT COALESCE(max(revision), -1) + 1 AS n FROM core.ground_profile
          WHERE site_id=$1 AND profile_name=$2`, [siteId, d.profile_name]);
      const revision = Number(existing.rows[0]!.n);

      const gp = await c.query(
        `INSERT INTO core.ground_profile
           (site_id, profile_name, revision, description, depth_mode, total_planned_depth,
            source, source_reference, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9)
         RETURNING id`,
        [siteId, d.profile_name, revision,
         d.reason ?? `${d.from ?? '처음'} ~ ${d.to ?? '끝'} 범위 일괄적용`,
         d.depth_mode, d.total_planned_depth, d.source, d.source_reference ?? null,
         req.actor!.userId]);
      const profileId = gp.rows[0]!.id as string;

      let from = 0;
      for (let i = 0; i < d.layers.length; i++) {
        const l = d.layers[i]!;
        const gt = await c.query(
          'SELECT id FROM core.ground_type WHERE site_id=$1 AND code=$2',
          [siteId, l.ground_type_code]);
        const gtId = gt.rows[0]?.id;
        if (!gtId) throw badRequest(`지층종류 '${l.ground_type_code}' 가 등록되어 있지 않습니다.`);
        if (d.depth_mode === 'DEPTH_RANGE') {
          const to = Number((from + Number(l.planned_length)).toFixed(3));
          await c.query(
            `INSERT INTO core.ground_profile_layer
               (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [profileId, i + 1, gtId, from, to, l.planned_length]);
          from = to;
        } else {
          await c.query(
            `INSERT INTO core.ground_profile_layer
               (ground_profile_id, sequence, ground_type_id, planned_length)
             VALUES ($1,$2,$3,$4)`, [profileId, i + 1, gtId, l.planned_length]);
        }
      }

      // 확정 시 "지층합계 = 총 계획심도" 가 DB에서 강제된다 (§8)
      await c.query(
        `UPDATE core.ground_profile SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now()
          WHERE id=$1`, [profileId, req.actor!.userId]);

      const assigned = await c.query(
        'SELECT core.fn_assign_ground_profile($1,$2,$3) AS n',
        [profileId, holes.map((h) => h.hole_id), d.reason ?? '범위 일괄적용']);

      await c.query(
        'UPDATE core.site SET setup_step = GREATEST(setup_step, 7) WHERE id=$1', [siteId]);

      return {
        ground_profile_id: profileId,
        profile_name: d.profile_name,
        revision,
        matched_holes: holes.length,
        assigned_holes: Number(assigned.rows[0]!.n),
        first: holes[0]?.hole_no ?? null,
        last: holes[holes.length - 1]?.hole_no ?? null,
      };
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/* ================================================ 2) 총연장 → 공당 환산 (§11) */
/**
 * 수량산출서가 "A-001~A-030 토사 360m, 풍화암 240m" 처럼 구간 합계만 줄 때
 * 공당 값으로 환산한다. **환산 결과를 보여주기만 하고 저장하지 않는다.**
 * 저장은 사용자가 확인한 뒤 /apply 를 호출해서 이루어진다 (§11).
 */
const convertSpec = rangeSpec.extend({
  totals: z.array(z.object({
    ground_type_code: z.string().min(1).max(20),
    total_length: length,
  })).min(1).max(20),
});

groundAssignRouter.post('/sites/:siteId/ground-assignments/convert', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = convertSpec.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');

    const holes = await withSession(req.actor!, async (c) => resolveRange(c, siteId, p.data));
    const n = holes.length;
    const issues: { code: string; severity: string; message: string }[] = [];
    if (n === 0) {
      issues.push({ code: 'NO_HOLE_IN_RANGE', severity: 'ERROR', message: '지정한 범위에 천공번호가 없습니다.' });
      return res.json({ hole_count: 0, layers: [], issues, can_save: false });
    }

    const layers = p.data.totals.map((t) => {
      const total = Number(t.total_length);
      const perHole = Number((total / n).toFixed(3));
      const recomposed = Number((perHole * n).toFixed(3));
      const remainder = Number((total - recomposed).toFixed(3));
      if (Math.abs(remainder) > 0.001) {
        issues.push({
          code: 'NOT_DIVIDED_EVENLY', severity: 'WARN',
          message: `${t.ground_type_code}: ${total}m ÷ ${n}공 = ${perHole}m/공 으로 나누면 `
            + `${remainder > 0 ? '+' : ''}${remainder}m 차이가 납니다. `
            + '수량산출서가 공별로 다른 값을 가진다면 공별 입력을 사용하십시오.',
        });
      }
      return {
        ground_type_code: t.ground_type_code,
        total_length: total, per_hole: perHole,
        recomposed_total: recomposed, remainder,
      };
    });

    const perHoleSum = Number(layers.reduce((a, l) => a + l.per_hole, 0).toFixed(3));
    res.json({
      hole_count: n,
      first: holes[0]?.hole_no ?? null,
      last: holes[holes.length - 1]?.hole_no ?? null,
      layers,
      suggested_total_planned_depth: perHoleSum,
      /** §11: 이 값은 제안일 뿐이다. 사용자가 확인해야 저장된다. */
      confirmation_required: true,
      issues,
      can_save: issues.filter((i) => i.severity === 'ERROR').length === 0,
    });
  } catch (e) { next(e); }
});

/* ============================================ 3) 공별 원본값 적용 (§11 후단) */
/**
 * "수량산출서가 공별로 서로 다른 값을 가지고 있다면 원본 값을 그대로 적용한다." (§11)
 * 같은 지층 조합은 하나의 지반조건을 공유해 데이터가 불필요하게 늘지 않게 한다.
 */
const perHoleSpec = z.object({
  source: z.enum(['QUANTITY_SHEET', 'APPROVED_DRAWING', 'APPROVED_MANUAL']).default('QUANTITY_SHEET'),
  source_reference: z.string().max(300).optional(),
  depth_mode: z.enum(['DEPTH_RANGE', 'LENGTH_ONLY']).default('DEPTH_RANGE'),
  reason: z.string().max(500).optional(),
  rows: z.array(z.object({
    hole_no: z.string().min(1).max(60),
    layers: z.array(z.object({
      ground_type_code: z.string().min(1).max(20),
      planned_length: length,
    })).min(1).max(20),
    /** 생략하면 지층합계를 총심도로 사용한다. */
    total_planned_depth: length.optional(),
  })).min(1).max(2000),
});

/** 지층 조합을 문자열 하나로 요약한다. 같은 조합은 같은 서명을 갖는다. */
function signature(layers: { ground_type_code: string; planned_length: string }[]): string {
  return layers.map((l) => `${l.ground_type_code}:${Number(l.planned_length).toFixed(3)}`).join(' + ');
}

groundAssignRouter.post('/sites/:siteId/ground-assignments/per-hole/preview', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = perHoleSpec.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');

    const issues: { code: string; severity: string; target?: string; message: string }[] = [];
    const combos = new Map<string, number>();
    const layerTotals = new Map<string, number>();

    for (const row of p.data.rows) {
      const sum = row.layers.reduce((a, l) => a + Number(l.planned_length), 0);
      const total = row.total_planned_depth === undefined ? sum : Number(row.total_planned_depth);
      if (Math.abs(sum - total) > 0.001) {
        issues.push({
          code: 'LAYER_SUM_MISMATCH', severity: 'ERROR', target: row.hole_no,
          message: `${row.hole_no}: 지층합계 ${sum.toFixed(3)}m ≠ 총심도 ${total.toFixed(3)}m`,
        });
      }
      const sig = signature(row.layers);
      combos.set(sig, (combos.get(sig) ?? 0) + 1);
      for (const l of row.layers) {
        layerTotals.set(l.ground_type_code,
          (layerTotals.get(l.ground_type_code) ?? 0) + Number(l.planned_length));
      }
    }

    const known = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT h.hole_no FROM core.hole_master h
          WHERE h.site_id=$1 AND h.hole_no = ANY($2)`,
        [siteId, p.data.rows.map((r2) => r2.hole_no)]);
      return new Set(r.rows.map((x: { hole_no: string }) => x.hole_no));
    });
    for (const row of p.data.rows) {
      if (!known.has(row.hole_no)) {
        issues.push({
          code: 'HOLE_NOT_FOUND', severity: 'ERROR', target: row.hole_no,
          message: `천공번호 ${row.hole_no} 가 이 현장에 없습니다.`,
        });
      }
    }

    res.json({
      row_count: p.data.rows.length,
      distinct_profiles: combos.size,
      profiles: [...combos.entries()]
        .map(([sig, n]) => ({ signature: sig, hole_count: n }))
        .sort((a, b) => b.hole_count - a.hole_count),
      layer_totals: [...layerTotals.entries()]
        .map(([code, m]) => ({ ground_type_code: code, total_length: Number(m.toFixed(3)) }))
        .sort((a, b) => (a.ground_type_code < b.ground_type_code ? -1 : 1)),
      grand_total: Number([...layerTotals.values()].reduce((a, b) => a + b, 0).toFixed(3)),
      issues,
      can_save: issues.filter((i) => i.severity === 'ERROR').length === 0,
    });
  } catch (e) { next(e); }
});

groundAssignRouter.post('/sites/:siteId/ground-assignments/per-hole/apply', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = perHoleSpec.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '입력이 올바르지 않습니다.');
    const d = p.data;

    for (const row of d.rows) {
      const sum = row.layers.reduce((a, l) => a + Number(l.planned_length), 0);
      const total = row.total_planned_depth === undefined ? sum : Number(row.total_planned_depth);
      if (Math.abs(sum - total) > 0.001) {
        throw badRequest(
          `${row.hole_no}: 지층합계 ${sum.toFixed(3)}m ≠ 총심도 ${total.toFixed(3)}m`,
          'LAYER_SUM_MISMATCH');
      }
    }

    const result = await withSession(req.actor!, async (c) => {
      const gtRows = await c.query(
        'SELECT id, code FROM core.ground_type WHERE site_id=$1', [siteId]);
      const gtId = new Map<string, string>(
        gtRows.rows.map((r: { code: string; id: string }) => [r.code, r.id]));

      const profileCache = new Map<string, string>();
      let created = 0;
      let assigned = 0;

      for (const row of d.rows) {
        const sig = signature(row.layers);
        let profileId = profileCache.get(sig);

        if (!profileId) {
          const total = row.total_planned_depth === undefined
            ? row.layers.reduce((a, l) => a + Number(l.planned_length), 0)
            : Number(row.total_planned_depth);

          const found = await c.query(
            `SELECT id FROM core.ground_profile
              WHERE site_id=$1 AND profile_name=$2 AND status='CONFIRMED'`, [siteId, sig]);
          if (found.rowCount) {
            profileId = found.rows[0]!.id as string;
          } else {
            const gp = await c.query(
              `INSERT INTO core.ground_profile
                 (site_id, profile_name, revision, description, depth_mode, total_planned_depth,
                  source, source_reference, status, created_by)
               VALUES ($1,$2,0,$3,$4,$5,$6,$7,'DRAFT',$8) RETURNING id`,
              [siteId, sig, d.reason ?? '수량산출서 공별 원본값', d.depth_mode, total,
               d.source, d.source_reference ?? null, req.actor!.userId]);
            profileId = gp.rows[0]!.id as string;

            let from = 0;
            for (let i = 0; i < row.layers.length; i++) {
              const l = row.layers[i]!;
              const id = gtId.get(l.ground_type_code);
              if (!id) throw badRequest(`지층종류 '${l.ground_type_code}' 가 등록되어 있지 않습니다.`);
              if (d.depth_mode === 'DEPTH_RANGE') {
                const to = Number((from + Number(l.planned_length)).toFixed(3));
                await c.query(
                  `INSERT INTO core.ground_profile_layer
                     (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
                   VALUES ($1,$2,$3,$4,$5,$6)`,
                  [profileId, i + 1, id, from, to, l.planned_length]);
                from = to;
              } else {
                await c.query(
                  `INSERT INTO core.ground_profile_layer
                     (ground_profile_id, sequence, ground_type_id, planned_length)
                   VALUES ($1,$2,$3,$4)`, [profileId, i + 1, id, l.planned_length]);
              }
            }
            await c.query(
              `UPDATE core.ground_profile SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now()
                WHERE id=$1`, [profileId, req.actor!.userId]);
            created++;
          }
          profileCache.set(sig, profileId);
        }

        const hole = await c.query(
          'SELECT id FROM core.hole_master WHERE site_id=$1 AND hole_no=$2', [siteId, row.hole_no]);
        const holeId = hole.rows[0]?.id;
        if (!holeId) throw badRequest(`천공번호 ${row.hole_no} 가 이 현장에 없습니다.`, 'HOLE_NOT_FOUND');

        const n = await c.query(
          'SELECT core.fn_assign_ground_profile($1,$2,$3) AS n',
          [profileId, [holeId], d.reason ?? '수량산출서 공별 원본값']);
        assigned += Number(n.rows[0]!.n);
      }

      await c.query(
        'UPDATE core.site SET setup_step = GREATEST(setup_step, 7) WHERE id=$1', [siteId]);
      return { rows: d.rows.length, created_profiles: created, assigned_holes: assigned };
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});
