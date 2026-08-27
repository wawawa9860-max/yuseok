-- =====================================================================
-- 0022 사전 업로드 5종 · 단가는 내역서로 · 월/일 이분화 · 계획심도 체크
--   Master Prompt §5, §24, §25, §26, §36, §37, §16, §31, §43
--
--   사용자 확인 (2026-08-27)
--     1) 천공과 평균단가를 같은 항목에 두니 단순하지 않다.
--        본사가 현장 배포 전 올리는 것은
--          계약내역서 · 천공조서 · 수량산출서 · 공내역서 · 작업도면(평면도 넘버링)
--        → 단가는 '내역서' 에 있다. 천공에 붙이지 않는다.
--     2) 월대·월급 / 일대·일당 두 갈래로 나누면 편하다.
--     3) 월 단위를 기본으로 둔다.
--     4) 평면도 기준으로 천공조서 심도를 확인하고, 현장은
--        '계획심도까지 됐는지 안 됐는지' 만 체크한다.
--        못 간 경우는 특이사항으로 남긴다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) 본사 사전 업로드 5종
-- ---------------------------------------------------------------------
ALTER TABLE core.document DROP CONSTRAINT document_doc_type_check;
ALTER TABLE core.document ADD CONSTRAINT document_doc_type_check CHECK (doc_type IN (
  'CONTRACT_BOQ',      -- 계약내역서 (단가의 원천)
  'DRILLING_REGISTER', -- 천공조서
  'QUANTITY_SHEET',    -- 수량산출서
  'WORK_BOQ',          -- 공내역서
  'WORK_DRAWING',      -- 작업도면 (평면도 넘버링)
  'CONTRACT', 'OTHER'  -- 기존 값 보존 (§38 덮어쓰지 않는다)
));
COMMENT ON COLUMN core.document.doc_type IS
  '본사가 현장 배포 전 올리는 5종: CONTRACT_BOQ 계약내역서 / DRILLING_REGISTER 천공조서 '
  '/ QUANTITY_SHEET 수량산출서 / WORK_BOQ 공내역서 / WORK_DRAWING 작업도면(평면도 넘버링)';

-- ---------------------------------------------------------------------
-- 2) 단가는 계약내역서에 있다
--
--   천공 한 공마다 단가를 붙이면 같은 값이 수백 번 복사되고,
--   설계변경이 나면 전부 고쳐야 한다. 그래서 천공종류를 내역 품목에 건다.
--
--   단가를 찾는 순서
--     1. 그 공에만 따로 정한 단가 (예외)
--     2. 천공종류가 걸린 계약내역서 품목의 단가   ← 기본
--   둘 다 없으면 없는 것이다. 0원으로 만들지 않는다.
-- ---------------------------------------------------------------------
ALTER TABLE core.site_hole_type
  ADD COLUMN contract_item_code text;
COMMENT ON COLUMN core.site_hole_type.contract_item_code IS
  '이 천공종류의 단가가 들어있는 계약내역서 품목코드. 설계변경이 나면 '
  '현재 revision 의 같은 품목코드를 자동으로 따라간다 (§38).';

COMMENT ON COLUMN core.hole_master.contract_unit_price IS
  '그 공에만 따로 정한 예외 단가. 보통은 비워 둔다. 단가의 기본 출처는 계약내역서다.';

/**
 * 공별 단가 해석. 기성·금액공정률은 전부 이 뷰를 쓴다.
 * 설계변경이 나면 현재 revision 의 같은 품목코드를 자동으로 따라간다.
 */
CREATE VIEW core.v_hole_price AS
SELECT h.id AS hole_id, h.site_id, h.hole_no, h.sort_key, h.status,
       h.construction_date, h.contract_quantity,
       COALESCE(h.contract_unit, ci.unit) AS contract_unit,
       COALESCE(h.contract_unit_price, ci.unit_price) AS unit_price,
       CASE WHEN h.contract_unit_price IS NOT NULL THEN 'HOLE_OVERRIDE'
            WHEN ci.unit_price IS NOT NULL         THEN 'CONTRACT_BOQ'
            ELSE 'NONE' END AS price_source,
       ci.item_code, ci.item_name,
       round(COALESCE(h.contract_quantity, 0)
             * COALESCE(h.contract_unit_price, ci.unit_price, 0), 2) AS amount
  FROM core.hole_master h
  LEFT JOIN core.site_hole_type ht ON ht.id = h.hole_type_id
  LEFT JOIN LATERAL (
    SELECT i.unit_price, i.unit, i.item_code, i.item_name
      FROM core.contract_item i
      JOIN core.contract c ON c.id = i.contract_id
     WHERE c.site_id = h.site_id AND c.status = 'ACTIVE'
       AND i.revision_no = c.current_revision
       AND ht.contract_item_code IS NOT NULL
       AND i.item_code = ht.contract_item_code
     LIMIT 1) ci ON true;

GRANT SELECT ON core.v_hole_price TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 3) 월대·월급 / 일대·일당 두 갈래
--
--   §26 은 '일대 / 월대 / 기타' 를 말하지만, 실제로 정산이 갈리는 지점은 둘뿐이다.
--   기타는 일 단위로 계산한다.
--
--   그리고 월 단위를 기본으로 둔다 (사용자 확인 3).
--   즉 월대·월급은 그 달 월액 전액이 기본이고,
--   불가항력 등으로 일자 정산할 때만 PRORATED 로 지정한다.
-- ---------------------------------------------------------------------
ALTER TABLE private_cost.monthly_settlement
  ALTER COLUMN method SET DEFAULT 'FIXED';
COMMENT ON TABLE private_cost.monthly_settlement IS
  '월대·월급의 그 달 정산방식. 기본은 월액 전액(FIXED). '
  '불가항력 등으로 일자 정산해 마무리할 때만 PRORATED 로 지정하고 사유를 남긴다 (§26).';

/** 계약방식을 두 갈래로 정리한다. 화면과 계산이 같은 말을 쓰게 한다. */
CREATE OR REPLACE FUNCTION core.fn_charge_basis(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_type = 'MONTHLY' THEN 'MONTHLY' ELSE 'DAILY' END;
$$;
COMMENT ON FUNCTION core.fn_charge_basis(text) IS
  'MONTHLY=월대·월급 / DAILY=일대·일당. 기타(OTHER)는 일 단위로 계산한다 (사용자 확인 2).';
GRANT EXECUTE ON FUNCTION core.fn_charge_basis(text) TO PUBLIC;

-- ---------------------------------------------------------------------
-- 4) 계획심도 도달 여부만 체크한다
--
--   현장은 숫자를 적지 않는다. '계획심도까지 갔다 / 못 갔다' 만 고른다.
--   못 간 공은 특이사항으로 남긴다. 사유 없이 못 간 것으로 두지 않는다.
-- ---------------------------------------------------------------------
COMMENT ON COLUMN core.daily_work_hole.depth_same_as_plan IS
  'true = 천공조서의 계획심도까지 도달. false = 미달(실제심도와 사유가 있어야 한다).';

ALTER TABLE core.daily_work_hole
  ADD COLUMN shortfall_reason text;
COMMENT ON COLUMN core.daily_work_hole.shortfall_reason IS
  '계획심도까지 못 간 사유. §31 특이사항과 같은 선택지를 쓴다.';

-- 미달이면 '어디까지 갔는지' 와 '왜' 가 둘 다 있어야 한다.
--   사유가 없으면 나중에 아무도 설명하지 못하고,
--   실제심도가 없으면 수량이 계획심도로 잡혀 과다계상된다.
ALTER TABLE core.daily_work_hole
  DROP CONSTRAINT ck_dwh_actual_depth;
ALTER TABLE core.daily_work_hole
  ADD CONSTRAINT ck_dwh_shortfall CHECK (
    depth_same_as_plan
    OR (shortfall_reason IS NOT NULL AND actual_depth_total IS NOT NULL));

/** 계획심도 미달 사유 선택지. 시스템이 목록을 강제하지 않도록 한곳에 모아 둔다 (§31). */
CREATE OR REPLACE FUNCTION core.fn_shortfall_reasons()
RETURNS TABLE (reason text, sort_order smallint)
LANGUAGE sql IMMUTABLE AS $$
  VALUES ('전석·호박돌', 1::smallint), ('지하수', 2::smallint), ('공벽붕괴', 3::smallint),
         ('장비고장', 4::smallint), ('지장물', 5::smallint), ('암반 조기출현', 6::smallint),
         ('작업부지 미조성', 7::smallint), ('원도급 지시', 8::smallint), ('기타', 9::smallint)
$$;
GRANT EXECUTE ON FUNCTION core.fn_shortfall_reasons() TO PUBLIC;

-- =====================================================================
-- 단가 출처가 바뀌었으므로 공정률·기성을 다시 쓴다
--   전부 core.v_hole_price 를 쓴다. 단가가 어디서 왔는지도 함께 낸다.
-- =====================================================================
CREATE OR REPLACE FUNCTION core.fn_progress_full(p_site_id uuid, p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_date   date := COALESCE(p_date, CURRENT_DATE);
  v_q      record;
  v_amount numeric;
  v_earned numeric;
  v_basis  text;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT * INTO v_q FROM core.fn_site_progress(p_site_id, v_date);

  -- 금액 공정률. 날짜로 자르지 않는다 — 물량 공정률과 같은 규칙이어야 한다.
  SELECT round(COALESCE(sum(p.amount) FILTER (WHERE p.status = 'COMPLETED'), 0), 2)
    INTO v_earned
    FROM core.v_hole_price p
   WHERE p.site_id = p_site_id AND p.unit_price IS NOT NULL;

  SELECT COALESCE(sum(c.current_amount), 0) INTO v_amount
    FROM core.contract c WHERE c.site_id = p_site_id AND c.status <> 'DRAFT';

  IF v_amount = 0 THEN
    SELECT round(COALESCE(sum(p.amount), 0), 2) INTO v_amount
      FROM core.v_hole_price p
     WHERE p.site_id = p_site_id AND p.unit_price IS NOT NULL;
    v_basis := CASE WHEN v_amount > 0 THEN 'HOLE_CONTRACT_AMOUNT' ELSE 'NONE' END;
  ELSE
    v_basis := 'CONTRACT_AMOUNT';
  END IF;

  RETURN jsonb_build_object(
    'as_of', v_date,
    'quantity', jsonb_build_object(
      'total', v_q.total_quantity::text, 'completed', v_q.completed_quantity::text,
      'remaining', v_q.remaining_quantity::text, 'rate', v_q.progress_rate::text,
      'basis', v_q.quantity_basis),
    'amount', jsonb_build_object(
      'contract_amount', v_amount::text, 'earned_amount', v_earned::text,
      'rate', CASE WHEN v_amount = 0 THEN '0.0'
                   ELSE round(v_earned / v_amount * 100, 1)::text END,
      'basis', v_basis),
    -- 단가가 어디서 왔는지 밝힌다. 내역서인지, 공별 예외인지, 아예 없는지.
    'price_sources', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('source', s.price_source, 'hole_count', s.n)
               ORDER BY s.price_source)
        FROM (SELECT p.price_source, count(*)::int AS n
                FROM core.v_hole_price p WHERE p.site_id = p_site_id
               GROUP BY p.price_source) s), '[]'::jsonb),
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
    'by_ground_type', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ground_type_code', s.code, 'ground_type_name', s.name,
               'planned_length', s.planned::text, 'completed_length', s.done::text,
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
    -- 계획심도까지 못 간 공. 현장이 체크한 그대로다 (사용자 확인 4).
    'depth_shortfall', (
      SELECT jsonb_build_object(
        'hole_count', count(*)::int,
        'reasons', COALESCE(jsonb_agg(DISTINCT d.shortfall_reason)
                     FILTER (WHERE d.shortfall_reason IS NOT NULL), '[]'::jsonb))
        FROM core.daily_work_hole d
        JOIN core.daily_work w ON w.id = d.daily_work_id
       WHERE w.site_id = p_site_id AND NOT d.depth_same_as_plan),
    'man_days', COALESCE((
      SELECT sum(e.man_days)::text FROM core.v_daily_labor_effective e
       WHERE e.site_id = p_site_id AND e.work_date <= v_date), '0'),
    'generated_at', now());
END $$;
GRANT EXECUTE ON FUNCTION core.fn_progress_full(uuid, date)
  TO rfcip_head_office, rfcip_field_manager;

/** §37 기성가능액 초안. 단가는 계약내역서에서 온다. */
CREATE OR REPLACE FUNCTION core.fn_payment_draft(
  p_site_id uuid, p_from date, p_to date, p_exclude_certificate uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_rows     jsonb;
  v_amount   numeric := 0;
  v_qty      numeric := 0;
  v_count    integer := 0;
  v_no_price integer := 0;
  v_prev     numeric := 0;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  WITH target AS (
    SELECT p.hole_id, p.hole_no, p.sort_key, p.contract_quantity, p.contract_unit,
           p.unit_price, p.price_source, p.item_code, p.item_name,
           p.construction_date, p.amount
      FROM core.v_hole_price p
     WHERE p.site_id = p_site_id
       AND p.status = 'COMPLETED'
       AND p.construction_date BETWEEN p_from AND p_to
       AND NOT EXISTS (
             SELECT 1 FROM core.payment_certificate_hole ph
               JOIN core.payment_certificate c ON c.id = ph.certificate_id
              WHERE ph.hole_id = p.hole_id
                AND c.status <> 'REJECTED'
                AND (p_exclude_certificate IS NULL OR c.id <> p_exclude_certificate))
  )
  SELECT jsonb_agg(jsonb_build_object(
           'hole_no', t.hole_no,
           'contract_quantity', t.contract_quantity::text,
           'contract_unit', t.contract_unit,
           'unit_price', t.unit_price::text,
           'price_source', t.price_source,
           'item_code', t.item_code,
           'item_name', t.item_name,
           'amount', t.amount::text,
           'construction_date', t.construction_date) ORDER BY t.sort_key),
         COALESCE(sum(t.amount) FILTER (WHERE t.unit_price IS NOT NULL), 0),
         COALESCE(sum(t.contract_quantity), 0),
         count(*)::integer,
         count(*) FILTER (WHERE t.unit_price IS NULL)::integer
    INTO v_rows, v_amount, v_qty, v_count, v_no_price
    FROM target t;

  SELECT COALESCE(sum(COALESCE(c.submitted_amount, c.draft_amount)), 0) INTO v_prev
    FROM core.payment_certificate c
   WHERE c.site_id = p_site_id AND c.status IN ('SUBMITTED', 'APPROVED')
     AND (p_exclude_certificate IS NULL OR c.id <> p_exclude_certificate);

  RETURN jsonb_build_object(
    'period_from', p_from, 'period_to', p_to,
    'hole_count', v_count,
    'quantity', v_qty::text,
    'draft_amount', v_amount::text,
    'previous_amount', v_prev::text,
    'cumulative_amount', (v_prev + v_amount)::text,
    'holes', COALESCE(v_rows, '[]'::jsonb),
    'issues', CASE WHEN v_no_price = 0 THEN '[]'::jsonb ELSE jsonb_build_array(
      jsonb_build_object(
        'code', 'UNIT_PRICE_NOT_SET', 'severity', 'WARN',
        'message', format('계약내역서에 단가가 연결되지 않은 천공이 %s공 있어 '
                          || '그만큼 금액에서 빠졌습니다. 천공종류에 내역 품목을 연결해 주십시오.',
                          v_no_price))) END,
    'generated_at', now());
END $$;
GRANT EXECUTE ON FUNCTION core.fn_payment_draft(uuid, date, date, uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- 기성 회차 생성도 같은 단가 출처를 쓴다
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
  SELECT v_id, p.hole_id, p.contract_quantity, p.unit_price, p.amount, p.construction_date
    FROM core.v_hole_price p
   WHERE p.site_id = p_site_id
     AND p.hole_no IN (SELECT x->>'hole_no' FROM jsonb_array_elements(v_draft->'holes') x);

  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_create_payment(uuid, date, date, text) TO rfcip_head_office;

-- ---------------------------------------------------------------------
-- 사전 업로드 5종 기준으로 현장설정 단계를 다시 쓴다
--   "본사가 현장 배포 전 무엇을 올려야 하는가" 가 그대로 보이게 한다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_site_setup_status(p_site_id uuid)
RETURNS TABLE (step smallint, step_name text, done boolean, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_holes        integer;
  v_holes_ground integer;
  v_holes_qty    integer;
  v_holes_price  integer;
  v_holes_mix    integer;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE h.ground_profile_id IS NOT NULL),
         count(*) FILTER (WHERE h.contract_quantity IS NOT NULL),
         count(*) FILTER (WHERE h.planned_ready_mix_quantity IS NOT NULL)
    INTO v_holes, v_holes_ground, v_holes_qty, v_holes_mix
    FROM core.hole_master h WHERE h.site_id = p_site_id;

  SELECT count(*) INTO v_holes_price
    FROM core.v_hole_price p WHERE p.site_id = p_site_id AND p.unit_price IS NOT NULL;

  RETURN QUERY SELECT 1::smallint, '현장 기본정보'::text, true,
    (SELECT s.site_name FROM core.site s WHERE s.id = p_site_id);

  -- ---- 본사 사전 업로드 5종 (사용자 확인) ----
  -- 계약내역서는 파일을 올렸는지보다 '품목과 단가가 시스템에 들어왔는지' 가 중요하다.
  -- 둘 중 하나라도 되어 있으면 완료로 본다.
  RETURN QUERY SELECT 2::smallint, '① 계약내역서'::text,
    (EXISTS (SELECT 1 FROM core.document d
              WHERE d.site_id = p_site_id AND d.doc_type IN ('CONTRACT_BOQ','CONTRACT'))
     OR EXISTS (SELECT 1 FROM core.contract_item i
                  JOIN core.contract ct ON ct.id = i.contract_id
                 WHERE ct.site_id = p_site_id AND i.revision_no = ct.current_revision)),
    (SELECT format('문서 %s건 · 내역품목 %s개',
             (SELECT count(*) FROM core.document d
               WHERE d.site_id = p_site_id AND d.doc_type IN ('CONTRACT_BOQ','CONTRACT')),
             (SELECT count(*) FROM core.contract_item i
                JOIN core.contract ct ON ct.id = i.contract_id
               WHERE ct.site_id = p_site_id AND i.revision_no = ct.current_revision)));

  RETURN QUERY SELECT 3::smallint, '② 천공조서'::text,
    EXISTS (SELECT 1 FROM core.document d
             WHERE d.site_id = p_site_id AND d.doc_type = 'DRILLING_REGISTER'),
    (SELECT CASE WHEN count(*) = 0 THEN '미등록 — 계획심도의 기준입니다'
                 ELSE count(*)::text || '건' END
       FROM core.document d WHERE d.site_id = p_site_id AND d.doc_type = 'DRILLING_REGISTER');

  RETURN QUERY SELECT 4::smallint, '③ 수량산출서'::text,
    EXISTS (SELECT 1 FROM core.document d
             WHERE d.site_id = p_site_id AND d.doc_type = 'QUANTITY_SHEET'),
    (SELECT COALESCE(count(*)::text || '건', '미등록')
       FROM core.document d WHERE d.site_id = p_site_id AND d.doc_type = 'QUANTITY_SHEET');

  RETURN QUERY SELECT 5::smallint, '④ 공내역서'::text,
    EXISTS (SELECT 1 FROM core.document d
             WHERE d.site_id = p_site_id AND d.doc_type = 'WORK_BOQ'),
    (SELECT COALESCE(count(*)::text || '건', '미등록')
       FROM core.document d WHERE d.site_id = p_site_id AND d.doc_type = 'WORK_BOQ');

  RETURN QUERY SELECT 6::smallint, '⑤ 작업도면 (평면도 넘버링)'::text,
    EXISTS (SELECT 1 FROM core.document d
             WHERE d.site_id = p_site_id AND d.doc_type = 'WORK_DRAWING'),
    (SELECT COALESCE(count(*)::text || '건', '미등록')
       FROM core.document d WHERE d.site_id = p_site_id AND d.doc_type = 'WORK_DRAWING');

  -- ---- 업로드한 자료를 시스템 값으로 옮기는 단계 ----
  RETURN QUERY SELECT 7::smallint, '천공번호 생성 (도면 넘버링 기준)'::text, v_holes > 0,
    v_holes::text || '공';

  RETURN QUERY SELECT 8::smallint, '지층종류'::text,
    EXISTS (SELECT 1 FROM core.ground_type g WHERE g.site_id = p_site_id),
    (SELECT COALESCE(string_agg(g.name, ', ' ORDER BY g.sort_order), '없음')
       FROM core.ground_type g WHERE g.site_id = p_site_id AND g.is_active);

  RETURN QUERY SELECT 9::smallint, '천공번호별 지반조건 · 계획심도'::text,
    (v_holes > 0 AND v_holes_ground = v_holes),
    v_holes_ground::text || ' / ' || v_holes::text || '공';

  RETURN QUERY SELECT 10::smallint, '계약수량'::text,
    (v_holes > 0 AND v_holes_qty = v_holes),
    v_holes_qty::text || ' / ' || v_holes::text || '공';

  -- 단가는 천공이 아니라 내역서에 있다. 여기서는 '연결됐는지' 만 본다.
  RETURN QUERY SELECT 11::smallint, '천공종류 ↔ 계약내역 품목 연결'::text,
    (v_holes > 0 AND v_holes_price = v_holes),
    CASE WHEN v_holes = 0 THEN '천공번호 먼저'
         WHEN v_holes_price = v_holes THEN v_holes_price::text || ' / ' || v_holes::text || '공'
         ELSE v_holes_price::text || ' / ' || v_holes::text || '공 — 단가는 계약내역서에서 옵니다'
    END;

  RETURN QUERY SELECT 12::smallint, '계획 레미콘량'::text,
    (v_holes > 0 AND v_holes_mix = v_holes),
    v_holes_mix::text || ' / ' || v_holes::text || '공';

  RETURN QUERY SELECT 13::smallint, '기본 인원/장비'::text,
    EXISTS (SELECT 1 FROM core.site_default_labor l WHERE l.site_id = p_site_id AND l.is_active),
    (SELECT count(*)::text || '개 직종'
       FROM core.site_default_labor l WHERE l.site_id = p_site_id AND l.is_active);

  RETURN QUERY SELECT 14::smallint, '검증'::text,
    NOT EXISTS (SELECT 1 FROM core.fn_validate_site(p_site_id) v WHERE v.severity='ERROR'),
    (SELECT count(*)::text || '건 오류'
       FROM core.fn_validate_site(p_site_id) v WHERE v.severity='ERROR');
END $$;
GRANT EXECUTE ON FUNCTION core.fn_site_setup_status(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §43 자동검증
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

  -- 단가가 연결되지 않은 완료 천공. 천공이 아니라 '연결' 이 빠진 것이다.
  RETURN QUERY
  SELECT 'PAYMENT_UNIT_PRICE_MISSING', 'WARN', '기성',
         format('계약내역서 단가가 연결되지 않은 완료 천공이 %s공 있어 기성에서 빠집니다. '
                || '천공종류에 내역 품목코드를 연결해 주십시오.', count(*))
    FROM core.v_hole_price p
   WHERE p.site_id = p_site_id AND p.status = 'COMPLETED' AND p.unit_price IS NULL
  HAVING count(*) > 0;

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

/** 계획심도 미달 검증 (사용자 확인 4). 미달 자체는 정상이다. 사유 없는 미달이 문제다. */
CREATE OR REPLACE FUNCTION core.fn_check_depth_shortfall(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  -- 미달이 많으면 계획 자체를 다시 봐야 한다. INFO 다 — 미달은 정상적으로 생긴다.
  RETURN QUERY
  SELECT 'DEPTH_SHORTFALL_SUMMARY', 'INFO', '계획심도 미달',
         format('계획심도까지 못 간 천공이 %s공 있습니다 (사유: %s).',
                count(*), string_agg(DISTINCT d.shortfall_reason, ', '))
    FROM core.daily_work_hole d
    JOIN core.daily_work w ON w.id = d.daily_work_id
   WHERE w.site_id = p_site_id AND NOT d.depth_same_as_plan
  HAVING count(*) > 0;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_depth_shortfall(uuid)
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
  UNION ALL SELECT * FROM core.fn_check_depth_shortfall(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;
