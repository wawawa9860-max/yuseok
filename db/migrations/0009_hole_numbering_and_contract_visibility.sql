-- =====================================================================
-- 0009 천공번호 체계 교체 + 계약단가 공개범위 변경
--
-- 배경 (실제 수량산출서 샘플 분석, docs/QUANTITY_SHEET_ANALYSIS.md)
--   PHASE 1 은 천공번호를 'A-001' 형식으로 가정했으나 실제 조서는
--   '1'~'29'(H-PILE) 와 '1.1'~'3.9'(무근) 처럼 현장·도면마다 다르다.
--   사용자 지시: "천공번호는 현장마다 다르므로 평면도/작업도면(PDF)에
--   명기된 기준으로 진행한다."
--
--   → 번호 형식을 강제하지 않고, 어떤 표기든 사람이 읽는 순서대로
--     정렬되는 자연정렬 키를 도입한다.
--
-- 사용자 지시: 현장관리자에게 계약단가를 공개해도 된다.
--   → hole_master.contract_unit_price 및 계약내역 조회를 허용한다.
--     단 private_cost(노무·장비 단가, 내부원가)는 그대로 차단한다 (§29).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 자연정렬 키 : 숫자 구간을 0 으로 채워 문자열 비교만으로 올바르게 정렬한다.
--   '1'      → '000000000001'
--   '1.1'    → '000000000001.000000000001'
--   '2'      → '000000000002'
--   'A-001'  → 'A-000000000001'
--   'C1-10'  → 'C000000000001-000000000010'
-- 결과: 1 < 1.1 < 1.2 < 2 < 10  (문자열 정렬만으로 성립)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_natural_sort_key(p_text text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  v_out text := '';
  v_tok text;
BEGIN
  FOR v_tok IN
    SELECT (regexp_matches(p_text, '([0-9]+|[^0-9]+)', 'g'))[1]
  LOOP
    IF v_tok ~ '^[0-9]+$' THEN
      v_out := v_out || lpad(v_tok, 12, '0');
    ELSE
      v_out := v_out || v_tok;
    END IF;
  END LOOP;
  RETURN v_out;
END $$;
COMMENT ON FUNCTION core.fn_natural_sort_key(text) IS
  '천공번호 표기를 강제하지 않고 사람이 읽는 순서대로 정렬하기 위한 키';

-- ---------------------------------------------------------------------
-- HOLE_MASTER 정렬키 교체
-- ---------------------------------------------------------------------
-- 컬럼을 바꾸기 전에 의존 VIEW 를 먼저 제거한다.
DROP VIEW IF EXISTS share.v_hole_progress;
DROP VIEW IF EXISTS share.v_layer_plan;
DROP VIEW IF EXISTS core.v_hole_layer_plan;
DROP VIEW IF EXISTS core.v_hole_status;

DROP INDEX IF EXISTS core.ix_hole_site_order;
ALTER TABLE core.hole_master DROP COLUMN hole_prefix;
ALTER TABLE core.hole_master DROP COLUMN hole_index;

ALTER TABLE core.hole_master
  ADD COLUMN sort_key text GENERATED ALWAYS AS (core.fn_natural_sort_key(hole_no)) STORED,
  -- 작업도면(PDF)에 표기된 순번. 도면 연결(PHASE 5)의 기준이며 선택 항목이다.
  ADD COLUMN drawing_sequence integer CHECK (drawing_sequence > 0),
  -- 도면상의 위치 참조 (도면번호/좌표 등). PHASE 5 에서 사용한다.
  ADD COLUMN drawing_ref text;

COMMENT ON COLUMN core.hole_master.hole_no IS
  '작업도면에 표기된 천공번호 원문. 형식을 강제하지 않는다 (1, 1.1, A-001, C1-10 …)';
COMMENT ON COLUMN core.hole_master.sort_key IS
  '자연정렬 키. 목록·범위선택은 항상 이 값으로 정렬한다.';
COMMENT ON COLUMN core.hole_master.drawing_sequence IS
  '작업도면에 표기된 순번(있는 경우). 도면 연결의 기준.';

CREATE INDEX ix_hole_site_sort ON core.hole_master(site_id, sort_key);
CREATE UNIQUE INDEX ux_hole_site_drawing_seq
  ON core.hole_master(site_id, drawing_sequence) WHERE drawing_sequence IS NOT NULL;

-- 파생 VIEW 재생성 (컬럼이 바뀌었으므로)
CREATE VIEW core.v_hole_status AS
SELECT h.id, h.site_id, h.hole_no, h.sort_key, h.drawing_sequence, h.section,
       h.status, h.construction_date, h.change_review_required,
       h.design_depth_total, h.actual_depth_total, h.ground_profile_id,
       CASE
         WHEN h.status = 'COMPLETED' AND h.construction_date = CURRENT_DATE THEN '금일완료'
         WHEN h.status = 'COMPLETED'                                        THEN '기존완료'
         WHEN h.status = 'ON_HOLD'                                          THEN '보류'
         WHEN h.status = 'CHANGED'                                          THEN '변경'
         WHEN h.status = 'NEEDS_CHECK'                                      THEN '확인필요'
         ELSE '미시공'
       END AS display_status
  FROM core.hole_master h;

CREATE VIEW core.v_hole_layer_plan AS
SELECT h.id AS hole_id, h.site_id, h.hole_no, h.sort_key, h.status, h.construction_date,
       g.id AS ground_type_id, g.code AS ground_type_code, g.name AS ground_type_name,
       l.sequence, l.planned_length
  FROM core.hole_master h
  JOIN core.ground_profile_layer l ON l.ground_profile_id = h.ground_profile_id
  JOIN core.ground_type g          ON g.id = l.ground_type_id;

CREATE VIEW share.v_hole_progress AS
SELECT h.site_id, h.hole_no, h.section, h.sort_key, h.drawing_sequence,
       h.design_depth_total, h.actual_depth_total, h.construction_date,
       CASE WHEN h.status = 'COMPLETED' THEN '완료' ELSE '미시공' END AS progress_status
  FROM core.hole_master h;

CREATE VIEW share.v_layer_plan AS
SELECT v.site_id, v.hole_no, v.ground_type_code, v.ground_type_name,
       v.planned_length, v.status, v.construction_date
  FROM core.v_hole_layer_plan v;

GRANT SELECT ON core.v_hole_status, core.v_hole_layer_plan
  TO rfcip_head_office, rfcip_field_manager;
GRANT SELECT ON share.v_hole_progress, share.v_layer_plan
  TO rfcip_external, rfcip_field_manager, rfcip_head_office;

-- ---------------------------------------------------------------------
-- 계약단가 공개 (사용자 지시)
--   내부원가(private_cost)는 그대로 차단된다. 여기서 여는 것은
--   계약상대방과도 공유되는 '계약단가' 뿐이다.
-- ---------------------------------------------------------------------
GRANT SELECT (
  id, site_id, hole_no, section, hole_type_id, sort_key, drawing_sequence, drawing_ref,
  drawing_revision, quantity_revision, design_depth_total, actual_depth_total,
  ground_profile_id, contract_quantity, contract_unit, contract_unit_price,
  planned_ready_mix_quantity, actual_ready_mix_quantity,
  status, construction_date, change_review_required, current_revision,
  created_by, created_at, updated_at
) ON core.hole_master TO rfcip_field_manager;

GRANT UPDATE (
  actual_depth_total, actual_ready_mix_quantity, status, construction_date
) ON core.hole_master TO rfcip_field_manager;

-- 계약내역(품목·단가) 조회 허용. 등록/수정은 여전히 본사만.
GRANT SELECT ON core.contract_item, core.contract_revision TO rfcip_field_manager;
CREATE POLICY p_contract_item_read ON core.contract_item FOR SELECT
  USING (EXISTS (SELECT 1 FROM core.contract ct
                  WHERE ct.id = contract_id AND app.has_site_access(ct.site_id)));
CREATE POLICY p_contract_rev_read ON core.contract_revision FOR SELECT
  USING (EXISTS (SELECT 1 FROM core.contract ct
                  WHERE ct.id = contract_id AND app.has_site_access(ct.site_id)));

-- ---------------------------------------------------------------------
-- 현장 설계 파라미터 (실제 수량산출서에 존재하는 현장 단위 값)
--   직경 / C.T.C / 할증률 등은 현장마다 다르므로 하드코딩하지 않는다.
--   계획 레미콘량 계산(PHASE 7)의 근거가 된다.
-- ---------------------------------------------------------------------
CREATE TABLE core.site_design_param (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  param_code  text NOT NULL,
  param_name  text NOT NULL,
  param_value numeric(18,6) NOT NULL,
  unit        text,
  note        text,
  created_by  uuid REFERENCES core.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, param_code)
);
COMMENT ON TABLE core.site_design_param IS
  '현장 설계 파라미터(직경/C.T.C/할증률 등). 수량산출서에서 확인된 값만 등록한다.';

CREATE TRIGGER trg_sdp_touch BEFORE UPDATE ON core.site_design_param
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_sdp_audit AFTER INSERT OR UPDATE OR DELETE ON core.site_design_param
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

ALTER TABLE core.site_design_param ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_design_param FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_sdp_read  ON core.site_design_param FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_sdp_write ON core.site_design_param FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
GRANT SELECT ON core.site_design_param TO rfcip_head_office, rfcip_field_manager;
GRANT INSERT, UPDATE, DELETE ON core.site_design_param TO rfcip_head_office;
