/**
 * PHASE 8 테스트 — 비용 / 사진증빙 / 본사전용 보안
 * Master Prompt §24, §25, §26, §27, §28, §29, §30, §43, §44, §46, §52
 *
 * 이 단계에서 처음으로 '실제 금액'이 시스템에 들어온다.
 * 그래서 §29(원가보안 절대규칙)를 프론트가 아니라 DB 에서 확인한다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const EXT = { userId: null, role: 'EXTERNAL' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** 1×1 PNG. 실제 영수증 사진 대신 쓴다 (내용이 아니라 경로·권한을 검증한다). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

let headToken = '';
let fieldToken = '';   // field03 — 이 현장의 관리자
let otherToken = '';   // field02 — 같은 현장의 다른 관리자
let siteId = '';
let fieldUserId = '';
let dailyWorkId = '';

beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE8_TEST', site_name: 'PHASE8 비용·증빙 검증현장' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([{ code: 'G01', name: '토사', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'B-', start: 1, end: 50, digits: 3 },
      hole_type_code: 'HPILE', design_depth_total: '20',
      contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: 'B구간 표준', total_planned_depth: '20',
      layers: [{ ground_type_code: 'G01', planned_length: '20' }],
    });

  // §21/§22 기본 인원·장비 (원가계산의 입력이 된다)
  await request(app).post(`/api/admin/sites/${siteId}/default-labor`).set(auth(headToken))
    .send([
      { role_name: '현장관리자', headcount: 1, sort_order: 1 },
      { role_name: '천공기 장비기사', headcount: 1, sort_order: 2 },
      { role_name: '천공기 작업반장', headcount: 1, sort_order: 3 },
    ]);
  await request(app).post(`/api/admin/sites/${siteId}/default-equipment`).set(auth(headToken))
    .send([
      { equipment_name: '천공기', charge_type: 'MONTHLY', quantity: 1, sort_order: 1 },
      { equipment_name: '펌프카', charge_type: 'DAILY', quantity: 1, sort_order: 2 },
    ]);

  const users = await withSession(HO, async (c) => {
    const r = await c.query(
      `SELECT login_id, id FROM core.app_user WHERE login_id IN ('field03','field02')`);
    return new Map(r.rows.map((u: { login_id: string; id: string }) => [u.login_id, u.id]));
  });
  fieldUserId = users.get('field03')!;
  for (const uid of [fieldUserId, users.get('field02')!]) {
    await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
      .send({ user_id: uid });
  }
  fieldToken = await login('field03');
  otherToken = await login('field02');

  // 원가계산을 붙일 일일작업 하루치
  const work = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
    .set(auth(fieldToken)).send({
      work_date: '2026-10-05', from: 'B-001', to: 'B-005',
      ready_mix: { quantity_m3: '29', has_delay: false }, submit: true,
    });
  dailyWorkId = work.body.daily_work_id;
});

/* ==================================================== §24 투입원가 6개 항목 */
describe('§24 투입원가는 6개 항목으로 고정된다', () => {
  it('노무비·장비비·유류비·잡자재비·식대·기타경비 6개가 그대로 나온다', async () => {
    const res = await request(app).get('/api/cost/cost-types').set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.cost_types.map((t: { code: string }) => t.code))
      .toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06']);
    expect(res.body.cost_types.map((t: { name_ko: string }) => t.name_ko))
      .toEqual(['노무비', '장비비', '유류비', '잡자재비', '식대', '기타경비']);
  });

  it('7번째 항목은 만들 수 없다', async () => {
    const res = await request(app).post(`/api/cost/sites/${siteId}/costs`)
      .set(auth(fieldToken)).send({ cost_type: 'C07', amount: '1000' });
    expect(res.status).toBe(400);
  });

  it('§27 사진증빙이 기본인 항목을 화면이 미리 알 수 있다', async () => {
    const res = await request(app).get('/api/cost/cost-types').set(auth(fieldToken));
    const need = new Map(res.body.cost_types.map(
      (t: { code: string; evidence_expected: boolean }) => [t.code, t.evidence_expected]));
    expect(need.get('C03')).toBe(true);    // 유류비
    expect(need.get('C05')).toBe(true);    // 식대
    expect(need.get('C01')).toBe(false);   // 노무비는 단가로 계산한다
  });
});

/* ============================================ §27, §28 비용 입력과 증빙상태 */
let fuelCostId = '';

describe('§28 영수증이 없어도 입력을 막지 않는다', () => {
  it('영수증 없이 저장하면 증빙대기로 남는다', async () => {
    const res = await request(app).post(`/api/cost/sites/${siteId}/costs`)
      .set(auth(fieldToken)).send({
        cost_date: '2026-10-05', cost_type: 'C03',
        amount: '380000', quantity: '420', unit: 'L', vendor: '○○주유소',
      });
    expect(res.status).toBe(201);
    expect(res.body.cost.evidence_status).toBe('PENDING_EVIDENCE');
    expect(res.body.evidence_expected).toBe(true);
    fuelCostId = res.body.cost.id;
  });

  it('같은 날 일일작업이 있으면 자동으로 연결한다 (§1-7 재입력 금지)', async () => {
    const linked = await withSession(HO, async (c) => {
      const r = await c.query(
        'SELECT daily_work_id FROM private_cost.daily_cost WHERE id=$1', [fuelCostId]);
      return r.rows[0].daily_work_id as string | null;
    });
    expect(linked).toBe(dailyWorkId);
  });

  it('★ 영수증 사진을 붙이면 증빙완료로 바뀐다', async () => {
    const res = await request(app).post(`/api/cost/costs/${fuelCostId}/evidence`)
      .set(auth(fieldToken)).attach('file', PNG, 'receipt.png');
    expect(res.status).toBe(201);
    expect(res.body.evidence_status).toBe('VERIFIED');
  });

  it('★ 영수증 파일은 DB 가 본사전용으로 강제한다 (§29 — 프론트 숨김 아님)', async () => {
    const row = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT f.category, f.visibility
           FROM private_cost.cost_evidence e
           JOIN core.stored_file f ON f.id = e.file_id
          WHERE e.cost_id = $1`, [fuelCostId]);
      return r.rows[0];
    });
    expect(row.category).toBe('RECEIPT');
    expect(row.visibility).toBe('HEAD_OFFICE_ONLY');
  });

  it('★ 영수증을 계약상대방 공유로 바꾸려 하면 DB 가 거부한다 (음성 검증)', async () => {
    await expect(
      withSession(HO, async (c) => {
        await c.query(
          `UPDATE core.stored_file SET visibility='SHARED_EXTERNAL'
            WHERE category='RECEIPT'`);
      }),
    ).rejects.toMatchObject({ code: '23514' });

    // 조용히 넘어가지도 않고, 값이 바뀌지도 않았다
    const vis = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT DISTINCT visibility FROM core.stored_file WHERE category='RECEIPT'`);
      return r.rows.map((x: { visibility: string }) => x.visibility);
    });
    expect(vis).toEqual(['HEAD_OFFICE_ONLY']);
  });

  it('사진이 아닌 파일은 거부한다', async () => {
    const res = await request(app).post(`/api/cost/costs/${fuelCostId}/evidence`)
      .set(auth(fieldToken)).attach('file', Buffer.from('x'), 'receipt.exe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_FILE');
  });

  it('금액이 음수면 거부한다', async () => {
    const res = await request(app).post(`/api/cost/sites/${siteId}/costs`)
      .set(auth(fieldToken)).send({ cost_type: 'C06', amount: '-1' });
    expect(res.status).toBe(400);
  });

  it('★ 같은 비용이 \'동시에\' 두 번 도착해도 한 번만 저장된다', async () => {
    // 통신이 돌아오는 순간 브라우저의 online 이벤트와 앱의 재시도가 겹치면
    // 같은 요청이 나란히 날아온다. 순차 재전송만 막아서는 부족하다.
    // (실제 브라우저에서 이 상황으로 기타경비가 두 건 저장되는 것을 확인했다)
    const reqId = randomUUID();
    const body = {
      cost_date: '2026-10-09', cost_type: 'C06', amount: '15000', vendor: '동시전송',
    };
    const send = () => request(app).post(`/api/cost/sites/${siteId}/costs`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(body);

    // 한 번에 여러 개를 던져 실제로 겹치게 만든다
    const res = await Promise.all(Array.from({ length: 6 }, send));
    for (const r of res) expect(r.status).toBe(201);
    const ids = new Set(res.map((r) => r.body.cost.id));
    expect(ids.size).toBe(1);
    // 처음 하나만 실제 저장이고 나머지는 저장된 응답을 돌려받아야 한다
    expect(res.filter((r) => r.body.replayed).length).toBe(res.length - 1);

    const n = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM private_cost.daily_cost
          WHERE site_id=$1 AND cost_date='2026-10-09'`, [siteId]);
      return r.rows[0].n as number;
    });
    expect(n).toBe(1);   // 30,000 원이 되지 않는다
  });

  it('오프라인 큐가 같은 비용을 두 번 보내도 한 번만 저장된다', async () => {
    const reqId = randomUUID();
    const body = {
      cost_date: '2026-10-06', cost_type: 'C05', amount: '48000', vendor: '현장식당',
      client_request_id: reqId,
    };
    const first = await request(app).post(`/api/cost/sites/${siteId}/costs`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(body);
    const second = await request(app).post(`/api/cost/sites/${siteId}/costs`)
      .set(auth(fieldToken)).set('X-Client-Request-Id', reqId).send(body);
    expect(first.status).toBe(201);
    expect(second.body.replayed).toBe(true);
    expect(second.body.cost.id).toBe(first.body.cost.id);

    const n = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM private_cost.daily_cost
          WHERE site_id=$1 AND cost_date='2026-10-06' AND cost_type='C05'`, [siteId]);
      return r.rows[0].n as number;
    });
    expect(n).toBe(1);   // 96,000 원이 되지 않는다
  });
});

/* ================================================ §23 레미콘 송장은 원가가 아니다 */
describe('§23 레미콘 송장사진', () => {
  it('송장은 현장도 볼 수 있게 SITE 로 남는다 (원가가 아니다)', async () => {
    const readyMixId = await withSession(HO, async (c) => {
      const r = await c.query(
        'SELECT id FROM core.daily_ready_mix WHERE daily_work_id=$1', [dailyWorkId]);
      return r.rows[0].id as string;
    });
    const res = await request(app).post(`/api/cost/ready-mix/${readyMixId}/evidence`)
      .set(auth(fieldToken)).attach('file', PNG, 'delivery.png');
    expect(res.status).toBe(201);

    const f = await withSession(HO, async (c) => {
      const r = await c.query(
        'SELECT category, visibility FROM core.stored_file WHERE id=$1', [res.body.file_id]);
      return r.rows[0];
    });
    expect(f.category).toBe('DELIVERY_NOTE');
    expect(f.visibility).toBe('SITE');
  });
});

/* ============================================ §25, §26 노무비·장비비 자동계산 */
describe('§25, §26 단가는 본사가 넣고 계산은 결정론적으로 한다 (§46)', () => {
  it('단가가 없으면 0원으로 만들지 않고 그 사실을 알린다', async () => {
    const res = await request(app)
      .post(`/api/admin/cost/daily-work/${dailyWorkId}/calculate-cost`).set(auth(headToken));
    expect(res.status).toBe(201);
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('RATE_NOT_FOUND');
    expect(res.body.calculated.find((c: { cost_type: string }) => c.cost_type === 'C01').amount)
      .toBe('0');
  });

  it('본사가 노무 단가를 등록한다', async () => {
    const res = await request(app).post('/api/admin/cost/labor-rates').set(auth(headToken))
      .send([
        { role_name: '현장관리자', pay_type: 'DAILY', rate: '250000', effective_from: '2026-01-01' },
        { role_name: '천공기 장비기사', pay_type: 'DAILY', rate: '300000', effective_from: '2026-01-01' },
        { role_name: '천공기 작업반장', pay_type: 'DAILY', rate: '280000', effective_from: '2026-01-01' },
      ]);
    expect(res.status).toBe(201);
    expect(res.body.labor_rates).toHaveLength(3);
  });

  it('본사가 장비 단가를 등록한다 (일대/월대)', async () => {
    const res = await request(app).post('/api/admin/cost/equipment-rates').set(auth(headToken))
      .send([
        { equipment_name: '천공기', charge_type: 'MONTHLY', rate: '15000000',
          effective_from: '2026-01-01' },
        { equipment_name: '펌프카', charge_type: 'DAILY', rate: '900000',
          effective_from: '2026-01-01' },
      ]);
    expect(res.status).toBe(201);
  });

  it('★ 노무비 = 인원 × 단가 (250000+300000+280000 = 830,000)', async () => {
    const res = await request(app)
      .post(`/api/admin/cost/daily-work/${dailyWorkId}/calculate-cost`).set(auth(headToken));
    const labor = res.body.calculated.find((c: { cost_type: string }) => c.cost_type === 'C01');
    expect(labor.amount).toBe('830000.00');
    expect(labor.missing_rate_count).toBe(0);
  });

  it('★ 월대 장비는 하루치로 환산한다 (15,000,000 ÷ 30 = 500,000, 펌프카 900,000)', async () => {
    const res = await request(app)
      .post(`/api/admin/cost/daily-work/${dailyWorkId}/calculate-cost`).set(auth(headToken));
    const equip = res.body.calculated.find((c: { cost_type: string }) => c.cost_type === 'C02');
    expect(equip.amount).toBe('1400000.00');
  });

  it('환산일수는 현장이 정한다 (25일이면 600,000 + 900,000)', async () => {
    await request(app).post(`/api/admin/sites/${siteId}/design-params`).set(auth(headToken))
      .send([{ param_code: 'MONTHLY_WORK_DAYS', param_name: '월 가동일수',
               param_value: 25, unit: '일' }]);
    const res = await request(app)
      .post(`/api/admin/cost/daily-work/${dailyWorkId}/calculate-cost`).set(auth(headToken));
    const equip = res.body.calculated.find((c: { cost_type: string }) => c.cost_type === 'C02');
    expect(equip.amount).toBe('1500000.00');
  });

  it('★ 여러 번 계산해도 원가가 중복 계상되지 않는다', async () => {
    await request(app).post(`/api/admin/cost/daily-work/${dailyWorkId}/calculate-cost`)
      .set(auth(headToken));
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT cost_type, count(*)::int AS n, sum(amount)::text AS total
           FROM private_cost.daily_cost
          WHERE site_id=$1 AND cost_date='2026-10-05' AND source='CALCULATED'
          GROUP BY cost_type ORDER BY cost_type`, [siteId]);
      return r.rows;
    });
    expect(rows.map((r: { n: number }) => r.n)).toEqual([1, 1]);
    expect(rows.find((r: { cost_type: string }) => r.cost_type === 'C02').total)
      .toBe('1500000.00');
  });

  it('계산근거를 남긴다 (사람이 검증할 수 있어야 한다 §46)', async () => {
    const detail = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT calc_detail FROM private_cost.daily_cost
          WHERE site_id=$1 AND cost_date='2026-10-05' AND cost_type='C01'
            AND source='CALCULATED'`, [siteId]);
      return r.rows[0].calc_detail as { items: { role_name: string; rate: string }[] };
    });
    const byRole = new Map(detail.items.map((i) => [i.role_name, i.rate]));
    // §46 단가는 문자열로 남긴다. JSON 숫자로 두면 큰 금액에서 오차가 생긴다.
    expect(byRole.get('천공기 장비기사')).toBe('300000.00');
  });

  it('같은 대상·같은 시작일에 단가를 두 개 만들 수 없다 (어느 쪽을 쓸지 모른다)', async () => {
    const res = await request(app).post('/api/admin/cost/labor-rates').set(auth(headToken))
      .send({ role_name: '현장관리자', pay_type: 'DAILY', rate: '999999', effective_from: '2026-01-01' });
    expect(res.status).toBe(201);          // 덮어쓰기(UPSERT)로 처리한다
    const n = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM private_cost.labor_rate
          WHERE role_name='현장관리자' AND effective_from='2026-01-01' AND site_id IS NULL`);
      return r.rows[0].n as number;
    });
    expect(n).toBe(1);
    // 되돌린다
    await request(app).post('/api/admin/cost/labor-rates').set(auth(headToken))
      .send({ role_name: '현장관리자', pay_type: 'DAILY', rate: '250000', effective_from: '2026-01-01' });
  });
});

/* ==================================================== §29 원가보안 (핵심) */
describe('§29 계약상대방은 원가에 어떤 경로로도 닿지 않는다', () => {
  const paths = [
    'SELECT count(*) FROM private_cost.daily_cost',
    'SELECT count(*) FROM private_cost.cost_evidence',
    'SELECT count(*) FROM private_cost.labor_rate',
    'SELECT count(*) FROM private_cost.equipment_rate',
    'SELECT count(*) FROM private_cost.v_daily_cost_summary',
    'SELECT count(*) FROM private_cost.cost_type',
  ];
  for (const sql of paths) {
    it(`차단: ${sql.replace('SELECT count(*) FROM ', '')}`, async () => {
      await expect(
        withSession(EXT, async (c) => { await c.query(sql); }),
      ).rejects.toMatchObject({ code: '42501' });
    });
  }

  it('원가계산 함수도 실행할 수 없다', async () => {
    await expect(
      withSession(EXT, async (c) => {
        await c.query(`SELECT * FROM private_cost.fn_evidence_rate(
          '00000000-0000-0000-0000-000000000000'::uuid, CURRENT_DATE, CURRENT_DATE)`);
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('★ share 스키마는 private_cost 에 어떤 의존도 갖지 않는다', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query('SELECT * FROM app.fn_share_isolation_violations()');
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it('★ core / share 에 있는 금액 컬럼은 계약금액뿐이다 (내부원가 유출 없음)', async () => {
    // §44 계약단가·계약금액은 현장관리자가 봐도 되는 값이라 core 에 있다.
    // 그 외의 금액 컬럼이 core/share 에 생기면 §29 위반이므로 즉시 깨져야 한다.
    const ALLOWED = [
      'core.contract.current_amount',
      'core.contract.original_amount',
      'core.contract_item.amount',
      'core.contract_item.unit_price',
      'core.contract_revision.contract_amount',
      'core.hole_master.contract_unit_price',
      'core.hole_revision.contract_unit_price',
    ];
    const cols = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT table_schema||'.'||table_name||'.'||column_name AS col
           FROM information_schema.columns
          WHERE table_schema IN ('core','share')
            AND (column_name ~ '(^|_)(amount|rate|price|cost)(_|$)'
                 OR column_name IN ('daily_rate','unit_price'))
          ORDER BY 1`);
      return r.rows.map((x: { col: string }) => x.col);
    });
    expect(cols).toEqual(ALLOWED);
  });
});

describe('§44 현장관리자는 비용을 입력하지만 원가를 보지 못한다', () => {
  it('단가 테이블은 GRANT 자체가 없다', async () => {
    for (const t of ['private_cost.labor_rate', 'private_cost.equipment_rate']) {
      await expect(
        withSession({ userId: fieldUserId, role: 'FIELD_MANAGER' }, async (c) => {
          await c.query(`SELECT count(*) FROM ${t}`);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('★ 원가 집계 뷰도 볼 수 없다', async () => {
    await expect(
      withSession({ userId: fieldUserId, role: 'FIELD_MANAGER' }, async (c) => {
        await c.query('SELECT count(*) FROM private_cost.v_daily_cost_summary');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('본사 전용 API 경로에 들어갈 수 없다', async () => {
    const calls = [
      request(app).post('/api/admin/cost/labor-rates').set(auth(fieldToken))
        .send({ role_name: 'X', rate: '1', effective_from: '2026-01-01' }),
      request(app).get(`/api/admin/cost/sites/${siteId}/cost-summary`).set(auth(fieldToken)),
      request(app).post(`/api/admin/cost/daily-work/${dailyWorkId}/calculate-cost`)
        .set(auth(fieldToken)),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
  });

  it('★ 자동계산된 노무비·장비비는 현장관리자 목록에 나오지 않는다 (RLS)', async () => {
    const res = await request(app).get(`/api/cost/sites/${siteId}/costs`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    const types = res.body.costs.map((c: { cost_type: string }) => c.cost_type);
    expect(types).not.toContain('C01');
    expect(types).not.toContain('C02');
    expect(JSON.stringify(res.body)).not.toContain('1500000');
  });

  it('다른 현장관리자가 입력한 비용은 보이지 않는다', async () => {
    await request(app).post(`/api/cost/sites/${siteId}/costs`).set(auth(otherToken))
      .send({ cost_date: '2026-10-07', cost_type: 'C06', amount: '77777' });
    const res = await request(app).get(`/api/cost/sites/${siteId}/costs`).set(auth(fieldToken));
    expect(JSON.stringify(res.body)).not.toContain('77777');
  });

  it('배정되지 않은 현장에는 비용을 넣을 수 없다', async () => {
    const other = await request(app).post('/api/admin/sites').set(auth(headToken))
      .send({ site_code: 'PHASE8_OTHER', site_name: '배정되지 않은 현장' });
    const res = await request(app).post(`/api/cost/sites/${other.body.site.id}/costs`)
      .set(auth(fieldToken)).send({ cost_type: 'C06', amount: '1000' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/* ==================================================== §52 증빙률 (금액 없음) */
describe('§52 현장관리자는 증빙률만 본다', () => {
  it('★ 건수만 나오고 금액은 한 푼도 나오지 않는다', async () => {
    const res = await request(app)
      .get(`/api/cost/sites/${siteId}/evidence-rate?from=2026-10-01&to=2026-10-31`)
      .set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.total_count).toBeGreaterThan(0);
    expect(res.body.verified_count).toBeGreaterThan(0);
    expect(typeof res.body.evidence_rate).toBe('string');
    // 나가는 키는 기간과 건수와 비율뿐이다. 금액을 뜻하는 키는 없다.
    expect(Object.keys(res.body).sort()).toEqual(
      ['evidence_rate', 'from', 'pending_count', 'review_count', 'to',
       'total_count', 'verified_count']);
    // 실제로 이 현장에 들어있는 금액이 응답에 섞여 나오지 않는다
    const text = JSON.stringify(res.body);
    for (const amount of ['380000', '830000', '1500000', '48000']) {
      expect(text).not.toContain(amount);
    }
  });

  it('자동계산분은 증빙 대상이 아니라 증빙률을 떨어뜨리지 않는다', async () => {
    const res = await request(app)
      .get(`/api/cost/sites/${siteId}/evidence-rate?from=2026-10-05&to=2026-10-05`)
      .set(auth(headToken));
    // 2026-10-05 에는 수동 1건(유류비, 증빙완료) + 자동 2건이 있다
    expect(res.body.total_count).toBe(1);
    expect(res.body.evidence_rate).toBe('100.0');
  });
});

/* ==================================================== 본사 집계 (§39 대비) */
describe('본사는 원가 합계를 본다', () => {
  it('일자별 합계가 항목별로 나뉜다', async () => {
    const res = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-summary?from=2026-10-01&to=2026-10-31`)
      .set(auth(headToken));
    expect(res.status).toBe(200);
    const day = res.body.daily.find((d: { cost_date: string }) =>
      d.cost_date.startsWith('2026-10-05'));
    expect(day.labor_amount).toBe('830000.00');
    expect(day.equipment_amount).toBe('1500000.00');
    expect(day.other_amount).toBe('380000.00');       // 유류비
    expect(day.total_amount).toBe('2710000.00');
    expect(day.verified_count).toBe(3);
  });

  it('항목별 합계도 6개 항목 순서를 지킨다', async () => {
    const res = await request(app)
      .get(`/api/admin/cost/sites/${siteId}/cost-summary?from=2026-10-01&to=2026-10-31`)
      .set(auth(headToken));
    const codes = res.body.by_type.map((t: { cost_type: string }) => t.cost_type);
    expect(codes).toEqual([...codes].sort());
  });
});

/* ==================================================== §43 자동검증 */
describe('§43 증빙 누락은 본사에만 알린다', () => {
  it('증빙대기 건이 있으면 본사 검증에 나온다', async () => {
    await request(app).post(`/api/cost/sites/${siteId}/costs`).set(auth(fieldToken))
      .send({ cost_date: '2026-10-08', cost_type: 'C04', amount: '52000', vendor: '철물점' });
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('COST_EVIDENCE_PENDING');
  });

  it('★ 경고 문구에도 금액은 넣지 않는다', async () => {
    const res = await request(app).get(`/api/sites/${siteId}/validation`).set(auth(headToken));
    const issue = res.body.issues.find(
      (i: { code: string }) => i.code === 'COST_EVIDENCE_PENDING');
    expect(issue.message).not.toMatch(/\d{4,}/);   // 52000 같은 금액이 없다
  });

  it('본사가 증빙대기 건을 본사확인으로 넘길 수 있다 (§28)', async () => {
    const costId = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT id FROM private_cost.daily_cost
          WHERE site_id=$1 AND cost_date='2026-10-08'`, [siteId]);
      return r.rows[0].id as string;
    });
    const res = await request(app).patch(`/api/admin/cost/costs/${costId}/evidence-status`)
      .set(auth(headToken)).send({ evidence_status: 'HEAD_OFFICE_REVIEW', memo: '영수증 분실' });
    expect(res.status).toBe(200);
    expect(res.body.evidence_status).toBe('HEAD_OFFICE_REVIEW');
  });
});

/* ==================================================== §38 이력 보존 */
describe('§38 원가도 덮어쓰지 않고 이력을 남긴다', () => {
  it('비용 입력·수정이 change_log 에 쌓인다', async () => {
    const n = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM audit.change_log
          WHERE table_name='private_cost.daily_cost'`);
      return r.rows[0].n as number;
    });
    expect(n).toBeGreaterThan(0);
  });

  it('단가 변경도 이력이 남는다', async () => {
    const n = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM audit.change_log
          WHERE table_name='private_cost.labor_rate'`);
      return r.rows[0].n as number;
    });
    expect(n).toBeGreaterThan(0);
  });
});
