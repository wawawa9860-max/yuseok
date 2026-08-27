-- =====================================================================
-- 0021 PHASE 10 : 공정률 / 기성
--   Master Prompt §36(공정률), §37(기성), §38(Revision), §29, §43, §46
--
--   §37 의 핵심 문장
--     "기성가능액 ≠ 실제 제출 기성 으로 구분한다.
--      실제 기성 제출은 본사 승인이 필요하다."
--
--   그래서 이 단계는 '초안'과 '확정'을 구조적으로 분리한다.
--   초안은 언제든 다시 계산되고, 확정은 그 순간을 그대로 얼려 둔다 (§38).
--
--   §29 기성은 '계약금액' 이다. 내부 원가가 아니다.
--   계약단가는 §44 대로 현장관리자도 볼 수 있다. private_cost 를 건드리지 않는다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §36 공정률 — 물량 / 금액 + 보조지표
--
--   물량 공정률 = 누적 완료 계약수량 ÷ 전체 계약수량
--   금액 공정률 = 누적 시공 인정금액 ÷ 현재 계약금액
--   보조지표    = 공수 / 총 천공연장 / 지층별 천공량
--
--   기준을 숨기지 않는다. 계약수량이 없어 계획심도로 대신 계산했다면 그 사실을 낸다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_progress_full(p_site_id uuid, p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_date     date := COALESCE(p_date, CURRENT_DATE);
  v_q        record;                 -- 물량 공정률 (기존 함수 재사용)
  v_amount   numeric;                -- 현재 계약금액
  v_earned   numeric;                -- 누적 시공 인정금액
  v_basis    text;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT * INTO v_q FROM core.fn_site_progress(p_site_id, v_date);

  -- 금액 공정률 : 완료된 공의 (계약수량 × 계약단가) 합계
  --
  -- 날짜로 자르지 않는다. 물량 공정률(fn_site_progress)이 완료된 것을 전부 세므로
  -- 여기만 날짜로 자르면 같은 화면에서 물량 10% · 금액 0% 처럼 어긋나 보인다.
  -- 기간이 필요한 것은 기성이고, 그쪽(fn_payment_draft)이 기간을 받는다.
  SELECT round(COALESCE(sum(h.contract_quantity * h.contract_unit_price)
                    FILTER (WHERE h.status = 'COMPLETED'), 0), 2)
    INTO v_earned
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.contract_unit_price IS NOT NULL;

  SELECT COALESCE(sum(c.current_amount), 0) INTO v_amount
    FROM core.contract c WHERE c.site_id = p_site_id AND c.status <> 'DRAFT';

  -- 계약금액이 없으면 공의 계약금액 합계로 대신한다. 무엇을 썼는지 함께 낸다.
  IF v_amount = 0 THEN
    SELECT round(COALESCE(sum(h.contract_quantity * h.contract_unit_price), 0), 2)
      INTO v_amount
      FROM core.hole_master h
     WHERE h.site_id = p_site_id AND h.contract_unit_price IS NOT NULL;
    v_basis := CASE WHEN v_amount > 0 THEN 'HOLE_CONTRACT_AMOUNT' ELSE 'NONE' END;
  ELSE
    v_basis := 'CONTRACT_AMOUNT';
  END IF;

  RETURN jsonb_build_object(
    'as_of', v_date,

    -- §36 물량 공정률
    'quantity', jsonb_build_object(
      'total', v_q.total_quantity::text,
      'completed', v_q.completed_quantity::text,
      'remaining', v_q.remaining_quantity::text,
      'rate', v_q.progress_rate::text,
      'basis', v_q.quantity_basis),

    -- §36 금액 공정률
    'amount', jsonb_build_object(
      'contract_amount', v_amount::text,
      'earned_amount', v_earned::text,
      'rate', CASE WHEN v_amount = 0 THEN '0.0'
                   ELSE round(v_earned / v_amount * 100, 1)::text END,
      'basis', v_basis),

    -- §36 보조지표
    'hole_count', jsonb_build_object(
      'total', v_q.total_holes, 'completed', v_q.completed_holes,
      'today', v_q.today_holes, 'remaining', v_q.remaining_holes,
      'rate', CASE WHEN v_q.total_holes = 0 THEN '0.0'
                   ELSE round(v_q.completed_holes::numeric / v_q.total_holes * 100, 1)::text END),

    'length', (
      SELECT jsonb_build_object(
        'total', COALESCE(sum(h.design_depth_total), 0)::text,
        'completed', COALESCE(sum(COALESCE(h.actual_depth_total, h.design_depth_total))
                       FILTER (WHERE h.status = 'COMPLETED'), 0)::text,
        'rate', CASE WHEN COALESCE(sum(h.design_depth_total), 0) = 0 THEN '0.0'
                ELSE round(COALESCE(sum(COALESCE(h.actual_depth_total, h.design_depth_total))
                             FILTER (WHERE h.status = 'COMPLETED'), 0)
                           / sum(h.design_depth_total) * 100, 1)::text END)
        FROM core.hole_master h WHERE h.site_id = p_site_id),

    -- 지층별 천공량. 실제 지층별 실적은 따로 받지 않으므로 계획 기준임을 밝힌다.
    'by_ground_type', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ground_type_code', s.code, 'ground_type_name', s.name,
               'planned_length', s.planned::text,
               'completed_length', s.done::text,
               'rate', CASE WHEN s.planned = 0 THEN '0.0'
                            ELSE round(s.done / s.planned * 100, 1)::text END)
               ORDER BY s.sort_order)
        FROM (SELECT g.code, g.name, g.sort_order,
                     sum(l.planned_length) AS planned,
                     COALESCE(sum(l.planned_length)
                       FILTER (WHERE h.status = 'COMPLETED'), 0) AS done
                FROM core.hole_master h
                JOIN core.ground_profile_layer l ON l.ground_profile_id = h.ground_profile_id
                JOIN core.ground_type g ON g.id = l.ground_type_id
               WHERE h.site_id = p_site_id
               GROUP BY g.code, g.name, g.sort_order) s), '[]'::jsonb),
    'by_ground_type_basis', 'PLANNED_LENGTH',

    -- 보조지표: 투입 공수 (출력일보 누계)
    'man_days', COALESCE((
      SELECT sum(e.man_days)::text FROM core.v_daily_labor_effective e
       WHERE e.site_id = p_site_id AND e.work_date <= v_date), '0'),

    'generated_at', now());
END $$;
GRANT EXECUTE ON FUNCTION core.fn_progress_full(uuid, date)
  TO rfcip_head_office, rfcip_field_manager;

-- =====================================================================
-- §37 기성
-- =====================================================================

-- 기성 회차. 확정하면 그 순간을 얼려 둔다 (§38 원본 보존).
CREATE TABLE core.payment_certificate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  contract_id     uuid REFERENCES core.contract(id) ON DELETE SET NULL,
  sequence_no     integer NOT NULL CHECK (sequence_no >= 1),   -- 몇 회차 기성인가
  period_from     date NOT NULL,
  period_to       date NOT NULL,

  -- §37 '기성가능액' 과 '실제 제출 기성' 은 다른 값이다. 칸을 나눈다.
  draft_amount    numeric(18,2) NOT NULL DEFAULT 0 CHECK (draft_amount    >= 0),
  submitted_amount numeric(18,2)                   CHECK (submitted_amount >= 0),
  -- 초안과 제출액이 다르면 왜 다른지 반드시 남긴다.
  adjust_reason   text,

  status          text NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  -- 확정 시점의 계산 근거 전체. 나중에 원본이 바뀌어도 이 값은 그대로다 (§38).
  snapshot        jsonb,

  submitted_by    uuid REFERENCES core.app_user(id),
  submitted_at    timestamptz,
  approved_by     uuid REFERENCES core.app_user(id),
  approved_at     timestamptz,
  memo            text,
  created_by      uuid REFERENCES core.app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (site_id, sequence_no),
  CONSTRAINT ck_pc_period CHECK (period_to >= period_from),
  -- 제출·승인 상태에는 제출액이 반드시 있어야 한다.
  CONSTRAINT ck_pc_submitted CHECK (
    status = 'DRAFT' OR status = 'REJECTED' OR submitted_amount IS NOT NULL),
  -- 초안과 다른 금액을 제출하면 사유를 남겨야 한다.
  CONSTRAINT ck_pc_adjust CHECK (
    submitted_amount IS NULL OR submitted_amount = draft_amount OR adjust_reason IS NOT NULL)
);
COMMENT ON TABLE core.payment_certificate IS
  '§37 기성. draft_amount=기성가능액(초안), submitted_amount=실제 제출 기성. 둘은 다른 값이다.';
COMMENT ON COLUMN core.payment_certificate.snapshot IS
  '확정 시점의 공별 계산 근거. 원본이 나중에 바뀌어도 이 값은 그대로 남는다 (§38).';

CREATE INDEX ix_pc_site ON core.payment_certificate(site_id, sequence_no DESC);

CREATE TRIGGER trg_pc_touch BEFORE UPDATE ON core.payment_certificate
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_pc_audit AFTER INSERT OR UPDATE OR DELETE ON core.payment_certificate
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- 기성에 포함된 공. 확정 후에 어떤 공이 들어갔는지 되짚을 수 있어야 한다.
CREATE TABLE core.payment_certificate_hole (
  certificate_id    uuid NOT NULL REFERENCES core.payment_certificate(id) ON DELETE CASCADE,
  hole_id           uuid NOT NULL REFERENCES core.hole_master(id) ON DELETE CASCADE,
  contract_quantity numeric(18,4),
  unit_price        numeric(18,2),
  amount            numeric(18,2),
  construction_date date,
  PRIMARY KEY (certificate_id, hole_id)
);

-- ---------------------------------------------------------------------
-- RLS
--   기성 열람은 현장관리자도 할 수 있다 (계약금액은 §44 상 볼 수 있는 값).
--   확정·승인은 본사만.
-- ---------------------------------------------------------------------
ALTER TABLE core.payment_certificate      ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.payment_certificate_hole ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.payment_certificate      FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.payment_certificate_hole FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_pc_read ON core.payment_certificate FOR SELECT
  USING (app.has_site_access(site_id));
CREATE POLICY p_pc_admin ON core.payment_certificate FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_pch_read ON core.payment_certificate_hole FOR SELECT
  USING (EXISTS (SELECT 1 FROM core.payment_certificate c
                  WHERE c.id = certificate_id AND app.has_site_access(c.site_id)));
CREATE POLICY p_pch_admin ON core.payment_certificate_hole FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

GRANT SELECT ON core.payment_certificate, core.payment_certificate_hole
  TO rfcip_head_office, rfcip_field_manager;
GRANT INSERT, UPDATE, DELETE ON core.payment_certificate, core.payment_certificate_hole
  TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- §37 기성가능액 초안
--   완료된 HOLE_MASTER 기준. 저장하지 않는다. 언제 불러도 지금 값을 낸다.
--   이미 앞 회차에 들어간 공은 빼야 이중 계상이 안 된다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_payment_draft(
  p_site_id uuid, p_from date, p_to date, p_exclude_certificate uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_rows       jsonb;
  v_amount     numeric := 0;
  v_qty        numeric := 0;
  v_count      integer := 0;
  v_no_price   integer := 0;
  v_prev       numeric := 0;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  -- 대상: 기간 안에 완료됐고, 아직 어느 기성에도 들어가지 않은 공
  WITH target AS (
    SELECT h.id, h.hole_no, h.sort_key, h.contract_quantity, h.contract_unit,
           h.contract_unit_price, h.construction_date,
           round(COALESCE(h.contract_quantity, 0)
                 * COALESCE(h.contract_unit_price, 0), 2) AS amount
      FROM core.hole_master h
     WHERE h.site_id = p_site_id
       AND h.status = 'COMPLETED'
       AND h.construction_date BETWEEN p_from AND p_to
       AND NOT EXISTS (
             SELECT 1 FROM core.payment_certificate_hole ph
               JOIN core.payment_certificate c ON c.id = ph.certificate_id
              WHERE ph.hole_id = h.id
                AND c.status <> 'REJECTED'
                AND (p_exclude_certificate IS NULL OR c.id <> p_exclude_certificate))
  )
  SELECT jsonb_agg(jsonb_build_object(
           'hole_no', t.hole_no,
           'contract_quantity', t.contract_quantity::text,
           'contract_unit', t.contract_unit,
           'unit_price', t.contract_unit_price::text,
           'amount', t.amount::text,
           'construction_date', t.construction_date) ORDER BY t.sort_key),
         COALESCE(sum(t.amount), 0),
         COALESCE(sum(t.contract_quantity), 0),
         count(*)::integer,
         count(*) FILTER (WHERE t.contract_unit_price IS NULL)::integer
    INTO v_rows, v_amount, v_qty, v_count, v_no_price
    FROM target t;

  -- 앞 회차 누계 (거절된 것은 뺀다)
  SELECT COALESCE(sum(COALESCE(c.submitted_amount, c.draft_amount)), 0) INTO v_prev
    FROM core.payment_certificate c
   WHERE c.site_id = p_site_id AND c.status IN ('SUBMITTED', 'APPROVED')
     AND (p_exclude_certificate IS NULL OR c.id <> p_exclude_certificate);

  RETURN jsonb_build_object(
    'period_from', p_from, 'period_to', p_to,
    'hole_count', v_count,
    'quantity', v_qty::text,
    -- §37 이것은 '기성가능액' 이다. 실제 제출 기성이 아니다.
    'draft_amount', v_amount::text,
    'previous_amount', v_prev::text,
    'cumulative_amount', (v_prev + v_amount)::text,
    'holes', COALESCE(v_rows, '[]'::jsonb),
    'issues', CASE WHEN v_no_price = 0 THEN '[]'::jsonb ELSE jsonb_build_array(
      jsonb_build_object(
        'code', 'UNIT_PRICE_NOT_SET', 'severity', 'WARN',
        -- 단가가 없는 공을 0원으로 계산해 놓고 조용히 넘어가지 않는다.
        'message', format('계약단가가 없는 천공이 %s공 있어 그만큼 금액에서 빠졌습니다.',
                          v_no_price))) END,
    'generated_at', now());
END $$;
GRANT EXECUTE ON FUNCTION core.fn_payment_draft(uuid, date, date, uuid)
  TO rfcip_head_office, rfcip_field_manager;

/**
 * 기성 회차를 만든다 (초안). 본사만.
 * 이 시점의 공 목록을 함께 남겨 무엇이 들어갔는지 되짚을 수 있게 한다.
 */
CREATE OR REPLACE FUNCTION core.fn_create_payment(
  p_site_id uuid, p_from date, p_to date, p_memo text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_draft jsonb;
  v_id    uuid;
  v_seq   integer;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '기성 작성은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  v_draft := core.fn_payment_draft(p_site_id, p_from, p_to);
  IF (v_draft->>'hole_count')::integer = 0 THEN
    RAISE EXCEPTION '그 기간에 새로 기성할 완료 천공이 없습니다.' USING ERRCODE='no_data_found';
  END IF;

  SELECT COALESCE(max(sequence_no), 0) + 1 INTO v_seq
    FROM core.payment_certificate WHERE site_id = p_site_id;

  INSERT INTO core.payment_certificate
    (site_id, contract_id, sequence_no, period_from, period_to,
     draft_amount, status, memo, created_by)
  VALUES (p_site_id,
          (SELECT c.id FROM core.contract c
            WHERE c.site_id = p_site_id AND c.status = 'ACTIVE' LIMIT 1),
          v_seq, p_from, p_to,
          (v_draft->>'draft_amount')::numeric, 'DRAFT', p_memo, app.current_user_id())
  RETURNING id INTO v_id;

  INSERT INTO core.payment_certificate_hole
    (certificate_id, hole_id, contract_quantity, unit_price, amount, construction_date)
  SELECT v_id, h.id, h.contract_quantity, h.contract_unit_price,
         round(COALESCE(h.contract_quantity, 0) * COALESCE(h.contract_unit_price, 0), 2),
         h.construction_date
    FROM core.hole_master h
   WHERE h.site_id = p_site_id
     AND h.hole_no IN (SELECT x->>'hole_no' FROM jsonb_array_elements(v_draft->'holes') x);

  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_create_payment(uuid, date, date, text) TO rfcip_head_office;

/**
 * §37 실제 기성 제출. 본사 승인 동작이다.
 *   초안과 다른 금액을 내려면 사유가 있어야 한다 (제약조건이 강제한다).
 *   제출 시점의 계산 근거를 snapshot 에 얼려 둔다 (§38).
 */
CREATE OR REPLACE FUNCTION core.fn_submit_payment(
  p_certificate_id uuid, p_amount numeric, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  c core.payment_certificate%ROWTYPE;
  v_snapshot jsonb;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '기성 제출은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT * INTO c FROM core.payment_certificate WHERE id = p_certificate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '기성을 찾을 수 없습니다.' USING ERRCODE='no_data_found';
  END IF;
  IF c.status IN ('SUBMITTED', 'APPROVED') THEN
    RAISE EXCEPTION '이미 제출된 기성입니다. 되돌리려면 반려하십시오.'
      USING ERRCODE='invalid_parameter_value';
  END IF;

  v_snapshot := core.fn_payment_draft(c.site_id, c.period_from, c.period_to, p_certificate_id);

  UPDATE core.payment_certificate
     SET submitted_amount = p_amount,
         adjust_reason    = p_reason,
         status           = 'SUBMITTED',
         snapshot         = v_snapshot,
         submitted_by     = app.current_user_id(),
         submitted_at     = now()
   WHERE id = p_certificate_id;

  RETURN jsonb_build_object(
    'certificate_id', p_certificate_id,
    'status', 'SUBMITTED',
    'draft_amount', c.draft_amount::text,
    'submitted_amount', p_amount::text,
    'adjust_reason', p_reason);
END $$;
GRANT EXECUTE ON FUNCTION core.fn_submit_payment(uuid, numeric, text) TO rfcip_head_office;

/** 승인 / 반려. 반려하면 그 회차의 공이 다시 다음 기성 대상이 된다. */
CREATE OR REPLACE FUNCTION core.fn_decide_payment(
  p_certificate_id uuid, p_approve boolean, p_memo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '기성 승인은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  v_status := CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END;

  UPDATE core.payment_certificate
     SET status      = v_status,
         approved_by = app.current_user_id(),
         approved_at = now(),
         memo        = COALESCE(p_memo, memo)
   WHERE id = p_certificate_id AND status = 'SUBMITTED';

  IF NOT FOUND THEN
    RAISE EXCEPTION '제출된 기성만 승인하거나 반려할 수 있습니다.'
      USING ERRCODE='invalid_parameter_value';
  END IF;
  RETURN jsonb_build_object('certificate_id', p_certificate_id, 'status', v_status);
END $$;
GRANT EXECUTE ON FUNCTION core.fn_decide_payment(uuid, boolean, text) TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- §43 자동검증 — 기성
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_payment(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_total numeric;
  v_paid  numeric;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  -- 계약단가가 없는 완료 천공은 기성에서 조용히 빠진다. 그것을 알린다.
  RETURN QUERY
  SELECT 'PAYMENT_UNIT_PRICE_MISSING', 'WARN', '기성',
         format('계약단가가 없는 완료 천공이 %s공 있어 기성에서 빠집니다.', count(*))
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.status = 'COMPLETED'
     AND h.contract_unit_price IS NULL
  HAVING count(*) > 0;

  -- 누적 기성이 계약금액을 넘으면 설계변경 없이 넘긴 것이다. ERROR 다.
  SELECT COALESCE(sum(c.current_amount), 0) INTO v_total
    FROM core.contract c WHERE c.site_id = p_site_id AND c.status <> 'DRAFT';
  SELECT COALESCE(sum(COALESCE(p.submitted_amount, p.draft_amount)), 0) INTO v_paid
    FROM core.payment_certificate p
   WHERE p.site_id = p_site_id AND p.status IN ('SUBMITTED', 'APPROVED');

  IF v_total > 0 AND v_paid > v_total THEN
    RETURN QUERY SELECT 'PAYMENT_OVER_CONTRACT', 'ERROR', '기성',
      format('누적 기성 %s원이 계약금액 %s원을 넘습니다. 설계변경을 확인하십시오.',
             to_char(v_paid, 'FM999,999,999,990'), to_char(v_total, 'FM999,999,999,990'));
  END IF;

  -- 제출한 지 오래된 채로 승인이 안 난 기성
  RETURN QUERY
  SELECT 'PAYMENT_PENDING_APPROVAL', 'INFO', p.sequence_no || '회차',
         format('%s회차 기성이 제출된 지 %s일째 승인 대기입니다.',
                p.sequence_no, (CURRENT_DATE - p.submitted_at::date))
    FROM core.payment_certificate p
   WHERE p.site_id = p_site_id AND p.status = 'SUBMITTED'
     AND p.submitted_at < now() - interval '7 days';
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_payment(uuid)
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
  UNION ALL SELECT * FROM core.fn_check_progress_consistency(p_site_id)
  UNION ALL SELECT * FROM core.fn_check_payment(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;
