/**
 * PHASE 7 테스트 — 레미콘 / 인원 / 장비 + 오프라인 큐
 * Master Prompt §21, §22, §23, §26, §29, §43, §46
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let headToken = '';
let fieldToken = '';
let siteId = '';

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE7_TEST', site_name: 'PHASE7 레미콘·인원·장비 검증현장' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 }, { code: 'G02', name: '풍화암', sort_order: 2 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'A-', start: 1, end: 100, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20',
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
  // 산출근거와 같은 방식으로 계산하도록 설계 파라미터를 넣는다
  await request(app).post(`/api/admin/sites/${siteId}/design-params`).set(auth(headToken))
    .send([
      { param_code: 'DIAMETER', param_name: '천공 직경', param_value: 0.6, unit: 'm' },
      { param_code: 'CONCRETE_PI', param_name: '산출 π', param_value: 3.14 },
      { param_code: 'CONCRETE_SURCHARGE', param_name: '콘크리트 할증률', param_value: 2, unit: '%' },
    ]);

  const fieldUser = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field02'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUser });
  fieldToken = await login('field02');
});

/* ============================================================ §21 인원 */
describe('§21 인원은 기본설정을 재사용하고 변경만 입력한다', () => {
  it('본사가 기본 인원을 등록한다 (직종은 현장이 정한다)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/default-labor`)
      .set(auth(headToken)).send([
        { role_name: '현장관리자', headcount: 1, sort_order: 1 },
        { role_name: '천공기 장비기사', headcount: 1, sort_order: 2 },
        { role_name: '천공기 작업반장', headcount: 1, sort_order: 3 },
        { role_name: '펌프카 기사', headcount: 1, sort_order: 4 },
      ]);
    expect(res.status).toBe(201);
    expect(res.body.default_labor).toHaveLength(4);
  });

  it('현장관리자는 기본 인원을 등록할 수 없다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/default-labor`)
      .set(auth(fieldToken)).send({ role_name: 'X', headcount: 1 });
    expect(res.status).toBe(403);
  });

  it('일일 화면이 기본 인원·장비를 내려준다 (단가 없음)', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/defaults`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.labor).toHaveLength(4);
    // §29 단가는 어디에도 없다
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/rate|단가|price|amount/i);
  });

  it('[예] 면 변경행이 하나도 생기지 않는다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-01', from: 'A-001', to: 'A-005',
        labor_same_as_default: true, submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.labor).toHaveLength(4);
    expect(res.body.labor.every((l: { is_override: boolean }) => !l.is_override)).toBe(true);

    const n = await withSession(HO, async (c) => {
      const r = await c.query('SELECT count(*)::int AS n FROM core.daily_labor');
      return r.rows[0].n as number;
    });
    expect(n).toBe(0);   // 아무것도 저장하지 않았다
  });

  it('[아니오] 면 바뀐 직종만 저장되고 나머지는 기본값이 유지된다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-02', from: 'A-006', to: 'A-010',
        labor_same_as_default: false,
        labor_changes: [{ role_name: '펌프카 기사', headcount: 0 }],
        submit: true,
      });
    expect(res.status).toBe(201);
    const byRole = new Map(res.body.labor.map(
      (l: { role_name: string; headcount: string }) => [l.role_name, l.headcount]));
    expect(byRole.get('현장관리자')).toBe('1.00');       // 기본 유지
    expect(byRole.get('펌프카 기사')).toBe('0.00');      // 변경 반영
  });

  it('기본에 없던 직종을 그날만 추가할 수 있다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-03', from: 'A-011', to: 'A-012',
        labor_same_as_default: false,
        labor_changes: [{ role_name: '보조원', headcount: 2 }],
        submit: true,
      });
    const names = res.body.labor.map((l: { role_name: string }) => l.role_name);
    expect(names).toContain('보조원');
    expect(names).toContain('현장관리자');
    expect(res.body.labor).toHaveLength(5);
  });
});

/* ============================================================ §22 장비 */
describe('§22 장비는 계약방식과 함께 관리하고 변경만 입력한다', () => {
  it('일대/월대/기타 계약방식을 등록한다 (§26)', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/default-equipment`)
      .set(auth(headToken)).send([
        { equipment_name: '천공기', charge_type: 'MONTHLY', quantity: 1, sort_order: 1 },
        { equipment_name: '펌프카', charge_type: 'DAILY', quantity: 1, sort_order: 2 },
        { equipment_name: '백호(06)', charge_type: 'DAILY', quantity: 1, sort_order: 3 },
      ]);
    expect(res.status).toBe(201);
    const byName = new Map(res.body.default_equipment.map(
      (e: { equipment_name: string; charge_type: string }) => [e.equipment_name, e.charge_type]));
    expect(byName.get('천공기')).toBe('MONTHLY');
    expect(byName.get('펌프카')).toBe('DAILY');
  });

  it('잘못된 계약방식은 거부한다', async () => {
    const res = await request(app).post(`/api/admin/sites/${siteId}/default-equipment`)
      .set(auth(headToken)).send({ equipment_name: 'X', charge_type: '일대' });
    expect(res.status).toBe(400);
  });

  it('[예] 면 기본 장비가 그대로 적용된다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-04', from: 'A-013', to: 'A-015',
        equipment_same_as_default: true, submit: true,
      });
    expect(res.body.equipment).toHaveLength(3);
    expect(res.body.equipment.every((e: { is_override: boolean }) => !e.is_override)).toBe(true);
  });

  it('변경한 장비만 저장된다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-05', from: 'A-016', to: 'A-018',
        equipment_same_as_default: false,
        equipment_changes: [{ equipment_name: '펌프카', quantity: 0 }],
        submit: true,
      });
    const byName = new Map(res.body.equipment.map(
      (e: { equipment_name: string; quantity: string }) => [e.equipment_name, e.quantity]));
    expect(byName.get('천공기')).toBe('1.00');
    expect(byName.get('펌프카')).toBe('0.00');
  });
});

/* ============================================================ §23 레미콘 */
describe('§23 레미콘', () => {
  it('반입량을 저장한다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-06', from: 'A-019', to: 'A-023',
        ready_mix: { quantity_m3: '30.5', has_delay: false },
        submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.ready_mix.quantity_m3).toBe('30.500');
    expect(res.body.ready_mix.has_delay).toBe(false);
  });

  it('공급지연을 시간·사유와 함께 남긴다 (정산증빙 연결 대비)', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-07', from: 'A-024', to: 'A-026',
        ready_mix: {
          quantity_m3: '18', has_delay: true,
          delay_minutes: 60, delay_reason: '레미콘공장',
        },
        submit: true,
      });
    expect(res.body.ready_mix.delay_minutes).toBe(60);
    expect(res.body.ready_mix.delay_reason).toBe('레미콘공장');
  });

  it('지연이 있다면서 시간을 안 주면 거부한다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-08', from: 'A-027', to: 'A-028',
        ready_mix: { quantity_m3: '10', has_delay: true },
        submit: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('DELAY_MINUTES_REQUIRED');
  });

  it('DB도 같은 조건을 강제한다 (음성 검증)', async () => {
    await expect(
      withSession(HO, async (c) => {
        const w = await c.query(
          `SELECT id FROM core.daily_work WHERE site_id=$1 AND work_date='2026-09-06'`, [siteId]);
        await c.query(
          `INSERT INTO core.daily_ready_mix (daily_work_id, quantity_m3, has_delay)
           VALUES ($1, 5, true)`, [w.rows[0].id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('§46 계획 레미콘량을 산출근거와 같은 식으로 계산한다', async () => {
    // (3.14 × 0.6²)/4 × 2052 = 579.8952  →  3자리 579.895
    // 할증 2% = 11.598  →  합계 591.493
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/planned-ready-mix?length=2052`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.base_volume).toBe('579.895');
    expect(res.body.surcharge_volume).toBe('11.598');
    expect(res.body.total_volume).toBe('591.493');
    expect(res.body.pi_value).toBe('3.140000');     // 더 정밀한 π 로 바꾸지 않는다
    expect(res.body.basis).toBe('SITE_DESIGN_PARAM');
  });

  it('산출근거 표기값(591.498)과 0.005㎥ 차이가 나는 이유는 중간 반올림이다', async () => {
    // 산출근거는 기본량을 1자리(579.9)로 반올림한 뒤 할증을 곱한다.
    //   579.9 × 1.02 = 591.498
    // 시스템은 3자리를 유지한다.
    //   579.895 × 1.02 = 591.493
    // 차이 0.005㎥ (0.00085%). 어느 쪽을 쓸지는 사람이 정한다.
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/planned-ready-mix?length=2052`).set(auth(fieldToken));
    const system = Number(res.body.total_volume);
    const sheet = Number((Math.round(579.8952 * 10) / 10 * 1.02).toFixed(3));
    expect(sheet).toBe(591.498);
    expect(Math.abs(sheet - system)).toBeCloseTo(0.005, 3);
    expect(Math.abs(sheet - system) / sheet).toBeLessThan(0.0001);   // 0.01% 미만
  });

  it('직경이 없으면 계산하지 않고 그 사실을 알린다', async () => {
    const other = await request(app).post('/api/admin/sites').set(auth(headToken))
      .send({ site_code: 'PHASE7_NOPARAM', site_name: '파라미터 없는 현장' });
    const res = await request(app)
      .get(`/api/field/sites/${other.body.site.id}/planned-ready-mix?length=100`)
      .set(auth(headToken));
    expect(res.body.basis).toBe('DIAMETER_NOT_SET');
    expect(res.body.total_volume).toBeNull();
  });
});

/* ============================================ 오프라인 큐 재전송 안전장치 */
describe('오프라인 큐 — 같은 요청을 두 번 보내도 한 번만 저장된다', () => {
  it('★ 재전송해도 레미콘·공수가 두 배가 되지 않는다', async () => {
    const reqId = randomUUID();
    const payload = {
      work_date: '2026-09-10', from: 'A-030', to: 'A-034',
      ready_mix: { quantity_m3: '91', has_delay: false },
      submit: true,
    };

    const first = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(payload);
    expect(first.status).toBe(201);
    expect(first.body.today_hole_count).toBe(5);
    expect(first.body.replayed).toBeUndefined();

    // 통신이 끊겨 응답을 못 받았다고 보고 그대로 다시 보낸다
    const second = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(payload);
    expect(second.status).toBe(201);
    expect(second.body.replayed).toBe(true);
    expect(second.body.daily_work_id).toBe(first.body.daily_work_id);

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT r.quantity_m3::text AS qty, count(d.hole_id)::int AS holes
           FROM core.daily_work w
           JOIN core.daily_ready_mix r ON r.daily_work_id = w.id
           LEFT JOIN core.daily_work_hole d ON d.daily_work_id = w.id
          WHERE w.site_id=$1 AND w.work_date='2026-09-10'
          GROUP BY r.quantity_m3`, [siteId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe('91.000');   // 182 가 아니다
    expect(rows[0].holes).toBe(5);        // 10 이 아니다
  });

  it('★ 동시에 도착해도 두 배가 되지 않는다 (온라인 복귀 순간)', async () => {
    const reqId = randomUUID();
    const payload = {
      work_date: '2026-09-21', from: 'A-080', to: 'A-083',
      ready_mix: { quantity_m3: '55', has_delay: false }, submit: true,
    };
    const send = () => request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(payload);

    const res = await Promise.all(Array.from({ length: 6 }, send));
    for (const r of res) expect(r.status).toBe(201);
    expect(new Set(res.map((r) => r.body.daily_work_id)).size).toBe(1);
    expect(res.filter((r) => r.body.replayed).length).toBe(res.length - 1);

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT r.quantity_m3::text AS qty, count(d.hole_id)::int AS holes
           FROM core.daily_work w
           JOIN core.daily_ready_mix r ON r.daily_work_id = w.id
           LEFT JOIN core.daily_work_hole d ON d.daily_work_id = w.id
          WHERE w.site_id=$1 AND w.work_date='2026-09-21'
          GROUP BY r.quantity_m3`, [siteId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe('55.000');
    expect(rows[0].holes).toBe(4);
  });

  it('요청 ID 가 없으면 멱등 처리하지 않는다 (기존 동작 유지)', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-11', from: 'A-035', to: 'A-036', submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBeUndefined();
  });

  it('UUID 가 아닌 요청 ID 는 거부한다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', 'not-a-uuid')
      .send({ work_date: '2026-09-12', from: 'A-037', to: 'A-038' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST_ID');
  });

  it('실패한 요청은 기록되지 않아 다시 시도할 수 있다', async () => {
    const reqId = randomUUID();
    // 지연시간 누락으로 실패시킨다
    const bad = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send({
        work_date: '2026-09-13', from: 'A-040', to: 'A-041',
        ready_mix: { quantity_m3: '10', has_delay: true },
      });
    expect(bad.status).toBe(400);

    // 고쳐서 같은 ID 로 다시 보내면 이번엔 저장돼야 한다
    const good = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send({
        work_date: '2026-09-13', from: 'A-040', to: 'A-041',
        ready_mix: { quantity_m3: '10', has_delay: true, delay_minutes: 30 },
        submit: true,
      });
    expect(good.status).toBe(201);
    expect(good.body.replayed).toBeUndefined();
    expect(good.body.today_hole_count).toBe(2);
  });

  it('다른 사람의 요청 ID 기록은 보이지 않는다 (RLS)', async () => {
    const visible = await withSession({ userId: null, role: 'FIELD_MANAGER' }, async (c) => {
      const r = await c.query('SELECT count(*)::int AS n FROM core.idempotency_key');
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});

/* ============================================================ §43 자동검증 */
describe('§43 레미콘·장비 자동검증', () => {
  it('계획 대비 실제 레미콘 차이가 크면 알린다', async () => {
    // A-050~A-054 (5공 × 20m = 100m) 계획 28.83㎥ 인데 60㎥ 반입
    await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-15', from: 'A-050', to: 'A-054',
        ready_mix: { quantity_m3: '60', has_delay: false }, submit: true,
      });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('READY_MIX_DEVIATION');
  });

  it('계획과 비슷하면 알리지 않는다 (오탐 확인)', async () => {
    // 5공 × 20m = 100m → 계획 (3.14×0.36/4)×100×1.02 = 28.83㎥
    await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-16', from: 'A-060', to: 'A-064',
        ready_mix: { quantity_m3: '29', has_delay: false }, submit: true,
      });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const targets = res.body.issues
      .filter((i: { code: string }) => i.code === 'READY_MIX_DEVIATION')
      .map((i: { target: string }) => i.target);
    expect(targets).not.toContain('2026-09-16');
  });

  it('천공 없이 레미콘만 반입된 날을 알린다', async () => {
    await withSession(HO, async (c) => {
      const w = await c.query(
        `INSERT INTO core.daily_work (site_id, work_date) VALUES ($1,'2026-09-20') RETURNING id`,
        [siteId]);
      await c.query(
        `INSERT INTO core.daily_ready_mix (daily_work_id, quantity_m3) VALUES ($1, 12)`,
        [w.rows[0].id]);
    });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('READY_MIX_WITHOUT_HOLE');
  });
});

/* ============================================================ §29 원가 격리 */
describe('§29 인원·장비를 넣어도 단가는 노출되지 않는다', () => {
  it('현장관리자는 노무·장비 단가 테이블에 접근할 수 없다', async () => {
    for (const table of ['private_cost.labor_rate', 'private_cost.equipment_rate']) {
      await expect(
        withSession({ userId: null, role: 'FIELD_MANAGER' }, async (c) => {
          await c.query(`SELECT count(*) FROM ${table}`);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('기본 인원·장비 테이블에 단가 컬럼이 없다', async () => {
    const cols = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='core'
            AND table_name IN ('site_default_labor','site_default_equipment',
                               'daily_labor','daily_equipment')`);
      return r.rows.map((x: { column_name: string }) => x.column_name);
    });
    expect(cols.filter((c) => /rate|price|amount|cost/i.test(c))).toEqual([]);
  });

  it('share 스키마는 여전히 private_cost 에 의존하지 않는다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query('SELECT * FROM app.fn_share_isolation_violations()');
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});

/* ============================================ 빈 항목 처리 (회귀) */
describe('레미콘을 비우고 저장할 수 있다 (회귀)', () => {
  it('★ ready_mix 없이 저장된다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-25', from: 'A-070', to: 'A-072', submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.ready_mix).toBeNull();
    expect(res.body.today_hole_count).toBe(3);
  });

  it('★ 화면이 빈 값을 null 로 보내도 받아들인다', async () => {
    // 실제로 났던 버그: 레미콘을 비운 채 저장하면 "Expected object, received null"
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-26', from: 'A-073', to: 'A-075',
        ready_mix: null, labor_changes: null, equipment_changes: null,
        depth_exceptions: null, ground_notes: null, submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.today_hole_count).toBe(3);
    expect(res.body.labor.length).toBeGreaterThan(0);   // 기본 인원은 그대로 적용
  });

  it('반입량이 0 이면 0 으로 저장된다 (없음과 구분)', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-09-27', from: 'A-076', to: 'A-077',
        ready_mix: { quantity_m3: '0', has_delay: false }, submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.ready_mix.quantity_m3).toBe('0.000');
  });
});
