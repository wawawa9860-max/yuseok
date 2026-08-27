/**
 * 출력일보 / 장비가동일보 (공수) + 월 정산방식
 * Master Prompt §21, §22, §25, §26, §29, §43, §46
 *
 * 사용자 확인사항 (2026-08-27)
 *   · 노무비·장비대는 월급/월대인 경우도 있고 일자로 계산하는 경우도 있다.
 *     불가항력이나 변수가 생기면 일자로 계산해 마무리한다.
 *   · 현금으로 지급하지 않아도 출력일보·장비가동일보에 따라 1일 또는 0.5일이
 *     입력되어야 하고, 그에 따라 투입비를 통상적으로 계산한다.
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

const day = (d: string, from: string, to: string, extra: object = {}) =>
  request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
    .send({ work_date: d, from, to, submit: true, ...extra });

const calcMonth = (ym: string) =>
  request(app).post(`/api/admin/cost/sites/${siteId}/calculate-month`)
    .set(auth(headToken)).send({ year_month: ym });

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'WORKDAY_TEST', site_name: '공수·정산 검증현장' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'W-', start: 1, end: 200, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20',
      contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: '표준', total_planned_depth: '20',
      layers: [{ ground_type_code: 'G01', planned_length: '20' }],
    });
  // 월 기준일수를 25일로 둔다 (회사마다 다르므로 현장 파라미터다)
  await request(app).post(`/api/admin/sites/${siteId}/design-params`).set(auth(headToken))
    .send([{ param_code: 'MONTHLY_WORK_DAYS', param_name: '월 가동일수',
             param_value: 25, unit: '일' }]);

  await request(app).post(`/api/admin/sites/${siteId}/default-labor`).set(auth(headToken))
    .send([
      { role_name: '천공기 장비기사', headcount: 1, sort_order: 1 },
      { role_name: '천공기 작업반장', headcount: 1, sort_order: 2 },
    ]);
  await request(app).post(`/api/admin/sites/${siteId}/default-equipment`).set(auth(headToken))
    .send([
      { equipment_name: '천공기', charge_type: 'MONTHLY', quantity: 1, sort_order: 1 },
      { equipment_name: '펌프카', charge_type: 'DAILY', quantity: 1, sort_order: 2 },
    ]);

  fieldUserId = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUserId });
  fieldToken = await login('field01');
});

/* ================================================ 출력일보 — 1일 / 0.5일 */
describe('§25 출력일보 공수', () => {
  it('아무것도 안 적으면 공수는 1일이다 (§1-6 예외만 입력)', async () => {
    const res = await day('2026-11-02', 'W-001', 'W-005');
    expect(res.status).toBe(201);
    const byRole = new Map(res.body.labor.map(
      (l: { role_name: string; man_days: string }) => [l.role_name, l.man_days]));
    expect(byRole.get('천공기 장비기사')).toBe('1.00');
    expect(byRole.get('천공기 작업반장')).toBe('1.00');
  });

  it('★ 반일만 나온 사람은 0.5일로 남는다', async () => {
    const res = await day('2026-11-03', 'W-006', 'W-008', {
      labor_same_as_default: false,
      labor_changes: [{ role_name: '천공기 작업반장', work_days: '0.5',
                        absence_reason: '오전 반차' }],
    });
    expect(res.status).toBe(201);
    const byRole = new Map(res.body.labor.map(
      (l: { role_name: string; headcount: string; work_days: string; man_days: string }) =>
        [l.role_name, l]));
    const boss = byRole.get('천공기 작업반장') as { headcount: string; man_days: string };
    expect(boss.headcount).toBe('1.00');   // 인원은 그대로
    expect(boss.man_days).toBe('0.50');    // 공수만 반일
    // 손대지 않은 사람은 그대로 1일
    expect((byRole.get('천공기 장비기사') as { man_days: string }).man_days).toBe('1.00');
  });

  it('인원만 바꾸는 날도 공수는 기본 1일을 지킨다', async () => {
    const res = await day('2026-11-04', 'W-009', 'W-010', {
      labor_same_as_default: false,
      labor_changes: [{ role_name: '천공기 장비기사', headcount: '2' }],
    });
    const driver = res.body.labor.find(
      (l: { role_name: string }) => l.role_name === '천공기 장비기사');
    expect(driver.headcount).toBe('2.00');
    expect(driver.work_days).toBe('1.00');
    expect(driver.man_days).toBe('2.00');   // 2명 × 1일
  });

  it('미출력(0일)은 공수 0으로 남고 원가에서 빠진다', async () => {
    const res = await day('2026-11-05', 'W-011', 'W-012', {
      labor_same_as_default: false,
      labor_changes: [{ role_name: '천공기 작업반장', work_days: '0',
                        absence_reason: '개인사정' }],
    });
    const boss = res.body.labor.find(
      (l: { role_name: string }) => l.role_name === '천공기 작업반장');
    expect(boss.man_days).toBe('0.00');
    expect(boss.absence_reason).toBe('개인사정');
  });

  it('공수 범위를 벗어나면 DB 가 막는다 (음성 검증)', async () => {
    await expect(
      withSession(HO, async (c) => {
        const w = await c.query(
          `SELECT id FROM core.daily_work WHERE site_id=$1 AND work_date='2026-11-02'`, [siteId]);
        await c.query(
          `INSERT INTO core.daily_labor (daily_work_id, role_name, headcount, work_days)
           VALUES ($1,'테스트',1,5)`, [w.rows[0].id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/* ================================================ 장비가동일보 */
describe('§26 장비가동일보', () => {
  it('★ 대기·기상·불가항력으로 미가동인 날을 사유와 함께 남긴다', async () => {
    const res = await day('2026-11-06', 'W-013', 'W-014', {
      equipment_same_as_default: false,
      equipment_changes: [{ equipment_name: '펌프카', operating_days: '0',
                            idle_reason: '우천 대기' }],
    });
    expect(res.status).toBe(201);
    const pump = res.body.equipment.find(
      (e: { equipment_name: string }) => e.equipment_name === '펌프카');
    expect(pump.quantity).toBe('1.00');       // 장비는 현장에 있다
    expect(pump.operating_days).toBe('0.00'); // 가동만 안 했다
    expect(pump.unit_days).toBe('0.00');
    expect(pump.idle_reason).toBe('우천 대기');
  });

  it('반일 가동도 남는다', async () => {
    const res = await day('2026-11-09', 'W-015', 'W-016', {
      equipment_same_as_default: false,
      equipment_changes: [{ equipment_name: '펌프카', operating_days: '0.5',
                            idle_reason: '오후 장비 이동' }],
    });
    const pump = res.body.equipment.find(
      (e: { equipment_name: string }) => e.equipment_name === '펌프카');
    expect(pump.unit_days).toBe('0.50');
  });
});

/* ================================================ 일보 조회 (금액 없음) */
describe('출력일보 · 장비가동일보 조회', () => {
  it('직종별 공수 합계가 나온다', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/labor-log?from=2026-11-01&to=2026-11-30`)
      .set(auth(fieldToken));
    expect(res.status).toBe(200);
    const byRole = new Map(res.body.by_role.map(
      (r: { role_name: string; man_days: string }) => [r.role_name, r.man_days]));
    // 장비기사: 11/02 1 + 11/03 1 + 11/04 2 + 11/05 1 + 11/06 1 + 11/09 1 = 7
    expect(byRole.get('천공기 장비기사')).toBe('7.00');
    // 작업반장: 1 + 0.5 + 1 + 0 + 1 + 1 = 4.5
    expect(byRole.get('천공기 작업반장')).toBe('4.50');
  });

  it('★ 일보에 금액이 하나도 없다 (§29)', async () => {
    const [labor, equip] = await Promise.all([
      request(app).get(`/api/field/sites/${siteId}/labor-log?from=2026-11-01&to=2026-11-30`)
        .set(auth(fieldToken)),
      request(app).get(`/api/field/sites/${siteId}/equipment-log?from=2026-11-01&to=2026-11-30`)
        .set(auth(fieldToken)),
    ]);
    for (const res of [labor, equip]) {
      const keys = new Set<string>();
      JSON.stringify(res.body, (k, v) => { keys.add(k); return v; });
      for (const k of keys) expect(k).not.toMatch(/(^|_)(amount|rate|price|cost|단가)(_|$)/);
    }
  });

  it('장비별 가동일수와 미가동 일수가 나온다', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/equipment-log?from=2026-11-01&to=2026-11-30`)
      .set(auth(fieldToken));
    const pump = res.body.by_equipment.find(
      (e: { equipment_name: string }) => e.equipment_name === '펌프카');
    expect(pump.idle_day_count).toBe(1);          // 11/06 우천 대기
    // 11/02~11/05 각 1일 + 11/06 미가동 0 + 11/09 반일 0.5 = 4.5
    expect(pump.unit_days).toBe('4.50');
  });
});

/* ================================================ §25 일당제 / 월급제 */
describe('§25 노무비 — 일당제와 월급제', () => {
  it('일당제는 공수 × 일당이다', async () => {
    await request(app).post('/api/admin/cost/labor-rates').set(auth(headToken)).send([
      { role_name: '천공기 장비기사', pay_type: 'DAILY', rate: '300000',
        effective_from: '2026-01-01' },
      { role_name: '천공기 작업반장', pay_type: 'DAILY', rate: '280000',
        effective_from: '2026-01-01' },
    ]);
    const res = await calcMonth('2026-11');
    expect(res.status).toBe(201);
    // 장비기사 7공수 × 300,000 = 2,100,000
    // 작업반장 4.5공수 × 280,000 = 1,260,000
    const labor = res.body.calculated.find((c: { cost_type: string }) => c.cost_type === 'C01');
    expect(labor.amount).toBe('3360000.00');
  });

  it('★ 반일은 반값으로 계산된다 (0.5공수 × 280,000 = 140,000)', async () => {
    const res = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-preview?year_month=2026-11`)
      .set(auth(headToken));
    const halfDay = res.body.labor.find(
      (l: { work_date: string; role_name: string }) =>
        l.work_date.startsWith('2026-11-03') && l.role_name === '천공기 작업반장');
    expect(halfDay.work_days).toBe('0.50');
    expect(halfDay.amount).toBe('140000.00');
  });

  it('미출력한 날은 아예 나오지 않는다', async () => {
    const res = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-preview?year_month=2026-11`)
      .set(auth(headToken));
    const absent = res.body.labor.filter(
      (l: { work_date: string; role_name: string }) =>
        l.work_date.startsWith('2026-11-05') && l.role_name === '천공기 작업반장');
    expect(absent).toHaveLength(0);
  });

  it('★ 월급제는 월액을 월 기준일수로 나눠 공수만큼 계산한다', async () => {
    await request(app).post('/api/admin/cost/labor-rates').set(auth(headToken))
      .send({ role_name: '천공기 작업반장', pay_type: 'MONTHLY', rate: '7000000',
              effective_from: '2026-01-01' });
    const res = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-preview?year_month=2026-11`)
      .set(auth(headToken));
    // 월액 7,000,000 ÷ 기준 25일 = 280,000/공수. 반일이면 140,000
    const full = res.body.labor.find(
      (l: { work_date: string; role_name: string }) =>
        l.work_date.startsWith('2026-11-02') && l.role_name === '천공기 작업반장');
    expect(full.pay_type).toBe('MONTHLY');
    expect(full.method).toBe('PRORATED');
    expect(full.amount).toBe('280000.00');
  });
});

/* ================================================ §26 월 정산방식 */
describe('§26 불가항력이면 일자로 계산해 마무리한다', () => {
  it('월대 기본은 일할이다 (가동일수 × 월액 ÷ 기준일수)', async () => {
    await request(app).post('/api/admin/cost/equipment-rates').set(auth(headToken)).send([
      { equipment_name: '천공기', charge_type: 'MONTHLY', rate: '15000000',
        effective_from: '2026-01-01' },
      { equipment_name: '펌프카', charge_type: 'DAILY', rate: '900000',
        effective_from: '2026-01-01' },
    ]);
    const res = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-preview?year_month=2026-11`)
      .set(auth(headToken));
    const drill = res.body.equipment.find(
      (e: { work_date: string; equipment_name: string }) =>
        e.work_date.startsWith('2026-11-02') && e.equipment_name === '천공기');
    expect(drill.method).toBe('PRORATED');
    expect(drill.amount).toBe('600000.00');   // 15,000,000 ÷ 25
  });

  it('★ 월액 전액으로 마감하면 그 달 합계가 월액과 정확히 같다', async () => {
    const res = await request(app).put(`/api/admin/cost/sites/${siteId}/settlement`)
      .set(auth(headToken)).send({
        target_kind: 'EQUIPMENT', target_name: '천공기', year_month: '2026-11',
        method: 'FIXED', reason: '월대 계약분 전액 마감',
      });
    expect(res.status).toBe(200);
    expect(res.body.recalculated_months).toEqual(['2026-11']);

    const preview = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-preview?year_month=2026-11`)
      .set(auth(headToken));
    const drill = preview.body.equipment.filter(
      (e: { equipment_name: string }) => e.equipment_name === '천공기');
    const sum = drill.reduce((a: number, e: { amount: string }) => a + Number(e.amount), 0);
    // 반올림 잔액이 남으면 안 된다. 1원도 어긋나지 않아야 한다.
    expect(sum).toBe(15000000);
    expect(drill.every((e: { method: string }) => e.method === 'FIXED')).toBe(true);
  });

  it('★ 일할로 되돌리면 금액이 다시 바뀐다', async () => {
    await request(app).put(`/api/admin/cost/sites/${siteId}/settlement`)
      .set(auth(headToken)).send({
        target_kind: 'EQUIPMENT', target_name: '천공기', year_month: '2026-11',
        method: 'PRORATED', reason: '불가항력으로 일자 정산',
      });
    const preview = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-preview?year_month=2026-11`)
      .set(auth(headToken));
    const drill = preview.body.equipment.filter(
      (e: { equipment_name: string }) => e.equipment_name === '천공기');
    const sum = drill.reduce((a: number, e: { amount: string }) => a + Number(e.amount), 0);
    // 6일 가동 × 600,000 = 3,600,000 (월액 전액이 아니다)
    expect(sum).toBe(3600000);
  });

  it('정산 근거를 남긴다 (§38)', async () => {
    const row = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT method, reason FROM private_cost.monthly_settlement
          WHERE site_id=$1 AND target_name='천공기'`, [siteId]);
      return r.rows[0];
    });
    expect(row.method).toBe('PRORATED');
    expect(row.reason).toBe('불가항력으로 일자 정산');
  });

  it('다시 계산해도 중복 계상되지 않는다', async () => {
    await calcMonth('2026-11');
    await calcMonth('2026-11');
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT cost_type, count(*)::int AS n FROM private_cost.daily_cost
          WHERE site_id=$1 AND source='CALCULATED'
          GROUP BY cost_type ORDER BY cost_type`, [siteId]);
      return r.rows;
    });
    // 6일 × 2항목. 날짜마다 1건씩이어야 한다.
    expect(rows.map((r: { n: number }) => r.n)).toEqual([6, 6]);
  });
});

/* ================================================ §43 자동검증 */
describe('§43 공수와 실적이 어긋나는 날을 알린다', () => {
  it('천공했는데 아무도 출력하지 않은 날을 알린다', async () => {
    await day('2026-11-10', 'W-020', 'W-022', {
      labor_same_as_default: false,
      labor_changes: [
        { role_name: '천공기 장비기사', work_days: '0', absence_reason: '착오' },
        { role_name: '천공기 작업반장', work_days: '0', absence_reason: '착오' },
      ],
    });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const issue = res.body.issues.find(
      (i: { code: string }) => i.code === 'LABOR_ZERO_WITH_WORK');
    expect(issue).toBeDefined();
    expect(issue.target).toBe('2026-11-10');
    expect(issue.severity).toBe('WARN');   // ERROR 가 아니다
  });

  it('사유 없이 반일로 적힌 장비를 INFO 로 알린다', async () => {
    await day('2026-11-11', 'W-025', 'W-026', {
      equipment_same_as_default: false,
      equipment_changes: [{ equipment_name: '펌프카', operating_days: '0.5' }],
    });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const issue = res.body.issues.find(
      (i: { code: string }) => i.code === 'IDLE_REASON_MISSING');
    expect(issue.severity).toBe('INFO');   // 반일 작업은 정상적으로 생긴다
  });

  it('정상인 날은 알리지 않는다 (오탐 확인)', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const targets = res.body.issues
      .filter((i: { code: string }) => i.code === 'LABOR_ZERO_WITH_WORK')
      .map((i: { target: string }) => i.target);
    expect(targets).not.toContain('2026-11-02');
    expect(targets).toHaveLength(1);
  });
});

/* ================================================ §29 */
describe('§29 정산방식과 단가는 본사만 본다', () => {
  it('현장관리자는 월 정산방식 테이블에 접근할 수 없다', async () => {
    await expect(
      withSession({ userId: fieldUserId, role: 'FIELD_MANAGER' }, async (c) => {
        await c.query('SELECT count(*) FROM private_cost.monthly_settlement');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('계약상대방도 접근할 수 없다', async () => {
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query('SELECT count(*) FROM private_cost.monthly_settlement');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('현장관리자는 월 계산·미리보기·정산방식 API 에 들어갈 수 없다', async () => {
    const calls = [
      request(app).post(`/api/admin/cost/sites/${siteId}/calculate-month`)
        .set(auth(fieldToken)).send({ year_month: '2026-11' }),
      request(app).get(`/api/admin/cost/sites/${siteId}/cost-preview?year_month=2026-11`)
        .set(auth(fieldToken)),
      request(app).put(`/api/admin/cost/sites/${siteId}/settlement`).set(auth(fieldToken))
        .send({ target_kind: 'LABOR', target_name: 'X', year_month: '2026-11',
                method: 'FIXED' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
  });

  it('★ core 의 일보 뷰에는 단가·금액 컬럼이 없다', async () => {
    const cols = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='core' AND table_name IN ('v_labor_log','v_equipment_log')
            AND (column_name ~ '(amount|rate|price|cost)')`);
      return r.rows.map((x: { column_name: string }) => x.column_name);
    });
    expect(cols).toEqual([]);
  });
});
