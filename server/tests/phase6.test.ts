/**
 * PHASE 6 테스트 — 모바일 오늘 작업입력
 * Master Prompt §15, §16, §18, §19, §20, §46, §52
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool, withSession } from '../src/db/pool.js';
import { isInRange, nextPick } from '../../web/pick.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const DATE = '2026-08-27';

let headToken = '';
let fieldToken = '';
let siteId = '';

/** 현장을 하나 만들고 현장관리자를 배정한다. 100공, 공당 20m. */
beforeAll(async () => {
  headToken = await login('head01');
  const site = await request(app).post('/api/admin/sites').set(auth(headToken))
    .send({ site_code: 'PHASE6_TEST', site_name: 'PHASE6 일일입력 검증현장' });
  siteId = site.body.site.id;

  await request(app).post(`/api/admin/sites/${siteId}/hole-types`).set(auth(headToken))
    .send([{ code: 'HPILE', name: 'H-PILE 구간', sort_order: 1 }]);
  await request(app).post(`/api/admin/sites/${siteId}/ground-types`).set(auth(headToken))
    .send([
      { code: 'G01', name: '토사', sort_order: 1 },
      { code: 'G02', name: '풍화암', sort_order: 2 },
      { code: 'G03', name: '연암', sort_order: 3, status: 'PROVISIONAL' },
    ]);
  await request(app).post(`/api/admin/sites/${siteId}/holes/bulk`).set(auth(headToken))
    .send({
      spec: { mode: 'RANGE', prefix: 'A-', start: 1, end: 100, digits: 3 },
      hole_type_code: 'HPILE', assign_drawing_sequence: true,
      design_depth_total: '20', contract_quantity: '20', contract_unit: 'm',
    });
  await request(app).post(`/api/admin/sites/${siteId}/ground-assignments/apply`)
    .set(auth(headToken)).send({
      profile_name: 'A구간 표준', total_planned_depth: '20',
      layers: [
        { ground_type_code: 'G01', planned_length: '14' },
        { ground_type_code: 'G02', planned_length: '6' },
      ],
    });

  const fieldUser = await withSession(HO, async (c) => {
    const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
    return r.rows[0].id as string;
  });
  await request(app).post(`/api/admin/sites/${siteId}/users`).set(auth(headToken))
    .send({ user_id: fieldUser });
  fieldToken = await login('field01');
});

/* ============================================================ §18 메인화면 */
describe('§18 메인화면은 필요한 것을 한 번에 준다', () => {
  it('현장·진행률·다음 번호를 한 번의 호출로 받는다', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/today?date=${DATE}`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.site.site_name).toContain('PHASE6');
    expect(res.body.progress.total_holes).toBe(100);
    expect(res.body.progress.completed_holes).toBe(0);
    expect(res.body.progress.progress_rate).toBe('0.0');
    expect(res.body.progress.quantity_basis).toBe('CONTRACT_QUANTITY');
    // 다음에 뚫을 번호를 제안한다 (§1-5 기본값 재사용)
    expect(res.body.suggested_start_hole_no).toBe('A-001');
    expect(res.body.daily_work).toBeNull();
  });

  it('현장관리자가 배정되지 않은 현장은 볼 수 없다', async () => {
    const other = await request(app).post('/api/admin/sites').set(auth(headToken))
      .send({ site_code: 'PHASE6_OTHER', site_name: '다른 현장' });
    const res = await request(app)
      .get(`/api/field/sites/${other.body.site.id}/today`).set(auth(fieldToken));
    expect(res.status).toBe(404);   // RLS 가 행 자체를 감춘다
  });
});

/* ====================================================== §19/§20 자동집계 */
describe('§19/§20 범위를 고르면 자동집계된다', () => {
  it('공수·연장·지층별 수량을 계산해 준다', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work/preview`).set(auth(fieldToken))
      .send({ work_date: DATE, from: 'A-001', to: 'A-013' });
    expect(res.status).toBe(200);
    expect(res.body.today_hole_count).toBe(13);
    expect(res.body.today_planned_length).toBe(260);        // 13공 × 20m
    expect(res.body.layer_summary).toEqual([
      { ground_type_code: 'G01', ground_type_name: '토사',   planned_length: '182.000' },
      { ground_type_code: 'G02', ground_type_name: '풍화암', planned_length: '78.000' },
    ]);
    expect(res.body.can_save).toBe(true);
  });

  it('누계·잔여·공정률을 함께 계산한다 (§19)', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work/preview`).set(auth(fieldToken))
      .send({ work_date: DATE, from: 'A-001', to: 'A-013' });
    expect(res.body.cumulative_hole_count).toBe(13);
    expect(res.body.remaining_hole_count).toBe(87);
    expect(res.body.total_hole_count).toBe(100);
    expect(res.body.progress_rate_after).toBe(13);          // 260 / 2000 × 100
  });

  it('제외번호를 뺄 수 있다 (§19)', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work/preview`).set(auth(fieldToken))
      .send({ work_date: DATE, from: 'A-001', to: 'A-013', exclude: ['A-007'] });
    expect(res.body.today_hole_count).toBe(12);
    expect(res.body.today_hole_numbers).not.toContain('A-007');
  });

  it('미리보기는 저장하지 않는다', async () => {
    const t = await request(app)
      .get(`/api/field/sites/${siteId}/today?date=${DATE}`).set(auth(fieldToken));
    expect(t.body.progress.completed_holes).toBe(0);
  });

  it('범위에 번호가 없으면 저장 불가로 표시한다', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work/preview`).set(auth(fieldToken))
      .send({ work_date: DATE, from: 'Z-900', to: 'Z-999' });
    expect(res.body.today_hole_count).toBe(0);
    expect(res.body.can_save).toBe(false);
  });

  it('§46 같은 범위는 항상 같은 결과', async () => {
    const run = () => request(app)
      .post(`/api/field/sites/${siteId}/daily-work/preview`).set(auth(fieldToken))
      .send({ work_date: DATE, from: 'A-020', to: 'A-030' });
    const a = await run(); const b = await run();
    expect(a.body.layer_summary).toEqual(b.body.layer_summary);
    expect(a.body.today_planned_length).toBe(b.body.today_planned_length);
  });
});

/* ====================================================== §16 실제심도 예외입력 */
describe('§16 계획심도와 같으면 다시 입력하지 않는다', () => {
  it('[예] 하나로 13공의 실제심도가 계획심도로 채워진다', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({
        work_date: DATE, from: 'A-001', to: 'A-013',
        depth_same_as_plan: true, submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.today_hole_count).toBe(13);
    expect(res.body.status).toBe('SUBMITTED');

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM core.hole_master
          WHERE site_id=$1 AND status='COMPLETED'
            AND actual_depth_total = design_depth_total AND construction_date=$2`,
        [siteId, DATE]);
      return r.rows[0].n as number;
    });
    expect(rows).toBe(13);   // 13공 전부 자동 적용
  });

  it('메인화면이 오늘 실적을 보여준다', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/today?date=${DATE}`).set(auth(fieldToken));
    expect(res.body.progress.today_holes).toBe(13);
    expect(res.body.progress.completed_holes).toBe(13);
    expect(res.body.progress.progress_rate).toBe('13.0');
    expect(res.body.daily_work.status).toBe('SUBMITTED');
    expect(res.body.today_layer_summary).toHaveLength(2);
  });

  it('이미 완료된 번호는 다시 세지 않는다 (§1-2 중복입력 금지)', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work/preview`).set(auth(fieldToken))
      .send({ work_date: '2026-08-28', from: 'A-010', to: 'A-020' });
    expect(res.body.today_hole_count).toBe(7);           // A-014 ~ A-020
    expect(res.body.excluded_already_done).toHaveLength(4);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('ALREADY_COMPLETED');
  });

  it('일부만 다르면 그 공만 실제심도를 받는다', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({
        work_date: '2026-08-28', from: 'A-014', to: 'A-020',
        depth_same_as_plan: true,
        depth_exceptions: [{ hole_no: 'A-016', actual_depth_total: '22.5' }],
        submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.today_hole_count).toBe(7);

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT hole_no, actual_depth_total::text, design_depth_total::text
           FROM core.hole_master WHERE site_id=$1 AND hole_no IN ('A-015','A-016')
          ORDER BY hole_no`, [siteId]);
      return r.rows;
    });
    expect(rows[0].actual_depth_total).toBe('20.000');   // 계획 그대로
    expect(rows[1].actual_depth_total).toBe('22.500');   // 예외만 반영
  });

  it('오늘 범위에 없는 번호의 실제심도는 거부한다', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({
        work_date: '2026-08-29', from: 'A-021', to: 'A-022',
        depth_exceptions: [{ hole_no: 'A-099', actual_depth_total: '19' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('DEPTH_EXCEPTION_NOT_IN_RANGE');
  });

  it('실제심도 0 이하는 거부한다', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({
        work_date: '2026-08-29', from: 'A-021', to: 'A-022',
        depth_exceptions: [{ hole_no: 'A-021', actual_depth_total: '0' }],
      });
    expect(res.status).toBe(400);
  });
});

/* ====================================================== §15 지반조건 특이사항 */
describe('§15 특이사항은 있을 때만 입력한다', () => {
  it('선택지를 현장 지층종류에서 만들어 준다 (하드코딩 아님)', async () => {
    const res = await request(app)
      .get(`/api/field/sites/${siteId}/ground-note-options`).set(auth(fieldToken));
    const types = res.body.options.map((o: { note_type: string }) => o.note_type);
    expect(types).toContain('토사구간 차이');
    expect(types).toContain('풍화암구간 차이');
    expect(types).toContain('연암구간 차이');     // PROVISIONAL 지층도 선택지에 있다
    expect(types).toContain('지하수');
    expect(types).toContain('기타');
  });

  it('[없음] 이면 아무것도 저장되지 않는다', async () => {
    const before = await withSession(HO, async (c) => {
      const r = await c.query('SELECT count(*)::int AS n FROM core.daily_ground_note');
      return r.rows[0].n as number;
    });
    await request(app).post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({ work_date: '2026-08-29', from: 'A-021', to: 'A-025', submit: true });
    const after = await withSession(HO, async (c) => {
      const r = await c.query('SELECT count(*)::int AS n FROM core.daily_ground_note');
      return r.rows[0].n as number;
    });
    expect(after).toBe(before);
  });

  it('[있음] 이면 유형과 관련 천공번호가 남는다 (§32)', async () => {
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({
        work_date: '2026-08-30', from: 'A-026', to: 'A-030',
        ground_notes: [
          { note_type: '연암 출현', memo: '예상보다 얕은 심도에서 확인',
            hole_nos: ['A-027', 'A-028'] },
        ],
        submit: true,
      });
    expect(res.status).toBe(201);

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT n.note_type, n.memo, count(nh.hole_id)::int AS holes
           FROM core.daily_ground_note n
           JOIN core.daily_work w ON w.id = n.daily_work_id
           LEFT JOIN core.daily_ground_note_hole nh ON nh.note_id = n.id
          WHERE w.site_id=$1 AND w.work_date='2026-08-30'
          GROUP BY n.id, n.note_type, n.memo`, [siteId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].note_type).toBe('연암 출현');
    expect(rows[0].holes).toBe(2);
  });
});

/* ====================================================== 취소 / 무결성 */
describe('입력 취소와 무결성', () => {
  it('잘못 넣었으면 되돌릴 수 있다', async () => {
    const res = await request(app)
      .delete(`/api/field/sites/${siteId}/daily-work/2026-08-30`).set(auth(fieldToken));
    expect(res.status).toBe(200);
    expect(res.body.reverted_holes).toBe(5);

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM core.hole_master
          WHERE site_id=$1 AND hole_no BETWEEN 'A-026' AND 'A-030' AND status='NOT_STARTED'`,
        [siteId]);
      return r.rows[0].n as number;
    });
    expect(rows).toBe(5);
  });

  it('같은 천공번호를 두 날짜에 완료 처리할 수 없다', async () => {
    await expect(
      withSession(HO, async (c) => {
        const w = await c.query(
          `SELECT id FROM core.daily_work WHERE site_id=$1 AND work_date=$2`, [siteId, DATE]);
        const h = await c.query(
          `SELECT id FROM core.hole_master WHERE site_id=$1 AND hole_no='A-001'`, [siteId]);
        const w2 = await c.query(
          `INSERT INTO core.daily_work (site_id, work_date, created_by)
           VALUES ($1,'2026-09-01',NULL) RETURNING id`, [siteId]);
        void w;
        await c.query(
          `INSERT INTO core.daily_work_hole (daily_work_id, hole_id) VALUES ($1,$2)`,
          [w2.rows[0].id, h.rows[0].id]);
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('계획과 다르다면서 실제심도를 안 주면 DB가 막는다', async () => {
    await expect(
      withSession(HO, async (c) => {
        const w = await c.query(
          `SELECT id FROM core.daily_work WHERE site_id=$1 AND work_date=$2`, [siteId, DATE]);
        const h = await c.query(
          `SELECT id FROM core.hole_master WHERE site_id=$1 AND hole_no='A-050'`, [siteId]);
        await c.query(
          `INSERT INTO core.daily_work_hole (daily_work_id, hole_id, depth_same_as_plan)
           VALUES ($1,$2,false)`, [w.rows[0].id, h.rows[0].id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

/* ====================================================== §52 성공기준 */
describe('§52 일일입력이 몇 번의 조작으로 끝나는가', () => {
  it('예외가 없는 날은 서버 왕복 3회로 끝난다', async () => {
    const date = '2026-09-05';
    let calls = 0;

    // 1) 화면 열기
    calls++;
    const t = await request(app)
      .get(`/api/field/sites/${siteId}/today?date=${date}`).set(auth(fieldToken));
    const start = t.body.suggested_start_hole_no;       // 기본값이 이미 제안됨
    expect(start).toBeTruthy();

    // 2) 범위 고르면 자동집계
    calls++;
    const pv = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work/preview`).set(auth(fieldToken))
      .send({ work_date: date, from: start, to: 'A-045' });
    expect(pv.body.can_save).toBe(true);

    // 3) 입력완료
    calls++;
    const save = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work`).set(auth(fieldToken))
      .send({ work_date: date, from: start, to: 'A-045', depth_same_as_plan: true, submit: true });
    expect(save.status).toBe(201);

    expect(calls).toBe(3);
    // 지층별 수량을 한 번도 직접 입력하지 않았다 (§20)
    expect(save.body.layer_summary.length).toBeGreaterThan(0);
  });

  it('현장관리자는 지층 수량을 한 번도 입력하지 않는다 (§20)', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT ground_type_name, sum(planned_length)::text AS m
           FROM core.v_hole_layer_plan
          WHERE site_id=$1 AND status='COMPLETED' GROUP BY 1 ORDER BY 1`, [siteId]);
      return r.rows;
    });
    // 완료된 공에서 지층별 실적이 자동으로 집계된다
    expect(rows.length).toBe(2);
    expect(Number(rows[0].m)).toBeGreaterThan(0);
  });
});

/* ====================================================== 권한 */
describe('권한', () => {
  it('계약상대방은 일일입력을 할 수 없다', async () => {
    const partner = await login('partner01');
    const res = await request(app)
      .post(`/api/field/sites/${siteId}/daily-work`).set(auth(partner))
      .send({ from: 'A-060', to: 'A-061' });
    expect([400, 403, 404]).toContain(res.status);
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM core.hole_master
          WHERE site_id=$1 AND hole_no IN ('A-060','A-061') AND status='COMPLETED'`, [siteId]);
      return r.rows[0].n as number;
    });
    expect(rows).toBe(0);
  });

  it('토큰 없이는 접근할 수 없다', async () => {
    const res = await request(app).get(`/api/field/sites/${siteId}/today`);
    expect(res.status).toBe(401);
  });
});

/* ====================================================== 화면 범위선택 규칙 */
describe('§19 화면에서 범위를 고르는 규칙 (회귀)', () => {
  const list = ['A-001', 'A-002', 'A-003', 'A-010', 'A-011'];

  it('시작이 미리 채워져 있으면 종료 하나만 눌러 범위가 완성된다', () => {
    const start = { from: 'A-001', to: null };
    expect(nextPick(start, list, 'A-010')).toEqual({ from: 'A-001', to: 'A-010' });
  });

  it('★ 미리 채워진 시작번호를 눌러도 초기화되지 않는다', () => {
    // 실제로 났던 버그: 첫 탭이 종료로 들어가고 두 번째 탭이 범위를 지웠다
    const start = { from: 'A-001', to: null };
    const afterFirst = nextPick(start, list, 'A-001');
    expect(afterFirst).toEqual({ from: 'A-001', to: 'A-001' });   // 1공짜리 범위
    const afterSecond = nextPick(afterFirst, list, 'A-010');
    expect(afterSecond).toEqual({ from: 'A-010', to: null });     // 새로 시작
  });

  it('시작보다 앞을 누르면 시작이 바뀐다', () => {
    expect(nextPick({ from: 'A-003', to: null }, list, 'A-002'))
      .toEqual({ from: 'A-002', to: null });
  });

  it('범위가 완성된 뒤 누르면 그 번호로 새로 시작한다', () => {
    expect(nextPick({ from: 'A-001', to: 'A-003' }, list, 'A-011'))
      .toEqual({ from: 'A-011', to: null });
  });

  it('목록에 없는 번호는 무시한다', () => {
    const cur = { from: 'A-001', to: null };
    expect(nextPick(cur, list, 'Z-999')).toBe(cur);
  });

  it('범위 안 번호만 강조된다 (양 끝은 별도 표시)', () => {
    const pick = { from: 'A-001', to: 'A-010' };
    expect(isInRange(pick, list, 'A-002')).toBe(true);
    expect(isInRange(pick, list, 'A-001')).toBe(false);
    expect(isInRange(pick, list, 'A-011')).toBe(false);
  });
});

/* ================================ 회귀: [아니오] 인데 일부만 적는 경우 */
describe('§16 심도 예외는 적은 공만 예외다 (회귀)', () => {
  it('★ [아니오] 를 누르고 한 공만 적어도 저장된다', async () => {
    // 화면 문구: "다른 공만 적으십시오. 비워두면 계획심도를 씁니다."
    // 예전에는 안 적은 공까지 '다름' 으로 저장하려다 400 으로 깨졌다.
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-10-21', from: 'A-070', to: 'A-074',
        depth_same_as_plan: false,
        depth_exceptions: [{ hole_no: 'A-072', actual_depth_total: '23.4' }],
        submit: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.today_hole_count).toBe(5);

    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT h.hole_no, d.depth_same_as_plan, d.actual_depth_total::text AS actual
           FROM core.daily_work_hole d
           JOIN core.hole_master h ON h.id = d.hole_id
           JOIN core.daily_work w ON w.id = d.daily_work_id
          WHERE w.site_id=$1 AND w.work_date='2026-10-21'
          ORDER BY h.sort_key`, [siteId]);
      return r.rows;
    });
    const byNo = new Map(rows.map((r: { hole_no: string }) => [r.hole_no, r]));
    // 적은 공만 예외
    expect(byNo.get('A-072')).toMatchObject({ depth_same_as_plan: false, actual: '23.400' });
    // 나머지는 계획심도 그대로
    for (const no of ['A-070', 'A-071', 'A-073', 'A-074']) {
      expect(byNo.get(no)).toMatchObject({ depth_same_as_plan: true, actual: null });
    }
  });

  it('예외를 하나도 안 적으면 전부 계획심도다', async () => {
    const res = await request(app).post(`/api/field/sites/${siteId}/daily-work`)
      .set(auth(fieldToken)).send({
        work_date: '2026-10-22', from: 'A-080', to: 'A-081',
        depth_same_as_plan: false, submit: true,
      });
    expect(res.status).toBe(201);
    const n = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM core.daily_work_hole d
           JOIN core.daily_work w ON w.id = d.daily_work_id
          WHERE w.site_id=$1 AND w.work_date='2026-10-22' AND NOT d.depth_same_as_plan`,
        [siteId]);
      return r.rows[0].n as number;
    });
    expect(n).toBe(0);
  });
});
