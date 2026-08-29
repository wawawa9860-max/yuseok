-- =====================================================================
-- 0026 PHASE 13 : 공유 분리 — 계약상대방용 작업현황
--   Master Prompt §41, §42, §29, §38, §46
--
--   §41 "계약상대방용에는 절대로 원가를 포함하지 않는다.
--        계약상대방 상세링크에서도 PRIVATE_COST 데이터에 접근할 수 없어야 한다."
--
--   이 파일의 함수는 전부 share/core 만 본다. private_cost 라는 글자가
--   함수 본문에 나오기만 해도 자동 테스트가 깨진다.
--
--   외부 열람은 '승인된 토큰' 으로만 한다 (core.external_share, PHASE 1).
--   본사가 발급하고, 만료·회수할 수 있다. 링크는 §42 대로 상세보기용이며
--   원본 자료는 시스템에 남는다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §41 계약상대방용 작업현황
--   들어가는 것: 금일 공수/연장 · 누계 · 공정률 · 금일 천공번호(+제외) ·
--                레미콘(+지연) · 특이사항(공급지연·심도미달) · 익일계획
--   안 들어가는 것: 원가 전부, 인원·장비·공수(투입), 민원 등 내부 사건,
--                   비용·증빙, 단가·금액.
-- ---------------------------------------------------------------------
/**
 * 내부 구현. 권한 검사가 없으므로 절대 밖에 GRANT 하지 않는다.
 * 진입로는 둘뿐이다:
 *   fn_daily_status      — 내부 사용자 (현장 배정 검사)
 *   fn_report_by_token   — 외부 (승인된 토큰 검사)
 */
CREATE OR REPLACE FUNCTION share.fn_daily_status_internal(p_site_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = share, core, app, pg_temp AS $$
DECLARE
  v_work core.daily_work%ROWTYPE;
  v_prog record;
BEGIN

  SELECT * INTO v_work FROM core.daily_work
   WHERE site_id = p_site_id AND work_date = p_date;

  -- fn_site_progress 는 내부에서 현장 접근검사를 다시 하므로 외부 토큰 경로에서 쓸 수 없다.
  -- 같은 규칙(§36)으로 여기서 직접 센다.
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

    -- 금일
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

    -- 누계 · 공정률 (기준을 숨기지 않는다)
    'cumulative', jsonb_build_object(
      'completed_holes', v_prog.completed_holes,
      'total_holes', v_prog.total_holes,
      'progress_rate', v_prog.progress_rate::text,
      'quantity_basis', v_prog.quantity_basis),

    -- 지층별 계획 실적 (§40 형식 — 계획 지층 기준)
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

    -- §41 특이사항: 계약상대방과 직접 관계된 사실만.
    --   공급지연과 계획심도 미달. 내부 사건(민원 등)은 넣지 않는다.
    'notes', COALESCE((
      SELECT jsonb_agg(n.item) FROM (
        SELECT jsonb_build_object(
                 'type', '레미콘 공급지연',
                 'detail', r.delay_minutes || '분' ||
                           COALESCE(' · ' || r.delay_reason, '')) AS item
          FROM core.daily_ready_mix r
         WHERE r.daily_work_id = v_work.id AND r.has_delay
        UNION ALL
        SELECT jsonb_build_object(
                 'type', '계획심도 미달',
                 'detail', h.hole_no || ' ' ||
                           trim(to_char(COALESCE(d.actual_depth_total, 0), 'FM9990.0')) || '/' ||
                           trim(to_char(COALESCE(h.design_depth_total, 0), 'FM9990.0')) || 'm · ' ||
                           COALESCE(d.shortfall_reason, ''))
          FROM core.daily_work_hole d
          JOIN core.hole_master h ON h.id = d.hole_id
         WHERE d.daily_work_id = v_work.id AND NOT d.depth_same_as_plan
      ) n), '[]'::jsonb),

    'next_day_plan', v_work.next_day_plan,
    'generated_at', now());
END $$;
-- 내부 구현은 아무에게도 GRANT 하지 않는다
REVOKE ALL ON FUNCTION share.fn_daily_status_internal(uuid, date) FROM PUBLIC;

/** 내부 사용자용 입구 — 현장 배정을 검사한다. */
CREATE OR REPLACE FUNCTION share.fn_daily_status(p_site_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = share, core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN share.fn_daily_status_internal(p_site_id, p_date);
END $$;
REVOKE ALL ON FUNCTION share.fn_daily_status(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION share.fn_daily_status(uuid, date)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- 토큰 발급 (본사 승인 §29) / 토큰 열람 (외부)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_issue_share(
  p_site_id uuid, p_report_date date, p_valid_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE v_token text;
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '외부 공유 발급은 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_valid_days < 1 OR p_valid_days > 90 THEN
    RAISE EXCEPTION '유효기간은 1~90일입니다.' USING ERRCODE='invalid_parameter_value';
  END IF;

  -- 토큰은 추측 불가능해야 한다. 128비트 난수.
  -- search_path 에 public 이 없으므로 pgcrypto 함수는 스키마를 명시한다
  v_token := encode(public.gen_random_bytes(16), 'hex');
  INSERT INTO core.external_share
    (site_id, share_token, report_date, approved_by, approved_at, expires_at)
  VALUES (p_site_id, v_token, p_report_date, app.current_user_id(), now(),
          now() + make_interval(days => p_valid_days));

  RETURN jsonb_build_object('share_token', v_token, 'report_date', p_report_date,
                            'expires_in_days', p_valid_days);
END $$;
REVOKE ALL ON FUNCTION core.fn_issue_share(uuid, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.fn_issue_share(uuid, date, integer) TO rfcip_head_office;

/** 회수. 링크가 이미 퍼졌어도 이 순간부터 열리지 않는다. */
CREATE OR REPLACE FUNCTION core.fn_revoke_share(p_token text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.is_head_office() THEN
    RAISE EXCEPTION '외부 공유 회수는 본사만 할 수 있습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  UPDATE core.external_share SET revoked_at = now()
   WHERE share_token = p_token AND revoked_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION core.fn_revoke_share(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.fn_revoke_share(text) TO rfcip_head_office;

/**
 * §41 상세보기 링크의 실체. 토큰만으로 열람한다 — 로그인이 없다.
 * 유효한 토큰이 아니면 무엇이 문제인지조차 말하지 않는다 (있는지 없는지도 비밀).
 */
CREATE OR REPLACE FUNCTION share.fn_report_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = share, core, app, pg_temp AS $$
DECLARE v core.external_share%ROWTYPE;
BEGIN
  SELECT * INTO v FROM core.external_share
   WHERE share_token = p_token
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now());
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN share.fn_daily_status_internal(v.site_id, COALESCE(v.report_date, CURRENT_DATE));
END $$;
GRANT EXECUTE ON FUNCTION share.fn_report_by_token(text)
  TO rfcip_external, rfcip_head_office, rfcip_field_manager;
