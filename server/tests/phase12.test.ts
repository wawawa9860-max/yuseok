/**
 * PHASE 12 테스트 — 본사 대시보드
 * Master Prompt §39, §29, §43, §52
 *
 * §39 현장별 한 줄 + 이상현장 표시.
 * §29 원가 합계가 처음으로 나오는 단계 — 본사 외에는 어떤 경로로도 못 본다.
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
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE12_TEST', site_name: 'PHASE12 대시보드 검증현장' });
  siteId = site.body.site.id;

  const contract = await request(app).post(`/api/sites/${siteId}/contracts`).set(auth(headToken))
    .send({ contract_no: 'D-001', contract_name: 'RF CIP', original_amount: '100000000' });
  await request(app).post(`/api/contracts/${contract.body.contract.id}/items`).set(auth(headToken))
    .send({ items: [{ item_code: 'CIP-600', item_name: 'C.I.P 천공', unit: 'm',
                      quantity: '1000', unit_price: '50000' }] });
  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1,
             contract_item_code: 'CIP-600' }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'D-', start: 1, end: 50, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20',
      contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: '표준', total_planned_depth: '20',
      layers: [{ ground_type_code: 'G01', planned_length: '20' }],
    });
  await request(app).post(`/api/admin/sites/${siteId}/default-labor`).set(auth(headToken))
    .send([{ role_name: '현장관리자', headcount: 1, sort_order: 1 }]);

  fieldUserId = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUserId });
  fieldToken = await login('field01');

  // 오늘 작업 + 레미콘 지연 + 비용 + 검토필요 사건
  await request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
    .send({
      work_date: TODAY, from: 'D-001', to: 'D-010',
      ready_mix: { quantity_m3: '55', has_delay: true, delay_minutes: 45,
                   delay_reason: '레미콘공장' },
      submit: true,
    });
  await request(app).post(`/api/cost/sites/${siteId}/costs`).set(auth(fieldToken))
    .send({ cost_date: TODAY, cost_type: 'C03', amount: '380000', vendor: '주유소' });
  await request(app).post(`/api/events/sites/${siteId}/events`).set(auth(fieldToken))
    .send({ event_type: '지반조건 상이', memo: '전석층', needs_review: true });
});

/* ============================================================ §39 한 줄 */
describe('§39 현장별 한 줄', () => {
  it('★ §39 항목이 한 줄에 다 있다', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(headToken));
    expect(res.status).toBe(200);
    const row = res.body.sites.find(
      (s: { site_code: string }) => s.site_code === 'PHASE12_TEST');
    expect(row).toMatchObject({
      site_name: 'PHASE12 대시보드 검증현장',
      today_holes: 10,                    // 금일 공수
      completed_holes: 10,                // 누계 공수
      total_holes: 50,
      progress_rate: '20.0',              // 공정률
      ready_mix_m3: '55.000',             // 레미콘
      ready_mix_delay: true,
      today_man_days: '1.00',             // 금일 투입 공수
      open_events: 1,                     // 특이사항
      review_events: 1,
    });
    expect(row.evidence).toMatchObject({ total: 1, pending: 1 });   // 비용증빙 상태
  });

  it('★ 이상현장 표시가 붙는다 — 본사는 이것만 클릭하면 된다', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(headToken));
    const row = res.body.sites.find(
      (s: { site_code: string }) => s.site_code === 'PHASE12_TEST');
    expect(row.flags).toContain('검토필요 특이사항');
    expect(row.flags).toContain('증빙대기 1건');
    expect(row.flags).toContain('레미콘 지연');
  });

  it('전 현장이 나온다 (시드 포함)', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(headToken));
    const codes = res.body.sites.map((s: { site_code: string }) => s.site_code);
    expect(codes).toEqual(expect.arrayContaining(
      ['PHASE12_TEST', 'SAMPLE_RFCIP_01', 'TEST_SITE_01']));
  });

  it('한 줄에는 원가가 없다 — 원가는 상세에서만 (§39, §29)', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(headToken));
    const keys = new Set<string>();
    JSON.stringify(res.body, (k, v) => { keys.add(k); return v; });
    for (const k of keys) expect(k).not.toMatch(/(^|_)(cost|rate_amount|단가|원가)(_|$)/);
    expect(JSON.stringify(res.body)).not.toContain('380000');
  });
});

/* ==================================================== 상세 (이상현장 클릭) */
describe('이상현장 클릭 → 상세', () => {
  it('★ 상세에서 처음으로 원가 합계가 나온다 (본사 전용)', async () => {
    const res = await request(app)
      .get(`/api/admin/dashboard/sites/${siteId}`).set(auth(headToken));
    expect(res.status).toBe(200);
    expect(res.body.cost.total).toBe('380000.00');
    const fuel = res.body.cost.by_type.find(
      (t: { cost_type: string }) => t.cost_type === 'C03');
    expect(fuel).toMatchObject({ name_ko: '유류비', amount: '380000.00', count: 1 });
    // 기성(계약금액) 대비 원가를 가늠할 수 있게 인정금액도 나란히
    expect(res.body.cost.earned_amount).toBe('10000000.00');
  });

  it('공정률·검증·특이사항이 함께 나온다', async () => {
    const res = await request(app)
      .get(`/api/admin/dashboard/sites/${siteId}`).set(auth(headToken));
    expect(res.body.progress.quantity.rate).toBe('20.0');
    expect(Array.isArray(res.body.validation)).toBe(true);
    expect(res.body.events.events[0].event_type).toBe('지반조건 상이');
  });
});

/* ============================================================ §29 차단 */
describe('§29 대시보드는 본사 외에 어떤 경로로도 못 본다', () => {
  it('현장관리자는 API 에서 403', async () => {
    for (const path of ['/api/admin/dashboard', `/api/admin/dashboard/sites/${siteId}`]) {
      const res = await request(app).get(path).set(auth(fieldToken));
      expect(res.status).toBe(403);
    }
  });

  it('★ API 를 우회해 DB 함수를 직접 불러도 막힌다', async () => {
    for (const sql of ['SELECT core.fn_dashboard(NULL)',
                       `SELECT core.fn_dashboard_site('${siteId}', NULL)`]) {
      await expect(
        withSession({ userId: fieldUserId, role: 'FIELD_MANAGER' }, async (c) => {
          await c.query(sql);
        }),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
          await c.query(sql);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('상세 함수도 share 격리를 깨지 않았다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query('SELECT * FROM app.fn_share_isolation_violations()');
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});
