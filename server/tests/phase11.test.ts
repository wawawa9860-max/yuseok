/**
 * PHASE 11 테스트 — SPECIAL_EVENT
 * Master Prompt §31, §32, §26, §33, §38, §43, §46
 *
 * §31 "별도의 복잡한 안전/품질/민원 ERP를 만들지 않는다. SPECIAL_EVENT 하나로 통합한다."
 * §1-2 일일입력이 이미 받은 예외는 재입력시키지 않는다 — 모아서 보여줄 뿐이다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let headToken = '';
let fieldToken = '';
let siteId = '';
let eventId = '';

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE11_TEST', site_name: 'PHASE11 특이사항 검증현장' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'E-', start: 1, end: 30, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20',
      contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: '표준', total_planned_depth: '20',
      layers: [{ ground_type_code: 'G01', planned_length: '20' }],
    });
  await request(app).post(`/api/admin/sites/${siteId}/default-equipment`).set(auth(headToken))
    .send([{ equipment_name: '천공기', charge_type: 'MONTHLY', quantity: 1, sort_order: 1 }]);

  const fieldUser = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUser });
  fieldToken = await login('field01');

  // 일일입력 하루치 — 미달 1공 + 레미콘 지연 + 장비 대기 + 지반 특이사항
  await request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
    .send({
      work_date: '2027-02-01', from: 'E-001', to: 'E-005',
      depth_same_as_plan: false,
      depth_exceptions: [{ hole_no: 'E-003', actual_depth_total: '13',
                           shortfall_reason: '전석·호박돌' }],
      ready_mix: { quantity_m3: '25', has_delay: true, delay_minutes: 90,
                   delay_reason: '레미콘공장' },
      equipment_same_as_default: false,
      equipment_changes: [{ equipment_name: '천공기', operating_days: '0.5',
                            idle_reason: '오후 우천' }],
      ground_notes: [{ note_type: '지하수', memo: 'E-004 용수', hole_nos: ['E-004'] }],
      submit: true,
    });
});

/* ============================================================ §31 등록 */
describe('§31 특이사항 등록 — ERP 가 아니라 한 장의 기록', () => {
  it('유형 선택지 17종을 서버가 내려준다', async () => {
    const res = await request(app).get('/api/events/event-types').set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.event_types).toHaveLength(17);
    for (const t of ['레미콘 지연', '지반조건 변화', '슬라임', 'H-BEAM', '우천', '기타']) {
      expect(res.body.event_types).toContain(t);
    }
  });

  it('★ 현장관리자가 사건을 등록한다 — §32 번호가 자동으로 붙는다', async () => {
    const res = await request(app).post(`/api/events/sites/${siteId}/events`)
      .set(auth(fieldToken)).send({
        event_date: '2027-02-01', event_type: '지반조건 변화',
        title: 'E-003 부근 전석층 출현',
        memo: '천공조서와 달리 GL-13m 부터 전석. 관입 불가.',
        needs_review: true,
        hole_nos: ['E-003', 'E-004'],
      });
    expect(res.status).toBe(201);
    expect(res.body.event.event_no).toBe('EV-2027-0001');
    expect(res.body.event.needs_review).toBe(true);
    expect(res.body.linked_holes).toEqual(['E-003', 'E-004']);
    eventId = res.body.event.id;
  });

  it('번호는 현장·연도별 순번이다', async () => {
    const res = await request(app).post(`/api/events/sites/${siteId}/events`)
      .set(auth(fieldToken)).send({ event_date: '2027-02-02', event_type: '우천' });
    expect(res.body.event.event_no).toBe('EV-2027-0002');
  });

  it('★ 동시에 등록해도 번호가 겹치지 않는다', async () => {
    const send = () => request(app).post(`/api/events/sites/${siteId}/events`)
      .set(auth(fieldToken)).send({ event_date: '2027-02-03', event_type: '기타' });
    const results = await Promise.all([send(), send(), send()]);
    const nos = results.map((r) => r.body.event.event_no);
    expect(new Set(nos).size).toBe(3);
  });

  it('도면에 없는 천공번호는 조용히 버리지 않고 알려준다 (§8)', async () => {
    const res = await request(app).post(`/api/events/sites/${siteId}/events`)
      .set(auth(fieldToken)).send({
        event_type: '추가천공', hole_nos: ['E-001', 'X-999'],
      });
    expect(res.body.linked_holes).toEqual(['E-001']);
    expect(res.body.unknown_holes).toEqual(['X-999']);
  });

  it('오프라인 큐가 같은 사건을 두 번 보내도 한 번만 저장된다', async () => {
    const reqId = randomUUID();
    const body = { event_type: '검측지연', memo: '원도급 검측 지연',
                   client_request_id: reqId };
    const send = () => request(app).post(`/api/events/sites/${siteId}/events`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(body);
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.body.event.event_no).toBe(b.body.event.event_no);
    expect([a.body.replayed, b.body.replayed].filter(Boolean)).toHaveLength(1);
  });
});

/* ==================================================== §31 사진·음성메모 */
describe('§31 사진 / 음성메모 연결', () => {
  it('사진을 붙인다 — 현장·본사가 함께 본다', async () => {
    const res = await request(app).post(`/api/events/${eventId}/files`)
      .set(auth(fieldToken)).attach('file', PNG, 'site-photo.png');
    expect(res.status).toBe(201);
    expect(res.body.category).toBe('FIELD_PHOTO');

    const vis = await withSession(HO, async (c) => {
      const r = await c.query(
        'SELECT visibility FROM core.stored_file WHERE id=$1', [res.body.file_id]);
      return r.rows[0].visibility as string;
    });
    expect(vis).toBe('SITE');   // 원가가 아니다. 본사전용으로 숨기지 않는다.
  });

  it('음성메모도 붙는다', async () => {
    const res = await request(app).post(`/api/events/${eventId}/files`)
      .set(auth(fieldToken)).attach('file', Buffer.from('fake-audio'), 'memo.m4a');
    expect(res.status).toBe(201);
    expect(res.body.category).toBe('VOICE_MEMO');
  });

  it('허용되지 않는 파일은 거부한다', async () => {
    const res = await request(app).post(`/api/events/${eventId}/files`)
      .set(auth(fieldToken)).attach('file', Buffer.from('x'), 'virus.exe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_FILE');
  });
});

/* ==================================================== §31 통합 조회 */
describe('§31 통합 — 일일입력이 받은 예외를 재입력시키지 않는다 (§1-2)', () => {
  it('★ 조회 하나로 사건 + 레미콘 지연 + 장비대기 + 심도미달 + 지반이 다 나온다', async () => {
    const res = await request(app)
      .get(`/api/events/sites/${siteId}/events?from=2027-02-01&to=2027-02-28`)
      .set(auth(fieldToken));
    expect(res.status).toBe(200);

    const ev = res.body.events.find(
      (e: { event_no: string }) => e.event_no === 'EV-2027-0001');
    expect(ev.event_type).toBe('지반조건 변화');
    expect(ev.hole_numbers).toEqual(['E-003', 'E-004']);
    expect(ev.files).toHaveLength(2);   // 사진 + 음성

    const d = res.body.from_daily_input;
    expect(d.ready_mix_delay[0]).toMatchObject({ delay_minutes: 90, delay_reason: '레미콘공장' });
    expect(d.equipment_idle[0]).toMatchObject({ equipment_name: '천공기', idle_reason: '오후 우천' });
    expect(d.depth_shortfall[0]).toMatchObject({
      hole_no: 'E-003', actual_depth: '13.000', reason: '전석·호박돌' });
    expect(d.ground_notes[0]).toMatchObject({ note_type: '지하수' });
    expect(d.ground_notes[0].hole_numbers).toEqual(['E-004']);
  });

  it('★ 작업일보 특이사항 칸에 사건이 합류한다 (§33)', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/daily-report?date=2027-02-01`).set(auth(fieldToken));
    const notes = res.body.special_notes;
    const sources = notes.map((n: { source: string }) => n.source);
    expect(sources).toContain('GROUND_NOTE');
    expect(sources).toContain('EVENT');
    const ev = notes.find((n: { source: string }) => n.source === 'EVENT');
    expect(ev.event_no).toBe('EV-2027-0001');
    expect(ev.needs_review).toBe(true);
  });

  it('§34 천공일지에도 이미 연결돼 있다 (지반 특이사항)', async () => {
    const res = await request(app)
      .get(`/api/reports/sites/${siteId}/holes/E-004/log`).set(auth(fieldToken));
    expect(res.body.special_notes.map((n: { note_type: string }) => n.note_type))
      .toContain('지하수');
  });
});

/* ==================================================== §32 검토 / 종결 */
describe('§32 변경/정산 검토', () => {
  it('★ 검토 필요 사건이 열려 있으면 본사 검증에 나온다 (§43)', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const issue = res.body.issues.find(
      (i: { code: string }) => i.code === 'EVENT_NEEDS_REVIEW');
    expect(issue).toBeDefined();
    expect(issue.target).toBe('EV-2027-0001');
    expect(issue.severity).toBe('WARN');
  });

  it('현장관리자에게는 그 경고가 보이지 않는다 (§43 후단)', async () => {
    const n = await withSession(HO, async (c) => {
      const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
      return r.rows[0].id as string;
    });
    const rows = await withSession({ userId: n, role: 'FIELD_MANAGER' }, async (c) => {
      const r = await c.query('SELECT * FROM core.fn_check_special_events($1)', [siteId]);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it('본사가 검토를 마치고 종결한다', async () => {
    const res = await request(app).patch(`/api/events/${eventId}`).set(auth(headToken))
      .send({ status: 'CLOSED', review_note: '설계변경 요청서 제출 (2027-02-05)' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLOSED');
  });

  it('종결하면 검증 경고가 사라진다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    expect(res.body.issues.map((i: { code: string }) => i.code))
      .not.toContain('EVENT_NEEDS_REVIEW');
  });

  it('현장관리자는 종결할 수 없다', async () => {
    const made = await request(app).post(`/api/events/sites/${siteId}/events`)
      .set(auth(fieldToken)).send({ event_type: '기타', needs_review: true });
    const res = await request(app).patch(`/api/events/${made.body.event.id}`)
      .set(auth(fieldToken)).send({ status: 'CLOSED' });
    expect(res.status).toBe(403);
  });
});

/* ==================================================== §29 / 권한 */
describe('권한', () => {
  it('배정되지 않은 현장에는 사건을 만들 수 없다', async () => {
    const other = await request(app).post('/api/admin/sites').set(auth(headToken))
      .send({ site_code: 'PHASE11_OTHER', site_name: '배정 안 된 현장' });
    const res = await request(app).post(`/api/events/sites/${other.body.site.id}/events`)
      .set(auth(fieldToken)).send({ event_type: '기타' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('계약상대방은 특이사항에 접근할 수 없다', async () => {
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query('SELECT count(*) FROM core.special_event');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('★ 특이사항 응답에 금액이 없다 (§29)', async () => {
    const res = await request(app)
      .get(`/api/events/sites/${siteId}/events?from=2027-01-01&to=2027-12-31`)
      .set(auth(fieldToken));
    const keys = new Set<string>();
    JSON.stringify(res.body, (k, v) => { keys.add(k); return v; });
    for (const k of keys) expect(k).not.toMatch(/(^|_)(amount|rate|price|cost|단가|원가)(_|$)/);
  });

  it('사건 등록·수정이 change_log 에 남는다 (§38)', async () => {
    const n = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM audit.change_log
          WHERE table_name='core.special_event'`);
      return r.rows[0].n as number;
    });
    expect(n).toBeGreaterThan(0);
  });
});
