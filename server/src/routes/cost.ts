/**
 * PHASE 8 — 비용 + 사진증빙 (Master Prompt §24, §27, §28, §29, §30)
 *
 * §29 절대 규칙
 *   투입원가는 HEAD_OFFICE_ONLY 다. 계약상대방에게 절대 전달되지 않는다.
 *   프론트엔드에서 숨기는 것으로 구현하지 않는다. DB/API 권한단계에서 차단한다.
 *
 * 이 파일의 모든 경로는 private_cost 스키마만 다룬다.
 * 현장관리자는 §44 대로 "비용 입력 및 증빙업로드" 까지만 할 수 있고,
 * 원가 합계·손익은 볼 수 없다 (RLS + GRANT 로 강제된다).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { withSession } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';
import { claim, findStored, remember, requestId } from '../http/idempotency.js';

export const costRouter = Router();
costRouter.use(requireAuth, requireRole('HEAD_OFFICE', 'FIELD_MANAGER'));

const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = resolve(HERE, '../..', env.STORAGE_LOCAL_ROOT);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');
/** 금액은 문자열로 다뤄 부동소수점 오차를 만들지 않는다 (§46). */
const money = z.union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d+)?$/.test(v), '금액은 0 이상의 숫자여야 합니다.');

/** §24 투입원가는 6개로 고정한다. */
const COST_TYPES = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06'] as const;
/** §27 사진증빙을 기본으로 하는 항목 */
const EVIDENCE_EXPECTED = new Set(['C03', 'C04', 'C05', 'C06']);

costRouter.get('/cost-types', async (req, res, next) => {
  try {
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT code, name_ko, sort_order FROM private_cost.cost_type ORDER BY sort_order');
      return r.rows as { code: string }[];
    });
    res.json({
      cost_types: rows.map((t) => ({ ...t, evidence_expected: EVIDENCE_EXPECTED.has(t.code) })),
      evidence_status: [
        { code: 'VERIFIED', name_ko: '증빙완료' },
        { code: 'PENDING_EVIDENCE', name_ko: '증빙대기' },
        { code: 'HEAD_OFFICE_REVIEW', name_ko: '본사확인' },
      ],
    });
  } catch (e) { next(e); }
});

/* ============================================================ 비용 입력 (§27) */
const costInput = z.object({
  cost_date: isoDate.optional(),
  cost_type: z.enum(COST_TYPES),
  amount: money,
  quantity: money.nullish(),
  unit: z.string().max(20).nullish(),
  vendor: z.string().max(200).nullish(),
  memo: z.string().max(500).nullish(),
  client_request_id: z.string().uuid().optional(),
});

/**
 * §28 영수증이 즉시 없는 현장상황을 고려해 입력 자체를 차단하지 않는다.
 * 증빙 없이 저장하면 '증빙대기' 로 남고, 나중에 사진을 붙이면 '증빙완료' 가 된다.
 */
costRouter.post('/sites/:siteId/costs', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = costInput.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '비용 정보가 올바르지 않습니다.');
    const d = p.data;
    const date = d.cost_date ?? new Date().toISOString().slice(0, 10);
    const reqId = requestId(req);

    const result = await withSession(req.actor!, async (c) => {
      if (reqId) {
        await claim(c, reqId);   // 동시에 온 같은 요청을 줄 세운다
        const stored = await findStored(c, reqId);
        if (stored) return { ...(stored.body as object), replayed: true };
      }

      // 같은 날 일일작업이 있으면 연결한다 (§1-7 재사용)
      const work = await c.query(
        'SELECT id FROM core.daily_work WHERE site_id=$1 AND work_date=$2', [siteId, date]);

      const r = await c.query(
        `INSERT INTO private_cost.daily_cost
           (site_id, cost_date, cost_type, amount, quantity, unit, vendor, memo,
            daily_work_id, source, evidence_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'MANUAL','PENDING_EVIDENCE',$10)
         RETURNING id, cost_date, cost_type, amount, quantity, unit, vendor,
                   evidence_status, created_at`,
        [siteId, date, d.cost_type, d.amount, d.quantity ?? null, d.unit ?? null,
         d.vendor ?? null, d.memo ?? null, work.rows[0]?.id ?? null, req.actor!.userId]);

      const payload = {
        cost: r.rows[0],
        evidence_expected: EVIDENCE_EXPECTED.has(d.cost_type),
      };
      if (reqId) {
        await remember(c, reqId, req.actor!.userId, 'POST /costs', 201, payload);
      }
      return payload;
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/** 내가 입력한 비용 목록. 현장관리자는 RLS 로 본인 것만 보인다 (§44). */
costRouter.get('/sites/:siteId/costs', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({
      from: isoDate.optional(), to: isoDate.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).safeParse(req.query);
    if (!q.success) throw badRequest('조회 조건이 올바르지 않습니다.');

    const rows = await withSession(req.actor!, async (c) => {
      const params: unknown[] = [siteId];
      let where = 'c.site_id = $1';
      if (q.data.from) { params.push(q.data.from); where += ` AND c.cost_date >= $${params.length}`; }
      if (q.data.to)   { params.push(q.data.to);   where += ` AND c.cost_date <= $${params.length}`; }
      params.push(q.data.limit);
      const r = await c.query(
        `SELECT c.id, c.cost_date, c.cost_type, t.name_ko AS cost_type_name,
                c.amount, c.quantity, c.unit, c.vendor, c.memo,
                c.evidence_status, c.source, c.created_at,
                count(e.id)::int AS evidence_count
           FROM private_cost.daily_cost c
           JOIN private_cost.cost_type t ON t.code = c.cost_type
           LEFT JOIN private_cost.cost_evidence e ON e.cost_id = c.id
          WHERE ${where}
          GROUP BY c.id, t.name_ko
          ORDER BY c.cost_date DESC, c.created_at DESC
          LIMIT $${params.length}`, params);
      return r.rows;
    });
    res.json({ costs: rows, count: rows.length });
  } catch (e) { next(e); }
});

/* ================================================ §27 영수증 사진 업로드 */
const ALLOWED_IMAGE = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.pdf']);

costRouter.post('/costs/:costId/evidence', upload.single('file'), async (req, res, next) => {
  try {
    const costId = uuid.parse(req.params.costId);
    const file = req.file;
    if (!file) throw badRequest('영수증 파일이 필요합니다.', 'FILE_REQUIRED');
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE.has(ext)) {
      throw badRequest('사진(jpg/png/heic/webp) 또는 PDF 만 올릴 수 있습니다.', 'UNSUPPORTED_FILE');
    }

    const result = await withSession(req.actor!, async (c) => {
      const cost = await c.query(
        'SELECT id, site_id FROM private_cost.daily_cost WHERE id=$1', [costId]);
      if (!cost.rowCount) return null;
      const siteId = cost.rows[0]!.site_id as string;

      const checksum = createHash('sha256').update(file.buffer).digest('hex');
      const key = `site/${siteId}/receipt/${checksum}${ext}`;
      const fullPath = join(STORAGE_ROOT, key);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.buffer);

      // 영수증 파일은 저장되는 순간 본사전용이 되고, 본사전용 파일은 현장관리자에게
      // '행 자체가 보이지 않는다'. 그래서 현장관리자가 직접 INSERT 할 수 없다.
      // 정책을 느슨하게 하는 대신, 이 동작 하나만 통과시키는 함수를 쓴다 (§29, §44).
      const r = await c.query(
        `SELECT * FROM private_cost.fn_attach_cost_evidence($1,$2,$3,$4,$5,$6)`,
        [costId, key, file.originalname, file.mimetype, file.size, checksum]);

      return {
        cost_id: costId,
        file_id: r.rows[0]!.file_id,
        visibility: r.rows[0]!.visibility,
        evidence_status: r.rows[0]!.evidence_status,
      };
    });
    if (!result) throw notFound('비용을 찾을 수 없습니다.');
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/** §23 레미콘 송장사진 — PHASE 7 에서 남겨둔 부분 */
costRouter.post('/ready-mix/:readyMixId/evidence', upload.single('file'), async (req, res, next) => {
  try {
    const readyMixId = uuid.parse(req.params.readyMixId);
    const file = req.file;
    if (!file) throw badRequest('송장사진이 필요합니다.', 'FILE_REQUIRED');
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE.has(ext)) {
      throw badRequest('사진 또는 PDF 만 올릴 수 있습니다.', 'UNSUPPORTED_FILE');
    }

    const result = await withSession(req.actor!, async (c) => {
      const rm = await c.query(
        `SELECT r.id, w.site_id FROM core.daily_ready_mix r
           JOIN core.daily_work w ON w.id = r.daily_work_id WHERE r.id=$1`, [readyMixId]);
      if (!rm.rowCount) return null;
      const siteId = rm.rows[0]!.site_id as string;

      const checksum = createHash('sha256').update(file.buffer).digest('hex');
      const key = `site/${siteId}/delivery-note/${checksum}${ext}`;
      const fullPath = join(STORAGE_ROOT, key);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.buffer);

      // 송장은 원가가 아니다. 현장·본사가 함께 본다.
      // 현장관리자에게는 stored_file UPDATE 권한이 없다. ON CONFLICT DO UPDATE 는
      // 충돌이 없어도 UPDATE 권한을 요구하므로 쓰지 않는다.
      const f = await c.query(
        `INSERT INTO core.stored_file
           (site_id, storage_backend, storage_key, original_name, mime_type,
            byte_size, checksum_sha256, category, visibility, uploaded_by)
         VALUES ($1,'LOCAL',$2,$3,$4,$5,$6,'DELIVERY_NOTE','SITE',$7)
         ON CONFLICT (storage_backend, storage_key) DO NOTHING
         RETURNING id`,
        [siteId, key, file.originalname, file.mimetype, file.size, checksum, req.actor!.userId]);
      // 같은 사진을 다시 올린 경우 기존 파일을 그대로 쓴다 (재전송 안전).
      const fileId = f.rows[0]?.id ?? (await c.query(
        `SELECT id FROM core.stored_file WHERE storage_backend='LOCAL' AND storage_key=$1`,
        [key])).rows[0]?.id;
      if (!fileId) return null;

      await c.query(
        `INSERT INTO core.ready_mix_evidence (ready_mix_id, file_id, uploaded_by)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [readyMixId, fileId, req.actor!.userId]);
      return { ready_mix_id: readyMixId, file_id: fileId };
    });
    if (!result) throw notFound('레미콘 기록을 찾을 수 없습니다.');
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/* ============================================ §52 증빙률 (금액 없음) */
/**
 * 현장관리자도 볼 수 있는 유일한 원가 관련 지표.
 * 건수만 돌려주고 금액은 한 푼도 내보내지 않는다.
 */
costRouter.get('/sites/:siteId/evidence-rate', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('기간이 올바르지 않습니다.');
    const to = q.data.to ?? new Date().toISOString().slice(0, 10);
    const from = q.data.from ?? to.slice(0, 8) + '01';

    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT * FROM private_cost.fn_evidence_rate($1,$2,$3)', [siteId, from, to]);
      return r.rows[0];
    });
    res.json({ from, to, ...row });
  } catch (e) { next(e); }
});

/* ==================================================== 본사 전용 (§29, §44) */
export const costAdminRouter = Router();
costAdminRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

/** §25 노무 단가 등록 */
const laborRate = z.object({
  site_id: z.string().uuid().nullish(),
  role_name: z.string().min(1).max(50),
  daily_rate: money,
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
  note: z.string().max(200).nullish(),
});

costAdminRouter.post('/labor-rates', async (req, res, next) => {
  try {
    const p = z.union([laborRate, z.array(laborRate).min(1).max(100)]).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '단가 정보가 올바르지 않습니다.');
    const items = Array.isArray(p.data) ? p.data : [p.data];
    const rows = await withSession(req.actor!, async (c) => {
      const out = [];
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO private_cost.labor_rate
             (site_id, role_name, daily_rate, effective_from, effective_to, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        role_name, effective_from)
             DO UPDATE SET daily_rate = EXCLUDED.daily_rate,
                           effective_to = EXCLUDED.effective_to, note = EXCLUDED.note
           RETURNING id, role_name, daily_rate, effective_from, effective_to`,
          [it.site_id ?? null, it.role_name, it.daily_rate, it.effective_from,
           it.effective_to ?? null, it.note ?? null, req.actor!.userId]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ labor_rates: rows });
  } catch (e) { next(e); }
});

/** §26 장비 단가 등록 */
const equipmentRate = z.object({
  site_id: z.string().uuid().nullish(),
  equipment_name: z.string().min(1).max(50),
  charge_type: z.enum(['DAILY', 'MONTHLY', 'OTHER']),
  rate: money,
  effective_from: isoDate,
  effective_to: isoDate.nullish(),
  note: z.string().max(200).nullish(),
});

costAdminRouter.post('/equipment-rates', async (req, res, next) => {
  try {
    const p = z.union([equipmentRate, z.array(equipmentRate).min(1).max(100)]).safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '단가 정보가 올바르지 않습니다.');
    const items = Array.isArray(p.data) ? p.data : [p.data];
    const rows = await withSession(req.actor!, async (c) => {
      const out = [];
      for (const it of items) {
        const r = await c.query(
          `INSERT INTO private_cost.equipment_rate
             (site_id, equipment_name, charge_type, rate, effective_from, effective_to, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        equipment_name, charge_type, effective_from)
             DO UPDATE SET rate = EXCLUDED.rate, effective_to = EXCLUDED.effective_to,
                           note = EXCLUDED.note
           RETURNING id, equipment_name, charge_type, rate, effective_from, effective_to`,
          [it.site_id ?? null, it.equipment_name, it.charge_type, it.rate, it.effective_from,
           it.effective_to ?? null, it.note ?? null, req.actor!.userId]);
        out.push(r.rows[0]);
      }
      return out;
    });
    res.status(201).json({ equipment_rates: rows });
  } catch (e) { next(e); }
});

/** §25/§26 노무비·장비비 자동계산 반영 */
costAdminRouter.post('/daily-work/:dailyWorkId/calculate-cost', async (req, res, next) => {
  try {
    const dailyWorkId = uuid.parse(req.params.dailyWorkId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT * FROM private_cost.fn_apply_calculated_cost($1)', [dailyWorkId]);
      return r.rows as { cost_type: string; amount: string; missing_rate_count: number }[];
    });
    const missing = rows.filter((r) => r.missing_rate_count > 0);
    res.status(201).json({
      calculated: rows,
      issues: missing.map((r) => ({
        code: 'RATE_NOT_FOUND', severity: 'WARN',
        message: `${r.cost_type}: 단가가 등록되지 않은 항목이 ${r.missing_rate_count}건 있어 `
          + '그만큼 금액에서 빠졌습니다.',
      })),
    });
  } catch (e) { next(e); }
});

/** 본사 원가 집계 — 현장관리자는 이 경로 자체에 들어올 수 없다 */
costAdminRouter.get('/sites/:siteId/cost-summary', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('기간이 올바르지 않습니다.');
    const to = q.data.to ?? new Date().toISOString().slice(0, 10);
    const from = q.data.from ?? to.slice(0, 8) + '01';

    const data = await withSession(req.actor!, async (c) => {
      const daily = await c.query(
        `SELECT cost_date, total_amount, labor_amount, equipment_amount, other_amount,
                verified_count, pending_count, review_count, cost_count
           FROM private_cost.v_daily_cost_summary
          WHERE site_id=$1 AND cost_date BETWEEN $2 AND $3
          ORDER BY cost_date DESC`, [siteId, from, to]);
      const byType = await c.query(
        `SELECT c.cost_type, t.name_ko, sum(c.amount) AS amount, count(*)::int AS n
           FROM private_cost.daily_cost c
           JOIN private_cost.cost_type t ON t.code = c.cost_type
          WHERE c.site_id=$1 AND c.cost_date BETWEEN $2 AND $3
          GROUP BY c.cost_type, t.name_ko, t.sort_order ORDER BY t.sort_order`,
        [siteId, from, to]);
      return { daily: daily.rows, by_type: byType.rows };
    });
    res.json({ from, to, ...data });
  } catch (e) { next(e); }
});

/** 증빙대기 건을 본사확인으로 전환 (§28) */
costAdminRouter.patch('/costs/:costId/evidence-status', async (req, res, next) => {
  try {
    const costId = uuid.parse(req.params.costId);
    const p = z.object({
      evidence_status: z.enum(['VERIFIED', 'PENDING_EVIDENCE', 'HEAD_OFFICE_REVIEW']),
      memo: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest('증빙 상태가 올바르지 않습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE private_cost.daily_cost
            SET evidence_status=$2, memo=COALESCE($3, memo)
          WHERE id=$1 AND source='MANUAL'
         RETURNING id, evidence_status`, [costId, p.data.evidence_status, p.data.memo ?? null]);
      return r.rows[0];
    });
    if (!row) throw notFound('비용을 찾을 수 없습니다.');
    res.json(row);
  } catch (e) { next(e); }
});

void forbidden;
