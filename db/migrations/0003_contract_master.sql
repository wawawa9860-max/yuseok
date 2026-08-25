-- =====================================================================
-- 0003 CONTRACT_MASTER + 계약 Revision
-- Master Prompt §4(계약내역), §37(기성), §38(원본 덮어쓰기 금지)
-- =====================================================================

CREATE TABLE core.contract (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  contract_no       text NOT NULL,
  contract_name     text NOT NULL,
  counterparty_name text,                    -- 계약상대방(원도급사 등)
  contract_date     date,
  start_date        date,
  end_date          date,
  original_amount   numeric(18,2) NOT NULL DEFAULT 0 CHECK (original_amount >= 0),
  current_amount    numeric(18,2) NOT NULL DEFAULT 0 CHECK (current_amount  >= 0),
  current_revision  integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  status            text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','ACTIVE','CLOSED')),
  created_by        uuid REFERENCES core.app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, contract_no)
);
COMMENT ON COLUMN core.contract.original_amount IS '원계약금액 (절대 변경하지 않는다)';
COMMENT ON COLUMN core.contract.current_amount  IS '설계변경 반영 현재 계약금액 (금액 공정률 분모, §36)';

CREATE TRIGGER trg_contract_touch BEFORE UPDATE ON core.contract
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_contract_audit AFTER INSERT OR UPDATE OR DELETE ON core.contract
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- 계약 Revision : REV 0 = 원계약, REV n = n차 설계변경 (§38)
CREATE TABLE core.contract_revision (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    uuid NOT NULL REFERENCES core.contract(id) ON DELETE CASCADE,
  revision_no    integer NOT NULL CHECK (revision_no >= 0),
  revision_type  text NOT NULL DEFAULT 'ORIGINAL'
                   CHECK (revision_type IN ('ORIGINAL','DESIGN_CHANGE')),
  contract_amount numeric(18,2) NOT NULL CHECK (contract_amount >= 0),
  effective_date date,
  reason         text,
  approved_by    uuid REFERENCES core.app_user(id),
  approved_at    timestamptz,
  is_current     boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES core.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, revision_no)
);
CREATE UNIQUE INDEX ux_contract_revision_current
  ON core.contract_revision(contract_id) WHERE is_current;

-- 계약내역 (수량산출서 상위 원장). revision 별로 보존한다.
CREATE TABLE core.contract_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES core.contract(id) ON DELETE CASCADE,
  revision_no integer NOT NULL CHECK (revision_no >= 0),
  item_code   text,
  item_name   text NOT NULL,
  spec        text,
  unit        text NOT NULL,
  quantity    numeric(18,4) NOT NULL CHECK (quantity >= 0),
  unit_price  numeric(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  amount      numeric(18,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, revision_no, item_code)
);
COMMENT ON COLUMN core.contract_item.amount IS '금액은 DB가 결정론적으로 계산한다 (§46)';

CREATE INDEX ix_contract_site ON core.contract(site_id);
CREATE INDEX ix_contract_item_contract ON core.contract_item(contract_id, revision_no);

-- RLS
ALTER TABLE core.contract           ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.contract_revision  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.contract_item      ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.contract           FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.contract_revision  FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.contract_item      FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_contract_read  ON core.contract FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_contract_write ON core.contract FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

-- 계약단가/금액은 본사만. 현장관리자는 계약 revision/내역 단가를 보지 않는다 (§44).
CREATE POLICY p_contract_rev_ho  ON core.contract_revision FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
CREATE POLICY p_contract_item_ho ON core.contract_item FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

GRANT SELECT ON core.contract TO rfcip_head_office, rfcip_field_manager;
GRANT INSERT, UPDATE, DELETE ON core.contract TO rfcip_head_office;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.contract_revision, core.contract_item TO rfcip_head_office;
