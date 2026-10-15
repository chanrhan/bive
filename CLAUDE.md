# CLAUDE.md — BIVE 개발 규칙

이 저장소는 BIVE(Baseline-Integrated Verification Environment)를 `docs/spec/`의 기획서 · PRD · 화면 정의서대로 만든다. 사람이 상시 지켜보지 않으므로 아래 규칙이 곧 운영 방식이다. 운영 프롬프트와 이 문서가 충돌하면 이 문서가 우선한다.

## 1. 문서 우선순위와 ID

- 원본: `docs/spec/prd.md`(요구사항) · `docs/spec/screens.md`(화면) · `docs/spec/plan.md`(용어 · 동작). 내용이 다르면 **PRD > 화면 정의서 > 기획서** 순으로 따른다 (PRD v0.9가 가장 최신, ADR-002).
- 요구사항은 PRD ID(`PRJ-01` `NRM-02` `RUN-08` `JDG-01` `DSN-07` `TODO-01` `COST-01` `MET-01` `COL-01` `NFR-01`)로, 화면은 `SCR-01`~`SCR-21`로 부른다. 매핑은 `docs/spec/screens.md` 1.3.
- 결정은 `docs/decisions.md`에 ADR로만 남긴다. 원본 `docs/spec/*`는 사람만 고친다.
- 로드맵은 `docs/roadmap.md`, 형식은 `docs/roadmap-format.md`. 이슈 키(`M1-03`)와 GitHub 이슈 번호를 함께 쓴다.

## 2. 막혔을 때 (사람에게 묻지 않는다)

1. 문서 우선순위로 풀리면 그대로 따른다.
2. 문서에 없으면 **가장 보수적인 해석**(범위가 작고, 되돌리기 쉽고, 무결성 NFR-01 · NFR-02를 더 지키는 쪽)을 고르고 `docs/decisions.md`에 ADR(맥락 · 결정 · 결과, 상태 `제안 (에이전트)`)을 추가한다.
3. 사람만 할 수 있는 일(권한, 외부 계정, 실기기 확인, 제품 방향)은 `needs-human` 라벨 이슈를 만들고, 그것에 의존하지 않는 작업을 계속한다.
4. 같은 오류를 세 번 다르게 시도해도 못 풀면 needs-human 이슈로 남기고 다음 일로 넘어간다.
5. 테스트를 끄거나 건너뛰어 통과시키지 않는다. 임시 우회는 ADR 없이는 금지.

## 3. 저장소 구조 (M0에서 생성)

pnpm 워크스페이스 · TypeScript strict · ESM. 상세는 `docs/architecture.md`.

| 경로 | 역할 |
|---|---|
| `packages/shared` | 도메인 타입 · 상태 enum · IPC 프로토콜 스키마(zod) · ID |
| `packages/store` | 프로젝트 폴더 밖 저장소 (SQLite, `~/.bive/`) · 마이그레이션 |
| `packages/orchestrator` | 백그라운드 프로세스: 파이프 서버 · 실행 엔진 · 에이전트 어댑터(실제 SDK / 가짜) · 고정 도구 · 판정기 · 예산 · git 워크트리 |
| `packages/parser` | import 그래프 · 블록 판정 · ERD · 클론 탐지 · 테스트 경로 스캔 (M2) |
| `packages/app` | Electron(electron-vite) main · preload · renderer(React) |
| `fixtures/sample-next-app` | 테스트용 Next.js · Prisma · SQLite · Vitest 프로젝트 |
| `docs/` | spec · 로드맵 · ADR · 아키텍처 · 프로토타입 맵 |

## 4. 작업 방식

- 이슈 1개 = 브랜치 1개 = PR 1개. 브랜치 `feat/<이슈번호>-<slug>` · `fix/` · `chore/` · `docs/`. PR 본문 첫 줄 `Closes #<번호>`, 머지는 squash.
- 커밋: `type(scope): 요약 (#이슈)`. type = feat · fix · chore · docs · test · refactor. 커밋 · PR · 코드 주석에 모델 이름을 쓰지 않는다.
- 언어: 문서 · 이슈 · PR · UI 문구 · 주석은 한국어, 식별자 · 파일명은 영어. UI 문구는 `docs/spec/screens.md` 1.1 원칙(명사형, 이모지 금지, 코드 표기 금지)을 따른다.
- 라벨: `type:feature` `type:bug` `type:chore` `type:docs` · `area:app` `area:orchestrator` `area:store` `area:parser` `area:shared` `area:ci` `area:docs` · `needs-human`.
- 모든 PR은 CI(`ci`) 통과 + `pr-reviewer` 스킬 검토 후 머지. 리뷰 지적은 최대 2회 수정 반복, 그래도 안 되면 이슈를 쪼갠다.
- 화면 데이터는 파서 · 실행 결과에서만 만든다(NFR-03). 목 데이터는 테스트 코드 안에서만 허용하고 제품 코드 경로에 두지 않는다.
- 서브에이전트 모델: 구현 · 리뷰 · QA는 `opus`, 기계적 작업(발행, 표 갱신)은 `sonnet`. 조율자는 결과만 받는다.

## 5. 진행 기록

- GitHub 이슈 #1 "📍 전체 진행 상황"에 단계 · 마일스톤이 바뀔 때마다 한 줄 코멘트.
- 마일스톤 끝에 회고 코멘트: 머지 PR 수 · 검수 판정 · needs-human 목록 · 새 ADR · 로드맵 조정.

<!-- KICKOFF -->
## 6. 환경과 명령어 (이 VM에서 실제로 실행해 확인한 것만 적는다)

VM: Ubuntu 24.04 x86_64, GUI 없음, 4 vCPU · 15GB RAM. 외부 HTTPS는 정책 프록시 경유(TLS CA: `/root/.ccr/ca-bundle.crt`).

| 도구 | 확인 결과 (2026-10-15) |
|---|---|
| Node | `node -v` → v22.22.0 |
| pnpm | `pnpm -v` → 10.28.0 (npm 10.9.4) |
| Python | `python3 --version` → 3.13.16 |
| 가상 디스플레이 | `xvfb-run --help` 동작. Electron 창은 `xvfb-run -a <명령>`으로 띄운다 |
| 브라우저 | `/opt/pw-browsers/chromium-1194`, `chromium_headless_shell-1194` (PLAYWRIGHT_BROWSERS_PATH 설정됨, `playwright install` 금지) |
| npm 레지스트리 | `npm view electron version` → 44.7.2 (접근 가능) |
| GitHub | `gh api repos/chanrhan/bive` 동작 (프록시가 인증 주입, `gh auth status`의 "token invalid" 경고는 무시). `git push` 동작. Actions 설정 API(`/actions/permissions`)는 프록시가 차단 |
| Claude 인증 | 환경에 `ANTHROPIC_API_KEY` 없음 → 실제 Claude Agent SDK 호출 불가. 테스트는 가짜 에이전트 어댑터로 수행 (ADR-016) |

설치 · 빌드 · 테스트 명령은 M0에서 scaffold를 만든 뒤 실제로 실행해 보고 아래에 채운다.

| 작업 | 명령 | 상태 |
|---|---|---|
| 설치 | `pnpm install --frozen-lockfile` | M0에서 확인 |
| 린트 · 타입 | `pnpm lint` · `pnpm typecheck` | M0에서 확인 |
| 단위 테스트 | `pnpm test` | M0에서 확인 |
| 빌드 | `pnpm build` | M0에서 확인 |
| 화면 e2e (헤드리스) | `pnpm e2e` | M0에서 확인 |
| Electron 스모크 | `xvfb-run -a pnpm smoke` | M0에서 확인 |
| GitHub REST | `scripts/gh-rest.sh GET repos/chanrhan/bive/milestones` | 확인됨 |
<!-- /KICKOFF -->
