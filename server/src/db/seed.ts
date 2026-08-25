/**
 * 테스트 데이터 (Master Prompt §51)
 *
 * 목적: 실제 회사 데이터가 없어도 "현장마다 지층조합이 달라도 동일 시스템이
 *       정상 작동하는지" 검증할 수 있게 한다.
 *
 * 주의: 여기 있는 수치는 Master Prompt §51 에 명시된 테스트값이거나,
 *       테스트용으로 명시한 가정값이다. 실제 계약수량이 아니다.
 *       실제 운영에서는 승인된 수량산출서만이 기준이다 (§11).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { env } from '../config/env.js';

interface LayerSpec { code: string; name: string; length: number }
interface SiteSpec {
  siteCode: string;
  siteName: string;
  clientName: string;
  location: string;
  groundTypes: { code: string; name: string }[];
  profileName: string;
  totalDepth: number;
  layers: LayerSpec[];
  holePrefix: string;
  holeFrom: number;
  holeTo: number;
  holeDigits: number;
  managerLogin: string;
  managerName: string;
}

/** §51 에 명시된 두 개의 테스트 현장 */
const SITES: SiteSpec[] = [
  {
    siteCode: 'TEST_SITE_01',
    siteName: '테스트현장 1공구 RF CIP',
    clientName: '테스트원도급(주)',
    location: '경기도 테스트시',
    groundTypes: [ { code: 'G01', name: '토사' }, { code: 'G02', name: '풍화암' } ],
    profileName: 'A구간 표준 (토사12+풍화암8)',
    totalDepth: 20.0,
    layers: [ { code: 'G01', name: '토사', length: 12.0 }, { code: 'G02', name: '풍화암', length: 8.0 } ],
    holePrefix: 'A-', holeFrom: 1, holeTo: 30, holeDigits: 3,
    managerLogin: 'field01', managerName: '김현장',
  },
  {
    siteCode: 'TEST_SITE_02',
    siteName: '테스트현장 2공구 RF CIP',
    clientName: '테스트건설(주)',
    location: '충청남도 테스트군',
    groundTypes: [ { code: 'G01', name: '토사' }, { code: 'G02', name: '풍화암' }, { code: 'G03', name: '연암' } ],
    profileName: 'B구간 표준 (토사10+풍화암7+연암4)',
    totalDepth: 21.0,
    layers: [
      { code: 'G01', name: '토사',   length: 10.0 },
      { code: 'G02', name: '풍화암', length: 7.0 },
      { code: 'G03', name: '연암',   length: 4.0 },
    ],
    holePrefix: 'B-', holeFrom: 1, holeTo: 20, holeDigits: 3,
    managerLogin: 'field02', managerName: '박현장',
  },
];

/** 테스트용 가정값. 실제 계약단가가 아니다. */
const TEST_UNIT_PRICE = 45000;
/** 테스트용 가정값: 천공경 D=500mm 기준 이론 체적 (m³/m) */
const TEST_READY_MIX_PER_METER = 0.196;

function holeNo(spec: SiteSpec, n: number): string {
  return spec.holePrefix + String(n).padStart(spec.holeDigits, '0');
}

async function adminClient(): Promise<pg.Client> {
  const url = new URL(env.ADMIN_DATABASE_URL);
  url.pathname = `/${env.DATABASE_NAME}`;
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  return c;
}

export async function seed(): Promise<void> {
  const c = await adminClient();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.role', 'HEAD_OFFICE', true)");

    const pwHash = await bcrypt.hash('test1234!', 10);

    const ho = await c.query(
      `INSERT INTO core.app_user (login_id, password_hash, display_name, role)
       VALUES ('head01', $1, '본사 공무팀', 'HEAD_OFFICE')
       ON CONFLICT (login_id) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`, [pwHash]);
    const headOfficeId: string = ho.rows[0].id;
    await c.query("SELECT set_config('app.user_id', $1, true)", [headOfficeId]);

    const ext = await c.query(
      `INSERT INTO core.app_user (login_id, password_hash, display_name, role)
       VALUES ('partner01', $1, '계약상대방 담당', 'EXTERNAL')
       ON CONFLICT (login_id) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`, [pwHash]);
    const externalId: string = ext.rows[0].id;

    for (const spec of SITES) {
      // STEP 1 현장 기본정보
      const site = await c.query(
        `INSERT INTO core.site (site_code, site_name, client_name, location, status, setup_step, created_by)
         VALUES ($1,$2,$3,$4,'ACTIVE',12,$5)
         ON CONFLICT (site_code) DO UPDATE SET site_name = EXCLUDED.site_name
         RETURNING id`,
        [spec.siteCode, spec.siteName, spec.clientName, spec.location, headOfficeId]);
      const siteId: string = site.rows[0].id;

      // 현장관리자 + 현장배정
      const fm = await c.query(
        `INSERT INTO core.app_user (login_id, password_hash, display_name, role)
         VALUES ($1,$2,$3,'FIELD_MANAGER')
         ON CONFLICT (login_id) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`, [spec.managerLogin, pwHash, spec.managerName]);
      const fmId: string = fm.rows[0].id;
      await c.query(
        `INSERT INTO core.user_site_access (user_id, site_id, granted_by)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [fmId, siteId, headOfficeId]);
      await c.query(
        `INSERT INTO core.user_site_access (user_id, site_id, granted_by)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [externalId, siteId, headOfficeId]);

      // STEP 2 계약정보
      const holeCount = spec.holeTo - spec.holeFrom + 1;
      const totalQty = holeCount * spec.totalDepth;
      const amount = totalQty * TEST_UNIT_PRICE;
      const contract = await c.query(
        `INSERT INTO core.contract
           (site_id, contract_no, contract_name, counterparty_name, contract_date,
            original_amount, current_amount, current_revision, status, created_by)
         VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$5,0,'ACTIVE',$6)
         ON CONFLICT (site_id, contract_no) DO UPDATE SET contract_name = EXCLUDED.contract_name
         RETURNING id`,
        [siteId, `${spec.siteCode}-C01`, `${spec.siteName} 흙막이 CIP 공사`,
         spec.clientName, amount, headOfficeId]);
      const contractId: string = contract.rows[0].id;

      await c.query(
        `INSERT INTO core.contract_revision
           (contract_id, revision_no, revision_type, contract_amount, effective_date,
            reason, approved_by, approved_at, is_current, created_by)
         VALUES ($1,0,'ORIGINAL',$2,CURRENT_DATE,'원계약',$3,now(),true,$3)
         ON CONFLICT (contract_id, revision_no) DO NOTHING`,
        [contractId, amount, headOfficeId]);

      await c.query(
        `INSERT INTO core.contract_item
           (contract_id, revision_no, item_code, item_name, spec, unit, quantity, unit_price, sort_order)
         VALUES ($1,0,'CIP-001','RF CIP 천공','D500',' m',$2,$3,1)
         ON CONFLICT (contract_id, revision_no, item_code) DO NOTHING`,
        [contractId, totalQty, TEST_UNIT_PRICE]);

      // STEP 5 천공종류 (현장별 활성화, §5)
      const htRows = await c.query(
        `INSERT INTO core.site_hole_type (site_id, code, name, sort_order)
         VALUES ($1,'HT01','Primary',1), ($1,'HT02','Secondary',2)
         ON CONFLICT (site_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, code`, [siteId]);
      const primaryTypeId: string = htRows.rows.find((r) => r.code === 'HT01')!.id;
      const secondaryTypeId: string = htRows.rows.find((r) => r.code === 'HT02')!.id;

      // STEP 6 현장에서 사용할 지층종류 (§7) — 현장마다 다르다
      const gtIds = new Map<string, string>();
      for (let i = 0; i < spec.groundTypes.length; i++) {
        const g = spec.groundTypes[i]!;
        const row = await c.query(
          `INSERT INTO core.ground_type (site_id, code, name, sort_order, created_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (site_id, code) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`, [siteId, g.code, g.name, i + 1, headOfficeId]);
        gtIds.set(g.code, row.rows[0].id);
      }

      // STEP 7 지반조건 (조합 + 깊이, §8)
      const existing = await c.query(
        `SELECT id FROM core.ground_profile WHERE site_id=$1 AND profile_name=$2 AND revision=0`,
        [siteId, spec.profileName]);
      let profileId: string;
      if (existing.rowCount) {
        profileId = existing.rows[0].id;
      } else {
        const gp = await c.query(
          `INSERT INTO core.ground_profile
             (site_id, profile_name, revision, description, depth_mode, total_planned_depth,
              source, source_reference, status, created_by)
           VALUES ($1,$2,0,$3,'DEPTH_RANGE',$4,'QUANTITY_SHEET',$5,'DRAFT',$6)
           RETURNING id`,
          [siteId, spec.profileName, `${spec.holePrefix}${spec.holeFrom}~${spec.holeTo} 공통 지반조건 (테스트 데이터)`,
           spec.totalDepth, `TEST §51`, headOfficeId]);
        profileId = gp.rows[0].id;

        let from = 0;
        for (let i = 0; i < spec.layers.length; i++) {
          const l = spec.layers[i]!;
          const to = Number((from + l.length).toFixed(3));
          await c.query(
            `INSERT INTO core.ground_profile_layer
               (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [profileId, i + 1, gtIds.get(l.code), from, to, l.length]);
          from = to;
        }
        // 확정 시점에 "지층합계 = 총심도" 가 DB에서 강제된다 (§8)
        await c.query(
          `UPDATE core.ground_profile
              SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now() WHERE id=$1`,
          [profileId, headOfficeId]);
      }

      // STEP 5/7/8/9 천공번호 생성 + 지반조건/계약수량/계획레미콘 연결
      const readyMix = Number((spec.totalDepth * TEST_READY_MIX_PER_METER).toFixed(3));
      for (let n = spec.holeFrom; n <= spec.holeTo; n++) {
        await c.query(
          `INSERT INTO core.hole_master
             (site_id, hole_no, section, hole_type_id, drawing_revision, quantity_revision,
              design_depth_total, ground_profile_id, contract_quantity, contract_unit,
              contract_unit_price, planned_ready_mix_quantity, status, created_by)
           VALUES ($1,$2,$3,$4,0,0,$5,$6,$5,'m',$7,$8,'NOT_STARTED',$9)
           ON CONFLICT (site_id, hole_no) DO NOTHING`,
          [siteId, holeNo(spec, n), spec.holePrefix.replace('-', '') + '구간',
           n % 2 === 1 ? primaryTypeId : secondaryTypeId,
           spec.totalDepth, profileId, TEST_UNIT_PRICE, readyMix, headOfficeId]);
      }

      console.log(`[seed] ${spec.siteCode}: 지층 ${spec.groundTypes.length}종, ` +
        `천공 ${holeCount}공, 공당 ${spec.totalDepth}m`);
    }

    await seedSampleRfcipSite(c, headOfficeId, pwHash, externalId);

    await c.query('COMMIT');
    console.log('[seed] done. 로그인: head01 / field01 / field02 / partner01  (비밀번호 test1234!)');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

/* ====================================================================
 * SAMPLE_RFCIP_01 — 실제 업로드된 수량산출서(천공조서) 기반 현장
 *
 * 목적: 천공번호 형식이 현장마다 다르다는 사실을 실제 데이터로 검증한다.
 *   H-PILE 구간 : '1' ~ '29'
 *   무근        : '1.1' ~ '3.9'
 *
 * 값은 전부 업로드된 조서의 원본값이다. 추정하거나 만들어낸 수치가 아니다.
 * 조서에 단가가 없으므로 계약단가는 NULL 로 둔다 (§8: AI가 계약수량을 확정하지 않는다).
 * ==================================================================== */
interface SampleHole {
  type: 'HPILE' | 'MUGEUN';
  no: string;
  토사: number; 풍화암: number; 연암: number; 경암: number; 총: number;
}

/** 조서에 실제로 값이 있는 지층만 등록한다. 0인 열(연암/경암)은 만들지 않는다. */
const SAMPLE_LAYER_NAMES = ['토사', '풍화암', '연암', '경암'] as const;

async function seedSampleRfcipSite(
  c: pg.Client, headOfficeId: string, pwHash: string, externalId: string,
): Promise<void> {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const dataPath = join(HERE, '../../../db/seeds/sample_rfcip_holes.json');
  const holes = JSON.parse(readFileSync(dataPath, 'utf8')) as SampleHole[];

  const site = await c.query(
    `INSERT INTO core.site (site_code, site_name, client_name, location, status, setup_step, created_by)
     VALUES ('SAMPLE_RFCIP_01','샘플현장 RF-CIP (실제 수량산출서 기준)','샘플원도급(주)','미상','ACTIVE',9,$1)
     ON CONFLICT (site_code) DO UPDATE SET site_name = EXCLUDED.site_name
     RETURNING id`, [headOfficeId]);
  const siteId: string = site.rows[0].id;

  const fm = await c.query(
    `INSERT INTO core.app_user (login_id, password_hash, display_name, role)
     VALUES ('field03',$1,'이현장','FIELD_MANAGER')
     ON CONFLICT (login_id) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`, [pwHash]);
  for (const uid of [fm.rows[0].id as string, externalId]) {
    await c.query(
      `INSERT INTO core.user_site_access (user_id, site_id, granted_by)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uid, siteId, headOfficeId]);
  }

  // 천공종류 — 조서의 두 블록이 곧 천공종류다
  const ht = await c.query(
    `INSERT INTO core.site_hole_type (site_id, code, name, sort_order)
     VALUES ($1,'HPILE','H-PILE 구간',1), ($1,'MUGEUN','무근',2)
     ON CONFLICT (site_id, code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, code`, [siteId]);
  const holeTypeId = new Map<string, string>(
    ht.rows.map((r: { code: string; id: string }) => [r.code, r.id]));

  // 설계 파라미터 — 조서 Y~AB 블록의 원본값
  await c.query(
    `INSERT INTO core.site_design_param (site_id, param_code, param_name, param_value, unit, note, created_by)
     VALUES ($1,'DIAMETER','천공 직경',0.6,'m','수량산출서 설계값',$2),
            ($1,'CTC','C.T.C',0.47,'m','중심간거리',$2),
            ($1,'WALL_LENGTH','가시설 연장',300,'m','벽면 연장',$2),
            ($1,'SIDE_PILE_GAP','측면말뚝 간격',1.41,'m',NULL,$2),
            ($1,'CONCRETE_SURCHARGE','콘크리트 할증률',2,'%','산출근거 기준',$2)
     ON CONFLICT (site_id, param_code) DO UPDATE SET param_value = EXCLUDED.param_value`,
    [siteId, headOfficeId]);

  // 실제로 사용된 지층만 등록 (연암·경암은 전 공 0 이므로 만들지 않는다)
  const usedLayers = SAMPLE_LAYER_NAMES.filter(
    (n) => holes.some((h) => h[n] > 0));
  const gtIds = new Map<string, string>();
  for (let i = 0; i < usedLayers.length; i++) {
    const name = usedLayers[i]!;
    const r = await c.query(
      `INSERT INTO core.ground_type (site_id, code, name, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (site_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [siteId, `G${String(i + 1).padStart(2, '0')}`, name, i + 1, headOfficeId]);
    gtIds.set(name, r.rows[0].id);
  }

  // 공당 깊이 조합이 같은 천공번호는 하나의 지반조건을 공유한다 (§10 범위적용 효과)
  const profileCache = new Map<string, string>();
  for (const h of holes) {
    const layers = usedLayers
      .map((n) => ({ name: n, len: h[n] }))
      .filter((l) => l.len > 0);
    const signature = layers.map((l) => `${l.name}:${l.len.toFixed(3)}`).join('|');

    let profileId = profileCache.get(signature);
    if (!profileId) {
      const existing = await c.query(
        `SELECT id FROM core.ground_profile WHERE site_id=$1 AND profile_name=$2 AND revision=0`,
        [siteId, signature]);
      if (existing.rowCount) {
        profileId = existing.rows[0].id as string;
      } else {
        const gp = await c.query(
          `INSERT INTO core.ground_profile
             (site_id, profile_name, revision, description, depth_mode, total_planned_depth,
              source, source_reference, status, created_by)
           VALUES ($1,$2,0,$3,'DEPTH_RANGE',$4,'QUANTITY_SHEET','천공조서(RF-CIP) 공당값','DRAFT',$5)
           RETURNING id`,
          [siteId, signature, layers.map((l) => `${l.name} ${l.len}m`).join(' + '), h.총, headOfficeId]);
        profileId = gp.rows[0].id as string;
        let from = 0;
        for (let i = 0; i < layers.length; i++) {
          const l = layers[i]!;
          const to = Number((from + l.len).toFixed(3));
          await c.query(
            `INSERT INTO core.ground_profile_layer
               (ground_profile_id, sequence, ground_type_id, from_depth, to_depth, planned_length)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [profileId, i + 1, gtIds.get(l.name), from, to, l.len]);
          from = to;
        }
        await c.query(
          `UPDATE core.ground_profile SET status='CONFIRMED', confirmed_by=$2, confirmed_at=now()
            WHERE id=$1`, [profileId, headOfficeId]);
      }
      profileCache.set(signature, profileId);
    }

    // ON CONFLICT DO NOTHING 을 쓰지 않는다.
    // 천공번호 충돌은 §14 에 따라 반드시 드러나야 하며, 조용히 누락되면 안 된다.
    await c.query(
      `INSERT INTO core.hole_master
         (site_id, hole_no, section, hole_type_id, drawing_revision, quantity_revision,
          design_depth_total, ground_profile_id, contract_quantity, contract_unit,
          status, created_by)
       VALUES ($1,$2,$3,$4,0,0,$5,$6,$5,'m','NOT_STARTED',$7)`,
      [siteId, h.no, h.type === 'HPILE' ? 'H-PILE 구간' : '무근구간',
       holeTypeId.get(h.type), h.총, profileId, headOfficeId]);
  }

  const total = holes.reduce((a, h) => a + h.총, 0);
  console.log(`[seed] SAMPLE_RFCIP_01: 지층 ${usedLayers.length}종(${usedLayers.join('/')}), ` +
    `천공 ${holes.length}공, 지반조건 ${profileCache.size}종, ` +
    `총 계획연장 ${total.toFixed(2)}m`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
