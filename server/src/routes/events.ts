/**
 * PHASE 11 — SPECIAL_EVENT (Master Prompt §31, §32, §26, §38, §43)
 *
 * §31 "별도의 복잡한 안전/품질/민원 ERP를 만들지 않는다."
 *   유형 하나 고르고, 필요하면 천공번호를 누르고, 사진을 찍는다. 그게 전부다.
 *
 * §1-2 레미콘 지연·장비대기·심도미달·지반 특이사항은 일일입력이 이미 받았다.
 *   여기서 다시 입력시키지 않는다. 조회가 그것들을 모아서 함께 보여준다.
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
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';
import { claim, findStored, remember, requestId } from '../http/idempotency.js';

export const eventRouter = Router();
eventRouter.use(requireAuth);

const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = resolve(HERE, '../..', env.STORAGE_LOCAL_ROOT);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
/** 사진·PDF 만. 음성메모는 쓰지 않는다 (사용자 확인 2026-08-28 — 회의는 회의록으로). */
const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.pdf']);

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '날짜 형식은 YYYY-MM-DD 입니다.');

/** §31 유형 선택지 */
eventRouter.get('/event-types', async (req, res, next) => {
  try {
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT event_type FROM core.fn_special_event_types() ORDER BY sort_order');
      return r.rows as { event_type: string }[];
    });
    res.json({ event_types: rows.map((x) => x.event_type) });
  } catch (e) { next(e); }
});

/* ============================================================ 등록 (§31, §32) */
const eventInput = z.object({
  event_date: isoDate.optional(),
  event_type: z.string().min(1).max(50),
  title: z.string().max(200).nullish(),
  memo: z.string().max(1000).nullish(),
  /** §32 "변경/정산 검토: YES" */
  needs_review: z.boolean().default(false),
  hole_nos: z.array(z.string().max(60)).max(200).nullish(),
  client_request_id: z.string().uuid().optional(),
});

eventRouter.post('/sites/:siteId/events', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const p = eventInput.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '특이사항 정보가 올바르지 않습니다.');
    const d = p.data;
    if (d.event_type === '기타' && !d.memo && !d.title) {
      throw badRequest('기타를 고르셨으면 내용을 적어 주십시오.', 'ETC_NEEDS_MEMO');
    }
    const date = d.event_date ?? new Date().toISOString().slice(0, 10);
    const reqId = requestId(req);

    const result = await withSession(req.actor!, async (c) => {
      if (reqId) {
        await claim(c, reqId);   // 오프라인 큐 재전송이 겹쳐도 한 번만 저장된다
        const stored = await findStored(c, reqId);
        if (stored) return { ...(stored.body as object), replayed: true };
      }

      const no = (await c.query(
        'SELECT core.fn_next_event_no($1,$2) AS no', [siteId, date])).rows[0]!.no as string;
      const ev = await c.query(
        `INSERT INTO core.special_event
           (site_id, event_no, event_date, event_type, title, memo, needs_review, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, event_no, event_date, event_type, needs_review, status`,
        [siteId, no, date, d.event_type, d.title ?? null, d.memo ?? null,
         d.needs_review, req.actor!.userId]);
      const eventId = ev.rows[0]!.id as string;

      // §32 관련 천공번호. 형식을 강제하지 않으므로 원문으로 찾는다.
      const linked: string[] = [];
      const missing: string[] = [];
      for (const holeNo of d.hole_nos ?? []) {
        const h = await c.query(
          'SELECT id FROM core.hole_master WHERE site_id=$1 AND hole_no=$2', [siteId, holeNo]);
        if (h.rowCount) {
          await c.query(
            `INSERT INTO core.special_event_hole (event_id, hole_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`, [eventId, h.rows[0]!.id]);
          linked.push(holeNo);
        } else missing.push(holeNo);
      }

      const payload = {
        event: ev.rows[0],
        linked_holes: linked,
        // 도면에 없는 번호는 조용히 버리지 않는다 (§8). 무엇이 안 걸렸는지 말해준다.
        unknown_holes: missing,
      };
      if (reqId) await remember(c, reqId, req.actor!.userId, 'POST /events', 201, payload);
      return payload;
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/* ============================================ §31 사진 / 음성메모 첨부 */
eventRouter.post('/:eventId/files', upload.single('file'), async (req, res, next) => {
  try {
    const eventId = uuid.parse(req.params.eventId);
    const file = req.file;
    if (!file) throw badRequest('파일이 필요합니다.', 'FILE_REQUIRED');
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED.has(ext)) {
      throw badRequest('사진 또는 PDF 만 올릴 수 있습니다.', 'UNSUPPORTED_FILE');
    }

    const result = await withSession(req.actor!, async (c) => {
      const ev = await c.query(
        'SELECT id, site_id FROM core.special_event WHERE id=$1', [eventId]);
      if (!ev.rowCount) return null;
      const siteId = ev.rows[0]!.site_id as string;

      const checksum = createHash('sha256').update(file.buffer).digest('hex');
      const category = 'FIELD_PHOTO';
      const key = `site/${siteId}/event/${checksum}${ext}`;
      const fullPath = join(STORAGE_ROOT, key);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.buffer);

      // 현장·본사가 함께 본다. 원가가 아니므로 SITE 다.
      const f = await c.query(
        `INSERT INTO core.stored_file
           (site_id, storage_backend, storage_key, original_name, mime_type,
            byte_size, checksum_sha256, category, visibility, uploaded_by)
         VALUES ($1,'LOCAL',$2,$3,$4,$5,$6,$7,'SITE',$8)
         ON CONFLICT (storage_backend, storage_key) DO NOTHING
         RETURNING id`,
        [siteId, key, file.originalname, file.mimetype, file.size, checksum,
         category, req.actor!.userId]);
      const fileId = f.rows[0]?.id ?? (await c.query(
        `SELECT id FROM core.stored_file WHERE storage_backend='LOCAL' AND storage_key=$1`,
        [key])).rows[0]?.id;
      if (!fileId) return null;

      await c.query(
        `INSERT INTO core.special_event_file (event_id, file_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`, [eventId, fileId]);
      return { event_id: eventId, file_id: fileId, category };
    });
    if (!result) throw notFound('특이사항을 찾을 수 없습니다.');
    res.status(201).json(result);
  } catch (e) { next(e); }
});

/* ============================================================ 조회 */
eventRouter.get('/sites/:siteId/events', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(req.query);
    if (!q.success) throw badRequest('기간이 올바르지 않습니다.');
    const to = q.data.to ?? new Date().toISOString().slice(0, 10);
    const from = q.data.from ?? `${to.slice(0, 5)}01-01`;

    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT core.fn_special_events($1,$2,$3) AS d', [siteId, from, to]);
      return r.rows[0]!.d as Record<string, unknown>;
    });
    res.json({ from, to, ...data });
  } catch (e) { next(e); }
});

/* ============================================ §32 검토 표시 / 종결 (본사) */
eventRouter.patch('/:eventId', requireRole('HEAD_OFFICE'), async (req, res, next) => {
  try {
    const eventId = uuid.parse(req.params.eventId);
    const p = z.object({
      status: z.enum(['OPEN', 'CLOSED']).optional(),
      needs_review: z.boolean().optional(),
      review_note: z.string().max(500).nullish(),
    }).safeParse(req.body);
    if (!p.success) throw badRequest('수정 내용이 올바르지 않습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `UPDATE core.special_event
            SET status       = COALESCE($2, status),
                needs_review = COALESCE($3, needs_review),
                review_note  = COALESCE($4, review_note),
                closed_by    = CASE WHEN $2 = 'CLOSED' THEN $5 ELSE closed_by END,
                closed_at    = CASE WHEN $2 = 'CLOSED' THEN now() ELSE closed_at END
          WHERE id=$1
        RETURNING id, event_no, status, needs_review, review_note`,
        [eventId, p.data.status ?? null, p.data.needs_review ?? null,
         p.data.review_note ?? null, req.actor!.userId]);
      return r.rows[0];
    });
    if (!row) throw notFound('특이사항을 찾을 수 없습니다.');
    res.json(row);
  } catch (e) { next(e); }
});
