/**
 * 계정 관리 테스트 — PHASE 15 운영 보완
 *
 * "어떤 파일을 들어가서 셋팅하는지 모르겠다" (사용자, 2026-08-30)
 * → 계정 생성·비밀번호 재설정·중지가 전부 웹 API 로 끝나야 한다.
 *   본사 전용이고, 마지막 본사 계정은 스스로 잠글 수 없다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login } from './helpers.js';
import { closePool } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let headToken = '';
let fieldToken = '';

beforeAll(async () => {
  headToken = await login('head01');
  fieldToken = await login('field01');
});

describe('권한 — 본사만 계정을 관리한다', () => {
  it('현장관리자는 목록을 볼 수 없다 (403)', async () => {
    const r = await request(app).get('/api/admin/users').set(auth(fieldToken));
    expect(r.status).toBe(403);
  });

  it('현장관리자는 계정을 만들 수 없다 (403)', async () => {
    const r = await request(app).post('/api/admin/users').set(auth(fieldToken))
      .send({ login_id: 'sneaky', password: 'password123', display_name: 'X', role: 'HEAD_OFFICE' });
    expect(r.status).toBe(403);
  });

  it('로그인 없이는 아무것도 못 한다 (401)', async () => {
    const r = await request(app).get('/api/admin/users');
    expect(r.status).toBe(401);
  });
});

describe('계정 수명주기 — 생성 → 비밀번호 재설정 → 중지 → 재개', () => {
  let userId = '';

  it('본사가 현장관리자 계정을 만든다', async () => {
    const r = await request(app).post('/api/admin/users').set(auth(headToken))
      .send({ login_id: 'au-test-fm', password: 'first-pw-123', display_name: '테스트 기사',
              role: 'FIELD_MANAGER' });
    expect(r.status).toBe(201);
    expect(r.body.user.login_id).toBe('au-test-fm');
    userId = r.body.user.id;
  });

  it('만든 계정으로 바로 로그인된다', async () => {
    const r = await request(app).post('/api/auth/login')
      .send({ login_id: 'au-test-fm', password: 'first-pw-123' });
    expect(r.status).toBe(200);
  });

  it('목록에 새 계정이 보인다', async () => {
    const r = await request(app).get('/api/admin/users').set(auth(headToken));
    expect(r.status).toBe(200);
    const u = r.body.users.find((x: { login_id: string }) => x.login_id === 'au-test-fm');
    expect(u).toBeTruthy();
    expect(u.is_active).toBe(true);
  });

  it('같은 아이디로 또 만들면 거부된다', async () => {
    const r = await request(app).post('/api/admin/users').set(auth(headToken))
      .send({ login_id: 'au-test-fm', password: 'other-pw-123', display_name: '중복', role: 'FIELD_MANAGER' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('DUPLICATE_LOGIN_ID');
  });

  it('비밀번호를 재설정하면 새 비밀번호로만 로그인된다', async () => {
    const reset = await request(app).post(`/api/admin/users/${userId}/reset-password`)
      .set(auth(headToken)).send({ password: 'second-pw-456' });
    expect(reset.status).toBe(200);

    const oldPw = await request(app).post('/api/auth/login')
      .send({ login_id: 'au-test-fm', password: 'first-pw-123' });
    expect(oldPw.status).toBe(401);

    const newPw = await request(app).post('/api/auth/login')
      .send({ login_id: 'au-test-fm', password: 'second-pw-456' });
    expect(newPw.status).toBe(200);
  });

  it('중지하면 맞는 비밀번호로도 로그인이 막힌다', async () => {
    const r = await request(app).patch(`/api/admin/users/${userId}`)
      .set(auth(headToken)).send({ is_active: false });
    expect(r.status).toBe(200);
    expect(r.body.user.is_active).toBe(false);

    const blocked = await request(app).post('/api/auth/login')
      .send({ login_id: 'au-test-fm', password: 'second-pw-456' });
    expect(blocked.status).toBe(401);
  });

  it('재개하면 다시 로그인된다', async () => {
    await request(app).patch(`/api/admin/users/${userId}`)
      .set(auth(headToken)).send({ is_active: true });
    const r = await request(app).post('/api/auth/login')
      .send({ login_id: 'au-test-fm', password: 'second-pw-456' });
    expect(r.status).toBe(200);
  });
});

describe('입력 검증', () => {
  it('아이디 형식이 틀리면 400 (한글·대문자·너무 짧음)', async () => {
    for (const bad of ['한글아이디', 'UPPER', 'ab']) {
      const r = await request(app).post('/api/admin/users').set(auth(headToken))
        .send({ login_id: bad, password: 'password123', display_name: 'X', role: 'FIELD_MANAGER' });
      expect(r.status, bad).toBe(400);
    }
  });

  it('비밀번호 8자 미만은 400', async () => {
    const r = await request(app).post('/api/admin/users').set(auth(headToken))
      .send({ login_id: 'au-shortpw', password: 'short', display_name: 'X', role: 'FIELD_MANAGER' });
    expect(r.status).toBe(400);
  });

  it('경로의 아이디가 UUID 가 아니면 500 이 아니라 400 이다', async () => {
    const r = await request(app).patch('/api/admin/users/not-a-uuid')
      .set(auth(headToken)).send({ is_active: false });
    expect(r.status).toBe(400);
  });

  it('없는 계정은 404', async () => {
    const r = await request(app)
      .post('/api/admin/users/00000000-0000-4000-8000-000000000000/reset-password')
      .set(auth(headToken)).send({ password: 'whatever-123' });
    expect(r.status).toBe(404);
  });
});

describe('마지막 본사 계정 보호', () => {
  it('본사 계정이 하나뿐이면 중지할 수 없다', async () => {
    // head01 외 다른 본사 계정을 전부 확인하고, 실제로 남은 활성 본사가 1개인 상황을 만들지 않고
    // 규칙 자체를 검증한다: 활성 본사 전부를 중지 시도하면 마지막 하나는 반드시 거부돼야 한다.
    const list = await request(app).get('/api/admin/users').set(auth(headToken));
    const activeHq = list.body.users.filter(
      (u: { role: string; is_active: boolean }) => u.role === 'HEAD_OFFICE' && u.is_active);

    let refused = 0;
    const stopped: string[] = [];
    for (const u of activeHq) {
      const r = await request(app).patch(`/api/admin/users/${u.id}`)
        .set(auth(headToken)).send({ is_active: false });
      if (r.status === 400 && r.body.error === 'LAST_HEAD_OFFICE') refused += 1;
      else if (r.status === 200) stopped.push(u.id);
    }
    expect(refused).toBe(1);

    // 원상복구
    for (const id of stopped) {
      await request(app).patch(`/api/admin/users/${id}`)
        .set(auth(headToken)).send({ is_active: true });
    }
  });
});
