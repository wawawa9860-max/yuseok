/**
 * PHASE 14 테스트 — 카카오톡 공유
 * Master Prompt §40, §41, §42, §29, §46
 *
 * §42 "카카오톡에는 핵심 작업정보 + 대표 상태 + 상세보기 링크만 제공한다."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';
import { externalMessage, internalMessage } from '../src/domain/kakaoMessage.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let headToken = '';
let fieldToken = '';
let siteId = '';

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE14_TEST', site_name: '○○현장' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 },
           { code: 'G02', name: '풍화암', sort_order: 2 },
           { code: 'G03', name: '연암', sort_order: 3 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'A-', start: 1, end: 300, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '18',
      contract_quantity: '18', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: '표준', total_planned_depth: '18',
      layers: [{ ground_type_code: 'G01', planned_length: '10' },
               { ground_type_code: 'G02', planned_length: '6' },
               { ground_type_code: 'G03', planned_length: '2' }],
    });

  const fieldUser = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUser });
  fieldToken = await login('field01');

  // §40 예시와 비슷한 하루: 13공, 1공 제외(미달), 레미콘 91㎥ 지연 60분, 비용 6건 중 5건 증빙
  await request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
    .send({
      work_date: '2027-08-25', from: 'A-031', to: 'A-044',
      depth_same_as_plan: false,
      depth_exceptions: [{ hole_no: 'A-037', actual_depth_total: '12',
                           shortfall_reason: '지하수' }],
      ready_mix: { quantity_m3: '91', has_delay: true, delay_minutes: 60,
                   delay_reason: '레미콘공장' },
      submit: true,
    });
  await request(app).put(`/api/reports/sites/${siteId}/daily-report/next-day-plan`)
    .set(auth(fieldToken))
    .send({ work_date: '2027-08-25', next_day_plan: 'A-045부터 진행예정' });
  await request(app).post(`/api/events/sites/${siteId}/events`).set(auth(fieldToken))
    .send({ event_type: '검측지연', memo: '원도급 검측 익일로 연기',
            event_date: '2027-08-25' });
  for (let i = 0; i < 6; i++) {
    const cost = await request(app).post(`/api/cost/sites/${siteId}/costs`)
      .set(auth(fieldToken))
      .send({ cost_date: '2027-08-25', cost_type: 'C06', amount: '10000', memo: `n${i}` });
    if (i < 5) {
      await request(app).post(`/api/cost/costs/${cost.body.cost.id}/evidence`)
        .set(auth(fieldToken))
        .attach('file', Buffer.from('89504e470d0a1a0a', 'hex'), `r${i}.png`);
    }
  }
});

/* ============================================================ §40 본사용 */
describe('§40 본사 카카오톡 메시지', () => {
  it('★ §40 예시 형식 그대로 — 본사전용 블록은 건수만', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/kakao-message?date=2027-08-25`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    const m = res.body.message as string;
    expect(m).toContain('[○○현장 / 8월25일]');
    expect(m).toContain('금일\n14공 / 246m');           // 13×18 + 12(미달)
    expect(m).toContain('공정률 4.7%');                  // 14/300
    expect(m).toContain('지층별 계획실적');
    expect(m).toContain('토사 140m');
    expect(m).toContain('레미콘\n91㎥');
    expect(m).toContain('레미콘 공급지연 60분');
    expect(m).toContain('계획심도 미달 A-037');
    expect(m).toContain('검측지연 원도급 검측 익일로 연기');
    expect(m).toContain('본사전용\n비용등록 6건\n증빙완료 5\n증빙대기 1');
    expect(m).toContain('[현장 상세보기]');
    expect(m).toContain('[본사 원가 상세보기]');
  });

  it('★ 메시지에 원가 금액이 없다 (§40 — 건수만)', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/kakao-message?date=2027-08-25`).set(auth(fieldToken));
    expect(res.body.message).not.toContain('10,000');
    expect(res.body.message).not.toContain('60,000');
    expect(res.body.message).not.toMatch(/\d원/);
  });
});

/* ============================================================ §41 외부용 */
describe('§41 계약상대방 카카오톡 메시지', () => {
  let message = '';
  let url = '';

  it('★ 본사가 발급하면 메시지 + 링크가 함께 나온다', async () => {
    const res = await request(app)
      .post(`/api/admin/share/sites/${siteId}/kakao-external`).set(auth(headToken))
      .send({ report_date: '2027-08-25' });
    expect(res.status).toBe(201);
    message = res.body.message;
    url = res.body.url;
    expect(message).toContain('[○○현장 RF CIP 작업현황]');
    expect(message).toContain('2027.08.25');
    expect(message).toContain('금일\n14공 / 246m');
    expect(message).toContain('금일 천공번호\nA-031 ~ A-044');
    expect(message).toContain('레미콘\n91㎥');
    expect(message).toContain('레미콘 공급지연 60분');
    expect(message).toContain('익일계획\nA-045부터 진행예정');
    expect(message).toContain('[작업현황 상세보기]');
    expect(message).toContain(url);
  });

  it('★ 특이사항 전 범위가 나간다 (사용자 확인 2026-08-29)', async () => {
    expect(message).toContain('검측지연 원도급 검측 익일로 연기');
  });

  it('★ 원가는 절대 없다 (§41)', async () => {
    expect(message).not.toContain('비용');
    expect(message).not.toContain('증빙');
    expect(message).not.toMatch(/원가|단가|금액/);
  });

  it('메시지의 링크가 실제로 열린다 (로그인 없이)', async () => {
    const token = url.split('/').pop()!;
    const res = await request(app).get(`/api/share/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.today.hole_count).toBe(14);
  });

  it('현장관리자는 외부용을 발급할 수 없다', async () => {
    const res = await request(app)
      .post(`/api/admin/share/sites/${siteId}/kakao-external`).set(auth(fieldToken)).send({});
    expect(res.status).toBe(403);
  });
});

/* ============================================================ §42 원칙 */
describe('§42 메시지는 핵심 + 링크뿐이다 (결정론 조립 §46)', () => {
  const base = {
    report_date: '2027-08-25',
    site: { site_name: '○○현장' },
    today: { hole_count: 13, length: '238.5' },
    cumulative: { completed_holes: 184, total_holes: 300, progress_rate: '61.2' },
    by_ground_type: [
      { ground_type_name: '토사', completed_length: '112' },
      { ground_type_name: '풍화암', completed_length: '74' },
      { ground_type_name: '연암', completed_length: '26' },
    ],
    ready_mix: { quantity_m3: '91', has_delay: true, delay_minutes: 60,
                 delay_reason: '레미콘공장' },
    notes: [{ type: '레미콘 공급지연', detail: '60분' }],
    next_day_plan: 'A-045부터 진행예정',
  };

  it('★ §40 예시를 그대로 재현한다', () => {
    const m = internalMessage(base, { label: 'A-031 ~ A-044', excluded: ['A-037'] },
      { total_count: 6, verified_count: 5, pending_count: 1 },
      'https://x/app/', 'https://x/cost/');
    expect(m).toContain('[○○현장 / 8월25일]');
    expect(m).toContain('금일\n13공 / 238.5m');
    expect(m).toContain('누계\n184공\n공정률 61.2%');
    expect(m).toContain('지층별 계획실적\n토사 112m\n풍화암 74m\n연암 26m');
    expect(m).toContain('본사전용\n비용등록 6건\n증빙완료 5\n증빙대기 1');
  });

  it('★ §41 예시를 그대로 재현한다', () => {
    const m = externalMessage(base, { label: 'A-031 ~ A-044', excluded: ['A-037'] },
      'https://x/share/t');
    expect(m).toContain('[○○현장 RF CIP 작업현황]');
    expect(m).toContain('금일 천공번호\nA-031 ~ A-044\n제외 A-037');
    expect(m).toContain('[작업현황 상세보기]\nhttps://x/share/t');
    expect(m).not.toContain('본사전용');
  });

  it('빈 값이면 그 블록이 통째로 빠진다 — 파일 저장소가 아니다', () => {
    const m = externalMessage(
      { ...base, ready_mix: null, notes: [], next_day_plan: null },
      { label: '', excluded: [] }, 'https://x/share/t');
    expect(m).not.toContain('레미콘');
    expect(m).not.toContain('특이사항');
    expect(m).not.toContain('익일계획');
    expect(m).not.toContain('금일 천공번호');
  });
});

describe('현장명에 RF CIP 가 이미 있으면 겹쳐 쓰지 않는다', () => {
  const d = {
    report_date: '2027-08-25', site: { site_name: '시험현장 RF CIP' },
    today: { hole_count: 1, length: '20' },
    cumulative: { completed_holes: 1, total_holes: 10, progress_rate: '10.0' },
    by_ground_type: [], ready_mix: null, notes: [], next_day_plan: null,
  };
  it('★ [시험현장 RF CIP 작업현황] — RF CIP 한 번만', () => {
    const m = externalMessage(d, { label: '', excluded: [] }, 'https://x/t');
    expect(m).toContain('[시험현장 RF CIP 작업현황]');
    expect(m).not.toContain('RF CIP RF CIP');
  });
});
