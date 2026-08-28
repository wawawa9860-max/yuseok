-- =====================================================================
-- 0025 PHASE 12 : 본사 대시보드
--   Master Prompt §39, §29, §43, §46, §52
--
--   §39 "현장별 한 줄 위주의 단순 화면으로 설계한다.
--        본사 담당자가 이상현장만 클릭해 상세정보를 확인하도록 한다."
--
--   한 줄에 들어가는 것: 현장명 · 금일 공수 · 누계 공수 · 공정률 · 레미콘 ·
--                        비용증빙 상태 · 기성 · 특이사항
--
--   §29 이 함수는 원가 '합계' 를 낸다. 본사 전용이다.
--   현장관리자·계약상대방에게 GRANT 하지 않는다.
-- =====================================================================

/**
 * 현장별 한 줄 (§39). 전 현장을 한 번에 돌려준다.
 * '이상' 판정도 여기서 한다 — 본사가 이상현장만 클릭하게 하려면
 * 무엇이 이상인지 시스템이 먼저 표시해야 한다.
 */
CREATE OR REPLACE FUNCTION core.fn_dashboard(p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_date date := COALESCE(p_date, CURRENT_DATE);
  v_rows jsonb;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '본사 대시보드는 본사만 볼 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT jsonb_agg(row_data ORDER BY row_data->>'site_name')
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
        'site_id', s.id,
        'site_code', s.site_code,
        'site_name', s.site_name,
        'status', s.status,

        -- 금일 / 누계 천공 공수
        'today_holes', COALESCE(t.today_holes, 0),
        'today_length', COALESCE(t.today_length, 0)::text,
        'total_holes', COALESCE(p.total_holes, 0),
        'completed_holes', COALESCE(p.completed_holes, 0),
        'progress_rate', COALESCE(p.progress_rate, 0)::text,
        'quantity_basis', p.quantity_basis,

        -- 금일 투입 공수 (출력일보)
        'today_man_days', COALESCE(m.man_days, 0)::text,

        -- 레미콘 (금일)
        'ready_mix_m3', r.quantity_m3::text,
        'ready_mix_delay', COALESCE(r.has_delay, false),

        -- 비용증빙 (이번달, 건수만 — 금액은 상세에서)
        'evidence', jsonb_build_object(
          'total', COALESCE(ev.total_count, 0),
          'verified', COALESCE(ev.verified_count, 0),
          'pending', COALESCE(ev.pending_count, 0)),

        -- 기성 (최근 회차)
        'payment', CASE WHEN pc.id IS NULL THEN NULL ELSE jsonb_build_object(
          'sequence_no', pc.sequence_no, 'status', pc.status,
          'amount', COALESCE(pc.submitted_amount, pc.draft_amount)::text) END,

        -- 특이사항 (열려 있는 것)
        'open_events', COALESCE(se.open_count, 0),
        'review_events', COALESCE(se.review_count, 0),

        -- '이상현장' 판정 근거. 본사는 이것이 붙은 현장만 클릭하면 된다.
        'flags', (
          SELECT COALESCE(jsonb_agg(f.flag), '[]'::jsonb) FROM (
            SELECT '검토필요 특이사항'::text AS flag
             WHERE COALESCE(se.review_count, 0) > 0
            UNION ALL SELECT '증빙대기 ' || ev.pending_count || '건'
             WHERE COALESCE(ev.pending_count, 0) > 0
            UNION ALL SELECT '레미콘 지연' WHERE COALESCE(r.has_delay, false)
            UNION ALL SELECT '금일 입력 없음'
             WHERE s.status = 'ACTIVE' AND t.today_holes IS NULL
               AND EXISTS (SELECT 1 FROM core.daily_work w2
                            WHERE w2.site_id = s.id)   -- 한 번이라도 쓰기 시작한 현장만
            UNION ALL SELECT '검증 ERROR'
             WHERE EXISTS (SELECT 1 FROM core.fn_validate_site(s.id) v
                            WHERE v.severity = 'ERROR')
          ) f)
      ) AS row_data
      FROM core.site s
      LEFT JOIN LATERAL (
        SELECT count(d.hole_id)::int AS today_holes,
               COALESCE(sum(COALESCE(d.actual_depth_total, h.design_depth_total)), 0) AS today_length
          FROM core.daily_work w
          JOIN core.daily_work_hole d ON d.daily_work_id = w.id
          JOIN core.hole_master h ON h.id = d.hole_id
         WHERE w.site_id = s.id AND w.work_date = v_date
         GROUP BY w.id) t ON true
      LEFT JOIN LATERAL (SELECT * FROM core.fn_site_progress(s.id, v_date)) p ON true
      LEFT JOIN LATERAL (
        SELECT sum(e.man_days) AS man_days FROM core.v_daily_labor_effective e
         WHERE e.site_id = s.id AND e.work_date = v_date) m ON true
      LEFT JOIN LATERAL (
        SELECT r2.quantity_m3, r2.has_delay
          FROM core.daily_ready_mix r2
          JOIN core.daily_work w2 ON w2.id = r2.daily_work_id
         WHERE w2.site_id = s.id AND w2.work_date = v_date LIMIT 1) r ON true
      LEFT JOIN LATERAL (
        SELECT * FROM private_cost.fn_evidence_rate(
          s.id, date_trunc('month', v_date)::date, v_date)) ev ON true
      LEFT JOIN LATERAL (
        SELECT * FROM core.payment_certificate pc2
         WHERE pc2.site_id = s.id ORDER BY pc2.sequence_no DESC LIMIT 1) pc ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE e2.status = 'OPEN')::int AS open_count,
               count(*) FILTER (WHERE e2.status = 'OPEN' AND e2.needs_review)::int AS review_count
          FROM core.special_event e2 WHERE e2.site_id = s.id) se ON true
    ) x;

  RETURN jsonb_build_object('as_of', v_date, 'sites', COALESCE(v_rows, '[]'::jsonb),
                            'generated_at', now());
END $$;
-- §29: 본사만. 현장관리자·외부에 GRANT 하지 않는다.
REVOKE ALL ON FUNCTION core.fn_dashboard(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.fn_dashboard(date) TO rfcip_head_office;

/**
 * 현장 상세 (이상현장 클릭 시). 본사 전용 — 여기서 처음으로 원가 합계가 나온다 (§29).
 */
CREATE OR REPLACE FUNCTION core.fn_dashboard_site(p_site_id uuid, p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = core, private_cost, app, pg_temp AS $$
DECLARE
  v_date date := COALESCE(p_date, CURRENT_DATE);
  v_from date := date_trunc('month', v_date)::date;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '본사 상세는 본사만 볼 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN jsonb_build_object(
    'as_of', v_date,
    'progress', core.fn_progress_full(p_site_id, v_date),
    'validation', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'code', v.code, 'severity', v.severity, 'target', v.target,
               'message', v.message) ORDER BY v.severity, v.code), '[]'::jsonb)
        FROM core.fn_validate_site_full(p_site_id) v),
    'events', core.fn_special_events(p_site_id, v_from, v_date),

    -- §29 원가 합계 — 본사 전용 함수라 여기서만 나온다
    'cost', jsonb_build_object(
      'month_from', v_from,
      'total', COALESCE((
        SELECT sum(c.amount)::text FROM private_cost.daily_cost c
         WHERE c.site_id = p_site_id AND c.cost_date BETWEEN v_from AND v_date), '0'),
      'by_type', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'cost_type', s.cost_type, 'name_ko', s.name_ko,
                 'amount', s.amt::text, 'count', s.n) ORDER BY s.sort_order)
          FROM (SELECT c.cost_type, t.name_ko, t.sort_order,
                       sum(c.amount) AS amt, count(*)::int AS n
                  FROM private_cost.daily_cost c
                  JOIN private_cost.cost_type t ON t.code = c.cost_type
                 WHERE c.site_id = p_site_id AND c.cost_date BETWEEN v_from AND v_date
                 GROUP BY c.cost_type, t.name_ko, t.sort_order) s), '[]'::jsonb),
      -- 기성(계약금액) 대비 원가 — 본사가 손익을 가늠하는 핵심 한 줄
      'earned_amount', (core.fn_progress_full(p_site_id, v_date)->'amount'->>'earned_amount')),
    'generated_at', now());
END $$;
REVOKE ALL ON FUNCTION core.fn_dashboard_site(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.fn_dashboard_site(uuid, date) TO rfcip_head_office;
