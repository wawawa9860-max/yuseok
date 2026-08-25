/**
 * PHASE 2 테스트 — SITE + CONTRACT + HOLE MASTER
 * Master Prompt §10, §14, §17, §19, §38, §46
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login, siteIdByCode } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';
import {
  generateHoleNumbers, naturalSortKey, parseNumberList, sortHoleNumbers,
} from '../src/domain/holeNumbering.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/* ==================================================== 천공번호 생성 로직 */
describe('§10/§19 천공번호 생성 (순수 함수, 결정론)', () => {
  it('LIST: 도면에 표기된 번호를 그대로 쓴다', () => {
    expect(generateHoleNumbers({ mode: 'LIST', numbers: ['1', '1.1', 'A-001', 'C1-10'] }))
      .toEqual(['1', '1.1', 'A-001', 'C1-10']);
  });

  it('LIST: 붙여넣기 문자열을 줄바꿈/쉼표로 분리한다', () => {
    expect(parseNumberList('1, 2\n3\t4;5  ')).toEqual(['1', '2', '3', '4', '5']);
  });

  it('LIST: 중복이 있으면 거부한다 (§14)', () => {
    expect(() => generateHoleNumbers({ mode: 'LIST', numbers: ['1', '2', '1'] }))
      .toThrow(/중복된 번호/);
  });

  it('RANGE: 접두어 + 자릿수 + 제외번호 (§19)', () => {
    const out = generateHoleNumbers({
      mode: 'RANGE', prefix: 'A-', start: 31, end: 44, digits: 3, exclude: [37],
    });
    expect(out).toHaveLength(13);
    expect(out[0]).toBe('A-031');
    expect(out).not.toContain('A-037');
    expect(out[out.length - 1]).toBe('A-044');
  });

  it('RANGE: 제외번호는 숫자로도 완성형으로도 인식한다', () => {
    const a = generateHoleNumbers({ mode: 'RANGE', prefix: 'A-', start: 1, end: 5, digits: 3, exclude: [3] });
    const b = generateHoleNumbers({ mode: 'RANGE', prefix: 'A-', start: 1, end: 5, digits: 3, exclude: ['A-003'] });
    expect(a).toEqual(b);
  });

  it('RANGE: 자릿수 0 이면 0 채움 없이 그대로 (실제 조서 형식)', () => {
    expect(generateHoleNumbers({ mode: 'RANGE', start: 1, end: 3 })).toEqual(['1', '2', '3']);
  });

  it('종료번호가 시작번호보다 작으면 거부한다', () => {
    expect(() => generateHoleNumbers({ mode: 'RANGE', start: 10, end: 5 })).toThrow(/작습니다/);
  });

  it('같은 입력이면 항상 같은 결과 (§46)', () => {
    const spec = { mode: 'RANGE' as const, prefix: 'B-', start: 1, end: 50, digits: 3, exclude: [7, 13] };
    expect(generateHoleNumbers(spec)).toEqual(generateHoleNumbers(spec));
  });
});

describe('자연정렬 — 번호 형식을 강제하지 않는다', () => {
  it('숫자와 소수가 섞여도 사람이 읽는 순서로 정렬된다', () => {
    expect(sortHoleNumbers(['10', '2', '1.1', '1', '1.10', '1.2', '29']))
      .toEqual(['1', '1.1', '1.2', '1.10', '2', '10', '29']);
  });

  it('접두어가 있는 형식도 올바르게 정렬된다', () => {
    expect(sortHoleNumbers(['A-10', 'A-2', 'A-1', 'B-1']))
      .toEqual(['A-1', 'A-2', 'A-10', 'B-1']);
  });

  it('TS 와 DB 의 정렬키가 완전히 같다', async () => {
    const samples = ['1', '1.1', '10', 'A-001', 'C1-10', '무근-3', '2.0'];
    const dbKeys = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT s AS raw, core.fn_natural_sort_key(s) AS k FROM unnest($1::text[]) s`, [samples]);
      return r.rows as { raw: string; k: string }[];
    });
    for (const row of dbKeys) expect(naturalSortKey(row.raw)).toBe(row.k);
  });
});

/* ==================================================== 실제 수량산출서 현장 */
describe('§51 실제 수량산출서 기반 현장 (SAMPLE_RFCIP_01)', () => {
  it('산출근거 집계와 천공조서 명세가 일치한다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT ground_type_name, sum(planned_length)::text AS m
           FROM core.v_hole_layer_plan
          WHERE site_id = (SELECT id FROM core.site WHERE site_code='SAMPLE_RFCIP_01')
          GROUP BY 1 ORDER BY 1`);
      return r.rows;
    });
    // 산출근거 시트: 토사 876.12m / 풍화암 147.30m
    expect(rows).toEqual([
      { ground_type_name: '토사',   m: '876.120' },
      { ground_type_name: '풍화암', m: '147.300' },
    ]);
  });

  it('천공종류별 합계가 조서 합계행과 일치한다 (각 29공 / 511.71m)', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT ht.code, count(*)::int AS n, sum(h.design_depth_total)::text AS m
           FROM core.hole_master h JOIN core.site_hole_type ht ON ht.id = h.hole_type_id
          WHERE h.site_id = (SELECT id FROM core.site WHERE site_code='SAMPLE_RFCIP_01')
          GROUP BY ht.code ORDER BY ht.code`);
      return r.rows;
    });
    expect(rows).toEqual([
      { code: 'HPILE',  n: 29, m: '511.710' },
      { code: 'MUGEUN', n: 29, m: '511.710' },
    ]);
  });

  it('58공 전부 지층합계 = 계획심도 를 만족한다 (§8)', async () => {
    const bad = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT h.hole_no
           FROM core.hole_master h
           JOIN core.ground_profile p ON p.id = h.ground_profile_id
          WHERE h.site_id = (SELECT id FROM core.site WHERE site_code='SAMPLE_RFCIP_01')
            AND abs(core.fn_profile_layer_sum(p.id) - h.design_depth_total) > 0.001`);
      return r.rows;
    });
    expect(bad).toEqual([]);
  });

  it('자동검증에 ERROR 가 없다', async () => {
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'SAMPLE_RFCIP_01');
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    expect(res.body.error_count).toBe(0);
  });

  it('현장 설계 파라미터가 조서 원본값으로 저장되어 있다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT param_code, param_value::text FROM core.site_design_param
          WHERE site_id=(SELECT id FROM core.site WHERE site_code='SAMPLE_RFCIP_01')
            AND param_code IN ('DIAMETER','CTC') ORDER BY param_code`);
      return r.rows;
    });
    expect(rows).toEqual([
      { param_code: 'CTC',      param_value: '0.470000' },
      { param_code: 'DIAMETER', param_value: '0.600000' },
    ]);
  });
});

/* ==================================================== 현장 최초설정 API */
describe('§17 현장 최초설정 STEP 1~5', () => {
  let siteId = '';
  let token = '';

  it('STEP 1 — 현장을 생성한다 (본사 전용)', async () => {
    token = await login('head01');
    const res = await request(app).post('/api/admin/sites').set(auth(token)).send({
      site_code: 'PHASE2_TEST', site_name: 'PHASE2 검증현장',
      client_name: '검증원도급', location: '검증시',
    });
    expect(res.status).toBe(201);
    expect(res.body.site.setup_step).toBe(1);
    siteId = res.body.site.id;
  });

  it('현장관리자는 현장을 생성할 수 없다', async () => {
    const fieldToken = await login('field01');
    const res = await request(app).post('/api/admin/sites').set(auth(fieldToken))
      .send({ site_code: 'X', site_name: 'X' });
    expect(res.status).toBe(403);
  });

  it('STEP 2 — 계약을 등록하면 원계약이 REV 0 으로 자동 보존된다 (§38)', async () => {
    const res = await request(app).post(`/api/sites/${siteId}/contracts`).set(auth(token)).send({
      contract_no: 'PH2-C01', contract_name: 'PHASE2 흙막이 공사',
      counterparty_name: '검증원도급', original_amount: '100000000',
    });
    expect(res.status).toBe(201);
    expect(res.body.contract.current_revision).toBe(0);

    const list = await request(app).get(`/api/sites/${siteId}/contracts`).set(auth(token));
    expect(list.body.contracts[0].revisions).toHaveLength(1);
    expect(list.body.contracts[0].revisions[0].revision_type).toBe('ORIGINAL');
    expect(list.body.contracts[0].revisions[0].is_current).toBe(true);
  });

  it('STEP 5 — 천공종류를 현장별로 등록한다 (§5)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/hole-types`)
      .set(auth(token)).send([
        { code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 },
        { code: 'MUGEUN', name: '무근', sort_order: 2 },
      ]);
    expect(res.status).toBe(201);
    expect(res.body.hole_types).toHaveLength(2);
  });

  it('미리보기는 저장하지 않고 결과만 보여준다 (§12 정신)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/holes/preview`)
      .set(auth(token)).send({
        spec: { mode: 'RANGE', prefix: 'A-', start: 1, end: 30, digits: 3, exclude: [7] },
      });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(29);
    expect(res.body.first).toBe('A-001');
    expect(res.body.last).toBe('A-030');
    expect(res.body.hole_numbers).not.toContain('A-007');
    expect(res.body.can_save).toBe(true);

    const after = await request(app).get(`/api/sites/${siteId}/holes`).set(auth(token));
    expect(after.body.count).toBe(0);   // 미리보기는 저장하지 않는다
  });

  it('일괄생성하면 원계약이 각 공의 REV 0 으로 보존된다 (§38)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`)
      .set(auth(token)).send({
        spec: { mode: 'RANGE', prefix: 'A-', start: 1, end: 30, digits: 3, exclude: [7] },
        hole_type_code: 'HPILE', section: 'A구간',
        design_depth_total: '20', contract_quantity: '20', contract_unit: 'm',
        contract_unit_price: '45000', assign_drawing_sequence: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(29);

    const holeId = res.body.holes[0].id;
    const rev = await request(app).get(`/api/admin/holes/${holeId}/revisions`).set(auth(token));
    expect(rev.body.revisions).toHaveLength(1);
    expect(rev.body.revisions[0].revision_type).toBe('ORIGINAL_CONTRACT');
    expect(rev.body.revisions[0].is_current).toBe(true);
  });

  it('§14 중복 천공번호는 저장 자체를 차단한다', async () => {
    const preview = await request(app).post(`/api/admin/sites/${siteId}/holes/preview`)
      .set(auth(token)).send({
        spec: { mode: 'RANGE', prefix: 'A-', start: 25, end: 35, digits: 3 },
      });
    expect(preview.body.can_save).toBe(false);
    expect(preview.body.conflicts.length).toBeGreaterThan(0);

    const before = await request(app).get(`/api/sites/${siteId}/holes`).set(auth(token));
    const save = await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`)
      .set(auth(token)).send({
        spec: { mode: 'RANGE', prefix: 'A-', start: 25, end: 35, digits: 3 },
      });
    expect(save.status).toBe(409);
    const after = await request(app).get(`/api/sites/${siteId}/holes`).set(auth(token));
    // 하나라도 충돌하면 전부 저장하지 않는다 (부분저장 금지)
    expect(after.body.count).toBe(before.body.count);
  });

  it('등록되지 않은 천공종류를 쓰면 거부한다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`)
      .set(auth(token)).send({
        spec: { mode: 'LIST', numbers: ['Z-001'] }, hole_type_code: 'NOPE',
      });
    expect(res.status).toBe(400);
  });

  it('설정 진행상황이 남은 단계를 알려준다', async () => {
    const res = await request(app).get(`/api/admin/sites/${siteId}/setup-status`).set(auth(token));
    expect(res.status).toBe(200);
    const byStep = new Map(res.body.steps.map((s: { step: number; done: boolean }) => [s.step, s.done]));
    expect(byStep.get(2)).toBe(true);    // 계약 등록됨
    expect(byStep.get(5)).toBe(true);    // 천공번호 생성됨
    expect(byStep.get(7)).toBe(false);   // 지반조건 아직
    expect(res.body.next_step).toBe(3);  // 수량산출서 등록이 다음
  });
});

/* ==================================================== 설계변경 Revision */
describe('§38 설계변경 Revision', () => {
  it('계약 revision 을 추가해도 원계약 금액은 그대로다', async () => {
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'PHASE2_TEST');
    const list = await request(app).get(`/api/sites/${siteId}/contracts`).set(auth(token));
    const contractId = list.body.contracts[0].id;

    const res = await request(app).post(`/api/contracts/${contractId}/revisions`)
      .set(auth(token)).send({
        contract_amount: '120000000', reason: '1차 설계변경 (물량 증가)', activate: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.revision.revision_no).toBe(1);

    const after = await request(app).get(`/api/sites/${siteId}/contracts`).set(auth(token));
    const ct = after.body.contracts[0];
    expect(ct.original_amount).toBe('100000000.00');   // 원계약 불변
    expect(ct.current_amount).toBe('120000000.00');    // 현재 계약금액만 변경
    expect(ct.current_revision).toBe(1);
    expect(ct.revisions).toHaveLength(2);
  });

  it('원계약(REV 0)으로 되돌릴 수 있다', async () => {
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'PHASE2_TEST');
    const list = await request(app).get(`/api/sites/${siteId}/contracts`).set(auth(token));
    const contractId = list.body.contracts[0].id;

    const res = await request(app)
      .post(`/api/contracts/${contractId}/revisions/0/activate`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.contract.current_amount).toBe('100000000.00');
    expect(res.body.contract.current_revision).toBe(0);
  });

  it('천공 계획값을 바꾸려면 변경사유가 필요하다', async () => {
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'PHASE2_TEST');
    const holes = await request(app).get(`/api/sites/${siteId}/holes?limit=1`).set(auth(token));
    const holeId = holes.body.holes[0].id;

    const noReason = await request(app).patch(`/api/admin/holes/${holeId}`)
      .set(auth(token)).send({ design_depth_total: '22' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toBe('REASON_REQUIRED');
  });

  it('계획값을 바꾸면 변경 전 값이 revision 으로 보존된다', async () => {
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'PHASE2_TEST');
    const holes = await request(app).get(`/api/sites/${siteId}/holes?limit=1`).set(auth(token));
    const holeId = holes.body.holes[0].id;
    const before = holes.body.holes[0].design_depth_total;

    const res = await request(app).patch(`/api/admin/holes/${holeId}`).set(auth(token))
      .send({ design_depth_total: '22', revision_reason: '지반조사 결과 심도 증가' });
    expect(res.status).toBe(200);
    expect(res.body.hole.design_depth_total).toBe('22.000');

    const rev = await request(app).get(`/api/admin/holes/${holeId}/revisions`).set(auth(token));
    expect(rev.body.revisions).toHaveLength(2);
    // REV 1 스냅샷은 "변경 전" 값을 담고 있어야 한다
    expect(rev.body.revisions[1].revision_type).toBe('DESIGN_CHANGE');
    expect(rev.body.revisions[1].design_depth_total).toBe(before);
    expect(rev.body.revisions[1].reason).toBe('지반조사 결과 심도 증가');
  });

  it('시공이력이 있는 천공번호는 삭제할 수 없다', async () => {
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'PHASE2_TEST');
    const holes = await request(app).get(`/api/sites/${siteId}/holes?limit=2`).set(auth(token));
    const holeId = holes.body.holes[1].id;

    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET status='COMPLETED', construction_date=CURRENT_DATE,
                actual_depth_total=20 WHERE id=$1`, [holeId]);
    });
    const res = await request(app).delete(`/api/admin/holes/${holeId}`).set(auth(token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('HOLE_NOT_DELETABLE');
  });
});
