# BIVE 로드맵

> v2 · 2026-10-15 · 기준 문서: PRD v0.9 · 화면 정의서 v0.5 · 기획서 (docs/spec) · architecture.md v0.1 · ADR-001~036

## 0. 원칙

- PRD 6장의 단계를 이슈 크기에 맞게 나눈다 (ADR-015). 매핑: **M0** 기반 → (PRD 없음) · **M1** 첫 슬라이스 → PRD M1 · **M2** 측정 시작 → PRD "M1 직후 측정 시작" · **M3 · M4 · M5** → PRD M2 MVP(P1 전부)를 판정 확장 / 설계 화면 · 수집 / 지시 · 질문 · 추적성으로 3분할 · **M6** 확장 → PRD M3(P2 전부).
- 우선순위 해석: P0 = M1, P1 = M3~M5, P2 = M6. 예외 3개: MET-01(P1)은 PRD가 "M1 직후"로 정해 M2. COST-02(P1)의 집계 저장과 SCR-05 실행 링크 표시는 COST-01(P0) 예산 집계와 같은 데이터라 M1(M1-17 · M1-18)에서 시작하고 SCR-03 · SCR-16 표시는 원래 단계. SCR-20(P1)은 M0-10 레이아웃이 오른쪽 영역 자리(360px)만 만들고 기능은 M5. PRD가 "후보"라고 한 우선순위는 그대로 둔다.
- 모든 자동 테스트는 ScriptedAdapter(가짜 에이전트)로 돈다 (ADR-016). 실제 Claude 인증 · Windows 완주 · 패키징 실측은 needs-human.
- 이슈 1개 = PR 1개. 의존 열의 키가 닫히기 전에는 시작하지 않는다. 같은 마일스톤 안의 순서는 번호가 아니라 의존 열로 정한다(키는 발행 후 바꾸지 않으므로 M1-08 → M1-09처럼 번호가 거꾸로인 의존이 있다).
- 수용 기준은 항목 1~4개를 `·`로만 구분하고 항목 안에서는 `·`를 쓰지 않는다 (roadmap-format 2절). 경로 약칭: `e2e/…` · `checklists/…` = `packages/app/e2e/…`, `<패키지>/test/…` · `<패키지>/e2e/…` = `packages/<패키지>/…`. 오류 코드는 architecture.md 5장(`-32001` 검증 실패 · `-32009` 상태 충돌 · `-32010` 설정 미비 · `-32020` 권한 없음, 표준 `-32601` 메서드 없음).
- 화면 이슈의 수용 기준은 `e2e/scr-XX.spec.ts`가 `checklists/scr-XX.ts`(screens.md 해당 SCR 절의 구성 요소 · 문구 목록)의 기본 상태와 정의된 빈 · 에러 상태를 통과하는 형식으로 쓴다. 정의 없는 빈 상태 문구는 ADR-029, 다음 마일스톤 기능의 화면 처리(미노출)는 ADR-035, 목록의 문제 항목 · 필터 유지 범위는 ADR-034.
- 완료 기준 흐름은 QA가 헤드리스 VM에서 그대로 실행한다. 클릭은 `xvfb-run` 아래 띄운 앱에 Playwright `chromium.connectOverCDP('http://127.0.0.1:9222')`로 붙어 수행한다.

## 1. 마일스톤 요약

| 마일스톤 | 목표 | PRD 단계 | 이슈 수 | 상태 |
|---|---|---|---|---|
| M0 기반 | 모노레포 · CI · 3층 뼈대 · 테스트 하네스 · 픽스처 | — | 10 | 대기 |
| M1 첫 슬라이스 | 요구사항 1개 → 규칙 → 승인 → 파이프라인 A → 판정 → 병합 → 화면 | M1 | 29 | 대기 |
| M2 측정 시작 | 코드 열람 기록(MET-01) | M1 직후 | 3 | 대기 |
| M3 판정 확장 | 구조 · 계약 검사, 변이, 유형 B·C·D, 검토 대기열, 계약 변경 승인, 결함 · 이력 · 상한, PostgreSQL | M2 (1/3) | 19 | 대기 |
| M4 설계 화면 · 수집 | 동기화, 파서, 수집 COL-01~04, 아키텍처 · L0 · L1 · 흐름도 · ERD · 변경 로그 · ADR | M2 (2/3) | 16 | 대기 |
| M5 지시 · 질문 · 추적성 | 채팅, 항목 단위 지시 · 질문, 추적성 맵, 잠정 승인 설정 | M2 (3/3) | 7 | 대기 |
| M6 확장 | 역추출, 자동 모드, 실행 추적, 의존성, 작성 규칙, 패키징 · 성능 | M3 | 8 | 대기 |

## 2. 마일스톤 상세

### 2.0 M0 기반

**목표**: 제품 기능 없이, 세 층(앱 · 오케스트레이터 · 저장소)이 서로 연결되고 모든 검증 명령이 이 VM과 CI에서 도는 상태를 만든다.

**완료 기준 흐름** (`main` 최신 checkout):
1. `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build` → 종료 코드 0.
2. `pnpm e2e` → `e2e/harness.spec.ts` · `e2e/layout.spec.ts` 통과, `artifacts/screens/SCR-00/기본.png`(셸 화면 ID · 상태 이름은 ADR-043)와 `artifacts/layout/chat-strip-1000.png` 생성. 레이아웃에 사이드바(상단 프로젝트명 · 알림 아이콘, 기획 · 설계 · 실행 메뉴, 하단 연결 상태 · 설정 아이콘) · 중앙 · 오른쪽 360px 채팅 자리가 있다.
3. `export BIVE_HOME=$(mktemp -d); xvfb-run -a pnpm smoke` → 종료 코드 0. 스모크가 창 제목 "BIVE", `window.bive`의 키가 `invoke` · `on` 두 개, `require` 부재, 사이드바 하단 "연결됨"을 확인한다.
4. `export BIVE_HOME=$(mktemp -d); BIVE_IDLE_SHUTDOWN_MS=8000 pnpm --filter @bive/orchestrator start & sleep 3` → `pnpm --filter @bive/orchestrator start; echo $?` → 곧바로 `0`(단일 인스턴스) → `pnpm --filter @bive/app cli ping` → 표준 출력 `pong` → `stat -c %a $BIVE_HOME/run/token` → `600` → `sleep 12; kill -0 $(cat $BIVE_HOME/run/orchestrator.pid)` → 실패(유휴 자동 종료).
5. `FX=$(mktemp -d)/fx; scripts/reset-fixture.sh $FX && pnpm -C $FX test` → HTTP 인수 테스트 1개 통과. `git -C $FX log --oneline main | wc -l` → `1`.
6. `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/$(git rev-parse HEAD)/check-runs` → 이름 `ci`의 `conclusion`이 `success`.

**범위 밖**: 요구사항 · 규칙 · 실행 기능, 실제 SDK 호출, 화면별 체크리스트 내용(M1부터).

| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |
|---|---|---|---|---|---|---|---|
| M0-01 | pnpm 워크스페이스 · TypeScript · ESLint · Prettier · 패키지 뼈대 · 제품 코드 import 금지 규칙 | chore | shared·ci | — | `pnpm install --frozen-lockfile` 뒤 루트 `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`가 5개 패키지(shared, store, orchestrator, parser, app)에서 종료 코드 0 · 루트 `package.json`의 `pnpm.onlyBuiltDependencies`에 electron, better-sqlite3, esbuild가 있다 · `eslint.config.js`가 제품 코드(`packages/*/src`)에서 `e2e/`, `fixtures/`, 이름에 `mock`이 든 경로의 import와 architecture.md 2장의 패키지 간 금지 import를 오류로 막고 `shared/test/lint-rules.test.ts`가 위반 예제 파일마다 오류 1건 이상을 단언 | NFR-03 · NFR-10 · ADR-015 · ADR-028 | #4 |
| M0-02 | GitHub Actions CI 워크플로 | chore | ci | M0-01 | `.github/workflows/ci.yml`의 체크 이름이 `ci`이고 install, lint, typecheck, test, build 단계를 PR과 main push에서 pnpm 저장소 캐시와 함께 실행 · 이 이슈의 PR 최신 커밋에서 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<sha>/check-runs`의 `ci` 결론이 `success` | — | #5 |
| M0-03 | shared: 도메인 타입 · 상태 enum · ID · IPC 스키마 초안 | feature | shared | M0-01 | `shared/test/enums.test.ts`가 판정 상태 5종, 변이 상태 3종, 실행 상태 6종(architecture.md 4장), 실행 유형 A~D, 생성 주체 2종의 zod enum 값을 단언 · `shared/test/protocol.test.ts`가 `packages/shared/src/protocol.ts`의 JSON-RPC 요청, 응답, 알림 스키마와 `ping` 메서드 왕복을 검증하고 스키마 위반 메시지에 `-32602`를 단언 · `shared/test/id.test.ts`가 표시 ID 접두(`REQ-` `RULE-` `CON-` `EXE-` `PRP-` `ADR-`)와 프로젝트별 3자리 순번(`REQ-001`)을 단언 | JDG-02 · RUN-07 · ADR-001 · ADR-025 | #6 |
| M0-04 | store: SQLite 저장소 · 마이그레이션 · 프로젝트 등록 | feature | store | M0-03 | `store/test/migrate.test.ts`가 임시 `BIVE_HOME`에 `projects/<projectId>/bive.db`를 만들고 마이그레이션을 두 번 실행해도 스키마가 같음을 단언 · `store/test/projects.test.ts`가 `projects` 테이블(id, 경로, 생성 시각) 생성, 조회, 수정, 삭제를 단언 · `store/test/paths.test.ts`가 `BIVE_HOME` 미설정 시 `~/.bive`, 작업 디렉터리 루트 `$BIVE_HOME/work`를 단언 | NFR-01 · ADR-005 · ADR-025 | #7 |
| M0-05 | orchestrator: 파이프 서버 · JSON-RPC · 토큰 · 수명 관리 | feature | orchestrator | M0-03 | `orchestrator/test/pipe.test.ts`가 Unix 소켓 `$BIVE_HOME/run/orchestrator.sock`에서 `system.hello`(토큰) 뒤 `ping`이 `pong`을 돌려주고 토큰이 틀리면 `-32020` 후 연결 종료를 단언 · `orchestrator/test/pipe-path.test.ts`가 OS별 경로 함수(Windows `\\.\pipe\bive-<사용자>`, 그 밖 Unix 소켓)를 단언 · `orchestrator/test/lifecycle.test.ts`가 진행 중 실행 0개이고 연결 0개인 상태가 `BIVE_IDLE_SHUTDOWN_MS`(기본 300000) 동안 이어지면 프로세스가 종료됨을 단언 · `orchestrator/test/lock.test.ts`가 `pnpm --filter @bive/orchestrator start` 두 번째 기동이 즉시 종료 코드 0으로 끝나고 pid가 죽은 `$BIVE_HOME/run/orchestrator.pid` 잠금은 인수하며 토큰 파일 권한이 0600임을 단언 | NFR-06 · NFR-10 · ADR-027 | #8 |
| M0-06 | app: Electron 뼈대 · preload 브리지 · 오케스트레이터 기동 · 스모크 | feature | app | M0-05 | electron-vite로 main, preload, renderer를 빌드하고 `xvfb-run -a pnpm smoke`가 창 제목 "BIVE", `window.bive`의 키가 `invoke(method, params)`와 `on(event, cb)` 두 개뿐임, 렌더러에 `require`가 없음을 확인하고 종료 코드 0 · `app/test/orchestrator-launch.test.ts`가 main이 오케스트레이터가 없으면 분리(detached) 프로세스로 기동하고 있으면 붙으며 앱 main pid를 `$BIVE_HOME/run/app.pid`에 기록함을 단언 · `pnpm --filter @bive/app cli ping`이 표준 출력 `pong`, `cli rpc <method> [json]`은 이름이 `.list`, `.get`, `.status`, `.summary`로 끝나는 메서드만 허용하고 그 밖은 종료 코드 2 · root 실행이거나 `BIVE_NO_SANDBOX=1`이면 Electron에 `--no-sandbox`를 넘기고 `pnpm --filter @bive/app start -- <인자>`의 인자(`--remote-debugging-port` 포함)를 Electron에 그대로 넘김(`app/test/launch-flags.test.ts`) | NFR-06 · NFR-10 · ADR-027 · ADR-028 | #9 |
| M0-07 | Playwright 렌더러 하네스 · 가짜 브리지 · 화면 체크리스트 틀 | chore | app·ci | M0-02·M0-06 | `pnpm e2e`가 Vite 개발 서버 렌더러에 `e2e/support/bive-mock.ts`로 `window.bive`를 주입해 열고 `e2e/harness.spec.ts`가 통과 · `expectScreen(scr, state)` 헬퍼가 `checklists/scr-XX.ts`의 요소 목록을 검사하고 화면 문구에 PRD ID 패턴, SCR 코드, 이모지가 있으면 실패함을 `harness.spec.ts`의 위반 예제가 단언 · 스크린샷을 `artifacts/screens/<SCR-ID>/<state>.png`(gitignore, CI 아티팩트)에 저장 · `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`가 있으면 그 브라우저를 쓰고(이 VM `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) `ci` 워크플로에 e2e 단계가 추가됨 | NFR-03 · NFR-09 · ADR-028 | #10 |
| M0-08 | fixtures/sample-next-app · 초기화 스크립트 | chore | ci | M0-01·M0-02 | `fixtures/sample-next-app`(Next.js app router, Prisma, SQLite, Vitest)에서 `pnpm test`가 `GET /api/health` HTTP 인수 테스트 1개를 통과 · `scripts/reset-fixture.sh <dir>`가 `<dir>`을 지우고 픽스처를 복사해 의존성을 설치하고 git 저장소(`main`, 커밋 1개)로 초기화해 `pnpm -C <dir> test`가 바로 통과 · `ci` 워크플로가 픽스처 설치와 테스트를 실행 | ADR-026 | #11 |
| M0-09 | CLAUDE.md KICKOFF 명령 표 채우기 · README 초안 | docs | docs | M0-02·M0-07·M0-08·M0-10 | CLAUDE.md KICKOFF 명령 표의 모든 행이 실제 실행 결과(날짜, 결과)로 갱신됨 · README에 설치, 실행, 테스트 3절 | — | #12 |
| M0-10 | app: 레이아웃 · 다크 테마 토큰 · 연결 상태 | feature | app | M0-07 | `e2e/layout.spec.ts`가 사이드바(상단 프로젝트명과 알림 아이콘, 기획/설계/실행 메뉴 그룹, 하단 연결 상태와 설정 아이콘), 중앙 영역, 오른쪽 360px 채팅 자리를 단언 · `packages/app/src/renderer/styles/tokens.css`에 `docs/prototype-map.md` 토큰 표의 이름이 전부 CSS 변수로 있음을 `app/test/tokens.test.ts`가 단언 · 사이드바 하단이 `system.status` 성공 시 "연결됨", 끊기면 "연결 끊김"(앱은 오케스트레이터를 다시 띄우지 않고 1초 간격 재접속)이고 `xvfb-run -a pnpm smoke`가 "연결됨"을 확인 | NFR-09 · SCR-20 | #13 |

### 2.1 M1 첫 슬라이스

**목표**: PRD 6장 M1. 요구사항 1개를 적으면 규칙이 제안되고, 승인하면 유형 A 파이프라인(테스트 작성 → Red → 구현 → 검사)이 돌아 판정 · 병합 · 화면 갱신까지 끝난다. 사람이 하는 일은 설정 저장(사전 조건, ADR-010) · 규칙 승인 · [실행] 확인(실행 시작 확인, RUN-02가 승인 단계와 별개로 둔 행위) 세 가지뿐이고, [실행] 확인 뒤 화면 갱신까지는 사람 개입 없이 진행한다(PRD "규칙 승인 외 사람 개입 없이"의 해석). 모든 자동 검증은 ScriptedAdapter로.

**완료 기준 흐름** (기본 브랜치 최신에서 `pnpm install --frozen-lockfile && pnpm build` 뒤, 아래 준비 블록을 한 셸에서 실행):
```sh
export BIVE_AGENT=scripted BIVE_HOME=$(mktemp -d) BIVE_IDLE_SHUTDOWN_MS=1000 FX=$(mktemp -d)/fx
scripts/reset-fixture.sh $FX
app()  { BIVE_SCENARIO=${1:-happy-path} xvfb-run -a pnpm --filter @bive/app start -- --open $FX --remote-debugging-port=9222 & sleep 5; }
quit() { kill $(cat $BIVE_HOME/run/app.pid); sleep 2; }   # 진행 중 실행이 없으면 오케스트레이터도 1초 뒤 종료
cli()  { pnpm --silent --filter @bive/app cli "$@"; }
```
"새 규칙 실행(R)" = SCR-02에서 [+ 새 요구사항] → 문장 R 입력 → Ctrl+Enter(⌘↵) → 승인 대기에서 새 제안 [승인] → SCR-03에서 그 규칙 선택 → [실행] → 확인. 시나리오 이름은 `packages/orchestrator/scenarios/<이름>.yaml`.
1. `app` → `cat $FX/.bive.json` → 키가 `projectId` · `schemaVersion` 둘뿐. 창은 SCR-02, 목록은 빈 상태 "요구사항 없음"(ADR-029), [BIVE 동기화] 없음(비어 있지 않은 미연결 폴더, ADR-036). `T=$(stat -c %Y $FX/.bive.json); quit; app` → `stat -c %Y $FX/.bive.json`이 `$T`와 같고 다시 SCR-02로 들어간다.
2. 설정(사이드바 하단 톱니) → 예산 · 모델에서 rule-writer 역할만 모델 `test-model` · 한도 USD 1 · 턴 20, 실행 전체 한도 USD 5 · 턴 200을 [저장] → Esc. (rule-writer 세션도 모델 · 예산이 필수, ADR-024)
3. SCR-02 [+ 새 요구사항] → "헬스 체크 응답에 서버 시각 포함" → Ctrl+Enter → 카드 1줄에 그 문장, 생성 주체 아이콘 사람 → 알림 배지 `2`(`happy-path`의 rule-writer가 제안 2개).
4. 알림 아이콘 → 할 일(탭은 승인 대기 하나) → 카드 2개(종류 태그 "신규", 생성 주체 에이전트). 첫 카드 상세: 제목 · EARS 진술 · 검사 종류 · 부모 요구사항 · 근거 → [수정] → 제목 끝에 "됨" 추가 → [승인]. 둘째 카드 [거절] → 사유 칸이 비어 있으면 확인 버튼 비활성 → 사유 "중복" → 확인. 처리됨 필터 → 승인 기록(수정 diff, 주체 사람)과 거절 기록(사유 "중복"). 배지 사라짐. `cli rpc approvalLog.list` → 2건(`approve_edited` · `reject`), 둘째 항목의 `prevHash`가 첫째 `hash`와 같다.
5. 설정 미비 거부: SCR-03에서 승인된 규칙 선택 → [실행] → 확인 → 오류 문구 "예산 · 모델 미설정", `cli rpc run.list` → 0건.
6. 설정 → test-writer · implementer 모델 `test-model` · 한도 USD 2 · 턴 100 [저장] → SCR-03 [실행] → 확인 → SCR-05 파이프라인 영역에 단계 8개(승인 · 테스트 작성 · Red 확인 · 구현 · 검사 · 변이 주입 "생략" · 병합 · 화면 갱신)가 이 순서로 보인다. 120초 안에 `cli rpc run.list`의 그 실행 상태가 `merged`이고, `cli rpc run.get '{"id":"EXE-001"}'`의 단계 상태가 변이 주입만 `skipped`, 나머지는 `passed`.
7. 완료 뒤 SCR-05 머리줄 "판정 기준 main@<커밋>"의 커밋 = `git -C $FX rev-parse --short main`, 준수 카드 "1 / 1", 규칙 목록에 통과(흐린 점) · 실행 링크의 비용 = `happy-path.yaml`에서 실행 세션(test-writer · implementer)의 `total_cost_usd` 합(화면 자릿수로 반올림) · 턴 = 같은 세션들의 `num_turns` 합. `git -C $FX log main --merges --oneline | wc -l` → `1`, `git -C $FX branch --list 'bive/run-*' | wc -l` → `1`.
8. 실패 경로: `quit; app fail-check` → 새 규칙 실행("헬스 체크 응답에 버전 포함") → 구현 3회(회귀 2회) 뒤 실행 '실패', SCR-03 그 규칙 카드 2줄째 "실패", 상세의 테스트 출력이 펼쳐져 있다. `git -C $FX log main --merges --oneline | wc -l` → `1`(변화 없음), `git -C $FX branch --list 'bive/run-*' | wc -l` → `2`.
9. 예산 초과: `quit; app` → 설정 실행 전체 한도 USD 0.01 [저장] → 새 규칙 실행("헬스 체크 응답에 호스트 이름 포함") → 실행 상태 '예산 초과', `git -C $FX branch --list 'bive/run-*' | wc -l` → `3`, merge 수 `1` 그대로. 설정 한도를 USD 5로 되돌린다.
10. 끊김 복구: `quit; app pause-implement` → 새 규칙 실행("헬스 체크 응답에 가동 시간 포함") → SCR-05 현재 단계 '구현', `test -f $BIVE_HOME/run/pause` 성공 → `kill -9 $(cat $BIVE_HOME/run/orchestrator.pid)` → 사이드바 "연결 끊김" → `BIVE_SCENARIO=pause-implement pnpm --filter @bive/orchestrator start &` → "연결됨" → SCR-05 실행 상태 '중단', [재개] 노출 → [재개] → 구현부터 새 세션(첫 구현 세션에서만 멈추는 시나리오라 그대로 진행) → '통과'. `rm -f $BIVE_HOME/run/pause`.
11. 앱 종료 후 유지(NFR-06): 새 규칙 실행("헬스 체크 응답에 요청 ID 포함") → 단계 '구현'에서 `quit` → `kill -0 $(cat $BIVE_HOME/run/orchestrator.pid) && echo alive` → `alive` → `M=$(git -C $FX rev-parse main); rm $BIVE_HOME/run/pause` → 60초 안에 `git -C $FX log main --merges -1 --format=%H`가 `$M`과 다른 새 merge commit → `app` → SCR-05에서 그 실행 '통과'.
12. 금지 경로(NFR-02): `quit; app forbidden-write` → 새 규칙 실행("헬스 체크 응답에 지역 포함") → `cli rpc run.get '{"id":"<EXE-ID>"}'`의 도구 호출 기록에 결과 `denied` 2건(인수 테스트 파일 쓰기, `$BIVE_HOME/projects` 쓰기) → 실행 '통과', `git -C $FX log --format=%H main -- bive-acceptance/<RULE-ID> | wc -l` → `1`(테스트 작성 단계 커밋뿐).
13. 승인 호출 거부(NFR-01): `quit; app agent-approve` → SCR-02 새 요구사항("헬스 체크 응답에 빌드 시각 포함") → 제안 2개 중 첫째만 [승인] → 그 규칙 [실행] → test-writer 세션이 `proposal.approve`를 호출 → `cli rpc run.get`의 도구 호출 기록에 그 호출이 결과 `denied` · 사유 `unknown_tool` → 둘째 제안은 승인 대기에 '대기'로 남고 `cli rpc approvalLog.list`에 둘째 제안 대상 항목 0건.
14. `pnpm e2e:pipeline` → architecture.md 8장 시나리오 9개 + `app-exit` 테스트 통과. `pnpm --filter @bive/orchestrator test -- integrity` 통과.
15. Windows(NFR-10): `scripts/gh-rest.sh GET "repos/chanrhan/bive/issues?labels=needs-human&state=all"`에서 M1-23이 만든 "Windows 완주" 이슈에 사람의 결과 코멘트가 있어야 M1을 닫는다(QA는 이슈 상태만 확인).

PRD 6장 M1 완료 기준 대응: 1회 완주 → 3~7 · NFR-02 역할 접근 제한 → 12 · 14 · NFR-01 에이전트 승인 불가 → 4(해시 체인) · 13 · 14 · NFR-10 Windows 완주 → 15 · NFR-06 앱 종료 후 유지 → 11.

**범위 밖**: 변이 주입, 구조 · 계약 검사, 검토 대기열, 대기열 유입 상한(M3-13), 규범 변경 이력(M3-12), 잠정 승인, 채팅, 설계 화면, 실제 SDK 완주 · Windows 완주(needs-human).

| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |
|---|---|---|---|---|---|---|---|
| M1-01 | 프로젝트 열기 · 설정 파일 생성 · 재진입 (SCR-01) | feature | app·orchestrator | M0-04·M0-10 | `orchestrator/test/project-open.test.ts`가 `project.open {path}`가 미연결 폴더에 루트 `.bive.json`(`projectId`, `schemaVersion`만)을 만들어 store에 등록하고, 연결된 폴더는 파일을 다시 쓰지 않음(수정 시각 동일)을 단언 · 앱 인자 `--open <path>`로 기동하면 폴더 선택 대화상자 없이 그 경로로 `project.open`을 호출(`app/test/open-arg.test.ts`) · `e2e/scr-01.spec.ts`가 `checklists/scr-01.ts`의 기본 상태([폴더 열기] 버튼)를 통과하고, 빈 폴더와 비어 있지 않은 미연결 폴더 모두 SCR-02로 들어가며 [BIVE 동기화]가 없음을 단언(ADR-036) | PRJ-01 · SCR-01 · ADR-025 · ADR-036 | #14 |
| M1-02 | 요구사항 모델 · CRUD RPC | feature | orchestrator·store | M0-04·M0-05 | `orchestrator/test/requirement.test.ts`가 `requirement.create/update/delete/list/get`과 필드(본문, 생성 주체, 생성 시각, 수정 시각, 상태)를 단언 · 사람의 `requirement.update`가 제안을 만들지 않고 바로 반영되며 수정 시각과 주체가 바뀜을 단언 · `requirement.delete`는 `deletedAt`을 채우는 소프트 삭제이고 `requirement.list`에서 빠짐을 단언 | NRM-01 · ADR-001 | #15 |
| M1-03 | 공통 목록 · 카드 · 상태 배지 컴포넌트 (화면 정의서 1.4) | feature | app | M0-07 | `e2e/list.spec.ts`가 `/` 키 검색 이동, 기준 안 OR와 기준끼리 AND 필터, 칩의 항목 개수와 0건 비활성, 선택 값 표시와 × 해제, 결과 줄("n개 중 m개"와 [초기화])을 단언 · [문제만] 토글이 기본 꺼짐이고 문제 항목(카드 2줄째 예외 1개 이상)이 먼저 정렬됨을 단언(ADR-034) · 필터 상태가 목록별로 앱 실행 동안 유지되어 다른 화면에 갔다 와도 그대로이고 앱을 다시 띄우면 초기화됨을 단언(ADR-034) · 2줄 카드(긴 텍스트 말줄임과 툴팁)와 상태 배지(정상은 글자 없는 흐린 점, 예외는 글자와 색)를 단언 | NFR-09 · ADR-034 | #16 |
| M1-04 | 요구사항 화면 (SCR-02) 목록 · 입력 줄 · 필터 | feature | app | M1-02·M1-03 | `e2e/scr-02.spec.ts`가 `checklists/scr-02.ts`의 기본 상태(카드 1줄 문장, 2줄 ID와 예외와 시각, 생성 주체 아이콘)와 빈 상태("요구사항 없음", ADR-029)를 통과 · [+ 새 요구사항]이 목록 맨 위 입력 줄을 열고 Ctrl+Enter(⌘↵)에 `requirement.create`를 1회 호출하며 Esc는 호출 없이 닫음을 단언 · 필터 칩 4종(상태, 작성, 승인, 블록)이 있고 블록 칩은 값이 없어 0건 비활성(ADR-035) | NRM-01 · SCR-02 · ADR-029 · ADR-035 | #17 |
| M1-05 | 설정: 예산 · 모델 섹션 (SCR-21) · 설정 검증 | feature | app·orchestrator·store | M0-04·M0-05·M0-10 | `orchestrator/test/settings.test.ts`가 `settings.get`과 `settings.update`의 저장 왕복을 단언 · 같은 테스트가 `settings.validateForRun()`이 역할(rule-writer, test-writer, implementer) 모델이나 실행 전체 한도, 역할별 한도(USD, 턴) 중 하나라도 비면 `SETTINGS_INCOMPLETE`(`-32010`)를 돌려줌을 단언 · `e2e/scr-21.spec.ts`가 `checklists/scr-21.ts`의 예산과 모델 섹션 기본 상태(모달 820×600, 바깥 클릭과 Esc와 × 닫기)를 통과하고 나머지 섹션(잠정 승인, 자동 모드, 대기열, 작성 규칙)이 미노출임을 단언(ADR-035) | COST-01 · NFR-07 · SCR-21 · ADR-010 · ADR-024 · ADR-035 | #18 |
| M1-06 | 에이전트 어댑터 인터페이스 · ScriptedAdapter · 시나리오 형식 | feature | orchestrator | M0-03·M0-05 | `orchestrator/test/scripted-adapter.test.ts`가 시나리오 YAML(역할별 턴의 도구 호출과 파일 내용, 결과 메시지의 `total_cost_usd`와 `num_turns`와 subtype)을 재생해 이벤트 순서와 비용 값이 파일 값과 같고 도구 호출이 세션에 주입된 도구 실행기로 넘어감을 단언 · 시나리오는 `BIVE_SCENARIO=<이름>`(기본 `happy-path`)으로 고르고 `packages/orchestrator/scenarios/`에 `happy-path`(rule-writer 제안 2개), `fail-check`(구현이 대상 테스트를 끝내 통과시키지 못함), `pause-implement`(실행마다 첫 구현 세션이 `$BIVE_HOME/run/pause`를 만들고 지워질 때까지 대기)를 둔다 · `BIVE_AGENT`(`scripted` 또는 `claude`, 기본 `claude`)로 어댑터를 고르고 다른 값이면 기동 실패(`orchestrator/test/adapter-select.test.ts`) | RUN-04 · ADR-016 · ADR-024 | #19 |
| M1-07 | 고정 도구 MCP 서버 · 허용 명령 · 경로 가드 · 세션 가드 | feature | orchestrator | M1-06 | `orchestrator/test/commands.test.ts`가 허용 argv 템플릿(`run_tests`, `prisma_generate`, `prisma_migrate`, 기본 빈 허용 목록의 `install_package`)만 `execFile`로 실행하고 목록 밖 명령과 임의 인자를 거부함을 단언 · `orchestrator/test/path-guard.test.ts`가 파일 도구(읽기, 쓰기, 목록, 검색)에서 세션 루트 밖, `$BIVE_HOME/projects`, `$BIVE_HOME/run`, `.git`, 심볼릭 링크 우회를 거부함을 단언 · 모든 도구 호출이 명령 또는 경로, 시각, 결과(`ok` 또는 `denied` 또는 `error`)와 함께 도구 호출 기록에 남음을 단언 · `orchestrator/test/session-guard.test.ts`가 init 메시지의 도구 목록이나 MCP 서버가 역할 허용 목록과 다르면 세션을 중단하고 도구 목록과 MCP 수를 기록함을 단언 | NFR-02 · NFR-04 · ADR-024 | #20 |
| M1-08 | 요구사항 → 규칙 자동 생성 (rule-writer 세션) | feature | orchestrator·store | M1-02·M1-06·M1-07·M1-09 | `orchestrator/test/rule-writer.test.ts`가 `requirement.create` 뒤 rule-writer 세션 1회가 `propose_rule`로 제안을 등록하고 규칙 테이블에는 반영되지 않음을 `happy-path`(제안 2개)로 단언 · `propose_rule`이 제목, EARS 진술, 검사 종류 1개 이상, 부모 요구사항을 검증하고 진술이 `WHEN … THE SYSTEM SHALL …` 형식이 아니면 도구 오류로 거부함을 단언 · rule-writer 세션의 도구 목록이 `propose_rule` 하나이고 설정의 rule-writer 모델과 한도로 시작함을 단언(ADR-024) | NRM-02 · ADR-009 · ADR-024 | #21 |
| M1-09 | 제안 모델 · 승인 · 수정 · 거절 RPC · 승인 경로 격리 | feature | orchestrator·store | M1-02 | `orchestrator/test/proposal.test.ts`가 `proposal.approve`(수정 후 승인 포함)의 규범 반영과 ApprovalLog(행동, 주체, 시각, 수정 diff, 이전 해시) 기록, `approvalLog.list` 조회를 단언 · 빈 사유 `proposal.reject`가 `-32001`(`REJECT_REASON_REQUIRED`)로 거부되고 제안 상태가 그대로임을 단언 · `orchestrator/test/proposal-guard.test.ts`가 토큰 없는 연결의 `proposal.approve`가 `-32020`으로 거부되고 `rule.update`와 `contract.update` 호출이 `-32601`(승인된 규칙과 계약은 직접 수정 RPC 없음)임을 단언 · `orchestrator/test/requirement.test.ts`가 요구사항 삭제 뒤 자식 규칙이 남고 `parentRequirementId`가 비는 것을 단언 | NRM-04 · NFR-01 · TODO-01 · ADR-027 | #22 |
| M1-10 | 할 일 진입 (알림 배지 · 툴팁 · 승인 대기 탭 · 안 읽음 점) | feature | app | M1-03·M1-09 | `e2e/todo-entry.spec.ts`가 알림 배지 숫자가 `proposal.list` 대기 건수와 같고 툴팁에 종류별 건수가 보임을 단언 · 할 일 머리에 승인 대기 탭만 있고 검토 대기열과 계약 변경 승인 탭은 미노출임을 단언(ADR-035) · 카드를 열면 `proposal.markRead`가 호출되고 안 읽음 점이 사라짐을 단언 | TODO-01 · SCR-17 · ADR-035 | #23 |
| M1-11 | 규칙 화면 (SCR-03) 목록 · 필터 · 조회 RPC | feature | app·orchestrator | M1-03·M1-09 | `orchestrator/test/rule.test.ts`가 `rule.list`와 `rule.get`이 승인된 규칙만(제안 제외) 최신 판정(없으면 미판정)과 함께 돌려줌을 단언 · `e2e/scr-03.spec.ts`가 `checklists/scr-03.ts`의 기본 상태(카드 1줄 제목, 2줄 ID와 WHEN 조건과 예외)와 빈 상태("규칙 없음", ADR-029)를 통과 · 필터 칩 6종(판정, 변이, 준수 집계, 블록, 위험도, 종류) 중 변이와 블록과 위험도는 값이 없어 0건 비활성임을 단언(ADR-035) | NRM-02 · JDG-02 · SCR-03 · ADR-029 · ADR-035 | #24 |
| M1-12 | 실행 모델 · 생성 RPC · 상태 저장 | feature | orchestrator·store | M1-05·M1-09 | `orchestrator/test/run.test.ts`가 `run.create(ruleIds)`가 실행(표시 ID `EXE-001`, 대상 규칙, 유형 A, 단계 목록)을 저장하고 ApprovalLog에 `run_start`를 남김을 단언 · 설정 검증 실패 시 `run.create`가 `SETTINGS_INCOMPLETE`(`-32010`)로 거부되고 실행이 만들어지지 않음을 단언 · 승인 단계가 대상 규칙 전부 승인 상태일 때만 끝나고 아니면 `waiting_approval`에 머묾을 단언 · 단계 종료마다 상태가 트랜잭션 1회로 저장되어 프로세스 재시작 뒤 `run.get`이 같은 값을 돌려줌을 단언 | RUN-01 · RUN-02 · NFR-07 · ADR-027 | #25 |
| M1-13 | git 브랜치 · 워크트리 · 병합 관리자 | feature | orchestrator | M0-04·M0-08 | `orchestrator/test/worktree.test.ts`가 픽스처 복사본에서 실행마다 브랜치 `bive/run-<EXE-ID>`와 워크트리 `$BIVE_HOME/work/<projectId>/worktrees/<EXE-ID>`를 만들고 커밋은 오케스트레이터 함수로만 생김을 단언 · `merge(run)`이 기준 브랜치가 그대로면 `--no-ff` merge commit을, 바뀌었으면 병합 결과로 주입된 검사 함수를 다시 돌려 통과할 때만 기준 브랜치를 갱신함을 단언(ADR-017) · 충돌이거나 프로젝트 폴더 작업 트리가 더러우면(추적 파일의 커밋되지 않은 변경만, `git status --porcelain --untracked-files=no`, 미추적 `.bive.json`은 무시) 병합 없이 사유와 함께 `failed`를 돌려주고 브랜치를 보존함을 단언 · `preserve(run)` 뒤 `git branch --list 'bive/run-*'`에 브랜치가 남고 기준 브랜치가 그대로임을 단언 | RUN-08 · ADR-017 · ADR-025 | #26 |
| M1-14 | 파이프라인 엔진 (상태 기계 · 회귀 · 중단 · 재개) | feature | orchestrator | M1-12·M1-13 | `orchestrator/test/engine.test.ts`가 유형 A 단계 순서(승인, 테스트 작성, Red 확인, 구현, 검사, `skipped`로 기록되는 변이 주입, 병합, 화면 갱신)와 모든 전이를 단언 · 종료 조건 미충족 단계는 다음으로 가지 않고 검사 실패는 구현으로 회귀하며 회귀 2회를 넘으면 `failed`임을 단언 · 비정상 종료 뒤 재기동하면 `running` 실행이 `interrupted`가 되고 자동 재개하지 않음을 단언 · `run.resume`이 `interrupted`만 받아 워크트리를 마지막 완료 단계 커밋으로 hard reset과 clean 한 뒤 다음 단계부터 새 세션으로 이어가고 `regressionCount`를 유지함을 단언(ADR-027) | RUN-01 · RUN-02 · ADR-011 · ADR-026 · ADR-027 | #27 |
| M1-15 | 테스트 작성 역할 · Red 확인 | feature | orchestrator | M1-07·M1-14·M1-24 | `orchestrator/test/test-writer.test.ts`가 세션 작업 디렉터리에 허용 입력 사본(규칙 진술, 라우트 목록, Prisma 스키마, 기존 인수 테스트)만 있고 쓰기는 `bive-acceptance/<RULE-ID>/`만 허용됨을 단언(ADR-024) · 대상 규칙마다 `*.acc.ts` 1개 이상이고 `acceptance-lint.ts`의 import 허용 목록(vitest, BIVE HTTP 도우미, Node 내장)을 지켜야 테스트 작성 단계가 끝남을 단언 · Red 확인이 판정 러너로 새 테스트를 돌려 케이스 전부 실패일 때만 통과하고 하나라도 통과하거나 `collect_error`면 테스트 작성으로 돌아가며 재시도 2회 뒤 `failed`임을 단언(ADR-026) · `red-violation` 시나리오(구현 전에 통과하는 테스트)를 추가하고 그 시나리오에서 테스트 작성 단계가 끝나지 않음을 단언 | RUN-03 · RUN-04 · JDG-01 · NFR-02 · ADR-024 · ADR-026 | #28 |
| M1-16 | 구현 역할 · 검사 단계 판정 · 판정 결과 저장 · 병합 연결 | feature | orchestrator·store | M1-13·M1-15·M1-17·M1-24 | `orchestrator/test/implementer.test.ts`가 구현 세션이 워크트리에서 인수 테스트와 `.git`과 `.bive.json` 쓰기를 거부당하고, Red 시점과 검사 직전의 인수 테스트 해시가 다르면 `guard_violation`으로 `failed`이며, 세션 뒤 판정 러너에서 대상 테스트가 전부 통과해야 구현 단계가 끝남을 단언 · 검사 단계가 승인된 규칙 전체 인수 테스트를 판정 러너로 돌려 규칙별 판정 결과(상태, 커밋, 시각, 실행기 출력, 실패 케이스의 `file:line`)를 저장함을 단언 · `false-pass` 시나리오(에이전트가 "통과"라고 보고하지만 테스트 실패)를 추가하고 판정이 `fail`이며 실행 상태가 에이전트 메시지로 바뀌지 않음을 단언 · `orchestrator/test/pipeline-merge.test.ts`(픽스처 통합)가 판정 통과 때 M1-13 `merge`가 호출되어 `main`에 merge commit이 생기고 실패와 예산 초과 종료 때 브랜치가 보존되고 병합이 없음을 단언 | JDG-01 · JDG-02 · RUN-04 · RUN-08 · NFR-02 · ADR-026 | #29 |
| M1-17 | 예산 집계 · 한도 · 비용 기록 | feature | orchestrator·store | M1-06·M1-14 | `orchestrator/test/budget.test.ts`가 세션 결과의 마지막 `total_cost_usd`, `modelUsage`, `num_turns`를 저장하고 세션에서 단계, 역할, 실행 순으로 합산함을 단언 · 값이 없는 세션은 `null`로 저장되어 합계에 0으로 더해지지 않고 모든 값이 없으면 합계도 `null`임을 단언 · 세션 `maxBudgetUsd`가 역할 잔여와 실행 잔여 중 작은 값이고 `error_max_budget_usd` 또는 집계 초과 때 세션이 중단되고 실행이 `budget_exceeded`임을 단언 · `budget-exceeded` 시나리오(결과 subtype `error_max_budget_usd`)를 추가 | COST-01 · COST-02 · ADR-024 | #30 |
| M1-18 | 검증 화면 (SCR-05) 머리줄 · 준수 카드 · 파이프라인 · 목록 · [재개] | feature | app·orchestrator | M1-03·M1-11·M1-16·M1-17 | `orchestrator/test/verification.test.ts`가 `verification.summary`가 판정 기준 커밋, 준수(통과 수와 판정 가능 수), 분모 목록, 실행당 비용(없으면 `null`)을 돌려줌을 단언 · `e2e/scr-05.spec.ts`가 `checklists/scr-05.ts`의 기본 상태(머리줄 "판정 기준 main@커밋", 준수 카드, 실행당 비용 카드, 파이프라인 영역의 최근 실행 단계와 현재 단계, 규칙별 최신 판정과 실행 링크의 비용 합계와 턴)와 빈 상태("실행 없음", ADR-029)를 통과 · 잠정, 변이, 규칙화 불가, 추적성 결함 카드는 미노출이고(ADR-035) 실행당 비용과 실행 링크 비용은 값이 없으면 '없음'임을 단언 · 준수 카드를 누르면 SCR-03이 `준수 집계: 판정 가능` 필터로 열리고, 최근 실행이 `interrupted`면 파이프라인 영역의 [재개]가 `run.resume`을 호출함을 단언(ADR-011) | JDG-03 · COST-02 · SCR-05 · ADR-011 · ADR-029 · ADR-035 | #31 |
| M1-19 | 실행 시작 확인 · 실행 이벤트 알림 · 화면 갱신 단계 | feature | app·orchestrator | M1-11·M1-14·M1-18 | `e2e/run-start.spec.ts`가 SCR-03 [실행]이 확인 대화를 열고 확인하면 `run.create`를 1회, 취소하면 0회 호출함을 단언 · `run.create`가 `SETTINGS_INCOMPLETE`를 돌려주면 확인 대화가 설정 미비 오류 문구(`checklists/scr-03.ts`에 정의)를 보이고 실행이 생기지 않음을 단언 · `orchestrator/test/events.test.ts`가 단계 전이마다 `event.run.updated`와 `event.step.updated`가 나가고 렌더러가 받으면 SCR-03과 SCR-05를 다시 조회함을 단언 · `orchestrator/test/engine.test.ts`가 화면 갱신 단계는 판정 결과 저장 뒤 `event.run.updated` 송신을 마쳐야 완료로 기록됨을 단언 | RUN-02 · SCR-03 · SCR-05 | #32 |
| M1-20 | 앱 종료 후 실행 유지 · 재접속 | feature | orchestrator·app | M0-06·M1-14·M1-16·M1-21 | `orchestrator/e2e/pipeline/app-exit.test.ts`(통합)가 실행 중 앱 프로세스가 끝난 동안에도 오케스트레이터가 살아 있고 실행이 다음 단계로 진행되어 `merged`에 도달함을 단언 · 앱을 다시 띄우면 새 오케스트레이터를 만들지 않고 기존 프로세스(같은 pid)에 붙어 진행 상태를 그대로 보여줌을 단언(`app/test/orchestrator-launch.test.ts`) · 진행 중 실행이 있는 동안에는 `BIVE_IDLE_SHUTDOWN_MS`가 지나도 자동 종료하지 않음을 단언(`orchestrator/test/lifecycle.test.ts`) | NFR-06 · RUN-01 · ADR-027 | #33 |
| M1-21 | 파이프라인 e2e (a): 정상 · 구현 실패 · Red 위반 · 예산 초과 | chore | ci·orchestrator | M1-08·M1-16·M1-17 | 루트 `pnpm e2e:pipeline`이 픽스처 복사본, 실제 git, 실제 판정 러너, ScriptedAdapter로 `orchestrator/e2e/pipeline/`을 실행하고 `ci` 워크플로에 포함됨 · `happy-path.test.ts`가 요구사항 저장부터 `merged`, 판정 `pass`, `main` merge commit까지를 단언 · `fail-check.test.ts`가 구현 3회(회귀 2회) 뒤 `failed`와 브랜치 보존을, `red-violation.test.ts`가 테스트 작성 미종료 뒤 `failed`를 단언 · `budget-exceeded.test.ts`가 `budget_exceeded`, 브랜치 보존, 병합 없음을 단언 | RUN-02 · RUN-03 · RUN-08 · COST-01 | #34 |
| M1-22 | 무결성 시험 (승인 호출 거부 · 셸 없음 · 저장소 격리 · 네트워크) | chore | orchestrator | M1-07·M1-09·M1-14·M1-08·M1-16 | `orchestrator/test/integrity.test.ts`가 모든 역할 세션의 도구 목록에 승인, 잠정 승인, 규범 쓰기, Bash 도구가 없음을 단언 · `agent-approve` 시나리오를 추가하고 세션의 `proposal.approve` 호출이 `denied`(사유 `unknown_tool`)로 거부되며 제안 상태 `pending`이 유지되고 그 제안 대상 ApprovalLog가 0건임을 단언 · 세션 작업 디렉터리의 실경로가 `$BIVE_HOME/projects`와 `$BIVE_HOME/run` 밖이고 그쪽을 가리키는 심볼릭 링크가 없음을 단언 · `happy-path` 실행 동안 오케스트레이터 프로세스의 외부 연결 시도(로컬 소켓과 127.0.0.1 제외)가 0건임을 `net`과 `dns` 감시로 단언 | NFR-01 · NFR-02 · NFR-04 · ADR-024 · ADR-027 | #35 |
| M1-23 | M1 문서: KICKOFF 명령 · needs-human (실 SDK · Windows · 패키징 실측) | docs | docs | M1-21·M1-29 | CLAUDE.md KICKOFF 표에 `pnpm e2e:pipeline`, `pnpm --filter @bive/app start -- --open <dir>`, `pnpm --filter @bive/app cli ping` 행이 실제 실행 결과와 함께 추가됨 · needs-human 이슈 4개 등록: 실제 Claude 인증 완주 1회, Windows 완주(설치, named pipe, 앱 종료 후 유지), 패키징된 앱의 SDK 내장 실행 파일 호출 실측, 에이전트 세션 메모리 실측(세션당 약 1GB가 출발점) · README 실행 절에 M1 완료 기준 흐름의 준비 블록(환경 변수, `scripts/reset-fixture.sh`)이 추가됨 | NFR-06 · NFR-10 · ADR-016 | #36 |
| M1-24 | 판정 러너 (BIVE 전용 vitest 설정 · JSON reporter · 판정 서버 기동) | feature | orchestrator | M0-05·M0-08 | `orchestrator/test/judge-runner.test.ts`가 `$BIVE_HOME/projects/<id>/judge/<runId>/vitest.config.mjs`를 만들어 프로젝트 vitest 설정 없이 `bive-acceptance/**/*.acc.ts`만 실행함을 픽스처 복사본에서 단언 · 스택 프로필 `next-prisma-sqlite`가 임시 SQLite에 `prisma migrate deploy`, `next build`, `next start`(127.0.0.1 임의 포트)를 수행하고 테스트에 기준 URL을 넘김을 단언 · JSON reporter를 파싱해 케이스별 이름, 파일, 줄(`location`), 상태, 메시지를 돌려주고 원본 JSON을 `judge/<runId>/`에 저장함을 단언 · 파일 로드 오류와 수집 0개를 케이스 실패와 구분한 `collect_error`로 돌려줌을 단언(ADR-026) | JDG-01 · ADR-026 | #37 |
| M1-25 | 요구사항 상세 (SCR-06) · 직접 편집 · 삭제 | feature | app | M1-04·M1-09·M1-28 | `e2e/scr-06-requirement.spec.ts`가 `checklists/scr-06.ts`의 요구사항 기본 상태(본문, 생성 주체 이름, 자식 규칙 목록)를 통과하고 변경 이력 영역이 미노출임을 단언(ADR-035) · 자식 규칙을 누르면 그 자리에서 진술, 속성, 테스트 출력이 펼쳐짐을 단언 · 직접 편집 저장이 `requirement.update`를 1회 호출하고, 삭제는 첫 클릭에서 호출 0회이며 두 번째 클릭에서 `requirement.delete`를 1회 호출함을 단언 | NRM-01 · SCR-06 · ADR-035 | #38 |
| M1-26 | ClaudeSdkAdapter 옵션 조립 · 스냅샷 | feature | orchestrator | M1-06·M1-07 | `orchestrator/test/claude-sdk-adapter.test.ts`의 `query()` options 스냅샷이 `tools: []`, `settingSources: []`, `strictMcpConfig: true`, `bive` 하나뿐인 `mcpServers`, `persistSession: false`, SessionSpec 값의 `maxTurns`와 `maxBudgetUsd`임을 단언(`query`는 주입 함수로 대체, 실제 호출 없음) · 스냅샷에 `agents` 키가 없고(ADR-007) `model`이 설정의 역할별 모델임을 단언 · 스냅샷에 모델 API 외 목적지 설정(프록시, 추가 MCP URL, 원격 MCP)이 없음을 단언 | NFR-02 · NFR-04 · ADR-007 · ADR-024 | #39 |
| M1-27 | 승인 대기 목록 · 상세 · 수정 · 거절 · 승인 (SCR-17) | feature | app | M1-10 | `e2e/scr-17.spec.ts`가 `checklists/scr-17.ts`의 기본 상태(카드 1줄 종류 태그와 제목, 2줄 ID와 예외와 시각, 안 읽음 점)와 빈 상태("대기 항목 없음", ADR-029)를 통과 · 상세가 출처, 제안(diff, 근거, 생성 주체), 승인하면과 거절하면 카드 순서이고 오른쪽 아래에 [거절] [수정] [승인]이 떠 있음을 단언 · [수정]과 [거절] 입력이 대화 끝 카드로 열려 자동 스크롤되고 포커스를 받으며 거절 사유가 비면 확인 버튼이 비활성임을 단언 · 필터 칩 4종(처리 상태, 종류, 위험도, 제안자) 중 위험도는 0건 비활성이고(ADR-035) 처리됨 필터에서 승인과 거절 기록(수정 diff, 주체, 사유)이 보임을 단언 | NRM-04 · TODO-01 · SCR-17 · ADR-029 · ADR-035 | #40 |
| M1-28 | 규칙 상세 (SCR-06) · 테스트 출력 | feature | app | M1-11·M1-16 | `e2e/scr-06-rule.spec.ts`가 `checklists/scr-06.ts`의 규칙 기본 상태(진술, 테스트 실행 결과, 실행 이력)를 통과하고 변경 이력 영역이 미노출임을 단언(ADR-035) · 테스트 출력이 기본 접힘이고 최신 판정이 실패면 자동으로 펼쳐짐을 단언 · 실패 원인에 실행기 출력(실패 케이스 이름, 메시지, `file:line`)이 보임을 단언 | NRM-02 · JDG-02 · SCR-03 · SCR-06 | #41 |
| M1-29 | 파이프라인 e2e (b): 중단 재개 · 금지 경로 · 추가 MCP · 통과 보고 · 병합 충돌 | chore | ci·orchestrator | M1-20·M1-21·M1-22 | `orchestrator/e2e/pipeline/interrupt-resume.test.ts`가 `pause-implement` 도중 오케스트레이터 SIGKILL, 재기동 뒤 `interrupted`, `run.resume` 뒤 `merged`를 단언 · `forbidden-write`와 `extra-mcp` 시나리오를 추가하고 `forbidden-write.test.ts`가 도구 거부 2건 기록과 인수 테스트 해시 불변을, `extra-mcp.test.ts`가 실행 `failed`를 단언 · `false-pass.test.ts`가 판정 `fail`을, `merge-conflict` 시나리오와 `merge-conflict.test.ts`가 병합 직전 기준 브랜치 충돌 커밋에서 `failed`와 브랜치 보존을 단언 · `pnpm e2e:pipeline`이 architecture.md 8장 시나리오 9개를 각각 테스트 1개로, 그리고 `app-exit.test.ts`를 포함해 `ci`에서 통과 | NFR-01 · NFR-02 · NFR-06 · JDG-01 · RUN-08 | #42 |

### 2.2 M2 측정 시작

**목표**: PRD "M1 직후 측정 시작". 코드 열람 횟수 · 사유를 기록하고 검증 화면에 분포를 보인다.

**완료 기준 흐름** (M1 흐름 1~8을 마친 상태, 같은 셸. 앱은 `BIVE_OPEN_URL_LOG=$BIVE_HOME/open-url.log`를 더해 띄운다: `quit; BIVE_OPEN_URL_LOG=$BIVE_HOME/open-url.log app`):
1. SCR-03에서 8단계의 실패 규칙 상세 → 실패 케이스 `file:line` 링크 → 사유 모달(화면 오류 · 정보 부족 · 디버깅) → 선택 없이 닫으면 `test -s $BIVE_HOME/open-url.log` 실패 → 다시 열어 "디버깅" → `tail -1 $BIVE_HOME/open-url.log` → `vscode://file/<경로>:<줄>` → `cli rpc codeOpen.list` → 1건(시각, 출발 화면 SCR-03, 항목 ID, 사유 `debugging`, 파일, 줄).
2. SCR-05 "코드 열람" 영역 → "디버깅 1". 새 `BIVE_HOME`으로 띄운 앱에서는 같은 영역이 '없음'.
3. 설정 → IDE를 Cursor로 [저장] → 1단계 링크를 다시 열기 → `tail -1 $BIVE_HOME/open-url.log` → `cursor://file/<경로>:<줄>`.

**범위 밖**: 링크를 거치지 않은 열람 집계(PRD가 한계로 명시).

| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |
|---|---|---|---|---|---|---|---|
| M2-01 | 코드 열기 링크 · 사유 선택 · 열람 기록 | feature | app·orchestrator·store | M1-16·M1-28 | `e2e/code-link.spec.ts`가 공통 `CodeLink`(`file:line`)를 누르면 사유 3종(화면 오류, 정보 부족, 디버깅) 모달이 열리고 선택 없이 닫으면 IDE 호출이 0회임을 단언 · `orchestrator/test/code-open.test.ts`가 `codeOpen.record`가 시각, 출발 SCR, 항목 ID, 사유, 파일, 줄을 저장하고 `codeOpen.list`가 돌려줌을 단언 · SCR-03 규칙 상세의 실패 케이스(M1-16이 저장한 `file:line`)에 `CodeLink`가 붙음을 `e2e/scr-06-rule.spec.ts`가 단언 | MET-01 · SCR-03 | #43 |
| M2-02 | 검증 화면 코드 열람 사유 분포 | feature | app·store | M1-18·M2-01 | `e2e/scr-05.spec.ts`가 "코드 열람" 영역의 사유별 건수를 통과 · 기록이 없으면 영역 값이 '없음' · `orchestrator/test/code-open.test.ts`가 `codeOpen.summary` 집계를 단언 | MET-01 · SCR-05 | #44 |
| M2-03 | IDE 선택 설정 · 열기 프로토콜 | feature | app·orchestrator | M1-05·M2-01 | `e2e/scr-21.spec.ts`가 설정의 IDE 항목(VS Code `vscode://file/{path}:{line}`, Cursor `cursor://file/{path}:{line}`, 사용자 지정 URL 틀)과 기본값 VS Code를 통과 · `app/test/ide-url.test.ts`가 선택별 URL 생성과 경로 인코딩을 단언하고, `BIVE_OPEN_URL_LOG=<파일>`이면 URL을 열지 않고 그 파일에 한 줄로 기록함을 단언 · IDE 미설정 상태에서 처음 열 때 IDE 선택을 먼저 요구함을 `e2e/code-link.spec.ts`가 단언(ADR-018) | MET-01 · SCR-21 · ADR-018 | #45 |

### 2.3 M3 판정 확장

**목표**: PRD M2의 판정 · 실행 쪽 P1. 구조 · 계약 검사와 변이 주입이 파이프라인에 들어가고, 실행 유형 B·C·D, 검토 대기열, 계약 변경 승인, 추적성 결함 · 규칙화 불가 · 변경 이력 · 유입 상한이 동작한다.

**완료 기준 흐름** (M1 흐름의 준비 블록 · `app` · `quit` · `cli` · "새 규칙 실행"을 그대로 쓰고, M1 흐름 1~7을 먼저 수행):
1. `cli blocks set $FX fixtures/blocks/sample-next-app.json` → SCR-03에 내장 규칙 `structure.public-api-only` · `structure.declared-direction`이 보이고 결함으로 잡히지 않는다. `scripts/make-variant.sh $FX undeclared-import` → SCR-03에서 `structure.declared-direction` [실행] → 확인 → 실행 유형 B(파이프라인에 테스트 작성 · Red 확인 "생략"), 검사 단계 실패, 규칙 판정 '실패', 실행 '실패'. `git -C $FX revert --no-edit HEAD`.
2. `cli contract register $FX openapi.yaml openapi` → 승인 대기 카드(종류 태그 "신규") → [승인] → SCR-04에 계약 1개(종류 API, 원본 파일 `openapi.yaml`, 연결 규칙 1개) → 그 `contract` 규칙 [실행] → 유형 B, 테스트 작성 · Red 확인 "생략", 실행 '통과'.
3. `quit; app mutant-survives` → 새 규칙 실행("헬스 체크 응답에 서비스 이름 포함") → SCR-05 파이프라인에 변이 주입 단계(생략 아님) → 실행 '통과', SCR-03 그 규칙 카드 예외 '변이 생존' → 할 일에 [검토 대기열] 탭과 카드(종류 변이 생존) → [판정 격리] → 사유가 비면 확인 비활성 → 취소 → [테스트 보강] → 유형 C 실행 생성(구현 "생략", Green 확인, 변이 주입) → 끝나면 그 규칙 '변이 검증됨'(흐린 점).
4. `quit; app` → 설정 실행 전체 한도 USD 0.01 [저장] → 새 규칙 실행("헬스 체크 응답에 리전 포함") → '예산 초과' → 검토 대기열 카드(종류 예산 초과) → [한도 상향 재개] → USD 5 입력 → 같은 실행이 마지막 완료 단계 다음부터 이어져 '통과', `git -C $FX log main --merges -1 --format=%s`에 그 실행 브랜치 이름.
5. `cli contract propose-change $FX CON-001 fixtures/contracts/openapi-v2.yaml` → `git -C $FX status --porcelain --untracked-files=no` 빈 출력(승인 전 추적 파일 불변, `.bive.json`은 미추적) → 할 일 [계약 변경 승인] 탭 → 카드 → 계약 diff · 영향 규칙 1개 · 블록 · Breaking 1 → [승인] → `cli rpc run.list`의 마지막 실행이 유형 B · 대상 = 그 계약의 `contract` 규칙.
6. `quit; app no-rules` → 새 요구사항 "로그 보관 기간 30일" 저장 → 제안 없음 → SCR-02 카드 예외 '추적성 결함'. 다른 요구사항 상세 → [규칙화 불가] → 사유가 비면 확인 비활성 → 사유 "외부 정책" → 카드 예외 '규칙화 불가', 결함 수에서 빠짐. SCR-05에 규칙화 불가 비율 카드 · 추적성 결함 카드가 보이고 결함 카드를 누르면 SCR-02가 '추적성 결함' 필터로 열린다.
7. 요구사항 하나를 편집 → SCR-06 변경 이력(접힘) → 펼치면 이전 · 이후 내용, 시각, 주체 사람.
8. 대기 제안을 모두 처리(승인 또는 거절)한 뒤 `quit; app bulk-41` → 새 요구사항 저장 → `cli rpc proposal.list '{"state":"pending"}'` → 40건(41번째는 `QUEUE_LIMIT_REACHED`로 거부, ADR-030) → SCR-17 머리줄 "대기 40 / 상한 40" 빨강, 알림 배지 빨강, 배지 툴팁 "유입 상한 도달" → 설정 대기열에서 승인 대기 상한 50 [저장] → 머리줄 "대기 40 / 상한 50" 기본색 → 새 요구사항 저장 → 대기 50건 뒤 다시 거부.
9. `scripts/make-variant.sh $FX touch-lib` → 10초 안에 SCR-03에서 대상 블록 `lib` 규칙이 '재검증 필요'. `pnpm --filter @bive/orchestrator test -- reproducibility` 통과(같은 커밋 3회 판정 동일, `flaky` 변형은 '격리').
10. PostgreSQL: `pg_ctlcluster 16 main start; runuser -u postgres -- psql -qc "ALTER USER postgres PASSWORD 'bive'"; export BIVE_PG_URL=postgresql://postgres:bive@127.0.0.1:5432/postgres` → `quit; FX=$(mktemp -d)/fx; scripts/reset-fixture.sh $FX; scripts/make-variant.sh $FX postgres; app` → M1 흐름 2 · 3 · 4 · 6과 이 흐름 1~2를 반복 → 같은 결과. `pnpm e2e:pipeline -- postgres` 통과.

**범위 밖**: 설계 화면, 채팅 · 지시, 잠정 승인 정책 UI(M5-06), 체류 기간 상한(미정), 이의 제기(PRD 미결 #7).

| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |
|---|---|---|---|---|---|---|---|
| M3-01 | 블록 선언 모델 · 규칙의 대상 블록 · 위험도 | feature | shared·store·orchestrator | M1-21 | `orchestrator/test/blocks.test.ts`가 블록 선언(이름, 종류, include, public, dependsOn, risk)을 `$BIVE_HOME/projects/<id>/`에 저장하고 `blocks.get`과 `blocks.set`이 왕복함을 단언 · 규칙에 대상 블록 1개 이상과 위험도(`low` 또는 `medium` 또는 `high`)가 필수이고 `propose_rule`에 없으면 도구 오류임을 단언 · 세션 작업 디렉터리에 블록 선언 읽기 전용 사본이 놓이고 쓰기 시도는 경로 가드가 거부함을 단언 · `pnpm --filter @bive/app cli blocks set <dir> <json>`이 `blocks.set`을 호출하고 예제 `fixtures/blocks/sample-next-app.json`(블록 `auth` 위험도 high, `lib` 위험도 low)이 픽스처에 맞음을 `app/test/cli-blocks.test.ts`가 단언 | NRM-09 · ADR-005 | #46 |
| M3-02 | 파서 기초: import 그래프 · 블록 판정 (dependency-cruiser) | feature | parser | M3-01 | `parser/test/graph.test.ts`가 dependency-cruiser JSON 출력에서 import 그래프를 만들고 자체 모듈 해석기를 쓰지 않음을 단언(ADR-033) · 파일과 블록 매핑(include)과 미분류 파일 목록을 단언 · 선언 외 방향, 공개 API 외 접근, 순환을 블록 선언에서 생성한 dependency-cruiser 규칙의 위반 출력으로 판별함을 단언 · `scripts/make-variant.sh <dir> <이름>`을 추가하고 `undeclared-import`와 `cycle` 변형에서 위반이 각각 1건임을 단언 | DSN-01 · JDG-05 · ADR-033 | #47 |
| M3-03 | 구조 검사 내장 규칙 · 검사 단계 통합 | feature | orchestrator | M1-16·M3-02 | `orchestrator/test/structure-check.test.ts`가 블록 선언 저장 때 내장 규칙 `structure.public-api-only`와 `structure.declared-direction`이 부모 없이 생기고 `rule.list`에 나옴을 단언 · 검사 단계가 구조 검사를 실행해 `undeclared-import` 변형에서 해당 내장 규칙 판정 `fail`과 회귀 규칙에 따른 실행 `failed`를 단언 · 내장 규칙이 준수 지표의 판정 가능 항목에 들어가고 추적성 결함에서는 빠짐을 `orchestrator/test/verification.test.ts`가 단언 | JDG-05 · NRM-06 · RUN-02 · ADR-033 | #48 |
| M3-04 | 계약 등록 · contract 검사 규칙 · 계약 검사 실행기 | feature | orchestrator·store | M1-24·M3-01 | `orchestrator/test/contract.test.ts`가 `contract.register(file, kind)`가 `contract_new` 제안을 만들고 승인 때 계약(등록 단위 파일, 내용 해시)과 `contract` 검사 규칙이 함께 반영되며 요구사항 연결이 파일 단위임을 단언(ADR-019) · 계약 검사 실행기가 OpenAPI는 `@redocly/cli lint`와 판정 서버 앞 `@stoplight/prism-cli proxy --errors`, Prisma 스키마는 `prisma validate`와 `prisma migrate diff --exit-code`, AsyncAPI는 `@asyncapi/cli validate`를 호출함을 단언(ADR-033) · 픽스처에 `openapi.yaml`을 더하고 `contract-mismatch` 변형(응답 필드 타입 위반, 마이그레이션 없는 스키마 필드)에서 `orchestrator/test/contract-runner.test.ts`가 OpenAPI와 Prisma 계약 판정 `fail`을, 원본에서 `pass`를 단언 · `pnpm --filter @bive/app cli contract register <dir> <file> <kind>`가 `contract.register`를 호출 | NRM-03 · ADR-019 · ADR-033 | #49 |
| M3-05 | 계약 화면 (SCR-04) | feature | app | M1-25·M3-04 | `e2e/scr-04.spec.ts`가 `checklists/scr-04.ts`의 기본 상태(종류, 원본 파일, 연결 규칙, 판정, 생성 주체)와 빈 상태("계약 없음", ADR-029)를 통과 · 결함(스키마 불일치, 검사 규칙 없는 계약)이 카드 2줄째 예외로 보이고 [문제만]에 잡힘을 단언 · 필터 칩 3종(종류, 검사 규칙, 판정)을 단언 | NRM-03 · SCR-04 · ADR-029 | #50 |
| M3-06 | 실행 유형 B · C · D 파이프라인 변형 | feature | orchestrator | M3-03·M3-04 | `orchestrator/test/engine.test.ts`가 ADR-020과 architecture.md 4장 유형 표의 단계 순서, 생략 단계의 `skipped` 저장, 모든 유형의 회귀 상한 2회를 상태 기계 테스트로 단언 · 유형 C가 Green 확인(새 테스트 전부 통과, 하나라도 실패면 테스트 작성 미종료)과 소스 파일 쓰기 거부를 지킴을 단언 · 유형 D가 시작 전 기존 검사 전부 통과가 아니면 시작을 거부하고 검사 단계에서 기존 검사 전부 통과를 요구함을 단언 · `run.create`가 유형을 기록하고 유형 B는 검사 종류가 `structure` 또는 `contract`인 규칙만 받음을 단언 | RUN-07 · ADR-020 | #51 |
| M3-07 | 변이 주입 역할 · 변이 상태 · 고위험 우선 | feature | orchestrator·store | M1-17·M3-01·M3-06 | `orchestrator/test/mutation.test.ts`가 변이 주입 세션이 고정 도구 `propose_mutant`(대상 블록 파일 안 단일 패치)로 변이를 내고 판정 러너가 격리 워크트리에 적용해 대상 규칙 인수 테스트가 실패하면 '변이 검증됨', 통과하면 '변이 생존'을 저장함을 단언(ADR-033) · 변이 대상 순서가 위험도 high, medium, low(같으면 규칙 ID) 순이고 예산이 중간에 바닥나면 남은 규칙이 '변이 미검증'으로 남음을 단언 · 유형 A의 변이 주입 단계가 `skipped`가 아니게 되고 유형 C 테스트 보강 실행은 변이 재주입에서 '변이 검증됨'이어야 끝남을 `mutant-survives` 시나리오(첫 변이 생존, 보강 뒤 재주입 변이 검출)로 단언 · `e2e/scr-21-mutation-role.spec.ts`가 SCR-21에 변이 주입 역할의 모델과 한도 입력 칸이 있고 비어 있으면 `validateForRun`이 `SETTINGS_INCOMPLETE`를 돌려줌을 단언 | JDG-04 · NRM-09 · RUN-02 · RUN-04 · ADR-033 | #52 |
| M3-08 | 검토 대기열 모델 · 자동 등록 · 처리 액션 | feature | orchestrator·store | M1-17·M3-07 | `orchestrator/test/review-queue.test.ts`가 예산 초과 실행과 변이 생존 규칙이 검토 대기열 항목으로 자동 등록됨을 단언 · 변이 생존 액션: 테스트 보강은 유형 C 실행을 만들고, 판정 격리는 빈 사유를 `-32001`로 거부하며 사유가 있으면 판정 상태 '격리', 이의 제기는 호출하면 `-32601`(PRD 미결 #7)임을 단언 · 예산 초과 액션: 한도 상향 재개는 새 한도를 실행에 적용해 마지막 완료 단계 다음부터 이어가고, 허용 목록 축소 재개는 사람이 구현 역할 파일 허용 목록(기본 대상 블록 include)에서 경로를 뺀 뒤 같은 방식으로 이어가며 뺀 경로 쓰기는 경로 가드가 거부함을 단언 · 규칙 분할은 rule-writer 세션이 대상 규칙을 2개 이상으로 나누는 제안을 승인 대기에 등록하고 원 실행은 `budget_exceeded`로 남음을 단언 | TODO-02 · COST-01 | #53 |
| M3-09 | 검토 대기열 화면 (SCR-18) · 할 일 탭 | feature | app | M1-10·M3-08 | `e2e/scr-18.spec.ts`가 `checklists/scr-18.ts`의 기본 상태(카드 1줄 대상 규칙 제목, 2줄 ID와 종류와 시각)와 빈 상태("검토 항목 없음", ADR-029)를 통과 · 종류별 액션 버튼(변이 생존: 테스트 보강, 판정 격리, 비활성 이의 제기 / 예산 초과: 한도 상향 재개, 허용 목록 축소 재개, 규칙 분할)이 보이고 판정 격리 사유가 비면 확인이 비활성임을 단언 · 할 일에 검토 대기열 탭이 생기고 배지 합계에 검토 대기열 건수가 들어가며 마지막 탭을 앱 실행 동안 기억함을 단언(ADR-034) · 필터 칩 2종(종류, 처리 상태)을 단언 | TODO-02 · SCR-18 · ADR-029 · ADR-034 | #54 |
| M3-10 | 계약 변경 승인 (SCR-19) | feature | app·orchestrator | M3-05·M3-06·M3-09 | `orchestrator/test/contract-change.test.ts`가 `contract.proposeChange(contractId, file)`가 구현 전에 계약 diff, Breaking 수(OpenAPI만 `openapi-diff`, 그 밖은 `null`), 영향 규칙과 블록을 계산해 `contract_change` 제안을 만들고 승인 전에는 계약 승인본과 프로젝트 파일이 바뀌지 않음을 단언 · `e2e/scr-19.spec.ts`가 `checklists/scr-19.ts`의 기본 상태(계약 diff, 영향 규칙과 블록, Breaking 수, 필터 칩 처리 상태와 Breaking과 대상 계약)와 빈 상태("변경 대기 없음", ADR-029)를 통과하고 ADR 영역은 미노출임을 단언(ADR-035) · 승인 때 그 계약의 `contract` 규칙으로 유형 B 실행이 생기고 규칙이 없으면 `contract` 규칙 제안이 함께 등록됨을 단언 · `pnpm --filter @bive/app cli contract propose-change <dir> <contractId> <file>`가 `contract.proposeChange`를 호출하고 예제 `fixtures/contracts/openapi-v2.yaml`(Breaking 1)을 둔다 | TODO-03 · SCR-19 · ADR-029 · ADR-033 · ADR-035 | #55 |
| M3-11 | 추적성 결함 · 규칙화 불가 | feature | app·store | M1-18·M1-21·M1-25 | `orchestrator/test/traceability.test.ts`가 규칙 없는 요구사항과 부모 없는 규칙의 개수와 목록을 돌려주고 내장 구조 규칙과 '규칙화 불가' 요구사항을 빼는 것을 단언 · `requirement.markUnrulable(id, reason)`이 빈 사유를 `-32001`로 거부하고, `e2e/scr-06-requirement.spec.ts`가 요구사항 상세의 [규칙화 불가]와 사유 입력(빈 사유면 확인 비활성)을 단언 · `e2e/scr-02.spec.ts`가 카드 2줄째 예외 '추적성 결함'과 '규칙화 불가'를 구분해 보이고 SCR-03 카드에 부모 없는 규칙 예외가 보임을 단언 · `e2e/scr-05.spec.ts`가 규칙화 불가 비율 카드와 추적성 결함 카드가 보이고 누르면 SCR-02가 해당 상태 필터로 열림을 단언, `no-rules` 시나리오(rule-writer 제안 0개)를 추가 | NRM-06 · NRM-08 · SCR-02 · SCR-05 · SCR-06 | #56 |
| M3-12 | 규범 변경 이력 | feature | app·store | M1-21·M1-25·M1-28·M3-05·M3-10 | `orchestrator/test/norm-change.test.ts`가 요구사항, 규칙, 계약 변경마다 NormChange(이전과 이후 내용, 시각, 주체, 연결 실행 또는 제안)가 기록됨을 단언 · `e2e/scr-06-history.spec.ts`가 요구사항, 규칙, 계약 상세에 변경 이력 영역이 기본 접힘으로 보이고 펼치면 내용, 시각, 주체, 연결 실행이 보임을 단언 | NRM-07 · SCR-06 | #57 |
| M3-13 | 대기열 유입 상한 · 설정 대기열 섹션 | feature | orchestrator·app | M1-05·M1-08·M1-27·M3-08·M3-09 | `orchestrator/test/queue-limit.test.ts`가 승인 대기 건수가 상한(기본 40)에 이른 뒤의 새 제안이 `-32009`(`QUEUE_LIMIT_REACHED`)로 거부되고 검토 대기열도 상한(기본 40)에서 같음을 단언(ADR-030) · `e2e/scr-17.spec.ts`가 머리줄 "대기 n / 상한 N"이 n이 N 이상이면 빨강이고 사이드바 알림 배지가 빨강, 배지 툴팁에 "유입 상한 도달"이 보임을 단언하고 `e2e/scr-18.spec.ts`가 같은 형식의 머리줄을 단언 · `e2e/scr-21.spec.ts`가 대기열 섹션의 승인 대기 상한과 검토 대기열 상한 입력(1 이상 정수)을 통과하고 체류 기간 상한은 미노출임을 단언 · `bulk-41` 시나리오(rule-writer 제안 41개)를 추가 | TODO-04 · SCR-17 · SCR-18 · SCR-21 · ADR-030 | #58 |
| M3-14 | 재검증 필요 · 격리 전이 · 감시자 | feature | orchestrator | M1-21·M3-01 | `orchestrator/test/watcher.test.ts`가 감시자가 기동 때와 5초마다 기준 브랜치 HEAD를 마지막 판정 커밋과 비교해 대상 블록 include에 걸리는 파일 변경이 있으면 영향 규칙을 '재검증 필요'로 바꾸며 꺼져 있던 동안의 커밋도 잡음을 단언 · 승인된 규칙의 진술이나 대상 블록이 바뀌면 그 규칙이 '재검증 필요'가 됨을 단언 · `orchestrator/test/reproducibility.test.ts`가 같은 커밋 3회 판정이 같음을 단언하고 3회 중 1회라도 다른 `flaky` 변형에서 판정 상태 '격리'와 격리 사유 '재판정 불일치'를 단언 · `scripts/make-variant.sh`에 `touch-lib`(블록 `lib` 파일 1줄 변경 커밋)과 `flaky` 변형을 추가 | JDG-02 · NFR-05 | #59 |
| M3-15 | 준수 추이 그래프 · 변이 카드 | feature | app·store | M1-18·M3-07 | `orchestrator/test/trend.test.ts`가 실행과 커밋별 통과율과 '변이 검증됨' 비율을 저장하고 `verification.trend`가 시간순으로 돌려줌을 단언 · `e2e/scr-05.spec.ts`가 준수 추이 그래프(선 2개, 기간은 가로축 표기만)와 변이 검증됨 카드를 통과하고 변이 카드를 누르면 SCR-03이 `변이: 생존` 필터로 열림을 단언 · `e2e/scr-03.spec.ts`가 변이 필터 칩 활성과 카드 예외 '변이 생존'을 단언 | JDG-04 · JDG-06 · SCR-03 · SCR-05 | #60 |
| M3-16 | 규칙 상세 최신 실행 링크 비용 · 턴 | feature | app | M1-17·M1-28 | `orchestrator/test/rule.test.ts`가 `rule.get`이 최신 실행 ID, 비용 합계(없으면 `null`), 턴을 돌려줌을 단언 · `e2e/scr-06-rule.spec.ts`가 최신 실행 링크에 실행 합계 비용과 턴이 보이고 값이 없으면 '없음'(0 표시 금지)임을 단언 | COST-02 · SCR-03 | #61 |
| M3-17 | 잠정 승인 상태 · 분리 집계 (정책 기본 사용 안 함) | feature | store·orchestrator·app | M1-09·M1-18·M3-06 | `orchestrator/test/provisional.test.ts`가 제안과 규칙의 `provisional` 상태가 준수 분모에서 빠지고 별도로 집계됨을 단언 · 정책 기본값 `off`에서 어떤 제안도 `provisional`이 되지 않음을 단언(ADR-012) · 잠정 항목을 거절하면 유형 D 되돌림 실행이 생김을 단언 · `e2e/scr-05.spec.ts`가 정책이 `off`가 아닐 때만 잠정 카드가 보이고(ADR-035) 누르면 SCR-03이 `잠정` 필터로 열리며 `e2e/scr-17.spec.ts`가 잠정 항목 카드 예외 '잠정'을 단언 | NRM-05 · JDG-03 · SCR-05 · SCR-17 · ADR-012 · ADR-035 | #62 |
| M3-18 | PostgreSQL 지원 | feature | orchestrator·ci | M3-03·M3-04·M3-06 | `scripts/make-variant.sh <dir> postgres`가 Prisma datasource provider를 `postgresql`로 바꾸고 `DATABASE_URL`을 환경 변수로 받게 함 · `orchestrator/test/judge-runner-postgres.test.ts`가 판정 러너가 `schema.prisma` datasource provider로 스택 프로필 `next-prisma-postgres`를 고르고 판정마다 `BIVE_PG_URL` 서버에 임시 데이터베이스를 만들고 지움을 단언 · `ci` 워크플로가 PostgreSQL 16 서비스 컨테이너로 `orchestrator/e2e/pipeline/postgres.test.ts`(구조 검사 실패 판정, `contract` 규칙 유형 B 통과)를 통과 | JDG-01 · ADR-026 | #63 |
| M3-19 | 대상 블록 · 위험도 · 구현 위치 표시 (SCR-02 · SCR-03 · SCR-17) | feature | app | M1-11·M1-25·M1-27·M3-01 | `e2e/scr-06-rule.spec.ts`가 규칙 상세에 대상 블록과 위험도가 보임을 단언 · `e2e/scr-06-requirement.spec.ts`가 요구사항 상세의 구현 위치(자식 규칙의 대상 블록만, 중복 제거)를 단언 · `e2e/scr-03.spec.ts`와 `e2e/scr-02.spec.ts`와 `e2e/scr-17.spec.ts`가 블록과 위험도 필터 칩이 값 개수와 함께 활성화됨을 단언 | NRM-09 · SCR-02 · SCR-03 · SCR-17 | #64 |

### 2.4 M4 설계 화면 · 수집

**목표**: PRD M2의 설계 · 수집 쪽 P1. 기존 프로젝트 동기화, 파서, 수집 COL-01~04, 설계 화면 6개(아키텍처 · L0 · L1 · 흐름도 · ERD · 변경 로그)와 ADR 화면.

**완료 기준 흐름** (M1 흐름의 준비 블록을 새로 실행해 블록 미선언 픽스처로 시작):
1. 설정에 모델 · 한도 저장(M1 흐름의 값에 planner 역할 추가. 저장 전 [BIVE 동기화]는 `SETTINGS_INCOMPLETE`로 거부) → `app` → SCR-01에 [BIVE 동기화](비어 있지 않은 미연결 폴더, ADR-036) → 클릭 → 승인 대기에 설계 제안 1개(종류 태그 "설계", 블록 선언 초안 + ADR 초안) → [승인] → `cli rpc blocks.get` → 블록 1개 이상 → SCR-08에 카드 6개와 L0 · L1 요약 카드.
2. `cli contract register $FX prisma/schema.prisma db-schema` → [승인] → `cli contract register $FX openapi.yaml openapi` → [승인] → 새 규칙 실행("헬스 체크 응답에 서버 시각 포함") → SCR-08 머리줄 실행 선택에 그 실행(이탈 수 표시) → 선택 → 카드 6개 값이 `cli rpc architecture.get '{"runId":"<EXE-ID>"}'`의 값과 같다. 변경량 카드는 기준 실행 5개 미만이라 비교 미표시. 카드를 누르면 정의 · 수치 · 해당 파일 · 기준 실행이 펼쳐진다.
3. [자세히 보기] → SCR-09에서 서버 → DB 연결선 선택 → Prisma 계약 · `contract` 규칙 · 최근 실행. 계약 없는 연결은 경고, 칩 [계약 검사 없는 연결]에 잡힌다. `scripts/make-variant.sh $FX undeclared-import` → SCR-10에서 선언 외 의존이 빨강, 칩 [선언 외 의존]에 잡힌다.
4. `scripts/make-variant.sh $FX extra-endpoint` → 새 규칙 실행("헬스 체크 응답에 버전 포함") → SCR-11에서 `/api/health`가 블록 그룹 아래 있고 테스트 경유 호출은 실선, 정적 분석만은 점선. `/api/extra`에 "계약 미등록" 태그.
5. `scripts/make-variant.sh $FX extra-table` → SCR-12에 Prisma 테이블 · 관계, 추가 테이블은 점선 · 경고, 칩 [명세 외 테이블]에 잡힌다.
6. SCR-14에 2단계 실행의 변경 요약 · 변경 사유("~ implementer") · 관련 ADR · 관련 규범이 있고 ADR 없는 변경 카드에 예외 "ADR 없음". SCR-15에 1단계 ADR이 '채택'이고 규범 연결이 없어 예외 "규범 연결 없음".

**범위 밖**: 지시 액션(M5), FE 내부 분석(ADR-003).

| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |
|---|---|---|---|---|---|---|---|
| M4-01 | 기존 프로젝트 동기화 · [BIVE 동기화] | feature | orchestrator·app | M1-27·M3-02·M4-02·M4-13 | `e2e/scr-01.spec.ts`가 비어 있지 않은 미연결 폴더를 처음 열면 SCR-01에 [BIVE 동기화]가 보이고 빈 폴더와 연결된 폴더에는 없음을 단언(ADR-036) · `orchestrator/test/sync.test.ts`가 `project.sync`의 planner 세션(읽기 도구와 `propose_blocks`만)이 블록 선언 초안과 ADR 초안을 `design_change` 제안으로 등록하고 승인 전에는 모든 파일이 미분류이며 `happy-path`의 동기화 세션이 `fixtures/blocks/sample-next-app.json`과 같은 블록을 제안함을 단언(ADR-021) · 승인 뒤 `blocks.get`이 초안을 돌려주고 parser가 같은 픽스처에서 ERD 모델을 돌려줌을 RPC 테스트로 단언 · `e2e/scr-21-planner-role.spec.ts`가 SCR-21에 planner 역할의 모델과 한도 입력 칸이 있고 비어 있으면 `project.sync`가 `SETTINGS_INCOMPLETE`로 거부됨을 단언 | PRJ-02 · SCR-01 · ADR-021 · ADR-036 | #65 |
| M4-02 | 파서: Prisma 스키마 → ERD 모델 | feature | parser | M3-02·M3-04 | `parser/test/erd.test.ts`가 픽스처 `schema.prisma`에서 `@prisma/internals` `getDMMF`로 테이블, 컬럼, 관계를 추출함을 단언(ADR-033) · 승인된 DB 스키마 계약에 없는 테이블을 '명세 외'로 판별함을 `extra-table` 변형(`scripts/make-variant.sh`에 추가)에서 단언 | DSN-04 · NRM-03 · ADR-033 | #66 |
| M4-03 | 파서: 클론 탐지 · 변경량 · 기준선 (COL-04) | feature | parser·store | M3-02 | `parser/test/clone.test.ts`가 jscpd 출력에서 실행이 새로 만든 클론 쌍(위치, 유사도, 줄 수)만 돌려줌을 단언 · `parser/test/churn.test.ts`가 실행 커밋 범위의 git diff 변경 줄 수와 최근 N개(기본 5) 실행 중앙값을 계산하고 기준 실행이 N개 미만이면 `null`임을 단언(ADR-022) | COL-04 · DSN-02 · ADR-022 · ADR-033 | #67 |
| M4-04 | 수집 COL-01: 인수 테스트 호출 커버리지 | feature | orchestrator·store | M1-16·M1-24 | `orchestrator/test/coverage.test.ts`가 판정 실행 중 판정 서버를 `NODE_V8_COVERAGE`로 띄우고 `c8`로 함수 단위 기록을 만들어 실행과 커밋별로 저장함을 단언(ADR-033) · `coverage.get(runId, functionRef)`가 호출 단위의 테스트 경유 여부를 돌려줌을 단언 | COL-01 · ADR-033 | #68 |
| M4-05 | 수집 COL-02 · COL-03: 테스트 요청 경로 · 계약 매핑 | feature | parser·shared | M3-04 | `parser/test/request-paths.test.ts`가 인수 테스트 파일의 HTTP 경로와 메서드를 TypeScript 컴파일러 API로 정적 스캔해 엔드포인트별 테스트 수를 돌려줌을 단언 · `parser/test/contract-edges.test.ts`가 계약 종류별 L0 연결선 고정 규칙(OpenAPI는 클라이언트와 서버, DB 스키마는 서버와 DB, AsyncAPI는 서버와 큐, 외부 API는 서버와 외부)과 규칙 밖 연결의 '계약 없음'을 단언 · 엔드포인트의 OpenAPI 정의 여부를 경로와 메서드로 대조해 `extra-endpoint` 변형(`scripts/make-variant.sh`에 추가)에서 미정의 1건을 단언 | COL-02 · COL-03 · NRM-03 | #69 |
| M4-06 | 공통 캔버스 컴포넌트 (화면 정의서 1.4) | feature | app | M0-07 | `e2e/canvas.spec.ts`가 이동, 확대, 맞춤과 왼쪽 위 찾기(맞는 노드 파란 테두리, 나머지 흐림, Enter와 ↑↓ 이동, Esc 해제)를 단언 · 빠른 강조 칩이 노드를 숨기지 않고 강조만 하며 오른쪽 아래에 선택 노드 정보 카드가 보임을 단언 | NFR-09 | #70 |
| M4-07 | 아키텍처 화면 (SCR-08) 카드 6종 · 기준 실행 · 펼침 | feature | app·orchestrator | M3-02·M4-03·M4-05·M4-08·M4-09·M4-14·M4-15 | `orchestrator/test/architecture.test.ts`가 `architecture.get(runId)`의 카드 6종 값이 파서 RPC(M4-03, M4-14, M4-15) 스냅샷과 같음을 단언 · `e2e/scr-08.spec.ts`가 `checklists/scr-08.ts`의 기본 상태(카드 이름과 값과 단위, 정의 툴팁, L0와 L1 요약 카드와 [자세히 보기])와 빈 상태(기준 실행 5개 미만이면 변경량 비교 미표시)를 통과 · 머리줄 실행 선택에 변경을 만든 실행만 이탈 수와 함께 보이고 고르면 카드 값이 그 실행 기준으로 바뀜을 단언 · 카드를 누르면 카드 줄 아래에 정의, 수치, 해당 파일, 기준 실행이 펼쳐짐을 단언 | DSN-02 · SCR-08 | #71 |
| M4-08 | L0 시스템 캔버스 (SCR-09) | feature | app | M4-05·M4-06·M4-13 | `e2e/scr-09.spec.ts`가 `checklists/scr-09.ts`의 기본 상태(노드 7종, 연결선 라벨은 경계 계약)와 빈 상태(ADR 없는 노드 이유 "기록 없음", 선언 없는 노드 "이유 없음")를 통과 · 연결선을 고르면 경계 계약, `contract` 검사 규칙, 최근 실행이 보이고 계약이나 검사 규칙이 없으면 경고(에러 상태)임을 단언 · 칩 [계약 검사 없는 연결]을 단언 | DSN-01 · COL-03 · SCR-09 · ADR-003 | #72 |
| M4-09 | L1 블록 캔버스 (SCR-10) | feature | app | M3-02·M4-06·M4-13 | `e2e/scr-10.spec.ts`가 `checklists/scr-10.ts`의 기본 상태(도메인, 공유, 미분류 블록과 의존), 빈 상태(블록 이유 "기록 없음", 미분류 "이유 없음"), 에러 상태(`undeclared-import` 변형의 선언 외 의존 빨강)를 통과 · 블록 선택 정보 카드에 이유(ADR만), 블록 규칙, 최근 실행이 보임을 단언 · 칩 [선언 외 의존]과 [규칙 0개 블록]을 단언 | DSN-01 · SCR-10 | #73 |
| M4-10 | 파서: 엔드포인트별 호출 트리 · 호출 태그 | feature | parser | M3-02·M4-04·M4-05·M4-14·M4-15 | `parser/test/call-tree.test.ts`가 Next.js app router 엔드포인트마다 호출 트리(함수와 메서드 단위, 본문 미포함)를 TypeScript 컴파일러 API로 만들고 블록 그룹을 붙임을 단언 · 호출마다 COL-01 테스트 경유 여부(실선과 점선의 근거)가 붙음을 단언 · 호출 태그 6종(구조 위반과 `file:line`, 명세 외, 명세 외 테이블, 명세 외 의존성, 계약 미등록, 검사 없는 계약)을 파서 근거로만 붙이고 규칙 판정은 붙이지 않음을 단언 | DSN-03 · COL-01 | #74 |
| M4-11 | ERD 캔버스 (SCR-12) | feature | app | M4-02·M4-06·M4-13 | `e2e/scr-12.spec.ts`가 `checklists/scr-12.ts`의 기본 상태(테이블, 컬럼, 관계), 빈 상태(테이블 이유 "기록 없음", 명세 외 "이유 없음"), 에러 상태(`extra-table` 변형의 명세 외 테이블 점선과 경고)를 통과 · 찾기(테이블과 컬럼 이름)와 칩 [명세 외 테이블]이 있고 블록 강조가 없음을 단언 · 테이블 선택 정보 카드에 이유(ADR만)와 관계가 보임을 단언 | DSN-04 · SCR-12 | #75 |
| M4-12 | 변경 로그 모델 · 화면 (SCR-14) | feature | app·store | M4-03·M4-13·M4-15 | `orchestrator/test/code-change.test.ts`가 실행마다 CodeChange(커밋, 파일, 변경 요약, 생성 주체 역할이 붙은 변경 사유, 관련 ADR, 실행 대상 규칙 기준 관련 요구사항과 규칙과 계약)를 저장함을 단언(ADR-008) · 예외 플래그 4종이 파서 결과에서만 정해짐(명세 외는 M4-15 규범 외 추가, 범위 밖은 블록 밖 수정, Breaking은 계약 diff, ADR 없음은 관련 ADR 0개)을 단언 · `e2e/scr-14.spec.ts`가 `checklists/scr-14.ts`의 기본 상태(카드 1줄 변경 요약, 2줄 실행과 예외, 상세는 변경 요약과 "~ 역할명"이 붙은 변경 사유와 관련 ADR과 관련 규범 순서)와 빈 상태("변경 없음", ADR-029)를 통과 · 필터 칩 2종(예외, 실행)이 있고 [제거 지시]와 [규범 편입 지시]는 미노출임을 단언(ADR-035) | DSN-06 · NFR-03 · SCR-14 · ADR-008 · ADR-029 · ADR-035 | #76 |
| M4-13 | ADR 모델 · 화면 (SCR-15) | feature | app·store | M1-21·M1-27 | `orchestrator/test/adr.test.ts`가 ADR(번호, 제목, 상태 제안 또는 채택, 맥락, 결정, 결과, 관련 규범, 연결 실행, 관련 제안)을 저장하고 연결 제안이 승인되면 '채택'이 됨을 단언 · `e2e/scr-15.spec.ts`가 `checklists/scr-15.ts`의 기본 상태(목록의 번호와 제목과 상태, 상세 6항목)와 빈 상태("ADR 없음", ADR-029)를 통과 · 규범 연결이 없는 ADR이 카드 예외 "규범 연결 없음"으로 보이고 필터 칩 3종(상태, 규범 연결, 실행 연결)이 있음을 단언 | DSN-06 · DSN-07 · SCR-15 · ADR-029 | #77 |
| M4-14 | 대상 블록 영향 · 의존성 위반 · 미분류 파일 집계 RPC | feature | orchestrator·parser | M3-02 | `orchestrator/test/arch-metrics.test.ts`가 import 그래프 역방향 의존 수, 선언 외 import, 순환, 공개 API 외 접근, include 매칭 실패 목록을 dependency-cruiser 결과에서 계산함을 단언(ADR-033) · 실행별 스냅샷을 저장하고 `architecture.metrics(runId)`가 돌려줌을 단언 | DSN-02 · ADR-033 | #78 |
| M4-15 | 규범 외 추가 판별 · 블록 밖 수정 측정 | feature | orchestrator·parser | M4-02·M4-05·M4-14 | `orchestrator/test/drift.test.ts`가 실행의 새 엔드포인트 중 OpenAPI 미정의, 새 테이블 중 계약 외, 새 의존성(package.json) 중 규범 연결 없음을 `extra-endpoint`와 `extra-table` 변형에서 판별함을 단언 · 실행 변경 파일과 대상 규칙의 대상 블록 include를 비교해 블록 밖 수정 파일 목록을 차단 없이 저장함을 단언 | DSN-02 · COL-03 · NRM-09 | #79 |
| M4-16 | 흐름도 화면 (SCR-11) | feature | app | M2-01·M4-10 | `e2e/scr-11.spec.ts`가 `checklists/scr-11.ts`의 기본 상태(블록별 그룹과 "테스트 n/m", [호출 트리 / 시퀀스] 전환, 상단 OpenAPI 정의 여부와 인수 테스트 수, 엔드포인트 커버리지)를 통과 · 범례와 함께 실선(테스트 경유)과 점선(정적 분석만)이 구분되고 함수 본문은 표시하지 않음을 단언 · 구조 위반 태그의 `file:line`이 `CodeLink`(사유 선택 뒤 기록)임을 단언 · 필터 칩 4종(블록, 메서드, 테스트, OpenAPI 계약)을 단언 | DSN-03 · COL-02 · MET-01 · SCR-11 | #80 |

### 2.5 M5 지시 · 질문 · 추적성

**목표**: PRD M2의 상호작용 P1. 에이전트 채팅 패널, 항목 단위 질문 · 지시, 설계 화면의 지시 연결, 추적성 맵, 잠정 승인 설정 UI.

**완료 기준 흐름** (M4 흐름을 마친 상태, 같은 셸):
1. 창 폭 1000px(Playwright `page.setViewportSize({width: 1000, height: 800})`) → 채팅이 44px 띠 → 띠 클릭 → 본문 위에 겹쳐 열림. 1200px → 오른쪽 고정.
2. 설정 예산 · 모델에 채팅 역할 모델 · 한도 [저장] → SCR-03에서 규칙 선택 → C 키 → 참조 칩 → [질문] → "이 규칙의 최근 판정은?" → Ctrl+Enter → 답변에 "~ 채팅". `ls -t $BIVE_HOME/projects/*/chat/*.context.json | head -1 | xargs cat` → 참조 규칙의 `rule.get` 응답만 들어 있다. 참조 칩을 지우고 선택을 해제하면 전송 버튼 비활성.
3. 같은 규칙에 [지시] → "응답에 버전도 포함" → 스레드에 "제안 PRP-xxx · 승인 대기" → 승인 대기에서 [승인] → `cli rpc adr.list`에서 그 ADR '채택', `cli rpc run.list`에 새 실행. "중복 코드 제거" 지시 → 유형 D 실행 제안 + ADR.
4. SCR-14 ADR 없는 변경 → [제거 지시] → 승인 대기에 유형 D 실행 제안. [규범 편입 지시] → 요구사항 제안. SCR-08 카드 항목 선택 → [지시] → 채팅이 지시 모드(테두리 강조) + 참조 칩.
5. SCR-07에 요구사항 → 규칙 · 계약 → 실행 → 변경 파일 연결(ADR-032)이 그려지고 실패 · 결함 · 변이 생존이 강조된다. 규칙 노드 클릭 → SCR-06 상세. 파일 노드 클릭 → 사유 모달.
6. 설정 잠정 승인을 '위험도 기준'으로 [저장]('방향 × 위험 2축' 선택지 없음, ADR-031) → `cli blocks set $FX fixtures/blocks/sample-next-app.json` → `quit; app low-risk-rule` → 새 요구사항 저장 → 승인 대기 카드 예외 '잠정', `cli rpc proposal.list`에서 상태 `provisional` · 부여 주체 `policy` → [거절](사유 "범위 밖") → `cli rpc run.list` 마지막 실행 유형 D.

**범위 밖**: 작성 규칙(M6), 자유 지시(ADR-004).

| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |
|---|---|---|---|---|---|---|---|
| M5-01 | 채팅 스레드 모델 · 질문 세션 | feature | orchestrator·store | M1-05·M1-06·M1-07 | `orchestrator/test/chat-ask.test.ts`가 `chat.ask(refs, text)` 세션의 컨텍스트 스냅샷(`$BIVE_HOME/projects/<id>/chat/<sessionId>.context.json`)에 참조 항목의 RPC 조회 결과와 "화면 정보로는 알 수 없음" 지침만 있고 다른 규범과 파일 내용이 없음을 단언 · 질문 세션의 도구 목록이 비어 있고 질문 전후 규범과 판정 테이블이 같음을 단언(ADR-024) · 참조가 비면 `-32001`로 거부하고 답변은 항목별 스레드에 생성 주체 `chat`으로 저장됨을 단언 · `e2e/scr-21-chat-role.spec.ts`가 SCR-21에 채팅 역할의 모델과 한도 입력 칸이 있고 비어 있으면 `chat.ask`가 `SETTINGS_INCOMPLETE`로 거부됨을 단언 | DSN-08 · NFR-03 · ADR-004 · ADR-024 | #81 |
| M5-02 | 에이전트 채팅 패널 (SCR-20) | feature | app | M0-10·M5-01 | `e2e/scr-20.spec.ts`가 `checklists/scr-20.ts`의 기본 상태(오른쪽 고정, [현재 대상] [스레드 n] 탭, 참조 칩, [질문] [지시] 선택, 입력창)와 접힘 상태(창 폭 1100px 미만이면 44px 띠, 누르면 본문 위에 겹쳐 열림)를 통과 · 항목 선택 뒤 C 키나 [채팅에 참조]로 참조 칩이 생기고, 칩을 비우면 현재 선택 항목을 자동 참조하며, 선택도 없으면 전송이 비활성임을 단언(ADR-004) · Ctrl+Enter(⌘↵) 전송, 지시 모드 입력창 테두리 강조, 에이전트 메시지의 "~ 역할명"을 단언 · 스레드를 누르면 해당 화면과 항목으로 이동함을 단언 | SCR-20 · DSN-07 · DSN-08 · ADR-004 | #82 |
| M5-03 | 항목 단위 지시 → 제안 + ADR → 할 일 | feature | orchestrator | M4-13·M5-01 | `orchestrator/test/chat-instruct.test.ts`가 `chat.instruct(refs, text)`의 planner 세션이 규범 변경 제안과 제안 상태 ADR을 등록하고 스레드에 제안 ID와 승인 대기 상태를 기록함을 단언 · 규범 변경이 없는 지시는 ADR과 유형 D 실행 제안으로 등록됨을 단언 · 지시 제안을 승인하면 ADR이 '채택'이 되고 대상 규칙 실행이 생기며(ApprovalLog `run_start`) 거절하면 스레드 상태가 바뀜을 단언 · planner 세션 도구가 제안 생성 도구뿐이고 세션 전후 워크트리와 프로젝트 폴더의 `git status`가 같음을 단언(코드 직접 수정 없음) | DSN-07 · RUN-07 · NRM-04 · ADR-024 | #83 |
| M5-04 | 설계 화면 · 변경 로그 · 규범 상세 · 계약 화면의 지시 연결 | feature | app | M3-05·M4-07·M4-12·M5-02·M5-03 | `e2e/instruct-entry.spec.ts`가 SCR-08 항목 선택 뒤 [지시]가 참조 칩과 함께 채팅 지시 모드를 엶을 단언 · SCR-14 ADR 없는 변경에 [제거 지시]와 [규범 편입 지시]가 보이고 각각 유형 D 제안과 요구사항 제안 종류로 `chat.instruct`를 호출함을 단언 · SCR-06 규칙과 계약 상세의 변경과 삭제 지시, SCR-04 신규 등록 지시가 `chat.instruct`를 호출하고 결과 제안이 승인 대기(신규 계약, 규칙) 또는 계약 변경 승인(기존 계약)에 들어감을 단언 | DSN-07 · SCR-04 · SCR-06 · SCR-08 · SCR-14 | #84 |
| M5-05 | 추적성 맵 (SCR-07) | feature | app·orchestrator | M2-01·M3-07·M3-11·M4-06·M4-12 | `orchestrator/test/trace.test.ts`가 `trace.get`이 요구사항, 규칙과 계약, 실행, 실행 변경 파일 연결을 저장소와 git 기록에서만 만듦을 단언(ADR-032) · `e2e/scr-07.spec.ts`가 `checklists/scr-07.ts`의 기본 상태(연결 전체, 실패와 결함과 변이 생존 강조)와 빈 상태("연결 없음", ADR-029)를 통과 · 항목을 고르면 SCR-06 상세로 이동하고 파일 노드는 `CodeLink`(사유 선택 뒤 기록)임을 단언 | JDG-06 · MET-01 · SCR-07 · ADR-029 · ADR-032 | #85 |
| M5-06 | 설정: 잠정 승인 정책 섹션 · 정책 함수 | feature | app·orchestrator | M3-01·M3-17 | `orchestrator/test/provisional-policy.test.ts`가 '위험도 기준'에서 ADR-031 저위험 기준(규칙 신규 제안, 출처 규칙 자동 생성, 제안 위험도 low, 대상 블록 전부 low)을 만족하는 제안만 잠정 상태와 부여 주체 '정책'으로 기록됨을 단언 · `orchestrator/test/integrity.test.ts`가 역할 세션 도구 목록에 잠정 부여 도구가 없음을 단언 · `e2e/scr-21.spec.ts`가 잠정 승인 섹션(기본 '사용 안 함', '위험도 기준' 선택 가능, '방향 × 위험 2축' 미노출)을 통과(ADR-031) · `low-risk-rule` 시나리오(대상 블록 `lib`, 위험도 low 규칙 제안 1개)를 추가 | NRM-05 · NFR-01 · SCR-21 · ADR-012 · ADR-031 | #86 |
| M5-07 | 제안 종류 태그 전체 · 설계 변경 제안 상세 · 연결 ADR 표시 | feature | app | M3-10·M5-03 | `e2e/scr-17.spec.ts`가 종류 태그 6종(신규, 변경, 요구사항, 요구사항 변경, 설계, 제목) 카드를 단언 · 설계 변경 제안 상세(diff, 근거, 연결 ADR)와 `e2e/scr-19.spec.ts`의 연결 ADR 영역이 보임을 단언 · 출처가 구현 중인 제안에 카드 예외 "구현 중 제안"이 보임을 단언 · 모든 종류의 제안에서 승인 전 [수정]이 되고 수정 diff와 주체가 기록됨을 단언 | NRM-04 · TODO-01 · SCR-17 · SCR-19 | #87 |

### 2.6 M6 확장

**목표**: PRD M3(P2). 요구사항 역추출, 자동 모드, 실행 추적 화면, 의존성 화면, 작성 규칙, 패키징과 성능 측정.

**완료 기준 흐름** (M5 흐름을 마친 상태, 같은 셸. 1단계는 M4 흐름 1처럼 새 픽스처를 동기화한 뒤):
1. SCR-01 [요구사항 자동 생성] → `cli rpc proposal.list '{"state":"pending"}'`의 새 제안이 전부 출처 `reverse_extraction`이고 잠정 정책이 '위험도 기준'이어도 상태 `pending`.
2. 설정 자동 모드: 사람이 [실행]을 확인한 실행이 없는 새 프로젝트에서는 토글 비활성 → 새 규칙 실행 1회 → 토글 켜기 → 다음 [실행]은 확인 대화 없이 실행 생성(`cli rpc run.list` 증가) → 새 요구사항의 규칙 제안은 여전히 승인 대기.
3. SCR-16에 실행 카드 · 가로 스테퍼 · 단계 선택 시 수치 줄(비용 · 예산 · 턴 · 토큰 입력 · 출력 · 첫 턴 캐시 쓰기 · 실행 시간) · 이벤트 로그가 있고, `false-pass` 시나리오 실행의 "통과" 보고에 판정 근거 아님 표시. M1 흐름 10처럼 중단시킨 실행에서 [재개].
4. `scripts/make-variant.sh $FX unused-dep` → SCR-13에 외부 패키지 · 사용처 · 영향 블록, 추가한 패키지에 '미사용'.
5. 설정 작성 규칙에서 rule-writer 규칙 제목 지침을 바꾸고 [저장] → [미리보기] → 규칙 3개 결과 → [기존 규칙에 적용] → 승인 대기에 종류 태그 "제목" 제안 → `cli rpc rule.get`의 진술이 그대로.
6. `pnpm package` → `ls dist/*.AppImage` 1개. `pnpm perf` → `artifacts/perf/<날짜>.json`에 `staticCheckMs` · `screenUpdateMs` 숫자.

**범위 밖**: 이의 제기(PRD 미결 #7), 체류 기간 상한, NFR-08 목표치(미정).

| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |
|---|---|---|---|---|---|---|---|
| M6-01 | 요구사항 자동 생성 (코드 역추출) | feature | orchestrator·app | M3-04·M3-06·M4-01·M5-06 | `orchestrator/test/reverse-extract.test.ts`가 planner 세션(읽기 도구와 제안 도구만)이 동기화된 블록 선언과 파서 결과(엔드포인트 목록, ERD, 테스트 요청 경로)만 입력으로 받아 요구사항, 규칙, 계약 제안을 출처 `reverse_extraction`으로 승인 대기에만 등록함을 단언 · 정책이 '위험도 기준'이어도 역추출 제안이 잠정 상태가 되지 않음을 단언(ADR-031) · `e2e/scr-01.spec.ts`가 동기화 직후(요구사항, 규칙, 계약 없음) [요구사항 자동 생성]이 보임을 단언하고, 승인된 역추출 규칙이 유형 C 실행으로 테스트를 등록함을 단언 | PRJ-03 · RUN-07 · SCR-01 · ADR-031 | #88 |
| M6-02 | 자동 모드 | feature | orchestrator·app | M1-19 | `orchestrator/test/auto-mode.test.ts`가 자동 모드에서 프로젝트 첫 실행이 사람 확인으로 시작된 뒤부터 실행 시작 확인을 생략하고 규범 승인 단계는 생략하지 않음을 단언(ADR-023) · `e2e/scr-21.spec.ts`가 사람 확인 실행이 없으면 자동 모드 토글이 비활성임을 단언 | RUN-05 · SCR-21 · ADR-023 | #89 |
| M6-03 | 실행 추적 (SCR-16) 이벤트 로그 저장 · 실행 목록 · 필터 | feature | app·orchestrator | M1-17·M3-06 | `orchestrator/test/run-events.test.ts`가 단계, 에이전트 메시지, 실행기 출력 이벤트를 실행별로 저장하고 `run.events(runId)`가 순서대로 돌려줌을 단언 · `e2e/scr-16.spec.ts`가 `checklists/scr-16.ts`의 실행 목록 기본 상태(카드 1줄 실행 목표, 2줄 ID와 상태와 예외와 시각, 예외 6종)와 빈 상태("실행 없음", ADR-029)를 통과 · 필터 칩 4종(상태, 유형, 대상 블록, 예산)을 단언 | RUN-06 · SCR-16 · ADR-029 | #90 |
| M6-04 | 의존성 화면 (SCR-13) · 패키지 사용처 파서 | feature | app·parser | M3-02·M4-15 | `parser/test/packages.test.ts`가 package.json 의존성마다 사용 파일, 사용 블록, 미사용 여부를 dependency-cruiser 결과로 계산함을 `unused-dep` 변형(`scripts/make-variant.sh`에 추가)에서 단언(ADR-033) · `e2e/scr-13.spec.ts`가 `checklists/scr-13.ts`의 기본 상태(패키지 목록, 사용처, 미사용, 영향 블록)와 빈 상태("외부 패키지 없음", ADR-029)를 통과 · 필터 칩 3종(사용, 출처, 사용 블록)을 단언 | DSN-05 · SCR-13 · ADR-029 · ADR-033 | #91 |
| M6-05 | 작성 규칙 (NRM-10) 모델 · 설정 섹션 · 세션 주입 | feature | orchestrator·app·store | M1-08·M5-03 | `orchestrator/test/writing-rules.test.ts`가 역할 5종과 문장 종류별 지침을 프로젝트 단위로 저장하고 변경 주체와 시각을 기록함을 단언 · 세션 시작 때 역할 지침이 시스템 프롬프트의 고정 부분(진술 형식, 검사, 판정 구조) 뒤에 들어가고 고정 부분은 지침으로 바뀌지 않음을 프롬프트 스냅샷으로 단언 · `e2e/scr-21.spec.ts`가 작성 규칙 섹션(지침 카드, 좋은 예와 나쁜 예, 고정 부분 표시, [기본값] [저장], 마지막 변경 시각)을 통과 · 지침을 바꾼 뒤 승인된 규범이 바뀌지 않음을 단언 | NRM-10 · SCR-21 · ADR-009 | #92 |
| M6-06 | 패키징 · 성능 측정 · 지원 환경 needs-human | chore | ci·app | M1-23 | `pnpm package`가 electron-builder로 Linux 산출물(AppImage)을 `dist/`에 만들고 `ci`가 아티팩트로 올림 · Windows와 macOS electron-builder 설정 파일이 있고 실기기 빌드와 실행 확인 needs-human 이슈 2개가 등록됨 · `pnpm perf`가 픽스처에서 정적 검사(파서 전체)와 화면 갱신(`event.run.updated` 송신부터 SCR-05 렌더 완료까지) 시간을 재서 `artifacts/perf/<날짜>.json`에 `staticCheckMs`와 `screenUpdateMs`로 기록 | NFR-08 · NFR-10 | #93 |
| M6-07 | 실행 추적 (SCR-16) 스테퍼 · 수치 줄 · 이벤트 · [재개] | feature | app | M6-03 | `e2e/scr-16.spec.ts`가 가로 스테퍼(칸 최소 52px, 이름 최대 2줄, 좁으면 가로 스크롤, 지나온 구간 초록, 미도달 회색, 생략 단계 흐림과 "생략")를 단언 · 단계를 고르면 수치 줄이 그 단계의 비용, 예산, 턴, 토큰(입력, 출력), 첫 턴 캐시 쓰기 토큰, 실행 시간과 세션별 역할과 모델로 바뀜을 단언 · 이벤트 로그에서 에이전트 "통과" 보고에 판정 근거 아님 표시가 붙음을 단언 · `interrupted` 실행의 [재개]가 `run.resume`을 호출함을 단언 | RUN-06 · COST-02 · SCR-16 · ADR-007 · ADR-011 | #94 |
| M6-08 | 작성 규칙 미리보기 · [기존 규칙에 적용] | feature | orchestrator·app | M6-05 | `e2e/scr-21.spec.ts`가 [미리보기]가 rule-writer 지침으로 규칙 3개의 제목 재생성 결과를 보이고 규범은 그대로임을 단언 · `orchestrator/test/writing-rules-apply.test.ts`가 [기존 규칙에 적용]이 규칙마다 `rule_title_change` 제안을 승인 대기에 등록하고 진술과 판정은 그대로임을 단언 | NRM-04 · NRM-10 · TODO-01 · SCR-21 | #95 |

## 3. 커버리지 표

| ID | 종류 | 우선 | 마일스톤 | 이슈 키 | 비고 |
|---|---|---|---|---|---|
| PRJ-01 | 요구사항 | P0 | M1 | M1-01 | 비어 있지 않은 미연결 폴더 ADR-036 |
| PRJ-02 | 요구사항 | P1 | M4 | M4-01 | 최초 블록 선언 ADR-021 |
| PRJ-03 | 요구사항 | P2 | M6 | M6-01 |  |
| NRM-01 | 요구사항 | P0 | M1 | M1-02·M1-04·M1-25 | 지시 경로는 M5-04 |
| NRM-02 | 요구사항 | P0 | M1 | M1-08·M1-11·M1-28 |  |
| NRM-03 | 요구사항 | P1 | M3(부분)·M4 | M3-04·M3-05·M4-02·M4-05 | 연결 단위 ADR-019, 검사 도구 ADR-033 |
| NRM-04 | 요구사항 | P0 | M1(부분)·M5(부분)·M6 | M1-09·M1-27·M5-03·M5-07·M6-08 | 직접 수정 RPC 없음 M1-09 |
| NRM-05 | 요구사항 | P1 `미정` | M3(부분)·M5 | M3-17·M5-06 | `미정` ADR-012 · 저위험 기준 ADR-031 |
| NRM-06 | 요구사항 | P1 | M3 | M3-03·M3-11 | 내장 구조 규칙 · 규칙화 불가 제외 |
| NRM-07 | 요구사항 | P1 | M3 | M3-12 |  |
| NRM-08 | 요구사항 | P1 | M3 | M3-11 |  |
| NRM-09 | 요구사항 | P1 | M3(부분)·M4 | M3-01·M3-07·M3-19·M4-15 |  |
| NRM-10 | 요구사항 | P2 | M6 | M6-05·M6-08 |  |
| RUN-01 | 요구사항 | P0 | M1 | M1-12·M1-14·M1-20 |  |
| RUN-02 | 요구사항 | P0 | M1(부분)·M3 | M1-12·M1-14·M1-19·M1-21·M3-03·M3-07 | 변이 단계 M3-07, 구조 검사 단계 M3-03 |
| RUN-03 | 요구사항 | P0 | M1 | M1-15·M1-21 |  |
| RUN-04 | 요구사항 | P0 | M1(부분)·M3 | M1-06·M1-15·M1-16·M3-07 |  |
| RUN-05 | 요구사항 | P2 | M6 | M6-02 | ADR-023 |
| RUN-06 | 요구사항 | P2 | M6 | M6-03·M6-07 | 토큰은 M6-07 수치 줄 |
| RUN-07 | 요구사항 | P1 `미정` | M0(부분)·M3(부분)·M5(부분)·M6 | M0-03·M3-06·M5-03·M6-01 | `미정` ADR-020 (M0-03은 유형 enum) |
| RUN-08 | 요구사항 | P0 | M1 | M1-13·M1-16·M1-21·M1-29 | 병합 시 기준 브랜치 변경 ADR-017 |
| JDG-01 | 요구사항 | P0 | M1(부분)·M3 | M1-15·M1-16·M1-24·M1-29·M3-18 | 판정 러너 ADR-026 |
| JDG-02 | 요구사항 | P0 | M0(부분)·M1(부분)·M3 | M0-03·M1-11·M1-16·M1-28·M3-14 |  |
| JDG-03 | 요구사항 | P0 | M1(부분)·M3 | M1-18·M3-17 |  |
| JDG-04 | 요구사항 | P1 | M3 | M3-07·M3-15 |  |
| JDG-05 | 요구사항 | P1 | M3 | M3-02·M3-03 |  |
| JDG-06 | 요구사항 | P1 | M3(부분)·M5 | M3-15·M5-05 | → 코드 연결 ADR-032 |
| DSN-01 | 요구사항 | P1 | M3(부분)·M4 | M3-02·M4-08·M4-09 |  |
| DSN-02 | 요구사항 | P1 | M4 | M4-03·M4-07·M4-14·M4-15 | 검사 도구 ADR-033 |
| DSN-03 | 요구사항 | P1 | M4 | M4-10·M4-16 |  |
| DSN-04 | 요구사항 | P1 | M4 | M4-02·M4-11 |  |
| DSN-05 | 요구사항 | P2 | M6 | M6-04 |  |
| DSN-06 | 요구사항 | P1 | M4 | M4-12·M4-13 |  |
| DSN-07 | 요구사항 | P1 | M4(부분)·M5 | M4-13·M5-02·M5-03·M5-04 |  |
| DSN-08 | 요구사항 | P1 | M5 | M5-01·M5-02 |  |
| TODO-01 | 요구사항 | P0 | M1(부분)·M5(부분)·M6 | M1-09·M1-10·M1-27·M5-07·M6-08 |  |
| TODO-02 | 요구사항 | P1 | M3 | M3-08·M3-09 | 이의 제기는 PRD 미결 #7 |
| TODO-03 | 요구사항 | P1 | M3 | M3-10 | 구현 중 계약 변경 처리는 미정 |
| TODO-04 | 요구사항 | P1 | M3 | M3-13 | 상한 경계 · 검토 대기열 상한 ADR-030, 체류 기간 상한 미정 |
| COST-01 | 요구사항 | P0 | M1(부분)·M3 | M1-05·M1-17·M1-21·M3-08 |  |
| COST-02 | 요구사항 | P1 | M1(부분)·M3(부분)·M6 | M1-17·M1-18·M3-16·M6-07 | M1에서 시작(0절 예외), 단계 상세 M6-07 |
| MET-01 | 요구사항 | P1 | M2(부분)·M4(부분)·M5 | M2-01·M2-02·M2-03·M4-16·M5-05 | IDE 기본값 ADR-018 |
| COL-01 | 요구사항 | P1 | M4 | M4-04·M4-10 | 수집 도구 ADR-033 |
| COL-02 | 요구사항 | P1 | M4 | M4-05·M4-16 |  |
| COL-03 | 요구사항 | P1 | M4 | M4-05·M4-08·M4-15 |  |
| COL-04 | 요구사항 | P1 | M4 | M4-03 | N은 ADR-022 |
| NFR-01 | 비기능 | — | M0(부분)·M1(부분)·M5 | M0-04·M1-09·M1-22·M1-29·M5-06 | 에이전트 승인 불가 · 해시 체인 ADR-027 |
| NFR-02 | 비기능 | — | M1 | M1-07·M1-15·M1-16·M1-22·M1-26·M1-29 | 경로 매트릭스는 ADR-024 (PRD `미정`) |
| NFR-03 | 비기능 | — | M0(부분)·M4(부분)·M5 | M0-01·M0-07·M4-12·M5-01 | 제품 코드 목 데이터 금지 ESLint 규칙(M0-01) · 화면 문구 검사(M0-07) |
| NFR-04 | 비기능 | — | M1 | M1-07·M1-22·M1-26 | 네트워크 허용 범위 PRD `미정`, 외부 연결 0건 시험 M1-22 |
| NFR-05 | 비기능 | — | M3 | M3-14 |  |
| NFR-06 | 비기능 | — | M0(부분)·M1 | M0-05·M0-06·M1-20·M1-23·M1-29 | Windows는 needs-human (M1-23) |
| NFR-07 | 비기능 | — | M1 | M1-05·M1-12 |  |
| NFR-08 | 비기능 | — | M6 | M6-06 | 목표치 미정 |
| NFR-09 | 비기능 | — | M0(부분)·M1(부분)·M4 | M0-07·M0-10·M1-03·M4-06 | 모든 화면 이슈의 체크리스트가 문구 검사(M0-07) |
| NFR-10 | 비기능 | — | M0(부분)·M1(부분)·M6 | M0-01·M0-05·M0-06·M1-23·M6-06 | Windows 완주 needs-human (M1-23) |
| SCR-01 | 화면 | P0/P1/P2 | M1(부분)·M4(부분)·M6 | M1-01·M4-01·M6-01 | 빈 상태 ADR-036 |
| SCR-02 | 화면 | P0/P1 | M1(부분)·M3 | M1-04·M3-11·M3-19 |  |
| SCR-03 | 화면 | P0/P1 | M1(부분)·M2(부분)·M3 | M1-11·M1-19·M1-28·M2-01·M3-15·M3-16·M3-19 |  |
| SCR-04 | 화면 | P1 | M3(부분)·M5 | M3-05·M5-04 |  |
| SCR-05 | 화면 | P0/P1 | M1(부분)·M2(부분)·M3 | M1-18·M1-19·M2-02·M3-11·M3-15·M3-17 | [재개] ADR-011, 미노출 카드 ADR-035 |
| SCR-06 | 화면 | P0/P1 | M1(부분)·M3(부분)·M5 | M1-25·M1-28·M3-11·M3-12·M5-04 |  |
| SCR-07 | 화면 | P1 | M5 | M5-05 |  |
| SCR-08 | 화면 | P1 | M4(부분)·M5 | M4-07·M5-04 |  |
| SCR-09 | 화면 | P1 | M4 | M4-08 |  |
| SCR-10 | 화면 | P1 | M4 | M4-09 |  |
| SCR-11 | 화면 | P1 | M4 | M4-16 |  |
| SCR-12 | 화면 | P1 | M4 | M4-11 |  |
| SCR-13 | 화면 | P2 | M6 | M6-04 |  |
| SCR-14 | 화면 | P1 | M4(부분)·M5 | M4-12·M5-04 |  |
| SCR-15 | 화면 | P1 | M4 | M4-13 |  |
| SCR-16 | 화면 | P2 | M6 | M6-03·M6-07 | [재개]는 M1-18에 선반영 ADR-011 |
| SCR-17 | 화면 | P0 | M1(부분)·M3(부분)·M5 | M1-10·M1-27·M3-13·M3-17·M3-19·M5-07 | 상한 표시 M3-13 (ADR-030) |
| SCR-18 | 화면 | P1 | M3 | M3-09·M3-13 |  |
| SCR-19 | 화면 | P1 | M3(부분)·M5 | M3-10·M5-07 |  |
| SCR-20 | 화면 | P1 | M0(부분)·M5 | M0-10·M5-02 | M0-10은 360px 자리만 |
| SCR-21 | 화면 | P0/P1/P2 | M1(부분)·M2(부분)·M3(부분)·M5(부분)·M6 | M1-05·M2-03·M3-13·M5-06·M6-02·M6-05·M6-08 | M1은 예산 · 모델만 ADR-010 · ADR-035 |

## 4. needs-human 후보

| 항목 | 시점 | 사람이 할 일 |
|---|---|---|
| 프로토타입 원본 | 지금 | `docs/prototype/`에 프로토타입 v5 HTML 추가 (prototype-map.md 표 4 이름으로) |
| 실제 Claude 인증 완주 | M1 끝 | 구독 로그인 또는 API 키로 M1 완료 기준 흐름 1회 수행, 결과를 이슈에 기록 (M1-23) |
| Windows 완주 | M1 끝 | Windows에서 설치 · named pipe · 앱 종료 후 실행 유지 확인, 결과 코멘트 (M1-23, M1 완료 기준 흐름 15) |
| 패키징된 앱의 SDK 내장 실행 파일 호출 | M1 끝 | PRD 5.1 "확인 필요": 패키징 빌드에서 SDK 실행 파일 호출 실측 (M1-23) |
| 에이전트 세션 메모리 | M1 끝 | PRD 5.1 "확인 필요": 세션당 메모리 사용량 실측(약 1GB가 출발점) (M1-23) |
| 실제 프로젝트 시작 | M2 | PRD "M1 직후 측정 시작": 작은 실제 프로젝트를 BIVE로 시작 |
| 브랜치 보호 | M0 끝 | 권한이 없으면 `ci`를 required status check로 등록 |
| ADR 확인 | 수시 | `docs/decisions.md` 제안 항목 채택 · 기각 (특히 ADR-033 변이 생성 방식) |
| macOS · Windows 패키징 | M6 | 실기기 빌드 · 실행 확인 (M6-06) |

## 5. 변경 이력

- 2026-10-15 v1 작성. PRD v0.9 · 화면 정의서 v0.5 기준. 마일스톤 7개, 이슈 81개.
- 2026-10-15 v2 검토(REQUEST_CHANGES) 반영. 수용 기준을 전 이슈 4항목 이하 · 테스트 파일 · 명령 · 오류 코드 명시로 재작성, 완료 기준 흐름을 헤드리스 실행 가능 명령으로 재작성(준비 블록 · `BIVE_SCENARIO` · pid 파일 · `cli`), M1 흐름에 PRD 6장 M1 기준 대응 단계(예산 초과 · 끊김 · 앱 종료 유지 · 금지 경로 · 승인 호출 거부 · Windows) 추가. 분할 9건(M0-06→M0-10, M1-04→M1-25, M1-06→M1-26, M1-10→M1-27, M1-11→M1-28, M1-21→M1-29, M4-10→M4-16, M6-03→M6-07, M6-05→M6-08), 추가 2건(M1-24 판정 러너, M3-19 대상 블록 · 위험도 표시). 의존 보강 · 범위 중복 정리 · 커버리지 양방향 일치. 새 ADR-029~036. 이슈 81개 → 92개(M0 10 · M1 29 · M2 3 · M3 19 · M4 16 · M5 7 · M6 8).
- 2026-10-15 2차 검토 반영: 의존 5곳 추가(M1-20 · M1-22 · M1-25 · M3-12 · M4-01), 변이 주입 · planner · 채팅 역할의 설정 칸(M3-07 · M4-01 · M5-01), M4 흐름 설정 저장을 1단계로, `.bive.json` 미추적 처리(M1-13 · M3 흐름 5), 도구 기록 결과 `denied` + 사유로 통일.
- 2026-10-15 발행: 마일스톤 7개, 이슈 92개 (GitHub #1~#7 마일스톤, 이슈 #4~#95). `scripts/publish-roadmap.py`로 발행하고 `이슈` 열에 번호를 기록.
- 2026-10-16 M0 흐름 2의 스크린샷 경로를 ADR-043(SCR-00 · 상태 이름)에 맞게 수정 (#109).
