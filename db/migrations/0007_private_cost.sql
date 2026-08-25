-- =====================================================================
-- 0007 PRIVATE_COST : 본사전용 원가 (절대 규칙)
-- Master Prompt §24(6개 고정항목), §28(증빙상태), §29(원가보안), §30(모델), §44
--
--  보안 3중 방어
--   1) 스키마 GRANT      : rfcip_external 은 private_cost 에 USAGE 자체가 없다.
--   2) 테이블/컬럼 GRANT : 단가(rate) 테이블은 현장관리자에게 GRANT 하지 않는다.
--   3) RLS               : 현장관리자는 자기 현장 + 본인 입력분만.
--  ※ 프론트엔드 숨김은 방어수단으로 인정하지 않는다.
-- =====================================================================

-- 투입원가 6개 항목 고정 (§24)
CREATE TABLE private_cost.cost_type (
  code       text PRIMARY KEY,
  name_ko    text NOT NULL,
  sort_order smallint NOT NULL
);
INSERT INTO private_cost.cost_type(code,name_ko,sort_order) VALUES
  ('C01','노무비',1), ('C02','장비비',2), ('C03','유류비',3),
  ('C04','잡자재비',4), ('C05','식대',5), ('C06','기타경비',6);

-- DAILY_COST (§30)
CREATE TABLE private_cost.daily_cost (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  cost_date       date NOT NULL,
  cost_type       text NOT NULL REFERENCES private_cost.cost_type(code),
  amount          numeric(18,2) NOT NULL CHECK (amount >= 0),
  quantity        numeric(18,4) CHECK (quantity >= 0),
  unit            text,
  vendor          text,
  memo            text,
  evidence_status text NOT NULL DEFAULT 'PENDING_EVIDENCE'
                    CHECK (evidence_status IN ('VERIFIED','PENDING_EVIDENCE','HEAD_OFFICE_REVIEW')),
  created_by      uuid REFERENCES core.app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN private_cost.daily_cost.evidence_status IS
  'VERIFIED=증빙완료 / PENDING_EVIDENCE=증빙대기 / HEAD_OFFICE_REVIEW=본사확인 (§28)';
CREATE INDEX ix_daily_cost_site_date ON private_cost.daily_cost(site_id, cost_date);

CREATE TRIGGER trg_daily_cost_touch BEFORE UPDATE ON private_cost.daily_cost
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_daily_cost_audit AFTER INSERT OR UPDATE OR DELETE ON private_cost.daily_cost
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- COST_EVIDENCE (§30)
CREATE TABLE private_cost.cost_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_id     uuid NOT NULL REFERENCES private_cost.daily_cost(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES core.stored_file(id),
  file_type   text NOT NULL DEFAULT 'RECEIPT' CHECK (file_type IN ('RECEIPT','DELIVERY_NOTE','OTHER')),
  uploaded_by uuid REFERENCES core.app_user(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cost_id, file_id)
);

-- 단가 마스터 : 본사만. 현장관리자에게는 GRANT 자체를 하지 않는다 (§25, §26, §29).
CREATE TABLE private_cost.labor_rate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid REFERENCES core.site(id) ON DELETE CASCADE,  -- NULL = 전사 기본단가
  role_name      text NOT NULL,
  daily_rate     numeric(18,2) NOT NULL CHECK (daily_rate >= 0),
  effective_from date NOT NULL,
  effective_to   date,
  created_by     uuid REFERENCES core.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_labor_rate_period CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE private_cost.equipment_rate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid REFERENCES core.site(id) ON DELETE CASCADE,
  equipment_name text NOT NULL,
  charge_type    text NOT NULL CHECK (charge_type IN ('DAILY','MONTHLY','OTHER')),  -- 일대/월대/기타 (§26)
  rate           numeric(18,2) NOT NULL CHECK (rate >= 0),
  effective_from date NOT NULL,
  effective_to   date,
  created_by     uuid REFERENCES core.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_equip_rate_period CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
ALTER TABLE private_cost.daily_cost     ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_cost.cost_evidence  ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_cost.labor_rate     ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_cost.equipment_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_cost.daily_cost     FORCE  ROW LEVEL SECURITY;
ALTER TABLE private_cost.cost_evidence  FORCE  ROW LEVEL SECURITY;
ALTER TABLE private_cost.labor_rate     FORCE  ROW LEVEL SECURITY;
ALTER TABLE private_cost.equipment_rate FORCE  ROW LEVEL SECURITY;

-- 현장관리자 : 자기 현장 + 본인이 입력한 건만. 타인/타현장 원가 합계 조회 불가 (§44).
CREATE POLICY p_cost_field_read ON private_cost.daily_cost FOR SELECT
  USING (app.has_site_access(site_id) AND created_by = app.current_user_id());
CREATE POLICY p_cost_field_insert ON private_cost.daily_cost FOR INSERT
  WITH CHECK (app.has_site_access(site_id) AND created_by = app.current_user_id());
CREATE POLICY p_cost_field_update ON private_cost.daily_cost FOR UPDATE
  USING (app.has_site_access(site_id) AND created_by = app.current_user_id()
         AND evidence_status <> 'VERIFIED')
  WITH CHECK (app.has_site_access(site_id) AND created_by = app.current_user_id());
CREATE POLICY p_cost_ho ON private_cost.daily_cost FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_evidence_field ON private_cost.cost_evidence FOR SELECT
  USING (EXISTS (SELECT 1 FROM private_cost.daily_cost c
                  WHERE c.id = cost_id AND c.created_by = app.current_user_id()));
CREATE POLICY p_evidence_field_ins ON private_cost.cost_evidence FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM private_cost.daily_cost c
                       WHERE c.id = cost_id AND c.created_by = app.current_user_id()));
CREATE POLICY p_evidence_ho ON private_cost.cost_evidence FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_labor_rate_ho ON private_cost.labor_rate FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
CREATE POLICY p_equip_rate_ho ON private_cost.equipment_rate FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

-- ---------------------------------------------------------------------
-- GRANT : 외부는 어떤 경로로도 접근 불가
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON private_cost.daily_cost, private_cost.cost_evidence,
     private_cost.labor_rate, private_cost.equipment_rate
  TO rfcip_head_office;
GRANT SELECT ON private_cost.cost_type TO rfcip_head_office, rfcip_field_manager;

-- 현장관리자 : 비용 입력/증빙업로드는 가능. 단가 테이블은 GRANT 없음.
GRANT SELECT, INSERT, UPDATE ON private_cost.daily_cost    TO rfcip_field_manager;
GRANT SELECT, INSERT          ON private_cost.cost_evidence TO rfcip_field_manager;
REVOKE ALL ON private_cost.labor_rate, private_cost.equipment_rate FROM rfcip_field_manager;

REVOKE ALL ON ALL TABLES IN SCHEMA private_cost FROM rfcip_external;
REVOKE ALL ON SCHEMA private_cost FROM rfcip_external;
