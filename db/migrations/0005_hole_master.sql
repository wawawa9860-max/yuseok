-- =====================================================================
-- 0005 HOLE_MASTER (모든 시스템의 단일 기준) + Hole Revision
-- Master Prompt §4, §5, §13, §14, §16, §38
-- =====================================================================

CREATE TABLE core.hole_master (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id                   uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  hole_no                   text NOT NULL,
  section                   text,
  hole_type_id              uuid REFERENCES core.site_hole_type(id),

  -- 범위 일괄설정 / 범위 선택을 위한 결정론적 정렬키 (§10, §19)
  hole_prefix               text    GENERATED ALWAYS AS
                              (COALESCE(substring(hole_no from '^(.*?)[0-9]+$'), hole_no)) STORED,
  hole_index                integer GENERATED ALWAYS AS
                              (NULLIF(substring(hole_no from '([0-9]+)$'), '')::integer) STORED,

  drawing_revision          integer NOT NULL DEFAULT 0 CHECK (drawing_revision  >= 0),
  quantity_revision         integer NOT NULL DEFAULT 0 CHECK (quantity_revision >= 0),

  design_depth_total        numeric(8,3) CHECK (design_depth_total > 0),
  actual_depth_total        numeric(8,3) CHECK (actual_depth_total > 0),

  ground_profile_id         uuid REFERENCES core.ground_profile(id),

  contract_quantity         numeric(18,4) CHECK (contract_quantity >= 0),
  contract_unit             text,
  contract_unit_price       numeric(18,2) CHECK (contract_unit_price >= 0),

  planned_ready_mix_quantity numeric(12,3) CHECK (planned_ready_mix_quantity >= 0),
  actual_ready_mix_quantity  numeric(12,3) CHECK (actual_ready_mix_quantity  >= 0),

  status                    text NOT NULL DEFAULT 'NOT_STARTED'
                              CHECK (status IN ('NOT_STARTED','COMPLETED','ON_HOLD','CHANGED','NEEDS_CHECK')),
  construction_date         date,

  change_review_required    boolean NOT NULL DEFAULT false,
  current_revision          integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),

  created_by                uuid REFERENCES core.app_user(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- 천공번호 중복 차단 (§14)
  CONSTRAINT ux_hole_site_no UNIQUE (site_id, hole_no),
  -- 완료 상태에는 시공일이 반드시 있어야 한다.
  CONSTRAINT ck_hole_completed_date CHECK (status <> 'COMPLETED' OR construction_date IS NOT NULL)
);
COMMENT ON TABLE core.hole_master IS
  '수량산출서/작업도면/천공일지/수량실적은 모두 이 테이블의 VIEW 다. 별도 원장을 만들지 않는다 (§4).';
COMMENT ON COLUMN core.hole_master.status IS
  '미시공/보류/변경/확인필요/완료. 금일완료·기존완료는 construction_date 로 파생한다 (중복저장 금지, §1-7)';

CREATE INDEX ix_hole_site_order ON core.hole_master(site_id, hole_prefix, hole_index);
CREATE INDEX ix_hole_site_status ON core.hole_master(site_id, status);
CREATE INDEX ix_hole_constr_date ON core.hole_master(site_id, construction_date);
CREATE INDEX ix_hole_profile ON core.hole_master(ground_profile_id);

CREATE TRIGGER trg_hole_touch BEFORE UPDATE ON core.hole_master
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_hole_audit AFTER INSERT OR UPDATE OR DELETE ON core.hole_master
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- 지반조건은 같은 현장의 CONFIRMED 프로파일만 연결할 수 있다.
CREATE OR REPLACE FUNCTION core.trg_hole_profile_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p core.ground_profile%ROWTYPE;
BEGIN
  IF NEW.ground_profile_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO p FROM core.ground_profile WHERE id = NEW.ground_profile_id;
  IF p.site_id <> NEW.site_id THEN
    RAISE EXCEPTION '다른 현장의 지반조건은 연결할 수 없습니다.' USING ERRCODE='check_violation';
  END IF;
  IF p.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION '확정(CONFIRMED)되지 않은 지반조건은 천공번호에 연결할 수 없습니다.'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_hole_profile_guard BEFORE INSERT OR UPDATE OF ground_profile_id, site_id
  ON core.hole_master FOR EACH ROW EXECUTE FUNCTION core.trg_hole_profile_guard();

-- ---------------------------------------------------------------------
-- Hole Revision (§38) : 원계약 / 설계변경 전·후 / 실제시공 을 모두 추적
-- ---------------------------------------------------------------------
CREATE TABLE core.hole_revision (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hole_id             uuid NOT NULL REFERENCES core.hole_master(id) ON DELETE CASCADE,
  revision_no         integer NOT NULL CHECK (revision_no >= 0),
  revision_type       text NOT NULL
                        CHECK (revision_type IN ('ORIGINAL_CONTRACT','DESIGN_CHANGE','FIELD_ACTUAL')),
  ground_profile_id   uuid REFERENCES core.ground_profile(id),
  design_depth_total  numeric(8,3),
  contract_quantity   numeric(18,4),
  contract_unit       text,
  contract_unit_price numeric(18,2),
  snapshot            jsonb NOT NULL,          -- 변경시점 HOLE_MASTER 전체 이미지
  reason              text,
  effective_date      date,
  approved_by         uuid REFERENCES core.app_user(id),
  approved_at         timestamptz,
  is_current          boolean NOT NULL DEFAULT false,
  created_by          uuid REFERENCES core.app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hole_id, revision_no)
);
CREATE UNIQUE INDEX ux_hole_revision_current ON core.hole_revision(hole_id) WHERE is_current;

-- ---------------------------------------------------------------------
-- 파생 VIEW : 화면 표시 상태 (§13) — 저장하지 않고 계산한다.
-- ---------------------------------------------------------------------
CREATE VIEW core.v_hole_status AS
SELECT h.id, h.site_id, h.hole_no, h.hole_prefix, h.hole_index, h.section,
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

-- ---------------------------------------------------------------------
-- 지층별 계획수량 파생 VIEW (§20) — 현장관리자가 다시 입력하지 않는다.
-- ---------------------------------------------------------------------
CREATE VIEW core.v_hole_layer_plan AS
SELECT h.id AS hole_id, h.site_id, h.hole_no, h.status, h.construction_date,
       g.id AS ground_type_id, g.code AS ground_type_code, g.name AS ground_type_name,
       l.sequence, l.planned_length
  FROM core.hole_master h
  JOIN core.ground_profile_layer l ON l.ground_profile_id = h.ground_profile_id
  JOIN core.ground_type g          ON g.id = l.ground_type_id;

-- RLS
ALTER TABLE core.hole_master   ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.hole_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.hole_master   FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.hole_revision FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_hole_read  ON core.hole_master FOR SELECT USING (app.has_site_access(site_id));
-- 현장관리자는 일일 시공실적만 갱신한다(컬럼 GRANT 로 추가 제한). 신규/삭제는 본사.
CREATE POLICY p_hole_update ON core.hole_master FOR UPDATE
  USING (app.has_site_access(site_id)) WITH CHECK (app.has_site_access(site_id));
CREATE POLICY p_hole_admin ON core.hole_master FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_hole_rev_read ON core.hole_revision FOR SELECT
  USING (EXISTS (SELECT 1 FROM core.hole_master h
                  WHERE h.id = hole_id AND app.has_site_access(h.site_id)));
CREATE POLICY p_hole_rev_admin ON core.hole_revision FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

-- 계약단가는 컬럼 단위로 현장관리자에게서 차단한다 (§44).
GRANT SELECT (
  id, site_id, hole_no, section, hole_type_id, hole_prefix, hole_index,
  drawing_revision, quantity_revision, design_depth_total, actual_depth_total,
  ground_profile_id, contract_quantity, contract_unit,
  planned_ready_mix_quantity, actual_ready_mix_quantity,
  status, construction_date, change_review_required, current_revision,
  created_by, created_at, updated_at
) ON core.hole_master TO rfcip_field_manager;

-- 현장관리자가 갱신할 수 있는 컬럼도 일일입력 항목으로 한정한다.
GRANT UPDATE (
  actual_depth_total, actual_ready_mix_quantity, status, construction_date
) ON core.hole_master TO rfcip_field_manager;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.hole_master TO rfcip_head_office;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.hole_revision TO rfcip_head_office;
GRANT SELECT ON core.hole_revision TO rfcip_field_manager;
GRANT SELECT ON core.v_hole_status, core.v_hole_layer_plan
  TO rfcip_head_office, rfcip_field_manager;
