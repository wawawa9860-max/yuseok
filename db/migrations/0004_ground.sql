-- =====================================================================
-- 0004 GROUND_TYPE / GROUND_PROFILE / GROUND_PROFILE_LAYER
-- Master Prompt §6~§11, §53
--  * 지층종류를 하드코딩하지 않는다. 현장별 사용자 정의.
--  * 지반조건은 "조합 + 깊이" 구조로 저장한다.
--  * 지층별 길이 합계 = 총 계획심도 를 코드로 검증한다.
--  * 계획값의 최종 기준은 승인된 수량산출서다. 시스템이 임의 생성하지 않는다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 현장별 지층종류. 시스템은 어떤 지층명도 필수값으로 강제하지 않는다. (§7)
-- ---------------------------------------------------------------------
CREATE TABLE core.ground_type (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  code       text NOT NULL,                    -- 예: G01 (현장이 정한다)
  name       text NOT NULL,                    -- 예: 토사 (현장이 정한다)
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean  NOT NULL DEFAULT true,
  created_by uuid REFERENCES core.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, code),
  UNIQUE (site_id, name)
);
COMMENT ON TABLE core.ground_type IS
  '현장별 지층종류. 마이그레이션에 특정 지층명을 넣지 않는다 (§7). 시드 데이터만 예외.';

-- ---------------------------------------------------------------------
-- GROUND_PROFILE : 지반조건 조합 1건 (§9)
--   depth_mode
--     DEPTH_RANGE : from_depth~to_depth 를 가진 수량산출서
--     LENGTH_ONLY : 지층별 연장값만 있는 수량산출서 (§9 후단)
--   source : 계획값의 근거. 우선순위는 §11 을 따른다.
-- ---------------------------------------------------------------------
CREATE TABLE core.ground_profile (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  profile_name        text NOT NULL,
  revision            integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  description         text,
  depth_mode          text NOT NULL DEFAULT 'DEPTH_RANGE'
                        CHECK (depth_mode IN ('DEPTH_RANGE','LENGTH_ONLY')),
  total_planned_depth numeric(8,3) NOT NULL CHECK (total_planned_depth > 0),
  source              text NOT NULL DEFAULT 'QUANTITY_SHEET'
                        CHECK (source IN ('QUANTITY_SHEET','APPROVED_DRAWING','APPROVED_MANUAL')),
  source_reference    text,                    -- 수량산출서 페이지/행 등 근거
  status              text NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','CONFIRMED','SUPERSEDED')),
  confirmed_by        uuid REFERENCES core.app_user(id),
  confirmed_at        timestamptz,
  superseded_by       uuid REFERENCES core.ground_profile(id),
  created_by          uuid REFERENCES core.app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, profile_name, revision)
);
COMMENT ON COLUMN core.ground_profile.source IS
  '§11 기준 우선순위 1)QUANTITY_SHEET 계약 수량산출서 2)APPROVED_DRAWING 승인도면 3)APPROVED_MANUAL 본사/현장 승인입력';

CREATE TRIGGER trg_ground_profile_touch BEFORE UPDATE ON core.ground_profile
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_ground_profile_audit AFTER INSERT OR UPDATE OR DELETE ON core.ground_profile
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- ---------------------------------------------------------------------
-- GROUND_PROFILE_LAYER : 지층별 계획 연장 (§8, §9)
-- ---------------------------------------------------------------------
CREATE TABLE core.ground_profile_layer (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ground_profile_id uuid NOT NULL REFERENCES core.ground_profile(id) ON DELETE CASCADE,
  sequence          smallint NOT NULL CHECK (sequence >= 1),
  ground_type_id    uuid NOT NULL REFERENCES core.ground_type(id),
  from_depth        numeric(8,3) CHECK (from_depth >= 0),
  to_depth          numeric(8,3) CHECK (to_depth   >= 0),
  planned_length    numeric(8,3) NOT NULL CHECK (planned_length > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ground_profile_id, sequence),
  UNIQUE (ground_profile_id, ground_type_id),
  CONSTRAINT ck_layer_depth_pair CHECK (
    (from_depth IS NULL AND to_depth IS NULL)
    OR (from_depth IS NOT NULL AND to_depth IS NOT NULL AND to_depth > from_depth)
  ),
  -- 깊이구간이 있으면 구간길이와 연장이 일치해야 한다.
  CONSTRAINT ck_layer_length_matches_depth CHECK (
    from_depth IS NULL OR abs((to_depth - from_depth) - planned_length) <= 0.001
  )
);
CREATE INDEX ix_gpl_profile ON core.ground_profile_layer(ground_profile_id, sequence);

-- ---------------------------------------------------------------------
-- 결정론적 검증 함수 (§8, §43, §46)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_profile_layer_sum(p_profile_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT COALESCE(SUM(planned_length), 0)::numeric(12,3)
    FROM core.ground_profile_layer WHERE ground_profile_id = p_profile_id
$$;

-- 검증 결과를 코드로 반환한다. 화면/API 는 이 결과만 신뢰한다.
CREATE OR REPLACE FUNCTION core.fn_validate_ground_profile(p_profile_id uuid)
RETURNS TABLE (code text, severity text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
DECLARE
  v_profile core.ground_profile%ROWTYPE;
  v_sum     numeric;
  v_cnt     integer;
  v_prev_to numeric;
  r         record;
BEGIN
  SELECT * INTO v_profile FROM core.ground_profile WHERE id = p_profile_id;
  -- SECURITY DEFINER 이므로 현장 접근권한을 함수 내부에서 다시 확인한다.
  IF FOUND AND NOT app.has_site_access(v_profile.site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'PROFILE_NOT_FOUND','ERROR','지반조건을 찾을 수 없습니다.'; RETURN;
  END IF;

  SELECT count(*) INTO v_cnt FROM core.ground_profile_layer WHERE ground_profile_id = p_profile_id;
  IF v_cnt = 0 THEN
    RETURN QUERY SELECT 'NO_LAYER','ERROR','지층이 하나도 등록되지 않았습니다.'; RETURN;
  END IF;

  v_sum := core.fn_profile_layer_sum(p_profile_id);
  IF abs(v_sum - v_profile.total_planned_depth) > 0.001 THEN
    RETURN QUERY SELECT 'LAYER_SUM_MISMATCH','ERROR',
      format('지층별 길이 합계 %sm 가 총 계획심도 %sm 와 다릅니다.',
             trim(to_char(v_sum, 'FM9990.000')), trim(to_char(v_profile.total_planned_depth, 'FM9990.000')));
  END IF;

  IF v_profile.depth_mode = 'DEPTH_RANGE' THEN
    v_prev_to := 0;
    FOR r IN SELECT sequence, from_depth, to_depth
               FROM core.ground_profile_layer
              WHERE ground_profile_id = p_profile_id ORDER BY sequence LOOP
      IF r.from_depth IS NULL THEN
        RETURN QUERY SELECT 'DEPTH_RANGE_MISSING','ERROR',
          format('%s번째 지층에 깊이구간이 없습니다.', r.sequence);
      ELSIF abs(r.from_depth - v_prev_to) > 0.001 THEN
        RETURN QUERY SELECT 'DEPTH_NOT_CONTIGUOUS','ERROR',
          format('%s번째 지층 시작심도 %sm 가 직전 지층 종료심도 %sm 와 연속되지 않습니다.',
                 r.sequence, trim(to_char(r.from_depth, 'FM9990.000')),
                 trim(to_char(v_prev_to, 'FM9990.000')));
      END IF;
      v_prev_to := r.to_depth;
    END LOOP;
    IF v_prev_to IS NOT NULL AND abs(v_prev_to - v_profile.total_planned_depth) > 0.001 THEN
      RETURN QUERY SELECT 'DEPTH_END_MISMATCH','ERROR',
        format('마지막 지층 종료심도 %sm 가 총 계획심도 %sm 와 다릅니다.',
               trim(to_char(v_prev_to, 'FM9990.000')),
               trim(to_char(v_profile.total_planned_depth, 'FM9990.000')));
    END IF;
  END IF;

  -- 다른 현장의 지층종류를 참조할 수 없다.
  IF EXISTS (
    SELECT 1 FROM core.ground_profile_layer l
      JOIN core.ground_type g ON g.id = l.ground_type_id
     WHERE l.ground_profile_id = p_profile_id AND g.site_id <> v_profile.site_id
  ) THEN
    RETURN QUERY SELECT 'GROUND_TYPE_SITE_MISMATCH','ERROR','다른 현장의 지층종류가 사용되었습니다.';
  END IF;
END $$;

-- CONFIRMED 로 승격할 때만 검증을 강제한다 (§8 "불일치하면 저장 전에 경고").
CREATE OR REPLACE FUNCTION core.trg_ground_profile_confirm_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_err text;
BEGIN
  IF NEW.status = 'CONFIRMED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'CONFIRMED') THEN
    SELECT string_agg(message, ' / ') INTO v_err
      FROM core.fn_validate_ground_profile(NEW.id) WHERE severity = 'ERROR';
    IF v_err IS NOT NULL THEN
      RAISE EXCEPTION '지반조건 확정 불가: %', v_err USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER trg_gp_confirm_guard
  AFTER INSERT OR UPDATE ON core.ground_profile
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION core.trg_ground_profile_confirm_guard();

-- 확정된 지반조건의 지층은 수정할 수 없다. 변경은 새 revision 으로 한다. (§38)
CREATE OR REPLACE FUNCTION core.trg_layer_immutable_when_confirmed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text; v_pid uuid;
BEGIN
  v_pid := COALESCE(NEW.ground_profile_id, OLD.ground_profile_id);
  SELECT status INTO v_status FROM core.ground_profile WHERE id = v_pid;
  IF v_status = 'CONFIRMED' THEN
    RAISE EXCEPTION '확정된 지반조건의 지층은 변경할 수 없습니다. 새 revision 을 생성하십시오.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_gpl_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON core.ground_profile_layer
  FOR EACH ROW EXECUTE FUNCTION core.trg_layer_immutable_when_confirmed();

-- RLS
ALTER TABLE core.ground_type          ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ground_profile       ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ground_profile_layer ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ground_type          FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.ground_profile       FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.ground_profile_layer FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_gt_read  ON core.ground_type FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_gt_write ON core.ground_type FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_gp_read  ON core.ground_profile FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_gp_write ON core.ground_profile FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_gpl_read ON core.ground_profile_layer FOR SELECT
  USING (EXISTS (SELECT 1 FROM core.ground_profile p
                  WHERE p.id = ground_profile_id AND app.has_site_access(p.site_id)));
CREATE POLICY p_gpl_write ON core.ground_profile_layer FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

GRANT SELECT ON core.ground_type, core.ground_profile, core.ground_profile_layer
  TO rfcip_head_office, rfcip_field_manager;
GRANT INSERT, UPDATE, DELETE ON core.ground_type, core.ground_profile, core.ground_profile_layer
  TO rfcip_head_office;
GRANT EXECUTE ON FUNCTION core.fn_validate_ground_profile(uuid), core.fn_profile_layer_sum(uuid)
  TO rfcip_head_office, rfcip_field_manager;
