/**
 * PHASE 15 — §52 최종 성공기준 자동 점검
 *
 * V1 성공 조건 11개 중 코드로 검증 가능한 10개를 하나의 파일에서 다시 확인한다.
 * (11번째 — "50~60대 사용자가 별도 설명 없이 기본입력 가능" — 은 사람만 판정할 수 있다.
 *  R20 실사용 시험 항목이며 docs/PILOT_GUIDE.md 가 그 절차다.)
 *
 * 이 파일은 기능 테스트의 중복이 아니라 '성공기준 → 증거' 맵이다.
 * 각 테스트 제목이 §52 의 문장 그대로다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const TODAY = new Date().toISOString().slice(0, 10);

let headToken = '';
let fieldToken = '';
let siteId = '';

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'CRITERIA_TEST', site_name: '§52 성공기준 검증현장' });
  siteId = site.body.site.id;

  const contract = await request(app).post(`/api/sites/${siteId}/contracts`).set(auth(headToken))
    .send({ contract_no: 'F-001', contract_name: 'RF CIP', original_amount: '100000000' });
  await request(app).post(`/api/contracts/${contract.body.contract.id}/items`)
    .set(auth(headToken))
    .send({ items: [{ item_code: 'CIP-600', item_name: 'C.I.P 천공', unit: 'm',
                      quantity: '2000', unit_price: '50000' }] });
  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1,
             contract_item_code: 'CIP-600' }]);
  // §52 "현장마다 다른 지층조합" — 이 현장은 3층 조합을 쓴다
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '매립토', sort_order: 1 },
           { code: 'G02', name: '풍화토', sort_order: 2 },
           { code: 'G03', name: '풍화암', sort_order: 3 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'C-', start: 1, end: 80, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '21',
      contract_quantity: '21', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: '표준', total_planned_depth: '21',
      layers: [{ ground_type_code: 'G01', planned_length: '8' },
               { ground_type_code: 'G02', planned_length: '9' },
               { ground_type_code: 'G03', planned_length: '4' }],
    });
  await request(app).post(`/api/admin/sites/${siteId}/default-labor`).set(auth(headToken))
    .send([{ role_name: '현장관리자', headcount: 1, sort_order: 1 }]);

  const fieldUser = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUser });
  fieldToken = await login('field01');
});

describe('§52 최종 성공기준', () => {
  it('① 현장 일일입력 3분 이내 — 필수 입력이 5터치 상당(요청 1건)으로 끝난다', async () => {
    // 화면 기준 5터치는 브라우저 검증에서 확인했다. 여기서는 그 5터치가
    // 만들어내는 요청이 '단 1건' 이고 즉시 완료되는지를 본다.
    const t0 = Date.now();
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken))
      .send({ work_date: TODAY, from: 'C-001', to: 'C-010', submit: true });
    expect(res.status).toBe(201);
    expect(res.body.today_hole_count).toBe(10);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('② 동일 데이터 중복입력 0 — 재전송·동시전송 모두 한 번만 저장', async () => {
    // 이미 phase7/8 에서 확인했다. 성공기준 파일에서는 대표 케이스만 재확인한다.
    const { randomUUID } = await import('node:crypto');
    const reqId = randomUUID();
    const body = { work_date: TODAY, from: 'C-011', to: 'C-012', submit: true };
    const send = () => request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(body);
    const rs = await Promise.all([send(), send(), send()]);
    expect(new Set(rs.map((r) => r.body.daily_work_id)).size).toBe(1);
  });

  it('③ 수량산출서 = HOLE_MASTER = 작업도면 = 천공일지 실적 일치', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/progress-consistency`).set(auth(fieldToken));
    expect(res.body.consistent).toBe(true);
    const counts = new Set(res.body.sources.map((s: { hole_count: number }) => s.hole_count));
    expect(counts.size).toBe(1);
  });

  it('④ 지층별 계획수량 자동집계 가능', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/daily-report?date=${TODAY}`).set(auth(fieldToken));
    const byType = new Map(res.body.layer_summary.map(
      (l: { ground_type_name: string; planned_length: string }) =>
        [l.ground_type_name, l.planned_length]));
    // ①의 10공 + ②의 2공 = 오늘 12공
    expect(byType.get('매립토')).toBe('96.000');    // 8 × 12
    expect(byType.get('풍화토')).toBe('108.000');   // 9 × 12
    expect(byType.get('풍화암')).toBe('48.000');    // 4 × 12
  });

  it('⑤ 현장마다 다른 지층조합 사용 가능', async () => {
    // 이 현장은 매립토/풍화토/풍화암 — 시드 현장(토사/풍화암)과 다르다.
    // 하드코딩된 지층이 없다는 뜻이다.
    const mine = await request(app)
      .get(`/api/reports/sites/${siteId}/drilling-register?limit=1`).set(auth(fieldToken));
    expect(mine.body.ground_types.map((g: { name: string }) => g.name))
      .toEqual(['매립토', '풍화토', '풍화암']);
  });

  it('⑥ 천공번호 범위 일괄설정 가능', async () => {
    // C-001~C-080 을 spec 하나로 만들었다 (beforeAll). 존재를 확인한다.
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/drilling-register?limit=1`).set(auth(fieldToken));
    expect(res.body.total_count).toBe(80);
  });

  it('⑦ 비용 증빙률 확인 가능 (현장관리자, 금액 없이)', async () => {
    await request(app).post(`/api/cost/sites/${siteId}/costs`).set(auth(fieldToken))
      .send({ cost_date: TODAY, cost_type: 'C03', amount: '380000' });
    const res = await request(app)
      .get(`/api/cost/sites/${siteId}/evidence-rate`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.total_count).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('380000');
  });

  it('⑧ 계약상대방 원가노출 0건', async () => {
    // 구조적 증거 세 가지를 한 번에 본다.
    const iso = await withSession(HO, async (c) =>
      (await c.query('SELECT * FROM app.fn_share_isolation_violations()')).rows);
    expect(iso).toEqual([]);   // share → private_cost 의존 0

    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query('SELECT count(*) FROM private_cost.daily_cost');
      }),
    ).rejects.toMatchObject({ code: '42501' });   // 외부 역할 차단

    const share = await withSession(HO, async (c) =>
      (await c.query(`SELECT p.proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='share' AND p.prosrc ~* 'private_cost'`)).rows);
    expect(share).toEqual([]);   // 외부 보고서 함수의 원가 접근 0
  });

  it('⑨ 작업일보 자동생성 — 새로 묻는 것 없이', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/daily-report?date=${TODAY}`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.today.hole_count).toBe(12);
    expect(res.body.labor.length).toBeGreaterThan(0);
  });

  it('⑩ 카카오톡용 보고서 자동생성', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/kakao-message?date=${TODAY}`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('[§52 성공기준 검증현장');
    expect(res.body.message).toContain('본사전용');
    // §40 딥링크 — 그 현장·그 날짜로 직행한다
    expect(res.body.message).toContain(`#report/${siteId}/${TODAY}`);
    expect(res.body.message).toContain(`#cost/${siteId}/${TODAY}`);
  });

  it('⑪ 50~60대 사용자 무설명 입력 — 사람만 판정할 수 있다 (R20)', () => {
    // 자동화할 수 없다. docs/PILOT_GUIDE.md 의 실사용 시험이 이 항목의 증거가 된다.
    // 이 테스트는 그 사실을 기록으로 남기기 위해 존재한다.
    expect(true).toBe(true);
  });
});
