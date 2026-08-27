/**
 * PHASE 4 테스트 — 수량산출서 ↔ HOLE_MASTER 연결
 * Master Prompt §12, §14, §43, §45, §46
 *
 * 픽스처는 사용자가 업로드한 **실제 RF-CIP 수량산출서**다.
 * 합성 데이터가 아니라 실물로 검증한다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import request from 'supertest';
import { app, login, siteIdByCode } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';
import { analyzeWorkbook } from '../src/domain/quantitySheet/analyze.js';
import { crossCheck } from '../src/domain/quantitySheet/crossCheck.js';
import { convertAll, convertHoleNo } from '../src/domain/quantitySheet/holeNo.js';
import { expandByPattern } from '../src/domain/quantitySheet/expand.js';
import { decimalPlaces } from '../src/domain/quantitySheet/cells.js';
import type { WorkbookAnalysis } from '../src/domain/quantitySheet/types.js';

afterAll(async () => { await closePool(); });

const FIXTURE = join(process.cwd(), 'tests/fixtures/sample-quantity-sheet.xlsx');
const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let analysis: WorkbookAnalysis;
beforeAll(async () => { analysis = await analyzeWorkbook(FIXTURE); });

/* ============================================ 구조 자동 인식 (§12) */
describe('§12 시트 구조 자동 분석 — 좌표 하드코딩 없이', () => {
  it('시트 역할을 이름으로 판별한다', () => {
    expect(analysis.schedule_sheet).toBe('천공조서(RF-CIP)');
    expect(analysis.basis_sheet).toBe('산출근거(RF-CIP)');
  });

  it('좌·우 두 블록을 천공종류가 다른 별개 블록으로 분리한다', () => {
    expect(analysis.blocks).toHaveLength(2);
    expect(analysis.blocks[0]!.block_label).toContain('H-PILE');
    expect(analysis.blocks[1]!.block_label).toContain('무');
  });

  it('3행에 걸친 병합 헤더에서 지층 × 공당/소계 매트릭스를 복원한다', () => {
    const b = analysis.blocks[0]!;
    expect(b.layers.map((l) => l.label)).toEqual(['토사', '풍화암', '연암', '경암']);
    // 지층 하나가 [공당 | 소계] 두 열을 차지한다
    for (const l of b.layers) {
      expect(l.subtotal_col).toBe(l.per_hole_col + 1);
    }
    expect(b.total_col).not.toBeNull();
  });

  it('데이터 범위를 정확히 잡는다 (합계행을 데이터로 삼키지 않는다)', () => {
    for (const b of analysis.blocks) {
      expect(b.rows).toHaveLength(29);
      const nos = b.rows.map((r) => r.hole_no_raw);
      expect(new Set(nos).size).toBe(29);   // 중복 없음
    }
  });
});

/* ============================================ 표기 원문 복원 (R9 해결) */
describe('§12 셀 표기 원문 복원 — 엑셀이 잃어버린 소수를 되살린다', () => {
  it('무근 열의 소수 자릿수를 열 단위로 추론한다', () => {
    expect(analysis.blocks[0]!.id_decimals).toBe(0);   // 1, 2 … 29
    expect(analysis.blocks[1]!.id_decimals).toBe(1);   // 1.1, 1.2 … 3.9
  });

  it('엑셀이 2.0 을 정수 2 로 저장해도 2.0 으로 복원한다', () => {
    const nos = analysis.blocks[1]!.rows.map((r) => r.hole_no_raw);
    expect(nos).toContain('2.0');
    expect(nos).toContain('3.0');
    expect(nos[0]).toBe('1.1');
    expect(nos[nos.length - 1]).toBe('3.9');
  });

  it('복원 없이는 H-PILE 번호와 충돌한다 (회귀 방지)', () => {
    const hpile = new Set(analysis.blocks[0]!.rows.map((r) => r.hole_no_raw));
    const mugeun = analysis.blocks[1]!.rows.map((r) => r.hole_no_raw);
    // 복원된 '2.0' 은 '2' 와 다르다
    expect(hpile.has('2')).toBe(true);
    expect(mugeun.includes('2')).toBe(false);
    expect(mugeun.filter((n) => hpile.has(n))).toEqual([]);
  });

  it('decimalPlaces 는 문자열 표기 기준으로 센다', () => {
    expect(decimalPlaces(2)).toBe(0);
    expect(decimalPlaces(1.1)).toBe(1);
    expect(decimalPlaces(14.63)).toBe(2);
  });
});

/* ============================================ 번호 표기 변환 (사용자 지시) */
describe('무근 번호를 1-1 형식으로 변환 (사용자 지시)', () => {
  it('1.1 → 1-1 로 기계적으로 옮긴다', () => {
    expect(convertHoleNo('1.1', 'DECIMAL_TO_DASH').hole_no).toBe('1-1');
    expect(convertHoleNo('3.9', 'DECIMAL_TO_DASH').hole_no).toBe('3-9');
  });

  it('2.0 은 2-0 이 되며 확인 요청 경고를 낸다 (추측하지 않는다)', () => {
    const r = convertHoleNo('2.0', 'DECIMAL_TO_DASH');
    expect(r.hole_no).toBe('2-0');
    expect(r.notes.map((n) => n.code)).toContain('DASH_ZERO_INDEX');
  });

  it('RAW 모드는 원문을 그대로 둔다', () => {
    expect(convertHoleNo('1.1', 'RAW').hole_no).toBe('1.1');
  });

  it('변환 후 중복이 생기면 ERROR 로 잡는다', () => {
    const r = convertAll(['1.1', '1-1'], 'DECIMAL_TO_DASH');
    expect(r.notes.map((n) => n.code)).toContain('DUPLICATE_AFTER_CONVERT');
  });

  it('실제 조서 29공을 변환해도 중복이 없다', () => {
    const raws = analysis.blocks[1]!.rows.map((r) => r.hole_no_raw);
    const r = convertAll(raws, 'DECIMAL_TO_DASH');
    expect(r.hole_nos[0]).toBe('1-1');
    expect(new Set(r.hole_nos).size).toBe(29);
    expect(r.notes.filter((n) => n.severity === 'ERROR')).toEqual([]);
  });
});

/* ============================================ 교차검증 (§14) */
describe('§14 산출근거 ↔ 천공조서 교차검증', () => {
  it('지층별 총연장이 두 시트에서 일치한다', () => {
    const check = crossCheck(analysis.blocks, analysis.basis_totals);
    const soil = check.lines.find((l) => l.label === '토사')!;
    const weathered = check.lines.find((l) => l.label === '풍화암')!;

    expect(soil.basis_total).toBe(876.12);
    expect(soil.schedule_total).toBe(876.12);   // H-PILE 438.06 + 무근 438.06
    expect(soil.match).toBe(true);

    expect(weathered.basis_total).toBe(147.3);
    expect(weathered.schedule_total).toBe(147.3);
    expect(weathered.match).toBe(true);

    expect(check.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
  });

  it('블록별 합계가 조서 합계행과 일치한다', () => {
    for (const b of analysis.blocks) {
      expect(b.computed_grand_total).toBe(511.71);
      expect(b.sheet_totals).not.toBeNull();
      const soil = b.sheet_totals!.find((t) => t.label === '토사')!;
      expect(soil.total).toBe(438.06);
    }
  });

  it('모든 행이 지층합계 = 조서 합계열 을 만족한다', () => {
    const bad = analysis.blocks.flatMap((b) => b.rows.filter((r) => r.issues.length > 0));
    expect(bad).toEqual([]);
  });

  it('불일치를 만들면 ERROR 로 검출한다 (음성 검증)', () => {
    const tampered = crossCheck(analysis.blocks, [
      { label: '토사', total: 900, source_row: 5 },
    ]);
    const codes = tampered.issues.map((i) => i.code);
    expect(codes).toContain('BASIS_SCHEDULE_MISMATCH');
    expect(tampered.lines.find((l) => l.label === '토사')!.match).toBe(false);
  });
});

/* ============================================ 지층 후보 / 설계 파라미터 */
describe('§7 지층 후보는 조서 원문에서 뽑고 강제하지 않는다', () => {
  it('값이 0인 지층 열도 후보로 남긴다', () => {
    const labels = analysis.layer_labels;
    expect(labels.map((l) => l.label)).toEqual(['토사', '풍화암', '연암', '경암']);
    expect(labels.find((l) => l.label === '연암')!.used).toBe(false);
    expect(labels.find((l) => l.label === '토사')!.used).toBe(true);
  });

  it('0인 지층은 PROVISIONAL 등록을 권고한다', () => {
    const w = analysis.warnings.find((x) => x.code === 'ZERO_LAYER_PRESENT');
    expect(w).toBeDefined();
    expect(w!.message).toContain('연암');
  });

  it('설계 파라미터를 원본값 그대로 읽는다', () => {
    const byLabel = new Map(analysis.design_params.map((p) => [p.label, p.value]));
    expect(byLabel.get('직경')).toBe(0.6);
    expect(byLabel.get('C.T.C')).toBe(0.47);
    expect(byLabel.get('가시설 연장')).toBe(300);
  });
});

/* ============================================ 패턴 반복 확장 (사용자 지시) */
describe('발췌본 29공 패턴 반복 확장 (사용자 지시)', () => {
  it('29공 패턴을 순환 적용해 대상 공수를 채운다', () => {
    const pattern = analysis.blocks[0]!.rows;
    const r = expandByPattern(
      pattern, { mode: 'RANGE', start: 1, end: 213 }, (x) => x.hole_no_raw);
    expect(r.rows).toHaveLength(213);
    expect(r.pattern_size).toBe(29);
    // 30번째 공은 발췌본 1번의 깊이를 그대로 쓴다
    expect(r.rows[29]!.layer_sum).toBe(pattern[0]!.layer_sum);
    expect(r.rows[29]!.generated_from).toBe('1');
  });

  it('생성된 수량임을 항상 경고한다 (§8 AI가 계약수량을 확정하지 않는다)', () => {
    const r = expandByPattern(
      analysis.blocks[0]!.rows, { mode: 'RANGE', start: 1, end: 58 }, (x) => x.hole_no_raw);
    expect(r.issues.map((i) => i.code)).toContain('GENERATED_QUANTITY');
  });

  it('배수가 아니면 부분 주기를 알려준다', () => {
    const r = expandByPattern(
      analysis.blocks[0]!.rows, { mode: 'RANGE', start: 1, end: 100 }, (x) => x.hole_no_raw);
    expect(r.issues.map((i) => i.code)).toContain('PARTIAL_CYCLE');
    expect(r.rows).toHaveLength(100);
  });

  it('§46 같은 입력이면 항상 같은 결과', () => {
    const run = () => expandByPattern(
      analysis.blocks[0]!.rows, { mode: 'RANGE', start: 1, end: 87 }, (x) => x.hole_no_raw);
    expect(run().layer_totals).toEqual(run().layer_totals);
  });

  it('정확히 배수면 지층 총량이 배수만큼 늘어난다', () => {
    const r = expandByPattern(
      analysis.blocks[0]!.rows, { mode: 'RANGE', start: 1, end: 87 }, (x) => x.hole_no_raw);
    expect(r.cycles).toBe(3);
    const soil = r.layer_totals.find((t) => t.label === '토사')!;
    expect(soil.total).toBeCloseTo(438.06 * 3, 2);
  });
});

/* ============================================ API 전 과정 (§12) */
describe('§12 업로드 → 분석 → 매핑 → 미리보기 → 승인 → 반영', () => {
  let token = '';
  let siteId = '';
  let importId = '';

  it('현장을 만들고 수량산출서를 업로드하면 구조가 분석된다', async () => {
    token = await login('head01');
    const site = await request(app).post('/api/admin/sites').set(auth(token))
      .send({ site_code: 'PHASE4_TEST', site_name: 'PHASE4 가져오기 검증현장' });
    siteId = site.body.site.id;

    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/quantity-imports`)
      .set(auth(token))
      .attach('file', FIXTURE);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ANALYZED');
    expect(res.body.analysis.blocks).toHaveLength(2);
    expect(res.body.analysis.blocks[0].row_count).toBe(29);
    expect(res.body.cross_check.lines.find(
      (l: { label: string }) => l.label === '토사').match).toBe(true);
    importId = res.body.import_id;
  });

  it('AI 는 매핑 후보만 제안한다 (§45)', async () => {
    const res = await request(app).get(`/api/admin/quantity-imports/${importId}`).set(auth(token));
    expect(res.body.mapping).toBeNull();     // 아직 확정된 매핑이 없다
    expect(res.body.status).toBe('ANALYZED');
  });

  it('매핑 없이 미리보기를 요청하면 거부한다', async () => {
    const res = await request(app)
      .post(`/api/admin/quantity-imports/${importId}/preview`).set(auth(token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MAPPING_REQUIRED');
  });

  it('매핑을 확정한다 (지층 0인 것은 PROVISIONAL)', async () => {
    const res = await request(app)
      .patch(`/api/admin/quantity-imports/${importId}/mapping`).set(auth(token))
      .send({
        hole_no_style: 'RAW',
        blocks: [
          { block_key: 'A', hole_type_code: 'HPILE', hole_type_name: 'H-PILE 구간',
            hole_no_style: 'RAW', section: 'H-PILE 구간' },
          { block_key: 'M', hole_type_code: 'MUGEUN', hole_type_name: '무근',
            hole_no_style: 'DECIMAL_TO_DASH', section: '무근구간' },
        ],
        ground_types: [
          { label: '토사', code: 'G01', name: '토사', status: 'CONFIRMED' },
          { label: '풍화암', code: 'G02', name: '풍화암', status: 'CONFIRMED' },
          { label: '연암', code: 'G03', name: '연암', status: 'PROVISIONAL' },
          { label: '경암', code: 'G04', name: '경암', status: 'PROVISIONAL' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('MAPPED');
  });

  it('파일에 없는 블록·지층을 매핑하면 거부한다', async () => {
    const res = await request(app)
      .patch(`/api/admin/quantity-imports/${importId}/mapping`).set(auth(token))
      .send({
        blocks: [{ block_key: 'ZZ', hole_type_code: 'X', hole_type_name: 'X' }],
        ground_types: [{ label: '토사', code: 'G01', name: '토사' }],
      });
    expect(res.status).toBe(400);
  });

  it('미리보기가 반영될 모습을 보여주지만 저장하지 않는다', async () => {
    const res = await request(app)
      .post(`/api/admin/quantity-imports/${importId}/preview`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.hole_count).toBe(58);
    expect(res.body.approval_required).toBe(true);
    expect(res.body.can_apply).toBe(true);

    const byType = new Map(res.body.by_type.map(
      (t: { hole_type_code: string; total_length: number }) => [t.hole_type_code, t.total_length]));
    expect(byType.get('HPILE')).toBe(511.71);
    expect(byType.get('MUGEUN')).toBe(511.71);
    expect(res.body.grand_total).toBe(1023.42);

    // 저장은 아직 안 됐다
    const holes = await request(app).get(`/api/sites/${siteId}/holes`).set(auth(token));
    expect(holes.body.count).toBe(0);
  });

  it('승인 없이 반영을 시도하면 거부한다 (§12, §45)', async () => {
    const res = await request(app)
      .post(`/api/admin/quantity-imports/${importId}/apply`).set(auth(token)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('APPROVAL_REQUIRED');

    const holes = await request(app).get(`/api/sites/${siteId}/holes`).set(auth(token));
    expect(holes.body.count).toBe(0);
  });

  it('승인하면 HOLE_MASTER 에 반영된다', async () => {
    const res = await request(app)
      .post(`/api/admin/quantity-imports/${importId}/apply`).set(auth(token))
      .send({ approved: true, approval_note: '원본 조서 대조 완료' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPLIED');
    expect(res.body.created_holes).toBe(58);
    expect(res.body.ground_types).toBe(4);
    expect(res.body.hole_types).toBe(2);

    const holes = await request(app).get(`/api/sites/${siteId}/holes`).set(auth(token));
    expect(holes.body.count).toBe(58);
  });

  it('무근 번호가 1-1 형식으로 들어갔다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/holes`).set(auth(token));
    const nos = res.body.holes.map((h: { hole_no: string }) => h.hole_no);
    expect(nos).toContain('1-1');
    expect(nos).toContain('2-0');
    expect(nos).toContain('3-9');
    expect(nos).toContain('1');    // H-PILE 는 원문 그대로
    expect(nos).toContain('29');
  });

  it('반영 결과가 원본 수량산출서와 일치한다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT ground_type_name, sum(planned_length)::text AS m
           FROM core.v_hole_layer_plan WHERE site_id=$1 GROUP BY 1 ORDER BY 1`, [siteId]);
      return r.rows;
    });
    expect(rows).toEqual([
      { ground_type_name: '토사',   m: '876.120' },
      { ground_type_name: '풍화암', m: '147.300' },
    ]);
  });

  it('0인 지층이 PROVISIONAL 로 등록되어 보존된다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/ground-types`).set(auth(token));
    const byName = new Map(res.body.ground_types.map(
      (g: { name: string; status: string }) => [g.name, g.status]));
    expect(byName.get('토사')).toBe('CONFIRMED');
    expect(byName.get('연암')).toBe('PROVISIONAL');
    expect(byName.get('경암')).toBe('PROVISIONAL');
  });

  it('설계 파라미터가 함께 등록된다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT param_code, param_value::text FROM core.site_design_param
          WHERE site_id=$1 AND param_code IN ('DIAMETER','CTC') ORDER BY param_code`, [siteId]);
      return r.rows;
    });
    expect(rows).toEqual([
      { param_code: 'CTC',      param_value: '0.470000' },
      { param_code: 'DIAMETER', param_value: '0.600000' },
    ]);
  });

  it('두 번 반영하려 하면 거부한다', async () => {
    const res = await request(app)
      .post(`/api/admin/quantity-imports/${importId}/apply`).set(auth(token))
      .send({ approved: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ALREADY_APPLIED');
  });

  it('§43 무근과 H-PILE 깊이가 같으면 확인 요청이 뜬다 (사용자 지시)', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    // 발췌본은 두 값이 동일하다 → 단순화된 임시본인지 확인 필요
    expect(codes).toContain('MUGEUN_SAME_AS_HPILE');
    expect(res.body.error_count).toBe(0);
  });

  it('패턴 확장 미리보기가 동작한다', async () => {
    const res = await request(app)
      .post(`/api/admin/quantity-imports/${importId}/expand-preview`).set(auth(token))
      .send({ block_key: 'A', numbering: { mode: 'RANGE', start: 1, end: 213 } });
    expect(res.status).toBe(200);
    expect(res.body.generated_count).toBe(213);
    expect(res.body.pattern_size).toBe(29);
    expect(res.body.approval_required).toBe(true);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('GENERATED_QUANTITY');
  });

  it('현장관리자는 수량산출서를 가져올 수 없다', async () => {
    // 역할 게이트가 multer 보다 먼저 걸리므로 파일을 붙이지 않고 확인한다.
    // (붙이면 서버가 본문을 읽기 전에 403 을 내보내 EPIPE 가 난다 — 정상 동작)
    const fieldToken = await login('field01');
    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/quantity-imports`).set(auth(fieldToken));
    expect(res.status).toBe(403);
  });

  it('xlsx 가 아닌 파일은 거부한다', async () => {
    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/quantity-imports`).set(auth(token))
      .attach('file', Buffer.from('not excel'), 'notes.txt');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_FILE');
  });
});
