import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest } from '../http/errors.js';
import { requireAuth } from '../http/context.js';

export const holeRouter = Router();
holeRouter.use(requireAuth);

const uuid = z.string().uuid();

/**
 * 조회 컬럼. 계약단가(contract_unit_price)는 사용자 지시에 따라 현장관리자에게도 공개한다.
 * 내부원가(private_cost)는 별개이며 여전히 차단된다 (§29).
 */
const HOLE_COLUMNS = `
  h.id, h.hole_no, h.sort_key, h.drawing_sequence, h.drawing_ref,
  h.section, h.hole_type_id,
  h.design_depth_total, h.actual_depth_total, h.ground_profile_id,
  h.contract_quantity, h.contract_unit, h.contract_unit_price,
  h.planned_ready_mix_quantity, h.actual_ready_mix_quantity,
  h.status, h.construction_date, h.change_review_required,
  h.drawing_revision, h.quantity_revision`;

const listQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.enum(['NOT_STARTED', 'COMPLETED', 'ON_HOLD', 'CHANGED', 'NEEDS_CHECK']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/**
 * 천공번호 목록. from/to 로 범위 선택 (§19).
 * 정렬·범위비교는 항상 자연정렬 키(sort_key)로 한다.
 * 번호 형식이 '1', '1.1', 'A-001', 'C1-10' 무엇이든 사람이 읽는 순서대로 동작한다.
 */
holeRouter.get('/:siteId/holes', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = listQuery.safeParse(req.query);
    if (!q.success) throw badRequest('조회 조건이 올바르지 않습니다.');
    const { from, to, status, limit } = q.data;

    const rows = await withSession(req.actor!, async (c) => {
      const params: unknown[] = [siteId];
      let where = 'h.site_id = $1';
      if (from) { params.push(from); where += ` AND h.sort_key >= core.fn_natural_sort_key($${params.length})`; }
      if (to)   { params.push(to);   where += ` AND h.sort_key <= core.fn_natural_sort_key($${params.length})`; }
      if (status) { params.push(status); where += ` AND h.status = $${params.length}`; }
      params.push(limit);

      const r = await c.query(
        `SELECT ${HOLE_COLUMNS},
                ht.name AS hole_type_name,
                CASE
                  WHEN h.status='COMPLETED' AND h.construction_date=CURRENT_DATE THEN '금일완료'
                  WHEN h.status='COMPLETED' THEN '기존완료'
                  WHEN h.status='ON_HOLD' THEN '보류'
                  WHEN h.status='CHANGED' THEN '변경'
                  WHEN h.status='NEEDS_CHECK' THEN '확인필요'
                  ELSE '미시공'
                END AS display_status
           FROM core.hole_master h
           LEFT JOIN core.site_hole_type ht ON ht.id = h.hole_type_id
          WHERE ${where}
          ORDER BY h.sort_key
          LIMIT $${params.length}`, params);
      return r.rows;
    });
    res.json({ holes: rows, count: rows.length });
  } catch (e) { next(e); }
});

/**
 * 지층별 계획수량 자동집계 (§20).
 * 현장관리자가 토사/풍화암/연암 수량을 직접 입력하지 않는다.
 * 계산은 전부 SQL 에서 결정론적으로 수행한다 (§46).
 */
holeRouter.get('/:siteId/layer-summary', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = listQuery.safeParse(req.query);
    if (!q.success) throw badRequest('조회 조건이 올바르지 않습니다.');

    const data = await withSession(req.actor!, async (c) => {
      const params: unknown[] = [siteId];
      let where = 'v.site_id = $1';
      if (q.data.status) { params.push(q.data.status); where += ` AND v.status = $${params.length}`; }
      if (q.data.from)   { params.push(q.data.from);   where += ` AND v.sort_key >= core.fn_natural_sort_key($${params.length})`; }
      if (q.data.to)     { params.push(q.data.to);     where += ` AND v.sort_key <= core.fn_natural_sort_key($${params.length})`; }

      const layers = await c.query(
        `SELECT v.ground_type_code, v.ground_type_name,
                sum(v.planned_length)::numeric(14,3) AS planned_length,
                count(DISTINCT v.hole_id)::int AS hole_count
           FROM core.v_hole_layer_plan v
          WHERE ${where}
          GROUP BY v.ground_type_code, v.ground_type_name
          ORDER BY v.ground_type_code`, params);
      const total = await c.query(
        `SELECT COALESCE(sum(v.planned_length),0)::numeric(14,3) AS total_length,
                count(DISTINCT v.hole_id)::int AS hole_count
           FROM core.v_hole_layer_plan v WHERE ${where}`, params);
      return { layers: layers.rows, total: total.rows[0] };
    });
    res.json(data);
  } catch (e) { next(e); }
});
