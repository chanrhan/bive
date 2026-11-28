너는 chanrhan/bive 저장소의 이슈 #319(로드맵 M3-56 "예산 초과 액션: 이어받는 실행 · 한도 상향 재개")를 구현하는 서브에이전트다. M3-08(#53, PR #317, ADR-145)이 검토 대기열 · 자동 등록 · 변이 생존 액션을 넣었고, 예산 초과 항목은 등록되지만 처리 액션이 없어 열림으로 남는다. 이 이슈는 첫 예산 초과 액션인 **한도 상향 재개**를 "이어받는 새 실행"으로 넣는다. 설계 결정은 ADR-147에 있다: 그대로 구현하고 세부 모양만 네 ADR이 정한다.

## 받은 값
- 이슈 번호 `<N>` = 319, 브랜치 `<B>` = `feat/319-run-continuation`, ADR 번호 `<A>` = ADR-149, 커밋 `<T>` = `feat(orchestrator)`(store · shared 커밋은 `feat(store)` · `feat(shared)`). 화면 변경 없음(SCR-18은 M3-09. 새 enum 값 · `skipped` 사유의 표시명 표만 shared와 app에 함께 더한다. 그것 때문에 화면 e2e · 스모크가 필요해지면 돌린다).
- 마이그레이션은 **`project/0030_…` 하나**(이 번호는 네 것이다). 0029는 병렬 이슈 #294(AsyncAPI 실행기, `judgments.runner` CHECK 넓히기)의 것이다: 이 PR은 #294의 PR이 병합된 뒤에 병합된다(번호 빈칸을 만들지 않는다). #294가 `judgments` 표를 다시 만들 수 있으므로 네 0030은 `judgments`를 다시 만들지 않는 쪽으로 한다.
- 기준 main은 `git fetch origin main` 뒤의 `origin/main`. **PR #317이 병합된 main(`22c66c7` 이후)이어야 한다**(`git log origin/main --oneline -3`에 "검토 대기열 모델 · 자동 등록 · 변이 생존 액션 (#53) (#317)"이 있는지 확인. 없으면 멈추고 보고). `git merge-base --is-ancestor 97b4d86 HEAD` 확인.
- 병렬 작업: #294(ADR-148, 0029: `contract-check/` · `steps/contract-check.ts` · `enums.ts`의 `JudgeRunner` · store 0029)가 구현 중이다. `enums.ts` · `protocol.ts` · `docs/decisions.md` · store `migrations/project/index.ts`는 필요한 줄만 더한다. ADR 순서는 147 · 148 · 149.

## 먼저 읽을 것 (순서대로, 전부)
1. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-common.md` 공통 지침. 그대로 따른다.
2. 이슈 #319 본문의 수용 기준 4개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/319`), `docs/roadmap.md`의 M3-56 · M3-08 · M3-57 · M3-58 · M3-09 행과 M3 "완료 기준 흐름" 4번.
3. `docs/decisions.md`: **ADR-147 전부**(맥락의 코드 사실과 결정 ① ~ ⑨. 이 결정을 그대로 구현한다) · **ADR-145 전부**(검토 대기열: 표 · 트리거 · 뷰 · RPC) · ADR-143(보강 실행 · 재주입 · ⑮ 더하기만) · ADR-136(실행 유형) · ADR-104 · ADR-105(하루 한도 · 대기열 깨우기 · 재개) · ADR-107 · ADR-061(종료 상태) · ADR-142(구조 시험) · ADR-100(B⑤ · 명세 변경 목록의 TODO-02 · COST-01).
4. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/m3-handoff.md`의 "M3-08" · "M3-55 뒤의 로드맵 사실" · "M3-54" · "M3-06" · "M3-31" · "M3-52" 절과 `m7-handoff.md`의 "M7-04" · "M7-06" · "M7-12" 절.
5. 관련 코드(전부 main에 있다): `engine/pipeline-engine.ts`(단계 계획 · `#drive` · `resume` · `#runSession` · `sessionLimits` · `runRemaining` · `budgetOverrun` · 종료 저장) · `engine/session-budget.ts` · `engine/run-ending.ts` · `runs/run-service.ts`(`createRun` · `SLOT_HOLDING_RUN_STATUSES` · 대기열 깨우기) · `ipc/run-handlers.ts`(`run.create` · `reviewQueue.reinforce`가 있는 자리) · `review/review-queue.ts` · `ipc/review-queue-handlers.ts` · `git/worktree-manager.ts`(`create(CreateRunInput)`) · `steps/judging.ts`(`lastPassed` · `redAcceptanceHashes`) · `steps/run-type.ts`(`acceptanceBaselineOf` · `isReinforcementRun`) · `steps/check.ts` · `steps/merge.ts` · `steps/green-check.ts` · `steps/mutation.ts` · store 0016 · 0027 · 0028(뷰 `run_reinforcement_causes`) · `run-repository.ts` · `mutation-result-repository.ts`(`reinforcementCauseOfRun`) · `review-queue-repository.ts` · shared `BudgetSnapshot` · `RUN_STATUS_TRANSITIONS` · `StepStatus`.

## 해야 할 것 (ADR-147의 결정 번호와 함께)
1. **연결 표와 뷰** (0030, 결정 ② ⑦).
   - 새 표(예: `run_continuations`): 이어받는 실행 ID(UNIQUE) · 원 실행 ID · 만든 시각. 추가 전용(수정 · 삭제 거부). 넣을 때의 조건을 트리거로: 원 실행이 `budget_exceeded`일 것, 새 실행이 사람이 시작했고 원 실행과 유형 · 대상 규칙 · 기준 커밋이 같을 것, **원 실행 하나에 끝나지 않은 이어받는 실행이 이미 있으면 거부**(끝난 뒤에는 다시 이을 수 있는가: 이어받는 실행이 다시 `budget_exceeded`로 끝나면 사람은 **그 실행의 새 항목**에서 다시 잇는다. 그러면 사슬은 원 → 1차 → 2차로 이어진다. 원 실행에서 가지가 둘로 갈라지는 것(같은 원 실행을 두 번 잇기)은 막는다: 원 실행 ID에 UNIQUE를 걸 수 있는지 판단하고 ADR에 적는다).
   - **뷰 `run_reinforcement_causes`를 다시 만든다**(DROP VIEW · CREATE VIEW, 0028 파일은 고치지 않는다): 보강 실행을 이어받은 실행도 사슬을 따라 원인 변이 기록에 닿게(`WITH RECURSIVE`). 이 뷰를 읽는 0028의 트리거(자동 등록 둘 · `review_items_insert`)와 `reinforcementCauseOfRun`이 그대로 동작해야 한다(트리거 본문은 뷰를 이름으로 참조한다: 다시 만든 뒤 살아 있는지 시험). `link_kind` 칸의 값은 사슬의 뿌리 연결 종류를 따른다(판단해 ADR에).
   - 0028의 "한 실행은 두 연결 가운데 하나만" · 자동 보강 연결의 조건(0027: 잇는 실행이 그 규칙을 대상으로 한 유형 C)과 부딪히지 않는지 확인한다(이어받는 실행은 연결 표 둘에 행을 갖지 않고 사슬로만 닿는다).
2. **이어받는 실행 만들기** (결정 ② ⑤ ⑦, 수용 기준 3).
   - RPC(이름은 `reviewQueue.*` 관례에 맞춰, 예: `reviewQueue.resumeWithBudget`): 사람 주체만(에이전트 -32020, 저장소를 열기 전), 열린 예산 초과 항목만(다른 종류 · 처리된 항목 · 없는 항목은 M3-08의 거부 그대로).
   - 실행 생성은 **`createRun`을 거친다**(사람의 `run.create`의 문: 설정 확인 -32010 · 유형 · `run_start` · 프로젝트당 실행 1개의 대기). 구조 시험이 "`createRun(`을 부르는 곳은 `ipc/run-handlers.ts`뿐"을 고정하므로 처리기는 `run-handlers.ts`에 두고(M3-08의 `reviewQueue.reinforce`와 같은 자리 · 같은 방식), 항목 확인 · 연결 · 처리는 `review/review-queue.ts`가 한다. 실행 생성 · 연결 · 항목 처리는 쓰기 트랜잭션 1개(중간 실패면 아무것도 남지 않음: 시험에서 실패를 주입).
   - 유형 · 대상 규칙 · 기준 커밋은 원 실행에서 정해진다(요청이 바꿔 넣을 수 없다). 원 실행의 유형이 사람의 `run.create`가 받지 않는 것(내장 규칙 대상 · 유형 선언 등)일 때 `createRun`의 문이 어떻게 하는지 확인하고 ADR에 적는다. 대상 규칙이 그 사이 폐기 · 삭제됐으면 기존 승인 단계의 효력 확인이 하는 대로다(새 규칙 없음).
   - 하루 한도는 바꾸지 않는다. 사람 실행의 규칙 그대로(세션을 열 때 본다, ADR-104).
3. **한도** (결정 ④, 수용 기준 2).
   - 요청의 새 한도는 `BudgetSnapshot`과 같은 모양. 검증(-32001, `data.reason` 고정 값): 모양이 다름(역할 집합이 원 실행과 다름 등), 어느 값이든 원 실행의 같은 값보다 작음, 원 실행(사슬 전체)이 쓴 양이 이미 닿은 값인데 쓴 양보다 크지 않음. "닿은 값"의 판정은 엔진이 예산 초과를 판정하는 것과 같은 계산을 쓴다(따로 구현하지 않는다).
   - 새 한도는 새 실행의 `budgetSnapshot`으로 들어간다(`runs_identity_immutable`을 풀지 않는다. 설정은 바뀌지 않는다: `createRun`이 설정에서 스냅숏을 뜨는 자리를 넓혀야 한다. 넓히는 인자가 사람의 `run.create` RPC로는 닿지 않게 한다).
   - 사용량 누적: `sessionLimits` · `runRemaining` · `budgetOverrun`이 그 실행의 세션 기록만 센다. 이어받는 실행은 **사슬 전체**(원 실행들)의 세션 기록을 이어 센다(실행 전체 · 역할별, USD · 턴 각각). 이어받는 실행이 아닌 실행의 계산은 글자까지 그대로(시험). 비용 표시(실행마다 자기 비용)는 바꾸지 않는다.
4. **중간 시작** (결정 ② ③, 수용 기준 1).
   - 작업 가지: 새 실행의 가지는 원 실행의 **마지막 완료(`passed`) 단계 산출 커밋**에서 시작한다(`worktree-manager.create`를 넓힌다: 시작 커밋 인자. 그 커밋이 원 실행의 가지에 실제로 있는 커밋인지 git 객체로 확인한다). 기준 커밋(base)은 원 실행과 같다. 원 실행이 끝낸 단계가 없으면 기준 커밋에서 첫 단계부터.
   - 단계 기록: 이어받은 단계는 새 실행에 `skipped`(`exitDetail` = `{reason: <이어받음 고정 값>, …원 실행 · 그 단계 시도를 가리키는 값}`)로 남는다. `passed` 행을 만들지 않는다. "마지막 완료 단계 다음"의 정의를 유형별 단계 계획(A · B · C · D, 회귀 중이던 실행: 구현 재시도 · 테스트 작성 회귀로 같은 단계의 시도가 여럿인 경우)에서 정하고 ADR에 적는다: 원 실행이 **어느 단계의 몇 번째 시도 중에** 예산 초과가 됐는지에 따라 새 실행이 어디서 시작하고 회귀 카운터(시도 수 상한)를 어떻게 이어 세는지(상한을 이어받기로 우회하지 못하게: 사슬 전체로 센다).
   - 판정 근거: `acceptanceBaselineOf` · `lastPassed` · `redAcceptanceHashes` · `check.ts`의 커밋 대조 · `merge.ts`의 대조가 **연결을 거쳐 원 실행의 단계 기록에서 읽는다**(복사하지 않는다). 읽는 자리를 한 함수로 모아(예: "이 실행과 그 원 실행들의 단계 기록") 단계 실행기들이 그것을 쓰게 한다. 원 실행의 Red 해시와 다른 인수 테스트는 기존 보호가 그대로 막는다(시험: 이어받는 실행의 구현 세션이 인수 테스트를 바꾸면 `guard_violation`).
   - 원 실행의 작업 폴더 · 브랜치는 건드리지 않는다(읽기만). 원 실행의 상태 · 단계 · 세션 기록이 바뀌지 않음을 시험으로(트리거가 막고, 코드도 쓰지 않는다).
5. **항목 처리와 다시 예산 초과 · 보강 사슬** (결정 ⑦, 수용 기준 4).
   - 이어받는 실행이 만들어지면 그 항목은 처리됨(액션 값 새로: `ReviewAction`에 더하고 0028의 CHECK(종류별 액션 짝 · 처리 결과가 실제로 있어야 함)를 **0030에서 넓힌다**: `review_items`의 CHECK를 넓히려면 표를 다시 만들어야 하는지, 트리거만으로 되는지 0028을 읽고 가장 작은 방법을 고른다. 표를 다시 만들면 그 표를 참조하는 트리거 · 색인을 모두 다시 건다).
   - 이어받는 실행이 다시 `budget_exceeded`면 M3-08의 자동 등록이 새 항목을 만든다(코드 추가 없이 성립하는지 시험).
   - 보강 실행(유형 C + 보강 연결)을 이어받은 실행: `isReinforcementRun` 참, 재주입 · "더하기만"(ADR-143 ⑮ 세 자리) · 자동 보강의 "같은 규칙에 끝나지 않은 보강 실행" 판단에 든다. `failed`로 끝나면 변이 생존 항목 등록 조건이 걸린다. **"더하기만"의 기준**(기준 커밋의 기존 파일 = 바이트까지 그대로)은 원 실행과 같은 기준 커밋으로 본다.
6. **무결성 · 구조 시험**: 연결 표를 쓰는 곳은 한 곳(`review/review-queue.ts`)임을 `integrity.test.ts`에 새 시험으로. 기존 허용 목록을 넓혀야 하면 멈추고 보고한다. `RUN_STATUS_TRANSITIONS`와 0016 트리거가 그대로임을 시험이 고정한다(수용 기준 3).
7. **ADR-149**: 연결 표 · 뷰 · 사슬의 모양, "마지막 완료 단계 다음"의 정의와 회귀 카운터, 판정 근거를 읽는 함수, 작업 가지의 시작 커밋, 새 한도의 검증과 누적 계산, `createRun`을 넓힌 방식, 항목 처리의 저장 변경, 원 실행의 유형별 처리, 한계(실행이 둘로 보임 · 비용 표시 · `skipped` 사유의 표시 · 그 밖), 다시 정하는 조건. `docs/architecture.md`(엔터티 · 파이프라인 문단 · 메서드 표)를 사실에 맞게 고친다.

## 크기와 순서 (중요)
- 순서: 1(저장) → 2 · 3(실행 만들기와 한도 검증: 아직 첫 단계부터 도는 상태로) → 4(중간 시작) → 5. **1 ~ 3을 끝낸 시점과 4를 끝낸 시점에 `git diff --stat origin/main`을 본다. 바뀐 파일이 25개를 넘거나 +2500줄을 넘을 것 같으면 그 시점까지를 통과 상태로 커밋 · 푸시하고 PR은 만들지 말고 보고한다**(조율자가 판단한다). ADR-147의 결정이 코드에서 성립하지 않는 자리를 만나면 고치지 말고 멈추고 보고한다.
- 무거운 단위 시험을 더하면 새 시험 파일의 소요 시간을 재서 보고한다(CI `checks` 16 ~ 22분, 다시 보는 선 25분).

## 시험
- `orchestrator/test/review-queue-budget.test.ts`(새 파일) · `orchestrator/test/budget.test.ts` · `store/test/run-continuations.test.ts`(새 파일)가 수용 기준의 단언을 맡는다.
- 방어마다 시험: 에이전트 주체, 없는 · 처리된 · 다른 종류의 항목, 내리는 한도, 닿은 값이 쓴 양 이하, 역할 집합이 다름, 설정 미비(아무것도 남지 않음), 실행 생성 뒤 실패 주입(아무것도 남지 않음), 원 실행 하나에 두 번째 이어받기, 원 실행이 `budget_exceeded`가 아님, 유형 · 대상 · 기준 커밋이 다른 실행을 직접 잇기(SQL), 연결의 수정 · 삭제, 시작 커밋이 원 실행의 가지에 없음, 원 실행의 기록 불변, 이어받은 단계가 `passed`가 아님, 인수 테스트 변경이 원 실행의 Red 해시로 막힘, 회귀 상한이 사슬 전체로 세어짐, 사슬 2단(원 → 1차 → 2차)의 한도 누적과 판정 근거, 보강 사슬.
- 파이프라인 e2e: 엔진 · IPC를 고쳤으므로 대상이다. 로컬 전체(약 70분)는 돌리지 않고 관련 파일 몇 개만 로컬에서, 나머지는 CI에 맡긴다. 새 파이프라인 e2e 시나리오는 수용 기준이 요구하지 않으므로 더하지 않는다(M3 흐름 4번은 M3-09 뒤 QA가 본다).

## 하지 않는 것
- 허용 목록 축소 재개(M3-58, #321) · 규칙 분할(M3-57, #320) · SCR-18 화면(M3-09) · 종료 상태를 되살리는 길 · 비용 합산 표시 · `docs/spec/*` · `docs/roadmap.md` 수정 · 0001 ~ 0029 마이그레이션 수정.
- CI가 무관한 시험으로 빨강이면 다시 돌리지 말고 보고한다. `ci` 성공까지 확인한 뒤 보고한다(대기 40분까지).

## 보고
공통 지침의 보고 형식 + ADR-147 결정 ① ~ ⑦ 각각을 어떻게 구현했는지(달라진 점과 이유), "마지막 완료 단계 다음"의 정의, 0030의 내용(다시 만든 표 · 뷰 · 트리거 목록), 네가 새로 정한 것, 새 시험의 소요 시간, 한계, 멈췄다면 어디서 왜.
