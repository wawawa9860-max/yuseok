-- =====================================================================
-- 0013 PHASE 5 : 작업도면 ↔ 천공번호 연결
--   Master Prompt §13(도면 상태), §14(자동검증), §35(세 문서 일치), §38(Revision)
--
--   사용자 지시:
--     "작업도면 PDF 업로드 시 수량산출서와 넘버링이 다른 부분들이 있을 거다.
--      도면 기준으로 넘버링과 천공공수를 맞춰주기 바란다.
--      천공깊이는 발췌본 기준으로 생각해주기 바란다."
--
--   → 도면을 넘버링·공수의 기준으로 삼되, **삭제는 자동으로 하지 않는다.**
--     도면에 없는 천공번호는 사람이 처리방식을 고른다 (§8).
-- =====================================================================

CREATE TABLE core.drawing_import (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  file_id        uuid REFERENCES core.stored_file(id),
  document_id    uuid REFERENCES core.document(id),
  revision_no    integer NOT NULL DEFAULT 0 CHECK (revision_no >= 0),
  original_name  text NOT NULL,
  status         text NOT NULL DEFAULT 'ANALYZED'
                   CHECK (status IN ('ANALYZED','MAPPED','PREVIEWED','APPLIED','CANCELLED')),
  -- 도면에서 뽑은 라벨 원문 + 좌표. 해석하지 않고 그대로 보존한다.
  analysis       jsonb NOT NULL,
  mapping        jsonb,
  reconciliation jsonb,
  applied_at     timestamptz,
  applied_by     uuid REFERENCES core.app_user(id),
  created_by     uuid REFERENCES core.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE core.drawing_import IS
  '작업도면 가져오기 세션. 승인(APPLIED) 전까지 HOLE_MASTER 에 영향을 주지 않는다.';

CREATE INDEX ix_drawing_import_site ON core.drawing_import(site_id, created_at DESC);
CREATE TRIGGER trg_di_touch BEFORE UPDATE ON core.drawing_import
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_di_audit AFTER INSERT OR UPDATE OR DELETE ON core.drawing_import
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

ALTER TABLE core.drawing_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.drawing_import FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_di_ho ON core.drawing_import FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
CREATE POLICY p_di_read ON core.drawing_import FOR SELECT
  USING (app.has_site_access(site_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON core.drawing_import TO rfcip_head_office;
GRANT SELECT ON core.drawing_import TO rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 도면 ↔ HOLE_MASTER 대조 (§14)
--   도면 천공번호 목록을 받아 세 갈래로 나눈다.
--     MATCHED      양쪽 다 있음
--     DRAWING_ONLY 도면에만 있음  → HOLE_MASTER 누락
--     MASTER_ONLY  마스터에만 있음 → 도면 누락
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_reconcile_drawing(p_site_id uuid, p_hole_nos text[])
RETURNS TABLE (
  hole_no text, match_status text, hole_id uuid,
  hole_status text, construction_date date, design_depth_total numeric,
  drawing_order integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  WITH drawing AS (
    SELECT n.hole_no, n.ord
      FROM unnest(p_hole_nos) WITH ORDINALITY AS n(hole_no, ord)
  ),
  master AS (
    SELECT h.id, h.hole_no, h.status, h.construction_date, h.design_depth_total
      FROM core.hole_master h
     WHERE h.site_id = p_site_id AND app.has_site_access(p_site_id)
  )
  SELECT COALESCE(d.hole_no, m.hole_no)::text,
         CASE WHEN d.hole_no IS NULL THEN 'MASTER_ONLY'
              WHEN m.hole_no IS NULL THEN 'DRAWING_ONLY'
              ELSE 'MATCHED' END::text,
         m.id, m.status, m.construction_date, m.design_depth_total,
         d.ord::integer
    FROM drawing d
    FULL OUTER JOIN master m ON m.hole_no = d.hole_no
   ORDER BY d.ord NULLS LAST, core.fn_natural_sort_key(COALESCE(d.hole_no, m.hole_no))
$$;
GRANT EXECUTE ON FUNCTION core.fn_reconcile_drawing(uuid, text[])
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 도면 기준 반영 (§14, §38)
--   도면 순서를 drawing_sequence 로 기록한다.
--   도면에 없는 천공번호는 처리방식을 사람이 고른다.
--     MARK_ONLY : 상태를 NEEDS_CHECK 로 표시만 (기본, 데이터 보존)
--     REMOVE    : 미시공인 것만 삭제. 시공이력이 있으면 거부한다.
--     KEEP      : 아무것도 하지 않는다
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_apply_drawing_order(
  p_site_id  uuid,
  p_hole_nos text[],
  p_drawing_ref text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE v_count integer := 0;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '도면 반영은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  -- 순번을 다시 매기기 전에 기존 값을 비운다 (부분 유니크 인덱스 충돌 방지)
  UPDATE core.hole_master SET drawing_sequence = NULL
   WHERE site_id = p_site_id AND drawing_sequence IS NOT NULL;

  WITH d AS (
    SELECT n.hole_no, n.ord FROM unnest(p_hole_nos) WITH ORDINALITY AS n(hole_no, ord)
  )
  UPDATE core.hole_master h
     SET drawing_sequence = d.ord,
         drawing_ref = COALESCE(p_drawing_ref, h.drawing_ref)
    FROM d
   WHERE h.site_id = p_site_id AND h.hole_no = d.hole_no;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_apply_drawing_order(uuid, text[], text)
  TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 자동검증 확장 (§14, §43)
--   도면과 마스터가 어긋나면 본사에 보고한다. 현장에는 보이지 않는다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_drawing_consistency(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_nos      text[];
  v_applied  timestamptz;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT ARRAY(SELECT jsonb_array_elements_text(di.mapping->'hole_numbers')), di.applied_at
    INTO v_nos, v_applied
    FROM core.drawing_import di
   WHERE di.site_id = p_site_id AND di.status = 'APPLIED'
   ORDER BY di.applied_at DESC LIMIT 1;

  IF v_nos IS NULL THEN
    RETURN QUERY SELECT 'NO_DRAWING_APPLIED', 'INFO', '작업도면',
      '반영된 작업도면이 없어 도면 대조를 하지 못했습니다. (STEP 4)';
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'MASTER_HOLE_MISSING_IN_DRAWING', 'WARN', r.hole_no,
         format('천공번호 %s 가 HOLE_MASTER 에는 있으나 작업도면에 없습니다.', r.hole_no)
    FROM core.fn_reconcile_drawing(p_site_id, v_nos) r
   WHERE r.match_status = 'MASTER_ONLY';

  RETURN QUERY
  SELECT 'DRAWING_HOLE_MISSING_IN_MASTER', 'ERROR', r.hole_no,
         format('작업도면에 있는 천공번호 %s 가 HOLE_MASTER 에 없습니다.', r.hole_no)
    FROM core.fn_reconcile_drawing(p_site_id, v_nos) r
   WHERE r.match_status = 'DRAWING_ONLY';

  RETURN QUERY
  SELECT 'HOLE_WITHOUT_DRAWING_ORDER', 'WARN', h.hole_no,
         format('천공번호 %s 에 도면 순번이 없습니다.', h.hole_no)
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.drawing_sequence IS NULL;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_drawing_consistency(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- 현장 전체 검증에 도면 검사를 합친다.
CREATE OR REPLACE FUNCTION core.fn_validate_site_full(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT * FROM core.fn_validate_site(p_site_id)
  UNION ALL
  SELECT * FROM core.fn_check_hole_type_depth(p_site_id)
  UNION ALL
  SELECT * FROM core.fn_check_drawing_consistency(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 도면 진행상태 VIEW (§13)
--   도면 순서대로 상태를 보여준다. 상태는 저장하지 않고 파생한다.
-- ---------------------------------------------------------------------
CREATE VIEW core.v_drawing_progress AS
SELECT h.site_id, h.id AS hole_id, h.hole_no, h.sort_key,
       h.drawing_sequence, h.drawing_ref, h.section,
       ht.code AS hole_type_code, ht.name AS hole_type_name,
       h.design_depth_total, h.actual_depth_total, h.construction_date,
       CASE
         WHEN h.status = 'COMPLETED' AND h.construction_date = CURRENT_DATE THEN '금일완료'
         WHEN h.status = 'COMPLETED'                                        THEN '기존완료'
         WHEN h.status = 'ON_HOLD'                                          THEN '보류'
         WHEN h.status = 'CHANGED'                                          THEN '변경'
         WHEN h.status = 'NEEDS_CHECK'                                      THEN '확인필요'
         ELSE '미시공'
       END AS display_status
  FROM core.hole_master h
  LEFT JOIN core.site_hole_type ht ON ht.id = h.hole_type_id;

GRANT SELECT ON core.v_drawing_progress TO rfcip_head_office, rfcip_field_manager;
