/**
 * 지반조건 테스트 — Master Prompt §6~§11, §51
 * 핵심: 지층종류는 하드코딩되지 않고 현장별로 다르며,
 *       지층합계 = 총 계획심도가 코드로 강제된다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, withSession } from '../src/db/pool.js';

afterAll(async () => { await closePool(); });

const HO = { userId: null, role: 'HEAD_OFFICE' as const };

async function siteId(code: string): Promise<string> {
  return withSession(HO, async (c) => {
    const r = await c.query('SELECT id FROM core.site WHERE site_code=$1', [code]);
    return r.rows[0].id as string;
  });
}

describe('§7 지층종류는 현장별 사용자 정의', () => {
  it('마이그레이션에 특정 지층명이 하드코딩되어 있지 않다', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), '../db/migrations');
    const banned = ['토사', '풍화암', '연암', '경암', '전석층'];
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, f), 'utf8');
      for (const line of sql.split('\n')) {
        // 주석(예시 설명)은 허용, 실제 SQL 문에 등장하면 위반
        const code = line.split('--')[0] ?? '';
        if (banned.some((b) => code.includes(b))) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('현장마다 지층종류 개수와 구성이 다르다 (§51)', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT s.site_code, array_agg(g.name ORDER BY g.sort_order) AS types
           FROM core.ground_type g JOIN core.site s ON s.id=g.site_id
          GROUP BY s.site_code ORDER BY s.site_code`);
      return r.rows as { site_code: string; types: string[] }[];
    });
    const bySite = new Map(rows.map((r) => [r.site_code, r.types]));
    expect(bySite.get('TEST_SITE_01')).toHaveLength(2);
    expect(bySite.get('TEST_SITE_02')).toHaveLength(3);
    // 실제 수량산출서 현장: 연암·경암 열은 전 공 0 이므로 등록되지 않는다
    expect(bySite.get('SAMPLE_RFCIP_01')).toEqual(['토사', '풍화암']);
  });
});

describe('§8 지층합계 = 총 계획심도 강제', () => {
  it('합계가 맞지 않으면 CONFIRMED 로 확정할 수 없다', async () => {
    const site = await siteId('TEST_SITE_01');
    await expect(
      withSession(HO, async (c) => {
        const gp = await c.query(
          `INSERT INTO core.ground_profile
             (site_id, profile_name, revision, depth_mode, total_planned_depth, source, status)
           VALUES ($1,'불일치 테스트',0,'DEPTH_RANGE',20.0,'QUANTITY_SHEET','DRAFT') RETURNING id`,
          [site]);
        const pid = gp.rows[0].id as string;
        const gt = await c.query(
          `SELECT id, code FROM core.ground_type WHERE site_id=$1 ORDER BY sort_order`, [site]);
        // 12 + 5 = 17 ≠ 20
        await c.query(
          `INSERT INTO core.ground_profile_layer
             (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
           VALUES ($1,1,$2,0,12,12), ($1,2,$3,12,17,5)`,
          [pid, gt.rows[0].id, gt.rows[1].id]);
        await c.query(`UPDATE core.ground_profile SET status='CONFIRMED' WHERE id=$1`, [pid]);
      }),
    ).rejects.toThrow(/지층별 길이 합계/);
  });

  it('깊이구간이 연속되지 않으면 확정할 수 없다', async () => {
    const site = await siteId('TEST_SITE_01');
    await expect(
      withSession(HO, async (c) => {
        const gp = await c.query(
          `INSERT INTO core.ground_profile
             (site_id, profile_name, revision, depth_mode, total_planned_depth, source, status)
           VALUES ($1,'불연속 테스트',0,'DEPTH_RANGE',20.0,'QUANTITY_SHEET','DRAFT') RETURNING id`,
          [site]);
        const pid = gp.rows[0].id as string;
        const gt = await c.query(
          `SELECT id FROM core.ground_type WHERE site_id=$1 ORDER BY sort_order`, [site]);
        // 0~12, 그리고 13~21 (12~13 구간이 비어있다)
        await c.query(
          `INSERT INTO core.ground_profile_layer
             (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
           VALUES ($1,1,$2,0,12,12), ($1,2,$3,13,21,8)`,
          [pid, gt.rows[0].id, gt.rows[1].id]);
        await c.query(`UPDATE core.ground_profile SET status='CONFIRMED' WHERE id=$1`, [pid]);
      }),
    ).rejects.toThrow(/연속되지 않습니다|지층별 길이 합계/);
  });

  it('LENGTH_ONLY 모드(연장값만 있는 수량산출서)도 확정할 수 있다 (§9)', async () => {
    const site = await siteId('TEST_SITE_02');
    const status = await withSession(HO, async (c) => {
      const gp = await c.query(
        `INSERT INTO core.ground_profile
           (site_id, profile_name, revision, depth_mode, total_planned_depth, source, status)
         VALUES ($1,'연장전용 테스트',0,'LENGTH_ONLY',21.0,'QUANTITY_SHEET','DRAFT') RETURNING id`,
        [site]);
      const pid = gp.rows[0].id as string;
      const gt = await c.query(
        `SELECT id FROM core.ground_type WHERE site_id=$1 ORDER BY sort_order`, [site]);
      await c.query(
        `INSERT INTO core.ground_profile_layer
           (ground_profile_id, sequence, ground_type_id, planned_length)
         VALUES ($1,1,$2,10), ($1,2,$3,7), ($1,3,$4,4)`,
        [pid, gt.rows[0].id, gt.rows[1].id, gt.rows[2].id]);
      await c.query(`UPDATE core.ground_profile SET status='CONFIRMED' WHERE id=$1`, [pid]);
      const r = await c.query('SELECT status FROM core.ground_profile WHERE id=$1', [pid]);
      return r.rows[0].status as string;
    });
    expect(status).toBe('CONFIRMED');
  });
});

describe('§38 확정 데이터 보존', () => {
  it('확정된 지반조건의 지층은 수정할 수 없다', async () => {
    await expect(
      withSession(HO, async (c) => {
        await c.query(
          `UPDATE core.ground_profile_layer SET planned_length = 99
            WHERE ground_profile_id = (SELECT id FROM core.ground_profile
                                        WHERE status='CONFIRMED' LIMIT 1)`);
      }),
    ).rejects.toThrow(/확정된 지반조건/);
  });

  it('확정되지 않은 지반조건은 천공번호에 연결할 수 없다', async () => {
    const site = await siteId('TEST_SITE_01');
    await expect(
      withSession(HO, async (c) => {
        const gp = await c.query(
          `INSERT INTO core.ground_profile
             (site_id, profile_name, revision, depth_mode, total_planned_depth, source, status)
           VALUES ($1,'미확정 연결 테스트',0,'DEPTH_RANGE',20.0,'QUANTITY_SHEET','DRAFT') RETURNING id`,
          [site]);
        await c.query(
          `UPDATE core.hole_master SET ground_profile_id=$1
            WHERE hole_no='A-005' AND site_id=$2`, [gp.rows[0].id, site]);
      }),
    ).rejects.toThrow(/확정\(CONFIRMED\)되지 않은/);
  });
});

describe('§14 천공번호 무결성', () => {
  it('같은 현장에 중복 천공번호를 만들 수 없다', async () => {
    const site = await siteId('TEST_SITE_01');
    await expect(
      withSession(HO, async (c) => {
        await c.query(
          `INSERT INTO core.hole_master (site_id, hole_no, design_depth_total)
           VALUES ($1,'A-001',20.0)`, [site]);
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('다른 현장의 지반조건은 연결할 수 없다', async () => {
    const site1 = await siteId('TEST_SITE_01');
    await expect(
      withSession(HO, async (c) => {
        const other = await c.query(
          `SELECT p.id FROM core.ground_profile p
            WHERE p.site_id <> $1 AND p.status='CONFIRMED' LIMIT 1`, [site1]);
        await c.query(
          `UPDATE core.hole_master SET ground_profile_id=$1
            WHERE hole_no='A-006' AND site_id=$2`, [other.rows[0].id, site1]);
      }),
    ).rejects.toThrow(/다른 현장의 지반조건/);
  });
});

describe('§20 지층별 계획수량 자동집계 (결정론)', () => {
  it('A-001~A-010 의 지층별 수량이 항상 동일하게 계산된다', async () => {
    const run = () => withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT ground_type_name, sum(planned_length)::text AS m
           FROM core.v_hole_layer_plan
          WHERE site_id = (SELECT id FROM core.site WHERE site_code='TEST_SITE_01')
            AND hole_no BETWEEN 'A-001' AND 'A-010'
          GROUP BY 1 ORDER BY 1`);
      return r.rows;
    });
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a).toEqual([
      { ground_type_name: '토사',   m: '120.000' },
      { ground_type_name: '풍화암', m: '80.000'  },
    ]);
  });

  it('현장마다 지층조합이 달라도 동일 로직으로 집계된다 (§51 목적)', async () => {
    const rows = await withSession(HO, async (c) => {
      const r = await c.query(
        `SELECT ground_type_name, sum(planned_length)::text AS m
           FROM core.v_hole_layer_plan
          WHERE site_id = (SELECT id FROM core.site WHERE site_code='TEST_SITE_02')
            AND hole_no BETWEEN 'B-001' AND 'B-010'
          GROUP BY 1 ORDER BY 1`);
      return r.rows;
    });
    expect(rows).toEqual([
      { ground_type_name: '연암',   m: '40.000'  },
      { ground_type_name: '토사',   m: '100.000' },
      { ground_type_name: '풍화암', m: '70.000'  },
    ]);
  });
});
