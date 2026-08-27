-- =====================================================================
-- 0016 PHASE 7 : 레미콘 / 인원 / 장비 + 재전송 안전장치
--   Master Prompt §21, §22, §23, §25, §26, §29, §46
--
--   핵심 원칙
--     · 매일 동일한 값은 재입력시키지 않는다. 변경만 입력한다 (§1-4, §21, §22)
--     · 단가는 내부원가다. core 에 두지 않는다 (§29)
--     · 계획 레미콘량은 현장 설계 파라미터로 계산한다. 하드코딩하지 않는다
-- =====================================================================

-- ---------------------------------------------------------------------
-- 현장 기본 인원 (§21)
--   직종 목록을 시스템이 강제하지 않는다. 현장이 정한다.
--   단가는 여기 없다. private_cost.labor_rate 에만 있다 (§29).
-- ---------------------------------------------------------------------
CREATE TABLE core.site_default_labor (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  role_name  text NOT NULL,
  headcount  numeric(6,2) NOT NULL CHECK (headcount >= 0),
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  note       text,
  created_by uuid REFERENCES core.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, role_name)
);
COMMENT ON TABLE core.site_default_labor IS
  '현장 기본 인원. 직종명은 현장이 정한다(§21). 단가는 private_cost 에만 둔다(§29).';

CREATE TRIGGER trg_sdl_touch BEFORE UPDATE ON core.site_default_labor
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_sdl_audit AFTER INSERT OR UPDATE OR DELETE ON core.site_default_labor
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- ---------------------------------------------------------------------
-- 현장 기본 장비 (§22)
--   계약방식: 일대 / 월대 / 기타
-- ---------------------------------------------------------------------
CREATE TABLE core.site_default_equipment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  equipment_name text NOT NULL,
  charge_type    text NOT NULL CHECK (charge_type IN ('DAILY','MONTHLY','OTHER')),
  quantity       numeric(6,2) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  sort_order     smallint NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  note           text,
  created_by     uuid REFERENCES core.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, equipment_name)
);
COMMENT ON COLUMN core.site_default_equipment.charge_type IS 'DAILY=일대 / MONTHLY=월대 / OTHER=기타 (§26)';

CREATE TRIGGER trg_sde_touch BEFORE UPDATE ON core.site_default_equipment
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_sde_audit AFTER INSERT OR UPDATE OR DELETE ON core.site_default_equipment
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- ---------------------------------------------------------------------
-- 일일 인원·장비 : "기본설정과 동일합니까?" 에 아니오 일 때만 행이 생긴다
-- ---------------------------------------------------------------------
ALTER TABLE core.daily_work
  ADD COLUMN labor_same_as_default     boolean NOT NULL DEFAULT true,
  ADD COLUMN equipment_same_as_default boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN core.daily_work.labor_same_as_default IS
  'true 면 기본 인원을 그대로 쓴다. 현장관리자가 매일 인원을 다시 입력하지 않는다 (§21).';

CREATE TABLE core.daily_labor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_work_id uuid NOT NULL REFERENCES core.daily_work(id) ON DELETE CASCADE,
  role_name     text NOT NULL,
  headcount     numeric(6,2) NOT NULL CHECK (headcount >= 0),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_work_id, role_name)
);

CREATE TABLE core.daily_equipment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_work_id  uuid NOT NULL REFERENCES core.daily_work(id) ON DELETE CASCADE,
  equipment_name text NOT NULL,
  quantity       numeric(6,2) NOT NULL CHECK (quantity >= 0),
  charge_type    text CHECK (charge_type IN ('DAILY','MONTHLY','OTHER')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_work_id, equipment_name)
);

-- ---------------------------------------------------------------------
-- 레미콘 (§23)
--   지연시간은 정산증빙과 연결할 수 있도록 분 단위로 저장한다.
-- ---------------------------------------------------------------------
CREATE TABLE core.daily_ready_mix (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_work_id  uuid NOT NULL REFERENCES core.daily_work(id) ON DELETE CASCADE,
  quantity_m3    numeric(10,3) NOT NULL CHECK (quantity_m3 >= 0),
  has_delay      boolean NOT NULL DEFAULT false,
  delay_minutes  integer CHECK (delay_minutes > 0),
  delay_reason   text,
  memo           text,
  created_by     uuid REFERENCES core.app_user(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_work_id),
  -- 지연이 있다고 했으면 시간이 있어야 한다
  CONSTRAINT ck_drm_delay CHECK (NOT has_delay OR delay_minutes IS NOT NULL)
);
COMMENT ON COLUMN core.daily_ready_mix.delay_minutes IS
  '공급지연 분. SPECIAL_EVENT·정산증빙과 연결 가능하도록 분 단위로 남긴다 (§23).';

CREATE TRIGGER trg_drm_touch BEFORE UPDATE ON core.daily_ready_mix
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_drm_audit AFTER INSERT OR UPDATE OR DELETE ON core.daily_ready_mix
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- 송장사진 (§23). 파일 실체는 core.stored_file 에 있다.
CREATE TABLE core.ready_mix_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ready_mix_id uuid NOT NULL REFERENCES core.daily_ready_mix(id) ON DELETE CASCADE,
  file_id      uuid NOT NULL REFERENCES core.stored_file(id),
  uploaded_by  uuid REFERENCES core.app_user(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ready_mix_id, file_id)
);

-- ---------------------------------------------------------------------
-- 유효 인원·장비 VIEW : 기본 + 변경을 합쳐서 보여준다
--   "한 번 입력한 데이터를 모든 문서가 재사용한다" (§1-7)
-- ---------------------------------------------------------------------
CREATE VIEW core.v_daily_labor_effective AS
-- 1) 기본 인원. 당일 변경이 있으면 그 값으로 대체한다.
SELECT w.id AS daily_work_id, w.site_id, w.work_date,
       sl.role_name,
       COALESCE(dl.headcount, sl.headcount) AS headcount,
       (dl.id IS NOT NULL) AS is_override,
       sl.sort_order
  FROM core.daily_work w
  JOIN core.site_default_labor sl ON sl.site_id = w.site_id AND sl.is_active
  LEFT JOIN core.daily_labor dl ON dl.daily_work_id = w.id AND dl.role_name = sl.role_name
UNION ALL
-- 2) 기본에 없는데 그날만 투입된 직종
SELECT w.id, w.site_id, w.work_date, dl.role_name, dl.headcount, true, 999::smallint
  FROM core.daily_work w
  JOIN core.daily_labor dl ON dl.daily_work_id = w.id
 WHERE NOT EXISTS (SELECT 1 FROM core.site_default_labor sl
                    WHERE sl.site_id = w.site_id AND sl.role_name = dl.role_name AND sl.is_active);

CREATE VIEW core.v_daily_equipment_effective AS
SELECT w.id AS daily_work_id, w.site_id, w.work_date,
       se.equipment_name,
       COALESCE(de.quantity, se.quantity) AS quantity,
       COALESCE(de.charge_type, se.charge_type) AS charge_type,
       (de.id IS NOT NULL) AS is_override,
       se.sort_order
  FROM core.daily_work w
  JOIN core.site_default_equipment se ON se.site_id = w.site_id AND se.is_active
  LEFT JOIN core.daily_equipment de ON de.daily_work_id = w.id AND de.equipment_name = se.equipment_name
UNION ALL
SELECT w.id, w.site_id, w.work_date, de.equipment_name, de.quantity, de.charge_type, true, 999::smallint
  FROM core.daily_work w
  JOIN core.daily_equipment de ON de.daily_work_id = w.id
 WHERE NOT EXISTS (SELECT 1 FROM core.site_default_equipment se
                    WHERE se.site_id = w.site_id AND se.equipment_name = de.equipment_name AND se.is_active);

-- ---------------------------------------------------------------------
-- 계획 레미콘량 (§46 결정론)
--   산출근거 방식: (π × D²) / 4 × 연장 × (1 + 할증률)
--   π·직경·할증률은 현장 설계 파라미터를 쓴다. 원본 산출방식을 바꾸지 않는다.
--   실제 샘플: (3.14 × 0.6²)/4 × 2052 × 1.02 = 591.498 m³
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_planned_ready_mix(p_site_id uuid, p_length numeric)
RETURNS TABLE (
  diameter numeric, pi_value numeric, surcharge_pct numeric,
  base_volume numeric, surcharge_volume numeric, total_volume numeric,
  per_meter numeric, basis text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_d numeric; v_pi numeric; v_sur numeric; v_base numeric; v_add numeric;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT param_value INTO v_d   FROM core.site_design_param
   WHERE site_id=p_site_id AND param_code='DIAMETER' AND section IS NULL;
  SELECT param_value INTO v_pi  FROM core.site_design_param
   WHERE site_id=p_site_id AND param_code='CONCRETE_PI' AND section IS NULL;
  SELECT param_value INTO v_sur FROM core.site_design_param
   WHERE site_id=p_site_id AND param_code='CONCRETE_SURCHARGE' AND section IS NULL;

  IF v_d IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::numeric, NULL::numeric,
      NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
      'DIAMETER_NOT_SET'::text;
    RETURN;
  END IF;

  -- 산출근거가 3.14 를 쓰면 3.14 를 쓴다. 시스템이 더 정밀한 값으로 바꾸지 않는다.
  v_pi  := COALESCE(v_pi, 3.14);
  v_sur := COALESCE(v_sur, 0);

  v_base := round(v_pi * v_d * v_d / 4 * p_length, 3);
  v_add  := round(v_base * v_sur / 100, 3);

  RETURN QUERY SELECT
    v_d, v_pi, v_sur, v_base, v_add, round(v_base + v_add, 3),
    CASE WHEN p_length = 0 THEN 0::numeric
         ELSE round((v_base + v_add) / p_length, 4) END,
    'SITE_DESIGN_PARAM'::text;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_planned_ready_mix(uuid, numeric)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 재전송 안전장치 (오프라인 큐)
--   현장은 통신이 자주 끊긴다. 끊긴 입력을 나중에 다시 보내는데,
--   같은 요청이 두 번 들어와도 두 번 저장되면 안 된다.
--   클라이언트가 만든 요청 ID 로 한 번만 처리되도록 막는다.
-- ---------------------------------------------------------------------
CREATE TABLE core.idempotency_key (
  client_request_id uuid PRIMARY KEY,
  user_id           uuid REFERENCES core.app_user(id),
  endpoint          text NOT NULL,
  status_code       integer NOT NULL,
  response_body     jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_idem_created ON core.idempotency_key(created_at);
COMMENT ON TABLE core.idempotency_key IS
  '오프라인 큐 재전송 시 중복 저장을 막는다. 같은 client_request_id 는 저장된 응답을 그대로 돌려준다.';

ALTER TABLE core.idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.idempotency_key FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_idem_self ON core.idempotency_key FOR ALL
  USING (app.is_head_office() OR user_id = app.current_user_id())
  WITH CHECK (app.is_head_office() OR user_id = app.current_user_id());
GRANT SELECT, INSERT ON core.idempotency_key TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
ALTER TABLE core.site_default_labor     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_default_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_labor            ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_equipment        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_ready_mix        ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ready_mix_evidence     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_default_labor     FORCE ROW LEVEL SECURITY;
ALTER TABLE core.site_default_equipment FORCE ROW LEVEL SECURITY;
ALTER TABLE core.daily_labor            FORCE ROW LEVEL SECURITY;
ALTER TABLE core.daily_equipment        FORCE ROW LEVEL SECURITY;
ALTER TABLE core.daily_ready_mix        FORCE ROW LEVEL SECURITY;
ALTER TABLE core.ready_mix_evidence     FORCE ROW LEVEL SECURITY;

-- 기본 설정은 본사가, 일일 변경은 현장이 한다.
CREATE POLICY p_sdl_read  ON core.site_default_labor FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_sdl_write ON core.site_default_labor FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
CREATE POLICY p_sde_read  ON core.site_default_equipment FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_sde_write ON core.site_default_equipment FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_dl_site ON core.daily_labor FOR ALL
  USING (EXISTS (SELECT 1 FROM core.daily_work w
                  WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.daily_work w
                       WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)));
CREATE POLICY p_de_site ON core.daily_equipment FOR ALL
  USING (EXISTS (SELECT 1 FROM core.daily_work w
                  WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.daily_work w
                       WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)));
CREATE POLICY p_drm_site ON core.daily_ready_mix FOR ALL
  USING (EXISTS (SELECT 1 FROM core.daily_work w
                  WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.daily_work w
                       WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)));
CREATE POLICY p_rme_site ON core.ready_mix_evidence FOR ALL
  USING (EXISTS (SELECT 1 FROM core.daily_ready_mix r JOIN core.daily_work w ON w.id = r.daily_work_id
                  WHERE r.id = ready_mix_id AND app.has_site_access(w.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.daily_ready_mix r JOIN core.daily_work w ON w.id = r.daily_work_id
                       WHERE r.id = ready_mix_id AND app.has_site_access(w.site_id)));

GRANT SELECT ON core.site_default_labor, core.site_default_equipment
  TO rfcip_head_office, rfcip_field_manager;
GRANT INSERT, UPDATE, DELETE ON core.site_default_labor, core.site_default_equipment
  TO rfcip_head_office;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON core.daily_labor, core.daily_equipment, core.daily_ready_mix, core.ready_mix_evidence
  TO rfcip_head_office, rfcip_field_manager;
GRANT SELECT ON core.v_daily_labor_effective, core.v_daily_equipment_effective
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 자동검증 (§43)
--   계획 레미콘 대비 실제 사용량 차이 / 장비 투입인데 천공 0
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_daily_inputs(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  -- 계획 레미콘 대비 실제 사용량 차이 (10% 초과)
  RETURN QUERY
  SELECT 'READY_MIX_DEVIATION', 'WARN', w.work_date::text,
         format('%s : 레미콘 실제 %s㎥ 가 계획 %s㎥ 와 %s%% 차이납니다.',
                w.work_date,
                trim(to_char(r.quantity_m3, 'FM9990.###')),
                trim(to_char(pl.total_volume, 'FM9990.###')),
                trim(to_char(round((r.quantity_m3 - pl.total_volume) / NULLIF(pl.total_volume,0) * 100, 1),
                             'FMS9990.#')))
    FROM core.daily_work w
    JOIN core.daily_ready_mix r ON r.daily_work_id = w.id
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(h.design_depth_total), 0) AS len
        FROM core.daily_work_hole d JOIN core.hole_master h ON h.id = d.hole_id
       WHERE d.daily_work_id = w.id) t
    CROSS JOIN LATERAL core.fn_planned_ready_mix(p_site_id, t.len) pl
   WHERE w.site_id = p_site_id
     AND pl.total_volume IS NOT NULL AND pl.total_volume > 0
     AND abs(r.quantity_m3 - pl.total_volume) / pl.total_volume > 0.10;

  -- 장비를 넣었는데 천공이 0인 날 (§43)
  RETURN QUERY
  SELECT 'EQUIPMENT_WITHOUT_HOLE', 'WARN', w.work_date::text,
         format('%s : 장비가 투입되었으나 천공 실적이 없습니다.', w.work_date)
    FROM core.daily_work w
   WHERE w.site_id = p_site_id
     AND NOT EXISTS (SELECT 1 FROM core.daily_work_hole d WHERE d.daily_work_id = w.id)
     AND (EXISTS (SELECT 1 FROM core.daily_equipment e WHERE e.daily_work_id = w.id)
          OR EXISTS (SELECT 1 FROM core.site_default_equipment se
                      WHERE se.site_id = p_site_id AND se.is_active
                        AND w.equipment_same_as_default));

  -- 레미콘을 타설했는데 천공 실적이 없는 날
  RETURN QUERY
  SELECT 'READY_MIX_WITHOUT_HOLE', 'WARN', w.work_date::text,
         format('%s : 레미콘 %s㎥ 가 반입되었으나 천공 실적이 없습니다.',
                w.work_date, trim(to_char(r.quantity_m3, 'FM9990.###')))
    FROM core.daily_work w
    JOIN core.daily_ready_mix r ON r.daily_work_id = w.id AND r.quantity_m3 > 0
   WHERE w.site_id = p_site_id
     AND NOT EXISTS (SELECT 1 FROM core.daily_work_hole d WHERE d.daily_work_id = w.id);

  -- 기본 인원이 설정되지 않은 현장
  RETURN QUERY
  SELECT 'NO_DEFAULT_LABOR', 'INFO', '기본 인원',
         '현장 기본 인원이 설정되지 않아 매일 인원을 입력해야 합니다. (STEP 10)'
    FROM core.site s
   WHERE s.id = p_site_id
     AND NOT EXISTS (SELECT 1 FROM core.site_default_labor l
                      WHERE l.site_id = p_site_id AND l.is_active);
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_daily_inputs(uuid)
  TO rfcip_head_office, rfcip_field_manager;

CREATE OR REPLACE FUNCTION core.fn_validate_site_full(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT * FROM core.fn_validate_site(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_hole_type_depth(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_drawing_consistency(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_hole_count_basis(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_quantity_basis(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_daily_inputs(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;
