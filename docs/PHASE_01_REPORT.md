# PHASE 1 완료 보고서 — 프로젝트 구조 / DB / 권한

> Master Prompt §49 PHASE 1, §50 보고 형식, §53 개발 시작 지시에 따름.
> 작성일 2026-08-25

---

## 0. 비전문가용 한 줄 요약

**아직 화면은 없습니다.** 이번 단계는 건물로 치면 *기초와 철골, 그리고 잠금장치*를 만든 것입니다.
현장 데이터를 담을 **금고(데이터베이스)** 를 만들고, **누가 어느 서랍을 열 수 있는지**를
프로그램이 아니라 금고 자체에 새겨 넣었습니다. 그리고 실제 회사 데이터 없이도 시험할 수 있도록
가상의 현장 2곳을 만들어 넣고, 35가지 항목을 자동으로 점검해 전부 통과시켰습니다.

가장 중요한 결과 두 가지:

1. **계약상대방은 우리 원가를 볼 수 없습니다.** 화면에서 가린 게 아니라, 데이터베이스가
   그 사람의 접속 자체를 거부합니다. 프로그램에 버그가 생겨도 뚫리지 않습니다.
2. **현장마다 지층 조합이 달라도 같은 시스템이 돌아갑니다.** '토사+풍화암' 현장과
   '토사+풍화암+연암' 현장을 동시에 넣고 시험해서 확인했습니다.

---

## 1. 이번에 구현한 기능

| Master Prompt §53 PHASE 1 항목 | 구현 내용 |
|---|---|
| 1. DB schema | 5개 스키마 계층 (`core` / `private_cost` / `share` / `audit` / `app`), 20개 테이블 |
| 2. 사용자 역할 | `HEAD_OFFICE` / `FIELD_MANAGER` / `EXTERNAL` — 앱 역할 + **DB 역할** 이중화 |
| 3. HEAD_OFFICE_ONLY 원가 권한 | `private_cost` 스키마 분리 + 스키마/테이블/컬럼 GRANT + RLS 3중 차단 |
| 4. SITE_MASTER | `core.site` + 현장별 천공종류 `core.site_hole_type` + 사용자↔현장 배정 |
| 5. CONTRACT_MASTER | `core.contract` + `contract_revision`(REV 0/1/2…) + `contract_item` |
| 6. HOLE_MASTER 기본구조 | `core.hole_master` — §5 명시 필드 전부 + 범위선택용 정렬키 |
| 7. GROUND_TYPE | `core.ground_type` — **현장별 사용자 정의**, 하드코딩 0건 (테스트로 강제) |
| 8. GROUND_PROFILE | `core.ground_profile` + `ground_profile_layer` — 조합+깊이 구조, 2가지 입력모드 |
| 9. Revision 구조 | 계약/천공/문서 각각의 revision + 전 테이블 공통 변경이력 `audit.change_log` |
| 10. 파일 Storage 구조 | `core.stored_file`(벤더 비종속) + `core.document`/`document_revision` |

추가로 함께 만든 것:

- 결정론적 검증 함수 `core.fn_validate_site()`, `core.fn_validate_ground_profile()` (§43)
- 지층별 계획수량 자동집계 VIEW `core.v_hole_layer_plan` (§20)
- 도면 표시상태 파생 VIEW `core.v_hole_status` (§13)
- 외부 공유 전용 `share` 스키마 + **원가 의존성 0건 자동검증** (§29)
- 접근차단 로그 `audit.access_denied_log` (§43 마지막 항목)
- 테스트 현장 2곳 시드 (§51)

---

## 2. 생성/수정한 파일

### 기준 문서
```
docs/MASTER_PROMPT.md          업로드된 Master Prompt 원문 (최상위 기준으로 고정)
CLAUDE.md                      절대원칙 + 코드 불변규칙 + Phase 순서
README.md                      실행 방법
docs/PHASE_01_REPORT.md        본 문서
```

### DB (스키마·권한·검증의 단일 원천)
```
db/migrations/0001_foundation.sql            스키마 5개, DB역할 3개, 세션컨텍스트, 변경이력
db/migrations/0002_users_and_sites.sql       사용자, SITE_MASTER, 현장배정, 천공종류, 로그인함수
db/migrations/0003_contract_master.sql       계약, 계약 revision, 계약내역
db/migrations/0004_ground.sql                GROUND_TYPE / PROFILE / LAYER + 검증 트리거
db/migrations/0005_hole_master.sql           HOLE_MASTER, hole revision, 파생 VIEW 2개
db/migrations/0006_files_and_documents.sql   파일 저장소, 문서 revision
db/migrations/0007_private_cost.sql          본사전용 원가 (6개 항목 고정, 증빙상태)
db/migrations/0008_share_and_validation.sql  share 스키마, 격리검증, 자동검증, 차단로그
```

### 서버
```
server/package.json / tsconfig.json / vitest.config.ts / .env.example
server/src/config/env.ts        환경변수 검증 (zod)
server/src/db/pool.ts           ★ 요청마다 DB 역할을 강등하는 접속 래퍼
server/src/db/migrate.ts        마이그레이션 러너 (+ 앱 계정 생성)
server/src/db/seed.ts           테스트 현장 2곳 (§51)
server/src/auth/password.ts     bcrypt
server/src/auth/token.ts        JWT 발급/검증
server/src/http/errors.ts       오류 타입
server/src/http/context.ts      인증·역할 미들웨어 + 차단로그
server/src/routes/auth.ts       로그인 / 내 정보
server/src/routes/sites.ts      현장 / 지층종류 / 지반조건 / 자동검증
server/src/routes/holes.ts      천공번호 범위조회 / 지층별 자동집계
server/src/app.ts, index.ts     앱 구성, 기동
server/tests/*.test.ts          자동 테스트 35건
```

---

## 3. DB 변경사항

### 스키마 계층 (권한 경계를 스키마로 물리적으로 나눔)

| 스키마 | 용도 | 본사 | 현장관리자 | 계약상대방 |
|---|---|---|---|---|
| `core` | 현장·계약·천공·지반·문서 | ✅ | ✅ (제한) | ❌ |
| `private_cost` | **본사전용 원가** | ✅ | 입력만 | **접속 자체 불가** |
| `share` | 외부 공유 VIEW | ✅ | ✅ | ✅ (읽기) |
| `audit` | 변경이력·차단로그 | 읽기 | ❌ | ❌ |
| `app` | 권한 헬퍼 함수 | ✅ | ✅ | ✅ |

### 주요 테이블

```
core.app_user / user_site_access        사용자, 현장 배정
core.site / site_hole_type              SITE_MASTER, 현장별 천공종류
core.contract / contract_revision / contract_item
core.ground_type                        현장별 지층종류  ← 하드코딩 없음
core.ground_profile / ground_profile_layer   지반조건 = 조합 + 깊이
core.hole_master / hole_revision        ★ 모든 문서의 단일 기준
core.stored_file / document / document_revision
core.external_share                     외부 공유 승인 단위
private_cost.cost_type(C01~C06 고정) / daily_cost / cost_evidence
private_cost.labor_rate / equipment_rate     ← 현장관리자 GRANT 없음
audit.change_log                        전 테이블 변경 전·후 이미지 (수정·삭제 불가)
audit.access_denied_log                 권한거부 기록
```

### HOLE_MASTER 가 단일 기준인 이유

Master Prompt §4 대로 **수량산출서와 작업도면을 별도 원장으로 만들지 않았습니다.**
둘 다 `core.hole_master` 를 다르게 보여주는 VIEW 입니다. 따라서 구조적으로
`작업도면 완료 = 천공일지 완료 = 수량산출 실적` 이 어긋날 수 없습니다 (§35).

또한 `금일완료 / 기존완료` 같은 표시상태는 **저장하지 않고 계산**합니다
(`construction_date = 오늘` 인지로 판정). 같은 사실을 두 곳에 저장하지 않기 위함입니다 (§1-7).

### 범위 일괄설정 준비

`hole_no` 에서 접두어와 번호를 자동으로 분리하는 계산 컬럼을 넣었습니다.

```
'A-001' → hole_prefix='A-', hole_index=1
'A-030' → hole_prefix='A-', hole_index=30
```

덕분에 `A-031 ~ A-044` 같은 범위 선택(§19)과 범위 일괄설정(§10)이
문자열 비교가 아니라 숫자 비교로 정확하게 동작합니다. **PHASE 3에서 쓸 기반입니다.**

---

## 4. 화면 변경사항

**없습니다.** PHASE 1은 서버·DB 단계입니다. 모바일 화면은 PHASE 6부터 만듭니다.

대신 화면이 사용할 API 를 먼저 열어 두었습니다.

| API | 용도 | 접근 |
|---|---|---|
| `POST /api/auth/login` | 로그인 | 전체 |
| `GET /api/auth/me` | 내 정보 + 접근 가능 현장 | 로그인 사용자 |
| `GET /api/sites` | 현장 목록 | 배정된 현장만 |
| `GET /api/sites/:id` | 현장 상세 + 오늘/누계 공수 | 배정된 현장만 |
| `GET /api/sites/:id/ground-types` | 현장 지층종류 | 배정된 현장만 |
| `GET /api/sites/:id/ground-profiles` | 지반조건 + 지층별 깊이 | 배정된 현장만 |
| `GET /api/sites/:id/holes?from=&to=` | 천공번호 범위 조회 | 배정된 현장만 |
| `GET /api/sites/:id/layer-summary?from=&to=` | **지층별 계획수량 자동집계** | 배정된 현장만 |
| `GET /api/sites/:id/validation` | 자동 오류검출 | **본사 전용** |

---

## 5. 계산 규칙

Master Prompt §46 대로 **모든 계산은 SQL/코드에서 결정론적으로** 수행합니다. AI 계산 없음.

| 항목 | 계산식 | 위치 |
|---|---|---|
| 지층별 계획수량 | `Σ ground_profile_layer.planned_length` (해당 천공번호 집합) | `core.v_hole_layer_plan` |
| 지반조건 총연장 | `Σ planned_length` | `core.fn_profile_layer_sum()` |
| 계약내역 금액 | `round(quantity × unit_price, 2)` | `contract_item.amount` (DB 생성컬럼) |
| 표시상태 | `construction_date = CURRENT_DATE → 금일완료, 그 외 완료 → 기존완료` | `core.v_hole_status` |
| 천공번호 정렬 | `(hole_prefix, hole_index)` 튜플 비교 | `hole_master` 생성컬럼 |

소수 처리: 깊이/연장은 `numeric(8,3)` (밀리미터 단위), 금액은 `numeric(18,2)`.
**부동소수점(float)을 쓰지 않습니다.** 서버도 숫자를 문자열로 받아 오차를 만들지 않습니다.
검증 허용오차는 1mm(`0.001`) 로 고정했습니다.

**아직 계산하지 않는 것** (해당 Phase에서 구현): 공정률, 기성가능액, 노무비/장비비, 누계원가.

---

## 6. 권한 규칙

### 3중 방어 구조

```
1차  API 미들웨어      requireAuth / requireRole      ← 편의상의 방어
2차  DB 역할 GRANT     SET LOCAL ROLE 로 요청마다 강등  ← 스키마·테이블·컬럼 단위
3차  Row Level Security  현장 배정 / 작성자 기준        ← 행 단위
```

핵심은 **애플리케이션이 DB에 붙는 계정(`rfcip_app`) 자체가 아무 권한도 없다**는 점입니다
(`NOINHERIT`). 요청마다 인증된 사용자의 역할로 강등한 뒤에야 데이터에 접근합니다.
서버 코드에 SQL 인젝션이나 로직 버그가 생겨도 **DB가 최종적으로 막습니다.**

### 역할별 실제 권한

| 대상 | HEAD_OFFICE | FIELD_MANAGER | EXTERNAL |
|---|---|---|---|
| 현장 목록 | 전체 | **배정된 현장만** | 배정된 현장만 |
| 천공번호 | 전체 | 배정 현장 | share 뷰만 |
| `hole_master.contract_unit_price` | ✅ | **컬럼 GRANT 없음** | ❌ |
| 계약 revision / 계약내역 단가 | ✅ | ❌ | ❌ |
| `private_cost.daily_cost` | 전체 | **본인 입력분만** | **스키마 접속 불가** |
| `private_cost.labor_rate` / `equipment_rate` | ✅ | **GRANT 없음** | 접속 불가 |
| 영수증 파일 | ✅ | 본인 업로드분 | **행 자체가 안 보임** |
| 자동검증 결과 | ✅ | ❌ (§43: 본사가 우선 확인) | ❌ |
| 변경이력 | 읽기 | ❌ | ❌ |

### 원가 노출 0건을 보장하는 방법 (§29)

Master Prompt는 *"외부 보고서 생성 서버 함수는 PRIVATE_COST 관련 테이블을 조회하지 않도록
설계한다"* 고 요구합니다. 이를 **사람의 주의력에 맡기지 않고 자동 검사로** 만들었습니다.

`app.fn_share_isolation_violations()` 가 PostgreSQL 내부 의존성 그래프를 직접 조회해
`share` 스키마의 어떤 객체라도 `private_cost` 를 참조하면 즉시 검출합니다.
자동 테스트가 이 결과가 **0건**임을 강제합니다. 앞으로 누군가 실수로 외부 공유 뷰에
원가를 연결하면 **테스트가 깨져서 배포되지 않습니다.**

추가로 `share` 스키마 컬럼명에 `price/amount/cost/rate/margin/profit/단가/원가` 가
하나라도 있으면 테스트가 실패합니다.

---

## 7. 자동 테스트 결과

```
Test Files  3 passed (3)
Tests      35 passed (35)
Duration   3.6s
```

| 파일 | 건수 | 검증 내용 |
|---|---|---|
| `tests/security.test.ts` | 15 | 역할분리, 원가 3중차단, share 격리, 컬럼차단, 변경이력 불변, 앱계정 무권한 |
| `tests/ground.test.ts` | 11 | 지층 하드코딩 0건, 현장별 상이조합, 합계검증, 깊이연속성, 두 입력모드, 확정데이터 보존, 중복번호 차단, 집계 결정론 |
| `tests/api.test.ts` | 9 | 로그인, 401/403, 범위조회, 지층 자동집계, 자동검증, 표시상태 파생 |

### 특히 중요한 통과 항목

- ✅ 계약상대방 역할로 `private_cost` 조회 시도 → **DB가 `42501 permission denied` 로 거부**
- ✅ 현장관리자가 `contract_unit_price` 조회 시도 → **컬럼 권한 없음으로 거부**
- ✅ 현장관리자가 타 현장 천공번호 조회 → **RLS가 0건 반환**
- ✅ 지층합계 17m ≠ 총심도 20m → **확정 차단, 한국어 오류메시지**
- ✅ 마이그레이션 SQL에 '토사/풍화암/연암' 하드코딩 → **0건**
- ✅ `share` 스키마 → `private_cost` 의존 → **0건**
- ✅ 동일 입력 2회 집계 → **완전히 동일한 결과** (결정론, §46)

### 이번에 실제로 잡은 버그

검증 메시지에 `%.3f` 같은 C 언어식 서식을 썼는데 PostgreSQL의 `format()` 은 이를 지원하지
않아 **오류 메시지 자체가 깨지는** 문제가 있었습니다. 테스트가 이를 잡아냈고
`to_char()` 로 교체했습니다. 지금은 이렇게 출력됩니다.

```
ERROR  DESIGN_DEPTH_MISMATCH  A-025  천공번호 A-025 : 계획심도 21.500m ≠ 지반조건 총심도 20.000m
WARN   ACTUAL_DEPTH_DEVIATION A-026  천공번호 A-026 : 실제심도 22.200m, 계획심도 20.000m (차이 +2.200m)
```

### 테스트 현장 (§51)

| 현장 | 지층조합 | 천공번호 | 지반조건 | 검증 |
|---|---|---|---|---|
| TEST_SITE_01 | 토사 / 풍화암 (2종) | A-001~A-030 | 12.0 + 8.0 = **20.0m** | ✅ |
| TEST_SITE_02 | 토사 / 풍화암 / 연암 (3종) | B-001~B-020 | 10.0 + 7.0 + 4.0 = **21.0m** | ✅ |

지층 개수가 다른 두 현장이 **같은 코드로** 동작함을 확인했습니다.

---

## 8. 사람이 직접 확인해야 할 사항

> AI가 확정하면 안 되는 항목입니다 (§45). **반드시 검토해 주십시오.**

1. **[중요] 테스트 시드의 계약수량·단가는 전부 가짜입니다.**
   `TEST_UNIT_PRICE = 45,000원/m`, `계획 레미콘 0.196㎥/m(D500 이론값)` 은 제가 만든
   테스트용 가정값입니다. **실제 계약 데이터가 아닙니다.** 실제 현장 등록 시에는
   승인된 수량산출서 값만 사용됩니다 (§11). 시드는 `TEST_SITE_` 접두어로 구분됩니다.

2. **현장별 천공종류 목록을 확정해 주십시오.**
   §5 예시(Primary/Secondary/무근/H-BEAM/Post Pile/기타) 중 실제로 쓰는 것이 무엇인지.
   시드에는 Primary/Secondary 2종만 넣었습니다. 하드코딩이 아니므로 언제든 추가 가능합니다.

3. **지층종류 코드 체계** — `G01/G02/G03` 형식이 실제 수량산출서와 맞는지.

4. **투입원가 6개 항목(C01~C06)이 실제 회계 계정과 일치하는지** (§24).

5. **현장관리자에게 계약단가를 보여줄지 여부.**
   §44가 *"원가 합계/손익 분석 접근 제한 **가능**"* 이라 표현했기에, 저는 **가장 안전한 쪽
   (차단)** 으로 구현했습니다. 현장에서 단가 확인이 필요하다면 알려주십시오.
   컬럼 GRANT 한 줄로 변경됩니다.

6. **파일 저장소 위치.** 현재 로컬 디스크(`storage/`)입니다. 운영에서는 S3 등으로
   바꿔야 합니다. DB에는 경로만 저장하므로 교체 가능하게 되어 있습니다.

7. **운영 비밀번호.** `.env.example` 의 값은 전부 예시입니다. 운영 배포 전 반드시 교체.

8. **실제심도 허용오차.** 현재 계획 대비 0.5m 초과 시 경고합니다. 이 기준이 적절한지.

---

## 9. 발견된 위험

| # | 위험 | 심각도 | 현재 대응 | 남은 조치 |
|---|---|---|---|---|
| R1 | 아직 프론트엔드가 없어 실제 현장 사용성(3분 이내 입력)을 검증할 수 없음 | 높음 | — | PHASE 6에서 최우선 검증. 그 전까지 "성공"이라 말할 수 없음 |
| R2 | 수량산출서 Excel 구조는 회사마다 제각각이라 PHASE 4에서 가장 큰 변수 | 높음 | 두 가지 입력모드(깊이구간/연장전용) 미리 지원 | **실제 수량산출서 샘플 1부가 필요합니다** |
| R3 | 데이터베이스 접속계정이 유출되면 SET ROLE로 본사 권한 획득 가능 | 중간 | `NOINHERIT`, 앱 계정 자체는 무권한 | 운영 시 비밀번호 관리(Secret Manager), 접속 IP 제한 |
| R4 | `SECURITY DEFINER` 함수는 RLS를 우회함 | 중간 | 함수 내부에 `has_site_access` 재확인 추가 | 새 함수 추가 시 동일 패턴 필수 — CLAUDE.md에 명시 |
| R5 | 변경이력(`audit.change_log`)이 무한히 커짐 | 낮음 | — | 운영 6개월 후 파티셔닝/아카이브 검토 |
| R6 | 천공번호가 `A-001` 같은 "접두어+숫자" 형식이 아니면 정렬키가 NULL | 낮음 | 그래도 저장은 됨 | 실제 도면 번호체계 확인 후 PHASE 5에서 보완 |
| R7 | 카카오톡 공유(PHASE 14)는 외부 서비스 정책에 종속 | 중간 | — | PHASE 13까지 완료 후 별도 검토 |
| R8 | 계약상대방 상세링크가 유출되면 작업현황이 노출됨 | 중간 | `external_share` 에 토큰·만료·회수 필드 준비 | PHASE 13에서 만료/회수 로직 구현 |

**원가 노출 위험은 현재 0건입니다.** 다만 이는 PHASE 8/13에서 실제 기능이 붙은 뒤
재검증해야 합니다. `share` 격리 테스트가 그 시점에도 자동으로 감시합니다.

---

## 10. 다음 Phase 실행 명령

PHASE 1 결과에 이견이 없으시면 아래 문장을 그대로 보내주십시오.

```
PHASE 2 실행.
SITE + CONTRACT + HOLE MASTER 관리 기능을 구현하라.

포함:
- 현장 최초설정 STEP 1~5 (현장 기본정보 / 계약정보 / 문서등록 / 천공번호 생성·매핑 / 천공종류)
- 천공번호 일괄생성 (접두어 + 시작번호 + 종료번호 + 자릿수 + 제외번호)
- 계약 revision 등록 및 현재 revision 전환
- 본사 전용 관리 API + 검증
- 자동 테스트 및 PHASE 2 보고서
```

### 8번 항목 중 답변이 필요한 것

PHASE 2를 시작하기 전에 다음 두 가지만 정해 주시면 됩니다.
(정하지 않으셔도 진행 가능하며, 그 경우 현재 설정을 그대로 유지합니다.)

1. 현장관리자에게 **계약단가**를 보여줄까요? (현재: 차단)
2. 실제 현장의 **천공번호 표기 형식**은 무엇입니까? (현재 가정: `A-001`)

### 참고: 이후 순서 (§49)

```
PHASE 3  GROUND_TYPE + GROUND_PROFILE + 범위 일괄입력   ← 기반은 이미 완성됨
PHASE 4  수량산출서 ↔ HOLE_MASTER 연결                  ← 실제 수량산출서 샘플 필요
PHASE 5  작업도면 ↔ 천공번호 연결
PHASE 6  모바일 오늘 작업입력                            ← 성공기준(3분) 최초 검증 시점
```
