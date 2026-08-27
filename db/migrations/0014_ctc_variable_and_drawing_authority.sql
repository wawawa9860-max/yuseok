-- =====================================================================
-- 0014 공수의 확정 기준을 도면 넘버링으로 고정
--
-- 사용자 확인 (현장 실무):
--   "0.47 간격으로 유지가 되는 구간도 있고 유지가 안 되는 구간들이 있어서
--    간격을 좁혀야 하는 상황이 매번 생긴다.
--    그러므로 도면 넘버링에 맞도록 수량을 체크하였다."
--
-- 따라서:
--   1) 총 공수 = 벽면연장 ÷ C.T.C 는 **참고 추정값**이다. 공수를 확정하지 않는다.
--   2) 공수의 확정 기준은 **도면에 표기된 천공번호 개수**다.
--   3) C.T.C 는 현장 전체 하나가 아니라 **구간마다 다를 수 있다.**
--
-- 시스템은 계산값과 실제가 다르다고 오류로 보지 않는다. 정상 상황이다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 설계 파라미터를 구간별로 둘 수 있게 한다.
--   section = NULL  → 현장 전체 기본값
--   section = 'A구간' → 해당 구간에만 적용
-- ---------------------------------------------------------------------
ALTER TABLE core.site_design_param
  ADD COLUMN section text,
  -- 참고값 여부. 계산으로 얻은 추정치는 확정근거가 아니다.
  ADD COLUMN is_reference boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN core.site_design_param.section IS
  'NULL 이면 현장 전체 기본값. C.T.C 처럼 구간마다 달라지는 값은 구간명을 넣는다.';
COMMENT ON COLUMN core.site_design_param.is_reference IS
  'true = 계산으로 얻은 참고 추정값(예: 연장÷C.T.C). 공수·수량 확정 근거로 쓰지 않는다.';

ALTER TABLE core.site_design_param DROP CONSTRAINT site_design_param_site_id_param_code_key;
CREATE UNIQUE INDEX ux_sdp_site_code_section
  ON core.site_design_param (site_id, param_code, COALESCE(section, ''));

-- 계산으로 유도되는 파라미터는 참고값으로 표시한다.
UPDATE core.site_design_param
   SET is_reference = true
 WHERE param_code IN ('TOTAL_HOLE_COUNT', 'HPILE_COUNT', 'MUGEUN_COUNT');

-- ---------------------------------------------------------------------
-- 공수 근거 확인 (§43)
--   설계 파라미터의 계산 공수와 실제 등록 공수가 다른 것은 **정상**이다.
--   C.T.C 가 구간마다 달라지기 때문이다. 따라서 INFO 로만 알린다.
--   단, 도면이 반영된 뒤에는 도면 공수와 마스터 공수가 같아야 한다 → 그건 ERROR.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_hole_count_basis(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_actual    integer;
  v_reference numeric;
  v_drawing   integer;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT count(*) INTO v_actual FROM core.hole_master WHERE site_id = p_site_id;
  IF v_actual = 0 THEN RETURN; END IF;

  SELECT param_value INTO v_reference
    FROM core.site_design_param
   WHERE site_id = p_site_id AND param_code = 'TOTAL_HOLE_COUNT' AND section IS NULL;

  SELECT count(*) INTO v_drawing
    FROM core.hole_master
   WHERE site_id = p_site_id AND drawing_sequence IS NOT NULL;

  -- 계산 추정치와의 차이는 정상이다. C.T.C 가 구간마다 달라지기 때문이다.
  IF v_reference IS NOT NULL AND abs(v_reference - v_actual) >= 1 THEN
    RETURN QUERY SELECT 'HOLE_COUNT_VS_REFERENCE', 'INFO', '총 공수',
      format('등록 공수 %s공 은 설계 참고값 %s공 과 다릅니다. '
             'C.T.C 가 구간마다 달라지므로 정상일 수 있으며, 공수의 기준은 도면 넘버링입니다.',
             v_actual, trim(to_char(v_reference, 'FM9990.##')));
  END IF;

  -- 도면이 반영된 뒤라면 도면 공수가 기준이다.
  IF v_drawing > 0 AND v_drawing <> v_actual THEN
    RETURN QUERY SELECT 'HOLE_COUNT_VS_DRAWING', 'WARN', '총 공수',
      format('도면에 표기된 %s공 과 HOLE_MASTER 의 %s공 이 다릅니다. '
             '도면 대조표에서 처리방식을 확인하십시오.', v_drawing, v_actual);
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_hole_count_basis(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 구간별 실제 C.T.C 파생 조회
--   도면 순번이 매겨진 뒤에는 구간별 공수를 실제로 셀 수 있다.
--   벽면연장을 알면 구간 평균 C.T.C 를 역산할 수 있으나,
--   **시스템이 이를 설계값으로 확정하지 않는다.** 참고 조회일 뿐이다.
-- ---------------------------------------------------------------------
CREATE VIEW core.v_section_hole_count AS
SELECT h.site_id,
       COALESCE(h.section, '(구간미지정)') AS section,
       ht.code AS hole_type_code,
       count(*)::integer AS hole_count,
       min(h.drawing_sequence) AS drawing_from,
       max(h.drawing_sequence) AS drawing_to,
       sum(h.design_depth_total)::numeric(14,3) AS planned_length
  FROM core.hole_master h
  LEFT JOIN core.site_hole_type ht ON ht.id = h.hole_type_id
 GROUP BY h.site_id, COALESCE(h.section, '(구간미지정)'), ht.code;

GRANT SELECT ON core.v_section_hole_count TO rfcip_head_office, rfcip_field_manager;

-- 현장 전체 검증에 공수 근거 확인을 합친다.
CREATE OR REPLACE FUNCTION core.fn_validate_site_full(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT * FROM core.fn_validate_site(p_site_id)
  UNION ALL
  SELECT * FROM core.fn_check_hole_type_depth(p_site_id)
  UNION ALL
  SELECT * FROM core.fn_check_drawing_consistency(p_site_id)
  UNION ALL
  SELECT * FROM core.fn_check_hole_count_basis(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;
