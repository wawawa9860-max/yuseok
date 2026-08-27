-- =====================================================================
-- 0018 출력일보 / 장비가동일보 (공수) + 정산방식
--   Master Prompt §21, §22, §25, §26, §29, §43, §46
--
--   사용자 확인사항 (2026-08-27)
--     · 노무비·장비대는 월급/월대인 경우도 있고 일자로 계산하는 경우도 있다.
--       불가항력이나 변수가 생기면 일자로 계산해 마무리한다.
--     · 현금으로 지급하지 않아도 출력일보·장비가동일보에 따라
--       1일 또는 0.5일이 입력되어야 하고, 그에 따라 투입비를 통상적으로 계산한다.
--
--   0016~0017 은 '인원 수'와 '장비 대수'만 알고 공수를 몰랐다.
--   그래서 반일만 나온 날도 하루치 원가가 잡혔다. 이 마이그레이션이 그것을 고친다.
--
--   공수는 원가가 아니다. 출력일보·장비가동일보는 core 에 있고 금액은 없다 (§29).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 공수 (출력일보) / 가동일수 (장비가동일보)
--
--   0.5 단위가 통상이지만 잔업 등으로 1.25 같은 값이 필요한 현장이 있다.
--   단위를 코드로 강제하지 않는다. 범위만 막는다.
-- ---------------------------------------------------------------------
ALTER TABLE core.site_default_labor
  ADD COLUMN default_work_days numeric(4,2) NOT NULL DEFAULT 1.0
    CHECK (default_work_days >= 0 AND default_work_days <= 3);
ALTER TABLE core.site_default_equipment
  ADD COLUMN default_operating_days numeric(4,2) NOT NULL DEFAULT 1.0
    CHECK (default_operating_days >= 0 AND default_operating_days <= 3);

ALTER TABLE core.daily_labor
  ADD COLUMN work_days numeric(4,2) NOT NULL DEFAULT 1.0
    CHECK (work_days >= 0 AND work_days <= 3),
  -- §26 대기·기상·불가항력. PHASE 11 SPECIAL_EVENT 와 연결한다.
  ADD COLUMN absence_reason text;
ALTER TABLE core.daily_equipment
  ADD COLUMN operating_days numeric(4,2) NOT NULL DEFAULT 1.0
    CHECK (operating_days >= 0 AND operating_days <= 3),
  ADD COLUMN idle_reason text;

COMMENT ON COLUMN core.daily_labor.work_days IS
  '출력일보 공수. 1=하루, 0.5=반일, 0=미출력. 투입비는 인원 × 공수 로 계산한다.';
COMMENT ON COLUMN core.daily_equipment.operating_days IS
  '장비가동일보 가동일수. 1=하루, 0.5=반일, 0=미가동(대기·기상·불가항력).';
COMMENT ON COLUMN core.daily_equipment.idle_reason IS
  '미가동·반일 사유. §26 대로 SPECIAL_EVENT 와 연결한다.';

-- ---------------------------------------------------------------------
-- 유효 인원·장비 VIEW 에 공수를 얹는다
--   기존 컬럼 순서는 건드리지 않고 뒤에 붙인다 (의존 함수가 깨지지 않는다).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW core.v_daily_labor_effective AS
SELECT w.id AS daily_work_id, w.site_id, w.work_date,
       sl.role_name,
       COALESCE(dl.headcount, sl.headcount) AS headcount,
       (dl.id IS NOT NULL) AS is_override,
       sl.sort_order,
       COALESCE(dl.work_days, sl.default_work_days) AS work_days,
       -- 투입공수 = 인원 × 공수. 원가는 이 값에 단가를 곱한다.
       round(COALESCE(dl.headcount, sl.headcount)
             * COALESCE(dl.work_days, sl.default_work_days), 2) AS man_days,
       dl.absence_reason
  FROM core.daily_work w
  JOIN core.site_default_labor sl ON sl.site_id = w.site_id AND sl.is_active
  LEFT JOIN core.daily_labor dl ON dl.daily_work_id = w.id AND dl.role_name = sl.role_name
UNION ALL
SELECT w.id, w.site_id, w.work_date, dl.role_name, dl.headcount, true, 999::smallint,
       dl.work_days, round(dl.headcount * dl.work_days, 2), dl.absence_reason
  FROM core.daily_work w
  JOIN core.daily_labor dl ON dl.daily_work_id = w.id
 WHERE NOT EXISTS (SELECT 1 FROM core.site_default_labor sl
                    WHERE sl.site_id = w.site_id AND sl.role_name = dl.role_name AND sl.is_active);

CREATE OR REPLACE VIEW core.v_daily_equipment_effective AS
SELECT w.id AS daily_work_id, w.site_id, w.work_date,
       se.equipment_name,
       COALESCE(de.quantity, se.quantity) AS quantity,
       COALESCE(de.charge_type, se.charge_type) AS charge_type,
       (de.id IS NOT NULL) AS is_override,
       se.sort_order,
       COALESCE(de.operating_days, se.default_operating_days) AS operating_days,
       round(COALESCE(de.quantity, se.quantity)
             * COALESCE(de.operating_days, se.default_operating_days), 2) AS unit_days,
       de.idle_reason
  FROM core.daily_work w
  JOIN core.site_default_equipment se ON se.site_id = w.site_id AND se.is_active
  LEFT JOIN core.daily_equipment de ON de.daily_work_id = w.id AND de.equipment_name = se.equipment_name
UNION ALL
SELECT w.id, w.site_id, w.work_date, de.equipment_name, de.quantity, de.charge_type, true, 999::smallint,
       de.operating_days, round(de.quantity * de.operating_days, 2), de.idle_reason
  FROM core.daily_work w
  JOIN core.daily_equipment de ON de.daily_work_id = w.id
 WHERE NOT EXISTS (SELECT 1 FROM core.site_default_equipment se
                    WHERE se.site_id = w.site_id AND se.equipment_name = de.equipment_name AND se.is_active);

-- ---------------------------------------------------------------------
-- 출력일보 / 장비가동일보 (금액 없음 — core 에 둔다)
--   PHASE 9 작업일보가 이 뷰를 그대로 재사용한다 (§1-7).
-- ---------------------------------------------------------------------
CREATE VIEW core.v_labor_log AS
SELECT site_id, work_date, role_name, headcount, work_days, man_days,
       is_override, absence_reason, sort_order
  FROM core.v_daily_labor_effective;

CREATE VIEW core.v_equipment_log AS
SELECT site_id, work_date, equipment_name, charge_type, quantity,
       operating_days, unit_days, is_override, idle_reason, sort_order
  FROM core.v_daily_equipment_effective;

GRANT SELECT ON core.v_labor_log, core.v_equipment_log
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §25 노무 단가에 지급방식을 붙인다
--   일당제(DAILY) 와 월급제(MONTHLY) 둘 다 쓴다.
--   컬럼명을 rate 로 바꾼다. daily_rate 라는 이름이 월급을 담으면 거짓말이 된다.
-- ---------------------------------------------------------------------
ALTER TABLE private_cost.labor_rate RENAME COLUMN daily_rate TO rate;
ALTER TABLE private_cost.labor_rate
  ADD COLUMN pay_type text NOT NULL DEFAULT 'DAILY'
    CHECK (pay_type IN ('DAILY', 'MONTHLY'));
COMMENT ON COLUMN private_cost.labor_rate.pay_type IS
  'DAILY=일당제(rate 는 1공수 단가) / MONTHLY=월급제(rate 는 월액) (§25)';
COMMENT ON COLUMN private_cost.labor_rate.rate IS
  'pay_type 에 따라 일당 또는 월액. 어느 쪽인지 이름으로 단정하지 않는다.';

-- ---------------------------------------------------------------------
-- 월 정산방식 (§26 불가항력 → 일자로 계산하여 마무리)
--
--   PRORATED = 일할. 월액 ÷ 월 기준일수 × 실투입공수
--   FIXED    = 월액 전액. 그 달의 공수 비율로 일자에 배분한다.
--
--   기본값은 PRORATED 다. 사용자 확인: "출력일보·장비가동일보에 따라
--   1일 또는 0.5일이 입력되고 그에 따라 투입비를 통상적으로 계산한다."
--   월액 전액으로 마감해야 하는 달만 본사가 FIXED 로 지정한다.
-- ---------------------------------------------------------------------
CREATE TABLE private_cost.monthly_settlement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('LABOR', 'EQUIPMENT')),
  target_name text NOT NULL,          -- 직종명 또는 장비명
  year_month  date NOT NULL,          -- 해당 월의 1일
  method      text NOT NULL CHECK (method IN ('FIXED', 'PRORATED')),
  reason      text,                   -- 왜 이렇게 마감했는지. 근거를 남긴다 (§38)
  decided_by  uuid REFERENCES core.app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_ms_month CHECK (date_trunc('month', year_month) = year_month),
  UNIQUE (site_id, target_kind, target_name, year_month)
);
COMMENT ON TABLE private_cost.monthly_settlement IS
  '월대·월급의 그 달 정산방식. 기본은 일할(PRORATED). 불가항력 등으로 월액 전액을 '
  '계상해야 하면 FIXED 로 지정한다 (§26).';

CREATE TRIGGER trg_ms_touch BEFORE UPDATE ON private_cost.monthly_settlement
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_ms_audit AFTER INSERT OR UPDATE OR DELETE ON private_cost.monthly_settlement
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

ALTER TABLE private_cost.monthly_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_cost.monthly_settlement FORCE  ROW LEVEL SECURITY;
CREATE POLICY p_ms_ho ON private_cost.monthly_settlement FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());
GRANT SELECT, INSERT, UPDATE, DELETE ON private_cost.monthly_settlement TO rfcip_head_office;
REVOKE ALL ON private_cost.monthly_settlement FROM rfcip_field_manager, rfcip_external;

-- =====================================================================
-- 원가 계산 다시 쓰기 (§25, §26, §46)
--
--   0017 은 두 가지가 틀렸다.
--     1) 공수를 몰랐다. 반일만 나온 날도 하루치가 잡혔다.
--     2) 월대를 항상 일할로 나눴다. 월액 전액으로 마감하는 달을 표현할 수 없었다.
--
--   계산은 '월 단위'가 기준이다. FIXED 는 그 달 전체를 봐야 배분할 수 있다.
--   일자별 계산은 그 날이 속한 달을 다시 계산한 뒤 그 날만 돌려준다.
-- =====================================================================

DROP FUNCTION IF EXISTS private_cost.fn_calc_daily_labor_cost(uuid);
DROP FUNCTION IF EXISTS private_cost.fn_calc_daily_equipment_cost(uuid);

/**
 * 한 달치 노무비를 일자별로 계산한다. 저장하지 않는다 (미리보기 겸용).
 *
 *   일당제          : 투입공수 × 일당
 *   월급제 PRORATED : 투입공수 × (월액 ÷ 월 기준일수)
 *   월급제 FIXED    : 월액 전액을 그 달 공수 비율로 배분
 *
 * FIXED 는 배분 잔액을 마지막 날에 몰아 준다.
 * 일자별로 반올림만 하면 합계가 월액과 몇 원 어긋나고, 그 차이가 기성까지 따라간다.
 */
CREATE OR REPLACE FUNCTION private_cost.fn_calc_labor_cost(p_site_id uuid, p_month date)
RETURNS TABLE (work_date date, role_name text, headcount numeric, work_days numeric,
               man_days numeric, pay_type text, method text, rate numeric, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
DECLARE
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_days numeric;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '원가 계산은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  -- 월 기준일수는 현장이 정한다. 코드에 박지 않는다.
  SELECT param_value INTO v_days FROM core.site_design_param
   WHERE site_id = p_site_id AND param_code = 'MONTHLY_WORK_DAYS' AND section IS NULL;
  v_days := COALESCE(v_days, 30);

  RETURN QUERY
  WITH priced AS (
    SELECT e.work_date, e.role_name, e.headcount, e.work_days, e.man_days,
           r.rate, r.pay_type, COALESCE(s.method, 'PRORATED') AS method
      FROM core.v_daily_labor_effective e
      -- 현장 전용 단가가 있으면 그것을, 없으면 전사 기본단가를 쓴다.
      LEFT JOIN LATERAL (
        SELECT lr.rate, lr.pay_type FROM private_cost.labor_rate lr
         WHERE lr.role_name = e.role_name
           AND (lr.site_id = p_site_id OR lr.site_id IS NULL)
           AND lr.effective_from <= e.work_date
           AND (lr.effective_to IS NULL OR lr.effective_to >= e.work_date)
         ORDER BY lr.site_id NULLS LAST, lr.effective_from DESC
         LIMIT 1) r ON true
      LEFT JOIN private_cost.monthly_settlement s
             ON s.site_id = p_site_id AND s.target_kind = 'LABOR'
            AND s.target_name = e.role_name AND s.year_month = v_from
     WHERE e.site_id = p_site_id AND e.work_date BETWEEN v_from AND v_to
       AND e.man_days > 0
  ), alloc AS (
    SELECT p.*,
           CASE WHEN sum(p.man_days) OVER w > 0
                THEN round(p.rate * p.man_days / sum(p.man_days) OVER w, 2) END AS fixed_raw,
           row_number() OVER (PARTITION BY p.role_name ORDER BY p.work_date) AS rn,
           count(*)     OVER w AS n_rows
      FROM priced p
    WINDOW w AS (PARTITION BY p.role_name)
  ), spread AS (
    SELECT a.*,
           COALESCE(sum(a.fixed_raw) OVER (PARTITION BY a.role_name ORDER BY a.work_date
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS given
      FROM alloc a
  )
  SELECT x.work_date, x.role_name, x.headcount, x.work_days, x.man_days,
         x.pay_type, x.method, x.rate,
         CASE
           WHEN x.rate IS NULL THEN NULL          -- 단가가 없으면 0원으로 만들지 않는다
           WHEN x.pay_type = 'MONTHLY' AND x.method = 'FIXED'
             -- 마지막 날이 잔액을 받아 합계가 월액과 정확히 같아진다
             THEN CASE WHEN x.rn = x.n_rows THEN x.rate - x.given ELSE x.fixed_raw END
           WHEN x.pay_type = 'MONTHLY'
             THEN round(x.man_days * x.rate / v_days, 2)
           ELSE round(x.man_days * x.rate, 2)
         END
    FROM spread x
   ORDER BY x.work_date, x.role_name;
END $$;
GRANT EXECUTE ON FUNCTION private_cost.fn_calc_labor_cost(uuid, date) TO rfcip_head_office;

/** 장비비. 규칙은 노무비와 같다. 일대/기타는 가동일수 × 단가. */
CREATE OR REPLACE FUNCTION private_cost.fn_calc_equipment_cost(p_site_id uuid, p_month date)
RETURNS TABLE (work_date date, equipment_name text, quantity numeric, operating_days numeric,
               unit_days numeric, charge_type text, method text, rate numeric, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
DECLARE
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_days numeric;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '원가 계산은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT param_value INTO v_days FROM core.site_design_param
   WHERE site_id = p_site_id AND param_code = 'MONTHLY_WORK_DAYS' AND section IS NULL;
  v_days := COALESCE(v_days, 30);

  RETURN QUERY
  WITH priced AS (
    SELECT e.work_date, e.equipment_name, e.quantity, e.operating_days, e.unit_days,
           e.charge_type, r.rate, COALESCE(s.method, 'PRORATED') AS method
      FROM core.v_daily_equipment_effective e
      LEFT JOIN LATERAL (
        SELECT er.rate FROM private_cost.equipment_rate er
         WHERE er.equipment_name = e.equipment_name
           AND er.charge_type = e.charge_type
           AND (er.site_id = p_site_id OR er.site_id IS NULL)
           AND er.effective_from <= e.work_date
           AND (er.effective_to IS NULL OR er.effective_to >= e.work_date)
         ORDER BY er.site_id NULLS LAST, er.effective_from DESC
         LIMIT 1) r ON true
      LEFT JOIN private_cost.monthly_settlement s
             ON s.site_id = p_site_id AND s.target_kind = 'EQUIPMENT'
            AND s.target_name = e.equipment_name AND s.year_month = v_from
     WHERE e.site_id = p_site_id AND e.work_date BETWEEN v_from AND v_to
       AND e.unit_days > 0
  ), alloc AS (
    SELECT p.*,
           CASE WHEN sum(p.unit_days) OVER w > 0
                THEN round(p.rate * p.unit_days / sum(p.unit_days) OVER w, 2) END AS fixed_raw,
           row_number() OVER (PARTITION BY p.equipment_name ORDER BY p.work_date) AS rn,
           count(*)     OVER w AS n_rows
      FROM priced p
    WINDOW w AS (PARTITION BY p.equipment_name)
  ), spread AS (
    SELECT a.*,
           COALESCE(sum(a.fixed_raw) OVER (PARTITION BY a.equipment_name ORDER BY a.work_date
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS given
      FROM alloc a
  )
  SELECT x.work_date, x.equipment_name, x.quantity, x.operating_days, x.unit_days,
         x.charge_type, x.method, x.rate,
         CASE
           WHEN x.rate IS NULL THEN NULL
           WHEN x.charge_type = 'MONTHLY' AND x.method = 'FIXED'
             THEN CASE WHEN x.rn = x.n_rows THEN x.rate - x.given ELSE x.fixed_raw END
           WHEN x.charge_type = 'MONTHLY'
             THEN round(x.unit_days * x.rate / v_days, 2)
           ELSE round(x.unit_days * x.rate, 2)
         END
    FROM spread x
   ORDER BY x.work_date, x.equipment_name;
END $$;
GRANT EXECUTE ON FUNCTION private_cost.fn_calc_equipment_cost(uuid, date) TO rfcip_head_office;

/**
 * 한 달치 계산 결과를 DAILY_COST 에 반영한다.
 *
 * 그 달의 CALCULATED 행을 지우고 다시 넣는다.
 * 공수가 바뀌거나 정산방식이 바뀌면 금액도 따라 바뀌어야 하고,
 * FIXED 는 그 달 전체를 봐야 배분이 맞기 때문이다.
 * 사람이 입력한 MANUAL 행은 건드리지 않는다.
 */
CREATE OR REPLACE FUNCTION private_cost.fn_apply_monthly_cost(p_site_id uuid, p_month date)
RETURNS TABLE (cost_type text, amount numeric, missing_rate_count integer, day_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_labor_miss integer;
  v_equip_miss integer;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '원가 계산은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  CREATE TEMP TABLE tmp_labor ON COMMIT DROP AS
    SELECT * FROM private_cost.fn_calc_labor_cost(p_site_id, v_from);
  CREATE TEMP TABLE tmp_equip ON COMMIT DROP AS
    SELECT * FROM private_cost.fn_calc_equipment_cost(p_site_id, v_from);

  SELECT count(*) FILTER (WHERE l.rate IS NULL) INTO v_labor_miss FROM tmp_labor l;
  SELECT count(*) FILTER (WHERE e.rate IS NULL) INTO v_equip_miss FROM tmp_equip e;

  -- 다시 계산하므로 이전 자동계산분은 지운다. MANUAL 은 그대로 둔다.
  DELETE FROM private_cost.daily_cost c
   WHERE c.site_id = p_site_id AND c.source = 'CALCULATED'
     AND c.cost_date BETWEEN v_from AND v_to;

  INSERT INTO private_cost.daily_cost
    (site_id, cost_date, cost_type, amount, daily_work_id, source, calc_detail,
     evidence_status, created_by)
  SELECT p_site_id, d.work_date, 'C01', d.total,
         (SELECT w.id FROM core.daily_work w
           WHERE w.site_id = p_site_id AND w.work_date = d.work_date),
         'CALCULATED', d.detail, 'VERIFIED', app.current_user_id()
    FROM (
      SELECT l.work_date, sum(l.amount) AS total,
             jsonb_build_object(
               'basis', '인원 × 공수 × 단가',
               'items', jsonb_agg(jsonb_build_object(
                 'role_name', l.role_name, 'headcount', l.headcount::text,
                 'work_days', l.work_days::text, 'man_days', l.man_days::text,
                 'pay_type', l.pay_type, 'method', l.method,
                 'rate', l.rate::text, 'amount', l.amount::text) ORDER BY l.role_name),
               'missing_rate', count(*) FILTER (WHERE l.rate IS NULL)) AS detail
        FROM tmp_labor l GROUP BY l.work_date
    ) d
   WHERE d.total > 0;

  INSERT INTO private_cost.daily_cost
    (site_id, cost_date, cost_type, amount, daily_work_id, source, calc_detail,
     evidence_status, created_by)
  SELECT p_site_id, d.work_date, 'C02', d.total,
         (SELECT w.id FROM core.daily_work w
           WHERE w.site_id = p_site_id AND w.work_date = d.work_date),
         'CALCULATED', d.detail, 'VERIFIED', app.current_user_id()
    FROM (
      SELECT e.work_date, sum(e.amount) AS total,
             jsonb_build_object(
               'basis', '대수 × 가동일수 × 단가',
               'items', jsonb_agg(jsonb_build_object(
                 'equipment_name', e.equipment_name, 'quantity', e.quantity::text,
                 'operating_days', e.operating_days::text, 'unit_days', e.unit_days::text,
                 'charge_type', e.charge_type, 'method', e.method,
                 'rate', e.rate::text, 'amount', e.amount::text) ORDER BY e.equipment_name),
               'missing_rate', count(*) FILTER (WHERE e.rate IS NULL)) AS detail
        FROM tmp_equip e GROUP BY e.work_date
    ) d
   WHERE d.total > 0;

  RETURN QUERY
  SELECT 'C01', COALESCE((SELECT sum(l.amount) FROM tmp_labor l), 0), v_labor_miss,
         (SELECT count(DISTINCT l.work_date)::integer FROM tmp_labor l)
  UNION ALL
  SELECT 'C02', COALESCE((SELECT sum(e.amount) FROM tmp_equip e), 0), v_equip_miss,
         (SELECT count(DISTINCT e.work_date)::integer FROM tmp_equip e);

  DROP TABLE tmp_labor;
  DROP TABLE tmp_equip;
END $$;
GRANT EXECUTE ON FUNCTION private_cost.fn_apply_monthly_cost(uuid, date) TO rfcip_head_office;

/**
 * 하루치 요청도 받는다. 다만 계산은 그 날이 속한 달 전체를 다시 한다.
 * FIXED 배분이 그 달 전체를 봐야 맞기 때문이다.
 */
CREATE OR REPLACE FUNCTION private_cost.fn_apply_calculated_cost(p_daily_work_id uuid)
RETURNS TABLE (cost_type text, amount numeric, missing_rate_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
#variable_conflict use_column
DECLARE w core.daily_work%ROWTYPE;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '원가 계산은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT * INTO w FROM core.daily_work WHERE id = p_daily_work_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '일일 작업을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;

  PERFORM private_cost.fn_apply_monthly_cost(w.site_id, w.work_date);

  -- 돌려주는 값은 '그 날' 금액이다.
  RETURN QUERY
  SELECT t.code,
         COALESCE((SELECT c.amount FROM private_cost.daily_cost c
                    WHERE c.site_id = w.site_id AND c.cost_date = w.work_date
                      AND c.cost_type = t.code AND c.source = 'CALCULATED'), 0),
         COALESCE((SELECT (c.calc_detail->>'missing_rate')::integer
                     FROM private_cost.daily_cost c
                    WHERE c.site_id = w.site_id AND c.cost_date = w.work_date
                      AND c.cost_type = t.code AND c.source = 'CALCULATED'),
                  -- 금액이 0이라 행이 안 생긴 경우에도 빠진 단가는 알려야 한다
                  (SELECT count(*)::integer FROM private_cost.fn_calc_labor_cost(w.site_id, w.work_date) l
                    WHERE l.work_date = w.work_date AND l.rate IS NULL AND t.code = 'C01')
                  + (SELECT count(*)::integer FROM private_cost.fn_calc_equipment_cost(w.site_id, w.work_date) e
                      WHERE e.work_date = w.work_date AND e.rate IS NULL AND t.code = 'C02'))
    FROM (VALUES ('C01'), ('C02')) AS t(code);
END $$;
GRANT EXECUTE ON FUNCTION private_cost.fn_apply_calculated_cost(uuid) TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- §43 자동검증 — 공수와 실적이 어긋나는 날
--   ERROR 가 아니다. 반일 작업이나 장비 대기는 정상적으로 생긴다 (§26).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_work_days(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  -- 천공 실적은 있는데 아무도 출력하지 않은 날
  RETURN QUERY
  SELECT 'LABOR_ZERO_WITH_WORK', 'WARN', w.work_date::text,
         '천공 실적이 있는데 출력 공수가 0입니다. 출력일보를 확인해 주십시오.'
    FROM core.daily_work w
   WHERE w.site_id = p_site_id
     AND EXISTS (SELECT 1 FROM core.daily_work_hole h WHERE h.daily_work_id = w.id)
     AND COALESCE((SELECT sum(e.man_days) FROM core.v_daily_labor_effective e
                    WHERE e.daily_work_id = w.id), 0) = 0;

  -- 천공 실적은 있는데 장비가 하나도 가동하지 않은 날
  RETURN QUERY
  SELECT 'EQUIPMENT_IDLE_WITH_WORK', 'WARN', w.work_date::text,
         '천공 실적이 있는데 장비 가동일수가 0입니다. 장비가동일보를 확인해 주십시오.'
    FROM core.daily_work w
   WHERE w.site_id = p_site_id
     AND EXISTS (SELECT 1 FROM core.daily_work_hole h WHERE h.daily_work_id = w.id)
     AND COALESCE((SELECT sum(e.unit_days) FROM core.v_daily_equipment_effective e
                    WHERE e.daily_work_id = w.id), 0) = 0;

  -- 사유 없이 반일·미가동으로 적힌 장비 (§26 SPECIAL_EVENT 연결 대비)
  RETURN QUERY
  SELECT 'IDLE_REASON_MISSING', 'INFO', w.work_date || ' ' || e.equipment_name,
         '가동일수가 1일이 아닌데 사유가 없습니다. 정산 근거로 남겨두는 편이 좋습니다.'
    FROM core.v_equipment_log e
    JOIN core.daily_work w ON w.site_id = e.site_id AND w.work_date = e.work_date
   WHERE e.site_id = p_site_id AND e.operating_days <> 1 AND e.idle_reason IS NULL;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_work_days(uuid)
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
  UNION ALL SELECT * FROM core.fn_check_cost_evidence(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_work_days(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;

REVOKE ALL ON ALL TABLES IN SCHEMA private_cost FROM rfcip_external;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_cost FROM rfcip_external;
REVOKE ALL ON SCHEMA private_cost FROM rfcip_external;
