-- =====================================================================
-- 0012 PHASE 4 : 수량산출서 가져오기
--   Master Prompt §12(가져오기 절차), §14(자동검증), §45(AI 역할 한계)
--
--   "AI는 열 이름과 구조를 해석하는 보조 역할만 한다.
--    계약수량 변경을 자동 확정하지 않는다." (§12)
--
--   따라서 업로드 → 분석 → 매핑확인 → 미리보기 → 승인 → 반영 을
--   각각 별개의 상태로 저장한다. 승인 없이 HOLE_MASTER 가 바뀌는 경로는 없다.
-- =====================================================================

CREATE TABLE core.quantity_import (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  file_id       uuid REFERENCES core.stored_file(id),
  document_id   uuid REFERENCES core.document(id),
  original_name text NOT NULL,
  status        text NOT NULL DEFAULT 'ANALYZED'
                  CHECK (status IN ('ANALYZED','MAPPED','PREVIEWED','APPLIED','CANCELLED')),
  -- AI/파서가 해석한 시트 구조. 사람이 검토·수정하는 대상이다.
  analysis      jsonb NOT NULL,
  -- 사용자가 확정한 매핑 (지층열 ↔ GROUND_TYPE, 블록 ↔ 천공종류 등)
  mapping       jsonb,
  -- 교차검증 결과 (산출근거 ↔ 천공조서)
  cross_check   jsonb,
  applied_at    timestamptz,
  applied_by    uuid REFERENCES core.app_user(id),
  created_by    uuid REFERENCES core.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE core.quantity_import IS
  '수량산출서 가져오기 세션. 승인(APPLIED) 전까지 HOLE_MASTER 에 어떤 영향도 주지 않는다.';

CREATE INDEX ix_quantity_import_site ON core.quantity_import(site_id, created_at DESC);
CREATE TRIGGER trg_qi_touch BEFORE UPDATE ON core.quantity_import
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_qi_audit AFTER INSERT OR UPDATE OR DELETE ON core.quantity_import
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- ---------------------------------------------------------------------
-- 파싱된 천공조서 행. 원본 표기를 그대로 보존한다.
-- ---------------------------------------------------------------------
CREATE TABLE core.quantity_import_row (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id      uuid NOT NULL REFERENCES core.quantity_import(id) ON DELETE CASCADE,
  block_key      text NOT NULL,          -- 조서의 좌/우 블록 식별자
  source_row     integer NOT NULL,       -- 원본 엑셀 행번호 (추적용)
  hole_no_raw    text NOT NULL,          -- 셀 표기 원문 (서식 반영)
  hole_no        text NOT NULL,          -- 정규화된 천공번호
  hole_type_code text,
  layers         jsonb NOT NULL,         -- [{ground_type_label, planned_length}]
  layer_sum      numeric(10,3) NOT NULL,
  sheet_total    numeric(10,3),          -- 조서의 합계열 값
  -- 이 행이 발췌본 반복으로 생성된 것인지 (사용자 승인한 확장분)
  generated_from text,
  issues         jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (import_id, block_key, hole_no)
);
CREATE INDEX ix_qi_row_import ON core.quantity_import_row(import_id, block_key);

-- ---------------------------------------------------------------------
-- RLS : 가져오기는 본사 전용 (계약수량에 직접 영향)
-- ---------------------------------------------------------------------
ALTER TABLE core.quantity_import     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.quantity_import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.quantity_import     FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.quantity_import_row FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_qi_ho ON core.quantity_import FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
CREATE POLICY p_qir_ho ON core.quantity_import_row FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

GRANT SELECT, INSERT, UPDATE, DELETE ON core.quantity_import, core.quantity_import_row
  TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 자동검증 추가 (§43)
--   사용자 확인: "H-PILE 천공깊이보다 무근의 천공깊이가 통상적으로 짧게 형성된다."
--   → 규칙을 코드로 강제하지 않고, 어긋나면 본사에 알린다.
--     (실제 설계가 예외일 수 있으므로 차단이 아니라 경고다)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_hole_type_depth(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_hpile_avg numeric;
  v_mugeun_avg numeric;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT avg(h.design_depth_total) INTO v_hpile_avg
    FROM core.hole_master h JOIN core.site_hole_type t ON t.id = h.hole_type_id
   WHERE h.site_id = p_site_id AND t.code = 'HPILE' AND h.design_depth_total IS NOT NULL;

  SELECT avg(h.design_depth_total) INTO v_mugeun_avg
    FROM core.hole_master h JOIN core.site_hole_type t ON t.id = h.hole_type_id
   WHERE h.site_id = p_site_id AND t.code = 'MUGEUN' AND h.design_depth_total IS NOT NULL;

  IF v_hpile_avg IS NULL OR v_mugeun_avg IS NULL THEN
    RETURN;
  END IF;

  IF v_mugeun_avg > v_hpile_avg + 0.001 THEN
    RETURN QUERY SELECT 'MUGEUN_DEEPER_THAN_HPILE', 'WARN', '무근',
      format('무근 평균 천공깊이 %sm 가 H-PILE 평균 %sm 보다 깊습니다. '
             '통상 무근이 더 짧게 형성되므로 설계값을 확인하십시오.',
             trim(to_char(v_mugeun_avg, 'FM9990.000')),
             trim(to_char(v_hpile_avg, 'FM9990.000')));
  ELSIF abs(v_mugeun_avg - v_hpile_avg) <= 0.001 THEN
    RETURN QUERY SELECT 'MUGEUN_SAME_AS_HPILE', 'INFO', '무근',
      format('무근과 H-PILE 의 평균 천공깊이가 %sm 로 동일합니다. '
             '단순화된 임시 설계값인지 확인하십시오.',
             trim(to_char(v_mugeun_avg, 'FM9990.000')));
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_hole_type_depth(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 현장 검증에 천공종류 깊이 검사를 합친다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_validate_site_full(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT * FROM core.fn_validate_site(p_site_id)
  UNION ALL
  SELECT * FROM core.fn_check_hole_type_depth(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;
