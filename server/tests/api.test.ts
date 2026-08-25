/** API 계층 테스트 — 인증 / 현장 / 천공번호 범위선택 / 자동검증 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login, siteIdByCode } from './helpers.js';
import { closePool } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

describe('인증', () => {
  it('올바른 자격으로 로그인한다', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ login_id: 'head01', password: 'test1234!' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('HEAD_OFFICE');
    expect(res.body.token).toBeTruthy();
  });

  it('잘못된 비밀번호는 401 이며 계정 존재 여부를 알려주지 않는다', async () => {
    const wrongPw = await request(app).post('/api/auth/login')
      .send({ login_id: 'head01', password: 'wrong' });
    const noUser = await request(app).post('/api/auth/login')
      .send({ login_id: 'nobody', password: 'wrong' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.message).toBe(noUser.body.message);
  });

  it('토큰 없이 보호된 자원에 접근하면 401', async () => {
    const res = await request(app).get('/api/sites');
    expect(res.status).toBe(401);
  });

  it('/me 는 접근 가능한 현장을 함께 돌려준다', async () => {
    const token = await login('field02');
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.sites.map((s: { site_code: string }) => s.site_code)).toEqual(['TEST_SITE_02']);
  });
});

describe('§19 천공번호 범위 선택', () => {
  it('from~to 범위로 조회하면 해당 구간만 순서대로 나온다', async () => {
    const token = await login('field01');
    const siteId = await siteIdByCode(token, 'TEST_SITE_01');
    const res = await request(app)
      .get(`/api/sites/${siteId}/holes?from=A-031&to=A-044`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // 시드는 A-030 까지만 존재하므로 A-031~A-044 는 0건
    expect(res.body.count).toBe(0);

    const res2 = await request(app)
      .get(`/api/sites/${siteId}/holes?from=A-005&to=A-014`)
      .set('Authorization', `Bearer ${token}`);
    expect(res2.body.count).toBe(10);
    expect(res2.body.holes[0].hole_no).toBe('A-005');
    expect(res2.body.holes[9].hole_no).toBe('A-014');
  });

  it('§20 범위별 지층 자동집계 API 가 동작한다', async () => {
    const token = await login('field01');
    const siteId = await siteIdByCode(token, 'TEST_SITE_01');
    const res = await request(app)
      .get(`/api/sites/${siteId}/layer-summary?from=A-001&to=A-010`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.total.hole_count).toBe(10);
    expect(res.body.total.total_length).toBe('200.000');
    expect(res.body.layers).toHaveLength(2);
  });
});

describe('§43 자동 검증', () => {
  it('정상 시드 현장은 ERROR 가 0건이다', async () => {
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'TEST_SITE_01');
    const res = await request(app)
      .get(`/api/sites/${siteId}/validation`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.error_count).toBe(0);
  });

  it('계획심도가 지반조건 총심도와 다르면 ERROR 로 검출된다', async () => {
    const { withSession } = await import('../src/db/pool.js');
    const token = await login('head01');
    const siteId = await siteIdByCode(token, 'TEST_SITE_01');
    await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET design_depth_total = 21.0
          WHERE hole_no='A-020' AND site_id=$1`, [siteId]);
    });
    const res = await request(app)
      .get(`/api/sites/${siteId}/validation`).set('Authorization', `Bearer ${token}`);
    const codes = res.body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('DESIGN_DEPTH_MISMATCH');
    // 원복
    await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET design_depth_total = 20.0
          WHERE hole_no='A-020' AND site_id=$1`, [siteId]);
    });
  });
});

describe('§13 도면 표시상태는 저장하지 않고 파생한다', () => {
  it('완료일이 오늘이면 금일완료, 과거면 기존완료', async () => {
    const { withSession } = await import('../src/db/pool.js');
    const rows = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      await c.query(
        `UPDATE core.hole_master SET status='COMPLETED', construction_date=CURRENT_DATE,
                actual_depth_total=20.0
          WHERE hole_no='A-011'
            AND site_id=(SELECT id FROM core.site WHERE site_code='TEST_SITE_01')`);
      await c.query(
        `UPDATE core.hole_master SET status='COMPLETED', construction_date=CURRENT_DATE - 3,
                actual_depth_total=20.0
          WHERE hole_no='A-012'
            AND site_id=(SELECT id FROM core.site WHERE site_code='TEST_SITE_01')`);
      const r = await c.query(
        `SELECT hole_no, display_status FROM core.v_hole_status
          WHERE site_id = (SELECT id FROM core.site WHERE site_code='TEST_SITE_01')
            AND hole_no IN ('A-011','A-012','A-013') ORDER BY hole_no`);
      return r.rows as { hole_no: string; display_status: string }[];
    });
    expect(rows).toEqual([
      { hole_no: 'A-011', display_status: '금일완료' },
      { hole_no: 'A-012', display_status: '기존완료' },
      { hole_no: 'A-013', display_status: '미시공' },
    ]);
  });
});
