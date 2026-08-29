/**
 * PHASE 13 테스트 — 공유 분리
 * Master Prompt §41, §42, §29, §46
 *
 * §41 "계약상대방용에는 절대로 원가를 포함하지 않는다.
 *      상세링크에서도 PRIVATE_COST 데이터에 접근할 수 없어야 한다."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';
import { compressHoleNumbers } from '../src/domain/holeRange.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let headToken = '';
let fieldToken = '';
let siteId = '';
let shareToken = '';

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE13_TEST', site_name: 'PHASE13 공유 검증현장' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 },
           { code: 'G02', name: '풍화암', sort_order: 2 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'S-', start: 1, end: 60, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20',
      contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: '표준', total_planned_depth: '20',
      layers: [{ ground_type_code: 'G01', planned_length: '14' },
               { ground_type_code: 'G02', planned_length: '6' }],
    });

  const fieldUser = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUser });
  fieldToken = await login('field01');

  // §41 예시 상황: 14공 중 1공 제외(미달), 레미콘 지연, 익일계획
  await request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
    .send({
      work_date: '2027-03-02', from: 'S-031', to: 'S-044',
      depth_same_as_plan: false,
      depth_exceptions: [{ hole_no: 'S-037', actual_depth_total: '11',
                           shortfall_reason: '지하수' }],
      ready_mix: { quantity_m3: '91', has_delay: true, delay_minutes: 60,
                   delay_reason: '레미콘공장' },
      submit: true,
    });
  await request(app).put(`/api/reports/sites/${siteId}/daily-report/next-day-plan`)
    .set(auth(fieldToken))
    .send({ work_date: '2027-03-02', next_day_plan: 'S-045부터 진행예정' });
  // 내부 사건 (외부에 나가면 안 된다) + 내부 비용
  await request(app).post(`/api/events/sites/${siteId}/events`).set(auth(fieldToken))
    .send({ event_type: '소음 민원발생', memo: '외부에 나가면 안 되는 내부 기록',
            needs_review: true });
  await request(app).post(`/api/cost/sites/${siteId}/costs`).set(auth(fieldToken))
    .send({ cost_date: '2027-03-02', cost_type: 'C03', amount: '777001', vendor: '주유소' });
});

/* ============================================================ 발급 / 열람 */
describe('§41 본사가 발급하고, 링크만으로 열람한다', () => {
  it('본사가 공유 링크를 발급한다', async () => {
    const res = await request(app).post(`/api/admin/share/sites/${siteId}/issue`)
      .set(auth(headToken)).send({ report_date: '2027-03-02', valid_days: 7 });
    expect(res.status).toBe(201);
    expect(res.body.share_token).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.url).toBe(`/share/${res.body.share_token}`);
    shareToken = res.body.share_token;
  });

  it('현장관리자는 발급할 수 없다', async () => {
    const res = await request(app).post(`/api/admin/share/sites/${siteId}/issue`)
      .set(auth(fieldToken)).send({});
    expect(res.status).toBe(403);
  });

  it('★ 로그인 없이 토큰만으로 열린다 — §41 항목 그대로', async () => {
    const res = await request(app).get(`/api/share/${shareToken}`);   // 인증 헤더 없음
    expect(res.status).toBe(200);
    expect(res.body.site.site_name).toBe('PHASE13 공유 검증현장');
    expect(res.body.today.hole_count).toBe(14);
    // 금일 연장 = 13×20 + 11(미달) = 271
    expect(res.body.today.length).toBe('271.000');
    expect(res.body.cumulative).toMatchObject({
      completed_holes: 14, total_holes: 60, quantity_basis: 'CONTRACT_QUANTITY' });
    expect(res.body.ready_mix.quantity_m3).toBe('91.000');
    expect(res.body.next_day_plan).toBe('S-045부터 진행예정');
  });

  it('★ 금일 천공번호가 §41 형식이다 — 범위 + 제외 없음(미달도 시공은 했다)', async () => {
    const res = await request(app).get(`/api/share/${shareToken}`);
    expect(res.body.today_hole_range.label).toBe('S-031 ~ S-044');
    expect(res.body.today_hole_range.excluded).toEqual([]);
  });

  it('특이사항에 공급지연과 심도미달이 나온다', async () => {
    const res = await request(app).get(`/api/share/${shareToken}`);
    const types = res.body.notes.map((n: { type: string }) => n.type);
    expect(types).toContain('레미콘 공급지연');
    expect(types).toContain('계획심도 미달');
    const delay = res.body.notes.find((n: { type: string }) => n.type === '레미콘 공급지연');
    expect(delay.detail).toBe('60분 · 레미콘공장');
  });

  it('★ 내부 사건(민원 등)은 외부에 나가지 않는다', async () => {
    const res = await request(app).get(`/api/share/${shareToken}`);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('민원');
    expect(text).not.toContain('내부 기록');
  });

  it('★ 원가는 한 글자도 나가지 않는다 (§41)', async () => {
    const res = await request(app).get(`/api/share/${shareToken}`);
    const keys = new Set<string>();
    JSON.stringify(res.body, (k, v) => { keys.add(k); return v; });
    for (const k of keys) expect(k).not.toMatch(/(^|_)(amount|rate_|price|cost|단가|원가)(_|$)/);
    expect(JSON.stringify(res.body)).not.toContain('777001');
  });
});

/* ============================================================ 토큰 안전 */
describe('§42 토큰은 추측할 수 없고 회수할 수 있다', () => {
  it('없는 토큰·형식이 다른 토큰은 똑같이 404 다 (있는지 없는지도 비밀)', async () => {
    for (const t of ['0'.repeat(32), 'abc', '../../etc/passwd']) {
      const res = await request(app).get(`/api/share/${encodeURIComponent(t)}`);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('열람할 수 없는 링크입니다.');
    }
  });

  it('만료된 토큰은 열리지 않는다', async () => {
    const issued = await request(app).post(`/api/admin/share/sites/${siteId}/issue`)
      .set(auth(headToken)).send({ report_date: '2027-03-02', valid_days: 1 });
    const t = issued.body.share_token;
    await withSession(HO, async (c) => {
      await c.query(
        `UPDATE core.external_share SET expires_at = now() - interval '1 minute'
          WHERE share_token=$1`, [t]);
    });
    const res = await request(app).get(`/api/share/${t}`);
    expect(res.status).toBe(404);
  });

  it('★ 회수하면 이미 퍼진 링크도 그 순간부터 닫힌다', async () => {
    const before = await request(app).get(`/api/share/${shareToken}`);
    expect(before.status).toBe(200);
    await request(app).post(`/api/admin/share/revoke/${shareToken}`).set(auth(headToken));
    const after = await request(app).get(`/api/share/${shareToken}`);
    expect(after.status).toBe(404);
    // 다음 테스트를 위해 새로 발급
    const re = await request(app).post(`/api/admin/share/sites/${siteId}/issue`)
      .set(auth(headToken)).send({ report_date: '2027-03-02' });
    shareToken = re.body.share_token;
  });

  it('상세보기 HTML 페이지가 열린다 (로그인 없음)', async () => {
    const res = await request(app).get(`/share/${shareToken}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('share-view.js');
  });
});

/* ============================================================ §29 구조 차단 */
describe('§29 상세링크 경로에서 PRIVATE_COST 는 구조적으로 닿지 않는다', () => {
  it('★ share 스키마 함수 본문에 private_cost 가 없다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'share' AND p.prosrc ~* 'private_cost'`);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it('★ share 뷰의 private_cost 의존 0 (기존 불변조건 유지)', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query('SELECT * FROM app.fn_share_isolation_violations()');
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it('★ 외부 역할은 토큰 없이 현장 상태 함수를 직접 부를 수 없다', async () => {
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query(`SELECT share.fn_daily_status($1, '2027-03-02')`, [siteId]);
      }),
    ).rejects.toMatchObject({ code: '42501' });
    // 내부 구현 함수도 직접 못 부른다
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query(`SELECT share.fn_daily_status_internal($1, '2027-03-02')`, [siteId]);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('외부 역할은 발급·회수 함수도 부를 수 없다', async () => {
    for (const sql of [`SELECT core.fn_issue_share($1, '2027-03-02', 7)`,
                       `SELECT core.fn_revoke_share('deadbeef')`]) {
      await expect(
        withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
          await c.query(sql.includes('$1') ? sql : sql, sql.includes('$1') ? [siteId] : []);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('본사 미리보기 = 외부가 보는 것과 같은 내용', async () => {
    const preview = await request(app)
      .get(`/api/admin/share/sites/${siteId}/preview?date=2027-03-02`).set(auth(headToken));
    const ext = await request(app).get(`/api/share/${shareToken}`);
    expect(preview.body.today).toEqual(ext.body.today);
    expect(preview.body.notes).toEqual(ext.body.notes);
    expect(preview.body.today_hole_range).toEqual(ext.body.today_hole_range);
  });
});

/* ============================================================ 범위 압축 */
describe('§41 천공번호 범위 표현 (결정론 §46)', () => {
  it('연속이면 범위 하나', () => {
    expect(compressHoleNumbers(['A-031', 'A-032', 'A-033']))
      .toEqual({ label: 'A-031 ~ A-033', excluded: [] });
  });

  it('★ §41 예시 — 하나 빠지면 범위 + 제외', () => {
    const nos = [];
    for (let i = 31; i <= 44; i++) if (i !== 37) nos.push(`A-0${i}`);
    expect(compressHoleNumbers(nos))
      .toEqual({ label: 'A-031 ~ A-044', excluded: ['A-037'] });
  });

  it('많이 빠지면 제외가 아니라 구간 나열', () => {
    const r = compressHoleNumbers(['A-001', 'A-002', 'A-010', 'A-011', 'A-020']);
    expect(r.label).toBe('A-001 ~ A-002, A-010 ~ A-011, A-020');
    expect(r.excluded).toEqual([]);
  });

  it('무근 번호(1-1 형식)도 그대로 다룬다 — 형식을 강제하지 않는다', () => {
    const r = compressHoleNumbers(['1-1', '1-2', '1-3']);
    expect(r.label).toBe('1-1 ~ 1-3');
  });

  it('숫자로 안 끝나는 번호는 그대로 나열한다', () => {
    const r = compressHoleNumbers(['A-001', 'A-002', '보강공A']);
    expect(r.label).toBe('A-001 ~ A-002, 보강공A');
  });

  it('빈 목록·한 개', () => {
    expect(compressHoleNumbers([])).toEqual({ label: '', excluded: [] });
    expect(compressHoleNumbers(['A-007'])).toEqual({ label: 'A-007', excluded: [] });
  });
});
