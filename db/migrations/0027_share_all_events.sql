-- =====================================================================
-- 0027 외부 공유에 특이사항 전 범위 포함 (사용자 확인 2026-08-29)
--
--   "외부로 나가는 특이사항 모든 범위는 같이 공유가 되어야 한다."
--
--   그날 등록된 특이사항 사건(8종 전부 — 민원 포함)이 외부 작업현황에 나간다.
--   일일입력 예외(공급지연·심도미달)에 더해서다.
--   원가는 여전히 한 글자도 나가지 않는다 (§41 절대 원칙 유지).
-- =====================================================================

CREATE OR REPLACE FUNCTION share.fn_daily_status_internal(p_site_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = share, core, app, pg_temp AS $$
DECLARE
  v_work core.daily_work%ROWTYPE;
  v_prog record;
BEGIN
  SELECT * INTO v_work FROM core.daily_work
   WHERE site_id = p_site_id AND work_date = p_date;

  SELECT count(*)::integer                                        AS total_holes,
         count(*) FILTER (WHERE h.status = 'COMPLETED')::integer  AS completed_holes,
         CASE WHEN COALESCE(sum(q.qty), 0) = 0 THEN 0::numeric(5,1)
              ELSE round(COALESCE(sum(q.qty) FILTER (WHERE h.status = 'COMPLETED'), 0)
                         / sum(q.qty) * 100, 1)::numeric(5,1) END AS progress_rate,
         CASE WHEN COALESCE(sum(h.contract_quantity), 0) > 0 THEN 'CONTRACT_QUANTITY'
              WHEN COALESCE(sum(h.design_depth_total), 0) > 0 THEN 'DESIGN_DEPTH'
              ELSE 'NONE' END                                     AS quantity_basis
    INTO v_prog
    FROM core.hole_master h
    CROSS JOIN LATERAL (SELECT COALESCE(h.contract_quantity, h.design_depth_total) AS qty) q
   WHERE h.site_id = p_site_id;

  RETURN jsonb_build_object(
    'report_date', p_date,
    'site', (SELECT jsonb_build_object('site_name', s.site_name, 'site_code', s.site_code)
               FROM core.site s WHERE s.id = p_site_id),
    'today', (
      SELECT jsonb_build_object(
        'hole_count', count(*)::int,
        'length', COALESCE(sum(COALESCE(d.actual_depth_total, h.design_depth_total)), 0)::text)
        FROM core.daily_work_hole d
        JOIN core.hole_master h ON h.id = d.hole_id
       WHERE d.daily_work_id = v_work.id),
    'today_hole_numbers', COALESCE((
      SELECT jsonb_agg(h.hole_no ORDER BY h.sort_key)
        FROM core.daily_work_hole d
        JOIN core.hole_master h ON h.id = d.hole_id
       WHERE d.daily_work_id = v_work.id), '[]'::jsonb),
    'cumulative', jsonb_build_object(
      'completed_holes', v_prog.completed_holes,
      'total_holes', v_prog.total_holes,
      'progress_rate', v_prog.progress_rate::text,
      'quantity_basis', v_prog.quantity_basis),
    'by_ground_type', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'ground_type_name', s.name, 'completed_length', s.done::text)
               ORDER BY s.sort_order)
        FROM (SELECT g.name, g.sort_order,
                     COALESCE(sum(l.planned_length)
                       FILTER (WHERE h.status = 'COMPLETED'), 0) AS done
                FROM core.hole_master h
                JOIN core.ground_profile_layer l ON l.ground_profile_id = h.ground_profile_id
                JOIN core.ground_type g ON g.id = l.ground_type_id
               WHERE h.site_id = p_site_id
               GROUP BY g.name, g.sort_order) s), '[]'::jsonb),
    'ready_mix', (
      SELECT jsonb_build_object(
        'quantity_m3', r.quantity_m3::text, 'has_delay', r.has_delay,
        'delay_minutes', r.delay_minutes, 'delay_reason', r.delay_reason)
        FROM core.daily_ready_mix r WHERE r.daily_work_id = v_work.id),

    -- 특이사항 전 범위 (사용자 확인 2026-08-29):
    --   일일입력 예외(공급지연·심도미달) + 그날 등록된 사건 8종 전부.
    --   원가는 여전히 0 이다.
    'notes', COALESCE((
      SELECT jsonb_agg(n.item ORDER BY n.ord) FROM (
        SELECT 1 AS ord, jsonb_build_object(
                 'type', '레미콘 공급지연',
                 'detail', r.delay_minutes || '분' ||
                           COALESCE(' · ' || r.delay_reason, '')) AS item
          FROM core.daily_ready_mix r
         WHERE r.daily_work_id = v_work.id AND r.has_delay
        UNION ALL
        SELECT 2, jsonb_build_object(
                 'type', '계획심도 미달',
                 'detail', h.hole_no || ' ' ||
                           trim(to_char(COALESCE(d.actual_depth_total, 0), 'FM9990.0')) || '/' ||
                           trim(to_char(COALESCE(h.design_depth_total, 0), 'FM9990.0')) || 'm · ' ||
                           COALESCE(d.shortfall_reason, ''))
          FROM core.daily_work_hole d
          JOIN core.hole_master h ON h.id = d.hole_id
         WHERE d.daily_work_id = v_work.id AND NOT d.depth_same_as_plan
        UNION ALL
        SELECT 3, jsonb_build_object(
                 'type', e.event_type,
                 'detail', COALESCE(e.title, e.memo, '') ||
                           COALESCE((SELECT ' · ' || string_agg(h.hole_no, ', ' ORDER BY h.sort_key)
                                       FROM core.special_event_hole eh
                                       JOIN core.hole_master h ON h.id = eh.hole_id
                                      WHERE eh.event_id = e.id), ''))
          FROM core.special_event e
         WHERE e.site_id = p_site_id AND e.event_date = p_date
      ) n), '[]'::jsonb),

    'next_day_plan', v_work.next_day_plan,
    'generated_at', now());
END $$;
REVOKE ALL ON FUNCTION share.fn_daily_status_internal(uuid, date) FROM PUBLIC;
