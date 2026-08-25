-- =====================================================================
-- 0008 SHARE 스키마(외부 공유 전용) + 자동 검증 + 접근차단 로그
-- Master Prompt §29(외부 보고서 함수는 PRIVATE_COST 를 조회하지 않는다),
--               §41(계약상대방 공유), §43(자동 오류검출)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 외부(계약상대방) 공유 승인 단위
-- ---------------------------------------------------------------------
CREATE TABLE core.external_share (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  share_token  text NOT NULL UNIQUE,
  report_date  date,
  approved_by  uuid REFERENCES core.app_user(id),
  approved_at  timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_external_share_site ON core.external_share(site_id, report_date);

ALTER TABLE core.external_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.external_share FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_share_ho ON core.external_share FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
CREATE POLICY p_share_read ON core.external_share FOR SELECT
  USING (app.has_site_access(site_id));
GRANT SELECT ON core.external_share TO rfcip_field_manager, rfcip_external;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.external_share TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- share 스키마 : 계약상대방이 볼 수 있는 데이터만. 원가 컬럼 0개.
-- ---------------------------------------------------------------------
CREATE VIEW share.v_site AS
SELECT s.id AS site_id, s.site_code, s.site_name, s.location, s.status
  FROM core.site s;

CREATE VIEW share.v_hole_progress AS
SELECT h.site_id, h.hole_no, h.section, h.hole_prefix, h.hole_index,
       h.design_depth_total, h.actual_depth_total,
       h.construction_date,
       CASE WHEN h.status = 'COMPLETED' THEN '완료' ELSE '미시공' END AS progress_status
  FROM core.hole_master h;

CREATE VIEW share.v_layer_plan AS
SELECT v.site_id, v.hole_no, v.ground_type_code, v.ground_type_name,
       v.planned_length, v.status, v.construction_date
  FROM core.v_hole_layer_plan v;

GRANT SELECT ON share.v_site, share.v_hole_progress, share.v_layer_plan
  TO rfcip_external, rfcip_field_manager, rfcip_head_office;

-- ---------------------------------------------------------------------
-- share 격리 검증 : share 스키마의 어떤 객체도 private_cost 에 의존할 수 없다.
--   자동 테스트가 이 함수의 결과가 비어있음을 강제한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fn_share_isolation_violations()
RETURNS TABLE (share_object text, depends_on text)
LANGUAGE sql STABLE AS $$
  SELECT (sn.nspname || '.' || sc.relname)::text,
         (dn.nspname || '.' || dc.relname)::text
    FROM pg_depend d
    JOIN pg_rewrite r  ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
    JOIN pg_class  sc  ON sc.oid = r.ev_class
    JOIN pg_namespace sn ON sn.oid = sc.relnamespace
    JOIN pg_class  dc  ON dc.oid = d.refobjid
    JOIN pg_namespace dn ON dn.oid = dc.relnamespace
   WHERE sn.nspname = 'share' AND dn.nspname = 'private_cost'
$$;
GRANT EXECUTE ON FUNCTION app.fn_share_isolation_violations() TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 접근차단 로그 (§43 마지막 항목 : 외부 사용자의 PRIVATE_COST 접근시도)
-- ---------------------------------------------------------------------
CREATE TABLE audit.access_denied_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid,
  role_name   text,
  method      text,
  path        text,
  reason      text NOT NULL,
  ip_address  inet,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_access_denied_time ON audit.access_denied_log(occurred_at DESC);
GRANT SELECT, INSERT ON audit.access_denied_log TO rfcip_head_office;
GRANT USAGE ON SEQUENCE audit.access_denied_log_id_seq TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 현장 단위 자동 검증 (§43) — PHASE 1 시점에 데이터가 존재하는 항목만 구현.
--   이후 Phase 에서 항목을 추가한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_validate_site(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  -- SECURITY DEFINER 이므로 현장 접근권한을 함수 내부에서 다시 확인한다.
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1) 지층별 길이 합계 != 총 계획심도
  RETURN QUERY
  SELECT 'LAYER_SUM_MISMATCH', 'ERROR', p.profile_name,
         format('지반조건 %s : 지층합계 %sm ≠ 총 계획심도 %sm',
                p.profile_name,
                trim(to_char(core.fn_profile_layer_sum(p.id), 'FM9990.000')),
                trim(to_char(p.total_planned_depth, 'FM9990.000')))
    FROM core.ground_profile p
   WHERE p.site_id = p_site_id
     AND abs(core.fn_profile_layer_sum(p.id) - p.total_planned_depth) > 0.001;

  -- 2) 지반조건이 연결되지 않은 천공번호
  RETURN QUERY
  SELECT 'HOLE_WITHOUT_PROFILE', 'WARN', h.hole_no,
         format('천공번호 %s 에 지반조건이 연결되지 않았습니다.', h.hole_no)
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.ground_profile_id IS NULL;

  -- 3) 계획심도 불일치 (HOLE_MASTER vs 지반조건 총심도) — §14
  RETURN QUERY
  SELECT 'DESIGN_DEPTH_MISMATCH', 'ERROR', h.hole_no,
         format('천공번호 %s : 계획심도 %sm ≠ 지반조건 총심도 %sm',
                h.hole_no,
                trim(to_char(h.design_depth_total, 'FM9990.000')),
                trim(to_char(p.total_planned_depth, 'FM9990.000')))
    FROM core.hole_master h
    JOIN core.ground_profile p ON p.id = h.ground_profile_id
   WHERE h.site_id = p_site_id
     AND h.design_depth_total IS NOT NULL
     AND abs(h.design_depth_total - p.total_planned_depth) > 0.001;

  -- 4) 완료 처리되었으나 실제심도 미입력 — §43
  RETURN QUERY
  SELECT 'COMPLETED_WITHOUT_ACTUAL_DEPTH', 'WARN', h.hole_no,
         format('천공번호 %s 완료 처리되었으나 실제심도가 없습니다.', h.hole_no)
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.status = 'COMPLETED' AND h.actual_depth_total IS NULL;

  -- 5) 계획심도 대비 실제심도 차이 (0.5m 초과) — §43
  RETURN QUERY
  SELECT 'ACTUAL_DEPTH_DEVIATION', 'WARN', h.hole_no,
         format('천공번호 %s : 실제심도 %sm, 계획심도 %sm (차이 %sm)',
                h.hole_no,
                trim(to_char(h.actual_depth_total, 'FM9990.000')),
                trim(to_char(h.design_depth_total, 'FM9990.000')),
                trim(to_char(h.actual_depth_total - h.design_depth_total, 'FMS9990.000')))
    FROM core.hole_master h
   WHERE h.site_id = p_site_id
     AND h.actual_depth_total IS NOT NULL AND h.design_depth_total IS NOT NULL
     AND abs(h.actual_depth_total - h.design_depth_total) > 0.5;

  -- 6) 지층종류가 하나도 정의되지 않은 현장 — 최초설정 미완료
  RETURN QUERY
  SELECT 'NO_GROUND_TYPE', 'WARN', s.site_code,
         '현장에서 사용할 지층종류가 정의되지 않았습니다. (STEP 6)'
    FROM core.site s
   WHERE s.id = p_site_id
     AND NOT EXISTS (SELECT 1 FROM core.ground_type g WHERE g.site_id = s.id);

  -- 7) Revision 혼재 — §43
  RETURN QUERY
  SELECT 'REVISION_MIXED', 'WARN', 'quantity_revision',
         format('현장 내 수량산출서 revision 이 혼재합니다: %s',
                string_agg(DISTINCT h.quantity_revision::text, ', '))
    FROM core.hole_master h
   WHERE h.site_id = p_site_id
  HAVING count(DISTINCT h.quantity_revision) > 1;
END $$;

GRANT EXECUTE ON FUNCTION core.fn_validate_site(uuid) TO rfcip_head_office, rfcip_field_manager;
