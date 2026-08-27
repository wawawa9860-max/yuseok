/**
 * PHASE 5 — 작업도면 ↔ 천공번호 연결 (Master Prompt §13, §14, §35, §38)
 *
 * 사용자 지시:
 *   "작업도면 PDF 업로드 시 수량산출서와 넘버링이 다른 부분들이 있을 거다.
 *    도면 기준으로 넘버링과 천공공수를 맞춰주기 바란다."
 *
 * 도면을 넘버링·공수의 기준으로 삼되, **삭제는 절대 자동으로 하지 않는다.**
 * 도면에 없는 천공번호를 어떻게 할지는 사람이 고른다 (§8).
 *
 *   업로드 → 라벨 추출 → 대조표 → 처리방식 선택 → 승인 → 반영
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
import {
  extractDrawingLabels, filterHoleLabels, type DrawingLabel,
} from '../domain/drawing/extractLabels.js';

export const drawingImportRouter = Router();
drawingImportRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = resolve(HERE, '../..', env.STORAGE_LOCAL_ROOT);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const uuid = z.string().uuid();

interface DrawingAnalysis {
  page_count: number;
  piece_count: number;
  label_count: number;
  hole_labels: DrawingLabel[];
  duplicates: { text: string; count: number }[];
  ignored_labels: string[];
  extract_options: { lineTolerance: number; joinGapRatio: number };
}

/* ========================================================= 1) 업로드 + 라벨 추출 */
const extractQuery = z.object({
  line_tolerance: z.coerce.number().min(0.05).max(2).optional(),
  join_gap_ratio: z.coerce.number().min(0.05).max(3).optional(),
});

drawingImportRouter.post('/sites/:siteId/drawing-imports',
  upload.single('file'), async (req, res, next) => {
    try {
      const siteId = uuid.parse(req.params.siteId);
      const file = req.file;
      if (!file) throw badRequest('작업도면 파일이 필요합니다.', 'FILE_REQUIRED');
      const ext = extname(file.originalname).toLowerCase();
      if (ext !== '.pdf') throw badRequest('PDF 파일만 업로드할 수 있습니다.', 'UNSUPPORTED_FILE');

      const q = extractQuery.safeParse(req.query);
      if (!q.success) throw badRequest('추출 옵션이 올바르지 않습니다.');
      const opts = {
        lineTolerance: q.data.line_tolerance ?? 0.35,
        joinGapRatio: q.data.join_gap_ratio ?? 0.6,
      };

      const extracted = await extractDrawingLabels(new Uint8Array(file.buffer), opts);
      const holeLabels = filterHoleLabels(extracted.labels);
      const ignored = extracted.labels
        .filter((l) => !holeLabels.some((h) => h.x === l.x && h.y === l.y && h.page === l.page))
        .map((l) => l.text);

      const counts = new Map<string, number>();
      for (const l of holeLabels) counts.set(l.text, (counts.get(l.text) ?? 0) + 1);
      const duplicates = [...counts.entries()]
        .filter(([, n]) => n > 1).map(([text, count]) => ({ text, count }));

      const analysis: DrawingAnalysis = {
        page_count: extracted.page_count,
        piece_count: extracted.piece_count,
        label_count: extracted.labels.length,
        hole_labels: holeLabels,
        duplicates,
        ignored_labels: [...new Set(ignored)].slice(0, 50),
        extract_options: opts,
      };

      const checksum = createHash('sha256').update(file.buffer).digest('hex');
      const key = `site/${siteId}/work-drawing/${checksum}${ext}`;
      const fullPath = join(STORAGE_ROOT, key);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.buffer);

      const row = await withSession(req.actor!, async (c) => {
        const f = await c.query(
          `INSERT INTO core.stored_file
             (site_id, storage_backend, storage_key, original_name, mime_type,
              byte_size, checksum_sha256, category, visibility, uploaded_by)
           VALUES ($1,'LOCAL',$2,$3,$4,$5,$6,'WORK_DRAWING','SITE',$7)
           ON CONFLICT (storage_backend, storage_key) DO UPDATE
             SET original_name = EXCLUDED.original_name
           RETURNING id`,
          [siteId, key, file.originalname, file.mimetype, file.size, checksum, req.actor!.userId]);

        const doc = await c.query(
          `INSERT INTO core.document (site_id, doc_type, title, created_by)
           VALUES ($1,'WORK_DRAWING',$2,$3)
           ON CONFLICT (site_id, doc_type, title) DO UPDATE SET title = EXCLUDED.title
           RETURNING id, current_revision`,
          [siteId, file.originalname, req.actor!.userId]);
        const documentId = doc.rows[0]!.id as string;

        // 도면도 revision 을 가진다 (§38)
        const nextRev = await c.query(
          `SELECT COALESCE(max(revision_no), -1) + 1 AS n
             FROM core.document_revision WHERE document_id=$1`, [documentId]);
        const revisionNo = Number(nextRev.rows[0]!.n);
        await c.query(
          `INSERT INTO core.document_revision
             (document_id, revision_no, file_id, note, is_current, created_by)
           VALUES ($1,$2,$3,$4,false,$5)`,
          [documentId, revisionNo, f.rows[0]!.id,
           `천공번호 ${holeLabels.length}개 추출`, req.actor!.userId]);

        const imp = await c.query(
          `INSERT INTO core.drawing_import
             (site_id, file_id, document_id, revision_no, original_name, status, analysis, created_by)
           VALUES ($1,$2,$3,$4,$5,'ANALYZED',$6,$7)
           RETURNING id, status, revision_no`,
          [siteId, f.rows[0]!.id, documentId, revisionNo, file.originalname,
           JSON.stringify(analysis), req.actor!.userId]);
        return imp.rows[0];
      });

      res.status(201).json({
        import_id: row!.id,
        status: row!.status,
        revision_no: row!.revision_no,
        page_count: analysis.page_count,
        extracted_labels: analysis.label_count,
        hole_number_count: holeLabels.length,
        hole_numbers: holeLabels.map((l) => l.text),
        duplicates,
        ignored_labels: analysis.ignored_labels,
        extract_options: opts,
        /** 추출 결과가 도면과 맞는지는 사람이 확인한다 (§12 정신) */
        confirmation_required: true,
      });
    } catch (e) { next(e); }
  });

/* ========================================================= 2) 대조표 (§14) */
drawingImportRouter.get('/drawing-imports/:id/reconcile', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT site_id, analysis, mapping, status FROM core.drawing_import WHERE id=$1', [id]);
      if (!r.rowCount) return null;
      const { site_id: siteId, analysis, mapping } = r.rows[0]! as {
        site_id: string; analysis: DrawingAnalysis; mapping: { hole_numbers?: string[] } | null };

      const holeNos = mapping?.hole_numbers ?? analysis.hole_labels.map((l) => l.text);
      const rec = await c.query(
        'SELECT * FROM core.fn_reconcile_drawing($1,$2)', [siteId, holeNos]);
      return { holeNos, rows: rec.rows as {
        hole_no: string; match_status: string; hole_id: string | null;
        hole_status: string | null; construction_date: string | null;
        design_depth_total: string | null; drawing_order: number | null }[] };
    });
    if (!data) throw notFound('도면 가져오기 세션을 찾을 수 없습니다.');

    const matched = data.rows.filter((r) => r.match_status === 'MATCHED');
    const drawingOnly = data.rows.filter((r) => r.match_status === 'DRAWING_ONLY');
    const masterOnly = data.rows.filter((r) => r.match_status === 'MASTER_ONLY');

    const issues: { code: string; severity: string; message: string }[] = [];
    if (drawingOnly.length > 0) {
      issues.push({
        code: 'DRAWING_HOLE_MISSING_IN_MASTER', severity: 'ERROR',
        message: `도면에 있는 천공번호 ${drawingOnly.length}개가 HOLE_MASTER 에 없습니다: `
          + drawingOnly.slice(0, 20).map((r) => r.hole_no).join(', '),
      });
    }
    if (masterOnly.length > 0) {
      const built = masterOnly.filter((r) => r.construction_date !== null);
      issues.push({
        code: 'MASTER_HOLE_MISSING_IN_DRAWING',
        severity: built.length > 0 ? 'ERROR' : 'WARN',
        message: `HOLE_MASTER 에 있는 천공번호 ${masterOnly.length}개가 도면에 없습니다: `
          + masterOnly.slice(0, 20).map((r) => r.hole_no).join(', ')
          + (built.length > 0 ? ` (이 중 ${built.length}개는 이미 시공됨)` : ''),
      });
    }

    res.json({
      import_id: id,
      drawing_hole_count: data.holeNos.length,
      matched: matched.length,
      drawing_only: drawingOnly.map((r) => r.hole_no),
      master_only: masterOnly.map((r) => ({
        hole_no: r.hole_no, hole_status: r.hole_status,
        construction_date: r.construction_date,
        deletable: r.hole_status === 'NOT_STARTED' && r.construction_date === null,
      })),
      issues,
      /** 도면에 없는 번호의 처리방식은 사람이 고른다 (§8) */
      missing_hole_actions: ['MARK_ONLY', 'REMOVE', 'KEEP'],
      recommended_action: 'MARK_ONLY',
    });
  } catch (e) { next(e); }
});

/* ========================================================= 3) 매핑 확정 */
const mappingSchema = z.object({
  /** 추출값을 그대로 쓰거나, 사람이 손본 목록을 넣는다. */
  hole_numbers: z.array(z.string().min(1).max(60)).min(1).max(20000).optional(),
  /** 도면에 없는 HOLE_MASTER 천공번호 처리방식 */
  missing_hole_action: z.enum(['MARK_ONLY', 'REMOVE', 'KEEP']).default('MARK_ONLY'),
  /** 도면에만 있는 번호를 새로 만들지 */
  create_missing_holes: z.boolean().default(false),
  /** 새로 만들 때 붙일 천공종류 (create_missing_holes 시 필요) */
  new_hole_type_code: z.string().max(20).optional(),
  drawing_ref: z.string().max(200).optional(),
  set_as_current_revision: z.boolean().default(true),
});

drawingImportRouter.patch('/drawing-imports/:id/mapping', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const p = mappingSchema.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '매핑이 올바르지 않습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const cur = await c.query(
        'SELECT analysis FROM core.drawing_import WHERE id=$1', [id]);
      if (!cur.rowCount) return null;
      const analysis = cur.rows[0]!.analysis as DrawingAnalysis;
      const holeNumbers = p.data.hole_numbers ?? analysis.hole_labels.map((l) => l.text);

      const seen = new Set<string>();
      const dup = new Set<string>();
      for (const n of holeNumbers) {
        if (seen.has(n)) dup.add(n);
        seen.add(n);
      }
      if (dup.size > 0) {
        throw badRequest(`도면 천공번호가 중복됩니다: ${[...dup].slice(0, 20).join(', ')}`,
          'DRAWING_DUPLICATE');
      }

      const mapping = { ...p.data, hole_numbers: holeNumbers };
      const r = await c.query(
        `UPDATE core.drawing_import SET mapping=$2, status='MAPPED' WHERE id=$1
         RETURNING id, status`, [id, JSON.stringify(mapping)]);
      return { row: r.rows[0], count: holeNumbers.length };
    });
    if (!row) throw notFound('도면 가져오기 세션을 찾을 수 없습니다.');
    res.json({ import_id: id, status: row.row!.status, hole_number_count: row.count });
  } catch (e) { next(e); }
});

/* ========================================================= 4) 승인 후 반영 */
const applySchema = z.object({
  approved: z.literal(true),
  approval_note: z.string().max(500).optional(),
});

drawingImportRouter.post('/drawing-imports/:id/apply', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const p = applySchema.safeParse(req.body);
    if (!p.success) {
      throw badRequest('승인(approved: true)이 없으면 반영하지 않습니다.', 'APPROVAL_REQUIRED');
    }

    const result = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT site_id, document_id, revision_no, analysis, mapping, status
           FROM core.drawing_import WHERE id=$1`, [id]);
      if (!r.rowCount) return null;
      const { site_id: siteId, document_id: documentId, revision_no: revisionNo,
              mapping, status } = r.rows[0]! as {
        site_id: string; document_id: string; revision_no: number;
        mapping: z.infer<typeof mappingSchema> & { hole_numbers: string[] } | null; status: string };
      if (status === 'APPLIED') throw badRequest('이미 반영된 도면입니다.', 'ALREADY_APPLIED');
      if (!mapping) throw badRequest('먼저 매핑을 확정하십시오.', 'MAPPING_REQUIRED');

      const holeNos = mapping.hole_numbers;
      const rec = await c.query(
        'SELECT * FROM core.fn_reconcile_drawing($1,$2)', [siteId, holeNos]);
      const rows = rec.rows as { hole_no: string; match_status: string; hole_id: string | null;
        hole_status: string | null; construction_date: string | null }[];

      const drawingOnly = rows.filter((x) => x.match_status === 'DRAWING_ONLY');
      const masterOnly = rows.filter((x) => x.match_status === 'MASTER_ONLY');

      // 도면에만 있는 번호 → 새로 만든다 (사용자가 요청한 경우만)
      let created = 0;
      if (drawingOnly.length > 0) {
        if (!mapping.create_missing_holes) {
          throw badRequest(
            `도면에 있는 ${drawingOnly.length}개 천공번호가 HOLE_MASTER 에 없습니다. `
            + 'create_missing_holes 를 켜거나 수량산출서를 먼저 반영하십시오.',
            'DRAWING_HOLE_MISSING_IN_MASTER');
        }
        let htId: string | null = null;
        if (mapping.new_hole_type_code) {
          const ht = await c.query(
            'SELECT id FROM core.site_hole_type WHERE site_id=$1 AND code=$2',
            [siteId, mapping.new_hole_type_code]);
          if (!ht.rowCount) {
            throw badRequest(`천공종류 '${mapping.new_hole_type_code}' 가 등록되어 있지 않습니다.`);
          }
          htId = ht.rows[0]!.id as string;
        }
        for (const d of drawingOnly) {
          await c.query(
            `INSERT INTO core.hole_master
               (site_id, hole_no, hole_type_id, drawing_revision, status, change_review_required, created_by)
             VALUES ($1,$2,$3,$4,'NOT_STARTED',true,$5)`,
            [siteId, d.hole_no, htId, revisionNo, req.actor!.userId]);
          created++;
        }
      }

      // 도면에 없는 번호 → 사람이 고른 방식대로 (삭제는 미시공만)
      let marked = 0;
      let removed = 0;
      const blocked: string[] = [];
      if (mapping.missing_hole_action === 'MARK_ONLY') {
        for (const m of masterOnly) {
          await c.query(
            `UPDATE core.hole_master
                SET status = CASE WHEN status='NOT_STARTED' THEN 'NEEDS_CHECK' ELSE status END,
                    change_review_required = true
              WHERE id=$1`, [m.hole_id]);
          marked++;
        }
      } else if (mapping.missing_hole_action === 'REMOVE') {
        for (const m of masterOnly) {
          if (m.construction_date !== null || m.hole_status !== 'NOT_STARTED') {
            blocked.push(m.hole_no);
            await c.query(
              `UPDATE core.hole_master SET status='NEEDS_CHECK', change_review_required=true
                WHERE id=$1`, [m.hole_id]);
            continue;
          }
          await c.query('DELETE FROM core.hole_master WHERE id=$1', [m.hole_id]);
          removed++;
        }
      }

      // 도면 순서를 기록한다
      const ordered = await c.query(
        'SELECT core.fn_apply_drawing_order($1,$2,$3) AS n',
        [siteId, holeNos, mapping.drawing_ref ?? `REV ${revisionNo}`]);

      await c.query(
        'UPDATE core.hole_master SET drawing_revision=$2 WHERE site_id=$1', [siteId, revisionNo]);

      if (mapping.set_as_current_revision) {
        await c.query(
          'UPDATE core.document_revision SET is_current=false WHERE document_id=$1 AND is_current',
          [documentId]);
        await c.query(
          `UPDATE core.document_revision SET is_current=true, approved_by=$3, approved_at=now()
            WHERE document_id=$1 AND revision_no=$2`,
          [documentId, revisionNo, req.actor!.userId]);
        await c.query(
          'UPDATE core.document SET current_revision=$2 WHERE id=$1', [documentId, revisionNo]);
      }

      await c.query(
        `UPDATE core.drawing_import
            SET status='APPLIED', applied_at=now(), applied_by=$2,
                reconciliation=$3
          WHERE id=$1`,
        [id, req.actor!.userId, JSON.stringify({
          matched: rows.filter((x) => x.match_status === 'MATCHED').length,
          drawing_only: drawingOnly.map((x) => x.hole_no),
          master_only: masterOnly.map((x) => x.hole_no),
          action: mapping.missing_hole_action,
          approval_note: p.data.approval_note ?? null,
        })]);
      await c.query(
        'UPDATE core.site SET setup_step = GREATEST(setup_step, 5) WHERE id=$1', [siteId]);

      return {
        drawing_hole_count: holeNos.length,
        matched: rows.filter((x) => x.match_status === 'MATCHED').length,
        created_holes: created,
        marked_needs_check: marked,
        removed_holes: removed,
        removal_blocked: blocked,
        drawing_order_applied: Number(ordered.rows[0]!.n),
        revision_no: revisionNo,
      };
    });
    if (!result) throw notFound('도면 가져오기 세션을 찾을 수 없습니다.');
    res.status(201).json({ import_id: id, status: 'APPLIED', ...result });
  } catch (e) { next(e); }
});

/* ========================================================= 도면 진행상태 (§13) */
drawingImportRouter.get('/sites/:siteId/drawing-progress', async (req, res, next) => {
  try {
    const siteId = uuid.parse(req.params.siteId);
    const rows = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT hole_no, drawing_sequence, hole_type_code, hole_type_name,
                design_depth_total, actual_depth_total, construction_date, display_status
           FROM core.v_drawing_progress
          WHERE site_id=$1
          ORDER BY drawing_sequence NULLS LAST, sort_key`, [siteId]);
      return r.rows as { display_status: string }[];
    });
    const byStatus = new Map<string, number>();
    for (const r of rows) byStatus.set(r.display_status, (byStatus.get(r.display_status) ?? 0) + 1);
    res.json({
      holes: rows,
      total: rows.length,
      by_status: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
    });
  } catch (e) { next(e); }
});
