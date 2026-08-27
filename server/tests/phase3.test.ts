/**
 * PHASE 3 테스트 — GROUND_TYPE / GROUND_PROFILE / 범위 일괄설정
 * Master Prompt §6~§11, §38, §43, §46
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login, siteIdByCode } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let token = '';
let siteId = '';

/** PHASE 3 전용 현장을 하나 만들어 다른 테스트와 간섭하지 않게 한다. */
beforeAll(async () => {
  token = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(token)).send({
    site_code: 'PHASE3_TEST', site_name: 'PHASE3 지반조건 검증현장',
  });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(token))
    .send([{ code: 'PRI', name: 'Primary', sort_order: 1 }]);

  // 도면에 표기된 번호를 그대로 쓰는 방식 (§10 대상 100공)
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(token)).send({
    spec: { mode: 'RANGE', prefix: 'A-', start: 1, end: 100, digits: 3 },
    hole_type_code: 'PRI',
  });
});

/* ================================================ 지층종류 (§7) */
describe('§7 지층종류는 현장이 직접 만든다', () => {
  it('현장별로 지층종류를 등록한다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-types`)
      .set(auth(token)).send([
        { code: 'G01', name: '토사', sort_order: 1 },
        { code: 'G02', name: '풍화암', sort_order: 2 },
        { code: 'G03', name: '연암', sort_order: 3 },
      ]);
    expect(res.status).toBe(201);
    expect(res.body.ground_types).toHaveLength(3);
    expect(res.body.ground_types.every((g: { status: string }) => g.status === 'CONFIRMED')).toBe(true);
  });

  it('계획수량 0인 지층은 PROVISIONAL 로 남긴다 (사용자 지시)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-types`)
      .set(auth(token)).send({
        code: 'G04', name: '경암', sort_order: 4, status: 'PROVISIONAL',
        note: '현장 여건에 따라 출현 가능',
      });
    expect(res.status).toBe(201);
    expect(res.body.ground_types[0].status).toBe('PROVISIONAL');
  });

  it('미확정 지층은 자동검증에 INFO 로 보고된다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    const provisional = res.body.issues.filter(
      (i: { code: string }) => i.code === 'PROVISIONAL_GROUND_TYPE');
    expect(provisional.length).toBeGreaterThan(0);
    expect(provisional[0].severity).toBe('INFO');
    expect(res.body.error_count).toBe(0);   // INFO 는 오류가 아니다
  });

  it('사용 중인 지층종류는 삭제되지 않는다', async () => {
    // 먼저 지반조건에서 사용하게 만든다
    await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
      .set(auth(token)).send({
        from: 'A-001', to: 'A-030',
        profile_name: 'A구간 표준', total_planned_depth: '20',
        layers: [
          { ground_type_code: 'G01', planned_length: '12' },
          { ground_type_code: 'G02', planned_length: '8' },
        ],
      });
    const gt = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT id FROM core.ground_type WHERE site_id=$1 AND code='G01'`, [siteId]);
      return r.rows[0].id as string;
    });
    const res = await request(app).delete(`/api/admin/ground-types/${gt}`).set(auth(token));
    expect(res.status).toBe(409);          // DB 트리거가 막는다
    expect(res.body.error).toBe('IN_USE');
    expect(res.body.message).toMatch(/RETIRED/);   // 대안을 알려준다
  });

  it('현장관리자는 지층종류를 만들 수 없다', async () => {
    const fieldToken = await login('field01');
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-types`)
      .set(auth(fieldToken)).send({ code: 'X', name: 'X' });
    expect(res.status).toBe(403);
  });
});

/* ============================================ §10 범위 일괄적용 */
describe('§10 천공번호 범위별 지반조건 일괄설정', () => {
  it('미리보기가 대상 공수와 지층별 총량을 계산해 보여준다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/preview`)
      .set(auth(token)).send({
        from: 'A-031', to: 'A-065',
        profile_name: 'B구간 표준', total_planned_depth: '21',
        layers: [
          { ground_type_code: 'G01', planned_length: '10' },
          { ground_type_code: 'G02', planned_length: '7' },
          { ground_type_code: 'G03', planned_length: '4' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.hole_count).toBe(35);
    expect(res.body.first).toBe('A-031');
    expect(res.body.last).toBe('A-065');
    expect(res.body.layer_sum).toBe(21);
    expect(res.body.total_planned_length).toBe(735);   // 21m × 35공
    expect(res.body.layer_totals).toEqual([
      { ground_type_code: 'G01', per_hole: 10, total: 350 },
      { ground_type_code: 'G02', per_hole: 7,  total: 245 },
      { ground_type_code: 'G03', per_hole: 4,  total: 140 },
    ]);
    expect(res.body.can_save).toBe(true);
  });

  it('미리보기는 저장하지 않는다', async () => {
    const holes = await request(app)
      .get(`/api/sites/${siteId}/holes?from=A-031&to=A-031`).set(auth(token));
    expect(holes.body.holes[0].ground_profile_id).toBeNull();
  });

  it('§8 지층합계가 총심도와 다르면 미리보기가 저장을 막는다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/preview`)
      .set(auth(token)).send({
        from: 'A-031', to: 'A-065',
        profile_name: '불일치', total_planned_depth: '21',
        layers: [
          { ground_type_code: 'G01', planned_length: '10' },
          { ground_type_code: 'G02', planned_length: '7' },
        ],
      });
    expect(res.body.can_save).toBe(false);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('LAYER_SUM_MISMATCH');
  });

  it('불일치 상태로 저장을 시도하면 거부한다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
      .set(auth(token)).send({
        from: 'A-031', to: 'A-065',
        profile_name: '불일치', total_planned_depth: '21',
        layers: [{ ground_type_code: 'G01', planned_length: '10' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LAYER_SUM_MISMATCH');
  });

  it('범위 적용이 35공에 한 번에 반영된다 (§10 예시 그대로)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
      .set(auth(token)).send({
        from: 'A-031', to: 'A-065',
        profile_name: 'B구간 표준', total_planned_depth: '21',
        source: 'QUANTITY_SHEET', source_reference: '수량산출서 p.12',
        layers: [
          { ground_type_code: 'G01', planned_length: '10' },
          { ground_type_code: 'G02', planned_length: '7' },
          { ground_type_code: 'G03', planned_length: '4' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.assigned_holes).toBe(35);

    // 계획심도도 함께 맞춰진다
    const holes = await request(app)
      .get(`/api/sites/${siteId}/holes?from=A-031&to=A-065`).set(auth(token));
    expect(holes.body.count).toBe(35);
    expect(holes.body.holes.every(
      (h: { design_depth_total: string }) => h.design_depth_total === '21.000')).toBe(true);
  });

  it('§19 제외번호를 지정할 수 있다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/preview`)
      .set(auth(token)).send({
        from: 'A-066', to: 'A-080', exclude: ['A-070', 'A-071'],
        profile_name: 'C구간', total_planned_depth: '18',
        layers: [{ ground_type_code: 'G01', planned_length: '18' }],
      });
    expect(res.body.hole_count).toBe(13);
    expect(res.body.hole_numbers).not.toContain('A-070');
    expect(res.body.hole_numbers).not.toContain('A-071');
  });

  it('기존 지반조건이 있으면 덮어쓰기 경고를 낸다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/preview`)
      .set(auth(token)).send({
        from: 'A-031', to: 'A-035',
        profile_name: 'B구간 재적용', total_planned_depth: '22',
        layers: [
          { ground_type_code: 'G01', planned_length: '11' },
          { ground_type_code: 'G02', planned_length: '11' },
        ],
      });
    expect(res.body.already_assigned).toHaveLength(5);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('WILL_OVERWRITE');
    expect(res.body.can_save).toBe(true);   // 경고일 뿐 차단하지 않는다
  });

  it('§38 덮어쓸 때 기존 값이 Revision 으로 보존된다', async () => {
    const before = await request(app)
      .get(`/api/sites/${siteId}/holes?from=A-031&to=A-031`).set(auth(token));
    const holeId = before.body.holes[0].id;
    const beforeDepth = before.body.holes[0].design_depth_total;

    await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
      .set(auth(token)).send({
        from: 'A-031', to: 'A-035',
        profile_name: 'B구간 재적용', total_planned_depth: '22',
        layers: [
          { ground_type_code: 'G01', planned_length: '11' },
          { ground_type_code: 'G02', planned_length: '11' },
        ],
        reason: '지반조사 재실시',
      });

    const rev = await request(app).get(`/api/admin/holes/${holeId}/revisions`).set(auth(token));
    const latest = rev.body.revisions[rev.body.revisions.length - 1];
    expect(latest.revision_type).toBe('DESIGN_CHANGE');
    expect(latest.reason).toBe('지반조사 재실시');
    expect(latest.design_depth_total).toBe(beforeDepth);   // 변경 "전" 값
  });
});

/* ============================================ §11 총연장 → 공당 환산 */
describe('§11 수량산출서 총연장을 공당으로 환산', () => {
  it('나누어떨어지는 경우 (§11 예시: 30공 토사 360m, 풍화암 240m)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/convert`)
      .set(auth(token)).send({
        from: 'A-001', to: 'A-030',
        totals: [
          { ground_type_code: 'G01', total_length: '360' },
          { ground_type_code: 'G02', total_length: '240' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.hole_count).toBe(30);
    expect(res.body.layers).toEqual([
      { ground_type_code: 'G01', total_length: 360, per_hole: 12, recomposed_total: 360, remainder: 0 },
      { ground_type_code: 'G02', total_length: 240, per_hole: 8,  recomposed_total: 240, remainder: 0 },
    ]);
    expect(res.body.suggested_total_planned_depth).toBe(20);
    expect(res.body.confirmation_required).toBe(true);   // §11: 사용자 확인 필수
  });

  it('환산만으로는 저장되지 않는다', async () => {
    const holes = await request(app)
      .get(`/api/sites/${siteId}/holes?from=A-001&to=A-001`).set(auth(token));
    // A-001 은 앞선 테스트에서 'A구간 표준'(20m)이 적용된 상태 그대로여야 한다
    expect(holes.body.holes[0].design_depth_total).toBe('20.000');
  });

  it('나누어떨어지지 않으면 경고하고 잔여를 알려준다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/convert`)
      .set(auth(token)).send({
        from: 'A-001', to: 'A-030',
        totals: [{ ground_type_code: 'G01', total_length: '365' }],
      });
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('NOT_DIVIDED_EVENLY');
    expect(res.body.layers[0].per_hole).toBe(12.167);
    expect(Math.abs(res.body.layers[0].remainder)).toBeGreaterThan(0);
  });

  it('범위에 천공번호가 없으면 저장 불가로 표시한다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/convert`)
      .set(auth(token)).send({
        from: 'Z-001', to: 'Z-999',
        totals: [{ ground_type_code: 'G01', total_length: '100' }],
      });
    expect(res.body.hole_count).toBe(0);
    expect(res.body.can_save).toBe(false);
  });
});

/* ==================================== §11 후단 공별 원본값 */
describe('§11 공별로 값이 다르면 원본값을 그대로 적용한다', () => {
  it('미리보기가 조합 개수와 지층별 총량을 알려준다', async () => {
    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/ground-assignments/per-hole/preview`)
      .set(auth(token)).send({
        rows: [
          { hole_no: 'A-081', layers: [{ ground_type_code: 'G01', planned_length: '14.6' }, { ground_type_code: 'G02', planned_length: '2.4' }] },
          { hole_no: 'A-082', layers: [{ ground_type_code: 'G01', planned_length: '14.6' }, { ground_type_code: 'G02', planned_length: '2.4' }] },
          { hole_no: 'A-083', layers: [{ ground_type_code: 'G01', planned_length: '14.63' }, { ground_type_code: 'G02', planned_length: '2.37' }] },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.row_count).toBe(3);
    expect(res.body.distinct_profiles).toBe(2);   // 같은 조합은 공유
    expect(res.body.grand_total).toBe(51);
    expect(res.body.can_save).toBe(true);
  });

  it('지층합계가 총심도와 다른 행을 짚어준다', async () => {
    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/ground-assignments/per-hole/preview`)
      .set(auth(token)).send({
        rows: [{
          hole_no: 'A-081', total_planned_depth: '20',
          layers: [{ ground_type_code: 'G01', planned_length: '14.6' }],
        }],
      });
    expect(res.body.can_save).toBe(false);
    const issue = res.body.issues.find((i: { code: string }) => i.code === 'LAYER_SUM_MISMATCH');
    expect(issue.target).toBe('A-081');
  });

  it('없는 천공번호를 짚어준다', async () => {
    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/ground-assignments/per-hole/preview`)
      .set(auth(token)).send({
        rows: [{ hole_no: 'ZZZ-999', layers: [{ ground_type_code: 'G01', planned_length: '10' }] }],
      });
    expect(res.body.can_save).toBe(false);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('HOLE_NOT_FOUND');
  });

  it('적용하면 같은 조합끼리 지반조건을 공유한다', async () => {
    const res = await request(app)
      .post(`/api/admin/sites/${siteId}/ground-assignments/per-hole/apply`)
      .set(auth(token)).send({
        source_reference: '천공조서 공당값',
        rows: [
          { hole_no: 'A-081', layers: [{ ground_type_code: 'G01', planned_length: '14.6' }, { ground_type_code: 'G02', planned_length: '2.4' }] },
          { hole_no: 'A-082', layers: [{ ground_type_code: 'G01', planned_length: '14.6' }, { ground_type_code: 'G02', planned_length: '2.4' }] },
          { hole_no: 'A-083', layers: [{ ground_type_code: 'G01', planned_length: '14.63' }, { ground_type_code: 'G02', planned_length: '2.37' }] },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.assigned_holes).toBe(3);
    expect(res.body.created_profiles).toBe(2);   // 3공이지만 조합은 2종

    const holes = await request(app)
      .get(`/api/sites/${siteId}/holes?from=A-081&to=A-083`).set(auth(token));
    const ids = holes.body.holes.map((h: { ground_profile_id: string }) => h.ground_profile_id);
    expect(ids[0]).toBe(ids[1]);      // A-081 과 A-082 는 같은 지반조건
    expect(ids[0]).not.toBe(ids[2]);  // A-083 은 다른 지반조건
    expect(holes.body.holes[2].design_depth_total).toBe('17.000');
  });
});

/* ============================================ §38 지반조건 개정 */
describe('§38 지반조건 개정 (원본 덮어쓰기 금지)', () => {
  it('확정된 지반조건을 개정하면 새 revision 이 생기고 이전 것은 SUPERSEDED', async () => {
    const profileId = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT id FROM core.ground_profile
          WHERE site_id=$1 AND profile_name='A구간 표준' AND status='CONFIRMED'`, [siteId]);
      return r.rows[0].id as string;
    });

    const res = await request(app).post(`/api/admin/ground-profiles/${profileId}/revise`)
      .set(auth(token)).send({
        total_planned_depth: '23',
        layers: [
          { ground_type_code: 'G01', planned_length: '12' },
          { ground_type_code: 'G02', planned_length: '8' },
          { ground_type_code: 'G03', planned_length: '3' },
        ],
        reason: '1차 설계변경 - 연암 출현',
      });
    expect(res.status).toBe(201);
    expect(res.body.ground_profile.revision).toBe(1);
    expect(res.body.ground_profile.status).toBe('CONFIRMED');
    expect(res.body.reassigned_holes).toBeGreaterThan(0);

    const old = await withSession(HO, async (c) => {
      const r = await c.query(
        'SELECT status, superseded_by FROM core.ground_profile WHERE id=$1', [profileId]);
      return r.rows[0];
    });
    expect(old.status).toBe('SUPERSEDED');
    expect(old.superseded_by).toBe(res.body.ground_profile.id);
  });

  it('REV 0 의 지층 구성은 그대로 남아 조회할 수 있다 (§38)', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/ground-profiles`).set(auth(token));
    const revs = res.body.ground_profiles
      .filter((p: { profile_name: string }) => p.profile_name === 'A구간 표준')
      .sort((a: { revision: number }, b: { revision: number }) => a.revision - b.revision);
    expect(revs).toHaveLength(2);
    expect(revs[0].revision).toBe(0);
    expect(revs[0].total_planned_depth).toBe('20.000');
    expect(revs[0].layers).toHaveLength(2);
    expect(revs[1].revision).toBe(1);
    expect(revs[1].total_planned_depth).toBe('23.000');
    expect(revs[1].layers).toHaveLength(3);
  });

  it('개정 시에도 지층합계 = 총심도 가 강제된다', async () => {
    const profileId = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT id FROM core.ground_profile
          WHERE site_id=$1 AND profile_name='B구간 표준' AND status='CONFIRMED'`, [siteId]);
      return r.rows[0].id as string;
    });
    const res = await request(app).post(`/api/admin/ground-profiles/${profileId}/revise`)
      .set(auth(token)).send({
        total_planned_depth: '25',
        layers: [{ ground_type_code: 'G01', planned_length: '10' }],
        reason: '잘못된 개정',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LAYER_SUM_MISMATCH');
  });
});

/* ============================================ 결정론 / 최종 정합성 */
describe('§46 결정론 및 최종 정합성', () => {
  it('같은 범위를 두 번 조회하면 항상 같은 결과', async () => {
    const run = () => request(app)
      .post(`/api/admin/sites/${siteId}/ground-assignments/convert`)
      .set(auth(token)).send({
        from: 'A-001', to: 'A-030',
        totals: [{ ground_type_code: 'G01', total_length: '360' }],
      });
    const a = await run();
    const b = await run();
    expect(a.body.layers).toEqual(b.body.layers);
  });

  it('설정 완료 후 자동검증에 ERROR 가 없다', async () => {
    // 남은 미할당 공에도 지반조건을 넣는다
    await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
      .set(auth(token)).send({
        from: 'A-066', to: 'A-100',
        profile_name: 'C구간 표준', total_planned_depth: '18',
        layers: [{ ground_type_code: 'G01', planned_length: '18' }],
      });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(token));
    expect(res.body.error_count).toBe(0);
    const warns = res.body.issues.filter((i: { code: string }) => i.code === 'HOLE_WITHOUT_PROFILE');
    expect(warns).toHaveLength(0);
  });

  it('현장 최초설정 단계가 완료로 판정된다 (§17)', async () => {
    // 단계 구성은 사용자 확인(2026-08-27)에 따라 '본사 사전 업로드 5종' 기준으로 바뀌었다.
    // 번호가 아니라 이름으로 찾는다. 번호가 또 바뀌어도 테스트가 흔들리지 않는다.
    const res = await request(app).get(`/api/admin/sites/${siteId}/setup-status`).set(auth(token));
    const byName = new Map(res.body.steps.map(
      (s: { step_name: string; done: boolean }) => [s.step_name, s.done]));
    expect(byName.get('지층종류')).toBe(true);
    expect(byName.get('천공번호별 지반조건 · 계획심도')).toBe(true);
  });

  it('★ 현장설정 첫 단계가 본사 사전 업로드 5종이다 (사용자 확인)', async () => {
    const res = await request(app).get(`/api/admin/sites/${siteId}/setup-status`).set(auth(token));
    const names = res.body.steps.map((s: { step_name: string }) => s.step_name);
    expect(names.slice(1, 6)).toEqual([
      '① 계약내역서', '② 천공조서', '③ 수량산출서', '④ 공내역서', '⑤ 작업도면 (평면도 넘버링)',
    ]);
  });
});
