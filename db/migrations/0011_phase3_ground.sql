-- =====================================================================
-- 0011 PHASE 3 : GROUND_TYPE / GROUND_PROFILE / 범위 일괄설정
--   Master Prompt §6~§11, §38, §43, §46
--
-- 사용자 지시 반영
--   "현장 여건에 따라 지반조건이 달라지는 부분들이 있어서 우선 0으로 입력해놓은 상황"
--   → 계획수량이 0인 지층을 '없는 것'으로 지워버리지 않는다.
--     PROVISIONAL(미확정) 상태로 등록해 두고, 실제 출현 시 계획에 편입한다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 지층종류 상태
--   CONFIRMED   : 계획수량이 확정된 지층
--   PROVISIONAL : 현장 여건에 따라 나올 수 있으나 현재 계획수량 0 (수량산출서 0 기재)
--   RETIRED     : 이 현장에서 더 이상 쓰지 않음
-- ---------------------------------------------------------------------
ALTER TABLE core.ground_type
  ADD COLUMN status text NOT NULL DEFAULT 'CONFIRMED'
    CHECK (status IN ('CONFIRMED','PROVISIONAL','RETIRED')),
  ADD COLUMN note text;

COMMENT ON COLUMN core.ground_type.status IS
  'PROVISIONAL = 수량산출서에 0으로 기재되어 계획수량은 없으나 현장 여건에 따라 출현 가능';

CREATE TRIGGER trg_ground_type_audit AFTER INSERT OR UPDATE OR DELETE ON core.ground_type
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- 사용 중인 지층종류는 삭제할 수 없다. 상태를 RETIRED 로 바꾼다.
CREATE OR REPLACE FUNCTION core.trg_ground_type_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.ground_profile_layer WHERE ground_type_id = OLD.id) THEN
    RAISE EXCEPTION '지반조건에서 사용 중인 지층종류는 삭제할 수 없습니다. 상태를 RETIRED 로 변경하십시오.'
      USING ERRCODE='foreign_key_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER trg_ground_type_delete_guard BEFORE DELETE ON core.ground_type
  FOR EACH ROW EXECUTE FUNCTION core.trg_ground_type_delete_guard();

-- ---------------------------------------------------------------------
-- 범위 해석 (§10, §19)
--   from/to 는 자연정렬 키로 비교한다. 번호 형식을 강제하지 않는다.
--   exclude 는 천공번호 원문 그대로 받는다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_resolve_hole_range(
  p_site_id  uuid,
  p_from     text DEFAULT NULL,
  p_to       text DEFAULT NULL,
  p_exclude  text[] DEFAULT NULL,
  p_hole_type_code text DEFAULT NULL
) RETURNS TABLE (
  hole_id uuid, hole_no text, sort_key text,
  design_depth_total numeric, current_profile_id uuid, current_profile_name text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT h.id, h.hole_no, h.sort_key, h.design_depth_total, h.ground_profile_id, gp.profile_name
    FROM core.hole_master h
    LEFT JOIN core.ground_profile gp ON gp.id = h.ground_profile_id
    LEFT JOIN core.site_hole_type ht ON ht.id = h.hole_type_id
   WHERE h.site_id = p_site_id
     AND app.has_site_access(p_site_id)
     AND (p_from IS NULL OR h.sort_key >= core.fn_natural_sort_key(p_from))
     AND (p_to   IS NULL OR h.sort_key <= core.fn_natural_sort_key(p_to))
     AND (p_exclude IS NULL OR NOT (h.hole_no = ANY(p_exclude)))
     AND (p_hole_type_code IS NULL OR ht.code = p_hole_type_code)
   ORDER BY h.sort_key
$$;
GRANT EXECUTE ON FUNCTION core.fn_resolve_hole_range(uuid, text, text, text[], text)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 지반조건 일괄 연결 (§10)
--   기존 지반조건이 있던 천공번호는 변경 "전" 상태를 revision 으로 보존한다 (§38).
--   반환값 = 실제로 연결된 공수
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_assign_ground_profile(
  p_profile_id uuid,
  p_hole_ids   uuid[],
  p_reason     text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_profile core.ground_profile%ROWTYPE;
  v_hole    record;
  v_count   integer := 0;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '지반조건 설정은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT * INTO v_profile FROM core.ground_profile WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '지반조건을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;
  IF v_profile.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION '확정되지 않은 지반조건은 연결할 수 없습니다.' USING ERRCODE='check_violation';
  END IF;

  FOR v_hole IN
    SELECT id, site_id, ground_profile_id FROM core.hole_master WHERE id = ANY(p_hole_ids)
  LOOP
    IF v_hole.site_id <> v_profile.site_id THEN
      RAISE EXCEPTION '다른 현장의 천공번호가 포함되어 있습니다.' USING ERRCODE='check_violation';
    END IF;
    -- 이미 지반조건이 있었다면 변경 전 상태를 남긴다 (원본 덮어쓰기 금지)
    IF v_hole.ground_profile_id IS DISTINCT FROM p_profile_id THEN
      IF v_hole.ground_profile_id IS NOT NULL THEN
        PERFORM core.fn_snapshot_hole_revision(
          v_hole.id, 'DESIGN_CHANGE', COALESCE(p_reason, '지반조건 변경'));
      END IF;
      UPDATE core.hole_master
         SET ground_profile_id = p_profile_id,
             design_depth_total = v_profile.total_planned_depth
       WHERE id = v_hole.id;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_assign_ground_profile(uuid, uuid[], text)
  TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 지반조건 개정 (§38)
--   확정된 지반조건은 수정하지 않는다. 새 revision 을 만들고 이전 것은 SUPERSEDED.
--   반환값 = 새 revision 의 id (레이어는 호출자가 채운 뒤 확정한다)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_revise_ground_profile(
  p_profile_id uuid,
  p_new_total  numeric,
  p_reason     text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_old core.ground_profile%ROWTYPE;
  v_new_id uuid;
  v_next   integer;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '지반조건 개정은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT * INTO v_old FROM core.ground_profile WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '지반조건을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;

  SELECT COALESCE(max(revision), -1) + 1 INTO v_next
    FROM core.ground_profile
   WHERE site_id = v_old.site_id AND profile_name = v_old.profile_name;

  INSERT INTO core.ground_profile
    (site_id, profile_name, revision, description, depth_mode, total_planned_depth,
     source, source_reference, status, created_by)
  VALUES
    (v_old.site_id, v_old.profile_name, v_next,
     COALESCE(p_reason, v_old.description), v_old.depth_mode, p_new_total,
     v_old.source, v_old.source_reference, 'DRAFT', app.current_user_id())
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_revise_ground_profile(uuid, numeric, text)
  TO rfcip_head_office;

-- 개정본이 확정되면 이전 revision 을 SUPERSEDED 로 내린다.
CREATE OR REPLACE FUNCTION core.trg_supersede_prior_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CONFIRMED' AND OLD.status IS DISTINCT FROM 'CONFIRMED' THEN
    UPDATE core.ground_profile
       SET status = 'SUPERSEDED', superseded_by = NEW.id
     WHERE site_id = NEW.site_id
       AND profile_name = NEW.profile_name
       AND revision < NEW.revision
       AND status = 'CONFIRMED';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_gp_supersede AFTER UPDATE OF status ON core.ground_profile
  FOR EACH ROW EXECUTE FUNCTION core.trg_supersede_prior_revision();

-- ---------------------------------------------------------------------
-- 수량산출서 총연장 → 공당 환산 (§11)
--   시스템이 임의로 확정하지 않는다. 계산 결과를 돌려주기만 하고
--   저장은 사용자가 확인한 뒤에 별도 호출로 이루어진다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_convert_total_to_per_hole(
  p_total_length numeric,
  p_hole_count   integer
) RETURNS TABLE (per_hole numeric, remainder numeric, divides_evenly boolean)
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    round(p_total_length / NULLIF(p_hole_count, 0), 3),
    round(p_total_length - round(p_total_length / NULLIF(p_hole_count, 0), 3) * p_hole_count, 3),
    abs(p_total_length - round(p_total_length / NULLIF(p_hole_count, 0), 3) * p_hole_count) <= 0.001
$$;
GRANT EXECUTE ON FUNCTION core.fn_convert_total_to_per_hole(numeric, integer)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 자동검증 보강 (§43)
--   PROVISIONAL 지층이 있는 현장은 본사에 알린다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_validate_site(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
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
     AND p.status <> 'SUPERSEDED'
     AND abs(core.fn_profile_layer_sum(p.id) - p.total_planned_depth) > 0.001;

  -- 2) 지반조건이 연결되지 않은 천공번호
  RETURN QUERY
  SELECT 'HOLE_WITHOUT_PROFILE', 'WARN', h.hole_no,
         format('천공번호 %s 에 지반조건이 연결되지 않았습니다.', h.hole_no)
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.ground_profile_id IS NULL;

  -- 3) 계획심도 불일치 (§14)
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

  -- 4) 완료인데 실제심도 없음
  RETURN QUERY
  SELECT 'COMPLETED_WITHOUT_ACTUAL_DEPTH', 'WARN', h.hole_no,
         format('천공번호 %s 완료 처리되었으나 실제심도가 없습니다.', h.hole_no)
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.status = 'COMPLETED' AND h.actual_depth_total IS NULL;

  -- 5) 계획 대비 실제심도 차이
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

  -- 6) 지층종류 미정의
  RETURN QUERY
  SELECT 'NO_GROUND_TYPE', 'WARN', s.site_code,
         '현장에서 사용할 지층종류가 정의되지 않았습니다. (STEP 6)'
    FROM core.site s
   WHERE s.id = p_site_id
     AND NOT EXISTS (SELECT 1 FROM core.ground_type g WHERE g.site_id = s.id);

  -- 7) Revision 혼재
  RETURN QUERY
  SELECT 'REVISION_MIXED', 'WARN', 'quantity_revision',
         format('현장 내 수량산출서 revision 이 혼재합니다: %s',
                string_agg(DISTINCT h.quantity_revision::text, ', '))
    FROM core.hole_master h
   WHERE h.site_id = p_site_id
  HAVING count(DISTINCT h.quantity_revision) > 1;

  -- 8) 미확정 지층 (사용자 지시: 현장 여건에 따라 달라지는 지층은 0으로 입력해 둠)
  RETURN QUERY
  SELECT 'PROVISIONAL_GROUND_TYPE', 'INFO', g.name,
         format('지층 %s 은(는) 계획수량 0 인 미확정 상태입니다. 실제 출현 시 계획 반영이 필요합니다.', g.name)
    FROM core.ground_type g
   WHERE g.site_id = p_site_id AND g.status = 'PROVISIONAL';

  -- 9) 지반조건이 있으나 어떤 천공번호에도 연결되지 않음
  RETURN QUERY
  SELECT 'PROFILE_UNUSED', 'INFO', p.profile_name,
         format('지반조건 %s (REV %s) 이 어떤 천공번호에도 연결되어 있지 않습니다.',
                p.profile_name, p.revision)
    FROM core.ground_profile p
   WHERE p.site_id = p_site_id AND p.status = 'CONFIRMED'
     AND NOT EXISTS (SELECT 1 FROM core.hole_master h WHERE h.ground_profile_id = p.id);
END $$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site(uuid) TO rfcip_head_office, rfcip_field_manager;
