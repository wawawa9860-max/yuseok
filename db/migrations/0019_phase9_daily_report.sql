-- =====================================================================
-- 0019 PHASE 9 : 작업일보 / 천공일지 자동생성
--   Master Prompt §33(작업일보), §34(천공일지), §35(3자 일치), §38, §43, §46
--
--   §33 "현장관리자가 별도로 작성하지 않는다."
--   이 단계는 새로 묻는 것이 하나도 없다. 이미 받아 둔 값을 문서로 만든다 (§1-7).
--
--   §29 작업일보·천공일지에는 금액이 없다. 함수 자체가 private_cost 를 보지 않는다.
--   자동 테스트가 pg_depend 로 이것을 강제한다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §33 작업일보
--   포함: 일자·현장·작업구간·작업내용·금일 천공번호·금일 공수·누계 공수·
--         금일 천공연장·지층별 계획 천공연장·레미콘·인원·장비·특이사항·익일계획
--
--   '공수' 는 두 가지 뜻으로 쓰인다. 둘 다 필요해서 이름을 나눈다.
--     hole_count = 천공 공수 (몇 공을 뚫었나)  ← §33 의 '금일 공수'
--     man_days   = 투입 공수 (사람이 며칠치 나왔나) ← §25 출력일보
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_daily_report(p_site_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_work    core.daily_work%ROWTYPE;
  v_site    core.site%ROWTYPE;
  v_result  jsonb;
  v_holes   jsonb;
  v_sections text;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT * INTO v_site FROM core.site WHERE id = p_site_id;
  SELECT * INTO v_work FROM core.daily_work
   WHERE site_id = p_site_id AND work_date = p_date;

  -- 금일 천공번호는 도면 순서(sort_key)로 낸다. 문자열 정렬이 아니다 (§10).
  SELECT jsonb_agg(x ORDER BY x->>'sort_key'), string_agg(DISTINCT x->>'section', ', ')
    INTO v_holes, v_sections
    FROM (
      SELECT jsonb_build_object(
               'hole_no', h.hole_no, 'sort_key', h.sort_key, 'section', h.section,
               'hole_type', ht.name,
               'design_depth_total', h.design_depth_total::text,
               'actual_depth_total', COALESCE(d.actual_depth_total, h.design_depth_total)::text,
               'depth_same_as_plan', d.depth_same_as_plan) AS x
        FROM core.daily_work_hole d
        JOIN core.hole_master h ON h.id = d.hole_id
        LEFT JOIN core.site_hole_type ht ON ht.id = h.hole_type_id
       WHERE d.daily_work_id = v_work.id
    ) t;

  v_result := jsonb_build_object(
    'work_date', p_date,
    'site', jsonb_build_object('site_code', v_site.site_code, 'site_name', v_site.site_name,
                               'client_name', v_site.client_name, 'location', v_site.location),
    'status', COALESCE(v_work.status, 'NONE'),
    'submitted_at', v_work.submitted_at,

    -- 작업구간 · 작업내용
    'sections', v_sections,
    'work_summary', COALESCE(v_work.memo,
      CASE WHEN v_holes IS NULL THEN '작업 없음'
           ELSE 'RF CIP 천공 ' || jsonb_array_length(v_holes) || '공' END),

    'hole_numbers', COALESCE(v_holes, '[]'::jsonb),

    -- 금일 / 누계 천공 공수와 연장
    'today', (
      SELECT jsonb_build_object(
        'hole_count', count(*)::int,
        'length', COALESCE(sum(COALESCE(d.actual_depth_total, h.design_depth_total)), 0)::text)
        FROM core.daily_work_hole d
        JOIN core.hole_master h ON h.id = d.hole_id
       WHERE d.daily_work_id = v_work.id),
    'cumulative', (
      SELECT jsonb_build_object(
        'hole_count', count(*)::int,
        'length', COALESCE(sum(COALESCE(h.actual_depth_total, h.design_depth_total)), 0)::text,
        'total_hole_count', (SELECT count(*)::int FROM core.hole_master m WHERE m.site_id = p_site_id))
        FROM core.hole_master h
       WHERE h.site_id = p_site_id AND h.status = 'COMPLETED'
         AND h.construction_date <= p_date),

    -- 지층별 계획 천공연장 (금일분)
    'layer_summary', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ground_type_name', g.name, 'planned_length', s.len::text) ORDER BY g.sort_order)
        FROM (SELECT l.ground_type_id, sum(l.planned_length) AS len
                FROM core.daily_work_hole d
                JOIN core.hole_master h ON h.id = d.hole_id
                JOIN core.ground_profile_layer l ON l.ground_profile_id = h.ground_profile_id
               WHERE d.daily_work_id = v_work.id
               GROUP BY l.ground_type_id) s
        JOIN core.ground_type g ON g.id = s.ground_type_id), '[]'::jsonb),

    'ready_mix', (
      SELECT jsonb_build_object('quantity_m3', r.quantity_m3::text, 'has_delay', r.has_delay,
                                'delay_minutes', r.delay_minutes, 'delay_reason', r.delay_reason)
        FROM core.daily_ready_mix r WHERE r.daily_work_id = v_work.id),

    -- 인원 · 장비는 출력일보 · 장비가동일보를 그대로 쓴다 (§25, §26)
    'labor', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'role_name', e.role_name, 'headcount', e.headcount::text,
               'work_days', e.work_days::text, 'man_days', e.man_days::text,
               'absence_reason', e.absence_reason) ORDER BY e.sort_order, e.role_name)
        FROM core.v_daily_labor_effective e WHERE e.daily_work_id = v_work.id), '[]'::jsonb),
    'today_man_days', COALESCE((
      SELECT sum(e.man_days)::text FROM core.v_daily_labor_effective e
       WHERE e.daily_work_id = v_work.id), '0'),
    'cumulative_man_days', COALESCE((
      SELECT sum(e.man_days)::text FROM core.v_daily_labor_effective e
       WHERE e.site_id = p_site_id AND e.work_date <= p_date), '0'),

    'equipment', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'equipment_name', e.equipment_name, 'quantity', e.quantity::text,
               'operating_days', e.operating_days::text, 'unit_days', e.unit_days::text,
               'idle_reason', e.idle_reason) ORDER BY e.sort_order, e.equipment_name)
        FROM core.v_daily_equipment_effective e WHERE e.daily_work_id = v_work.id), '[]'::jsonb),

    -- 특이사항. PHASE 11 SPECIAL_EVENT 가 여기에 합류한다.
    'special_notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'note_type', n.note_type, 'memo', n.memo,
               'hole_numbers', COALESCE((
                 SELECT jsonb_agg(h.hole_no ORDER BY h.sort_key)
                   FROM core.daily_ground_note_hole nh
                   JOIN core.hole_master h ON h.id = nh.hole_id
                  WHERE nh.note_id = n.id), '[]'::jsonb)))
        FROM core.daily_ground_note n WHERE n.daily_work_id = v_work.id), '[]'::jsonb),

    'next_day_plan', v_work.next_day_plan,
    -- 익일계획을 안 적었으면 다음 미시공 번호를 제안한다. 확정이 아니라 제안이다 (§11).
    'next_day_suggestion', COALESCE((
      SELECT jsonb_agg(h.hole_no ORDER BY h.sort_key)
        FROM (SELECT m.hole_no, m.sort_key FROM core.hole_master m
               WHERE m.site_id = p_site_id AND m.status = 'NOT_STARTED'
               ORDER BY m.sort_key LIMIT 10) h), '[]'::jsonb),

    'generated_at', now()
  );
  RETURN v_result;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_daily_report(uuid, date)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §34 천공일지 (Hole 별)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_hole_log(p_hole_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  h core.hole_master%ROWTYPE;
BEGIN
  SELECT * INTO h FROM core.hole_master WHERE id = p_hole_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT app.has_site_access(h.site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN jsonb_build_object(
    'hole_no', h.hole_no,
    'section', h.section,
    'hole_type', (SELECT ht.name FROM core.site_hole_type ht WHERE ht.id = h.hole_type_id),
    'design_depth_total', h.design_depth_total::text,
    'actual_depth_total', h.actual_depth_total::text,
    -- 계획과 실제가 다르면 그 차이를 숨기지 않는다
    'depth_diff', CASE WHEN h.actual_depth_total IS NOT NULL AND h.design_depth_total IS NOT NULL
                       THEN (h.actual_depth_total - h.design_depth_total)::text END,
    'planned_layers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ground_type_name', g.name,
               'from_depth', l.from_depth::text, 'to_depth', l.to_depth::text,
               'planned_length', l.planned_length::text) ORDER BY l.sequence)
        FROM core.ground_profile_layer l
        JOIN core.ground_type g ON g.id = l.ground_type_id
       WHERE l.ground_profile_id = h.ground_profile_id), '[]'::jsonb),
    'status', h.status,
    'construction_date', h.construction_date,
    'ready_mix', (
      SELECT jsonb_build_object('work_date', w.work_date, 'quantity_m3', r.quantity_m3::text)
        FROM core.daily_work_hole d
        JOIN core.daily_work w ON w.id = d.daily_work_id
        JOIN core.daily_ready_mix r ON r.daily_work_id = w.id
       WHERE d.hole_id = p_hole_id LIMIT 1),
    'special_notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('work_date', w.work_date,
                                          'note_type', n.note_type, 'memo', n.memo))
        FROM core.daily_ground_note_hole nh
        JOIN core.daily_ground_note n ON n.id = nh.note_id
        JOIN core.daily_work w ON w.id = n.daily_work_id
       WHERE nh.hole_id = p_hole_id), '[]'::jsonb),
    'drawing', jsonb_build_object('drawing_ref', h.drawing_ref,
                                  'drawing_sequence', h.drawing_sequence),
    'revision', h.current_revision,
    -- §38 값이 바뀐 이력을 그대로 보여준다
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'revision', r.revision_no, 'revision_type', r.revision_type,
               'changed_at', r.created_at, 'effective_date', r.effective_date,
               'reason', r.reason, 'is_current', r.is_current) ORDER BY r.revision_no)
        FROM core.hole_revision r WHERE r.hole_id = p_hole_id), '[]'::jsonb),
    'generated_at', now());
END $$;
GRANT EXECUTE ON FUNCTION core.fn_hole_log(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §35 작업도면 완료 = 천공일지 완료 = 수량산출 실적
--   세 가지가 항상 일치해야 한다. 파생값으로 비교하면 의미가 없으므로
--   서로 다른 경로로 센 값을 맞춰 본다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_progress_consistency(p_site_id uuid)
RETURNS TABLE (source text, hole_count integer, length numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN QUERY
  -- 1) 작업도면 : 도면 진행상태에서 '완료' 로 보이는 것
  SELECT '작업도면'::text, count(*)::integer,
         COALESCE(sum(COALESCE(v.actual_depth_total, v.design_depth_total)), 0)
    FROM core.v_drawing_progress v
   WHERE v.site_id = p_site_id AND v.display_status IN ('금일완료', '기존완료');

  RETURN QUERY
  -- 2) 천공일지 : 일일작업에 실제로 찍힌 것
  SELECT '천공일지'::text, count(DISTINCT d.hole_id)::integer,
         COALESCE(sum(COALESCE(d.actual_depth_total, h.design_depth_total)), 0)
    FROM core.daily_work_hole d
    JOIN core.daily_work w ON w.id = d.daily_work_id
    JOIN core.hole_master h ON h.id = d.hole_id
   WHERE w.site_id = p_site_id;

  RETURN QUERY
  -- 3) 수량산출 실적 : HOLE_MASTER 의 상태
  SELECT '수량산출실적'::text, count(*)::integer,
         COALESCE(sum(COALESCE(h.actual_depth_total, h.design_depth_total)), 0)
    FROM core.hole_master h
   WHERE h.site_id = p_site_id AND h.status = 'COMPLETED';
END $$;
GRANT EXECUTE ON FUNCTION core.fn_progress_consistency(uuid)
  TO rfcip_head_office, rfcip_field_manager;

/** §35 세 값이 어긋나면 알린다. 어긋나는 것 자체가 사고다. */
CREATE OR REPLACE FUNCTION core.fn_check_progress_consistency(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_min integer; v_max integer;
  v_len_min numeric; v_len_max numeric;
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT min(c.hole_count), max(c.hole_count), min(c.length), max(c.length)
    INTO v_min, v_max, v_len_min, v_len_max
    FROM core.fn_progress_consistency(p_site_id) c;

  IF v_max IS NULL OR v_max = 0 THEN RETURN; END IF;

  IF v_min <> v_max THEN
    RETURN QUERY SELECT 'PROGRESS_MISMATCH', 'ERROR', '작업도면/천공일지/수량산출',
      format('완료 공수가 서로 다릅니다 (%s ~ %s공). 셋은 항상 같아야 합니다.', v_min, v_max);
  END IF;

  IF v_len_max - v_len_min > 0.001 THEN
    RETURN QUERY SELECT 'PROGRESS_LENGTH_MISMATCH', 'ERROR', '작업도면/천공일지/수량산출',
      format('완료 연장이 서로 다릅니다 (%s ~ %s m).',
             to_char(v_len_min, 'FM9999990.000'), to_char(v_len_max, 'FM9999990.000'));
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_progress_consistency(uuid)
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
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;
