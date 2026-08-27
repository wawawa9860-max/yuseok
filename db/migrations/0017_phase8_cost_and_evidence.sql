-- =====================================================================
-- 0017 PHASE 8 : 비용 + 사진증빙 + 본사전용 보안
--   Master Prompt §24(6개 항목), §25(노무비), §26(장비비), §27(사진증빙),
--                 §28(증빙상태), §29(원가보안 절대규칙), §30(모델), §46
--
--   이 단계부터 실제 금액이 들어온다. §29 가 가장 강하게 걸린다.
--
--   절대 규칙
--     · 원가·단가·영수증은 private_cost 스키마 안에서만 존재한다
--     · core / share 에 금액 컬럼을 만들지 않는다
--     · 계약상대방(rfcip_external)은 private_cost 에 USAGE 자체가 없다
--     · 노무비·장비비 계산도 private_cost 안에서만 이루어진다
-- =====================================================================

-- ---------------------------------------------------------------------
-- 단가 마스터 보강 (§25, §26)
--   PHASE 1 에 만들어 둔 labor_rate / equipment_rate 를 실제로 쓸 수 있게 한다.
-- ---------------------------------------------------------------------
ALTER TABLE private_cost.labor_rate
  ADD COLUMN note text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE private_cost.equipment_rate
  ADD COLUMN note text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER trg_lr_touch BEFORE UPDATE ON private_cost.labor_rate
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_er_touch BEFORE UPDATE ON private_cost.equipment_rate
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_lr_audit AFTER INSERT OR UPDATE OR DELETE ON private_cost.labor_rate
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();
CREATE TRIGGER trg_er_audit AFTER INSERT OR UPDATE OR DELETE ON private_cost.equipment_rate
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- 같은 대상·같은 기간에 단가가 겹치면 어느 것을 쓸지 알 수 없다.
CREATE UNIQUE INDEX ux_labor_rate_key
  ON private_cost.labor_rate (COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
                              role_name, effective_from);
CREATE UNIQUE INDEX ux_equipment_rate_key
  ON private_cost.equipment_rate (COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                  equipment_name, charge_type, effective_from);

-- ---------------------------------------------------------------------
-- DAILY_COST 보강 (§30)
--   일일작업과 연결해 작업일보·정산이 같은 데이터를 재사용하게 한다 (§1-7).
-- ---------------------------------------------------------------------
ALTER TABLE private_cost.daily_cost
  ADD COLUMN daily_work_id uuid REFERENCES core.daily_work(id) ON DELETE SET NULL,
  -- 사람이 입력한 것인지, 단가로 자동계산된 것인지 구분한다.
  ADD COLUMN source text NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL', 'CALCULATED')),
  ADD COLUMN calc_detail jsonb;

COMMENT ON COLUMN private_cost.daily_cost.source IS
  'MANUAL=현장 입력 / CALCULATED=기본 인원·장비 × 본사 단가로 자동계산 (§25, §26)';
COMMENT ON COLUMN private_cost.daily_cost.calc_detail IS
  '자동계산 근거. 무엇에 어떤 단가를 곱했는지 남긴다. 사람이 검증할 수 있어야 한다.';

CREATE INDEX ix_daily_cost_work ON private_cost.daily_cost(daily_work_id);

-- 자동계산분은 항목당 하루 1건이어야 한다 (중복 계상 방지)
CREATE UNIQUE INDEX ux_daily_cost_calculated
  ON private_cost.daily_cost (site_id, cost_date, cost_type)
  WHERE source = 'CALCULATED';

-- ---------------------------------------------------------------------
-- §25 노무비 = 기본 인원 × 본사 등록단가
-- §26 장비비 = 기본 장비 × 계약방식별 단가
--
--   현장에서 매일 인원·단가를 입력시키지 않는다. 변경만 반영한다.
--   이 함수는 private_cost 안에서만 동작하며 결과도 private_cost 에만 남는다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private_cost.fn_calc_daily_labor_cost(p_daily_work_id uuid)
RETURNS TABLE (role_name text, headcount numeric, daily_rate numeric, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
DECLARE w core.daily_work%ROWTYPE;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '원가 계산은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT * INTO w FROM core.daily_work WHERE id = p_daily_work_id;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT e.role_name, e.headcount, r.daily_rate,
         round(e.headcount * r.daily_rate, 2)
    FROM core.v_daily_labor_effective e
    -- 현장 전용 단가가 있으면 그것을, 없으면 전사 기본단가를 쓴다.
    LEFT JOIN LATERAL (
      SELECT lr.daily_rate FROM private_cost.labor_rate lr
       WHERE lr.role_name = e.role_name
         AND (lr.site_id = w.site_id OR lr.site_id IS NULL)
         AND lr.effective_from <= w.work_date
         AND (lr.effective_to IS NULL OR lr.effective_to >= w.work_date)
       ORDER BY lr.site_id NULLS LAST, lr.effective_from DESC
       LIMIT 1) r ON true
   WHERE e.daily_work_id = p_daily_work_id AND e.headcount > 0;
END $$;
GRANT EXECUTE ON FUNCTION private_cost.fn_calc_daily_labor_cost(uuid) TO rfcip_head_office;

CREATE OR REPLACE FUNCTION private_cost.fn_calc_daily_equipment_cost(p_daily_work_id uuid)
RETURNS TABLE (equipment_name text, charge_type text, quantity numeric,
               rate numeric, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
DECLARE w core.daily_work%ROWTYPE;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '원가 계산은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT * INTO w FROM core.daily_work WHERE id = p_daily_work_id;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  SELECT e.equipment_name, e.charge_type, e.quantity, r.rate,
         CASE
           -- 월대는 하루치로 환산한다. 환산일수는 현장 설계 파라미터를 쓴다.
           WHEN e.charge_type = 'MONTHLY'
             THEN round(e.quantity * r.rate / COALESCE(
                    (SELECT param_value FROM core.site_design_param
                      WHERE site_id = w.site_id AND param_code = 'MONTHLY_WORK_DAYS'
                        AND section IS NULL), 30), 2)
           ELSE round(e.quantity * r.rate, 2)
         END
    FROM core.v_daily_equipment_effective e
    LEFT JOIN LATERAL (
      SELECT er.rate FROM private_cost.equipment_rate er
       WHERE er.equipment_name = e.equipment_name
         AND er.charge_type = e.charge_type
         AND (er.site_id = w.site_id OR er.site_id IS NULL)
         AND er.effective_from <= w.work_date
         AND (er.effective_to IS NULL OR er.effective_to >= w.work_date)
       ORDER BY er.site_id NULLS LAST, er.effective_from DESC
       LIMIT 1) r ON true
   WHERE e.daily_work_id = p_daily_work_id AND e.quantity > 0;
END $$;
GRANT EXECUTE ON FUNCTION private_cost.fn_calc_daily_equipment_cost(uuid) TO rfcip_head_office;

/**
 * 자동계산 결과를 DAILY_COST 에 반영한다 (§25, §26).
 * 단가가 없는 항목은 계산하지 않고 그 사실을 남긴다. 0원으로 만들지 않는다.
 */
CREATE OR REPLACE FUNCTION private_cost.fn_apply_calculated_cost(p_daily_work_id uuid)
RETURNS TABLE (cost_type text, amount numeric, missing_rate_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
-- OUT 파라미터(cost_type, amount)와 daily_cost 의 컬럼명이 같다.
-- INSERT 문 안에서는 항상 '컬럼'을 뜻하도록 못박는다.
#variable_conflict use_column
DECLARE
  w            core.daily_work%ROWTYPE;
  v_labor      numeric := 0;
  v_equip      numeric := 0;
  v_labor_miss integer := 0;
  v_equip_miss integer := 0;
  v_labor_json jsonb;
  v_equip_json jsonb;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '원가 계산은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT * INTO w FROM core.daily_work WHERE id = p_daily_work_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '일일 작업을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;

  SELECT COALESCE(sum(l.amount), 0), count(*) FILTER (WHERE l.daily_rate IS NULL),
         jsonb_agg(jsonb_build_object(
           'role_name', l.role_name, 'headcount', l.headcount::text,
           'daily_rate', l.daily_rate::text, 'amount', l.amount::text))
    INTO v_labor, v_labor_miss, v_labor_json
    FROM private_cost.fn_calc_daily_labor_cost(p_daily_work_id) l;

  SELECT COALESCE(sum(e.amount), 0), count(*) FILTER (WHERE e.rate IS NULL),
         jsonb_agg(jsonb_build_object(
           'equipment_name', e.equipment_name, 'charge_type', e.charge_type,
           'quantity', e.quantity::text, 'rate', e.rate::text, 'amount', e.amount::text))
    INTO v_equip, v_equip_miss, v_equip_json
    FROM private_cost.fn_calc_daily_equipment_cost(p_daily_work_id) e;

  IF v_labor > 0 THEN
    INSERT INTO private_cost.daily_cost
      (site_id, cost_date, cost_type, amount, daily_work_id, source, calc_detail,
       evidence_status, created_by)
    VALUES (w.site_id, w.work_date, 'C01', v_labor, p_daily_work_id, 'CALCULATED',
            jsonb_build_object('items', v_labor_json, 'missing_rate', v_labor_miss),
            'VERIFIED', app.current_user_id())
    ON CONFLICT (site_id, cost_date, cost_type) WHERE source = 'CALCULATED'
      DO UPDATE SET amount = EXCLUDED.amount, calc_detail = EXCLUDED.calc_detail;
  END IF;

  IF v_equip > 0 THEN
    INSERT INTO private_cost.daily_cost
      (site_id, cost_date, cost_type, amount, daily_work_id, source, calc_detail,
       evidence_status, created_by)
    VALUES (w.site_id, w.work_date, 'C02', v_equip, p_daily_work_id, 'CALCULATED',
            jsonb_build_object('items', v_equip_json, 'missing_rate', v_equip_miss),
            'VERIFIED', app.current_user_id())
    ON CONFLICT (site_id, cost_date, cost_type) WHERE source = 'CALCULATED'
      DO UPDATE SET amount = EXCLUDED.amount, calc_detail = EXCLUDED.calc_detail;
  END IF;

  RETURN QUERY VALUES ('C01', v_labor, v_labor_miss), ('C02', v_equip, v_equip_miss);
END $$;
GRANT EXECUTE ON FUNCTION private_cost.fn_apply_calculated_cost(uuid) TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 증빙 상태 자동 전이 (§28)
--   영수증이 붙으면 '증빙대기' → '증빙완료'.
--   영수증이 즉시 없는 현장상황을 고려해 입력 자체를 막지 않는다 (§28 후단).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private_cost.trg_evidence_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = private_cost, pg_temp AS $$
DECLARE v_cost uuid;
BEGIN
  v_cost := COALESCE(NEW.cost_id, OLD.cost_id);
  UPDATE private_cost.daily_cost c
     SET evidence_status = CASE
           WHEN EXISTS (SELECT 1 FROM private_cost.cost_evidence e WHERE e.cost_id = c.id)
             THEN 'VERIFIED'
           WHEN c.evidence_status = 'HEAD_OFFICE_REVIEW' THEN 'HEAD_OFFICE_REVIEW'
           ELSE 'PENDING_EVIDENCE' END
   WHERE c.id = v_cost AND c.source = 'MANUAL';
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_cost_evidence_status
  AFTER INSERT OR DELETE ON private_cost.cost_evidence
  FOR EACH ROW EXECUTE FUNCTION private_cost.trg_evidence_status();

-- ---------------------------------------------------------------------
-- 본사 원가 집계 (§39 대시보드 대비)
--   현장관리자는 이 뷰에 접근할 수 없다. GRANT 를 주지 않는다.
-- ---------------------------------------------------------------------
CREATE VIEW private_cost.v_daily_cost_summary AS
SELECT c.site_id, c.cost_date,
       sum(c.amount) AS total_amount,
       sum(c.amount) FILTER (WHERE c.cost_type = 'C01') AS labor_amount,
       sum(c.amount) FILTER (WHERE c.cost_type = 'C02') AS equipment_amount,
       sum(c.amount) FILTER (WHERE c.cost_type NOT IN ('C01','C02')) AS other_amount,
       count(*) FILTER (WHERE c.evidence_status = 'VERIFIED')::integer AS verified_count,
       count(*) FILTER (WHERE c.evidence_status = 'PENDING_EVIDENCE')::integer AS pending_count,
       count(*) FILTER (WHERE c.evidence_status = 'HEAD_OFFICE_REVIEW')::integer AS review_count,
       count(*)::integer AS cost_count
  FROM private_cost.daily_cost c
 GROUP BY c.site_id, c.cost_date;

GRANT SELECT ON private_cost.v_daily_cost_summary TO rfcip_head_office;
REVOKE ALL ON private_cost.v_daily_cost_summary FROM rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 증빙률 (현장관리자도 볼 수 있는 유일한 원가 관련 지표)
--   §52 "비용 증빙률 확인 가능" — 금액이 아니라 '건수'만 돌려준다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private_cost.fn_evidence_rate(p_site_id uuid, p_from date, p_to date)
RETURNS TABLE (total_count integer, verified_count integer,
               pending_count integer, review_count integer, evidence_rate numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = private_cost, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT count(*)::integer,
         count(*) FILTER (WHERE evidence_status = 'VERIFIED')::integer,
         count(*) FILTER (WHERE evidence_status = 'PENDING_EVIDENCE')::integer,
         count(*) FILTER (WHERE evidence_status = 'HEAD_OFFICE_REVIEW')::integer,
         CASE WHEN count(*) = 0 THEN 0::numeric(5,1)
              ELSE round(count(*) FILTER (WHERE evidence_status = 'VERIFIED')::numeric
                         / count(*) * 100, 1)::numeric(5,1) END
    FROM private_cost.daily_cost
   WHERE site_id = p_site_id AND cost_date BETWEEN p_from AND p_to
     AND source = 'MANUAL';   -- 자동계산분은 증빙 대상이 아니다
END $$;
-- 금액이 아니라 건수만 나가므로 현장관리자도 실행할 수 있다.
GRANT EXECUTE ON FUNCTION private_cost.fn_evidence_rate(uuid, date, date)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 자동검증 (§43) — 비용 증빙 누락
--   금액은 넣지 않는다. 본사 대시보드가 상세를 따로 조회한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_cost_evidence(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE v_pending integer;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  -- 본사만 원가 존재 여부를 본다 (§43: 현장에 모든 경고를 보이지 않는다)
  IF NOT app.is_head_office() THEN RETURN; END IF;

  SELECT count(*) INTO v_pending
    FROM private_cost.daily_cost
   WHERE site_id = p_site_id AND evidence_status = 'PENDING_EVIDENCE' AND source = 'MANUAL';

  IF v_pending > 0 THEN
    RETURN QUERY SELECT 'COST_EVIDENCE_PENDING', 'WARN', '비용증빙',
      format('영수증이 아직 없는 비용이 %s건 있습니다.', v_pending);
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_cost_evidence(uuid)
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
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §29 영수증 visibility 가드 수정
--   0006 의 가드는 SHARED_EXTERNAL 요청을 먼저 HEAD_OFFICE_ONLY 로 바꿔버려서
--   그 다음 줄의 RAISE 가 절대 실행되지 않았다. 막히기는 하지만 '조용히' 막힌다.
--   계약상대방에게 영수증을 공유하려는 시도는 조용히 넘어가면 안 된다.
--   → 명시적으로 SHARED_EXTERNAL 을 요청하면 거부하고, 나머지만 강제 교정한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.trg_file_visibility_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category = 'RECEIPT' AND NEW.visibility = 'SHARED_EXTERNAL' THEN
    RAISE EXCEPTION '영수증은 계약상대방에게 공유할 수 없습니다.' USING ERRCODE='check_violation';
  END IF;
  IF NEW.category = 'RECEIPT' AND NEW.visibility <> 'HEAD_OFFICE_ONLY' THEN
    NEW.visibility := 'HEAD_OFFICE_ONLY';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- §27 영수증 첨부 (현장관리자가 실행할 수 있어야 한다)
--
--   영수증 파일은 core.stored_file 에 들어가는 순간 트리거가
--   visibility='HEAD_OFFICE_ONLY' 로 바꾼다. 그런데 stored_file 의 SELECT 정책은
--   본사전용 파일을 현장관리자에게 '행 자체가 없는 것'으로 만든다.
--   그래서 현장관리자가 직접 INSERT ... RETURNING 하면 42501 로 막힌다.
--
--   §44 는 현장관리자에게 '증빙 업로드'를 허용한다. 그렇다고 stored_file 의
--   본사전용 정책을 느슨하게 만들면 §29 가 무너진다.
--   → 정책은 그대로 두고, '영수증을 붙인다'는 이 동작 하나만 통과시킨다.
--     자기 현장의, 자기가 입력한 비용에만 붙일 수 있다.
--     돌려주는 값에도 금액은 없다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private_cost.fn_attach_cost_evidence(
  p_cost_id       uuid,
  p_storage_key   text,
  p_original_name text,
  p_mime_type     text,
  p_byte_size     bigint,
  p_checksum      text)
RETURNS TABLE (file_id uuid, visibility text, evidence_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = private_cost, core, app, pg_temp AS $$
-- OUT 파라미터(visibility, evidence_status)가 컬럼명과 같다. 컬럼을 뜻하게 못박는다.
#variable_conflict use_column
DECLARE
  v_site uuid;
  v_file uuid;
  v_vis  text;
BEGIN
  -- SECURITY DEFINER 라 RLS 를 건너뛴다. 권한을 여기서 직접 확인한다.
  SELECT c.site_id INTO v_site
    FROM private_cost.daily_cost c
   WHERE c.id = p_cost_id
     AND (app.is_head_office()
          OR (app.has_site_access(c.site_id) AND c.created_by = app.current_user_id()));
  IF NOT FOUND THEN
    RAISE EXCEPTION '비용을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;

  INSERT INTO core.stored_file
    (site_id, storage_backend, storage_key, original_name, mime_type,
     byte_size, checksum_sha256, category, uploaded_by)
  VALUES (v_site, 'LOCAL', p_storage_key, p_original_name, p_mime_type,
          p_byte_size, p_checksum, 'RECEIPT', app.current_user_id())
  ON CONFLICT (storage_backend, storage_key) DO UPDATE
    SET original_name = EXCLUDED.original_name
  RETURNING id, visibility INTO v_file, v_vis;

  INSERT INTO private_cost.cost_evidence (cost_id, file_id, file_type, uploaded_by)
  VALUES (p_cost_id, v_file, 'RECEIPT', app.current_user_id())
  ON CONFLICT DO NOTHING;

  RETURN QUERY
  SELECT v_file, v_vis, c.evidence_status
    FROM private_cost.daily_cost c WHERE c.id = p_cost_id;
END $$;

REVOKE ALL ON FUNCTION private_cost.fn_attach_cost_evidence(
  uuid, text, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private_cost.fn_attach_cost_evidence(
  uuid, text, text, text, bigint, text) TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §29 재확인 : 외부는 어떤 경로로도 접근 불가
-- ---------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA private_cost FROM rfcip_external;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private_cost FROM rfcip_external;
REVOKE ALL ON SCHEMA private_cost FROM rfcip_external;
