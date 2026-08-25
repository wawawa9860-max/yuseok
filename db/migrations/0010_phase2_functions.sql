-- =====================================================================
-- 0010 PHASE 2 : 결정론적 업무 함수
--   Master Prompt §38(Revision), §46(계산은 코드로), §17(최초설정 STEP)
--   금액/수량 계산과 상태 전이를 애플리케이션이 아닌 DB 함수로 고정한다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 천공번호 Revision 스냅샷 (§38)
--   HOLE_MASTER 를 바꾸기 "전에" 현재 상태를 revision 으로 보존한다.
--   원계약(REV 0)은 천공번호 생성 시 자동으로 남긴다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_snapshot_hole_revision(
  p_hole_id       uuid,
  p_revision_type text,
  p_reason        text DEFAULT NULL,
  p_effective     date DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  h       core.hole_master%ROWTYPE;
  v_next  integer;
BEGIN
  SELECT * INTO h FROM core.hole_master WHERE id = p_hole_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '천공번호를 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION 'Revision 생성은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT COALESCE(max(revision_no), -1) + 1 INTO v_next
    FROM core.hole_revision WHERE hole_id = p_hole_id;

  UPDATE core.hole_revision SET is_current = false WHERE hole_id = p_hole_id AND is_current;

  INSERT INTO core.hole_revision (
    hole_id, revision_no, revision_type, ground_profile_id, design_depth_total,
    contract_quantity, contract_unit, contract_unit_price, snapshot,
    reason, effective_date, is_current, created_by)
  VALUES (
    p_hole_id, v_next, p_revision_type, h.ground_profile_id, h.design_depth_total,
    h.contract_quantity, h.contract_unit, h.contract_unit_price, to_jsonb(h),
    p_reason, COALESCE(p_effective, CURRENT_DATE), true, app.current_user_id());

  UPDATE core.hole_master SET current_revision = v_next WHERE id = p_hole_id;
  RETURN v_next;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_snapshot_hole_revision(uuid, text, text, date)
  TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 계약 Revision 전환 (§38)
--   원계약 금액은 절대 건드리지 않고, current_amount 만 갱신한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_activate_contract_revision(
  p_contract_id uuid,
  p_revision_no integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE v_amount numeric(18,2);
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '계약 Revision 전환은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT contract_amount INTO v_amount
    FROM core.contract_revision WHERE contract_id = p_contract_id AND revision_no = p_revision_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION '계약 Revision 을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;

  UPDATE core.contract_revision SET is_current = false
   WHERE contract_id = p_contract_id AND is_current;
  UPDATE core.contract_revision SET is_current = true
   WHERE contract_id = p_contract_id AND revision_no = p_revision_no;
  UPDATE core.contract SET current_amount = v_amount, current_revision = p_revision_no
   WHERE id = p_contract_id;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_activate_contract_revision(uuid, integer)
  TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 현장 최초설정 진행상황 (§17 STEP 1~12)
--   "무엇이 남았는지"를 사람이 세지 않고 코드가 판정한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_site_setup_status(p_site_id uuid)
RETURNS TABLE (step smallint, step_name text, done boolean, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_holes        integer;
  v_holes_ground integer;
  v_holes_qty    integer;
  v_holes_mix    integer;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE ground_profile_id IS NOT NULL),
         count(*) FILTER (WHERE contract_quantity IS NOT NULL),
         count(*) FILTER (WHERE planned_ready_mix_quantity IS NOT NULL)
    INTO v_holes, v_holes_ground, v_holes_qty, v_holes_mix
    FROM core.hole_master WHERE site_id = p_site_id;

  RETURN QUERY SELECT 1::smallint, '현장 기본정보'::text, true,
    (SELECT s.site_name FROM core.site s WHERE s.id = p_site_id);

  RETURN QUERY SELECT 2::smallint, '계약정보'::text,
    EXISTS (SELECT 1 FROM core.contract ct WHERE ct.site_id = p_site_id),
    (SELECT count(*)::text || '건' FROM core.contract ct WHERE ct.site_id = p_site_id);

  RETURN QUERY SELECT 3::smallint, '수량산출서 등록'::text,
    EXISTS (SELECT 1 FROM core.document d WHERE d.site_id = p_site_id AND d.doc_type='QUANTITY_SHEET'),
    (SELECT count(*)::text || '건' FROM core.document d
      WHERE d.site_id = p_site_id AND d.doc_type='QUANTITY_SHEET');

  RETURN QUERY SELECT 4::smallint, '작업도면 등록'::text,
    EXISTS (SELECT 1 FROM core.document d WHERE d.site_id = p_site_id AND d.doc_type='WORK_DRAWING'),
    (SELECT count(*)::text || '건' FROM core.document d
      WHERE d.site_id = p_site_id AND d.doc_type='WORK_DRAWING');

  RETURN QUERY SELECT 5::smallint, '천공번호 생성/매핑'::text, v_holes > 0,
    v_holes::text || '공';

  RETURN QUERY SELECT 6::smallint, '지층종류 생성'::text,
    EXISTS (SELECT 1 FROM core.ground_type g WHERE g.site_id = p_site_id),
    (SELECT COALESCE(string_agg(g.name, ', ' ORDER BY g.sort_order), '없음')
       FROM core.ground_type g WHERE g.site_id = p_site_id AND g.is_active);

  RETURN QUERY SELECT 7::smallint, '천공번호별 지반조건'::text,
    (v_holes > 0 AND v_holes_ground = v_holes),
    v_holes_ground::text || ' / ' || v_holes::text || '공';

  RETURN QUERY SELECT 8::smallint, '계약수량/단가 연결'::text,
    (v_holes > 0 AND v_holes_qty = v_holes),
    v_holes_qty::text || ' / ' || v_holes::text || '공';

  RETURN QUERY SELECT 9::smallint, '계획 레미콘량'::text,
    (v_holes > 0 AND v_holes_mix = v_holes),
    v_holes_mix::text || ' / ' || v_holes::text || '공';

  RETURN QUERY SELECT 10::smallint, '기본 인원/장비'::text, false, 'PHASE 7'::text;
  RETURN QUERY SELECT 11::smallint, '노무/장비 기본단가'::text, false, 'PHASE 8'::text;

  RETURN QUERY SELECT 12::smallint, '검증'::text,
    NOT EXISTS (SELECT 1 FROM core.fn_validate_site(p_site_id) v WHERE v.severity='ERROR'),
    (SELECT count(*)::text || '건 오류'
       FROM core.fn_validate_site(p_site_id) v WHERE v.severity='ERROR');
END $$;
GRANT EXECUTE ON FUNCTION core.fn_site_setup_status(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 천공번호 목록 검증 : 일괄생성 전에 충돌을 미리 알려준다 (§14)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_hole_numbers(p_site_id uuid, p_hole_nos text[])
RETURNS TABLE (hole_no text, issue text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  -- 입력 목록 내부의 중복
  SELECT n, '입력 목록에 중복된 번호'
    FROM unnest(p_hole_nos) AS n
   GROUP BY n HAVING count(*) > 1
  UNION ALL
  -- 이미 등록된 번호
  SELECT h.hole_no, '이미 등록된 번호'
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.hole_no = ANY(p_hole_nos)
$$;
GRANT EXECUTE ON FUNCTION core.fn_check_hole_numbers(uuid, text[])
  TO rfcip_head_office, rfcip_field_manager;
