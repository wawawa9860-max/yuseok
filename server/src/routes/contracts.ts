/**
 * PHASE 2 — CONTRACT_MASTER + Revision (Master Prompt §17 STEP 2, §38)
 * 원계약 금액은 절대 덮어쓰지 않는다. 설계변경은 새 revision 으로만 반영한다.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withSession } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';

export const contractRouter = Router();
contractRouter.use(requireAuth);

const uuid = z.string().uuid();
/** 금액·수량은 문자열로 받아 부동소수점 오차를 만들지 않는다 (§46). */
const decimal = z.union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), '숫자 형식이 아닙니다.');

/* 조회 — 배정된 현장이면 현장관리자도 볼 수 있다 (계약단가 공개 지시 반영) */
contractRouter.get('/sites/:siteId/contracts', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const data = await withSession(req.actor!, async (c) => {
      const contracts = await c.query(
        `SELECT id, contract_no, contract_name, counterparty_name, contract_date,
                start_date, end_date, original_amount, current_amount,
                current_revision, status
           FROM core.contract WHERE site_id=$1 ORDER BY contract_no`, [siteId]);
      const revisions = await c.query(
        `SELECT cr.contract_id, cr.revision_no, cr.revision_type, cr.contract_amount,
                cr.effective_date, cr.reason, cr.is_current, cr.approved_at
           FROM core.contract_revision cr
           JOIN core.contract ct ON ct.id = cr.contract_id
          WHERE ct.site_id=$1 ORDER BY cr.contract_id, cr.revision_no`, [siteId]);
      return contracts.rows.map((ct: Record<string, unknown>) => ({
        ...ct,
        revisions: revisions.rows.filter((r) => r.contract_id === ct.id),
      }));
    });
    res.json({ contracts: data });
  } catch (e) { next(e); }
});

contractRouter.get('/contracts/:contractId/items', async (req, res, next) => {
  try {
    const contractId = uuid.parse(req.params.contractId);
    const revision = req.query.revision === undefined ? null : Number(req.query.revision);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT ci.id, ci.revision_no, ci.item_code, ci.item_name, ci.spec,
                ci.unit, ci.quantity, ci.unit_price, ci.amount, ci.sort_order
           FROM core.contract_item ci
           JOIN core.contract ct ON ct.id = ci.contract_id
          WHERE ci.contract_id = $1
            AND ci.revision_no = COALESCE($2, ct.current_revision)
          ORDER BY ci.sort_order, ci.item_code`, [contractId, revision]);
      return r.rows;
    });
    res.json({ items: rows });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- 등록/변경은 본사만 */
const contractCreate = z.object({
  contract_no: z.string().min(1).max(60),
  contract_name: z.string().min(1).max(200),
  counterparty_name: z.string().max(200).optional(),
  contract_date: z.string().date().optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  original_amount: decimal.default('0'),
});

contractRouter.post('/sites/:siteId/contracts', requireRole('HEAD_OFFICE'), async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = contractCreate.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '계약 정보가 올바르지 않습니다.');
    const d = p.data;

    const row = await withSession(req.actor!, async (c) => {
      const ct = await c.query(
        `INSERT INTO core.contract
           (site_id, contract_no, contract_name, counterparty_name, contract_date,
            start_date, end_date, original_amount, current_amount, current_revision,
            status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'ACTIVE',$9)
         RETURNING id, contract_no, contract_name, original_amount, current_amount, current_revision`,
        [siteId, d.contract_no, d.contract_name, d.counterparty_name ?? null,
         d.contract_date ?? null, d.start_date ?? null, d.end_date ?? null,
         d.original_amount, req.actor!.userId]);

      // 원계약을 REV 0 으로 즉시 보존한다 (§38)
      await c.query(
        `INSERT INTO core.contract_revision
           (contract_id, revision_no, revision_type, contract_amount, effective_date,
            reason, approved_by, approved_at, is_current, created_by)
         VALUES ($1,0,'ORIGINAL',$2,$3,'원계약',$4,now(),true,$4)`,
        [ct.rows[0].id, d.original_amount, d.contract_date ?? null, req.actor!.userId]);
      return ct.rows[0];
    });
    res.status(201).json({ contract: row });
  } catch (e) { next(e); }
});

/** 설계변경 Revision 등록 (§38). 등록만으로는 적용되지 않는다. */
contractRouter.post('/contracts/:contractId/revisions', requireRole('HEAD_OFFICE'), async (req, res, next) => {
  try {
    const contractId = uuid.parse(req.params.contractId);
    const p = z.object({
      contract_amount: decimal,
      effective_date: z.string().date().optional(),
      reason: z.string().min(1).max(500),
      activate: z.boolean().default(false),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '변경 정보가 올바르지 않습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const next = await c.query(
        `SELECT COALESCE(max(revision_no), -1) + 1 AS n FROM core.contract_revision
          WHERE contract_id=$1`, [contractId]);
      const revisionNo = Number(next.rows[0].n);
      if (revisionNo === 0) return null;   // 계약이 없거나 원계약이 없음

      const r = await c.query(
        `INSERT INTO core.contract_revision
           (contract_id, revision_no, revision_type, contract_amount, effective_date,
            reason, approved_by, approved_at, is_current, created_by)
         VALUES ($1,$2,'DESIGN_CHANGE',$3,$4,$5,$6,now(),false,$6)
         RETURNING id, revision_no, contract_amount, effective_date, reason, is_current`,
        [contractId, revisionNo, p.data.contract_amount,
         p.data.effective_date ?? null, p.data.reason, req.actor!.userId]);

      if (p.data.activate) {
        await c.query('SELECT core.fn_activate_contract_revision($1,$2)', [contractId, revisionNo]);
        r.rows[0].is_current = true;
      }
      return r.rows[0];
    });
    if (!row) throw notFound('계약을 찾을 수 없습니다.');
    res.status(201).json({ revision: row });
  } catch (e) { next(e); }
});

/** Revision 전환 — 원계약(REV 0)으로 되돌리는 것도 가능하다. */
contractRouter.post('/contracts/:contractId/revisions/:revisionNo/activate',
  requireRole('HEAD_OFFICE'), async (req, res, next) => {
    try {
      const contractId = uuid.parse(req.params.contractId);
      const revisionNo = z.coerce.number().int().min(0).parse(req.params.revisionNo);
      const row = await withSession(req.actor!, async (c) => {
        await c.query('SELECT core.fn_activate_contract_revision($1,$2)', [contractId, revisionNo]);
        const r = await c.query(
          `SELECT id, contract_no, current_amount, current_revision
             FROM core.contract WHERE id=$1`, [contractId]);
        return r.rows[0];
      });
      res.json({ contract: row });
    } catch (e) { next(e); }
  });

/** 계약내역 등록 (수량산출서 상위 원장). 금액은 DB가 계산한다 (§46). */
const itemInput = z.object({
  item_code: z.string().max(60).optional(),
  item_name: z.string().min(1).max(200),
  spec: z.string().max(200).optional(),
  unit: z.string().min(1).max(20),
  quantity: decimal,
  unit_price: decimal.default('0'),
  sort_order: z.number().int().min(0).default(0),
});

contractRouter.post('/contracts/:contractId/items', requireRole('HEAD_OFFICE'), async (req, res, next) => {
  try {
    const contractId = uuid.parse(req.params.contractId);
    const p = z.object({
      revision_no: z.number().int().min(0).optional(),
      items: z.array(itemInput).min(1).max(2000),
    }).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '계약내역이 올바르지 않습니다.');

    const rows = await withSession(req.actor!, async (c) => {
      const rev = p.data.revision_no ?? (await c.query(
        'SELECT current_revision AS n FROM core.contract WHERE id=$1', [contractId])).rows[0]?.n;
      if (rev === undefined) throw notFound('계약을 찾을 수 없습니다.');
      const out = [];
      for (const it of p.data.items) {
        const r = await c.query(
          `INSERT INTO core.contract_item
             (contract_id, revision_no, item_code, item_name, spec, unit,
              quantity, unit_price, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (contract_id, revision_no, item_code) DO UPDATE
             SET item_name = EXCLUDED.item_name, spec = EXCLUDED.spec, unit = EXCLUDED.unit,
                 quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price,
                 sort_order = EXCLUDED.sort_order
           RETURNING id, item_code, item_name, unit, quantity, unit_price, amount`,
          [contractId, rev, it.item_code ?? null, it.item_name, it.spec ?? null,
           it.unit, it.quantity, it.unit_price, it.sort_order]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ items: rows });
  } catch (e) { next(e); }
});
