-- =====================================================================
-- 0020 천공조서 형식 (Master Prompt §34, §35, §7, §11)
--
--   사용자 확인 (2026-08-27): "천공일지는 천공조서와 거의 동일하다고 보면 된다."
--
--   그래서 천공일지를 수량산출서의 천공조서와 같은 칸 구성으로 낸다.
--
--     천공조서 :  PILE NO │ 토사 공당·소계 │ 풍화암 공당·소계 │ … │ 합계
--     천공일지 :  같은 칸 + 실제심도 · 시공일 · 상태
--
--   지층 칸은 현장마다 다르다. 시스템이 '토사/풍화암/연암/경암' 을 박지 않는다 (§7).
--   그래서 지층 목록을 따로 돌려주고, 행에는 그 지층별 값을 담는다.
-- =====================================================================

/**
 * 현장의 천공조서. 계획(공당·소계)과 실적을 한 표에 담는다.
 *
 * 소계는 그 행의 공수를 곱한 값이다. 지금은 한 행이 한 공이라 공당과 같지만,
 * 조서 원본처럼 구간을 묶어 쓰는 경우를 위해 칸을 나눠 둔다.
 */
CREATE OR REPLACE FUNCTION core.fn_drilling_register(p_site_id uuid)
RETURNS TABLE (
  hole_no            text,
  sort_key           text,
  section            text,
  hole_type_code     text,
  hole_type_name     text,
  layers             jsonb,        -- [{ground_type_code, ground_type_name, per_hole, subtotal}]
  design_depth_total numeric,
  layer_sum          numeric,      -- 지층 합계. design_depth_total 과 같아야 한다.
  actual_depth_total numeric,
  depth_diff         numeric,
  status             text,
  construction_date  text,
  drawing_ref        text,
  -- 지반조건이 아직 배정되지 않은 공은 '합계가 다르다' 가 아니라 '아직 없다' 이다.
  has_ground_profile boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT h.hole_no, h.sort_key, h.section,
         ht.code, ht.name,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'ground_type_code', g.code,
                    'ground_type_name', g.name,
                    'per_hole', l.planned_length::text,
                    'subtotal', l.planned_length::text,
                    'planned_length', l.planned_length::text,
                    'from_depth', l.from_depth::text,
                    'to_depth', l.to_depth::text) ORDER BY g.sort_order, l.sequence)
             FROM core.ground_profile_layer l
             JOIN core.ground_type g ON g.id = l.ground_type_id
            WHERE l.ground_profile_id = h.ground_profile_id), '[]'::jsonb),
         h.design_depth_total,
         COALESCE((SELECT sum(l.planned_length) FROM core.ground_profile_layer l
                    WHERE l.ground_profile_id = h.ground_profile_id), 0),
         h.actual_depth_total,
         CASE WHEN h.actual_depth_total IS NOT NULL AND h.design_depth_total IS NOT NULL
              THEN h.actual_depth_total - h.design_depth_total END,
         h.status, h.construction_date::text, h.drawing_ref,
         (h.ground_profile_id IS NOT NULL)
    FROM core.hole_master h
    LEFT JOIN core.site_hole_type ht ON ht.id = h.hole_type_id
   WHERE h.site_id = p_site_id
   ORDER BY h.sort_key;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_drilling_register(uuid)
  TO rfcip_head_office, rfcip_field_manager;

/**
 * 천공조서 합계행 (조서 원본의 마지막 줄).
 *   지층별 소계 합계 + 총 합계 + 공수
 * 계획과 실적을 나란히 낸다.
 */
CREATE OR REPLACE FUNCTION core.fn_drilling_register_total(p_site_id uuid)
RETURNS TABLE (
  hole_type_code   text,
  hole_type_name   text,
  hole_count       integer,
  completed_count  integer,
  layers           jsonb,       -- [{ground_type_code, ground_type_name, planned_length}]
  planned_length   numeric,
  actual_length    numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
BEGIN
  IF NOT app.has_site_access(p_site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT t.code, t.name,
         count(h.id)::integer,
         count(h.id) FILTER (WHERE h.status = 'COMPLETED')::integer,
         COALESCE((
           SELECT jsonb_agg(x ORDER BY x->>'sort_order')
             FROM (SELECT jsonb_build_object(
                            'ground_type_code', g.code,
                            'ground_type_name', g.name,
                            'sort_order', g.sort_order,
                            'planned_length', sum(l.planned_length)::text) AS x
                     FROM core.hole_master h2
                     JOIN core.ground_profile_layer l ON l.ground_profile_id = h2.ground_profile_id
                     JOIN core.ground_type g ON g.id = l.ground_type_id
                    WHERE h2.site_id = p_site_id
                      AND h2.hole_type_id IS NOT DISTINCT FROM t.id
                    GROUP BY g.code, g.name, g.sort_order) s), '[]'::jsonb),
         COALESCE(sum(h.design_depth_total), 0),
         COALESCE(sum(h.actual_depth_total) FILTER (WHERE h.status = 'COMPLETED'), 0)
    FROM core.site_hole_type t
    LEFT JOIN core.hole_master h ON h.hole_type_id = t.id AND h.site_id = p_site_id
   WHERE t.site_id = p_site_id
   GROUP BY t.id, t.code, t.name, t.sort_order
   ORDER BY t.sort_order;
END $$;
GRANT EXECUTE ON FUNCTION core.fn_drilling_register_total(uuid)
  TO rfcip_head_office, rfcip_field_manager;

-- ---------------------------------------------------------------------
-- §34 천공일지를 조서 칸 구성에 맞춘다
--   기존 항목은 그대로 두고, 조서와 같은 '지층별 공당 + 합계' 를 얹는다.
--   지층합계와 계획심도가 어긋나면 그 사실을 함께 낸다 (조서 자체의 오류일 수 있다).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.fn_hole_log(p_hole_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = core, app, pg_temp AS $$
DECLARE
  h         core.hole_master%ROWTYPE;
  v_layers  jsonb;
  v_sum     numeric;
BEGIN
  SELECT * INTO h FROM core.hole_master WHERE id = p_hole_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT app.has_site_access(h.site_id) THEN
    RAISE EXCEPTION '해당 현장에 접근 권한이 없습니다.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'ground_type_code', g.code,
           'ground_type_name', g.name,
           'per_hole', l.planned_length::text,      -- 조서의 '공당'
           'subtotal', l.planned_length::text,      -- 조서의 '소계'
           'planned_length', l.planned_length::text,
           'from_depth', l.from_depth::text,
           'to_depth', l.to_depth::text) ORDER BY g.sort_order, l.sequence), '[]'::jsonb),
         COALESCE(sum(l.planned_length), 0)
    INTO v_layers, v_sum
    FROM core.ground_profile_layer l
    JOIN core.ground_type g ON g.id = l.ground_type_id
   WHERE l.ground_profile_id = h.ground_profile_id;

  RETURN jsonb_build_object(
    'hole_no', h.hole_no,
    'sort_key', h.sort_key,
    'section', h.section,
    'hole_type', (SELECT ht.name FROM core.site_hole_type ht WHERE ht.id = h.hole_type_id),
    'hole_type_code', (SELECT ht.code FROM core.site_hole_type ht WHERE ht.id = h.hole_type_id),

    -- 천공조서와 같은 칸 구성
    'layers', v_layers,
    'layer_sum', v_sum::text,
    'design_depth_total', h.design_depth_total::text,
    -- 지층합계 = 총 계획심도 여야 한다. 어긋나면 숨기지 않는다.
    'has_ground_profile', (h.ground_profile_id IS NOT NULL),
    -- 지반조건이 아직 없으면 비교할 대상이 없다. '어긋났다' 고 하지 않는다.
    'layer_sum_matches', (h.ground_profile_id IS NULL OR h.design_depth_total IS NULL
                          OR abs(v_sum - h.design_depth_total) < 0.001),

    -- 여기부터가 조서에 없는 '일지' 부분
    'actual_depth_total', h.actual_depth_total::text,
    'depth_diff', CASE WHEN h.actual_depth_total IS NOT NULL AND h.design_depth_total IS NOT NULL
                       THEN (h.actual_depth_total - h.design_depth_total)::text END,
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
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'revision', r.revision_no, 'revision_type', r.revision_type,
               'changed_at', r.created_at, 'effective_date', r.effective_date,
               'reason', r.reason, 'is_current', r.is_current) ORDER BY r.revision_no)
        FROM core.hole_revision r WHERE r.hole_id = p_hole_id), '[]'::jsonb),

    -- 이전 이름을 쓰던 화면이 있으므로 남겨 둔다
    'planned_layers', v_layers,
    'generated_at', now());
END $$;
GRANT EXECUTE ON FUNCTION core.fn_hole_log(uuid)
  TO rfcip_head_office, rfcip_field_manager;
