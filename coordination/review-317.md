너는 chanrhan/bive 저장소의 PR #317(이슈 #53, 로드맵 M3-08 "검토 대기열 모델 · 자동 등록 · 처리 액션" 가운데 **수용 기준 1 · 2만**)을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경 한 줄
검토 대기열의 저장 모델(마이그레이션 `project/0028_review_queue`: 표 `review_items` · `review_reinforcements`와 트리거) · 자동 등록(실행 종료 저장과 같은 문장에서 DB 트리거가 넣음) · 변이 생존 액션(사람의 테스트 보강 = 유형 C 보강 실행, 판정 격리 = 사유 필수, 이의 제기 = 메서드 없음 -32601) · RPC `reviewQueue.list/get/reinforce/quarantine` · 알림 `event.reviewQueue.changed`. ADR-145. **예산 초과 액션(기준 3 · 4)은 이 PR에 없다**: 조율자가 로드맵에서 새 행으로 쪼개는 중이다(이슈 #316). 그것이 없다는 것은 지적 대상이 아니다.

## 받은 값
- PR #317, 브랜치 `feat/53-review-queue`, 헤드 `<HEAD>`(조율자가 아래 프롬프트에서 준다), 기준 main `81fe45d`. 바뀐 파일 24개(+2151 / -12). `ci` 결과는 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<HEAD>/check-runs`로 네가 확인한다(조율자가 성공을 확인하고 너를 띄운다).
- 네 작업 공간에서 `git fetch origin feat/53-review-queue` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-53.md`(구현자가 받은 지시서: "조율자가 미리 정한 것" ① ~ ⑥), `brief-common.md`, `m3-handoff.md`의 "M3-54" · "M3-07" · "M3-06" · "M3-31" 절, `m7-handoff.md`의 "M7-05" · "M7-06" · "M7-09" 절, `pr317-body.md`(PR 본문 사본, 되돌려서 빨강 확인한 표 포함).
3. 이슈 #53 본문의 수용 기준 1 · 2(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/53`).
4. `docs/decisions.md`의 ADR-145(이 PR이 더함) · ADR-143 전부 · ADR-141 · ADR-139 · ADR-136 · ADR-142(구조 시험) · ADR-100(B④ · A17 · 명세 변경 목록의 TODO-02 · JDG-04 행) · ADR-105 · 사람 전용 RPC의 주체 확인을 정한 ADR. `docs/spec/prd.md`의 TODO-02 · COST-01 · JDG-04 · NFR-01 · NFR-02 · NFR-03과 9장 미결 #7, `docs/spec/plan.md`의 "격리" 대목.

## 구현자가 정한 것 (네가 타당성을 판정한다)
- 표 `review_items(seq, kind, run_id, mutation_result_id, created_at, resolved_at, action, resolved_by, reason, detail)`. "열린 항목은 실행마다 하나"(부분 UNIQUE). 트리거: 넣을 때 열림 + 종류 조건, 처리 한 번 · 항목 칸 불변, 처리 결과가 실제로 있어야 함(보강 연결 / 같은 사유 격리 판정), 지우기 거부.
- **자동 등록은 DB 트리거**(`AFTER UPDATE OF status ON runs` 둘). 실행이 `budget_exceeded` → 예산 초과 항목(보강 실행 포함). 보강 실행이 `failed`이고 원인 규칙이 지금도 '변이 생존' → 변이 생존 항목. 보강이 `budget_exceeded`면 예산 초과 항목 하나뿐(ADR-143의 메모와 다름: 조율자 결정). 자동 보강이 생략된 생존은 항목이 아님(A17 글자).
- 사람 보강 연결은 새 표 `review_reinforcements`(0027은 넓히지 않음). `MutationResultRepository.reinforcementCauseOfRun`이 두 연결을 합쳐 보고 `isReinforcementRun` · 재주입 · 변이 자료 · "더하기만" · 자동 보강의 중복 확인이 이것을 쓴다.
- **`reviewQueue.reinforce` 처리기를 `ipc/run-handlers.ts`에 둠**: 구조 시험 "`createRun(`을 부르는 곳 = `ipc/run-handlers.ts`"를 넓히지 않으려고. 항목 확인 · 연결 · 처리는 `review/review-queue.ts`가 같은 트랜잭션에서.
- 판정 격리: 빈 사유 -32001 `QUARANTINE_REASON_REQUIRED`, 4000자 초과 `QUARANTINE_REASON_INVALID`. `judgments` 1행(`quarantined`, 사유, `runId`/`stepId` = null, 커밋 = 원인 변이 기록의 판정 커밋, 케이스 없음).
- 알림: 저장소를 여닫는 한 곳(`ipc/project-store-access.ts`)에서 사용 전후의 변경 표지(항목 수 + 처리된 수)를 비교.
- 앱의 메서드 허용 목록(`APP_METHOD_NAMES`)과 앱 표시명 표는 M3-09로 미룸(shared 표시명 표만 더함).

## 꼭 판정할 것
1. **범위와 불변.** `git diff 81fe45d...HEAD --stat`. `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · 워크플로 · 머지된 마이그레이션(0001 ~ 0027)이 바뀌지 않았는가. 기존 시험 파일의 `-` 줄. `steps/run-type.ts` · `steps/mutation.ts` · `steps/test-writing.ts` · `runs/auto-start.ts`의 변경이 "두 연결을 함께 본다" 말고 자동 보강의 동작(ADR-143 ⑧ ⑪: 중복 · 고리 방지)을 바꾸지 않는가. `mutation.test.ts` · `auto-start.test.ts`가 고쳐지지 않고 통과하는가.
2. **마이그레이션 0028 (가장 먼저, 꼼꼼히).**
   - 트리거의 SQL을 줄마다 읽는다. `AFTER UPDATE OF status ON runs`가 종료를 쓰는 모든 경로에서 뜨는가(상태가 `INSERT`로 처음부터 종료인 행이 있는가: 실행 대기 시작의 하루 한도 문 등). 같은 실행의 상태가 종료로 두 번 쓰일 수 없음(0016)과의 짝. 트리거 안의 "보강 실행" 판별(두 연결 표)과 "원인 규칙이 지금도 변이 생존"(규칙의 가장 나중 변이 기록) 조건이 코드의 `reinforcementCauseOfRun` · `statusOf`와 **같은 뜻**인가(SQL과 TS 두 곳에 같은 규칙: 어긋나면 등록이 빠지거나 헛등록된다. 경계: 같은 시각 기록, 재주입 기록이 '판정 불가'인 경우, 규칙이 폐기된 경우).
   - **이미 있는 데이터**: 0028 적용 전에 `budget_exceeded`로 끝난 실행 · 실패한 보강 실행은 항목이 없다. 되채우지 않은 것이 타당한가(ADR에 적혔는가). 되채우지 않으면 M3-09 화면에 옛 예산 초과가 안 보인다: 차단 여부를 판정하고 근거를 적는다(보수적 해석: 사람이 보는 자리를 잃는가).
   - 트리거 실패가 실행 종료 저장 자체를 막는가(항목 넣기가 CHECK · UNIQUE로 실패하면 `runs` 갱신이 롤백된다: 엔진이 종료를 저장하지 못하는 길이 생기는가. 부분 UNIQUE와 "열린 항목이 이미 있는 실행"의 조합으로 재현을 시도한다).
   - 처리 트리거: 처리됨 → 열림 되돌리기 · 다른 칸 고치기 · 삭제 · 사람이 아닌 주체 · 종류와 액션의 짝 · 처리 결과 없이 처리(보강 연결 없이 `reinforce`, 격리 판정 없이 `quarantine`)를 SQL로 직접 시도해 거부되는지 본다(`store/test/review-queue.test.ts`가 이미 단언하는 것은 읽고, 빠진 것만).
   - 마이그레이션이 기존 프로젝트 DB(0027까지 적용된 것, 실행 · 변이 기록이 있는 것)에 적용되는가(시험이 빈 DB만 쓰는가). 외래 키 · 색인(조회 `list`의 필터 열, `run_id` · `mutation_result_id`). `review_items`가 수만 행일 때 `list`가 전부 읽는가(상한 · 정렬).
3. **무결성 · 권한(NFR-01 · NFR-02).**
   - 처리 RPC가 사람 주체만 받는가(에이전트 -32020, 저장소를 열기 전). 에이전트 도구 · 파이프 쪽에서 `reviewQueue.*`를 부를 수 있는 길(메서드 등록 자리, 에이전트용 서버가 따로 있으면 그 목록). 조회 RPC는 누구나인가, 그래도 되는가(다른 조회 RPC의 선례).
   - **`reviewQueue.reinforce`를 `run-handlers.ts`에 둔 것**: 구조 시험이 지키려는 성질("실행을 만드는 사람 RPC의 자리는 하나")에 비춰 정직한 배치인가, 시험을 글자로만 지킨 회피인가. `createRun`이 사람의 `run.create`와 같은 문(설정 · 유형 선언 · 시작 근거 `run_start` · 프로젝트당 실행 1개 대기 · 하루 한도)을 지나는가. 사람이 유형 C를 직접 고르는 것이 아니라 항목에서 정해지는가(요청이 유형 · 대상 규칙을 바꿔 넣을 수 없는가). 판정: 그대로 / 목록에 한 파일을 더하고 처리기를 옮김.
   - 트랜잭션: 실행 생성 · 연결 · 처리가 하나인가. 중간에 실패하면 아무것도 남지 않는가(설정 미비 -32010에서 항목이 열림 그대로인지). 같은 항목에 두 요청이 동시에 오면(두 번째는 -32009 계열) 실행이 둘 생기지 않는가.
   - 사람이 시작한 보강 실행에도 ADR-143 ⑮(더하기만) · 재주입 · 변이 자료가 걸리는가: `isReinforcementRun`을 쓰는 세 자리(테스트 작성 결과 받기 · Green 확인 전 · 병합 직전)가 사람 연결로도 참인지 시험이 있는가. **사람 보강이 실패로 끝나면** 다시 변이 생존 항목이 생기는가(트리거의 "보강 실행" 판별이 사람 연결도 보는가. 생기는 것이 맞다: 사람이 다시 볼 자리).
   - 자동 보강의 중복 확인이 사람 보강 실행(끝나지 않은 것)을 보는가. 반대로 사람 보강이 자동 보강의 "같은 기록으로는 다시 만들지 않는다"를 깨지 않는가.
4. **판정 격리.**
   - '격리' 판정 1행이 **어디에서 읽히는가**를 전부 추적한다: 규칙 카드 · 규칙 상세의 최신 판정, `verification.summary`의 준수 분모(격리는 분모에서 빠진다: 사람이 실패하는 규칙을 격리해 준수율을 올릴 수 있다 → 변이 생존 항목에서만 가능하고 사유가 남는다. 타당성 판정), 판정 기준 커밋 선택, 규범 입력의 케이스 이름(구현자가 한계로 적음), 자동 시작 · 병합 재검사 · 검사 단계가 저장된 최신 판정을 "통과"로 읽는 곳이 없는가(구현자 주장: 없다. grep과 시험으로 확인).
   - `runId`/`stepId`가 null인 판정 행이 기존 코드(판정 목록 · 실행 링크 · `judgments.listByRun` 계열 · 화면)를 깨지 않는가. 스키마(shared `Judgment`)가 그것을 허용하던 것인가, 이 PR이 넓혔는가.
   - 커밋 = "원인 변이 기록의 판정 커밋"이 main에 없는 커밋(병합 안 된 실행의 것)일 수 있는가. 그러면 "판정 기준 main@커밋" 화면에서 이 격리가 보이는가 안 보이는가, 어느 쪽이 맞는가.
   - 사유: 공백만 · 숨은 글자만 · 4000자 경계 · 줄바꿈. 화면에 그릴 때 `visibleText`를 거치게 돼 있는가(이 PR은 화면이 없다: 응답에 실리는 모양만).
   - 격리를 되돌릴 길이 없다는 한계가 ADR에 있는가. 격리한 뒤 그 규칙의 자동 보강 · 변이 주입은 어떻게 되는가.
5. **이의 제기 -32601.** 메서드 이름이 무엇으로 시험되는가(임의 이름이 아니라 로드맵 · 화면이 쓸 이름인가). 등록되지 않은 것이 시험으로 고정됐는가.
6. **RPC와 알림.** `reviewQueue.list {kind?, state?}`의 정렬 · 상한 · 응답 모양(`{item, run, rules}`)이 SCR-18(카드 1줄 대상 규칙 제목, 2줄 ID와 종류와 시각, 필터 2종)을 그릴 만큼인가. 규칙 제목 등 에이전트가 쓴 글이 응답에 실릴 때의 표시 값 처리 관례(서버 · 앱 어느 쪽 책임인지 기존 RPC와 같은가). 알림: "저장소를 여닫는 한 곳에서 변경 표지 비교"가 모든 저장소 사용에 비용을 더하는가(질의 수 · 엔진의 뜨거운 길), 표지(항목 수 + 처리된 수)가 놓치는 변경이 있는가, 엔진 쪽(트리거가 항목을 넣는 순간)에서도 알림이 가는가(구현자 시험: 엔진에서 예산 초과로 끝나면 알림 1번).
7. **앱 쪽을 미룬 것.** `APP_METHOD_NAMES`에 없으면 앱이 이 메서드를 못 부른다: M3-09가 더하면 되는가, 지금 빠져서 깨지는 것(앱의 메서드 목록과 shared 프로토콜의 대조 시험 등)이 없는가. 새 enum 값의 앱 표시명 표를 미룬 것이 공통 지침("shared와 app의 표시명 표에 함께")과 기존 대조 시험에 걸리는가. 차단 여부 판정.
8. **시험.** `orchestrator/test/review-queue.test.ts`(576줄) · `store/test/review-queue.test.ts`(485줄) · `integrity.test.ts`의 새 구조 시험(정규식 기반: M3-31의 구문 트리 헬퍼 `source-structure.ts`와 짝을 맞춰야 하는가, 정규식이 놓치는 형태가 있는가)를 읽고 단언이 뜻을 고정하는지 본다. 수용 기준 1 · 2의 문장마다 시험이 있는가.
9. **ADR-145와 architecture.md.** 문장마다 코드와 맞는가. "멈춘 곳"이 사실대로인가(예산 초과 액션 없음, 조율자 방향 = 종료 상태 유지 + 이어받는 새 실행: 이 방향 자체는 이슈 #316의 ADR-147이 정한다. ADR-145가 그것을 "정했다"로 앞질러 적지 않았는가). ADR 머리줄 순서 143 · 144 · 145. `grep -c 'udb40' docs/decisions.md`는 2.
10. **변이.** 구현자의 7종(PR 본문 표)과 겹치지 않게 7 ~ 9종. 후보: ⓐ 트리거의 "지금도 변이 생존" 조건 제거(검출로 바뀐 규칙도 등록), ⓑ 보강 실행 판별에서 사람 연결 빼기(SQL 쪽), ⓒ 보강이 `budget_exceeded`일 때 변이 생존 항목도 넣기, ⓓ `reinforce`가 연결 없이 처리만 하기, ⓔ `quarantine`이 판정 행을 다른 규칙에 쓰기, ⓕ 처리 트랜잭션을 둘로 쪼개기(실행 생성 뒤 실패 시 실행이 남는가), ⓖ `list`의 `state` 필터 뒤집기, ⓗ 알림 표지에서 처리된 수 빼기(처리 때 알림이 안 감), ⓘ 예산 항목에 `quarantine` 허용, ⓙ 사람 보강 실행에서 `isReinforcementRun`이 거짓이 되게(`reinforcementCauseOfRun`이 자동 연결만 봄: 구현자가 "사람 연결 합산 제거"로 했으면 다른 자리에서). 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다(제품에서 생기지 않는 상태면 근거와 함께 비차단).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr317.XXXX)`): orchestrator `review-queue` · `mutation` · `auto-start` · `integrity` · `run` · `test-writer`, store `review-queue` · `mutation-results` · 마이그레이션 시험, shared `protocol`. 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번(격리 `TMPDIR`). 알려진 두 시험만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- SQL 직접 확인은 시험 파일 안에서 하거나(끝나면 되돌림) scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r317-probe/` 아래의 임시 스크립트로 한다(네 작업 공간의 빌드 산출을 가져다 쓴다. 제품 DB · 다른 작업 공간을 건드리지 않는다).
- 숨은 글자: 바뀐 파일 24개를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션이나 도구를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 끝낼 때 작업 트리가 깨끗한지와 네가 띄운 프로세스가 남지 않았는지 확인한다(네 PID만 끝낸다).
- 시간 제한은 없다. 2번(마이그레이션) · 3번(무결성) · 4번(격리)을 가장 먼저 한다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 1 · 2의 충족 여부와 근거(파일:줄, 시험).
- 마이그레이션 0028의 판정(트리거 SQL과 TS 규칙의 일치, 되채움, 트리거 실패가 종료 저장을 막는 길).
- `reinforce` 처리기 자리의 판정, 격리 기록이 읽히는 곳 목록과 판정, 앱 쪽 미룸의 판정.
- 변이 결과 표(변이, 빨강이 된 시험).
- 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, 못 한 것.
- 남은 지적이 한 번의 수정으로 닫힐 크기인지 한 줄.
