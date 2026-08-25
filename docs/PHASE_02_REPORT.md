# PHASE 2 완료 보고서 — SITE + CONTRACT + HOLE MASTER

> Master Prompt §49 PHASE 2, §50 보고 형식
> 작성일 2026-08-25

---

## 0. 비전문가용 한 줄 요약

PHASE 1이 금고를 만든 단계였다면, **PHASE 2는 그 금고에 현장을 등록하는 절차를 만든 단계**입니다.

현장 하나를 새로 열 때 필요한 순서 — 현장정보 → 계약 → 천공종류 → **천공번호 수백 개 생성** —
를 본사가 화면 몇 번으로 끝낼 수 있게 했습니다. 천공번호는 하나씩 치지 않고
**도면에 적힌 번호를 통째로 붙여넣거나, 범위를 지정해 한 번에** 만듭니다.
저장 전에 반드시 **미리보기**로 몇 개가 만들어지고 중복이 있는지 보여줍니다.

그리고 이번에 **업로드해주신 실제 수량산출서를 그대로 시스템에 넣어 검증**했습니다.
결과: 58공 전부, 지층별 수량 합계까지 **원본 문서와 소수점까지 일치**합니다.

---

## 1. 이번에 구현한 기능

### 1.1 지시사항 반영

| 지시 | 반영 결과 |
|---|---|
| 현장관리자에게 계약단가 공개 | `hole_master.contract_unit_price`, 계약내역·계약 revision 조회 개방. **내부원가(노무·장비 단가)는 그대로 차단** |
| 천공번호는 작업도면(PDF) 기준, 현장마다 다름 | 번호 형식 강제를 **완전히 제거**. 도면 원문을 그대로 저장하고 자연정렬 키로만 순서를 잡음 |
| 수량산출서 샘플 | 구조 분석 → [`docs/QUANTITY_SHEET_ANALYSIS.md`](QUANTITY_SHEET_ANALYSIS.md), 실제 데이터를 세 번째 테스트 현장으로 투입 |

### 1.2 현장 최초설정 STEP 1~5 (§17)

| STEP | API | 상태 |
|---|---|---|
| 1 현장 기본정보 | `POST /api/admin/sites`, `PATCH /api/admin/sites/:id` | ✅ |
| 2 계약정보 | `POST /api/sites/:id/contracts` (원계약 REV 0 자동 보존) | ✅ |
| 3 수량산출서 등록 | 문서 테이블 준비 완료, 업로드는 PHASE 4 | 구조만 |
| 4 작업도면 등록 | 문서 테이블 준비 완료, 연결은 PHASE 5 | 구조만 |
| 5 천공번호 생성/매핑 | `POST /api/admin/sites/:id/holes/preview` → `/bulk` | ✅ |

`GET /api/admin/sites/:id/setup-status` 가 **12단계 중 무엇이 끝났고 다음이 무엇인지** 코드로 판정합니다.
사람이 진행상황을 세지 않습니다.

### 1.3 천공번호 일괄생성 (§10, §19)

두 가지 입력방법. **형식을 강제하지 않습니다.**

```
LIST  — 도면에서 읽은 번호를 그대로 (권장)
        "1, 2, 3 ... 29"  또는  "1.1↵1.2↵1.3 ..."  붙여넣기
        줄바꿈·쉼표·탭·세미콜론 아무거나 구분자로 인식

RANGE — 규칙적인 현장을 위한 편의기능
        접두어 A-  +  1 ~ 30  +  자릿수 3  +  제외 [7]
        → A-001 … A-030 중 A-007 제외, 총 29공
```

**미리보기가 항상 먼저입니다.**

```
POST /holes/preview  →  { count: 29, first: 'A-001', last: 'A-030',
                          conflicts: [], can_save: true }
POST /holes/bulk     →  실제 저장 (충돌 1건이라도 있으면 전부 저장 안 함)
```

### 1.4 설계변경 Revision (§38)

- 천공번호 생성 시 **원계약 상태가 자동으로 REV 0**으로 보존됩니다.
- 계획값(계획심도·계약수량·계약단가·지반조건·계획레미콘)을 바꾸려면 **변경사유가 필수**입니다.
- 변경 시 **변경 "전" 값이 먼저 revision 으로 저장**된 뒤 수정됩니다.
- 계약도 동일: 원계약 금액은 절대 변하지 않고 `current_amount` 만 갱신, **원계약으로 되돌리기 가능**.

---

## 2. 생성/수정한 파일

### 신규
```
db/migrations/0009_hole_numbering_and_contract_visibility.sql
db/migrations/0010_phase2_functions.sql
db/seeds/sample_rfcip_holes.json        업로드된 천공조서에서 추출한 58공 원본값
server/src/domain/holeNumbering.ts      천공번호 생성·자연정렬 (순수 함수)
server/src/routes/admin-sites.ts        현장 최초설정 STEP 1~5
server/src/routes/admin-holes.ts        천공번호 미리보기/일괄생성/수정/Revision
server/src/routes/contracts.ts          계약 + Revision + 계약내역
server/tests/phase2.test.ts             PHASE 2 테스트 30건
docs/QUANTITY_SHEET_ANALYSIS.md         실제 수량산출서 구조 분석
docs/PHASE_02_REPORT.md                 본 문서
```

### 수정
```
server/src/routes/holes.ts   정렬·범위비교를 sort_key 기준으로 교체
server/src/db/seed.ts        SAMPLE_RFCIP_01 추가, 충돌 은폐 제거
server/src/app.ts            라우터 연결
server/tests/*.test.ts       계약단가 공개 반영, 어설션을 현장 단위로 축소
CLAUDE.md / README.md        불변규칙·진행상황 갱신
```

---

## 3. DB 변경사항

### 3.1 천공번호 정렬 체계 교체 ★

**PHASE 1의 가정이 실제 데이터로 반증되었습니다.**

| | PHASE 1 가정 | 실제 조서 |
|---|---|---|
| H-PILE 구간 | `A-001` | `1`, `2` … `29` |
| 무근 | — | `1.1`, `1.2` … `3.9` |

`hole_prefix` + `hole_index` 두 컬럼을 버리고 **자연정렬 키 하나**로 교체했습니다.

```sql
core.fn_natural_sort_key('1')      → '000000000001'
core.fn_natural_sort_key('1.1')    → '000000000001.000000000001'
core.fn_natural_sort_key('10')     → '000000000010'
core.fn_natural_sort_key('A-001')  → 'A-000000000001'
core.fn_natural_sort_key('C1-10')  → 'C000000000001-000000000010'
```

문자열 비교만으로 `1 < 1.1 < 1.2 < 2 < 10 < 29` 가 성립합니다.

> 단순 문자열 정렬이었다면 `1, 1.1 … 1.9, 10, 11, 12 …` 로 **10번이 2번보다 앞에** 왔을 것입니다.
> 실제 데이터로 확인한 차이입니다.

### 3.2 추가된 컬럼·테이블

```
core.hole_master
  + sort_key          자연정렬 키 (자동계산, 수정 불가)
  + drawing_sequence  작업도면 표기 순번 (현장별 고유, PHASE 5 도면 연결 기준)
  + drawing_ref       도면번호/좌표 등 참조정보
  − hole_prefix, hole_index  (삭제)

core.site_design_param   현장 설계 파라미터 (직경 / C.T.C / 할증률 …)
                         하드코딩하지 않고 수량산출서에서 확인된 값만 등록
```

### 3.3 추가된 결정론적 함수

| 함수 | 역할 |
|---|---|
| `core.fn_natural_sort_key(text)` | 번호 형식 무관 자연정렬 키 |
| `core.fn_snapshot_hole_revision()` | 변경 전 상태를 revision 으로 보존 (§38) |
| `core.fn_activate_contract_revision()` | 계약 revision 전환 (원계약 금액 불변) |
| `core.fn_site_setup_status()` | 최초설정 12단계 진행 판정 (§17) |
| `core.fn_check_hole_numbers()` | 저장 전 중복 검출 (§14) |

### 3.4 권한 변경 (사용자 지시)

```
+ GRANT SELECT (contract_unit_price) ON core.hole_master  TO rfcip_field_manager
+ GRANT SELECT ON core.contract_item, core.contract_revision TO rfcip_field_manager
  (RLS 로 배정 현장에만 한정)

변경 없음: private_cost.labor_rate / equipment_rate 는 여전히 GRANT 없음
변경 없음: rfcip_external 은 private_cost 스키마 USAGE 자체 없음
```

---

## 4. 화면 변경사항

**없습니다.** 모바일 화면은 PHASE 6부터입니다.

추가된 API (전부 서버 측):

| API | 용도 | 권한 |
|---|---|---|
| `POST /api/admin/sites` | 현장 생성 | 본사 |
| `PATCH /api/admin/sites/:id` | 현장 수정 | 본사 |
| `GET /api/admin/sites/:id/setup-status` | 최초설정 진행상황 | 본사 |
| `POST /api/admin/sites/:id/users` | 현장 담당자 배정 | 본사 |
| `POST /api/admin/sites/:id/hole-types` | 천공종류 등록 | 본사 |
| `POST /api/admin/sites/:id/design-params` | 설계 파라미터 등록 | 본사 |
| `POST /api/admin/sites/:id/holes/preview` | **천공번호 미리보기** | 본사 |
| `POST /api/admin/sites/:id/holes/bulk` | **천공번호 일괄생성** | 본사 |
| `PATCH /api/admin/holes/:id` | 천공번호 수정 (사유 필수) | 본사 |
| `GET /api/admin/holes/:id/revisions` | Revision 이력 | 본사 |
| `DELETE /api/admin/holes/:id` | 미시공만 삭제 가능 | 본사 |
| `GET /api/sites/:id/contracts` | 계약 + revision 목록 | 배정 현장 |
| `POST /api/sites/:id/contracts` | 계약 등록 | 본사 |
| `POST /api/contracts/:id/revisions` | 설계변경 등록 | 본사 |
| `POST /api/contracts/:id/revisions/:no/activate` | Revision 전환 | 본사 |
| `GET /api/contracts/:id/items` | 계약내역 | 배정 현장 |
| `POST /api/contracts/:id/items` | 계약내역 등록 | 본사 |

---

## 5. 계산 규칙

전부 결정론적입니다 (§46). 같은 입력 → 항상 같은 출력.

| 항목 | 규칙 | 위치 |
|---|---|---|
| 천공번호 생성 (RANGE) | `prefix + padStart(n, digits) + suffix`, 제외번호 차집합 | `holeNumbering.ts` |
| 자연정렬 키 | 숫자 구간을 12자리 0채움, 나머지는 원문 유지 | TS + SQL **양쪽 동일** (테스트로 강제) |
| 계약내역 금액 | `round(quantity × unit_price, 2)` | DB 생성컬럼 |
| 계약 현재금액 | 활성 revision 의 `contract_amount` | `fn_activate_contract_revision` |
| 최초설정 완료판정 | 각 STEP 조건을 SQL 로 판정 (예: 지반조건 = 전체 공수) | `fn_site_setup_status` |

금액·수량은 API 에서도 **문자열로 주고받습니다.** 부동소수점 오차를 만들지 않습니다.

---

## 6. 권한 규칙

PHASE 1의 3중 방어(API 미들웨어 → DB 역할 GRANT → RLS)는 그대로입니다.
이번에 바뀐 것은 **계약단가의 공개범위 하나뿐**입니다.

| 데이터 | 본사 | 현장관리자 | 계약상대방 |
|---|---|---|---|
| 계약단가 (`contract_unit_price`) | ✅ | ✅ **(이번에 개방)** | ❌ |
| 계약내역 / 계약 revision | ✅ | ✅ **(이번에 개방)** | ❌ |
| 노무단가 / 장비단가 | ✅ | ❌ GRANT 없음 | ❌ 스키마 접속 불가 |
| 일일원가 / 영수증 | ✅ | 본인 입력분만 | ❌ 스키마 접속 불가 |
| 현장 생성·수정 | ✅ | ❌ | ❌ |
| 천공번호 생성·삭제 | ✅ | ❌ | ❌ |
| 천공 시공실적 입력 | ✅ | ✅ (4개 컬럼만) | ❌ |

**계약단가와 내부원가는 성격이 다릅니다.** 계약단가는 계약상대방과도 공유되는 값이고,
§29가 금지한 것은 노무비·장비비·유류비 등 **내부원가**입니다. 이 구분이 테스트로 고정되어 있습니다.

---

## 7. 자동 테스트 결과

```
Test Files  4 passed (4)
Tests      67 passed (67)      ← PHASE 1 대비 +32
Duration   5.1s
```

| 파일 | 건수 | 내용 |
|---|---|---|
| `phase2.test.ts` | **30** | 천공번호 생성, 자연정렬, 실제 조서 교차검증, STEP 1~5, Revision |
| `security.test.ts` | 17 | 권한 3중방어 + 계약단가 공개 검증 |
| `ground.test.ts` | 11 | 지반조건 검증 |
| `api.test.ts` | 9 | 인증, 범위조회, 자동검증 |

### 실제 업로드 문서와의 교차검증 ★

시스템에 넣은 값과 **원본 수량산출서**를 대조한 결과입니다.

| 항목 | 산출근거 시트 | 시스템 | 결과 |
|---|---|---|---|
| 토사 총연장 | 876.12 m | 876.120 m | ✅ |
| 풍화암 총연장 | 147.30 m | 147.300 m | ✅ |
| H-PILE 구간 | 29공 / 511.71 m | 29공 / 511.710 m | ✅ |
| 무근 | 29공 / 511.71 m | 29공 / 511.710 m | ✅ |
| 지층합계 = 계획심도 | — | 58공 전부 만족 | ✅ |
| 자동검증 ERROR | — | 0건 | ✅ |

### 이번에 실제로 잡은 버그 3건

**① 무근 번호가 2공 조용히 사라짐** — 가장 위험했던 버그
Excel이 무근 연번 `2.0`, `3.0` 을 정수 `2`, `3` 으로 저장하는 바람에
H-PILE `2`번·`3`번과 천공번호가 충돌했고, 시드의 `ON CONFLICT DO NOTHING` 이
이를 **오류 없이 삼켜서** 29공이어야 할 무근이 27공만 들어갔습니다.

- 원인: 조서의 무근 열은 `1.1 ~ 3.9` 소수 연번인데 Excel 이 `2.0` 을 `2` 로 저장
- 조치 ①: 추출 시 소수 1자리로 정규화 → `2.0`, `3.0` (연번 체계 유지, 충돌 해소)
- 조치 ②: **시드에서 `ON CONFLICT DO NOTHING` 제거.** §14는 중복번호를 "차단 또는 본사 확인"
  하라고 요구하는데, 조용히 누락시키는 것은 그 어느 쪽도 아닙니다.

**② `fn_site_setup_status` 실행 실패**
PL/pgSQL 의 `RETURNS TABLE (… name text …)` 출력변수 `name` 이
`core.ground_type.name` 컬럼과 이름이 겹쳐 `column reference "name" is ambiguous` 오류.
출력변수를 `step_name` 으로 바꾸고 모든 내부 쿼리에 테이블 별칭을 붙였습니다.

**③ 마이그레이션 실행 실패**
계산컬럼 교체 시 의존 VIEW 를 먼저 제거하지 않아 `cannot drop column` 오류. 순서를 바로잡았습니다.

> ①은 테스트가 아니라 **실제 문서와 대조**했기 때문에 발견됐습니다.
> 합계가 876.12여야 하는데 845.92가 나온 것이 단서였습니다.

### 테스트 현장 3곳

| 현장 | 출처 | 지층 | 천공번호 | 공수 |
|---|---|---|---|---|
| TEST_SITE_01 | Master Prompt §51 | 토사/풍화암 | `A-001`~`A-030` | 30 |
| TEST_SITE_02 | Master Prompt §51 | 토사/풍화암/연암 | `B-001`~`B-020` | 20 |
| **SAMPLE_RFCIP_01** | **업로드된 실제 수량산출서** | 토사/풍화암 | `1`~`29`, `1.1`~`3.9` | **58** |

세 현장의 지층 개수도, 번호 체계도 전부 다르지만 **같은 코드로 동작합니다.**

---

## 8. 사람이 직접 확인해야 할 사항

> 아래 1~3번은 **업로드해주신 수량산출서를 읽으면서 생긴 질문**입니다. 답을 주시면 PHASE 4가 정확해집니다.

1. **[중요] 무근 번호 `2.0` / `3.0` 표기가 맞습니까?**
   조서에는 `2`, `3` 으로 인쇄되어 있으나 앞뒤가 `1.9`, `2.1` 인 소수 연번이므로
   `2.0`, `3.0` 으로 정규화했습니다. 그렇지 않다면 H-PILE `2`번과 구분할 방법을 알려주십시오.
   (현재 시스템은 한 현장 안에서 천공번호 중복을 §14에 따라 차단합니다.)

2. **[중요] 천공조서가 29공인데 설계 총공수는 638.30공입니다.**
   대표 구간만 발췌한 조서입니까, 아니면 이것이 전부입니까?
   전체 조서라면 나머지 609공의 지반조건 산정 방식을 알려주셔야 합니다.

3. **연암·경암 열은 항상 인쇄되는 양식입니까?**
   이번 현장은 두 열 모두 0이어서 지층종류로 등록하지 않았습니다.
   PHASE 4 가져오기에서 "값이 0인 지층은 제외" 규칙을 그대로 쓸지 확인이 필요합니다.

4. **계획 레미콘 산출식.** 산출근거 기준 `(3.14 × 직경²)/4 × 연장 × (1 + 할증 2%)`
   = **0.2826 ㎥/m** (직경 0.6m). PHASE 1 시드의 0.196은 폐기했습니다.
   할증률 2%가 모든 현장 공통입니까?

5. **`1차 천공(무근)` / `2차 천공(절삭공)` 과 천공종류 매핑.**
   현재 `무근` / `H-PILE 구간` 으로 등록했습니다. 실제 명칭이 다르면 알려주십시오.

6. **작업도면(PDF) 파일을 주실 수 있습니까?** PHASE 5의 도면-번호 연결에 필요합니다.
   `drawing_sequence` / `drawing_ref` 컬럼은 이미 준비되어 있습니다.

7. **계약단가 공개 범위.** 지시대로 열었습니다. 계약내역(품목별 단가)까지 열었는데,
   품목 단가는 가려야 한다면 알려주십시오.

---

## 9. 발견된 위험

| # | 위험 | 심각도 | 현재 대응 | 남은 조치 |
|---|---|---|---|---|
| R1 | 프론트엔드 부재로 "3분 이내 입력" 미검증 | 높음 | — | PHASE 6 최우선 |
| R2 | 천공조서 29공 vs 설계 638공 불일치 | **높음** | 원본값 그대로 보존 | **8-2번 답변 필요** |
| R9 | Excel 숫자셀이 표기를 잃는다 (`2.0`→`2`) | **높음** | 소수 정규화 + 충돌 차단 | PHASE 4 가져오기에서 **셀 서식까지 읽어** 원문 복원 |
| R10 | 무근/H-PILE 번호가 도면상 실제로 중복이면 현재 모델이 거부한다 | 중간 | §14 대로 차단 | 8-1번 답변에 따라 `(천공종류, 번호)` 복합키 검토 |
| R2' | 수량산출서 Excel 구조는 회사마다 다름 | 높음 | 샘플 1건 분석 완료 | 다른 현장 샘플 1~2건 더 있으면 정확도 상승 |
| R3 | DB 접속계정 유출 시 SET ROLE 로 권한 획득 | 중간 | `NOINHERIT` | 운영 시 Secret Manager, IP 제한 |
| R4 | `SECURITY DEFINER` 함수는 RLS 우회 | 중간 | 함수 내부 `has_site_access` 재확인 | 신규 함수마다 동일 패턴 필수 |
| R11 | 계약단가 공개로 현장 단말 분실 시 노출면 증가 | 낮음 | 배정 현장으로 RLS 한정 | 운영 시 화면 잠금 정책 |
| R5 | `audit.change_log` 무한 증가 | 낮음 | — | 6개월 후 파티셔닝 |
| R8 | 계약상대방 링크 유출 | 중간 | 토큰·만료·회수 필드 준비 | PHASE 13 |

**원가 노출 위험은 여전히 0건입니다.** 계약단가 개방 후에도 `share` 격리 테스트와
`private_cost` 차단 테스트가 모두 통과합니다.

---

## 10. 다음 Phase 실행 명령

```
PHASE 3 실행.
GROUND_TYPE + GROUND_PROFILE + 천공번호 범위별 지반조건 일괄설정을 구현하라.

포함:
- 현장별 지층종류 CRUD (본사)
- 지반조건 생성/확정/개정(Revision) API
- 천공번호 범위 지정 → 지반조건 일괄 적용 (§10)
- 수량산출서 총연장 → 공당 환산 시 미리보기 + 사용자 확인 (§11)
- 공별로 값이 다른 경우 원본값 그대로 적용 지원 (§11 후단)
- 자동 테스트 및 PHASE 3 보고서
```

### 참고: PHASE 3의 기반은 이미 완성되어 있습니다

- 지반조건 조합+깊이 구조, 두 입력모드, 합계검증 → PHASE 1
- 자연정렬 키 기반 범위선택 → PHASE 2
- 공별 상이값 지원 (SAMPLE_RFCIP_01 이 27종 지반조건으로 실증) → PHASE 2

PHASE 3은 **API 와 미리보기 UX** 를 붙이는 작업이 중심입니다.

### 이후 순서 (§49)

```
PHASE 4  수량산출서 ↔ HOLE_MASTER 연결   ← 8번 1·2·3번 답변이 필요
PHASE 5  작업도면 ↔ 천공번호 연결        ← 작업도면 PDF 필요
PHASE 6  모바일 오늘 작업입력            ← 성공기준(3분) 최초 검증
```
