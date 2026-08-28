-- =====================================================================
-- 0023 PHASE 11 : SPECIAL_EVENT (특이사항)
--   Master Prompt §31(통합), §32(천공번호 연결), §26(장비대기 연결), §38, §43
--
--   §31 "별도의 복잡한 안전/품질/민원 ERP를 만들지 않는다.
--        RF CIP 업무와 직접 관계되는 SPECIAL_EVENT 하나로 통합한다."
--
--   §1-7 "한 번 입력한 데이터를 모든 문서가 재사용한다" 가 여기서도 기준이다.
--   레미콘 지연·장비 대기·계획심도 미달·지반 특이사항은 일일입력에서 이미 받았다.
--   그것을 SPECIAL_EVENT 로 다시 입력시키지 않는다. 모아서 보여줄 뿐이다.
--   이 테이블은 '그 외의 일' — 사진·메모가 필요한 독립 사건을 담는다.
-- =====================================================================

-- §31 유형 선택지. 시스템이 강제하지 않도록 한곳에 모아 둔다.
CREATE OR REPLACE FUNCTION core.fn_special_event_types()
RETURNS TABLE (event_type text, sort_order smallint)
LANGUAGE sql IMMUTABLE AS $$
  VALUES ('레미콘 지연', 1::smallint), ('장비대기', 2::smallint), ('장비고장', 3::smallint),
         ('작업부지 미조성', 4::smallint), ('검측지연', 5::smallint), ('지반조건 변화', 6::smallint),
         ('지하수', 7::smallint), ('슬라임', 8::smallint), ('H-BEAM', 9::smallint),
         ('가이드월', 10::smallint), ('우천', 11::smallint), ('유류', 12::smallint),
         ('추가천공', 13::smallint), ('추가작업', 14::smallint), ('작업구간 변경', 15::smallint),
         ('원도급 지시', 16::smallint), ('기타', 17::smallint)
$$;
GRANT EXECUTE ON FUNCTION core.fn_special_event_types() TO PUBLIC;

CREATE TABLE core.special_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES core.site(id) ON DELETE CASCADE,
  -- §32 예: EV-2026-0048. 현장·연도별 순번.
  event_no      text NOT NULL,
  event_date    date NOT NULL,
  event_type    text NOT NULL,
  title         text,
  memo          text,
  -- §32 "변경/정산 검토: YES" — 설계변경이나 정산으로 이어질 수 있는 사건 표시
  needs_review  boolean NOT NULL DEFAULT false,
  review_note   text,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_by     uuid REFERENCES core.app_user(id),
  closed_at     timestamptz,
  created_by    uuid REFERENCES core.app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, event_no)
);
COMMENT ON TABLE core.special_event IS
  '§31 특이사항. 안전/품질/민원 ERP 를 따로 만들지 않고 이것 하나로 통합한다. '
  '일일입력이 이미 받은 예외(레미콘 지연·장비대기·심도미달·지반)는 재입력하지 않는다.';
CREATE INDEX ix_special_event_site ON core.special_event(site_id, event_date DESC);

CREATE TRIGGER trg_se_touch BEFORE UPDATE ON core.special_event
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER trg_se_audit AFTER INSERT OR UPDATE OR DELETE ON core.special_event
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

-- §32 관련 천공번호
CREATE TABLE core.special_event_hole (
  event_id uuid NOT NULL REFERENCES core.special_event(id) ON DELETE CASCADE,
  hole_id  uuid NOT NULL REFERENCES core.hole_master(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, hole_id)
);

-- §31 사진 / 음성메모 / 텍스트 연결. 파일 실체는 core.stored_file 에 있다.
CREATE TABLE core.special_event_file (
  event_id  uuid NOT NULL REFERENCES core.special_event(id) ON DELETE CASCADE,
  file_id   uuid NOT NULL REFERENCES core.stored_file(id),
  PRIMARY KEY (event_id, file_id)
);

/** §32 이벤트 번호 채번: EV-<연도>-<현장별 4자리 순번> */
CREATE OR REPLACE FUNCTION core.fn_next_event_no(p_site_id uuid, p_date date)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  v_year text := to_char(p_date, 'YYYY');
  v_seq  integer;
BEGIN
  -- 동시에 두 사건을 등록해도 번호가 겹치지 않게 현장 단위로 잠근다
  PERFORM pg_advisory_xact_lock(hashtextextended('event_no:' || p_site_id::text, 0));
  SELECT COALESCE(max(substring(event_no from 'EV-' || v_year || '-(\d+)')::integer), 0) + 1
    INTO v_seq
    FROM core.special_event
   WHERE site_id = p_site_id AND event_no LIKE 'EV-' || v_year || '-%';
  RETURN format('EV-%s-%s', v_year, lpad(v_seq::text, 4, '0'));
END $$;
GRANT EXECUTE ON FUNCTION core.fn_next_event_no(uuid, date)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- RLS : 현장은 자기 현장 사건을 만들고 본다. 종결은 본사만.
-- ---------------------------------------------------------------------
ALTER TABLE core.special_event      ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.special_event_hole ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.special_event_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.special_event      FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.special_event_hole FORCE  ROW LEVEL SECURITY;
ALTER TABLE core.special_event_file FORCE  ROW LEVEL SECURITY;

CREATE POLICY p_se_site ON core.special_event FOR SELECT USING (app.has_site_access(site_id));
CREATE POLICY p_se_ins  ON core.special_event FOR INSERT WITH CHECK (app.has_site_access(site_id));
CREATE POLICY p_se_upd  ON core.special_event FOR UPDATE
  USING (app.has_site_access(site_id) AND (app.is_head_office() OR status = 'OPEN'))
  WITH CHECK (app.has_site_access(site_id));
CREATE POLICY p_se_ho   ON core.special_event FOR ALL
  USING (app.is_head_office()) WITH CHECK (app.is_head_office());

CREATE POLICY p_seh_site ON core.special_event_hole FOR ALL
  USING (EXISTS (SELECT 1 FROM core.special_event e
                  WHERE e.id = event_id AND app.has_site_access(e.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.special_event e
                       WHERE e.id = event_id AND app.has_site_access(e.site_id)));
CREATE POLICY p_sef_site ON core.special_event_file FOR ALL
  USING (EXISTS (SELECT 1 FROM core.special_event e
                  WHERE e.id = event_id AND app.has_site_access(e.site_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM core.special_event e
                       WHERE e.id = event_id AND app.has_site_access(e.site_id)));

GRANT SELECT, INSERT, UPDATE ON core.special_event TO rfcip_field_manager;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.special_event TO rfcip_head_office;
GRANT SELECT, INSERT, DELETE ON core.special_event_hole, core.special_event_file
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §31 통합 조회 : 수동 사건 + 일일입력이 이미 받아 둔 예외
--   같은 일을 두 번 입력시키지 않는다 (§1-2). 모아서 보여줄 뿐이다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_special_events(p_site_id uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN jsonb_build_object(
    -- 등록된 사건 (사진·메모 포함)
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', e.id, 'event_no', e.event_no, 'event_date', e.event_date,
               'event_type', e.event_type, 'title', e.title, 'memo', e.memo,
               'needs_review', e.needs_review, 'review_note', e.review_note,
               'status', e.status,
               'hole_numbers', COALESCE((
                 SELECT jsonb_agg(h.hole_no ORDER BY h.sort_key)
                   FROM core.special_event_hole eh
                   JOIN core.hole_master h ON h.id = eh.hole_id
                  WHERE eh.event_id = e.id), '[]'::jsonb),
               'files', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'file_id', f.id, 'category', f.category,
                          'original_name', f.original_name))
                   FROM core.special_event_file ef
                   JOIN core.stored_file f ON f.id = ef.file_id
                  WHERE ef.event_id = e.id AND f.deleted_at IS NULL), '[]'::jsonb))
               ORDER BY e.event_date DESC, e.event_no DESC)
        FROM core.special_event e
       WHERE e.site_id = p_site_id AND e.event_date BETWEEN p_from AND p_to), '[]'::jsonb),

    -- 일일입력이 이미 받아 둔 예외 (재입력 금지 §1-2 — 여기서는 모아 보여주기만 한다)
    'from_daily_input', jsonb_build_object(
      'ready_mix_delay', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'work_date', w.work_date, 'delay_minutes', r.delay_minutes,
                 'delay_reason', r.delay_reason) ORDER BY w.work_date DESC)
          FROM core.daily_ready_mix r
          JOIN core.daily_work w ON w.id = r.daily_work_id
         WHERE w.site_id = p_site_id AND w.work_date BETWEEN p_from AND p_to
           AND r.has_delay), '[]'::jsonb),
      'equipment_idle', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'work_date', e.work_date, 'equipment_name', e.equipment_name,
                 'operating_days', e.operating_days::text, 'idle_reason', e.idle_reason)
                 ORDER BY e.work_date DESC)
          FROM core.v_equipment_log e
         WHERE e.site_id = p_site_id AND e.work_date BETWEEN p_from AND p_to
           AND e.operating_days < 1), '[]'::jsonb),
      'depth_shortfall', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'work_date', w.work_date, 'hole_no', h.hole_no,
                 'design_depth', h.design_depth_total::text,
                 'actual_depth', d.actual_depth_total::text,
                 'reason', d.shortfall_reason) ORDER BY w.work_date DESC, h.sort_key)
          FROM core.daily_work_hole d
          JOIN core.daily_work w ON w.id = d.daily_work_id
          JOIN core.hole_master h ON h.id = d.hole_id
         WHERE w.site_id = p_site_id AND w.work_date BETWEEN p_from AND p_to
           AND NOT d.depth_same_as_plan), '[]'::jsonb),
      'ground_notes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'work_date', w.work_date, 'note_type', n.note_type, 'memo', n.memo,
                 'hole_numbers', COALESCE((
                   SELECT jsonb_agg(h.hole_no ORDER BY h.sort_key)
                     FROM core.daily_ground_note_hole nh
                     JOIN core.hole_master h ON h.id = nh.hole_id
                    WHERE nh.note_id = n.id), '[]'::jsonb)) ORDER BY w.work_date DESC)
          FROM core.daily_ground_note n
          JOIN core.daily_work w ON w.id = n.daily_work_id
         WHERE w.site_id = p_site_id AND w.work_date BETWEEN p_from AND p_to), '[]'::jsonb)),
    'generated_at', now());
END $$;
GRANT EXECUTE ON FUNCTION core.fn_special_events(uuid, date, date)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §33 작업일보의 특이사항 칸에 SPECIAL_EVENT 를 합류시킨다
--   PHASE 9 에서 자리만 만들어 둔 곳이다. 지반 특이사항 + 등록 사건을 함께 낸다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_daily_report_events(p_site_id uuid, p_date date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.ord), '[]'::jsonb)
    FROM (
      SELECT 1 AS ord, jsonb_build_object(
               'source', 'GROUND_NOTE', 'note_type', n.note_type, 'memo', n.memo,
               'hole_numbers', COALESCE((
                 SELECT jsonb_agg(h.hole_no ORDER BY h.sort_key)
                   FROM core.daily_ground_note_hole nh
                   JOIN core.hole_master h ON h.id = nh.hole_id
                  WHERE nh.note_id = n.id), '[]'::jsonb)) AS item
        FROM core.daily_ground_note n
        JOIN core.daily_work w ON w.id = n.daily_work_id
       WHERE w.site_id = p_site_id AND w.work_date = p_date
      UNION ALL
      SELECT 2, jsonb_build_object(
               'source', 'EVENT', 'event_no', e.event_no, 'note_type', e.event_type,
               'memo', COALESCE(e.title, e.memo), 'needs_review', e.needs_review,
               'hole_numbers', COALESCE((
                 SELECT jsonb_agg(h.hole_no ORDER BY h.sort_key)
                   FROM core.special_event_hole eh
                   JOIN core.hole_master h ON h.id = eh.hole_id
                  WHERE eh.event_id = e.id), '[]'::jsonb))
        FROM core.special_event e
       WHERE e.site_id = p_site_id AND e.event_date = p_date
    ) x
$$;
GRANT EXECUTE ON FUNCTION core.fn_daily_report_events(uuid, date)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §43 검증 : 검토 필요 사건이 열려 있으면 본사에 알린다
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_check_special_events(p_site_id uuid)
RETURNS TABLE (code text, severity text, target text, message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;
  IF NOT app.is_head_office() THEN RETURN; END IF;

  RETURN QUERY
  SELECT 'EVENT_NEEDS_REVIEW', 'WARN', e.event_no,
         format('%s (%s) — 변경/정산 검토가 필요한 사건이 %s일째 열려 있습니다.',
                e.event_type, e.event_date, (CURRENT_DATE - e.event_date))
    FROM core.special_event e
   WHERE e.site_id = p_site_id AND e.status = 'OPEN' AND e.needs_review;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_check_special_events(uuid)
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
  UNION ALL SELECT * FROM core.fn_check_special_events(p_site_id)
$$;
GRANT EXECUTE ON FUNCTION core.fn_validate_site_full(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- fn_daily_report 의 특이사항 칸을 합류 함수로 교체한다.
-- 함수 전체를 다시 쓰지 않고 특이사항 부분만 바꾼 버전을 둔다 (0019 참조).
-- ※ fn_daily_report 본문이 길어 여기서는 특이사항 소스만 교체한 전체를 재생성한다.

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

    -- 특이사항 = 지반 특이사항 + SPECIAL_EVENT (§31 통합, PHASE 11)
    'special_notes', core.fn_daily_report_events(p_site_id, p_date),

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
