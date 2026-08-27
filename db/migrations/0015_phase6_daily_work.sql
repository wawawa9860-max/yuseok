-- =====================================================================
-- 0015 PHASE 6 : 모바일 오늘 작업입력
--   Master Prompt §15, §16, §18, §19, §20, §46, §47, §52
--
--   핵심 원칙
--     · 정상상태보다 예외상태만 입력하게 한다 (§1-6)
--     · 매일 동일한 값은 재입력시키지 않는다 (§1-4)
--     · 한 번 입력한 데이터를 모든 문서가 재사용한다 (§1-7)
--     · 지층별 수량은 자동집계한다. 다시 입력시키지 않는다 (§20)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 일일 작업 (현장 × 날짜 = 1건)
-- ---------------------------------------------------------------------
CREATE TABLE core.daily_work (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  work_date     date NOT NULL,
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED')),
  -- 익일계획은 다음날 화면의 기본값이 된다 (§1-5 전일값 재사용)
  next_day_plan text,
  memo          text,
  submitted_at  timestamptz,
  submitted_by  uuid REFERENCES core.app_user(id),
  created_by    uuid REFERENCES core.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, work_date)
);
CREATE INDEX ix_daily_work_site_date ON core.daily_work(site_id, work_date DESC);
CREATE TRIGGER trg_dw_touch BEFORE UPDATE ON core.daily_work
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_dw_audit AFTER INSERT OR UPDATE OR DELETE ON core.daily_work
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- ---------------------------------------------------------------------
-- 당일 시공한 천공번호
--   depth_same_as_plan = true 면 실제심도를 따로 입력하지 않는다 (§16)
-- ---------------------------------------------------------------------
CREATE TABLE core.daily_work_hole (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_work_id      uuid NOT NULL REFERENCES core.daily_work(id) ON DELETE CASCADE,
  hole_id            uuid NOT NULL REFERENCES core.hole_master(id) ON DELETE CASCADE,
  depth_same_as_plan boolean NOT NULL DEFAULT true,
  actual_depth_total numeric(8,3) CHECK (actual_depth_total > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_work_id, hole_id),
  -- 계획과 다르다고 했으면 실제심도가 있어야 한다
  CONSTRAINT ck_dwh_actual_depth CHECK (depth_same_as_plan OR actual_depth_total IS NOT NULL)
);
CREATE INDEX ix_dwh_hole ON core.daily_work_hole(hole_id);

-- 같은 천공번호를 두 날짜에 걸쳐 완료 처리할 수 없다.
CREATE UNIQUE INDEX ux_dwh_hole_once ON core.daily_work_hole(hole_id);

-- ---------------------------------------------------------------------
-- 지반조건 특이사항 (§15)
--   현장관리자에게 매 공마다 실제 지층을 입력시키지 않는다.
--   "계획과 다른 점이 있었습니까?" 에 '있음' 일 때만 남긴다.
-- ---------------------------------------------------------------------
CREATE TABLE core.daily_ground_note (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_work_id uuid NOT NULL REFERENCES core.daily_work(id) ON DELETE CASCADE,
  note_type     text NOT NULL,          -- 현장별 선택지. 시스템이 목록을 강제하지 않는다.
  memo          text,
  created_by    uuid REFERENCES core.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_dgn_work ON core.daily_ground_note(daily_work_id);

-- 특이사항과 천공번호 연결 (§32) — 있으면 연결한다
CREATE TABLE core.daily_ground_note_hole (
  note_id uuid NOT NULL REFERENCES core.daily_ground_note(id) ON DELETE CASCADE,
  hole_id uuid NOT NULL REFERENCES core.hole_master(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, hole_id)
);

-- ---------------------------------------------------------------------
-- 일일 입력 반영 : HOLE_MASTER 를 갱신한다
--   실제심도는 §16 대로 "계획과 동일" 이면 계획심도를 그대로 쓴다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_apply_daily_work(p_daily_work_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  w core.daily_work%ROWTYPE;
  v_count integer := 0;
BEGIN
  SELECT * INTO w FROM core.daily_work WHERE id = p_daily_work_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '일일 작업을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;
  IF NOT app.has_site_access(w.site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  UPDATE core.hole_master h
     SET status = 'COMPLETED',
         construction_date = w.work_date,
         actual_depth_total = CASE
           WHEN d.depth_same_as_plan THEN h.design_depth_total
           ELSE d.actual_depth_total END
    FROM core.daily_work_hole d
   WHERE d.daily_work_id = p_daily_work_id AND h.id = d.hole_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_apply_daily_work(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 오늘 작업 자동집계 (§19, §20) — 결정론적 계산 (§46)
--   선택한 천공번호로부터 공수·연장·지층별 수량을 계산한다.
--   현장관리자가 지층 수량을 다시 입력하지 않는다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_daily_layer_summary(p_hole_ids uuid[])
RETURNS TABLE (ground_type_code text, ground_type_name text, planned_length numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT g.code, g.name, sum(l.planned_length)::numeric(14,3)
    FROM core.hole_master h
    JOIN core.ground_profile_layer l ON l.ground_profile_id = h.ground_profile_id
    JOIN core.ground_type g          ON g.id = l.ground_type_id
   WHERE h.id = ANY(p_hole_ids)
   GROUP BY g.code, g.name, g.sort_order
   ORDER BY g.sort_order, g.code
$$;
GRANT EXECUTE ON FUNCTION core.fn_daily_layer_summary(uuid[])
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 현장 진행 현황 (§18 메인화면, §36 공정률)
--   물량 공정률 = 누적 완료 계약수량 / 전체 계약수량 × 100
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_site_progress(p_site_id uuid, p_date date DEFAULT NULL)
RETURNS TABLE (
  total_holes integer, completed_holes integer, today_holes integer, remaining_holes integer,
  total_quantity numeric, completed_quantity numeric, remaining_quantity numeric,
  progress_rate numeric, quantity_basis text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_date     date := COALESCE(p_date, CURRENT_DATE);
  v_contract numeric;
  v_design   numeric;
  v_basis    text;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  -- §36 물량 공정률의 기준은 계약수량이다.
  -- 다만 계약수량이 아직 연결되지 않은 현장에서 공정률이 영원히 0%로 보이면
  -- 현장이 "안 돌아간다"고 오해한다. 그럴 때만 계획심도로 대신 계산하고
  -- 어떤 기준을 썼는지 함께 돌려준다. 기준을 숨기지 않는다.
  SELECT COALESCE(sum(h.contract_quantity), 0), COALESCE(sum(h.design_depth_total), 0)
    INTO v_contract, v_design
    FROM core.hole_master h WHERE h.site_id = p_site_id;

  v_basis := CASE WHEN v_contract > 0 THEN 'CONTRACT_QUANTITY'
                  WHEN v_design   > 0 THEN 'DESIGN_DEPTH'
                  ELSE 'NONE' END;

  RETURN QUERY
  SELECT count(*)::integer,
         count(*) FILTER (WHERE h.status='COMPLETED')::integer,
         count(*) FILTER (WHERE h.status='COMPLETED' AND h.construction_date = v_date)::integer,
         count(*) FILTER (WHERE h.status <> 'COMPLETED')::integer,
         COALESCE(sum(q.qty), 0)::numeric(18,3),
         COALESCE(sum(q.qty) FILTER (WHERE h.status='COMPLETED'), 0)::numeric(18,3),
         COALESCE(sum(q.qty) FILTER (WHERE h.status<>'COMPLETED'), 0)::numeric(18,3),
         CASE WHEN COALESCE(sum(q.qty), 0) = 0 THEN 0::numeric(5,1)
              ELSE round(
                COALESCE(sum(q.qty) FILTER (WHERE h.status='COMPLETED'), 0)
                / sum(q.qty) * 100, 1)::numeric(5,1) END,
         v_basis
    FROM core.hole_master h
    CROSS JOIN LATERAL (SELECT CASE v_basis
             WHEN 'CONTRACT_QUANTITY' THEN h.contract_quantity
             WHEN 'DESIGN_DEPTH'      THEN h.design_depth_total
             ELSE NULL END AS qty) q
   WHERE h.site_id = p_site_id;
END $$;

GRANT EXECUTE ON FUNCTION core.fn_site_progress(uuid, date)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- RLS : 현장관리자가 자기 현장에 입력한다
-- ---------------------------------------------------------------------
ALTER TABLE core.daily_work            ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_work_hole       ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_ground_note     ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_ground_note_hole ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_work            FORCE ROW LEVEL SECURITY;
ALTER TABLE core.daily_work_hole       FORCE ROW LEVEL SECURITY;
ALTER TABLE core.daily_ground_note     FORCE ROW LEVEL SECURITY;
ALTER TABLE core.daily_ground_note_hole FORCE ROW LEVEL SECURITY;

CREATE POLICY p_dw_site ON core.daily_work FOR ALL
  USING (app.has_site_access(site_id)) WITH CHECK (app.has_site_access(site_id));

CREATE POLICY p_dwh_site ON core.daily_work_hole FOR ALL
  USING (EXISTS (SELECT 1 FROM core.daily_work w
                  WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.daily_work w
                       WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)));

CREATE POLICY p_dgn_site ON core.daily_ground_note FOR ALL
  USING (EXISTS (SELECT 1 FROM core.daily_work w
                  WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.daily_work w
                       WHERE w.id = daily_work_id AND app.has_site_access(w.site_id)));

CREATE POLICY p_dgnh_site ON core.daily_ground_note_hole FOR ALL
  USING (EXISTS (SELECT 1 FROM core.daily_ground_note n JOIN core.daily_work w ON w.id = n.daily_work_id
                  WHERE n.id = note_id AND app.has_site_access(w.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.daily_ground_note n JOIN core.daily_work w ON w.id = n.daily_work_id
                       WHERE n.id = note_id AND app.has_site_access(w.site_id)));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON core.daily_work, core.daily_work_hole, core.daily_ground_note, core.daily_ground_note_hole
  TO rfcip_head_office, rfcip_field_manager;

-- 일일 입력이 있으면 현장관리자도 실적 컬럼을 갱신할 수 있어야 한다 (이미 GRANT 되어 있음)

-- ---------------------------------------------------------------------
-- 계약수량 미연결 경고 (§36, §43)
--   공정률이 영원히 0%로 보이는 상황을 본사가 먼저 알아야 한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_quantity_basis(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE v_missing integer; v_total integer;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE contract_quantity IS NULL)
    INTO v_total, v_missing
    FROM core.hole_master WHERE site_id = p_site_id;

  IF v_total > 0 AND v_missing = v_total THEN
    RETURN QUERY SELECT 'NO_CONTRACT_QUANTITY', 'WARN', '공정률',
      format('%s공 전부 계약수량이 연결되지 않아 공정률을 계획심도로 대신 계산합니다. '
             '기성 산정 전에 계약수량을 연결하십시오.', v_total);
  ELSIF v_missing > 0 THEN
    RETURN QUERY SELECT 'PARTIAL_CONTRACT_QUANTITY', 'WARN', '공정률',
      format('%s / %s공 에 계약수량이 없어 물량 공정률이 실제보다 낮게 나옵니다.',
             v_missing, v_total);
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_quantity_basis(uuid)
  TO rfcip_head_office, rfcip_field_manager;

CREATE OR REPLACE FUNCTION core.fn_validate_site_full(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT * FROM core.fn_validate_site(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_hole_type_depth(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_drawing_consistency(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_hole_count_basis(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_quantity_basis(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;
