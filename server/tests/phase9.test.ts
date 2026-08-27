/**
 * PHASE 9 테스트 — 작업일보 / 천공일지
 * Master Prompt §33, §34, §35, §29, §38, §43, §46
 *
 * §33 "현장관리자가 별도로 작성하지 않는다."
 *   그래서 이 테스트는 '아무것도 더 입력하지 않았는데 문서가 나오는가' 를 본다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let headToken = '';
let fieldToken = '';
let siteId = '';
let fieldUserId = '';

const report = (date: string, token = fieldToken) =>
  request(app).get(`/api/reports/sites/${siteId}/daily-report?date=${date}`).set(auth(token));

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE9_TEST', site_name: 'PHASE9 작업일보 검증현장',
            client_name: '샘플원도급(주)', location: '서울' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 },
           { code: 'G02', name: '풍화암', sort_order: 2 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'R-', start: 1, end: 40, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20', section: 'A구간',
      contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: 'A구간 표준', total_planned_depth: '20',
      layers: [
        { ground_type_code: 'G01', planned_length: '14' },
        { ground_type_code: 'G02', planned_length: '6' },
      ],
    });
  await request(app).post(`/api/admin/sites/${siteId}/default-labor`).set(auth(headToken))
    .send([
      { role_name: '현장관리자', headcount: 1, sort_order: 1 },
      { role_name: '천공기 장비기사', headcount: 1, sort_order: 2 },
    ]);
  await request(app).post(`/api/admin/sites/${siteId}/default-equipment`).set(auth(headToken))
    .send([{ equipment_name: '천공기', charge_type: 'MONTHLY', quantity: 1, sort_order: 1 }]);

  fieldUserId = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUserId });
  fieldToken = await login('field01');

  // 하루치 일일입력. 이것 말고는 아무것도 입력하지 않는다.
  const dw = await request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
    .send({
      work_date: '2026-12-01', from: 'R-001', to: 'R-005',
      depth_same_as_plan: false,
      depth_exceptions: [{ hole_no: 'R-003', actual_depth_total: '22.5' }],
      ready_mix: { quantity_m3: '30', has_delay: true, delay_minutes: 60,
                   delay_reason: '레미콘공장' },
      labor_same_as_default: false,
      labor_changes: [{ role_name: '천공기 장비기사', work_days: '0.5',
                        absence_reason: '오후 장비 점검' }],
      ground_notes: [{ note_type: '지하수', memo: 'R-004 부근 용수',
                       hole_nos: ['R-004'] }],
      submit: true,
    });
  if (dw.status !== 201) throw new Error(`일일입력 실패 ${dw.status}: ${dw.text}`);
});

/* ============================================================ §33 작업일보 */
describe('§33 작업일보는 자동으로 만들어진다', () => {
  it('★ 현장관리자가 따로 쓴 것이 없는데 일보가 나온다', async () => {
    const res = await report('2026-12-01');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.site.site_name).toBe('PHASE9 작업일보 검증현장');
    expect(res.body.site.client_name).toBe('샘플원도급(주)');
  });

  it('§33 항목이 빠짐없이 들어 있다', async () => {
    const res = await report('2026-12-01');
    for (const key of [
      'work_date', 'site', 'sections', 'work_summary', 'hole_numbers',
      'today', 'cumulative', 'layer_summary', 'ready_mix', 'labor', 'equipment',
      'special_notes', 'next_day_plan', 'today_man_days', 'cumulative_man_days',
    ]) expect(res.body).toHaveProperty(key);
  });

  it('금일 천공번호가 도면 순서대로 나온다', async () => {
    const res = await report('2026-12-01');
    expect(res.body.hole_numbers.map((h: { hole_no: string }) => h.hole_no))
      .toEqual(['R-001', 'R-002', 'R-003', 'R-004', 'R-005']);
    expect(res.body.sections).toBe('A구간');
  });

  it('★ 금일 천공연장은 실제심도를 쓴다 (계획 20×5=100 이 아니라 102.5)', async () => {
    const res = await report('2026-12-01');
    expect(res.body.today.hole_count).toBe(5);
    expect(res.body.today.length).toBe('102.500');   // 20×4 + 22.5
    const deep = res.body.hole_numbers.find((h: { hole_no: string }) => h.hole_no === 'R-003');
    expect(deep.actual_depth_total).toBe('22.500');
    expect(deep.depth_same_as_plan).toBe(false);
  });

  it('★ 금일 공수와 누계 공수가 함께 나온다 (§33)', async () => {
    const res = await report('2026-12-01');
    // 현장관리자 1.0 + 장비기사 0.5 = 1.5
    expect(res.body.today_man_days).toBe('1.50');
    expect(res.body.cumulative_man_days).toBe('1.50');
    const driver = res.body.labor.find(
      (l: { role_name: string }) => l.role_name === '천공기 장비기사');
    expect(driver.work_days).toBe('0.50');
    expect(driver.absence_reason).toBe('오후 장비 점검');
  });

  it('지층별 계획 천공연장이 나온다 (토사 70, 풍화암 30)', async () => {
    const res = await report('2026-12-01');
    const byType = new Map(res.body.layer_summary.map(
      (l: { ground_type_name: string; planned_length: string }) =>
        [l.ground_type_name, l.planned_length]));
    expect(byType.get('토사')).toBe('70.000');      // 14 × 5
    expect(byType.get('풍화암')).toBe('30.000');    // 6 × 5
  });

  it('레미콘과 지연사유가 그대로 실린다', async () => {
    const res = await report('2026-12-01');
    expect(res.body.ready_mix.quantity_m3).toBe('30.000');
    expect(res.body.ready_mix.delay_minutes).toBe(60);
    expect(res.body.ready_mix.delay_reason).toBe('레미콘공장');
  });

  it('특이사항이 관련 천공번호와 함께 실린다 (§32 준비)', async () => {
    const res = await report('2026-12-01');
    expect(res.body.special_notes).toHaveLength(1);
    expect(res.body.special_notes[0].note_type).toBe('지하수');
    expect(res.body.special_notes[0].memo).toBe('R-004 부근 용수');
  });

  it('익일계획을 안 적으면 다음 미시공 번호를 제안한다 (확정 아님)', async () => {
    const res = await report('2026-12-01');
    expect(res.body.next_day_plan).toBeNull();
    expect(res.body.next_day_suggestion.slice(0, 3)).toEqual(['R-006', 'R-007', 'R-008']);
  });

  it('익일계획을 적으면 그대로 실린다', async () => {
    const put = await request(app)
      .put(`/api/reports/sites/${siteId}/daily-report/next-day-plan`).set(auth(fieldToken))
      .send({ work_date: '2026-12-01', next_day_plan: 'R-006 ~ R-012 천공' });
    expect(put.status).toBe(200);
    const res = await report('2026-12-01');
    expect(res.body.next_day_plan).toBe('R-006 ~ R-012 천공');
  });

  it('작업이 없는 날은 빈 일보를 돌려준다 (오류가 아니다)', async () => {
    const res = await report('2026-12-25');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NONE');
    expect(res.body.hole_numbers).toEqual([]);
    expect(res.body.work_summary).toBe('작업 없음');
    expect(res.body.today.hole_count).toBe(0);
  });

  it('월간 목록으로 훑어볼 수 있다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/daily-reports?from=2026-12-01&to=2026-12-31`)
      .set(auth(headToken));
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].hole_count).toBe(5);
    expect(res.body.reports[0].man_days).toBe('1.50');
    expect(res.body.reports[0].special_note_count).toBe(1);
  });
});

/* ============================================================ §34 천공일지 */
describe('§34 천공일지는 Hole 별로 자동생성된다', () => {
  it('§34 예시 항목이 들어 있다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/R-003/log`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.hole_no).toBe('R-003');
    expect(res.body.hole_type).toBe('H-PILE 구간');
    expect(res.body.design_depth_total).toBe('20.000');
    expect(res.body.actual_depth_total).toBe('22.500');
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.construction_date).toBe('2026-12-01');
  });

  it('★ 계획과 실제의 차이를 숨기지 않는다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/R-003/log`).set(auth(fieldToken));
    expect(res.body.depth_diff).toBe('2.500');
  });

  it('계획 지층이 순서대로 나온다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/R-003/log`).set(auth(fieldToken));
    expect(res.body.planned_layers.map(
      (l: { ground_type_name: string }) => l.ground_type_name)).toEqual(['토사', '풍화암']);
    expect(res.body.planned_layers[0].planned_length).toBe('14.000');
  });

  it('레미콘과 특이사항이 연결된다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/R-004/log`).set(auth(fieldToken));
    expect(res.body.ready_mix.quantity_m3).toBe('30.000');
    expect(res.body.special_notes.map(
      (n: { note_type: string }) => n.note_type)).toContain('지하수');
  });

  it('미시공 천공도 일지가 나온다 (계획만 있는 상태)', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/R-030/log`).set(auth(fieldToken));
    expect(res.body.status).toBe('NOT_STARTED');
    expect(res.body.actual_depth_total).toBeNull();
    expect(res.body.construction_date).toBeNull();
    expect(res.body.planned_layers).toHaveLength(2);
  });

  it('없는 천공번호는 404 다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/R-999/log`).set(auth(fieldToken));
    expect(res.status).toBe(404);
  });

  it('천공번호 형식을 강제하지 않는다 (원문 그대로 찾는다)', async () => {
    await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
      .send({ spec: { mode: 'LIST', numbers: ['1-1', '1-2'] },
              hole_type_code: 'HPILE', design_depth_total: '15' });
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/1-1/log`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.hole_no).toBe('1-1');
  });
});

/* ==================================== §35 작업도면 = 천공일지 = 수량산출 */
describe('§35 세 가지가 항상 일치한다', () => {
  it('★ 서로 다른 경로로 센 완료 공수가 같다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/progress-consistency`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.sources.map((s: { source: string }) => s.source))
      .toEqual(['작업도면', '천공일지', '수량산출실적']);
    const counts = new Set(res.body.sources.map((s: { hole_count: number }) => s.hole_count));
    expect(counts).toEqual(new Set([5]));
    expect(res.body.consistent).toBe(true);
  });

  it('연장도 같다 (102.5m)', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/progress-consistency`).set(auth(fieldToken));
    for (const s of res.body.sources) expect(Number(s.length)).toBe(102.5);
  });

  it('★ 어긋나면 ERROR 로 잡아낸다 (음성 검증)', async () => {
    // HOLE_MASTER 만 몰래 완료로 바꾼다. 일일작업에는 기록이 없다.
    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET status='COMPLETED', construction_date='2026-12-02'
          WHERE site_id=$1 AND hole_no='R-010'`, [siteId]);
    });
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/progress-consistency`).set(auth(headToken));
    expect(res.body.consistent).toBe(false);
    expect(res.body.issues[0].code).toBe('PROGRESS_MISMATCH');
    expect(res.body.issues[0].severity).toBe('ERROR');

    const v = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    expect(v.body.issues.map((i: { code: string }) => i.code)).toContain('PROGRESS_MISMATCH');

    // 되돌린다
    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET status='NOT_STARTED', construction_date=NULL
          WHERE site_id=$1 AND hole_no='R-010'`, [siteId]);
    });
  });

  it('되돌리면 다시 일치한다', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/progress-consistency`).set(auth(fieldToken));
    expect(res.body.consistent).toBe(true);
  });
});

/* ============================================================ §29 */
describe('§29 작업일보·천공일지에는 금액이 없다', () => {
  it('★ 응답 어디에도 금액을 뜻하는 키가 없다', async () => {
    const responses = await Promise.all([
      report('2026-12-01'),
      request(app).get(`/api/reports/sites/${siteId}/holes/R-003/log`).set(auth(fieldToken)),
      request(app).get(`/api/reports/sites/${siteId}/daily-reports`).set(auth(fieldToken)),
    ]);
    for (const res of responses) {
      const keys = new Set<string>();
      JSON.stringify(res.body, (k, v) => { keys.add(k); return v; });
      for (const k of keys) expect(k).not.toMatch(/(^|_)(amount|rate|price|cost|단가|원가)(_|$)/);
    }
  });

  it('★ 본사가 원가를 계산해 넣어도 일보에는 나오지 않는다', async () => {
    await request(app).post('/api/admin/cost/labor-rates').set(auth(headToken))
      .send({ role_name: '현장관리자', pay_type: 'DAILY', rate: '424242',
              effective_from: '2026-01-01' });
    await request(app).post(`/api/admin/cost/sites/${siteId}/calculate-month`)
      .set(auth(headToken)).send({ year_month: '2026-12' });

    for (const token of [fieldToken, headToken]) {
      const res = await report('2026-12-01', token);
      expect(JSON.stringify(res.body)).not.toContain('424242');
    }
  });

  it('★ 일보 함수 자체가 private_cost 에 의존하지 않는다 (pg_depend)', async () => {
    const deps = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT DISTINCT p.proname
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'core'
            AND p.proname IN ('fn_daily_report','fn_hole_log','fn_progress_consistency')
            AND p.prosrc ~* 'private_cost'`);
      return r.rows.map((x: { proname: string }) => x.proname);
    });
    expect(deps).toEqual([]);
  });

  it('계약상대방은 일보 함수를 실행할 수 없다', async () => {
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query(`SELECT core.fn_daily_report(
          '00000000-0000-0000-0000-000000000000'::uuid, CURRENT_DATE)`);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('배정되지 않은 현장의 일보는 볼 수 없다', async () => {
    const other = await request(app).post('/api/admin/sites').set(auth(headToken))
      .send({ site_code: 'PHASE9_OTHER', site_name: '배정 안 된 현장' });
    const res = await request(app)
      .get(`/api/reports/sites/${other.body.site.id}/daily-report?date=2026-12-01`)
      .set(auth(fieldToken));
    expect(res.status).toBe(403);
  });
});
