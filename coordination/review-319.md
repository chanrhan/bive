너는 chanrhan/bive 저장소의 이슈 #319(로드맵 M3-56 "예산 초과 액션: 이어받는 실행 · 한도 상향 재개")의 PR을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경 한 줄
검토 대기열의 예산 초과 항목에 첫 액션 "한도 상향 재개"를 넣는다. 종료 상태 `budget_exceeded`는 그대로 두고 **이어받는 새 실행**을 만든다(ADR-147). 이 PR의 범위(ADR-150으로 좁혀짐): 연결 표 `run_continuations`(마이그레이션 `project/0030_run_continuations`) · 뷰 `run_reinforcement_causes`를 사슬로 다시 만듦 · RPC `reviewQueue.resumeWithBudget` · 새 한도의 검증과 사슬 누적 · 항목 처리 · 보강 사슬 판별. **이어받는 실행은 기준 커밋에서 첫 단계부터 돈다.** 중간 시작(원 실행의 단계를 이어받아 뒤 단계부터 돎)은 이 PR에 없다(이슈 #325, M3-60): 그것이 없다는 것은 지적 대상이 아니다.

## 받은 값
- PR 번호 · 헤드 SHA는 조율자가 아래 프롬프트에서 준다. 브랜치 `feat/319-run-continuation`, 기준 main `25bc959`. `ci` 결과는 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<HEAD>/check-runs`로 네가 확인한다.
- 네 작업 공간에서 `git fetch origin feat/319-run-continuation` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-319.md`(구현자가 받은 지시서. 그 가운데 4번 "중간 시작"은 M3-60으로 옮겨졌다) · `brief-common.md` · `m3-handoff.md`의 "M3-08" · "M3-55 뒤의 로드맵 사실" · "M3-59 뒤의 로드맵 사실" · "M3-49" · "M3-54" · "M3-31" 절 · `a319-body.md`(PR 본문 초안. 실제 본문은 `scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/<번호>`로 읽는다).
3. 이슈 #319 본문의 수용 기준 4개(발행으로 좁혀진 지금 문장).
4. `docs/decisions.md`의 ADR-149(이 PR이 더함) · **ADR-147 전부** · **ADR-150 전부** · ADR-145 · ADR-143(⑮) · ADR-136 · ADR-104 · ADR-105 · ADR-107 · ADR-061 · ADR-142(구조 시험). `docs/spec/prd.md`의 TODO-02 · COST-01 · NFR-01 · NFR-02.

## 구현자가 정한 것 (네가 타당성을 판정한다)
- 표 `run_continuations`: 이어받는 실행 ID UNIQUE, **원 실행 ID에도 UNIQUE**(사슬 원 → 1차 → 2차는 되고 가지는 없다. "끝나지 않은 이어받는 실행은 하나"보다 강함: 원 실행의 예산 초과 항목은 하나이고 처리는 한 번이라 막히는 경우가 없다는 판단). 트리거 `run_continuations_insert` · `_no_update` · `_no_delete` · `runs_continuation_base_commit`(기준 커밋 확인을 넣을 때가 아니라 `runs.base_commit`을 쓸 때 봄: 원 실행이 워크트리를 만들기 전에 끝났으면 제약 없음) · `mutation_reinforcements_continuation` · `review_reinforcements_continuation` · `review_items_resolve_raise_limit`.
- 뷰 `run_reinforcement_causes`를 `WITH RECURSIVE`로 다시 만듦(0028 파일은 그대로). `link_kind`는 사슬 뿌리의 연결 종류.
- 처리기 `reviewQueue.resumeWithBudget`은 `ipc/run-handlers.ts`(구조 시험 "`createRun(`을 부르는 곳"). 순서: 사람 주체 확인(-32020, 저장소를 열기 전) → 항목 확인 → 한도 검증 → `createRun`(다섯째 인자 `RunContinuationSeed`: 새 실행의 `budgetSnapshot`과 원 실행) → 연결 → 항목 처리. 트랜잭션 1개.
- 한도 검증 `assertRaisedBudget`(-32001 + `data.fields`): `BUDGET_SHAPE_MISMATCH` · `BUDGET_LOWERED` · `BUDGET_NOT_ABOVE_SPENT`. "닿은 값" 판정은 `session-budget.ts`의 `budgetValueUsages` · `limitReached`(엔진의 판정과 같은 계산이라는 주장).
- 엔진의 `sessionLimits` · `budgetOverrun` · `runRemaining`이 `lineageSessions`(사슬 전체의 세션)를 센다. 이어받는 실행이 아니면 같은 배열.
- 처리 액션 값 `raise_limit_resume`은 0028의 CHECK와 shared에 이미 있어 표를 다시 만들지 않았다(처리 결과 트리거와 shared `ReviewResolution`의 모양만 더함).
- `worktree-manager.create`에 `start` 입력(시작 커밋이 원 실행 브랜치에 있는지 · 기준 커밋이 그 조상인지 git 객체로 확인, 아니면 `start_commit_unavailable`). 지금은 시작 커밋 = 원 실행의 기준 커밋.
- 회귀 수는 실행마다 센다(사슬 누적은 M3-60).

## 꼭 판정할 것
1. **범위와 불변.** `git diff 25bc959...HEAD --stat`. `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · 워크플로 · 머지된 마이그레이션(0001 ~ 0029)이 바뀌지 않았는가. 기존 시험 파일의 `-` 줄 전부. **이어받는 실행이 아닌 실행의 동작이 글자까지 그대로인가**: `pipeline-engine.ts`(+18) · `session-budget.ts`(+52) · `run-service.ts`(+26) · `worktree-manager.ts`(+66)의 변경이 보통 실행의 한도 계산 · 실행 생성 · 가지 만들기를 바꾸지 않는가(기존 `budget.test.ts` · `engine.test.ts` · `worktree` 시험이 고쳐지지 않고 통과하는가). `steps/`가 바뀌지 않았는가.
2. **마이그레이션 0030 (가장 먼저, 꼼꼼히).**
   - 트리거 SQL을 줄마다 읽는다. `run_continuations_insert`의 조건(원 실행이 `budget_exceeded` · 새 실행이 사람 시작 · 유형과 대상 규칙이 같음)이 빠짐없는가, 직접 SQL로 어긋난 행(다른 유형 · 다른 대상 · 원 실행이 다른 종료 상태 · 자기 자신을 잇기 · 순환 A → B → A)을 넣어 본다. **순환 · 깊은 사슬에서 `WITH RECURSIVE` 뷰가 끝나는가**(순환이 트리거로 막히는가, 뷰에 깊이 상한이 있는가. 이 뷰는 실행 종료 저장의 트리거(0028 자동 등록)가 읽는다: 뷰가 끝나지 않거나 실패하면 **실행 종료 저장 자체가 막힌다**).
   - 원 실행 ID UNIQUE의 타당성: 원 실행의 항목이 처리된 뒤 이어받는 실행이 **예산 초과가 아닌 이유로 끝나면**(예: `failed`) 원 실행을 다시 이을 길이 없다(구현자 한계). 그 경우 사람에게 남는 길이 무엇인가(새 `run.create`). ADR-147 ② "원 실행 하나에 끝나지 않은 이어받는 실행은 많아야 하나"보다 강하게 한 것이 받아들일 만한가.
   - `runs_continuation_base_commit`: 기준 커밋을 "쓸 때" 확인하는 방식에서 빠져나가는 길(기준 커밋이 이미 쓰인 실행을 나중에 잇는 순서 · 원 실행의 기준 커밋이 null인 경우 · `UPDATE OF base_commit`이 아닌 경로로 값이 들어가는 경우).
   - 다시 만든 뷰를 읽는 0028의 트리거 둘(`AFTER UPDATE OF status ON runs`의 자동 등록)과 `review_items_insert`가 0030 적용 뒤에도 그대로 동작하는가(`sqlite_master`를 0029 적용 뒤와 0030 적용 뒤로 떠서 바뀐 객체가 뷰 하나와 새 객체뿐인지 비교). 0029가 다시 만든 `judgments`와 0028의 `review_items_resolve_quarantine`이 0030 뒤에도 그대로인가.
   - `mutation_reinforcements_continuation` · `review_reinforcements_continuation`이 무엇을 막는가(이어받는 실행이 연결 표에 직접 행을 갖지 못하게: "한 실행은 보강 원인이 하나"). 0028의 "한 실행은 두 연결 가운데 하나만"과 합쳐 한 실행의 원인 변이 기록이 늘 0개 또는 1개인가(뷰가 한 실행에 두 행을 내는 길이 있으면 자동 등록 트리거의 부분 UNIQUE에 걸려 종료 저장이 막힌다: M3-08 검토에서 나온 것과 같은 종류).
   - `review_items_resolve_raise_limit`: `raise_limit_resume` 처리에 연결(그 항목의 실행을 원 실행으로 하는 `run_continuations` 행)이 실제로 있어야 하는가. 다른 실행의 연결로 처리할 수 있는가.
   - 기존 DB(0029까지, 실행 · 항목 · 보강 연결이 있는 것)에 적용되는가. 행 보존 · 외래 키 · 트랜잭션.
3. **한도 (COST-01, 수용 기준 2).**
   - `assertRaisedBudget`: 새 한도의 모양(실행 전체 · 역할별, USD · 턴), 역할 집합이 다름 · 어느 값이든 내림 · 닿은 값이 쓴 양 이하의 거부. 경계(같은 값 · 0 · 음수 · 아주 큰 값 · 소수 · `null`인 한도(한도 없음을 뜻하는 값이 있는가: 있으면 한도 없음 → 유한 값은 "내림"인가)).
   - "닿은 값"의 판정이 엔진이 세션을 열지 않는 판정과 **같은 함수**인가(따로 구현했으면 어긋날 수 있다: 두 판정이 다른 입력을 찾는다). 예산 초과의 원인별로 재개가 되는가: 실행 전체 USD · 역할별 USD · 턴 수 · 하루 한도(`project_daily_budget_exceeded`: 이 액션이 하루 한도를 바꾸지 않고 사람 실행의 규칙대로 세션을 열 때 다시 `budget_exceeded`가 되는가) · `queued`에서 바로 예산 초과가 된 실행(원 실행이 쓴 양 0).
   - `lineageSessions`: 사슬 전체의 세션을 값마다(실행 전체 · 역할별, USD · 턴) 이어 세는가. 사슬 2단(원 → 1차 → 2차)에서 2차의 잔여 = 2차 한도 − (원 + 1차 + 2차의 사용). **이어받기로 한도를 우회하는 길이 없는가**(1차의 한도를 원 실행의 한도와 같게 두고 "닿지 않은 값"만 있으면 통과하는가 → 그러면 새 실행이 원 실행의 사용량을 이어 세므로 곧 다시 막히는가. 누적이 빠지는 자리(세션 기록이 없는 비용 · 판정 러너 비용 · 중단된 세션)가 있는가).
   - 새 한도가 설정을 바꾸지 않는가. 새 실행의 `budgetSnapshot`이 `runs_identity_immutable` 아래 생성 때 한 번만 쓰이는가. `createRun`의 다섯째 인자가 사람의 `run.create` RPC로 닿지 않는가(스키마가 거부하는가: 구현자 주장 -32602. 직접 호출해 본다).
4. **무결성 · 권한 (NFR-01 · NFR-02, 수용 기준 3).**
   - 사람 주체만(-32020, 저장소를 열기 전). 에이전트 도구 쪽에서 닿는 길이 없는가.
   - 실행 생성 · 연결 · 항목 처리가 트랜잭션 1개인가(실패 주입 시험이 실제로 `createRun` 뒤의 실패를 만드는가). 같은 항목에 두 번(두 번째는 거부, 실행이 둘 생기지 않음).
   - 유형 · 대상 규칙 · 기준 커밋이 원 실행에서 정해지고 요청이 바꿔 넣을 수 없는가. 원 실행의 유형별: A · B · C(보강 · 보강 아님) · D, 내장 규칙이 대상인 실행(사람의 `run.create`가 거부하는 조합을 이 길로는 만들 수 있게 됐는가: 원 실행이 자동 시작이라 사람이 직접 만들 수 없던 실행을 사람 주체로 다시 만드는 것이다. `createRun`의 문이 무엇을 하고 그것이 맞는지). 대상 규칙이 그 사이 폐기된 경우.
   - **시작 주체가 사람인 이어받는 실행의 하루 한도 · 자동 시작 규칙**: 원 실행이 자동 시작(하루 한도의 문을 지남)이었는데 이어받는 실행은 사람 실행이라 "하루 한도가 비어도 돈다"(ADR-104). 사람이 누른 것이므로 맞는가(ADR-147 ⑤). 문서에 사실대로 있는가.
   - 원 실행의 상태 · 단계 · 세션 · 비용 기록이 바뀌지 않는가(시험이 무엇을 비교하는가).
   - `RUN_STATUS_TRANSITIONS`와 0016 트리거가 그대로임을 고정한 시험이 실제로 글자를 비교하는가.
5. **작업 가지 (`worktree-manager.create`의 `start`).** 시작 커밋 검증(원 실행 브랜치에 있는가 · 기준 커밋이 조상인가)이 git 객체로 되는가. 원 실행의 브랜치 · 작업 폴더가 지워졌을 때(ADR-058: 자동으로 지우지 않지만 사람이 지울 수 있다). 인자 주입(커밋 값이 옵션처럼 읽히는가: `--`로 가르는가, 40자 16진수 검사). 원 실행의 브랜치를 건드리지 않는가(읽기만). 지금은 시작 커밋 = 기준 커밋이라 이 검증이 사실상 쓰이는가, M3-60을 위한 미리 넣은 코드인가(쓰이지 않는 코드에 시험이 있는가).
6. **보강 사슬 (수용 기준 4).** 보강 실행을 이은 실행: `isReinforcementRun` 참, 자동 보강의 "같은 규칙에 끝나지 않은 보강 실행" 판단에 듦(같은 규칙에 보강 실행이 둘 생기지 않음), 첫 단계부터 도는 그 실행에서 테스트 작성 세션이 기존 파일 사본과 변이 자료를 받고 "더하기만"(세 자리)과 재주입이 걸림, `failed`면 변이 생존 항목. 사람 보강(`review_reinforcements`)을 이은 경우도 같은가. 이어받는 실행이 다시 `budget_exceeded`면 새 예산 초과 항목(코드 추가 없이).
7. **구조 시험과 RPC.** `integrity.test.ts`의 새 구조 시험이 무엇을 고정하는가(연결을 쓰는 곳 하나). 기존 허용 목록이 넓혀졌는가(`createRun(` 호출 자리 · `reviewQueue` 목록). RPC 스키마(shared `protocol.ts`)와 `architecture.md`의 표.
8. **시험.** `review-queue-budget.test.ts`(약 15건) · `budget.test.ts`의 새 절 · `store/test/run-continuations.test.ts`를 읽고 단언이 뜻을 고정하는지 본다. 수용 기준 문장마다 시험이 있는가(특히 기준 1의 "첫 단계부터 돎", 기준 4의 "자기 단계의 근거로 걸리며").
9. **ADR-149와 architecture.md.** 문장마다 코드와 맞는가. "멈춘 곳"이 ADR-150과 맞는가. ADR 머리줄 순서 147 · 148 · 149 · 150. `grep -c 'udb40' docs/decisions.md`는 2.
10. **변이.** 구현자의 것(PR 본문 표: 20건 안팎)과 겹치지 않게 8 ~ 10종. 후보: ⓐ `lineageSessions`가 바로 앞 실행만 세기(사슬 2단에서 원 실행 누락), ⓑ `BUDGET_NOT_ABOVE_SPENT`를 실행 전체 USD만 보기, ⓒ 원 실행 ID UNIQUE 빼기, ⓓ `run_continuations_insert`에서 대상 규칙 비교 빼기, ⓔ 뷰의 `link_kind`를 늘 `auto`로, ⓕ 항목 처리 트리거가 다른 실행의 연결도 받기, ⓖ 새 한도를 설정에도 쓰기, ⓗ 사람 확인을 저장소를 연 뒤로, ⓘ `start` 검증에서 조상 확인 빼기, ⓙ 이어받는 실행이 아닌 실행에도 `lineageSessions`가 다른 실행의 세션을 섞기, ⓚ 역할 집합이 달라도 통과. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다(제품에서 생기지 않는 상태면 근거와 함께 비차단).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr319.XXXX)`): orchestrator `review-queue-budget` · `review-queue` · `budget` · `engine` · `mutation` · `auto-start` · `integrity` · `run`, store 전체, shared `protocol`. 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번(격리 `TMPDIR`). 알려진 두 시험만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- SQL 직접 확인은 scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r319-probe/` 아래의 임시 스크립트로 한다(네 작업 공간의 빌드 산출을 가져다 쓴다. 제품 DB · 다른 작업 공간을 건드리지 않는다).
- 숨은 글자: 바뀐 파일 전부를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(출력이 없어야 한다. 시험 소스에 숨은 글자가 글자 그대로 있으면 지적한다).
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다(python · sed 한 줄로 고치지 않는다). 스크립트 파일로 감싸 거부를 피하기, 옵션이나 도구를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 끝낼 때 작업 트리가 깨끗한지와 네가 띄운 프로세스가 남지 않았는지 확인한다(네 PID만 끝낸다).
- 시간 제한은 없다. 2번(마이그레이션) · 3번(한도) · 4번(무결성)을 가장 먼저 한다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 4개별 충족 여부와 근거(파일:줄, 시험).
- 0030 판정(`sqlite_master` 비교, 순환 · 깊은 사슬에서의 뷰, 한 실행의 원인이 둘이 되는 길, 원 실행 ID UNIQUE의 타당성).
- 한도 판정(원인별 재개 · 사슬 누적 · 우회하는 길), 무결성 판정(원 실행 유형별 · 트랜잭션 · 사람 주체), 작업 가지 판정.
- 변이 결과 표(변이, 빨강이 된 시험).
- 차단 지적(재현 절차와 함께) · 비차단 지적 · M3-60(#325) 구현자가 알아야 할 것.
- 실행한 명령과 결과, 못 한 것, 끝낼 때의 check-runs 상태.
- 남은 지적이 한 번의 수정으로 닫힐 크기인지 한 줄.
