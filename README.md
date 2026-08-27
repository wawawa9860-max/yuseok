# RF CIP Mobile Field Control V1

RF CIP(겹침 CIP) 전문건설 현장의 **천공번호 기반 통합 현장관리 + 카카오톡 보고** 시스템.

> 최상위 개발 기준: [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md)
> 개발 규칙 요약: [`CLAUDE.md`](CLAUDE.md)

## 현재 진행상황

| Phase | 내용 | 상태 |
|---|---|---|
| PHASE 1 | 프로젝트 구조 / DB / 권한 | ✅ 완료 — [보고서](docs/PHASE_01_REPORT.md) |
| PHASE 2 | SITE + CONTRACT + HOLE MASTER | ✅ 완료 — [보고서](docs/PHASE_02_REPORT.md) |
| PHASE 3 | GROUND_TYPE + GROUND_PROFILE + 범위입력 | ✅ 완료 — [보고서](docs/PHASE_03_REPORT.md) |
| PHASE 4 | 수량산출서 ↔ HOLE_MASTER 연결 | ✅ 완료 — [보고서](docs/PHASE_04_REPORT.md) |
| PHASE 5 | 작업도면 ↔ 천공번호 연결 | ✅ 완료 — [보고서](docs/PHASE_05_REPORT.md) |
| PHASE 6 | 모바일 오늘 작업입력 | ✅ 완료 — [보고서](docs/PHASE_06_REPORT.md) |
| PHASE 7 | 레미콘 / 인원 / 장비 + 오프라인 큐 | ✅ 완료 — [보고서](docs/PHASE_07_REPORT.md) |
| PHASE 8 | 비용 + 사진증빙 + 본사전용 보안 | 대기 |
| PHASE 9~15 | — | 대기 |

## 로컬 실행

```bash
# 1) PostgreSQL 16 준비 후 접속정보 설정
cp server/.env.example server/.env    # 값 수정

# 2) 의존성 설치
npm --prefix server install

# 3) DB 생성 + 마이그레이션 + 테스트 현장 시드
npm --prefix server run db:reset

# 4) 자동 테스트 (권한/검증 포함)
npm --prefix server run test

# 5) 개발 서버
npm --prefix server run dev
```

접속: 현장 모바일 화면은 <http://localhost:3000/app/> 입니다.
휴대폰 브라우저에서 열어 홈 화면에 추가하면 앱처럼 쓸 수 있습니다 (PWA).

테스트 계정 (시드): `head01`(본사) / `field01`~`field03`(현장관리자) / `partner01`(계약상대방)
비밀번호는 모두 `test1234!` — **운영에서 사용 금지**.

## 디렉터리

```
db/migrations/     번호순 SQL 마이그레이션 (스키마·권한·검증의 단일 원천)
server/src/db/     접속풀(역할강등) / 마이그레이션 러너 / 시드
server/src/auth/   비밀번호 해시, JWT
server/src/http/   인증·역할 미들웨어, 오류 매핑
server/src/domain/  결정론적 업무 로직 (천공번호 생성·자연정렬)
server/src/domain/quantitySheet/  수량산출서 파싱·교차검증·패턴확장
server/tests/fixtures/            실제 수량산출서 (파서 회귀 테스트용)
server/src/routes/ REST API
server/tests/      권한/지반조건/API 자동 테스트
web/               모바일 PWA (빌드 단계 없음). 서버가 /app 으로 서빙한다.
storage/           로컬 파일 저장소 (도면·사진·영수증)
db/seeds/          실제 수량산출서에서 추출한 테스트 데이터
docs/              Master Prompt, 문서 분석·검토, Phase 보고서
```
