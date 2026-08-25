-- =====================================================================
-- 0001 FOUNDATION : 스키마 / DB역할 / 세션컨텍스트 / 공통 함수
-- Master Prompt §1-10(서버수준 권한분리), §29(원가보안), §44(권한)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- 스키마 계층
--   core         : 공용 업무 데이터 (현장/계약/천공/지반/문서)
--   private_cost : 본사전용 원가. 계약상대방 접근 0. (§29)
--   share        : 외부(계약상대방) 공유 전용 VIEW. private_cost 의존 금지.
--   audit        : 변경이력 (원본 덮어쓰기 금지, §1-11)
--   app          : 세션 컨텍스트 / 권한 헬퍼 함수
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS private_cost;
CREATE SCHEMA IF NOT EXISTS share;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------
-- DB 역할 (§44). 애플리케이션 계정은 요청마다 SET LOCAL ROLE 로 강등된다.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rfcip_head_office') THEN
    CREATE ROLE rfcip_head_office NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rfcip_field_manager') THEN
    CREATE ROLE rfcip_field_manager NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rfcip_external') THEN
    CREATE ROLE rfcip_external NOLOGIN;
  END IF;
END $$;

-- PUBLIC 기본권한 제거 : 명시적으로 GRANT 한 것만 접근 가능
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA core, private_cost, share, audit, app FROM PUBLIC;

GRANT USAGE ON SCHEMA app  TO rfcip_head_office, rfcip_field_manager, rfcip_external;
GRANT USAGE ON SCHEMA core TO rfcip_head_office, rfcip_field_manager;
GRANT USAGE ON SCHEMA share TO rfcip_head_office, rfcip_field_manager, rfcip_external;
GRANT USAGE ON SCHEMA audit TO rfcip_head_office;

-- private_cost : 본사 + (입력용) 현장관리자만. 외부는 USAGE 자체가 없다.
GRANT USAGE ON SCHEMA private_cost TO rfcip_head_office, rfcip_field_manager;
REVOKE ALL ON SCHEMA private_cost FROM rfcip_external;

-- ---------------------------------------------------------------------
-- 세션 컨텍스트 : API 가 트랜잭션마다 set_config 로 주입한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_role_name() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'ANONYMOUS')
$$;

CREATE OR REPLACE FUNCTION app.is_head_office() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.current_role_name() = 'HEAD_OFFICE'
$$;

COMMENT ON FUNCTION app.current_user_id() IS 'API가 트랜잭션 단위로 주입하는 인증 사용자 ID (RLS 기준)';

GRANT EXECUTE ON FUNCTION app.current_user_id(), app.current_role_name(), app.is_head_office()
  TO rfcip_head_office, rfcip_field_manager, rfcip_external;

-- ---------------------------------------------------------------------
-- 공통 : updated_at 자동갱신
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 변경이력 (§1-11, §38) : 모든 UPDATE/DELETE 전 이미지를 보존한다.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit.change_log (
  id           bigserial PRIMARY KEY,
  table_name   text        NOT NULL,
  row_id       uuid,
  operation    text        NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  before_image jsonb,
  after_image  jsonb,
  changed_by   uuid,
  changed_role text,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_change_log_table_row ON audit.change_log (table_name, row_id, changed_at DESC);

CREATE OR REPLACE FUNCTION audit.record_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_temp AS $$
DECLARE
  v_row_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row_id := (to_jsonb(OLD)->>'id')::uuid;
    INSERT INTO audit.change_log(table_name,row_id,operation,before_image,after_image,changed_by,changed_role)
    VALUES (TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME, v_row_id, 'DELETE', to_jsonb(OLD), NULL,
            app.current_user_id(), app.current_role_name());
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    v_row_id := (to_jsonb(NEW)->>'id')::uuid;
    IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
      INSERT INTO audit.change_log(table_name,row_id,operation,before_image,after_image,changed_by,changed_role)
      VALUES (TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME, v_row_id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW),
              app.current_user_id(), app.current_role_name());
    END IF;
    RETURN NEW;
  ELSE
    v_row_id := (to_jsonb(NEW)->>'id')::uuid;
    INSERT INTO audit.change_log(table_name,row_id,operation,before_image,after_image,changed_by,changed_role)
    VALUES (TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME, v_row_id, 'INSERT', NULL, to_jsonb(NEW),
            app.current_user_id(), app.current_role_name());
    RETURN NEW;
  END IF;
END $$;

-- 이력은 누구도 수정/삭제할 수 없다 (append-only)
CREATE OR REPLACE FUNCTION audit.deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '변경이력(audit.change_log)은 수정하거나 삭제할 수 없습니다.';
END $$;

DROP TRIGGER IF EXISTS trg_change_log_immutable ON audit.change_log;
CREATE TRIGGER trg_change_log_immutable
  BEFORE UPDATE OR DELETE ON audit.change_log
  FOR EACH ROW EXECUTE FUNCTION audit.deny_mutation();

GRANT SELECT ON audit.change_log TO rfcip_head_office;
-- audit.record_change 는 SECURITY DEFINER 이므로 일반 역할에 INSERT 권한이 필요없다.
-- 시퀀스는 정의자(소유자) 권한으로 사용된다.
