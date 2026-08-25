-- =====================================================================
-- 0002 USERS / SITE_MASTER
-- Master Prompt §44(권한), §48-2(SITE_MASTER), §5(현장별 천공종류 활성화)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 사용자 / 역할
-- ---------------------------------------------------------------------
CREATE TABLE core.app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id      text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  display_name  text        NOT NULL,
  phone         text,
  role          text        NOT NULL CHECK (role IN ('HEAD_OFFICE','FIELD_MANAGER','EXTERNAL')),
  is_active     boolean     NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN core.app_user.role IS 'HEAD_OFFICE=본사 / FIELD_MANAGER=현장관리자 / EXTERNAL=계약상대방';

CREATE TRIGGER trg_app_user_touch BEFORE UPDATE ON core.app_user
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- SITE_MASTER
-- ---------------------------------------------------------------------
CREATE TABLE core.site (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_code          text        NOT NULL UNIQUE,
  site_name          text        NOT NULL,
  client_name        text,                       -- 원도급사 / 발주처
  location           text,
  start_date         date,
  end_date           date,
  status             text        NOT NULL DEFAULT 'PREPARING'
                       CHECK (status IN ('PREPARING','ACTIVE','SUSPENDED','CLOSED')),
  setup_step         smallint    NOT NULL DEFAULT 1 CHECK (setup_step BETWEEN 1 AND 12),
  setup_completed_at timestamptz,
  memo               text,
  created_by         uuid REFERENCES core.app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_site_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
COMMENT ON COLUMN core.site.setup_step IS '현장 최초설정 진행단계 (Master Prompt §17 STEP 1~12)';

CREATE TRIGGER trg_site_touch BEFORE UPDATE ON core.site
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------
-- 사용자 ↔ 현장 접근권한 (FIELD_MANAGER / EXTERNAL 은 배정된 현장만)
-- ---------------------------------------------------------------------
CREATE TABLE core.user_site_access (
  user_id    uuid NOT NULL REFERENCES core.app_user(id) ON DELETE CASCADE,
  site_id    uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES core.app_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site_id)
);
CREATE INDEX ix_user_site_access_site ON core.user_site_access(site_id);

-- ---------------------------------------------------------------------
-- 권한 헬퍼 : RLS 정책의 단일 기준
--   SECURITY DEFINER 로 RLS 재귀를 피한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.has_site_access(p_site_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT CASE
    WHEN app.is_head_office() THEN true
    WHEN app.current_user_id() IS NULL THEN false
    ELSE EXISTS (
      SELECT 1 FROM core.user_site_access ua
       WHERE ua.user_id = app.current_user_id() AND ua.site_id = p_site_id
    )
  END
$$;
GRANT EXECUTE ON FUNCTION app.has_site_access(uuid)
  TO rfcip_head_office, rfcip_field_manager, rfcip_external;

-- ---------------------------------------------------------------------
-- 현장별 천공종류 (§5) — 시스템이 특정 종류를 강제하지 않는다.
-- ---------------------------------------------------------------------
CREATE TABLE core.site_hole_type (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean  NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, code),
  UNIQUE (site_id, name)
);
COMMENT ON TABLE core.site_hole_type IS 'Primary/Secondary/무근/H-BEAM 등은 하드코딩하지 않고 현장별로 생성한다 (§5)';

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
ALTER TABLE core.site              ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_site_access  ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_hole_type    ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.app_user          ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site              FORCE ROW LEVEL SECURITY;
ALTER TABLE core.user_site_access  FORCE ROW LEVEL SECURITY;
ALTER TABLE core.site_hole_type    FORCE ROW LEVEL SECURITY;
ALTER TABLE core.app_user          FORCE ROW LEVEL SECURITY;

CREATE POLICY p_site_read   ON core.site FOR SELECT USING (app.has_site_access(id));
CREATE POLICY p_site_write  ON core.site FOR ALL       USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_usa_read    ON core.user_site_access FOR SELECT
  USING (app.is_head_office() OR user_id = app.current_user_id());
CREATE POLICY p_usa_write   ON core.user_site_access FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_sht_read    ON core.site_hole_type FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_sht_write   ON core.site_hole_type FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

-- 사용자 목록은 본사만. 본인 정보는 본인이 조회 가능.
CREATE POLICY p_user_self   ON core.app_user FOR SELECT
  USING (app.is_head_office() OR id = app.current_user_id());
CREATE POLICY p_user_admin  ON core.app_user FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

GRANT SELECT ON core.site, core.site_hole_type, core.user_site_access, core.app_user
  TO rfcip_head_office, rfcip_field_manager;
GRANT INSERT, UPDATE, DELETE ON core.site, core.site_hole_type, core.user_site_access, core.app_user
  TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 로그인 조회 전용 함수.
--   로그인 시점에는 아직 인증된 사용자가 없으므로 RLS 를 통과할 수 없다.
--   본사 권한으로 승격하는 대신, 필요한 최소 컬럼만 반환하는
--   SECURITY DEFINER 함수를 사용한다. (password_hash 외 원가정보 없음)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fn_login_lookup(p_login_id text)
RETURNS TABLE (id uuid, login_id text, password_hash text, display_name text, role text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT u.id, u.login_id, u.password_hash, u.display_name, u.role, u.is_active
    FROM core.app_user u
   WHERE u.login_id = p_login_id
$$;
GRANT EXECUTE ON FUNCTION app.fn_login_lookup(text)
  TO rfcip_head_office, rfcip_field_manager, rfcip_external;

CREATE OR REPLACE FUNCTION app.fn_mark_login(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = core, pg_temp AS $$
  UPDATE core.app_user SET last_login_at = now() WHERE id = p_user_id
$$;
GRANT EXECUTE ON FUNCTION app.fn_mark_login(uuid)
  TO rfcip_head_office, rfcip_field_manager, rfcip_external;

-- 사용자 자신이 접근 가능한 현장 목록 (로그인 직후 화면 구성용)
CREATE OR REPLACE FUNCTION app.fn_my_site_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT CASE WHEN app.is_head_office() THEN s.id ELSE ua.site_id END
    FROM core.site s
    LEFT JOIN core.user_site_access ua
      ON ua.site_id = s.id AND ua.user_id = app.current_user_id()
   WHERE app.is_head_office() OR ua.user_id IS NOT NULL
$$;
GRANT EXECUTE ON FUNCTION app.fn_my_site_ids()
  TO rfcip_head_office, rfcip_field_manager, rfcip_external;
