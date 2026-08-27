/**
 * PHASE 4 — 수량산출서 가져오기 (Master Prompt §12, §14, §45)
 *
 *   업로드 → 열 구조 분석 → 천공번호 확인 → 지층 후보 확인
 *   → 계획심도 확인 → 미리보기 → **사용자 승인** → HOLE_MASTER 반영
 *
 * "AI는 열 이름과 구조를 해석하는 보조 역할만 한다.
 *  계약수량 변경을 자동 확정하지 않는다." (§12)
 *
 * 승인(apply) 호출 없이 HOLE_MASTER 가 바뀌는 경로는 존재하지 않는다.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { withSession, type SessionClient } from '../db/pool.js';
import { badRequest, notFound } from '../http/errors.js';
import { requireAuth, requireRole } from '../http/context.js';
import { analyzeWorkbook } from '../domain/quantitySheet/analyze.js';
import { crossCheck } from '../domain/quantitySheet/crossCheck.js';
import { convertAll, type HoleNoStyle } from '../domain/quantitySheet/holeNo.js';
import { expandByPattern } from '../domain/quantitySheet/expand.js';
import type { ScheduleBlock, WorkbookAnalysis } from '../domain/quantitySheet/types.js';
import { HoleNumberError } from '../domain/holeNumbering.js';

export const quantityImportRouter = Router();
quantityImportRouter.use(requireAuth, requireRole('HEAD_OFFICE'));

const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_ROOT = resolve(HERE, '../..', env.STORAGE_LOCAL_ROOT);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const uuid = z.string().uuid();
const ALLOWED_EXT = new Set(['.xlsx', '.xlsm']);

/* ========================================================= 1) 업로드 + 분석 */
quantityImportRouter.post('/sites/:siteId/quantity-imports',
  upload.single('file'), async (req, res, next) => {
    try {
      const siteId = uuid.parse(req.params.siteId);
      const file = req.file;
      if (!file) throw badRequest('수량산출서 파일이 필요합니다.', 'FILE_REQUIRED');
      const ext = extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        throw badRequest('xlsx 또는 xlsm 파일만 업로드할 수 있습니다.', 'UNSUPPORTED_FILE');
      }

      const checksum = createHash('sha256').update(file.buffer).digest('hex');
      const key = `site/${siteId}/quantity-sheet/${checksum}${ext}`;
      const fullPath = join(STORAGE_ROOT, key);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.buffer);

      const analysis = await analyzeWorkbook(fullPath);
      const check = crossCheck(analysis.blocks, analysis.basis_totals);

      const row = await withSession(req.actor!, async (c) => {
        const f = await c.query(
          `INSERT INTO core.stored_file
             (site_id, storage_backend, storage_key, original_name, mime_type,
              byte_size, checksum_sha256, category, visibility, uploaded_by)
           VALUES ($1,'LOCAL',$2,$3,$4,$5,$6,'QUANTITY_SHEET','SITE',$7)
           ON CONFLICT (storage_backend, storage_key) DO UPDATE
             SET original_name = EXCLUDED.original_name
           RETURNING id`,
          [siteId, key, file.originalname, file.mimetype, file.size, checksum, req.actor!.userId]);

        const doc = await c.query(
          `INSERT INTO core.document (site_id, doc_type, title, created_by)
           VALUES ($1,'QUANTITY_SHEET',$2,$3)
           ON CONFLICT (site_id, doc_type, title) DO UPDATE SET title = EXCLUDED.title
           RETURNING id, current_revision`,
          [siteId, file.originalname, req.actor!.userId]);

        const imp = await c.query(
          `INSERT INTO core.quantity_import
             (site_id, file_id, document_id, original_name, status, analysis, cross_check, created_by)
           VALUES ($1,$2,$3,$4,'ANALYZED',$5,$6,$7)
           RETURNING id, status, created_at`,
          [siteId, f.rows[0]!.id, doc.rows[0]!.id, file.originalname,
           JSON.stringify(analysis), JSON.stringify(check), req.actor!.userId]);
        return imp.rows[0];
      });

      res.status(201).json({
        import_id: row!.id,
        status: row!.status,
        analysis: summarizeAnalysis(analysis),
        cross_check: check,
        /** 사용자가 확인·수정해야 할 매핑 후보 (§12: AI 는 후보 제안까지만) */
        mapping_suggestion: suggestMapping(analysis),
      });
    } catch (e) { next(e); }
  });

/** 응답이 지나치게 커지지 않게 행 목록은 요약해서 돌려준다. */
function summarizeAnalysis(a: WorkbookAnalysis) {
  return {
    sheets: a.sheets,
    schedule_sheet: a.schedule_sheet,
    basis_sheet: a.basis_sheet,
    layer_labels: a.layer_labels,
    design_params: a.design_params,
    basis_totals: a.basis_totals,
    warnings: a.warnings,
    blocks: a.blocks.map((b) => ({
      block_key: b.block_key,
      block_label: b.block_label,
      row_count: b.rows.length,
      id_decimals: b.id_decimals,
      first_hole_no: b.rows[0]?.hole_no_raw ?? null,
      last_hole_no: b.rows[b.rows.length - 1]?.hole_no_raw ?? null,
      layers: b.layers.map((l) => l.label),
      computed_totals: b.computed_totals,
      computed_grand_total: b.computed_grand_total,
      sheet_totals: b.sheet_totals,
      row_issue_count: b.rows.filter((r) => r.issues.length > 0).length,
      source_rows: `R${b.data_from}~R${b.data_to}`,
    })),
  };
}

/** 매핑 후보 제안. 확정이 아니라 제안이다. */
function suggestMapping(a: WorkbookAnalysis) {
  return {
    blocks: a.blocks.map((b, i) => ({
      block_key: b.block_key,
      block_label: b.block_label,
      /** 천공종류 코드는 사람이 정한다. 여기서는 순번 기반 임시 제안만 한다. */
      suggested_hole_type_code: null as string | null,
      suggested_hole_no_style: (b.id_decimals > 0 ? 'DECIMAL_TO_DASH' : 'RAW') as HoleNoStyle,
      order: i,
    })),
    ground_types: a.layer_labels.map((l, i) => ({
      label: l.label,
      suggested_code: `G${String(i + 1).padStart(2, '0')}`,
      suggested_status: l.used ? 'CONFIRMED' : 'PROVISIONAL',
      total: l.total,
    })),
  };
}

/* ========================================================= 조회 */
quantityImportRouter.get('/quantity-imports/:id', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const row = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT id, site_id, original_name, status, analysis, mapping, cross_check,
                applied_at, created_at
           FROM core.quantity_import WHERE id=$1`, [id]);
      return r.rows[0];
    });
    if (!row) throw notFound('가져오기 세션을 찾을 수 없습니다.');
    const analysis = row.analysis as WorkbookAnalysis;
    res.json({
      import_id: row.id, status: row.status, original_name: row.original_name,
      analysis: summarizeAnalysis(analysis), mapping: row.mapping,
      cross_check: row.cross_check, applied_at: row.applied_at,
    });
  } catch (e) { next(e); }
});

/* ========================================================= 2) 매핑 확정 */
const mappingSchema = z.object({
  hole_no_style: z.enum(['RAW', 'DECIMAL_TO_DASH']).default('RAW'),
  blocks: z.array(z.object({
    block_key: z.string().min(1),
    hole_type_code: z.string().min(1).max(20),
    hole_type_name: z.string().min(1).max(50),
    hole_no_style: z.enum(['RAW', 'DECIMAL_TO_DASH']).optional(),
    section: z.string().max(100).optional(),
  })).min(1),
  ground_types: z.array(z.object({
    label: z.string().min(1),
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(50),
    status: z.enum(['CONFIRMED', 'PROVISIONAL', 'RETIRED']).default('CONFIRMED'),
  })).min(1),
  /** 설계 파라미터도 함께 등록할지 */
  import_design_params: z.boolean().default(true),
});

quantityImportRouter.patch('/quantity-imports/:id/mapping', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const p = mappingSchema.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '매핑이 올바르지 않습니다.');

    const row = await withSession(req.actor!, async (c) => {
      const cur = await c.query('SELECT analysis FROM core.quantity_import WHERE id=$1', [id]);
      if (!cur.rowCount) return null;
      const analysis = cur.rows[0]!.analysis as WorkbookAnalysis;

      const known = new Set(analysis.blocks.map((b) => b.block_key));
      for (const b of p.data.blocks) {
        if (!known.has(b.block_key)) {
          throw badRequest(`블록 '${b.block_key}' 는 이 파일에 없습니다.`);
        }
      }
      const labels = new Set(analysis.layer_labels.map((l) => l.label));
      for (const g of p.data.ground_types) {
        if (!labels.has(g.label)) {
          throw badRequest(`지층 '${g.label}' 는 이 파일에 없습니다.`);
        }
      }

      const r = await c.query(
        `UPDATE core.quantity_import SET mapping=$2, status='MAPPED' WHERE id=$1
         RETURNING id, status`, [id, JSON.stringify(p.data)]);
      return r.rows[0];
    });
    if (!row) throw notFound('가져오기 세션을 찾을 수 없습니다.');
    res.json({ import_id: row.id, status: row.status, mapping: p.data });
  } catch (e) { next(e); }
});

/* ========================================================= 3) 미리보기 */
interface PlannedHole {
  block_key: string;
  hole_no_raw: string;
  hole_no: string;
  hole_type_code: string;
  section: string | null;
  layers: { code: string; name: string; planned_length: number }[];
  design_depth_total: number;
  generated_from: string | null;
}

/** 매핑을 적용해 "HOLE_MASTER 에 들어갈 모습" 을 계산한다. 저장하지 않는다. */
function buildPlan(
  analysis: WorkbookAnalysis,
  mapping: z.infer<typeof mappingSchema>,
  expansions: Record<string, PlannedHole[]> = {},
) {
  const notes: { code: string; severity: string; message: string }[] = [];
  const labelToGt = new Map(mapping.ground_types.map((g) => [g.label, g]));
  const planned: PlannedHole[] = [];

  for (const bm of mapping.blocks) {
    const expanded = expansions[bm.block_key];
    if (expanded) { planned.push(...expanded); continue; }

    const block = analysis.blocks.find((b) => b.block_key === bm.block_key);
    if (!block) continue;

    const style: HoleNoStyle = bm.hole_no_style ?? mapping.hole_no_style;
    const { hole_nos: holeNos, notes: convNotes } =
      convertAll(block.rows.map((r) => r.hole_no_raw), style);
    notes.push(...convNotes.map((n) => ({ ...n,
      message: `[${bm.hole_type_code}] ${n.message}` })));

    block.rows.forEach((r, i) => {
      const layers = r.layers
        .filter((l) => l.planned_length > 0)
        .map((l) => {
          const gt = labelToGt.get(l.label);
          return { code: gt?.code ?? l.label, name: gt?.name ?? l.label, planned_length: l.planned_length };
        });
      planned.push({
        block_key: bm.block_key,
        hole_no_raw: r.hole_no_raw,
        hole_no: holeNos[i]!,
        hole_type_code: bm.hole_type_code,
        section: bm.section ?? null,
        layers,
        design_depth_total: r.layer_sum,
        generated_from: null,
      });
    });
  }

  // 현장 전체에서 천공번호가 유일해야 한다 (§14)
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const h of planned) {
    if (seen.has(h.hole_no)) dup.add(h.hole_no);
    seen.add(h.hole_no);
  }
  if (dup.size > 0) {
    notes.push({
      code: 'DUPLICATE_HOLE_NO', severity: 'ERROR',
      message: `블록 간 천공번호가 중복됩니다: ${[...dup].slice(0, 20).join(', ')}`,
    });
  }

  const layerTotals = new Map<string, number>();
  for (const h of planned) {
    for (const l of h.layers) {
      layerTotals.set(l.name, Number(((layerTotals.get(l.name) ?? 0) + l.planned_length).toFixed(3)));
    }
  }

  return {
    planned,
    summary: {
      hole_count: planned.length,
      by_type: mapping.blocks.map((b) => {
        const rows = planned.filter((h) => h.hole_type_code === b.hole_type_code);
        return {
          hole_type_code: b.hole_type_code,
          hole_count: rows.length,
          total_length: Number(rows.reduce((a, r) => a + r.design_depth_total, 0).toFixed(3)),
          first: rows[0]?.hole_no ?? null,
          last: rows[rows.length - 1]?.hole_no ?? null,
        };
      }),
      layer_totals: [...layerTotals.entries()].map(([name, total]) => ({ name, total })),
      grand_total: Number(planned.reduce((a, h) => a + h.design_depth_total, 0).toFixed(3)),
    },
    notes,
  };
}

quantityImportRouter.post('/quantity-imports/:id/preview', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const data = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        'SELECT site_id, analysis, mapping FROM core.quantity_import WHERE id=$1', [id]);
      if (!r.rowCount) return null;
      const { site_id: siteId, analysis, mapping } = r.rows[0]! as {
        site_id: string; analysis: WorkbookAnalysis; mapping: unknown };
      if (!mapping) throw badRequest('먼저 매핑을 확정하십시오.', 'MAPPING_REQUIRED');

      const plan = buildPlan(analysis, mapping as z.infer<typeof mappingSchema>);
      const conflicts = await c.query(
        'SELECT * FROM core.fn_check_hole_numbers($1,$2)',
        [siteId, plan.planned.map((h) => h.hole_no)]);
      return { siteId, plan, conflicts: conflicts.rows };
    });
    if (!data) throw notFound('가져오기 세션을 찾을 수 없습니다.');

    const notes = [...data.plan.notes];
    if (data.conflicts.length > 0) {
      notes.push({
        code: 'EXISTING_HOLE_NO', severity: 'WARN',
        message: `${data.conflicts.length}개 천공번호가 이미 현장에 있습니다. `
          + '기존 값은 Revision 으로 보존된 뒤 갱신됩니다.',
      });
    }

    await withSession(req.actor!, async (c) => {
      await c.query(
        `UPDATE core.quantity_import SET status='PREVIEWED' WHERE id=$1 AND status<>'APPLIED'`, [id]);
    });

    res.json({
      import_id: id,
      ...data.plan.summary,
      sample: data.plan.planned.slice(0, 10),
      existing_hole_numbers: data.conflicts.map((c: { hole_no: string }) => c.hole_no),
      notes,
      can_apply: notes.filter((n) => n.severity === 'ERROR').length === 0,
      /** §12: 승인은 사람이 한다 */
      approval_required: true,
    });
  } catch (e) { next(e); }
});

/* ========================================================= 4) 패턴 확장 미리보기 */
const expandSchema = z.object({
  block_key: z.string().min(1),
  numbering: z.union([
    z.object({ mode: z.literal('LIST'), numbers: z.array(z.string()).min(1) }),
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
  ]),
});

quantityImportRouter.post('/quantity-imports/:id/expand-preview', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const p = expandSchema.safeParse(req.body);
    if (!p.success) throw badRequest(p.error.issues[0]?.message ?? '확장 조건이 올바르지 않습니다.');

    const analysis = await withSession(req.actor!, async (c) => {
      const r = await c.query('SELECT analysis FROM core.quantity_import WHERE id=$1', [id]);
      return r.rows[0]?.analysis as WorkbookAnalysis | undefined;
    });
    if (!analysis) throw notFound('가져오기 세션을 찾을 수 없습니다.');

    const block: ScheduleBlock | undefined =
      analysis.blocks.find((b) => b.block_key === p.data.block_key);
    if (!block) throw badRequest(`블록 '${p.data.block_key}' 를 찾을 수 없습니다.`);

    let result;
    try {
      result = expandByPattern(block.rows, p.data.numbering, (r) => r.hole_no_raw);
    } catch (e) {
      if (e instanceof HoleNumberError) throw badRequest(e.message, 'HOLE_NUMBER_INVALID');
      throw e;
    }

    res.json({
      block_key: block.block_key,
      block_label: block.block_label,
      pattern_size: result.pattern_size,
      generated_count: result.rows.length,
      cycles: result.cycles,
      layer_totals: result.layer_totals,
      grand_total: result.grand_total,
      sample: result.rows.slice(0, 8),
      issues: result.issues,
      approval_required: true,
    });
  } catch (e) { next(e); }
});

/* ========================================================= 5) 승인 후 반영 */
const applySchema = z.object({
  /** 명시적 승인. 이 값이 true 가 아니면 반영하지 않는다 (§12, §45). */
  approved: z.literal(true),
  approval_note: z.string().max(500).optional(),
  expansions: z.array(expandSchema).optional(),
});

quantityImportRouter.post('/quantity-imports/:id/apply', async (req, res, next) => {
  try {
    const id = uuid.parse(req.params.id);
    const p = applySchema.safeParse(req.body);
    if (!p.success) {
      throw badRequest('승인(approved: true)이 없으면 반영하지 않습니다.', 'APPROVAL_REQUIRED');
    }

    const result = await withSession(req.actor!, async (c) => {
      const r = await c.query(
        `SELECT site_id, analysis, mapping, status FROM core.quantity_import WHERE id=$1`, [id]);
      if (!r.rowCount) return null;
      const { site_id: siteId, analysis, mapping, status } = r.rows[0]! as {
        site_id: string; analysis: WorkbookAnalysis; mapping: unknown; status: string };
      if (status === 'APPLIED') throw badRequest('이미 반영된 가져오기입니다.', 'ALREADY_APPLIED');
      if (!mapping) throw badRequest('먼저 매핑을 확정하십시오.', 'MAPPING_REQUIRED');
      const m = mapping as z.infer<typeof mappingSchema>;

      // 패턴 확장분을 계획에 합친다 (사용자가 명시적으로 요청한 경우에만)
      const expansions: Record<string, PlannedHole[]> = {};
      for (const ex of p.data.expansions ?? []) {
        const block = analysis.blocks.find((b) => b.block_key === ex.block_key);
        const bm = m.blocks.find((b) => b.block_key === ex.block_key);
        if (!block || !bm) throw badRequest(`블록 '${ex.block_key}' 를 찾을 수 없습니다.`);
        const labelToGt = new Map(m.ground_types.map((g) => [g.label, g]));
        const expanded = expandByPattern(block.rows, ex.numbering, (x) => x.hole_no_raw);
        expansions[ex.block_key] = expanded.rows.map((row) => ({
          block_key: ex.block_key,
          hole_no_raw: row.generated_from,
          hole_no: row.hole_no,
          hole_type_code: bm.hole_type_code,
          section: bm.section ?? null,
          layers: row.layers.filter((l) => l.planned_length > 0).map((l) => {
            const gt = labelToGt.get(l.label);
            return { code: gt?.code ?? l.label, name: gt?.name ?? l.label, planned_length: l.planned_length };
          }),
          design_depth_total: row.layer_sum,
          generated_from: row.generated_from,
        }));
      }

      const plan = buildPlan(analysis, m, expansions);
      const blocking = plan.notes.filter((n) => n.severity === 'ERROR');
      if (blocking.length > 0) throw badRequest(blocking[0]!.message, blocking[0]!.code);

      // 1) 지층종류 등록 (값이 0인 지층도 PROVISIONAL 로 보존)
      const gtId = new Map<string, string>();
      for (let i = 0; i < m.ground_types.length; i++) {
        const g = m.ground_types[i]!;
        const gr = await c.query(
          `INSERT INTO core.ground_type (site_id, code, name, sort_order, status, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (site_id, code) DO UPDATE
             SET name = EXCLUDED.name, status = EXCLUDED.status
           RETURNING id`,
          [siteId, g.code, g.name, i + 1, g.status,
           g.status === 'PROVISIONAL' ? '수량산출서에 0으로 기재됨' : null, req.actor!.userId]);
        gtId.set(g.code, gr.rows[0]!.id as string);
      }

      // 2) 천공종류 등록
      const htId = new Map<string, string>();
      for (let i = 0; i < m.blocks.length; i++) {
        const b = m.blocks[i]!;
        const hr = await c.query(
          `INSERT INTO core.site_hole_type (site_id, code, name, sort_order)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (site_id, code) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`, [siteId, b.hole_type_code, b.hole_type_name, i + 1]);
        htId.set(b.hole_type_code, hr.rows[0]!.id as string);
      }

      // 3) 설계 파라미터
      if (m.import_design_params) {
        for (const dp of analysis.design_params) {
          const code = paramCode(dp.label);
          await c.query(
            `INSERT INTO core.site_design_param
               (site_id, param_code, param_name, param_value, unit, note, is_reference, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (site_id, param_code, COALESCE(section, '')) DO UPDATE
               SET param_value = EXCLUDED.param_value, unit = EXCLUDED.unit,
                   is_reference = EXCLUDED.is_reference
             RETURNING id`,
            [siteId, code, dp.label, dp.value, dp.unit, dp.note,
             REFERENCE_PARAMS.has(code), req.actor!.userId]);
        }
      }

      // 4) 지반조건 + 천공번호 (같은 조합은 지반조건 공유)
      const profileCache = new Map<string, string>();
      let createdHoles = 0;
      let updatedHoles = 0;
      let createdProfiles = 0;

      for (const h of plan.planned) {
        const sig = h.layers.map((l) => `${l.name}:${l.planned_length.toFixed(3)}`).join(' + ');
        let profileId = profileCache.get(sig);
        if (!profileId) {
          const found = await c.query(
            `SELECT id FROM core.ground_profile
              WHERE site_id=$1 AND profile_name=$2 AND status='CONFIRMED'`, [siteId, sig]);
          if (found.rowCount) {
            profileId = found.rows[0]!.id as string;
          } else {
            profileId = await createProfile(c, siteId, sig, h, gtId, req.actor!.userId!);
            createdProfiles++;
          }
          profileCache.set(sig, profileId);
        }

        const existing = await c.query(
          'SELECT id FROM core.hole_master WHERE site_id=$1 AND hole_no=$2', [siteId, h.hole_no]);
        if (existing.rowCount) {
          const holeId = existing.rows[0]!.id as string;
          await c.query(
            `SELECT core.fn_snapshot_hole_revision($1,'DESIGN_CHANGE',$2)`,
            [holeId, `수량산출서 가져오기: ${p.data.approval_note ?? ''}`.trim()]);
          await c.query(
            `UPDATE core.hole_master
                SET hole_type_id=$2, section=COALESCE($3, section),
                    design_depth_total=$4, ground_profile_id=$5,
                    contract_quantity=$4, contract_unit='m'
              WHERE id=$1`,
            [holeId, htId.get(h.hole_type_code), h.section, h.design_depth_total, profileId]);
          updatedHoles++;
        } else {
          await c.query(
            `INSERT INTO core.hole_master
               (site_id, hole_no, section, hole_type_id, design_depth_total,
                ground_profile_id, contract_quantity, contract_unit, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$5,'m','NOT_STARTED',$7)`,
            [siteId, h.hole_no, h.section, htId.get(h.hole_type_code),
             h.design_depth_total, profileId, req.actor!.userId]);
          createdHoles++;
        }
      }

      // 5) 파싱 결과 원본을 보존한다 (추적 가능성)
      await c.query('DELETE FROM core.quantity_import_row WHERE import_id=$1', [id]);
      for (const h of plan.planned) {
        await c.query(
          `INSERT INTO core.quantity_import_row
             (import_id, block_key, source_row, hole_no_raw, hole_no, hole_type_code,
              layers, layer_sum, generated_from)
           VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (import_id, block_key, hole_no) DO NOTHING`,
          [id, h.block_key, h.hole_no_raw, h.hole_no, h.hole_type_code,
           JSON.stringify(h.layers), h.design_depth_total, h.generated_from]);
      }

      await c.query(
        `UPDATE core.quantity_import
            SET status='APPLIED', applied_at=now(), applied_by=$2 WHERE id=$1`,
        [id, req.actor!.userId]);
      await c.query(
        'UPDATE core.site SET setup_step = GREATEST(setup_step, 8) WHERE id=$1', [siteId]);

      return {
        created_holes: createdHoles, updated_holes: updatedHoles,
        created_profiles: createdProfiles,
        ground_types: m.ground_types.length, hole_types: m.blocks.length,
        summary: plan.summary,
      };
    });
    if (!result) throw notFound('가져오기 세션을 찾을 수 없습니다.');
    res.status(201).json({ import_id: id, status: 'APPLIED', ...result });
  } catch (e) { next(e); }
});

async function createProfile(
  c: SessionClient, siteId: string, sig: string, h: PlannedHole,
  gtId: Map<string, string>, userId: string,
): Promise<string> {
  const gp = await c.query(
    `INSERT INTO core.ground_profile
       (site_id, profile_name, revision, description, depth_mode, total_planned_depth,
        source, source_reference, status, created_by)
     VALUES ($1,$2,0,$3,'DEPTH_RANGE',$4,'QUANTITY_SHEET','천공조서 공당값','DRAFT',$5)
     RETURNING id`,
    [siteId, sig, `수량산출서 가져오기 (${h.hole_no_raw})`, h.design_depth_total, userId]);
  const profileId = gp.rows[0]!.id as string;

  let from = 0;
  for (let i = 0; i < h.layers.length; i++) {
    const l = h.layers[i]!;
    const id = gtId.get(l.code);
    if (!id) throw badRequest(`지층종류 '${l.code}' 매핑이 없습니다.`);
    const to = Number((from + l.planned_length).toFixed(3));
    await c.query(
      `INSERT INTO core.ground_profile_layer
         (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
       VALUES ($1,$2,$3,$4,$5,$6)`, [profileId, i + 1, id, from, to, l.planned_length]);
    from = to;
  }
  await c.query(
    `UPDATE core.ground_profile SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now()
      WHERE id=$1`, [profileId, userId]);
  return profileId;
}

/**
 * 계산으로 유도되는 파라미터. 확정 근거가 아니다.
 * 사용자 확인: C.T.C 가 구간마다 달라져 '연장 ÷ C.T.C' 로 공수를 정할 수 없다.
 * 공수의 기준은 도면 넘버링이다.
 */
const REFERENCE_PARAMS = new Set(['TOTAL_HOLE_COUNT', 'HPILE_COUNT', 'MUGEUN_COUNT']);

/** 한글 파라미터명을 안정적인 코드로 바꾼다. */
function paramCode(label: string): string {
  const map: Record<string, string> = {
    '직경': 'DIAMETER', 'C.T.C': 'CTC', '가시설 연장': 'WALL_LENGTH',
    '측면말뚝 간격': 'SIDE_PILE_GAP', '총 공수': 'TOTAL_HOLE_COUNT',
    'H-PILE 본수': 'HPILE_COUNT', '무근 본수': 'MUGEUN_COUNT',
  };
  return map[label] ?? 'P_' + createHash('sha1').update(label).digest('hex').slice(0, 10).toUpperCase();
}
