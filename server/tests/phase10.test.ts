/**
 * PHASE 10 테스트 — 공정률 / 기성
 * Master Prompt §36, §37, §38, §29, §43, §44, §46
 *
 * §37 "기성가능액 ≠ 실제 제출 기성. 실제 기성 제출은 본사 승인이 필요하다."
 *   → 초안과 확정이 구조적으로 분리돼 있는지, 확정이 그 순간을 얼려 두는지 본다.
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
let contractId = '';
let fieldUserId = '';

const progress = (token = fieldToken) =>
  request(app).get(`/api/progress/sites/${siteId}/progress`).set(auth(token));
const draft = (from: string, to: string, token = headToken) =>
  request(app).get(`/api/progress/sites/${siteId}/payment-draft?from=${from}&to=${to}`)
    .set(auth(token));

/** 완료 처리 — 일일입력을 거쳐야 §35 세 값이 어긋나지 않는다. */
const work = (date: string, from: string, to: string) =>
  request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
    .send({ work_date: date, from, to, submit: true });

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE10_TEST', site_name: 'PHASE10 공정률·기성 검증현장' });
  siteId = site.body.site.id;

  // 본사가 계약내역서를 먼저 올린다. 단가는 여기 있다 (사용자 확인 2026-08-27).
  const contract = await request(app).post(`/api/sites/${siteId}/contracts`).set(auth(headToken))
    .send({
      contract_no: 'C-2027-001', contract_name: 'RF CIP 흙막이 가시설',
      counterparty_name: '샘플원도급(주)', original_amount: '120000000',
    });
  contractId = contract.body.contract.id;
  await request(app).post(`/api/contracts/${contractId}/items`).set(auth(headToken))
    .send({ items: [{ item_code: 'CIP-600', item_name: 'C.I.P 천공 D=600', unit: 'm',
                      quantity: '2000', unit_price: '50000', sort_order: 1 }] });

  // 천공종류를 내역 품목에 건다. 공마다 단가를 붙이지 않는다.
  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1,
             contract_item_code: 'CIP-600' }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 },
           { code: 'G02', name: '풍화암', sort_order: 2 }]);
  // 100공 × 20m. 단가는 내역서(50,000/m)에서 온다 → 공당 1,000,000원
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'P-', start: 1, end: 100, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20',
      contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: '표준', total_planned_depth: '20',
      layers: [{ ground_type_code: 'G01', planned_length: '14' },
               { ground_type_code: 'G02', planned_length: '6' }],
    });

  fieldUserId = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUserId });
  fieldToken = await login('field01');
});

/* ============================================================ §36 공정률 */
describe('§36 공정률', () => {
  it('아무것도 안 했으면 0% 다', async () => {
    const res = await progress();
    expect(res.status).toBe(200);
    expect(res.body.quantity.rate).toBe('0.0');
    expect(res.body.amount.rate).toBe('0.0');
    expect(res.body.hole_count.total).toBe(100);
  });

  it('★ 물량 공정률 = 누적 완료 계약수량 ÷ 전체 계약수량', async () => {
    await work('2027-01-05', 'P-001', 'P-010');    // 10공 × 20m = 200m
    const res = await progress();
    expect(res.body.quantity.total).toBe('2000.000');      // 100공 × 20
    expect(res.body.quantity.completed).toBe('200.000');
    expect(res.body.quantity.rate).toBe('10.0');
    expect(res.body.quantity.basis).toBe('CONTRACT_QUANTITY');
  });

  it('★ 금액 공정률 = 누적 시공 인정금액 ÷ 현재 계약금액', async () => {
    const res = await progress();
    // 10공 × 20m × 50,000(내역서 단가) = 10,000,000
    expect(res.body.amount.earned_amount).toBe('10000000.00');
    expect(res.body.amount.contract_amount).toBe('120000000.00');
    expect(res.body.amount.rate).toBe('8.3');
  });

  it('★ 금액 기준이 무엇인지 숨기지 않는다', async () => {
    const res = await progress();
    expect(res.body.amount.basis).toBe('CONTRACT_AMOUNT');
    expect(res.body.amount.contract_amount).toBe('120000000.00');
    // 10,000,000 / 120,000,000 = 8.3%
    expect(res.body.amount.rate).toBe('8.3');
  });

  it('★ 단가가 계약내역서에서 온다는 사실을 밝힌다 (사용자 확인)', async () => {
    const res = await progress();
    const bySource = new Map(res.body.price_sources.map(
      (s: { source: string; hole_count: number }) => [s.source, s.hole_count]));
    // 공마다 단가를 붙이지 않았는데도 100공 전부 내역서에서 단가를 받았다
    expect(bySource.get('CONTRACT_BOQ')).toBe(100);
    expect(bySource.get('HOLE_OVERRIDE')).toBeUndefined();
  });

  it('★ 설계변경이 나면 새 단가를 자동으로 따라간다 (§38)', async () => {
    const before = (await progress()).body.amount.earned_amount;
    expect(before).toBe('10000000.00');

    const rev = await request(app).post(`/api/contracts/${contractId}/revisions`)
      .set(auth(headToken)).send({
        contract_amount: '132000000', reason: '단가 조정', effective_date: '2027-02-01',
      });
    expect(rev.status).toBe(201);
    const revNo = rev.body.revision.revision_no;
    await request(app).post(`/api/contracts/${contractId}/items`).set(auth(headToken))
      .send({ revision_no: revNo,
              items: [{ item_code: 'CIP-600', item_name: 'C.I.P 천공 D=600', unit: 'm',
                        quantity: '2000', unit_price: '55000', sort_order: 1 }] });
    await request(app).post(`/api/contracts/${contractId}/revisions/${revNo}/activate`)
      .set(auth(headToken)).send({});

    // 천공은 하나도 안 건드렸는데 단가가 따라 올라갔다
    const after = (await progress()).body.amount.earned_amount;
    expect(after).toBe('11000000.00');   // 10공 × 20m × 55,000

    // 되돌린다
    await request(app)
      .post(`/api/contracts/${contractId}/revisions/0/activate`).set(auth(headToken)).send({});
  });

  it('§36 보조지표 — 공수 · 천공연장 · 지층별', async () => {
    const res = await progress();
    expect(res.body.hole_count).toMatchObject({ total: 100, completed: 10, remaining: 90 });
    expect(res.body.hole_count.rate).toBe('10.0');
    expect(res.body.length.total).toBe('2000.000');
    expect(res.body.length.completed).toBe('200.000');

    const byType = new Map(res.body.by_ground_type.map(
      (g: { ground_type_name: string; completed_length: string }) =>
        [g.ground_type_name, g.completed_length]));
    expect(byType.get('토사')).toBe('140.000');      // 14 × 10
    expect(byType.get('풍화암')).toBe('60.000');     // 6 × 10
  });

  it('★ 지층별 실적이 계획 기준이라는 사실을 밝힌다', async () => {
    const res = await progress();
    // 지층별 실제 실적은 따로 받지 않는다. 무엇을 기준으로 냈는지 감추지 않는다.
    expect(res.body.by_ground_type_basis).toBe('PLANNED_LENGTH');
  });

  it('보조지표에 투입 공수가 들어간다 (§25 출력일보 누계)', async () => {
    const res = await progress();
    expect(res.body).toHaveProperty('man_days');
  });

  it('실제심도가 계획과 다르면 연장 실적에 반영된다', async () => {
    await request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({
        work_date: '2027-01-06', from: 'P-011', to: 'P-012',
        depth_same_as_plan: false,
        depth_exceptions: [{ hole_no: 'P-011', actual_depth_total: '15',
                             shortfall_reason: '전석·호박돌' }],
        submit: true,
      });
    const res = await progress();
    // 200 + 15(미달) + 20 = 235. 계획심도 20 으로 잡으면 240 이 되어 과다계상된다.
    expect(res.body.length.completed).toBe('235.000');
  });

  it('★ 계획심도 미달이 공정률에 그대로 드러난다 (사용자 확인)', async () => {
    const res = await progress();
    expect(res.body.depth_shortfall.hole_count).toBe(1);
    expect(res.body.depth_shortfall.reasons).toEqual(['전석·호박돌']);
  });
});

/* ============================================================ §37 기성 */
let certId = '';

describe('§37 기성가능액은 초안이다', () => {
  it('★ 초안은 저장되지 않고 이름표가 붙는다', async () => {
    const res = await draft('2027-01-01', '2027-01-31');
    expect(res.status).toBe(200);
    expect(res.body.is_draft).toBe(true);
    expect(res.body.hole_count).toBe(12);
    // 12공 × 1,000,000 = 12,000,000
    expect(res.body.draft_amount).toBe('12000000.00');
    expect(res.body.previous_amount).toBe('0');

    const n = await withSession(HO, async (c) => {
      const r = await c.query('SELECT count(*)::int AS n FROM core.payment_certificate');
      return r.rows[0].n as number;
    });
    expect(n).toBe(0);   // 조회만으로 아무것도 만들어지지 않는다
  });

  it('공별 계산 근거를 함께 낸다 (§46)', async () => {
    const res = await draft('2027-01-01', '2027-01-31');
    const first = res.body.holes[0];
    expect(first.hole_no).toBe('P-001');
    expect(first.contract_quantity).toBe('20.0000');
    expect(first.unit_price).toBe('50000.00');
    expect(first.amount).toBe('1000000.00');
  });

  it('★ 내역 품목이 연결되지 않으면 0원으로 만들지 않고 알린다', async () => {
    // 천공종류 ↔ 내역 품목 연결을 끊는다. 공은 그대로다.
    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.site_hole_type SET contract_item_code=NULL WHERE site_id=$1`, [siteId]);
    });
    const res = await draft('2027-01-01', '2027-01-31');
    expect(res.body.issues[0].code).toBe('UNIT_PRICE_NOT_SET');
    expect(res.body.issues[0].severity).toBe('WARN');
    expect(res.body.issues[0].message).toContain('계약내역서');
    expect(res.body.draft_amount).toBe('0');   // 전부 빠진다

    const v = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    expect(v.body.issues.map((i: { code: string }) => i.code))
      .toContain('PAYMENT_UNIT_PRICE_MISSING');

    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.site_hole_type SET contract_item_code='CIP-600' WHERE site_id=$1`, [siteId]);
    });
  });

  it('공별 예외 단가는 내역서보다 우선한다 (드문 경우)', async () => {
    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET contract_unit_price=70000
          WHERE site_id=$1 AND hole_no='P-001'`, [siteId]);
    });
    const res = await draft('2027-01-01', '2027-01-31');
    const p1 = res.body.holes.find((h: { hole_no: string }) => h.hole_no === 'P-001');
    expect(p1.unit_price).toBe('70000.00');
    expect(p1.price_source).toBe('HOLE_OVERRIDE');
    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET contract_unit_price=NULL
          WHERE site_id=$1 AND hole_no='P-001'`, [siteId]);
    });
  });

  it('현장관리자도 기성 초안을 볼 수 있다 (계약금액은 §44 열람 가능)', async () => {
    const res = await draft('2027-01-01', '2027-01-31', fieldToken);
    expect(res.status).toBe(200);
    expect(res.body.draft_amount).toBe('12000000.00');
  });

  it('★ 현장관리자는 기성을 만들거나 제출할 수 없다', async () => {
    const calls = [
      request(app).post(`/api/admin/payment/sites/${siteId}/payments`).set(auth(fieldToken))
        .send({ period_from: '2027-01-01', period_to: '2027-01-31' }),
      request(app).post('/api/admin/payment/payments/'
        + '00000000-0000-0000-0000-000000000000/submit').set(auth(fieldToken))
        .send({ submitted_amount: '1' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
  });
});

describe('§37 실제 제출 기성은 본사 승인이다', () => {
  it('본사가 1회차를 만든다 — 만들 때 경고도 함께 본다', async () => {
    const res = await request(app).post(`/api/admin/payment/sites/${siteId}/payments`)
      .set(auth(headToken)).send({
        period_from: '2027-01-01', period_to: '2027-01-31', memo: '1월분',
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    // 회차를 만든 뒤에 알아채는 것보다 그 자리에서 보이는 편이 낫다
    expect(res.body.draft_amount).toBe('12000000.00');
    expect(res.body.hole_count).toBe(12);
    expect(res.body.issues).toEqual([]);
    certId = res.body.certificate_id;

    const detail = await request(app).get(`/api/progress/payments/${certId}`)
      .set(auth(headToken));
    expect(detail.body.sequence_no).toBe(1);
    expect(detail.body.draft_amount).toBe('12000000.00');
    expect(detail.body.submitted_amount).toBeNull();      // 아직 제출 아님
    expect(detail.body.holes).toHaveLength(12);
  });

  it('★ 초안과 다른 금액을 사유 없이 제출하면 거부한다', async () => {
    const res = await request(app).post(`/api/admin/payment/payments/${certId}/submit`)
      .set(auth(headToken)).send({ submitted_amount: '9000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const detail = await request(app).get(`/api/progress/payments/${certId}`)
      .set(auth(headToken));
    expect(detail.body.status).toBe('DRAFT');             // 상태가 바뀌지 않았다
  });

  it('사유를 적으면 다른 금액으로 제출할 수 있다', async () => {
    const res = await request(app).post(`/api/admin/payment/payments/${certId}/submit`)
      .set(auth(headToken)).send({
        submitted_amount: '9000000', adjust_reason: '원도급 검측 미완료분 3공 제외',
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.draft_amount).toBe('12000000.00');
    expect(res.body.submitted_amount).toBe('9000000');
  });

  it('★ 제출 시점의 근거를 얼려 둔다 (§38)', async () => {
    // 제출 뒤에 원본을 바꿔도 snapshot 은 그대로여야 한다
    await work('2027-01-20', 'P-020', 'P-025');
    const detail = await request(app).get(`/api/progress/payments/${certId}`)
      .set(auth(headToken));
    expect(detail.body.snapshot.hole_count).toBe(12);     // 18 이 아니다
    expect(detail.body.snapshot.draft_amount).toBe('12000000.00');
  });

  it('이미 제출한 기성은 다시 제출할 수 없다', async () => {
    const res = await request(app).post(`/api/admin/payment/payments/${certId}/submit`)
      .set(auth(headToken)).send({ submitted_amount: '12000000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('★ 이미 기성한 공은 다음 회차 초안에서 빠진다 (이중 계상 방지)', async () => {
    const res = await draft('2027-01-01', '2027-01-31');
    expect(res.body.hole_count).toBe(6);                  // 1/20 에 한 6공만
    expect(res.body.draft_amount).toBe('6000000.00');
    expect(res.body.previous_amount).toBe('9000000.00');  // 제출액 기준
    expect(res.body.cumulative_amount).toBe('15000000.00');
  });

  it('본사가 승인한다', async () => {
    const res = await request(app).post(`/api/admin/payment/payments/${certId}/decide`)
      .set(auth(headToken)).send({ approve: true, memo: '원도급 확인 완료' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
  });

  it('제출되지 않은 기성은 승인할 수 없다', async () => {
    const made = await request(app).post(`/api/admin/payment/sites/${siteId}/payments`)
      .set(auth(headToken)).send({ period_from: '2027-01-01', period_to: '2027-01-31' });
    const res = await request(app).post(`/api/admin/payment/payments/${made.body.certificate_id}/decide`)
      .set(auth(headToken)).send({ approve: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('★ 반려하면 그 공들이 다시 기성 대상이 된다', async () => {
    const list = await request(app).get(`/api/progress/sites/${siteId}/payments`)
      .set(auth(headToken));
    const second = list.body.payments.find((p: { sequence_no: number }) => p.sequence_no === 2);
    await request(app).post(`/api/admin/payment/payments/${second.id}/submit`)
      .set(auth(headToken)).send({ submitted_amount: '6000000' });
    await request(app).post(`/api/admin/payment/payments/${second.id}/decide`)
      .set(auth(headToken)).send({ approve: false, memo: '기간 재산정 필요' });

    const res = await draft('2027-01-01', '2027-01-31');
    expect(res.body.hole_count).toBe(6);                  // 다시 대상이 되었다
    expect(res.body.previous_amount).toBe('9000000.00');  // 반려분은 누계에서 빠진다
  });

  it('그 기간에 새로 기성할 공이 없으면 만들지 않는다', async () => {
    const res = await request(app).post(`/api/admin/payment/sites/${siteId}/payments`)
      .set(auth(headToken)).send({ period_from: '2027-03-01', period_to: '2027-03-31' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('회차 목록과 누계가 나온다', async () => {
    const res = await request(app).get(`/api/progress/sites/${siteId}/payments`)
      .set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    // 승인 1회차 9,000,000 만 누계에 잡힌다 (2회차는 반려)
    expect(res.body.cumulative_amount).toBe('9000000.00');
  });
});

/* ============================================================ §43 자동검증 */
describe('§43 기성 검증', () => {
  it('★ 누적 기성이 계약금액을 넘으면 ERROR 다', async () => {
    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.contract SET current_amount=5000000 WHERE site_id=$1`, [siteId]);
    });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const issue = res.body.issues.find(
      (i: { code: string }) => i.code === 'PAYMENT_OVER_CONTRACT');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('ERROR');
    expect(issue.message).toContain('설계변경');

    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.contract SET current_amount=120000000 WHERE site_id=$1`, [siteId]);
    });
  });

  it('정상이면 알리지 않는다 (오탐 확인)', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    expect(res.body.issues.map((i: { code: string }) => i.code))
      .not.toContain('PAYMENT_OVER_CONTRACT');
  });
});

/* ============================================================ §29 */
describe('§29 기성은 계약금액이지 내부 원가가 아니다', () => {
  it('★ 공정률·기성 함수가 private_cost 를 조회하지 않는다', async () => {
    const deps = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='core'
            AND p.proname IN ('fn_progress_full','fn_payment_draft',
                              'fn_create_payment','fn_submit_payment','fn_decide_payment')
            AND p.prosrc ~* 'private_cost'`);
      return r.rows.map((x: { proname: string }) => x.proname);
    });
    expect(deps).toEqual([]);
  });

  it('★ 응답에 내부 원가가 섞이지 않는다', async () => {
    // 본사가 노무 단가를 넣고 원가를 계산해 둔다
    await request(app).post('/api/admin/cost/labor-rates').set(auth(headToken))
      .send({ role_name: '현장관리자', pay_type: 'DAILY', rate: '313131',
              effective_from: '2027-01-01' });
    for (const token of [fieldToken, headToken]) {
      const p = await progress(token);
      const d = await draft('2027-01-01', '2027-01-31', token);
      expect(JSON.stringify(p.body)).not.toContain('313131');
      expect(JSON.stringify(d.body)).not.toContain('313131');
    }
  });

  it('계약상대방은 기성 테이블에 접근할 수 없다', async () => {
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query('SELECT count(*) FROM core.payment_certificate');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('배정 안 된 현장의 공정률은 볼 수 없다', async () => {
    const other = await request(app).post('/api/admin/sites').set(auth(headToken))
      .send({ site_code: 'PHASE10_OTHER', site_name: '배정 안 된 현장' });
    const res = await request(app)
      .get(`/api/progress/sites/${other.body.site.id}/progress`).set(auth(fieldToken));
    expect(res.status).toBe(403);
  });
});

/* ============ 단가는 계약내역서에 있다 (사용자 확인 2026-08-27) ============ */
describe('단가를 천공에 붙이지 않는다', () => {
  it('★ 천공종류 하나만 바꾸면 그 종류의 모든 공 단가가 바뀐다', async () => {
    // 공마다 단가를 붙였다면 100공을 전부 고쳐야 한다.
    await request(app).post(`/api/contracts/${contractId}/items`).set(auth(headToken))
      .send({ items: [{ item_code: 'CIP-600', item_name: 'C.I.P 천공 D=600', unit: 'm',
                        quantity: '2000', unit_price: '60000', sort_order: 1 }] });
    const res = await draft('2027-01-01', '2027-01-31');
    for (const h of res.body.holes) {
      expect(h.unit_price).toBe('60000.00');
      expect(h.price_source).toBe('CONTRACT_BOQ');
      expect(h.item_code).toBe('CIP-600');
    }
    // 되돌린다
    await request(app).post(`/api/contracts/${contractId}/items`).set(auth(headToken))
      .send({ items: [{ item_code: 'CIP-600', item_name: 'C.I.P 천공 D=600', unit: 'm',
                        quantity: '2000', unit_price: '50000', sort_order: 1 }] });
  });

  it('★ 기성 근거에 어느 내역 품목에서 왔는지 남는다', async () => {
    const res = await draft('2027-01-01', '2027-01-31');
    expect(res.body.holes[0].item_name).toBe('C.I.P 천공 D=600');
    expect(res.body.holes[0].price_source).toBe('CONTRACT_BOQ');
  });

  it('현장설정에 "천공종류 ↔ 계약내역 품목 연결" 단계가 있다', async () => {
    const res = await request(app).get(`/api/admin/sites/${siteId}/setup-status`)
      .set(auth(headToken));
    const step = res.body.steps.find(
      (s: { step_name: string }) => s.step_name === '천공종류 ↔ 계약내역 품목 연결');
    expect(step).toBeDefined();
    expect(step.done).toBe(true);
    expect(step.detail).toContain('100 / 100공');
  });
});
