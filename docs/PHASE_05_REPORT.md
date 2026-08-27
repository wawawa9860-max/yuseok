# PHASE 5 완료 보고서 — 작업도면 ↔ 천공번호 연결

> Master Prompt §49 PHASE 5, §50 보고 형식
> 작성일 2026-08-27
> 함께 볼 문서: [`DOCUMENT_REVIEW_20260827.md`](DOCUMENT_REVIEW_20260827.md)

---

## 0. 비전문가용 한 줄 요약

**작업도면 PDF를 올리면 시스템이 도면에 적힌 천공번호를 읽어 옵니다.**
그리고 수량산출서로 만든 목록과 **한 줄씩 대조표**를 만들어 줍니다.

이번에 올려주신 실제 도면과 조서를 대조한 결과입니다.

```
도면 107공  vs  조서 108공
              → 16-1 이 도면에 없습니다
```

지시하신 대로 **도면을 넘버링·공수의 기준**으로 삼되, 도면에 없다고 해서
데이터를 **자동으로 지우지는 않습니다.** 지울지, 표시만 할지는 사람이 고릅니다.
계약수량에 직접 영향을 주는 일이기 때문입니다 (§8).

---

## 1. 이번에 구현한 기능

### 1.1 도면에서 천공번호 읽기

실제 도면의 무근 번호는 `1` 과 `-1` **두 조각으로 그려져** 있습니다.
글자 간격을 실측해 결합 규칙을 정했습니다.

```
합쳐야 할 간격 : 6.38 pt  (일정)
떼야 할 간격   : 최소 16.45 pt
글자 크기      : 18.1 pt
→ 임계값 = 글자 크기 × 0.6 (≈10.9pt) 로 깨끗이 갈린다
```

**절대 pt 값이 아니라 글자 크기 대비 비율**로 두었습니다.
축척이 다른 도면에서도 같은 규칙이 작동합니다.
비율을 0.4 / 0.6 / 0.85 로 바꿔도 107공이 그대로 나오는 것을 테스트로 고정했습니다.

### 1.2 도면 ↔ HOLE_MASTER 대조표 (§14)

```
GET /api/admin/drawing-imports/:id/reconcile

→ {
    drawing_hole_count: 107,
    matched: 107,
    drawing_only: [],                          ← 도면에만 있음 (마스터 누락)
    master_only: [{ hole_no: '16-1',           ← 마스터에만 있음 (도면 누락)
                    hole_status: 'NOT_STARTED',
                    deletable: true }],
    missing_hole_actions: ['MARK_ONLY','REMOVE','KEEP'],
    recommended_action: 'MARK_ONLY'
  }
```

**도면에 없는 번호의 처리방식은 세 가지 중 사람이 고릅니다.**

| 방식 | 동작 |
|---|---|
| `MARK_ONLY` (권장) | 상태를 `확인필요` 로 바꾸고 데이터는 보존 |
| `REMOVE` | **미시공인 것만** 삭제. 시공이력이 있으면 거부하고 `확인필요` 로 표시 |
| `KEEP` | 아무것도 하지 않음 |

### 1.3 도면 순서 기록

도면에 그려진 순서대로 `drawing_sequence` 를 매깁니다.
도면에 없는 번호는 순번이 비고, 목록에서 뒤로 밀립니다.

### 1.4 도면 진행상태 (§13)

```
GET /api/admin/sites/:id/drawing-progress
→ { total: 108, by_status: [ {미시공: 107}, {확인필요: 1} ] }
```

상태는 **저장하지 않고 계산**합니다. `금일완료 / 기존완료` 는 시공일로 판정합니다.

### 1.5 도면 Revision (§38)

같은 도면을 다시 올리면 `REV 1` 이 됩니다. 이전 revision 은 그대로 남습니다.
반영 시 `document.current_revision` 이 갱신되고, 각 천공번호의 `drawing_revision` 도 함께 기록됩니다.

---

## 2. 생성/수정한 파일

### 신규
```
db/migrations/0013_phase5_drawing.sql          도면 가져오기 세션, 대조·반영 함수, 진행상태 VIEW
server/src/domain/drawing/extractLabels.ts     PDF 라벨 추출 · 조각 결합
server/src/routes/drawing-import.ts            업로드~대조~승인~반영 API
server/tests/phase5.test.ts                    PHASE 5 테스트 24건
server/tests/fixtures/sample-work-drawing.pdf      실제 작업도면
server/tests/fixtures/sample-quantity-sheet-v2.xlsx 실제 수량산출서 v2
docs/DOCUMENT_REVIEW_20260827.md               업로드 문서 검토 결과
docs/PHASE_05_REPORT.md                        본 문서
```

### 수정
```
server/src/domain/quantitySheet/types.ts          합계열·공수 필드 추가
server/src/domain/quantitySheet/parseSchedule.ts  합계열 값 별도 수집
server/src/domain/quantitySheet/analyze.ts        합계열·공수 대조 검증 추가
server/src/app.ts                                 라우터 연결
CLAUDE.md / README.md                             불변규칙·진행상황 갱신
```

### 추가 의존성
```
pdfjs-dist  4.10.38   PDF 텍스트를 좌표와 함께 읽기 위해
```

---

## 3. DB 변경사항

```
core.drawing_import        도면 가져오기 세션
  revision_no    도면 revision
  analysis       추출한 라벨 원문 + 좌표 (해석하지 않고 보존)
  mapping        사람이 확정한 번호목록 + 처리방식
  reconciliation 대조 결과 기록
```

### 추가된 함수

| 함수 | 역할 |
|---|---|
| `core.fn_reconcile_drawing()` | 도면 ↔ 마스터를 MATCHED / DRAWING_ONLY / MASTER_ONLY 로 분류 |
| `core.fn_apply_drawing_order()` | 도면 순서를 `drawing_sequence` 에 기록 |
| `core.fn_check_drawing_consistency()` | 도면 불일치를 §43 검증 항목으로 보고 |
| `core.fn_validate_site_full()` | 지반·천공종류·도면 검증을 통합 |

### 추가된 VIEW

```
core.v_drawing_progress   도면 순서 + 파생 상태 (§13)
```

### 추가된 검증 항목 (§43)

```
DRAWING_HOLE_MISSING_IN_MASTER  [ERROR] 도면에 있는데 마스터에 없음
MASTER_HOLE_MISSING_IN_DRAWING  [WARN]  마스터에 있는데 도면에 없음 (시공됐으면 ERROR)
HOLE_WITHOUT_DRAWING_ORDER      [WARN]  도면 순번이 없음
NO_DRAWING_APPLIED              [INFO]  반영된 도면이 없음
```

---

## 4. 화면 변경사항

**없습니다.** 모바일 화면은 PHASE 6부터입니다.

추가된 API 5개 (전부 본사 전용):

| API | 용도 |
|---|---|
| `POST /api/admin/sites/:id/drawing-imports` | 도면 업로드 + 번호 추출 |
| `GET /api/admin/drawing-imports/:id/reconcile` | **대조표** |
| `PATCH /api/admin/drawing-imports/:id/mapping` | 번호목록·처리방식 확정 |
| `POST /api/admin/drawing-imports/:id/apply` | **승인 후 반영** |
| `GET /api/admin/sites/:id/drawing-progress` | 도면 진행상태 (§13) |

추출 옵션(`line_tolerance`, `join_gap_ratio`)을 쿼리로 조정할 수 있어,
결합이 잘못된 도면은 값을 바꿔 다시 올릴 수 있습니다.

---

## 5. 계산 규칙

| 항목 | 규칙 |
|---|---|
| 같은 줄 판정 | `\|Δy\| ≤ 글자크기 × 0.35` |
| 조각 결합 | `가로간격 ≤ 글자크기 × 0.6` |
| 좌표 변환 | 페이지 회전을 반영한 뷰포트 변환 적용 |
| 도면 순번 | 라벨 배열 순서 (페이지 → y → x) |
| 대조 | `hole_no` 완전일치 (FULL OUTER JOIN) |
| 목록 정렬 | `drawing_sequence` 우선, 없으면 자연정렬 키 |

---

## 6. 권한 규칙

| 작업 | 본사 | 현장관리자 | 계약상대방 |
|---|---|---|---|
| 도면 업로드·추출 | ✅ | ❌ | ❌ |
| 대조표 조회 | ✅ | ❌ | ❌ |
| 승인·반영 | ✅ | ❌ | ❌ |
| 도면 진행상태 조회 | ✅ | ✅ (배정 현장) | ❌ |
| 가져오기 이력 조회 | ✅ | ✅ (읽기) | ❌ |

DB 함수 내부에서도 `app.is_head_office()` 를 다시 확인합니다.

---

## 7. 자동 테스트 결과

```
Test Files  7 passed (7)
Tests      160 passed (160)      ← PHASE 4 대비 +24
Duration   21.4s
```

| 파일 | 건수 |
|---|---|
| `phase4.test.ts` | 42 |
| `phase2.test.ts` | 30 |
| `phase3.test.ts` | 27 |
| `phase5.test.ts` | **24** |
| `security.test.ts` | 17 |
| `ground.test.ts` | 11 |
| `api.test.ts` | 9 |

### 실제 문서로 검증한 항목

| 검증 | 결과 |
|---|---|
| 도면에서 107공 추출 | ✅ H-PILE 54 + 무근 53 |
| `1` + `-1` 조각 결합 | ✅ |
| **`16-1` 누락 검출** | ✅ |
| 결합 임계값 0.4 / 0.6 / 0.85 에서 동일 결과 | ✅ |
| 대조표: matched 107, master_only `16-1` | ✅ |
| `16-1` 이 삭제되지 않고 `확인필요` 로 보존 | ✅ |
| 도면 순번 107개 부여, `16-1` 은 순번 없음 | ✅ |
| 도면 재업로드 시 REV 1 | ✅ |
| 승인 없이 반영 시도 | ✅ 400 거부 |
| 현장관리자 접근 | ✅ 403 |

### 수량산출서 v2 회귀 검증

파서가 **코드를 한 줄도 고치지 않고** 새 파일을 처리했습니다.

| 변화 | 결과 |
|---|---|
| 29행 → 54행 | ✅ 자동 인식 |
| 무근 번호 소수 → 텍스트 `1-1` | ✅ 그대로 인식 |
| 시트 2개 → 4개 (실행가 추가) | ✅ 실행가는 `UNKNOWN` 으로 제외 |
| 무근 18m < H-PILE 20m | ✅ 깊이 경고 사라짐 |

### 음성 검증

- 결합 임계값을 3.0 으로 과하게 키우면 → 번호가 잘못 붙어 107개 미만 ✅
- 승인 없이 반영 → 400 ✅
- PDF 아닌 파일 → `UNSUPPORTED_FILE` ✅

### 이번에 잡은 버그 2건

**① 도면 파서가 입력 버퍼를 파괴했습니다**
pdf.js 는 넘겨받은 `Uint8Array` 를 detach(전송) 해 버립니다.
그래서 **같은 파일을 두 번 읽으면 `DataCloneError`** 가 났습니다.
호출자의 버퍼를 건드리지 않도록 사본을 넘기게 고쳤습니다.

**② 수량산출서 합계열 검증이 없었습니다** (PHASE 4 보완)
PHASE 4 파서는 지층 **소계**만 대조하고 **합계열**은 보지 않았습니다.
이번 조서에서 소계는 맞는데 합계열만 낡은 29공 범위를 참조하는 오류가 있어
그대로 통과했을 것입니다. 합계열과 공수 대조를 추가했고,
이전 파일(29공)에서는 오탐이 없음도 함께 확인했습니다.

```
GRAND_TOTAL_MISMATCH: [H-PILE 구간 천공] 행을 더한 값 1080m 가
                       조서 합계행의 합계 580m 와 다릅니다.
HOLE_COUNT_MISMATCH:  실제 54공 인데 조서 합계행에는 29공 으로 적혀 있습니다.
```

---

## 8. 사람이 직접 확인해야 할 사항

> 상세 근거는 [`DOCUMENT_REVIEW_20260827.md`](DOCUMENT_REVIEW_20260827.md) 참조

| # | 항목 | 중요도 |
|---|---|---|
| 1 | **천공조서 합계행 `A61` `J61` `V61` 수식 범위를 54공으로 수정** | 높음 |
| 2 | 수정 후 산출근거 H-Pile 근입(580→1,080m)·중량, 내역서 물량 재계산 | 높음 |
| 3 | H-Pile 규격 통일 — 산출근거 `H-300` vs 내역서 `H-350` | 높음 |
| 4 | 도면의 `16-1` 누락이 의도된 것인지 (개구부 등) | 중간 |
| 5 | 총 공수 108공의 산정근거 (50 ÷ 0.47 = 106.4) | 낮음 |
| 6 | 계획 레미콘 할증 2%가 전 현장 공통인지 (PHASE 7) | 중간 |

---

## 9. 발견된 위험

| # | 위험 | 심각도 | 현재 대응 | 남은 조치 |
|---|---|---|---|---|
| R17 | **수량산출서 수식 오류가 실행원가까지 전파** | **높음** | 합계열·공수 대조 검증 추가 | 원본 수정 필요 (8-1, 8-2) |
| R18 | 도면 번호가 이미지(래스터)면 추출 불가 | 중간 | 벡터 PDF 전제, 실패 시 명시적 오류 | OCR 은 V1 범위 밖 — 필요 시 별도 검토 |
| R19 | 도면 조각 결합 규칙이 다른 도면에서 어긋날 수 있음 | 중간 | 임계값을 쿼리로 조정 가능, 추출 결과를 사람이 확인 | 도면 2~3건 더 확보 시 기본값 재검증 |
| R15 | 패턴 확장이 만든 수량 오인 | 높음 | 경고 + 승인 + 추적 | PHASE 6 화면에서 시각 구분 |
| R1 | 프론트엔드 부재 | 높음 | — | **PHASE 6 — 성공기준 첫 검증** |
| R16 | 다른 회사 양식 파싱 실패 가능 | 중간 | 헤더 문구 기반 탐색 | 양식 추가 확보 |
| R14 | 범위 일괄적용 실수 파급 | 중간 | 미리보기 + revision | 되돌리기 API |
| R3 | DB 계정 유출 | 중간 | `NOINHERIT` | Secret Manager |
| R4 | `SECURITY DEFINER` RLS 우회 | 중간 | 함수 내부 권한 재확인 | 신규 함수마다 동일 패턴 |
| R5 | `audit.change_log` 증가 | 낮음 | — | 파티셔닝 |
| R8 | 계약상대방 링크 유출 | 중간 | 토큰·만료 필드 | PHASE 13 |

**R17이 이번에 발견된 가장 큰 위험입니다.** 시스템이 잡아냈지만
**원본 문서를 고치는 것은 사람의 일**입니다. 지금 상태로 계약·정산에 쓰면
H-Pile 물량이 약 46% 적게 계상됩니다.

**§29 원가 노출 위험은 여전히 0건입니다.** 새로 들어온 `실행가` 시트는
가져오기 대상에서 제외되며 자동 테스트로 고정했습니다.

---

## 10. 다음 Phase 실행 명령

```
PHASE 6 실행.
모바일 오늘 작업입력 화면을 구현하라.

포함:
- 모바일 우선 PWA 화면 (§18 통합 메인화면, ERP 사이드메뉴 금지)
- 오늘 천공 입력: 시작번호 / 종료번호 / 제외번호 → 자동집계 (§19, §20)
- 실제심도 예외입력: "계획심도와 동일합니까? [예][아니오]" (§16)
- 지반조건 특이사항: "계획과 다른 점이 있었습니까? [없음][있음]" (§15)
- 50~60대 기준 큰 글씨·큰 버튼 (§47)
- 일일입력 3분 이내 달성 검증 (§52)
- 자동 테스트 및 PHASE 6 보고서
```

### PHASE 6은 이 프로젝트의 분기점입니다

지금까지는 전부 서버·DB였습니다. PHASE 6에서 처음으로
**"50~60대 현장관리자가 별도 설명 없이 3분 안에 입력을 끝낼 수 있는가"**
를 실제로 확인하게 됩니다. §52 성공기준의 핵심입니다.

### 이후 순서 (§49)

```
PHASE 7  레미콘 / 인원 / 장비
PHASE 8  비용 + 사진증빙 + 본사전용 보안
PHASE 9  작업일보 / 천공일지
```
