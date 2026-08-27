/**
 * 권한/보안 테스트 — Master Prompt §29, §41, §44
 * 핵심: "프론트엔드에서 숨기는 것만으로 구현하지 않는다. DB/API 권한단계에서 차단한다."
 * 따라서 API 뿐 아니라 DB 역할로 직접 접속해서도 차단되는지 확인한다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, login, siteIdByCode } from './helpers.js';
import { closePool, pool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

describe('§44 역할 분리', () => {
  it('현장관리자는 배정된 현장만 조회한다', async () => {
    const token = await login('field01');
    const res = await request(app).get('/api/sites').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const codes = res.body.sites.map((s: { site_code: string }) => s.site_code);
    expect(codes).toContain('TEST_SITE_01');
    // 배정되지 않은 현장은 절대 보이지 않는다
    expect(codes).not.toContain('TEST_SITE_02');
    expect(codes).not.toContain('SAMPLE_RFCIP_01');
  });

  it('본사는 전체 현장을 조회한다', async () => {
    const token = await login('head01');
    const res = await request(app).get('/api/sites').set('Authorization', `Bearer ${token}`);
    const codes = res.body.sites.map((s: { site_code: string }) => s.site_code);
    // 시드 현장이 모두 보여야 한다 (다른 테스트가 만든 현장이 더 있을 수 있다)
    expect(codes).toEqual(expect.arrayContaining(
      ['SAMPLE_RFCIP_01', 'TEST_SITE_01', 'TEST_SITE_02']));
    expect(codes.length).toBeGreaterThanOrEqual(3);
  });

  it('현장관리자는 타 현장 천공번호를 조회할 수 없다 (RLS)', async () => {
    const head = await login('head01');
    const otherSite = await siteIdByCode(head, 'TEST_SITE_02');
    const field01 = await login('field01');
    const res = await request(app)
      .get(`/api/sites/${otherSite}/holes`).set('Authorization', `Bearer ${field01}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);   // RLS 가 행 자체를 제거한다
  });

  it('현장관리자는 본사전용 검증 API 에 접근할 수 없다', async () => {
    const head = await login('head01');
    const siteId = await siteIdByCode(head, 'TEST_SITE_01');
    const field01 = await login('field01');
    const res = await request(app)
      .get(`/api/sites/${siteId}/validation`).set('Authorization', `Bearer ${field01}`);
    expect(res.status).toBe(403);
  });
});

describe('§29 PRIVATE_COST 절대 차단 (DB 수준)', () => {
  it('계약상대방(EXTERNAL) 은 private_cost 스키마에 접근할 수 없다', async () => {
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query('SELECT count(*) FROM private_cost.daily_cost');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('계약상대방은 원가 단가 테이블에 접근할 수 없다', async () => {
    for (const table of ['private_cost.labor_rate', 'private_cost.equipment_rate']) {
      await expect(
        withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
          await c.query(`SELECT count(*) FROM ${table}`);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('현장관리자는 비용을 입력할 수 있으나 단가 테이블은 볼 수 없다', async () => {
    const head = await login('head01');
    const siteId = await siteIdByCode(head, 'TEST_SITE_01');
    const fieldUser = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
      return r.rows[0].id as string;
    });

    // 비용 입력은 허용 (§44 FIELD_MANAGER)
    await withSession({ userId: fieldUser, role: 'FIELD_MANAGER' }, async (c) => {
      await c.query(
        `INSERT INTO private_cost.daily_cost
           (site_id, cost_date, cost_type, amount, quantity, unit, vendor, created_by)
         VALUES ($1, CURRENT_DATE, 'C03', 380000, 420, 'L', '테스트주유소', $2)`,
        [siteId, fieldUser]);
    });

    // 단가 테이블은 GRANT 자체가 없다
    await expect(
      withSession({ userId: fieldUser, role: 'FIELD_MANAGER' }, async (c) => {
        await c.query('SELECT count(*) FROM private_cost.labor_rate');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('현장관리자는 다른 사람이 입력한 원가를 볼 수 없다 (RLS)', async () => {
    const headId = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='head01'`);
      return r.rows[0].id as string;
    });
    const siteId = await withSession({ userId: headId, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(`SELECT id FROM core.site WHERE site_code='TEST_SITE_01'`);
      return r.rows[0].id as string;
    });
    // 본사가 입력한 원가 1건
    await withSession({ userId: headId, role: 'HEAD_OFFICE' }, async (c) => {
      await c.query(
        `INSERT INTO private_cost.daily_cost (site_id, cost_date, cost_type, amount, created_by)
         VALUES ($1, CURRENT_DATE, 'C06', 999999, $2)`, [siteId, headId]);
    });
    const fieldUser = await withSession({ userId: headId, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='field01'`);
      return r.rows[0].id as string;
    });
    const visible = await withSession({ userId: fieldUser, role: 'FIELD_MANAGER' }, async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM private_cost.daily_cost WHERE amount = 999999`);
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});

describe('§29 외부 공유 경로 격리', () => {
  it('share 스키마의 어떤 객체도 private_cost 에 의존하지 않는다', async () => {
    const rows = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query('SELECT * FROM app.fn_share_isolation_violations()');
      return r.rows;
    });
    expect(rows).toEqual([]);
  });

  it('share 뷰에는 금액/단가/원가 컬럼이 존재하지 않는다', async () => {
    const cols = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'share'`);
      return r.rows as { table_name: string; column_name: string }[];
    });
    expect(cols.length).toBeGreaterThan(0);
    const banned = /price|amount|cost|rate|margin|profit|단가|원가/i;
    expect(cols.filter((c) => banned.test(c.column_name))).toEqual([]);
  });
});

describe('계약단가 공개 (사용자 지시) — 내부원가와는 별개다', () => {
  it('현장관리자도 hole_master.contract_unit_price 를 조회할 수 있다', async () => {
    const rows = await withSession({ userId: null, role: 'FIELD_MANAGER' }, async (c) => {
      const r = await c.query('SELECT contract_unit_price FROM core.hole_master LIMIT 1');
      return r.rows;
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('현장관리자 API 응답에 contract_unit_price 가 포함된다', async () => {
    const head = await login('head01');
    const siteId = await siteIdByCode(head, 'TEST_SITE_01');
    const field01 = await login('field01');
    const res = await request(app)
      .get(`/api/sites/${siteId}/holes?limit=1`).set('Authorization', `Bearer ${field01}`);
    expect(res.status).toBe(200);
    expect(res.body.holes[0]).toHaveProperty('contract_unit_price');
  });

  it('계약단가를 열어도 내부원가(노무·장비 단가)는 여전히 차단된다 (§29)', async () => {
    for (const table of ['private_cost.labor_rate', 'private_cost.equipment_rate']) {
      await expect(
        withSession({ userId: null, role: 'FIELD_MANAGER' }, async (c) => {
          await c.query(`SELECT count(*) FROM ${table}`);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('계약단가를 열어도 계약상대방은 계약 테이블에 접근할 수 없다', async () => {
    await expect(
      withSession({ userId: null, role: 'EXTERNAL' }, async (c) => {
        await c.query('SELECT count(*) FROM core.contract_item');
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('§1-11 변경이력 보존', () => {
  it('HOLE_MASTER 수정 시 이전 이미지가 audit.change_log 에 남는다', async () => {
    const headId = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(`SELECT id FROM core.app_user WHERE login_id='head01'`);
      return r.rows[0].id as string;
    });
    const holeId = await withSession({ userId: headId, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(
        `UPDATE core.hole_master SET section='변경된구간'
          WHERE hole_no='A-002'
            AND site_id=(SELECT id FROM core.site WHERE site_code='TEST_SITE_01')
          RETURNING id`);
      return r.rows[0].id as string;
    });
    const log = await withSession({ userId: headId, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(
        `SELECT before_image->>'section' AS before_section, changed_by
           FROM audit.change_log
          WHERE table_name='core.hole_master' AND row_id=$1 AND operation='UPDATE'
          ORDER BY changed_at DESC LIMIT 1`, [holeId]);
      return r.rows[0];
    });
    expect(log.before_section).not.toBe('변경된구간');
    expect(log.changed_by).toBe(headId);
  });

  it('변경이력은 수정하거나 삭제할 수 없다 (권한 + 트리거 2중 차단)', async () => {
    // 1차: 어떤 역할에도 change_log 의 UPDATE/DELETE 권한을 주지 않는다.
    await expect(
      withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
        await c.query('DELETE FROM audit.change_log WHERE id = (SELECT min(id) FROM audit.change_log)');
      }),
    ).rejects.toMatchObject({ code: '42501' });

    // 2차: 권한을 가진 주체가 시도해도 트리거가 막는다 (테이블 소유자 경로).
    const grants = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE table_schema='audit' AND table_name='change_log'
            AND privilege_type IN ('UPDATE','DELETE')
            AND grantee <> (SELECT tableowner FROM pg_tables
                             WHERE schemaname='audit' AND tablename='change_log')`);
      return r.rows;
    });
    expect(grants).toEqual([]);

    const trigger = await withSession({ userId: null, role: 'HEAD_OFFICE' }, async (c) => {
      const r = await c.query(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'audit.change_log'::regclass AND NOT tgisinternal`);
      return r.rows.map((x: { tgname: string }) => x.tgname);
    });
    expect(trigger).toContain('trg_change_log_immutable');
  });
});

describe('애플리케이션 DB 계정 자체는 무권한이다', () => {
  it('SET ROLE 없이는 core 테이블을 읽을 수 없다 (NOINHERIT)', async () => {
    const client = await pool.connect();
    try {
      await expect(client.query('SELECT count(*) FROM core.site')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });
});
