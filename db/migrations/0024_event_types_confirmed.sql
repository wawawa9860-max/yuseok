-- =====================================================================
-- 0024 특이사항 유형 확정 (사용자 확인 2026-08-28)
--
--   "소음 민원발생 / 진동 민원발생 / 레미콘 수급 지연 / 가설휀스 간섭 /
--    작업부지 미조성 / 검측지연 / 지반조건 상이 / 기타(입력)"
--
--   §31 예시 17종을 실제 현장 용어 8종으로 교체한다.
--   기타는 자유입력이다 — 내용 없이 '기타' 만 저장하는 것을 막는다.
--
--   음성메모는 쓰지 않는다 (사용자 확인: 회의는 회의록으로, 녹음은 따로 한다).
--   종결권한은 본사만 — 이미 그렇게 되어 있다 (0023).
-- =====================================================================

CREATE OR REPLACE FUNCTION core.fn_special_event_types()
RETURNS TABLE (event_type text, sort_order smallint)
LANGUAGE sql IMMUTABLE AS $$
  VALUES ('소음 민원발생', 1::smallint),
         ('진동 민원발생', 2::smallint),
         ('레미콘 수급 지연', 3::smallint),
         ('가설휀스 간섭', 4::smallint),
         ('작업부지 미조성', 5::smallint),
         ('검측지연', 6::smallint),
         ('지반조건 상이', 7::smallint),
         ('기타', 8::smallint)
$$;

-- '기타' 는 입력이 있어야 한다. 유형만 '기타' 로 남으면 나중에 아무도 설명 못 한다.
ALTER TABLE core.special_event
  ADD CONSTRAINT ck_se_etc_needs_memo CHECK (
    event_type <> '기타' OR memo IS NOT NULL OR title IS NOT NULL);
