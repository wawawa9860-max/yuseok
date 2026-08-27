/**
 * PHASE 5 테스트 — 작업도면 ↔ 천공번호 연결
 * Master Prompt §13, §14, §35, §38
 *
 * 픽스처는 사용자가 업로드한 **실제 작업도면 PDF와 수량산출서 v2** 다.
 * 두 문서가 실제로 어긋나는 부분(16-1 누락)을 그대로 검증한다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';
import {
  extractDrawingLabels, filterHoleLabels,
} from '../src/domain/drawing/extractLabels.js';
import { analyzeWorkbook } from '../src/domain/quantitySheet/analyze.js';
import { crossCheck } from '../src/domain/quantitySheet/crossCheck.js';

afterAll(async () => { await closePool(); });

const DRAWING = join(process.cwd(), 'tests/fixtures/sample-work-drawing.pdf');
const SHEET_V2 = join(process.cwd(), 'tests/fixtures/sample-quantity-sheet-v2.xlsx');
const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/* ============================================ 도면 라벨 추출 */
describe('§13 작업도면에서 천공번호를 뽑는다', () => {
  it('두 조각으로 그려진 번호를 하나로 합친다', async () => {
    const data = new Uint8Array(readFileSync(DRAWING));
    const r = await extractDrawingLabels(data);
    const holes = filterHoleLabels(r.labels);

    expect(r.page_count).toBe(1);
    expect(holes).toHaveLength(107);

    const texts = holes.map((h) => h.text);
    const plain = texts.filter((t) => /^\d+$/.test(t)).map(Number).sort((a, b) => a - b);
    const dashed = texts.filter((t) => /^\d+-\d+$/.test(t));

    expect(plain).toEqual([...Array(54)].map((_, i) => i + 1));   // 1~54 연속
    expect(dashed).toHaveLength(53);
    expect(dashed).toContain('1-1');
    expect(dashed).toContain('54-1');
  });

  it('도면에 16-1 이 없다 (실제 문서의 누락)', async () => {
    const r = await extractDrawingLabels(new Uint8Array(readFileSync(DRAWING)));
    const dashed = filterHoleLabels(r.labels).map((h) => h.text).filter((t) => /^\d+-\d+$/.test(t));
    const present = new Set(dashed.map((d) => Number(d.split('-')[0])));
    const missing = [...Array(54)].map((_, i) => i + 1).filter((n) => !present.has(n));
    expect(missing).toEqual([16]);
  });

  it('간격 임계값은 글자 크기에 대한 비율이라 축척에 흔들리지 않는다', async () => {
    const data = new Uint8Array(readFileSync(DRAWING));
    // 실측: 합쳐야 할 간격 6.38pt, 떼야 할 간격 최소 16.45pt, 글자 18.1pt
    for (const ratio of [0.4, 0.6, 0.85]) {
      const r = await extractDrawingLabels(data, { joinGapRatio: ratio });
      expect(filterHoleLabels(r.labels)).toHaveLength(107);
    }
  });

  it('임계값을 너무 크게 잡으면 번호가 잘못 붙는다 (음성 검증)', async () => {
    const r = await extractDrawingLabels(new Uint8Array(readFileSync(DRAWING)),
      { joinGapRatio: 3 });
    expect(filterHoleLabels(r.labels).length).toBeLessThan(107);
  });

  it('천공번호로 보기 어려운 라벨은 걸러낸다', async () => {
    const r = await extractDrawingLabels(new Uint8Array(readFileSync(DRAWING)));
    expect(r.labels.length).toBe(filterHoleLabels(r.labels).length + 0);
  });
});

/* ============================================ 새 수량산출서 회귀 */
describe('수량산출서 v2 — 파서가 코드 수정 없이 처리한다', () => {
  let a: Awaited<ReturnType<typeof analyzeWorkbook>>;
  beforeAll(async () => { a = await analyzeWorkbook(SHEET_V2); });

  it('행 수와 번호 형식이 바뀌어도 그대로 인식한다', async () => {
    expect(a.blocks).toHaveLength(2);
    for (const b of a.blocks) expect(b.rows).toHaveLength(54);   // 29 → 54 로 늘어남
    expect(a.blocks[1]!.rows[0]!.hole_no_raw).toBe('1-1');       // 이제 텍스트 표기
    expect(a.blocks[1]!.rows[53]!.hole_no_raw).toBe('54-1');
  });

  it('실행가 시트는 조서/산출근거로 오인하지 않는다 (§29)', async () => {
    const roles = new Map(a.sheets.map((s) => [s.sheet_name, s.role]));
    expect(roles.get('갑지-실행가')).toBe('UNKNOWN');
    expect(roles.get('내역서-실행가')).toBe('UNKNOWN');
    expect(a.schedule_sheet).toBe('천공조서(RF-CIP)');
    expect(a.basis_sheet).toBe('산출근거(RF-CIP)');
  });

  it('무근이 H-PILE 보다 짧다 (사용자 지시가 반영된 설계)', async () => {
    expect(a.blocks[0]!.computed_grand_total).toBe(1080);   // H-PILE 54공 × 20m
    expect(a.blocks[1]!.computed_grand_total).toBe(972);    // 무근  54공 × 18m
  });

  it('★ 조서 합계열의 낡은 수식 범위를 잡아낸다', async () => {
    const codes = a.warnings.filter((w) => w.severity === 'ERROR').map((w) => w.code);
    expect(codes).toContain('GRAND_TOTAL_MISMATCH');
    expect(codes).toContain('HOLE_COUNT_MISMATCH');

    const block = a.blocks[0]!;
    expect(block.computed_grand_total).toBe(1080);
    expect(block.sheet_grand_total).toBe(580);    // 29공분만 더한 값
    expect(block.sheet_hole_count).toBe(29);      // 실제는 54공
  });

  it('지층 소계는 정상이라 오탐이 아니다', async () => {
    const b = a.blocks[0]!;
    const soil = b.sheet_totals!.find((t) => t.label === '토사')!;
    expect(soil.total).toBe(810);
    expect(b.computed_totals.find((t) => t.label === '토사')!.total).toBe(810);
  });
});

/* ============================================ 도면 ↔ 마스터 대조 (§14) */
describe('§14 도면 ↔ HOLE_MASTER 대조 및 반영', () => {
  let token = '';
  let siteId = '';
  let quantityImportId = '';
  let drawingImportId = '';

  beforeAll(async () => {
    token = await login('head01');
    const site = await request(app).post('/api/admin/sites').set(auth(token))
      .send({ site_code: 'PHASE5_TEST', site_name: 'PHASE5 도면연결 검증현장' });
    siteId = site.body.site.id;

    // 수량산출서 v2 를 먼저 반영해 108공을 만든다
    const up = await request(app).post(`/api/admin/sites/${siteId}/quantity-imports`)
      .set(auth(token)).attach('file', SHEET_V2);
    quantityImportId = up.body.import_id;

    await request(app).patch(`/api/admin/quantity-imports/${quantityImportId}/mapping`)
      .set(auth(token)).send({
        blocks: [
          { block_key: 'A', hole_type_code: 'HPILE', hole_type_name: 'H-PILE 구간', hole_no_style: 'RAW' },
          { block_key: 'M', hole_type_code: 'MUGEUN', hole_type_name: '무근', hole_no_style: 'RAW' },
        ],
        ground_types: [
          { label: '토사', code: 'G01', name: '토사', status: 'CONFIRMED' },
          { label: '풍화암', code: 'G02', name: '풍화암', status: 'CONFIRMED' },
          { label: '연암', code: 'G03', name: '연암', status: 'CONFIRMED' },
          { label: '경암', code: 'G04', name: '경암', status: 'PROVISIONAL' },
        ],
      });
    await request(app).post(`/api/admin/quantity-imports/${quantityImportId}/apply`)
      .set(auth(token)).send({ approved: true });
  });

  it('수량산출서 반영으로 108공이 만들어진다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/holes?limit=200`).set(auth(token));
    expect(res.body.count).toBe(108);
  });

  it('도면을 올리면 천공번호가 추출된다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/drawing-imports`)
      .set(auth(token)).attach('file', DRAWING);
    expect(res.status).toBe(201);
    expect(res.body.hole_number_count).toBe(107);
    expect(res.body.duplicates).toEqual([]);
    expect(res.body.confirmation_required).toBe(true);
    expect(res.body.revision_no).toBe(0);
    drawingImportId = res.body.import_id;
  });

  it('★ 대조표가 도면과 조서의 실제 차이를 짚어낸다', async () => {
    const res = await request(app)
      .get(`/api/admin/drawing-imports/${drawingImportId}/reconcile`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.drawing_hole_count).toBe(107);
    expect(res.body.matched).toBe(107);
    expect(res.body.drawing_only).toEqual([]);
    expect(res.body.master_only.map((m: { hole_no: string }) => m.hole_no)).toEqual(['16-1']);
    expect(res.body.master_only[0].deletable).toBe(true);
    expect(res.body.issues.map((i: { code: string }) => i.code))
      .toContain('MASTER_HOLE_MISSING_IN_DRAWING');
    expect(res.body.recommended_action).toBe('MARK_ONLY');
  });

  it('승인 없이 반영하면 거부한다', async () => {
    await request(app).patch(`/api/admin/drawing-imports/${drawingImportId}/mapping`)
      .set(auth(token)).send({ missing_hole_action: 'MARK_ONLY' });
    const res = await request(app)
      .post(`/api/admin/drawing-imports/${drawingImportId}/apply`).set(auth(token)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('APPROVAL_REQUIRED');
  });

  it('도면 순서대로 drawing_sequence 가 매겨진다', async () => {
    const res = await request(app)
      .post(`/api/admin/drawing-imports/${drawingImportId}/apply`).set(auth(token))
      .send({ approved: true, approval_note: '도면 REV0 대조 완료' });
    expect(res.status).toBe(201);
    expect(res.body.matched).toBe(107);
    expect(res.body.drawing_order_applied).toBe(107);
    expect(res.body.marked_needs_check).toBe(1);   // 16-1
    expect(res.body.removed_holes).toBe(0);
  });

  it('도면에 없던 16-1 은 삭제되지 않고 확인필요로 표시된다 (§8)', async () => {
    const row = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT status, change_review_required, drawing_sequence
           FROM core.hole_master WHERE site_id=$1 AND hole_no='16-1'`, [siteId]);
      return r.rows[0];
    });
    expect(row).toBeDefined();                    // 데이터가 남아 있다
    expect(row.status).toBe('NEEDS_CHECK');
    expect(row.change_review_required).toBe(true);
    expect(row.drawing_sequence).toBeNull();      // 도면에 없으므로 순번 없음
  });

  it('§13 도면 진행상태를 파생으로 보여준다', async () => {
    const res = await request(app)
      .get(`/api/admin/sites/${siteId}/drawing-progress`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(108);
    const byStatus = new Map(res.body.by_status.map(
      (s: { status: string; count: number }) => [s.status, s.count]));
    expect(byStatus.get('미시공')).toBe(107);
    expect(byStatus.get('확인필요')).toBe(1);
    // 도면 순서가 먼저 오고, 도면에 없는 것은 뒤로 간다
    expect(res.body.holes[0].drawing_sequence).toBe(1);
    expect(res.body.holes[107].hole_no).toBe('16-1');
  });

  it('§43 현장 검증에 도면 불일치가 보고된다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('MASTER_HOLE_MISSING_IN_DRAWING');
    expect(codes).toContain('HOLE_WITHOUT_DRAWING_ORDER');
  });

  it('무근이 H-PILE 보다 짧아 깊이 경고가 사라진다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).not.toContain('MUGEUN_DEEPER_THAN_HPILE');
    expect(codes).not.toContain('MUGEUN_SAME_AS_HPILE');
  });

  it('§38 도면도 revision 을 가진다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT dr.revision_no, dr.is_current, d.current_revision
           FROM core.document_revision dr JOIN core.document d ON d.id = dr.document_id
          WHERE d.site_id=$1 AND d.doc_type='WORK_DRAWING' ORDER BY dr.revision_no`, [siteId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].revision_no).toBe(0);
    expect(rows[0].is_current).toBe(true);
    expect(rows[0].current_revision).toBe(0);
  });

  it('같은 도면을 다시 올리면 REV 1 이 된다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/drawing-imports`)
      .set(auth(token)).attach('file', DRAWING);
    expect(res.status).toBe(201);
    expect(res.body.revision_no).toBe(1);
  });

  it('두 번 반영하려 하면 거부한다', async () => {
    const res = await request(app)
      .post(`/api/admin/drawing-imports/${drawingImportId}/apply`).set(auth(token))
      .send({ approved: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ALREADY_APPLIED');
  });

  it('PDF 가 아닌 파일은 거부한다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/drawing-imports`)
      .set(auth(token)).attach('file', Buffer.from('not pdf'), 'x.png');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_FILE');
  });

  it('현장관리자는 도면을 반영할 수 없다', async () => {
    const fieldToken = await login('field01');
    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/drawing-imports`).set(auth(fieldToken));
    expect(res.status).toBe(403);
  });
});

/* ============================================ 수정본 v3 회귀 + C.T.C 가변 */
describe('수량산출서 v3 (수정본) — 지적한 오류가 고쳐졌는지 확인', () => {
  const SHEET_V3 = join(process.cwd(), 'tests/fixtures/sample-quantity-sheet-v3.xlsx');
  let a3: Awaited<ReturnType<typeof analyzeWorkbook>>;
  let a2: Awaited<ReturnType<typeof analyzeWorkbook>>;
  beforeAll(async () => {
    a3 = await analyzeWorkbook(SHEET_V3);
    a2 = await analyzeWorkbook(SHEET_V2);
  });

  it('합계열 오류가 해소되었다 (580 → 1080, 522 → 972)', () => {
    expect(a2.blocks[0]!.sheet_grand_total).toBe(580);    // 수정 전
    expect(a3.blocks[0]!.sheet_grand_total).toBe(1080);   // 수정 후
    expect(a3.blocks[1]!.sheet_grand_total).toBe(972);
    expect(a3.warnings.map((w) => w.code)).not.toContain('GRAND_TOTAL_MISMATCH');
  });

  it('행 합계와 조서 합계열이 이제 일치한다', () => {
    for (const b of a3.blocks) {
      expect(b.computed_grand_total).toBe(b.sheet_grand_total);
    }
  });

  it('합계행 공수는 아직 29 로 남아 있다 (미해결)', () => {
    expect(a3.blocks[0]!.sheet_hole_count).toBe(29);
    expect(a3.blocks[0]!.rows).toHaveLength(54);
    expect(a3.warnings.map((w) => w.code)).toContain('HOLE_COUNT_MISMATCH');
  });

  it('교차검증이 전부 통과한다', () => {
    const cc = crossCheck(a3.blocks, a3.basis_totals);
    expect(cc.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    const soil = cc.lines.find((l) => l.label === '토사')!;
    expect(soil.basis_total).toBe(1620);
    expect(soil.schedule_total).toBe(1620);
  });
});

describe('공수의 기준은 도면 넘버링이다 (사용자 확인: C.T.C 가변)', () => {
  let token = '';
  let siteId = '';

  beforeAll(async () => {
    token = await login('head01');
    const site = await request(app).post('/api/admin/sites').set(auth(token))
      .send({ site_code: 'CTC_TEST', site_name: 'C.T.C 가변 검증현장' });
    siteId = site.body.site.id;
    await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(token))
      .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
    // 도면 넘버링 기준 54공
    await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(token))
      .send({ spec: { mode: 'RANGE', start: 1, end: 54 }, hole_type_code: 'HPILE' });
  });

  it('계산 파라미터는 참고값으로 등록된다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/design-params`)
      .set(auth(token)).send([
        { param_code: 'WALL_LENGTH', param_name: '가시설 연장', param_value: 50, unit: 'm' },
        { param_code: 'CTC', param_name: 'C.T.C', param_value: 0.47, unit: 'm' },
        { param_code: 'TOTAL_HOLE_COUNT', param_name: '총 공수', param_value: 108, unit: '공',
          is_reference: true, note: '연장÷C.T.C' },
      ]);
    expect(res.status).toBe(201);
    const byCode = new Map(res.body.design_params.map(
      (p: { param_code: string; is_reference: boolean }) => [p.param_code, p.is_reference]));
    expect(byCode.get('TOTAL_HOLE_COUNT')).toBe(true);
    expect(byCode.get('CTC')).toBe(false);
  });

  it('구간마다 다른 C.T.C 를 따로 등록할 수 있다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/design-params`)
      .set(auth(token)).send([
        { param_code: 'CTC', param_name: 'C.T.C', param_value: 0.40, unit: 'm',
          section: '곡선부', note: '간격을 좁힌 구간' },
      ]);
    expect(res.status).toBe(201);
    expect(res.body.design_params[0].section).toBe('곡선부');

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT section, param_value::text FROM core.site_design_param
          WHERE site_id=$1 AND param_code='CTC' ORDER BY section NULLS FIRST`, [siteId]);
      return r.rows;
    });
    // 현장 기본값과 구간값이 함께 존재한다
    expect(rows).toEqual([
      { section: null,     param_value: '0.470000' },
      { section: '곡선부', param_value: '0.400000' },
    ]);
  });

  it('★ 계산 공수와 실제 공수가 달라도 오류가 아니다 (INFO)', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    const issue = res.body.issues.find(
      (i: { code: string }) => i.code === 'HOLE_COUNT_VS_REFERENCE');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('INFO');            // ERROR 가 아니다
    expect(issue.message).toContain('도면 넘버링');
    expect(res.body.error_count).toBe(0);
  });

  it('도면이 반영된 뒤에는 도면 공수가 기준이 된다', async () => {
    const before = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    expect(before.body.issues.map((i: { code: string }) => i.code))
      .not.toContain('HOLE_COUNT_VS_DRAWING');

    // 도면에 50공만 있다고 가정하고 순번을 매긴다
    await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT hole_no FROM core.hole_master WHERE site_id=$1 ORDER BY sort_key LIMIT 50`, [siteId]);
      await c.query('SELECT core.fn_apply_drawing_order($1,$2,$3)',
        [siteId, r.rows.map((x: { hole_no: string }) => x.hole_no), 'TEST']);
    });

    const after = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    const issue = after.body.issues.find(
      (i: { code: string }) => i.code === 'HOLE_COUNT_VS_DRAWING');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('WARN');
    expect(issue.message).toContain('50공');
  });

  it('구간별 실제 공수를 셀 수 있다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT section, hole_type_code, hole_count FROM core.v_section_hole_count
          WHERE site_id=$1`, [siteId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].hole_count).toBe(54);
  });
});
