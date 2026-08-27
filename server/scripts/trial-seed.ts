/**
 * 시험사용용 현장 하나를 만든다.
 *
 * 실제 계약 데이터가 아니라 **시험용 값**이다.
 * 현장관리자가 앱을 처음 열었을 때 바로 입력해 볼 수 있는 상태를 만든다.
 */
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closePool, withSession } from '../src/db/pool.js';

const SITE_CODE = 'TRIAL_01';

async function main(): Promise<void> {
  const app = createApp();
  const login = async (id: string) => {
    const r = await request(app).post('/api/auth/login')
      .send({ login_id: id, password: 'test1234!' });
    return r.body.token as string;
  };
  const token = await login('head01');
  const auth = { Authorization: `Bearer ${token}` };

  const existing = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
    const r = await c.query('SELECT id FROM core.site WHERE site_code=$1', [SITE_CODE]);
    return r.rows[0]?.id as string | undefined;
  });
  if (existing) {
    console.log(`[trial] ${SITE_CODE} 이미 있음 — 건너뜀`);
    await closePool();
    return;
  }

  const site = await request(app).post('/api/admin/sites').set(auth)
    .send({ site_code: SITE_CODE, site_name: '시험현장 RF CIP', client_name: '시험원도급(주)' });
  const id = site.body.site.id as string;

  await request(app).post(`/api/admin/sites/${id}/hole-types`).set(auth)
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${id}/ground-types`).set(auth)
    .send([
      { code: 'G01', name: '토사', sort_order: 1 },
      { code: 'G02', name: '풍화암', sort_order: 2 },
      { code: 'G03', name: '연암', sort_order: 3, status: 'PROVISIONAL' },
    ]);
  await request(app).post(`/api/admin/sites/${id}/holes/bulk`).set(auth)
    .send({
      spec: { mode: 'RANGE', prefix: 'A-', start: 1, end: 60, digits: 3 },
      hole_type_code: 'HPILE', assign_drawing_sequence: true,
      design_depth_total: '20', contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${id}/ground-assignments/apply`).set(auth)
    .send({
      profile_name: 'A구간 표준', total_planned_depth: '20',
      layers: [
        { ground_type_code: 'G01', planned_length: '14' },
        { ground_type_code: 'G02', planned_length: '6' },
      ],
    });
  await request(app).post(`/api/admin/sites/${id}/default-labor`).set(auth)
    .send([
      { role_name: '현장관리자', headcount: 1, sort_order: 1 },
      { role_name: '천공기 장비기사', headcount: 1, sort_order: 2 },
      { role_name: '천공기 작업반장', headcount: 1, sort_order: 3 },
      { role_name: '펌프카 기사', headcount: 1, sort_order: 4 },
    ]);
  await request(app).post(`/api/admin/sites/${id}/default-equipment`).set(auth)
    .send([
      { equipment_name: '천공기', charge_type: 'MONTHLY', quantity: 1, sort_order: 1 },
      { equipment_name: '펌프카', charge_type: 'DAILY', quantity: 1, sort_order: 2 },
      { equipment_name: '백호(06)', charge_type: 'DAILY', quantity: 1, sort_order: 3 },
    ]);
  await request(app).post(`/api/admin/sites/${id}/design-params`).set(auth)
    .send([
      { param_code: 'DIAMETER', param_name: '천공 직경', param_value: 0.6, unit: 'm' },
      { param_code: 'CONCRETE_PI', param_name: '산출 π', param_value: 3.14 },
      { param_code: 'CONCRETE_SURCHARGE', param_name: '콘크리트 할증률', param_value: 2, unit: '%' },
    ]);

  // 시험 사용자는 이 현장 하나만 배정한다 (현장선택 화면을 건너뛰기 위해)
  const trialUser = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
    const r = await c.query(
      `INSERT INTO core.app_user (login_id, password_hash, display_name, role)
       VALUES ('trial', (SELECT password_hash FROM core.app_user WHERE login_id='field01'),
               '시험 현장관리자', 'FIELD_MANAGER')
       ON CONFLICT (login_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${id}/users`).set(auth).send({ user_id: trialUser });

  console.log(`[trial] ${SITE_CODE} 준비완료 — 미시공 60공, 공당 20m`);
  console.log('[trial] 시험 계정:  아이디 trial  /  비밀번호 test1234!');
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });
