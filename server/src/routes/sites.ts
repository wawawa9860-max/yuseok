import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';

export const siteRouter = Router();
siteRouter.use(requireAuth);

const uuid = z.string().uuid();

/** 현장 목록 — RLS 가 배정된 현장만 돌려준다. */
siteRouter.get('/', async (req, res, next) => {
  try {
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT s.id, s.site_code, s.site_name, s.client_name, s.location,
                s.status, s.setup_step
           FROM core.site s ORDER BY s.site_code`);
      return r.rows;
    });
    res.json({ sites: rows });
  } catch (e) { next(e); }
});

siteRouter.get('/:siteId', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const data = await withSession(req.actor!, async (c) => {
      const site = await c.query(
        `SELECT id, site_code, site_name, client_name, location, status,
                setup_step, start_date, end_date
           FROM core.site WHERE id = $1`, [siteId]);
      if (!site.rowCount) return null;
      const holeTypes = await c.query(
        `SELECT id, code, name, sort_order, is_active FROM core.site_hole_type
          WHERE site_id=$1 AND is_active ORDER BY sort_order`, [siteId]);
      const groundTypes = await c.query(
        `SELECT id, code, name, sort_order, is_active, status, note
           FROM core.ground_type
          WHERE site_id=$1 AND is_active ORDER BY sort_order`, [siteId]);
      const summary = await c.query(
        `SELECT count(*)::int AS total_holes,
                count(*) FILTER (WHERE status='COMPLETED')::int AS completed_holes,
                count(*) FILTER (WHERE status='COMPLETED'
                                   AND construction_date = CURRENT_DATE)::int AS today_holes
           FROM core.hole_master WHERE site_id=$1`, [siteId]);
      return {
        site: site.rows[0],
        hole_types: holeTypes.rows,
        ground_types: groundTypes.rows,
        summary: summary.rows[0],
      };
    });
    if (!data) throw notFound('현장을 찾을 수 없습니다.');
    res.json(data);
  } catch (e) {
    if (e instanceof z.ZodError) return next(badRequest('현장 ID 형식이 올바르지 않습니다.'));
    next(e);
  }
});

/** 현장별 지층종류 — 하드코딩된 목록이 아니라 DB 에 등록된 것만 반환한다 (§7). */
siteRouter.get('/:siteId/ground-types', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT id, code, name, sort_order, is_active, status, note
           FROM core.ground_type
          WHERE site_id=$1 ORDER BY sort_order, code`, [siteId]);
      return r.rows;
    });
    res.json({ ground_types: rows });
  } catch (e) { next(e); }
});

/** 지반조건(조합+깊이) 조회 (§8, §9) */
siteRouter.get('/:siteId/ground-profiles', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const rows = await withSession(req.actor!, async (c) => {
      const profiles = await c.query(
        `SELECT p.id, p.profile_name, p.revision, p.depth_mode, p.total_planned_depth,
                p.source, p.source_reference, p.status,
                core.fn_profile_layer_sum(p.id) AS layer_sum
           FROM core.ground_profile p
          WHERE p.site_id=$1 ORDER BY p.profile_name, p.revision`, [siteId]);
      const layers = await c.query(
        `SELECT l.ground_profile_id, l.sequence, g.code AS ground_type_code,
                g.name AS ground_type_name, l.from_depth, l.to_depth, l.planned_length
           FROM core.ground_profile_layer l
           JOIN core.ground_type g ON g.id = l.ground_type_id
           JOIN core.ground_profile p ON p.id = l.ground_profile_id
          WHERE p.site_id=$1 ORDER BY l.ground_profile_id, l.sequence`, [siteId]);
      return profiles.rows.map((p: Record<string, unknown>) => ({
        ...p,
        layers: layers.rows.filter((l) => l.ground_profile_id === p.id),
      }));
    });
    res.json({ ground_profiles: rows });
  } catch (e) { next(e); }
});

/** 자동 검증 (§43). 현장관리자에게 전부 보여주지 않고 본사가 우선 확인한다. */
siteRouter.get('/:siteId/validation', requireRole('HEAD_OFFICE'), async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT * FROM core.fn_validate_site_full($1)', [siteId]);
      return r.rows;
    });
    res.json({
      issues: rows,
      error_count: rows.filter((r) => r.severity === 'ERROR').length,
      warn_count: rows.filter((r) => r.severity === 'WARN').length,
    });
  } catch (e) { next(e); }
});
