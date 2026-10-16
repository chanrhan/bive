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
| `fixtures/sample-next-app` | 테스트용 Next.js · Prisma · SQLite · Vitest 프로젝트. 루트 워크스페이스 밖의 독립 프로젝트(자체 `pnpm-lock.yaml` · 별도 설치) |
| `docs/` | spec · 로드맵 · ADR · 아키텍처 · 프로토타입 맵 |

## 4. 작업 방식

- 이슈 1개 = 브랜치 1개 = PR 1개. 브랜치 `feat/<이슈번호>-<slug>` · `fix/` · `chore/` · `docs/`. PR 본문 첫 줄 `Closes #<번호>`, 머지는 squash.
- 커밋: `type(scope): 요약 (#이슈)`. type = feat · fix · chore · docs · test · refactor. 코드 · 주석 · PR 제목 · 본문에 모델 이름을 쓰지 않는다. 커밋 메시지 끝의 공동 작성자(`Co-Authored-By`) · 세션 링크 트레일러는 세션이 지정한 값을 그대로 쓴다.
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
| Electron | `pnpm add -D electron@44.7.2` 후 `xvfb-run -a electron --version` → root라서 `--no-sandbox` 필요 (ADR-028) |
| better-sqlite3 | 13.0.3 프리빌트로 `sqlite_version()` = 3.53.4 확인 |
| Playwright | `@playwright/test@1.64.1`은 chromium 1248을 찾으나 VM에는 1194만 있음 → `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (ADR-028) |
| pnpm 빌드 스크립트 | pnpm 10이 postinstall을 기본 차단 → 루트 `pnpm.onlyBuiltDependencies` 필요 |

추가로 확인한 사실 (2026-10-16, M0-09).

| 항목 | 확인 결과 |
|---|---|
| 환경 변수 | `BIVE_HOME`(데이터 폴더, 기본 `~/.bive`, 테스트는 임시 폴더) · `BIVE_IDLE_SHUTDOWN_MS`(오케스트레이터 유휴 종료 대기, 기본 300000) · `BIVE_NO_SANDBOX=1`(Electron `--no-sandbox` 강제, root면 자동) · `BIVE_ORCHESTRATOR_MODE`(`source` \| `dist`, 앱이 오케스트레이터를 띄우는 방식, 기본은 `app.isPackaged`로 결정) · `BIVE_NODE_PATH`(`source` 방식에서 쓸 Node 실행 파일, 기본 PATH의 `node`) · `BIVE_E2E_PORT`(e2e Vite 서버 포트, 기본은 worktree 경로 해시로 자동 결정) · `BIVE_AGENT`(`scripted` \| `claude`, 에이전트 어댑터 선택. M1-06에서 추가 예정이라 아직 코드에 없음) |
| 오케스트레이터 개발 기동 | `node --conditions=@bive/source --import tsx src/cli.ts` (`packages/orchestrator`에서 실행, `pnpm --filter @bive/orchestrator start`와 같음). 앱은 개발 중 같은 명령으로 분리 프로세스를 띄운다 (ADR-042) |
| 병렬 worktree에서 e2e | e2e의 Vite 서버는 매번 새로 뜨고 포트가 차 있으면 실패한다 (ADR-043). 기본 포트는 worktree 경로 해시로 자동 결정(5179 + hash % 500)되어 worktree끼리 보통 겹치지 않고, 필요하면 `BIVE_E2E_PORT`로 지정한다 (ADR-046) |
| Electron 바이너리 | 설치(`pnpm install`) 때가 아니라 첫 `require('electron')` 때 내려받는다. 새 worktree의 첫 `pnpm smoke`는 `Downloading Electron binary...`가 출력되고 그만큼 오래 걸린다 |
| 픽스처 설치 | `fixtures/sample-next-app`은 루트 워크스페이스 밖이라 루트 `pnpm install`에 들어가지 않는다. `pnpm -C fixtures/sample-next-app install --frozen-lockfile`을 따로 실행해야 픽스처 테스트가 돈다 |

자주 겪는 문제.

- 빌드 스크립트가 돌지 않는다 (`better-sqlite3` 네이티브 모듈 · Electron 바이너리 없음): pnpm 10은 postinstall을 기본 차단한다. 루트 `package.json`의 `pnpm.onlyBuiltDependencies`에 패키지를 넣고 `pnpm install`을 다시 실행한다 (ADR-028).
- Electron이 root에서 기동 실패한다: Chromium 샌드박스 때문이다. 스모크 · 앱 기동 코드는 root(uid 0) 또는 `BIVE_NO_SANDBOX=1`이면 `--no-sandbox`를 붙인다. 직접 `electron`을 실행할 때만 손으로 붙인다.
- Playwright가 브라우저 실행 파일(chromium 1248)을 찾지 못한다: VM에는 1194만 있다. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`을 주고 `playwright install`은 쓰지 않는다 (ADR-028 · ADR-043).
- 오케스트레이터가 `소켓 경로가 너무 김`으로 기동하지 않는다: Unix 소켓 경로는 Linux 107바이트, macOS 103바이트까지다. `BIVE_HOME`을 `mktemp -d /tmp/bh.XXXX`처럼 짧은 경로로 준다. worktree 안에 임시 폴더를 만들면 걸리기 쉽다.
- `pnpm e2e`의 Vite 서버가 뜨지 않는다 (`--strictPort`): 해시 포트가 우연히 겹쳤거나 다른 프로세스가 쓰는 중일 수 있다. `BIVE_E2E_PORT`로 다른 포트를 지정한다.

아래 명령은 2026-10-16에 `main`(`a1f26b1`, #4~#11 머지 상태)의 새 worktree에서 순서대로 실제 실행한 결과다. 시간은 이 VM(4 vCPU)에서 한 번 잰 값이고, pnpm 저장소 캐시가 따뜻한 상태다.

| 작업 | 명령 | 상태 |
|---|---|---|
| 설치 | `pnpm install --frozen-lockfile` | 종료 코드 0 · 1.4초 (캐시 적중 · 변경 없음) |
| 린트 | `pnpm lint` | 종료 코드 0 · 6.2초 (5개 패키지) |
| 타입 검사 | `pnpm typecheck` | 종료 코드 0 · 6.1초 (5개 패키지, app은 tsconfig 3개) |
| 단위 테스트 | `pnpm test` | 종료 코드 0 · 12.6초 · 27개 파일 282개 통과 (shared 112 · store 43 · orchestrator 61 · app 65 · parser 1) |
| 빌드 | `pnpm build` | 종료 코드 0 · 3.5초 (`packages/*/dist` 생성, app은 electron-vite로 main · preload · renderer) |
| 형식 검사 | `pnpm format:check` | 종료 코드 0 · 3.6초 (`*.md` · `docs/` · `scripts/` · `fixtures/`는 대상 아님) |
| 화면 e2e (헤드리스) | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm e2e` | 종료 코드 0 · 30.4초 · 32개 통과 (`xvfb` 불필요) |
| Electron 스모크 | `xvfb-run -a pnpm smoke` | 종료 코드 0 · 9.6초 · 확인 항목 12개, "스모크 통과" (빌드 포함. 새 worktree 첫 실행은 Electron 바이너리 내려받기가 더해진다) |
| 앱 기동 | `BIVE_HOME=$(mktemp -d /tmp/bh.XXXX) BIVE_IDLE_SHUTDOWN_MS=2000 timeout 20 xvfb-run -a pnpm --filter @bive/app start` | 20초 제한까지 창이 떠 있어 종료 코드 124 (정상). 빌드 포함 23초. dbus 연결 오류 로그는 GUI 없는 VM의 무해한 출력 |
| 오케스트레이터 단독 기동 | `BIVE_HOME=$(mktemp -d /tmp/bh.XXXX) BIVE_IDLE_SHUTDOWN_MS=3000 pnpm --filter @bive/orchestrator start` | 종료 코드 0 · 4.0초 · "오케스트레이터 기동" 출력 뒤 3초 유휴 후 "오케스트레이터 종료 (idle)"로 스스로 종료 |
| CLI 핑 | `BIVE_HOME=$(mktemp -d /tmp/bh.XXXX) BIVE_IDLE_SHUTDOWN_MS=3000 pnpm --filter @bive/app cli ping` | 종료 코드 0 · 출력 `pong` (오케스트레이터가 없으면 CLI가 띄우고, 3초 뒤 유휴 종료되어 `run/`이 비는 것까지 확인) |
| 픽스처 설치 | `pnpm -C fixtures/sample-next-app install --frozen-lockfile` | 종료 코드 0 · 11.6초 (`prisma generate` postinstall 포함) |
| 픽스처 테스트 | `pnpm -C fixtures/sample-next-app test` | 종료 코드 0 · 26.8초 · 1개 통과 (임시 SQLite 마이그레이션 → `next build` → `next start` → HTTP 확인) |
| 픽스처 초기화 | `scripts/reset-fixture.sh $(mktemp -d)/fx --verify` | 종료 코드 0 · 20.6초 (복사 → 설치 → git 커밋 → 테스트 1개 통과) |
| 초기화 스크립트 검사 | `scripts/test-reset-fixture.sh` | 종료 코드 0 · 0.7초 (거부 경로 11개 · 허용 경로 1개 통과) |
| GitHub REST | `scripts/gh-rest.sh GET repos/chanrhan/bive/milestones` | 종료 코드 0 · 0.6초 · 마일스톤 M0~M6 7개 |
<!-- /KICKOFF -->
