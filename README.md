# BIVE

**Baseline-Integrated Verification Environment**

> AI 에이전트가 작성한 코드를, 코드 대신 **규범(요구사항 · 규칙 · 계약)과 판정 결과**로 검증하는 로컬 개발 도구

에이전트가 짠 코드를 사람이 읽지 않고도 검증하는 로컬 데스크톱 앱이다.

사람은 요구사항을 문장으로 적고, 에이전트가 제안한 규칙을 승인하고, 실행을 확인하는 세 가지만 한다. 테스트 작성 → Red 확인 → 구현 → 검사 → 병합은 고정 파이프라인이 사람 개입 없이 끝내고, 판정은 에이전트의 말이 아니라 **인수 테스트의 실행 결과**로만 내린다.

> 상태: M0 기반 진행 중. 모노레포 · CI · 앱 뼈대 · 오케스트레이터 파이프 서버 · 저장소 · 테스트 하네스 · 픽스처까지 들어갔고, 요구사항 → 규칙 → 실행 → 판정 흐름은 아직 없다(M1). 기준 문서 PRD v0.9 (`docs/spec/prd.md`) · 2026-10-16

## 목차

1. [BIVE는 무엇인가](#1-bive는-무엇인가)
2. [전체 구조](#2-전체-구조)
3. [실행 파이프라인](#3-실행-파이프라인)
4. [저장소 구조](#4-저장소-구조)
5. [설치](#5-설치)
6. [실행](#6-실행)
7. [테스트](#7-테스트)
8. [개발 규칙](#8-개발-규칙)
9. [문서](#9-문서)
10. [로드맵](#10-로드맵)

## 1. BIVE는 무엇인가

에이전트 코딩이 퍼지면서 **코드가 생산되는 속도가 사람이 검토하는 속도를 넘어섰다**. 그런데 검증은 여전히 사람이 코드를 읽는 방식에 기대고 있다. BIVE는 검증의 기준을 "사람이 읽었는가"에서 "규칙을 실행으로 증명했는가"로 옮긴다.

```mermaid
flowchart LR
  REQ["요구사항<br/>(사람이 문장으로 작성)"] --> RULE["규칙 제안<br/>(에이전트 · EARS 진술 + 검사 종류)"]
  RULE --> APPROVE{"승인<br/>(사람)"}
  APPROVE -->|승인| RUN["실행<br/>(고정 파이프라인)"]
  APPROVE -->|거절 · 사유 필수| RULE
  RUN --> JUDGE["판정<br/>(인수 테스트 결과로만)"]
  JUDGE --> SCREEN["화면 갱신<br/>준수 지표 · 판정 상태"]
```

설계 전체를 관통하는 비기능 원칙 세 가지:

| 원칙 | 내용 | PRD |
|---|---|---|
| 무결성 | 요구사항 · 규칙 · 승인 기록은 프로젝트 폴더 **밖**(`~/.bive/`)의 SQLite에 두고, 에이전트는 접근할 수 없다. 승인 기록은 해시 체인으로 추가만 된다. | NFR-01 |
| 역할 접근 제한 | 에이전트 세션에 셸이 없다. BIVE가 제공하는 고정 도구(MCP)만 쓰고, 역할별 경로 가드 안에서만 파일을 만진다. | NFR-02 |
| 데이터 출처 | 화면에 보이는 모든 값은 파서 또는 실행 결과에서만 만든다. 에이전트의 "통과했습니다"라는 메시지는 상태 변경 입력이 아니다. | NFR-03 · JDG-01 |

서버 · 계정 없이 로컬에서만 돈다. Windows를 최우선으로 macOS · Linux에서 같은 동작을 목표로 한다 (NFR-04 · NFR-10).

## 2. 전체 구조

프로세스 3층으로 나뉜다. 화면 앱(Electron)은 보여주기만 하고, 실제 일은 백그라운드 **오케스트레이터**가 한다. 오케스트레이터는 앱을 닫아도 진행 중인 실행이 끝날 때까지 살아 있고, 에이전트 프로세스는 세션마다 하나씩 띄운다.

```mermaid
flowchart LR
  subgraph APP["화면 앱 (Electron)"]
    R["renderer<br/>React · 화면 21개"] -->|"window.bive.invoke()"| P["preload<br/>메서드 허용 목록"]
    P -->|"ipcRenderer.invoke"| M["main<br/>파이프 클라이언트"]
  end

  subgraph ORC["오케스트레이터 (Node · 앱 종료 후에도 유지)"]
    S["파이프 서버<br/>JSON-RPC 2.0 · 토큰"] --> E["실행 엔진<br/>상태 기계"]
    E --> J["판정기<br/>BIVE 전용 vitest"]
    E --> B["예산 집계"]
    E --> G["git<br/>워크트리 · 커밋 · 병합"]
    E --> A["에이전트 어댑터<br/>실제 SDK / ScriptedAdapter"]
    A --> T["고정 도구<br/>MCP · 경로 가드"]
    W["감시자"] --> E
  end

  M -->|"로컬 파이프<br/>named pipe / Unix 소켓"| S
  A -->|"세션 1개 = 프로세스 1개"| AG["에이전트 프로세스 × n<br/>(셸 없음)"]
  AG -->|"MCP 도구 호출만"| T
  T --> WT["실행 워크트리<br/>~/.bive/work/…"]
  E --> DB[("폴더 밖 저장소<br/>~/.bive/projects/&lt;id&gt;/bive.db")]
  J --> WT
  G --> PRJ["프로젝트 폴더<br/>(기준 브랜치)"]
```

| 층 | 역할 | 비고 |
|---|---|---|
| 화면 앱 | 21개 화면(SCR-01~21) 렌더링, 폴더 선택 대화상자, 오케스트레이터 기동 | 렌더러는 Node 모듈 · `require` 없음. `window.bive`는 `invoke` · `on` 두 메서드만 노출 |
| 오케스트레이터 | 파이프 서버, 실행 상태 기계, 판정, 예산, git, 에이전트 세션 관리 | 사용자당 1개. 진행 중 실행 없음 + 연결된 앱 없음이면 자동 종료 |
| 에이전트 프로세스 | Claude Agent SDK 세션. 역할(rule-writer · test-writer · implementer …)별로 모델 · 예산 · 도구 목록이 다름 | TCP 포트 없음. 저장소(`~/.bive/projects`) 접근 불가 |

통신은 로컬 파이프 위의 **JSON-RPC 2.0** 한 줄 프레임이다. 모든 요청 · 응답 · 알림은 `packages/shared`의 zod 스키마로 양쪽에서 검증하고, 연결은 기동마다 갱신되는 토큰(`~/.bive/run/token`, 0600)으로 연다. 상세는 [`docs/architecture.md`](docs/architecture.md) 5장.

## 3. 실행 파이프라인

실행(Run)은 승인된 규칙을 대상으로 만들어지고, 유형 A(신규 동작) 기준으로 8단계를 순서대로 지난다. 검사에 실패하면 구현으로 되돌아가되, **회귀는 최대 2회**(구현 단계 최대 3회)다.

```mermaid
flowchart LR
  S1["1 승인<br/>사람"] --> S2["2 테스트 작성<br/>test-writer"]
  S2 --> S3["3 Red 확인<br/>판정기"]
  S3 -->|"새 테스트 전부 실패"| S4["4 구현<br/>implementer"]
  S3 -->|"통과하는 테스트 있음"| S2
  S4 --> S5["5 검사<br/>판정기 · 승인 규칙 전체"]
  S5 -->|"실패 0"| S6["6 변이 주입<br/>(M3)"]
  S5 -->|"실패 · 회귀 ≤ 2"| S4
  S5 -->|"회귀 > 2"| FAIL["실패<br/>브랜치 보존"]
  S6 --> S7["7 병합<br/>merge commit"]
  S7 -->|충돌| FAIL
  S7 --> S8["8 화면 갱신<br/>판정 저장 · 알림"]
```

| 단계 | 주체 | 종료 조건 |
|---|---|---|
| 테스트 작성 | test-writer 세션 | 대상 규칙마다 인수 테스트 파일 1개 이상, 허용 import · 허용 경로만 |
| Red 확인 | 판정기 | 새 테스트 케이스가 전부 실행되고 전부 실패 (구현 전에 통과하는 테스트는 무효) |
| 구현 | implementer 세션 | 세션 종료 후 판정기가 대상 규칙 테스트를 실행해 전부 통과 |
| 검사 | 판정기 | 승인된 규칙 전체의 인수 테스트 실패 0. Red 확인 때 기록한 테스트 파일 해시와 대조해 바뀌었으면 즉시 실패 |
| 병합 | 오케스트레이터 | 기준 브랜치에 `--no-ff` merge commit. 기준 브랜치가 그사이 바뀌었으면 임시 워크트리에서 검사를 다시 돌린 뒤에만 갱신 |

커밋과 병합은 오케스트레이터만 한다. 에이전트에게는 git 도구가 없다 (RUN-08).

실행 상태는 단계 종료마다 트랜잭션 1회로 저장한다. 오케스트레이터가 비정상 종료되면 재기동 시 `running`을 `interrupted`로 바꾸고, 사람이 재개하면 마지막 완료 단계 커밋으로 워크트리를 되돌린 뒤 다음 단계부터 새 세션으로 이어 간다.

```mermaid
stateDiagram-v2
  [*] --> waiting_approval: run.create (실행 시작 확인)
  waiting_approval --> running: 대상 규칙 전부 승인
  running --> merged: 판정 통과 + 병합 성공
  running --> failed: 회귀 상한 초과 · 병합 충돌 · 가드 위반
  running --> budget_exceeded: 실행 · 역할 예산 초과
  running --> interrupted: 비정상 종료 후 재기동
  interrupted --> running: run.resume (사람)
  merged --> [*]
  failed --> [*]
  budget_exceeded --> [*]
```

예산은 세션마다 `maxBudgetUsd = min(역할 잔여, 실행 잔여)`로 넘긴다. 초과하면 세션을 끊고 실행은 `budget_exceeded`로 끝나며 병합하지 않는다 (COST-01).

## 4. 저장소 구조

pnpm 워크스페이스 · TypeScript strict · ESM. 패키지 경계는 ESLint `no-restricted-imports`로 강제하고, 위반 예제마다 오류가 나는지 `packages/shared/test/lint-rules.test.ts`가 확인한다.

```
bive/
├── packages/
│   ├── shared/         도메인 타입 · 상태 enum · IPC 프로토콜 스키마(zod) · ID
│   ├── store/          프로젝트 폴더 밖 저장소 (better-sqlite3, ~/.bive/) · 마이그레이션
│   ├── parser/         import 그래프 · 블록 판정 · ERD · 클론 탐지 · 테스트 경로 스캔 (M4)
│   ├── orchestrator/   파이프 서버 · 실행 엔진 · 에이전트 어댑터 · 고정 도구 · 판정기 · 예산 · git
│   └── app/            Electron main · preload · renderer(React)
├── fixtures/
│   └── sample-next-app/  테스트 대상 프로젝트 (Next.js · Prisma · SQLite · Vitest). 워크스페이스 밖, 자체 lockfile
├── docs/
│   ├── spec/           prd.md · screens.md · plan.md  (원본, 사람만 수정)
│   ├── architecture.md 패키지 경계 · 데이터 모델 · 상태 기계 · IPC · 테스트 전략
│   ├── decisions.md    ADR (결정은 여기에만 남긴다)
│   ├── roadmap.md      마일스톤 · 이슈 · 수용 기준
│   └── prototype-map.md 프로토타입 → 화면(SCR) → 렌더러 모듈 대응표
├── scripts/            gh-rest.sh (GitHub REST 래퍼) · publish-roadmap.py · reset-fixture.sh · test-reset-fixture.sh
├── .claude/skills/     pr-reviewer · publish-roadmap · run-milestone
├── CLAUDE.md           개발 규칙 (운영 방식)
└── eslint.config.js    패키지 경계 · 테스트 전용 모듈 import 금지 규칙
```

의존 방향은 한쪽으로만 흐른다. `app`은 `shared`만 import하고, 오케스트레이터는 실행 파일 경로로만 기동한다 (프로세스 경계를 import로 넘지 않는다).

```mermaid
flowchart BT
  shared["@bive/shared"]
  store["@bive/store"] --> shared
  parser["@bive/parser"] --> shared
  orch["@bive/orchestrator"] --> shared
  orch --> store
  orch --> parser
  app["@bive/app"] -->|"타입 · 메서드 이름만"| shared
```

런타임 데이터는 전부 `BIVE_HOME`(기본 `~/.bive`) 아래에 둔다. 테스트는 임시 디렉터리로 덮어쓴다.

| 경로 | 내용 | 에이전트 접근 |
|---|---|---|
| `~/.bive/run/` | 파이프 경로 · 접속 토큰 · pid 잠금 | 불가 |
| `~/.bive/projects/<projectId>/bive.db` | 규범 · 실행 · 판정 · 승인 기록 | 불가 |
| `~/.bive/projects/<projectId>/judge/<runId>/` | vitest JSON 원본 · 판정기 설정 | 불가 |
| `~/.bive/work/<projectId>/worktrees/<runId>/` | 실행 워크트리 | 역할별 경로 가드 안에서만 |
| `~/.bive/work/<projectId>/sessions/<sessionId>/` | 역할 작업 디렉터리 | 해당 세션만 |

프로젝트 폴더에는 `.bive.json`(`projectId` · `schemaVersion`) 하나만 생긴다.

## 5. 설치

요구 사항: Node 22.12 이상, pnpm 10 (루트 `package.json`의 `packageManager`로 고정). GUI가 없는 환경에서 Electron 창을 띄우려면 `xvfb-run`이 필요하다.

```sh
pnpm install --frozen-lockfile   # 워크스페이스 의존성 설치
pnpm build                       # packages/*/dist 생성
```

- pnpm 10은 빌드 스크립트를 기본 차단한다. `better-sqlite3` · `electron` · `esbuild`는 루트 `package.json`의 `pnpm.onlyBuiltDependencies`로 허용되어 있다.
- Electron 바이너리는 설치 때가 아니라 처음 실행할 때 내려받는다.
- `fixtures/sample-next-app`은 워크스페이스 밖의 독립 프로젝트라 위 설치에 들어가지 않는다. 픽스처 테스트에는 `pnpm -C fixtures/sample-next-app install --frozen-lockfile`을 따로 실행한다.

## 6. 실행

런타임 데이터는 `BIVE_HOME`(기본 `~/.bive`) 아래에 쌓인다. 개발 중에는 임시 폴더로 덮어쓰는 편이 안전하다. Unix 소켓 경로 제한(Linux 107바이트) 때문에 짧은 경로를 쓴다.

```sh
export BIVE_HOME=$(mktemp -d /tmp/bh.XXXX)
```

| 대상 | 명령 | 설명 |
|---|---|---|
| 앱 | `pnpm --filter @bive/app start` | 앱을 빌드한 뒤 Electron 창을 띄운다. 오케스트레이터가 없으면 앱이 분리 프로세스로 띄운다. GUI 없는 VM에서는 앞에 `xvfb-run -a`를 붙이고, root 실행이면 `--no-sandbox`가 자동으로 붙는다 |
| 오케스트레이터 | `pnpm --filter @bive/orchestrator start` | 단독 기동. 연결된 앱과 진행 중 실행이 없으면 `BIVE_IDLE_SHUTDOWN_MS`(기본 300000ms) 뒤 스스로 종료한다 |
| CLI | `pnpm --filter @bive/app cli ping` | 파이프로 `ping`을 보내 `pong`을 받는다. 오케스트레이터가 없으면 띄운다. `cli rpc <method> [json]`은 조회 메서드(`*.list` · `*.get` · `*.status` · `*.summary`)만 허용한다 |

환경 변수:

| 변수 | 내용 |
|---|---|
| `BIVE_HOME` | 데이터 폴더. 기본 `~/.bive` |
| `BIVE_IDLE_SHUTDOWN_MS` | 오케스트레이터 유휴 종료 대기(ms). 기본 300000 |
| `BIVE_ORCHESTRATOR_MODE` | 앱이 오케스트레이터를 띄우는 방식. `source`(개발, `tsx`) · `dist`(패키징). 기본은 패키징 여부로 결정 |
| `BIVE_NODE_PATH` | `source` 방식에서 쓸 Node 실행 파일. 기본 PATH의 `node` |
| `BIVE_NO_SANDBOX` | `1`이면 Electron에 `--no-sandbox`를 붙인다 (개발 · 테스트 한정, root는 자동) |
| `BIVE_E2E_PORT` | 화면 e2e의 Vite 서버 포트. 기본 5179 |
| `BIVE_AGENT` | 에이전트 어댑터 선택(`scripted` · `claude`). M1에서 추가 예정이라 아직 동작하지 않는다 |

## 7. 테스트

모든 자동 테스트는 실제 Claude API 없이 돈다. 에이전트는 **ScriptedAdapter**(시나리오 파일로 턴을 재생하는 가짜 에이전트)가 대신하고, 실제 SDK 완주는 사람이 확인한다 (ADR-016). ScriptedAdapter 자체는 M1에서 들어온다.

| 종류 | 명령 | 내용 |
|---|---|---|
| 린트 · 형식 · 타입 | `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | ESLint(패키지 경계 규칙 포함) · Prettier · `tsc --noEmit` |
| 단위 테스트 | `pnpm test` | 패키지별 vitest |
| 빌드 | `pnpm build` | `packages/*/dist`, 앱은 electron-vite 출력 |
| 화면 e2e | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<chrome 경로> pnpm e2e` | Playwright로 Vite 개발 서버의 렌더러를 열어 화면 체크리스트 검사 · 스크린샷(`artifacts/screens`). 경로를 주지 않으면 Playwright 기본 브라우저를 쓴다 |
| Electron 스모크 | `xvfb-run -a pnpm smoke` | 앱을 빌드해 띄우고 preload 노출 · 오케스트레이터 연결 · 종료 뒤 유휴 종료를 확인 |
| 픽스처 | `pnpm -C fixtures/sample-next-app test` | 임시 SQLite 마이그레이션 → `next build` → `next start` → HTTP 확인 |
| 픽스처 초기화 | `scripts/reset-fixture.sh <dir> [--verify]` | 픽스처의 추적 파일을 `<dir>`로 복사해 설치하고 git 저장소(커밋 1개)로 만든다. `--verify`는 끝에 픽스처 테스트까지 실행한다 |
| 초기화 스크립트 검사 | `scripts/test-reset-fixture.sh` | 지우면 안 되는 경로를 거부하는지 검사 |

이 VM(Chromium 1194만 설치)에서의 e2e 실행 방법과 각 명령의 실측 결과는 [`CLAUDE.md`](CLAUDE.md) 6장에 있다. 같은 VM의 worktree 여러 개에서 e2e를 동시에 돌릴 때는 `BIVE_E2E_PORT`를 서로 다르게 준다.

## 8. 개발 규칙

상세는 [`CLAUDE.md`](CLAUDE.md). 요약:

- **문서 우선순위**: 내용이 다르면 PRD > 화면 정의서 > 기획서. 요구사항은 PRD ID(`RUN-08` `NFR-01` …), 화면은 `SCR-01`~`SCR-21`로 부른다.
- **결정은 ADR로만**: `docs/decisions.md`에 맥락 · 결정 · 결과를 남긴다. `docs/spec/*` 원본은 사람만 고친다.
- **이슈 1개 = 브랜치 1개 = PR 1개**: 브랜치 `feat/<이슈번호>-<slug>` (`fix/` `chore/` `docs/`), PR 본문 첫 줄 `Closes #<번호>`, squash 머지.
- **커밋**: `type(scope): 요약 (#이슈)`. type = feat · fix · chore · docs · test · refactor.
- **머지 조건**: CI `ci` 통과 + `pr-reviewer` 스킬 검토.
- **언어**: 문서 · 이슈 · PR · UI 문구 · 주석은 한국어, 식별자 · 파일명은 영어. UI 문구는 명사형, 이모지 · 코드 표기 금지.
- **목 데이터 금지**: 화면 데이터는 파서 · 실행 결과에서만. 목은 테스트 코드 안에서만 (NFR-03).
- **테스트를 끄거나 건너뛰어 통과시키지 않는다.** 임시 우회는 ADR 없이는 금지.

## 9. 문서

| 문서 | 내용 |
|---|---|
| [`docs/spec/prd.md`](docs/spec/prd.md) | 요구사항 (PRJ · NRM · RUN · JDG · DSN · TODO · COST · MET · COL · NFR). 가장 최신 원본 |
| [`docs/spec/screens.md`](docs/spec/screens.md) | 화면 정의서 SCR-01~21. 1.1 UI 문구 원칙, 1.3 요구사항 매핑 |
| [`docs/spec/plan.md`](docs/spec/plan.md) | 기획서. 용어(3장) · 동작 상세 |
| [`docs/architecture.md`](docs/architecture.md) | 3층 구조 · 패키지 경계 · 데이터 모델 · 실행 상태 기계 · IPC 메서드 · 테스트 전략 · 보안 경계 |
| [`docs/decisions.md`](docs/decisions.md) | ADR-001~ (ID 체계, 저장 위치, 가짜 어댑터, 헤드리스 실행 등) |
| [`docs/roadmap.md`](docs/roadmap.md) | 마일스톤 M0~M6, 이슈 키 · 의존 · 수용 기준 · GitHub 이슈 번호 |
| [`docs/roadmap-format.md`](docs/roadmap-format.md) | 로드맵 표 형식 |
| [`docs/prototype-map.md`](docs/prototype-map.md) | 프로토타입 파일 → SCR → 렌더러 모듈 |
| [`docs/needs-human.md`](docs/needs-human.md) | 사람만 할 수 있는 항목 목록 |

## 10. 로드맵

| 마일스톤 | 목표 | PRD 단계 |
|---|---|---|
| M0 기반 | 모노레포 · CI · 3층 뼈대 · 테스트 하네스 · 픽스처 | — |
| M1 첫 슬라이스 | 요구사항 1개 → 규칙 → 승인 → 유형 A 파이프라인 → 판정 → 병합 → 화면 | M1 |
| M2 측정 시작 | 코드 열람 기록 (MET-01) | M1 직후 |
| M3 판정 확장 | 구조 · 계약 검사, 변이 주입, 유형 B · C · D, 검토 대기열 | M2 (1/3) |
| M4 설계 화면 · 수집 | 동기화, 파서, 아키텍처 L0 · L1 · 흐름도 · ERD · 변경 로그 · ADR | M2 (2/3) |
| M5 지시 · 질문 · 추적성 | 채팅, 항목 단위 지시 · 질문, 추적성 맵 | M2 (3/3) |
| M6 확장 | 역추출, 자동 모드, 실행 추적, 의존성, 패키징 · 성능 | M3 |

진행 상황은 GitHub 이슈 [#1](https://github.com/chanrhan/bive/issues/1)에 기록한다.
