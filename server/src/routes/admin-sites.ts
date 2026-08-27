/**
 * PHASE 2 — 현장 최초설정 STEP 1~5 (Master Prompt §17)
 * 전부 본사(HEAD_OFFICE) 전용이다.
 * "최초 현장설정은 상세하게 할 수 있지만 일일입력은 극도로 단순하게" (§1-3)
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';

export const adminSiteRouter = Router();
adminSiteRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const uuid = z.string().uuid();

/* ---------------------------------------------------------------- STEP 1 */
const siteCreate = z.object({
  site_code: z.string().min(1).max(50),
  site_name: z.string().min(1).max(200),
  client_name: z.string().max(200).optional(),
  location: z.string().max(300).optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  memo: z.string().max(2000).optional(),
});

adminSiteRouter.post('/', async (req, res, next) => {
  try {
    const p = siteCreate.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '현장 정보가 올바르지 않습니다.');
    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `INSERT INTO core.site
           (site_code, site_name, client_name, location, start_date, end_date, memo,
            status, setup_step, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PREPARING',1,$8)
         RETURNING id, site_code, site_name, status, setup_step`,
        [p.data.site_code, p.data.site_name, p.data.client_name ?? null, p.data.location ?? null,
         p.data.start_date ?? null, p.data.end_date ?? null, p.data.memo ?? null, req.actor!.userId]);
      return r.rows[0];
    });
    res.status(201).json({ site: row });
  } catch (e) { next(e); }
});

adminSiteRouter.patch('/:siteId', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = siteCreate.partial().extend({
      status: z.enum(['PREPARING', 'ACTIVE', 'SUSPENDED', 'CLOSED']).optional(),
      setup_step: z.number().int().min(1).max(12).optional(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest('수정 값이 올바르지 않습니다.');

    const fields = Object.entries(p.data).filter(([, v]) => v !== undefined);
    if (fields.length === 0) throw badRequest('수정할 항목이 없습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      const r = await c.query(
        `UPDATE core.site SET ${sets} WHERE id = $1 RETURNING id, site_code, site_name, status, setup_step`,
        [siteId, ...fields.map(([, v]) => v)]);
      return r.rows[0];
    });
    if (!row) throw notFound('현장을 찾을 수 없습니다.');
    res.json({ site: row });
  } catch (e) { next(e); }
});

/** 현장 최초설정 진행상황 — 무엇이 남았는지 코드가 판정한다 (§17) */
adminSiteRouter.get('/:siteId/setup-status', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT * FROM core.fn_site_setup_status($1)', [siteId]);
      return r.rows as { step: number; name: string; done: boolean; detail: string }[];
    });
    const nextStep = rows.find((s) => !s.done)?.step ?? null;
    res.json({ steps: rows, next_step: nextStep, completed: nextStep === null });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- 현장 사용자 배정 */
adminSiteRouter.post('/:siteId/users', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.object({ user_id: z.string().uuid() }).safeParse(req.body);
    if (!p.success) throw badRequest('사용자 ID 가 올바르지 않습니다.');
    await withSession(req.actor!, async (c) => {
      await c.query(
        `INSERT INTO core.user_site_access (user_id, site_id, granted_by)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [p.data.user_id, siteId, req.actor!.userId]);
    });
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

/* --------------------------------------- STEP 5 : 현장별 천공종류 (§5) */
const holeTypeInput = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(50),
  sort_order: z.number().int().min(0).max(999).default(0),
  /**
   * 이 천공종류의 단가가 들어있는 계약내역서 품목코드.
   * 단가는 천공 한 공 한 공에 붙이지 않는다. 내역서에 있다 (사용자 확인 2026-08-27).
   * 설계변경이 나면 현재 revision 의 같은 품목코드를 자동으로 따라간다 (§38).
   */
  contract_item_code: z.string().max(60).nullish(),
});

adminSiteRouter.post('/:siteId/hole-types', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.union([holeTypeInput, z.array(holeTypeInput).min(1).max(50)]).safeParse(req.body);
    if (!p.success) throw badRequest('천공종류 정보가 올바르지 않습니다.');
    const items = Array.isArray(p.data) ? p.data : [p.data];

    const rows = await withSession(req.actor!, async (c) => {
      const out = [];
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO core.site_hole_type
             (site_id, code, name, sort_order, contract_item_code)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (site_id, code) DO UPDATE
             SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
                 contract_item_code = COALESCE(EXCLUDED.contract_item_code,
                                               core.site_hole_type.contract_item_code)
           RETURNING id, code, name, sort_order, is_active, contract_item_code`,
          [siteId, it.code, it.name, it.sort_order, it.contract_item_code ?? null]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ hole_types: rows });
  } catch (e) { next(e); }
});

/* ------------------------------- 현장 설계 파라미터 (직경/C.T.C/할증률 등) */
const designParam = z.object({
  param_code: z.string().min(1).max(40),
  param_name: z.string().min(1).max(100),
  param_value: z.number().finite(),
  unit: z.string().max(20).optional(),
  note: z.string().max(300).optional(),
  /** C.T.C 처럼 구간마다 달라지는 값은 구간명을 넣는다. 비우면 현장 전체 기본값. */
  section: z.string().max(100).optional(),
  /** 계산으로 얻은 추정치는 확정 근거가 아니다 (예: 연장÷C.T.C). */
  is_reference: z.boolean().default(false),
});

adminSiteRouter.post('/:siteId/design-params', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.union([designParam, z.array(designParam).min(1).max(50)]).safeParse(req.body);
    if (!p.success) throw badRequest('설계 파라미터가 올바르지 않습니다.');
    const items = Array.isArray(p.data) ? p.data : [p.data];

    const rows = await withSession(req.actor!, async (c) => {
      const out = [];
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO core.site_design_param
             (site_id, param_code, param_name, param_value, unit, note, section, is_reference, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (site_id, param_code, COALESCE(section, '')) DO UPDATE
             SET param_name = EXCLUDED.param_name, param_value = EXCLUDED.param_value,
                 unit = EXCLUDED.unit, note = EXCLUDED.note,
                 is_reference = EXCLUDED.is_reference
           RETURNING id, param_code, param_name, param_value, unit, note, section, is_reference`,
          [siteId, it.param_code, it.param_name, it.param_value,
           it.unit ?? null, it.note ?? null, it.section ?? null, it.is_reference,
           req.actor!.userId]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ design_params: rows });
  } catch (e) { next(e); }
});

/* ------------------------------ STEP 10 : 기본 인원 / 기본 장비 (§21, §22) */
/**
 * 직종·장비 목록을 시스템이 강제하지 않는다. 현장이 정한다.
 * 단가는 여기서 받지 않는다. 내부원가는 private_cost 에만 둔다 (§29).
 */
const laborInput = z.object({
  role_name: z.string().min(1).max(50),
  headcount: z.number().nonnegative().max(999),
  sort_order: z.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
  note: z.string().max(200).optional(),
});

adminSiteRouter.post('/:siteId/default-labor', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.union([laborInput, z.array(laborInput).min(1).max(50)]).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '기본 인원이 올바르지 않습니다.');
    const items = Array.isArray(p.data) ? p.data : [p.data];

    const rows = await withSession(req.actor!, async (c) => {
      const out = [];
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO core.site_default_labor
             (site_id, role_name, headcount, sort_order, is_active, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (site_id, role_name) DO UPDATE
             SET headcount = EXCLUDED.headcount, sort_order = EXCLUDED.sort_order,
                 is_active = EXCLUDED.is_active, note = EXCLUDED.note
           RETURNING id, role_name, headcount, sort_order, is_active, note`,
          [siteId, it.role_name, it.headcount, it.sort_order, it.is_active,
           it.note ?? null, req.actor!.userId]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ default_labor: rows });
  } catch (e) { next(e); }
});

const equipmentInput = z.object({
  equipment_name: z.string().min(1).max(50),
  charge_type: z.enum(['DAILY', 'MONTHLY', 'OTHER']),
  quantity: z.number().nonnegative().max(999).default(1),
  sort_order: z.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
  note: z.string().max(200).optional(),
});

adminSiteRouter.post('/:siteId/default-equipment', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = z.union([equipmentInput, z.array(equipmentInput).min(1).max(50)]).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '기본 장비가 올바르지 않습니다.');
    const items = Array.isArray(p.data) ? p.data : [p.data];

    const rows = await withSession(req.actor!, async (c) => {
      const out = [];
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO core.site_default_equipment
             (site_id, equipment_name, charge_type, quantity, sort_order, is_active, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (site_id, equipment_name) DO UPDATE
             SET charge_type = EXCLUDED.charge_type, quantity = EXCLUDED.quantity,
                 sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
                 note = EXCLUDED.note
           RETURNING id, equipment_name, charge_type, quantity, sort_order, is_active, note`,
          [siteId, it.equipment_name, it.charge_type, it.quantity, it.sort_order,
           it.is_active, it.note ?? null, req.actor!.userId]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ default_equipment: rows });
  } catch (e) { next(e); }
});
