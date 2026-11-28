너는 chanrhan/bive 저장소의 이슈 #320(로드맵 M3-57 "예산 초과 액션: 규칙 분할")의 PR을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

**절차(먼저 읽는다)**: 파일을 고치는 것(변이 · 임시 탐침 시험 포함)은 Edit · Write 도구로만 한다. `python` · `sed -i` · 셸 리다이렉션으로 저장소의 파일을 고치지 않는다. 되돌리기는 `git checkout -- <파일>`. 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것만 된다. 스크립트 파일로 감싸 거부를 피하기, 옵션 · 작업 폴더 · 경로 표기를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 배경 한 줄
검토 대기열의 예산 초과 항목에 둘째 액션 "규칙 분할"을 넣는다(ADR-153, ADR-147 ⑧의 결정). 사람이 원 실행의 대상 규칙 하나를 고르면(`reviewQueue.splitRule`) 규칙 작성 역할의 **분할 세션**이 새 도구 `split_rule`로 그 규칙을 2 ~ 5개의 새 규칙으로 대체한다. 마이그레이션 `project/0031_rule_splits`. 크기가 +2500줄 기준을 넘었고(24개 파일 안팎, +2750줄 안팎) 조율자가 PR 하나로 받았다: 크기 자체는 지적 대상이 아니다.

## 받은 값
- PR 번호 · 헤드 SHA · 기준 main은 조율자가 아래 프롬프트에서 준다. 브랜치 `feat/320-rule-split`. `ci` 결과는 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<HEAD>/check-runs`로 네가 확인한다.
- 네 작업 공간에서 `git fetch origin feat/320-rule-split` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-320.md`(구현자가 받은 지시서) · `brief-common.md` · `m3-handoff.md`의 "M3-08" · "M3-55 뒤의 로드맵 사실" · "M3-56" · "M3-60" · "M3-30" · "M3-31" 절 · `m7-handoff.md`의 "M7-09" · "M7-05" · "M7-19" 절. PR 본문은 `scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/<번호>`로 읽는다(변이 표 포함).
3. 이슈 #320 본문의 수용 기준 3개.
4. `docs/decisions.md`의 ADR-153(이 PR이 더함) · **ADR-147 ⑧과 한계** · ADR-145 · ADR-149 · **ADR-112**(대체 도구) · ADR-115 · ADR-118 · **ADR-151**(동작 선언) · ADR-107 · ADR-110 · ADR-100(B⑨ · 명세 변경 목록의 TODO-02 · NRM-02 · NRM-07 행) · ADR-127 · ADR-016(가짜 어댑터) · ADR-142. `docs/spec/prd.md`의 TODO-02 · NRM-02 · NRM-07 · RUN-04 · NFR-01 · NFR-02.

## 구현자가 정한 것 (네가 타당성을 판정한다)
- 새 도구 `split_rule {ruleId, grounds, rules: 2 ~ 5개}`(새 규칙 칸은 `ProposeRuleInput`에서 `parentRequirementId`만 뺀 것: 동작 선언 · EARS · 모순 판단이 필수). `supersede_rule`은 한 줄도 바뀌지 않았다.
- **도구는 분할 세션에만**: 역할 목록(`ROLE_TOOL_NAMES`)에 넣지 않고 `RULE_SPLIT_SESSION_TOOL_NAMES = ['split_rule']`을 따로 둠. 실행기 `toolSet: 'rule_split'`, SDK 노출은 `sessionToolDefinitions`. 분할 세션에서 다른 규범 도구는 `unknown_tool`, 다른 세션에서 `split_rule`도 `unknown_tool`. **이 때문에 `agent/claude-sdk-adapter.ts`가 역할 대신 실행기의 이름 목록을 읽게 바뀌었다**(기존 역할의 목록과 옵션은 글자까지 그대로라는 주장).
- RPC `reviewQueue.splitRule {projectId, seq, ruleId, author}` → `{entry, sessionId}`(`ipc/review-queue-handlers.ts`: 실행을 만들지 않음). 거부 순서: 에이전트 -32020(저장소를 열기 전) → 없는 항목 -32004 / 처리됨 · 다른 종류 -32009 → 대상 규칙 아님 -32001 `SPLIT_RULE_NOT_TARGET` → 내장 규칙 -32009 `builtin_rule` → 효력 없음 `rule_not_effective` · 부모 없음 `rule_without_parent` → 같은 항목의 분할 세션이 대기 · 진행 중 `split_in_progress` → 설정 미비 -32010 · 하루 한도 `project_daily_budget_exceeded`. 어느 거부도 세션을 열지 않는다.
- 분할 세션의 예산: 요구사항 세션과 같은 문(`roleSessionSettings` · `dailyBudgetReached`, 세션을 열 때 하루 잔여로 한도). 실행 밖 세션. 작업 지시에는 나눌 규칙의 제목 · 진술 · 부모 요구사항, 원 실행의 표시 ID · 종료 사유 · 멈춘 단계, 규범 자료만(고정 문장 `RULE_SPLIT_INSTRUCTION`).
- 0031: 표 `rule_splits(rule_id → rule_retirements, position, new_rule_id UNIQUE)`(폐기 기록의 `superseded_by`는 첫 새 규칙, 나머지는 이 표). 트리거 `rule_splits_insert`(짝 `superseded` 기록의 `detail.retirement.split`이 2개 이상이고 위치가 맞음, 위치 1 = `superseded_by`, 새 규칙이 살아 있고 내장이 아니며 부모가 같음) · 수정 · 삭제 거부 · `review_items_resolve_split_rule`(`detail.ruleId`가 그 항목 실행의 대상 규칙이고 분할 행이 2개 이상).
- 반영 `splitAgentRule`(`norms/agent-rule.ts`) 트랜잭션 1개: 새 규칙마다 규칙 + 신규 기록(동작 선언) + 모순 판단 기록(`new_rule`) → 나눈 규칙의 `superseded` 기록 + 폐기 기록 + 확인 풀림 → 분할 기록 → 처리 함수 `settle`. **처리기가 `splitSettlement`로 만든 함수를 세션 요청에 실어 넘긴다**(세션 코드가 검토 대기열을 모르게 하는 기존 구조 시험을 지키려고).
- 분할 세션의 중복 잠금은 프로세스 메모리(재기동하면 대기 중이던 세션이 사라지고 항목은 열림으로 남음).
- 새 규칙 2 ~ 5개(`RULE_SPLIT_MAX`), 판단 기록은 `supersede`가 아니라 규칙마다 `new_rule`, 부모 없는 규칙은 입구 거부.

## 꼭 판정할 것
1. **범위와 불변.** `git diff <기준 main>...HEAD --stat`. `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · 워크플로 · 머지된 마이그레이션(0001 ~ 0030)이 바뀌지 않았는가. 기존 시험 파일의 `-` 줄 전부(약 44줄: 무엇이 바뀌었는가, 약해진 단언은 없는가). **기존 규범 도구(`propose_rule` · `supersede_rule` · `retire_rule` · `uphold_rule`)와 기존 세션 종류의 동작이 글자까지 그대로인가**(`tools/definitions.ts` · `tools/executor.ts` · `rule-writer-service.ts` +387 · `agent-rule.ts` +203의 변경이 기존 갈래를 건드리지 않는가. 기존 `rule-writer` · `fixed-tools` · `norm-supersede` · `objection` 시험이 고쳐지지 않고 통과하는가).
2. **도구 노출과 역할 분리 (NFR-02 · RUN-04, 가장 먼저).**
   - `agent/claude-sdk-adapter.ts`의 변경을 줄마다 읽는다. 실제 SDK에 넘기는 도구 목록 · 허용 도구 · 권한 응답이 기존 역할(테스트 작성 · 구현 · 변이 주입 · 규칙 작성)에서 **바이트까지 같은가**. 이 VM에서는 실제 SDK를 부를 수 없다(ADR-016): 어댑터가 SDK에 넘기는 옵션을 단언하는 시험이 있는가(있으면 고쳐지지 않았는가, 없으면 이 변경을 무엇이 지키는가). "역할 대신 실행기의 이름 목록을 읽는다"가 **세션 가드**(허용되지 않은 도구 호출의 거부)와 어긋나는 길: 실행기의 목록과 SDK에 노출한 목록이 다른 곳에서 만들어져 어긋날 수 있는가(한 출처인가).
   - 분할 세션이 `split_rule`만 가지는가: 분할 세션에서 `propose_rule` · `supersede_rule` · `retire_rule` · `uphold_rule` · 파일 · 명령 도구를 부르면 거부되는가. 다른 세션(요구사항 · 이의 판단 · 검사 실패 판단 · 재판단)과 다른 역할에서 `split_rule`을 부르면 거부되는가. `sessionToolDefinitions`가 모르는 목록에 던지는 것이 세션을 열기 전인가(세션 중간에 던져 반쯤 쓴 상태가 남지 않는가).
3. **반영의 무결성 (NFR-01).**
   - `splitAgentRule`: 트랜잭션 1개인가. 실패 주입 5곳의 시험이 실제로 각 쓰기 뒤의 실패를 만들고 "아무것도 남지 않음"(규칙 · 신규 기록 · 판단 기록 · 폐기 기록 · 분할 기록 · 항목 처리 · 표시 ID 순번)을 보는가.
   - 검증: 새 규칙 2개 미만 · 6개 이상, 같은 진술(공백 · 대소문자 · 숨은 글자로 다르게 보이게 한 같은 진술: 정규화의 범위), 대상 규칙이 세션이 받은 그 규칙이 아님, 부모를 칸으로 줌, 동작 선언 빠짐, EARS 위반, 새 규칙의 진술이 **나눈 규칙의 진술과 같음**(나눈 척: 구현자 한계. 최소한 "새 규칙 가운데 하나가 원 규칙과 글자까지 같은 진술"은 거를 수 있는가, 거르는 것이 맞는가 의견).
   - 새 규칙의 속성: 부모 요구사항 = 나눈 규칙의 부모(트리거도 봄). 대상 블록 · 위험도는 세션이 정하는가(나눈 규칙보다 넓은 블록을 새 규칙에 줄 수 있는가: 그래도 되는가). 확인 상태(미확인) · 작성 주체. **사람이 확인한 규칙을 나누면** 확인이 풀리는 기록이 기존 대체와 같은 방식인가.
   - 승인 대기 제안 0건(ADR-100). 규범 변경 기록에 사유와 근거(NRM-07)가 남는가(`grounds`의 검증: 빈 값 · 길이 · 숨은 글자).
   - **처리 함수 `settle`을 세션 요청에 실어 넘기는 구조**: 세션 코드가 받은 함수를 트랜잭션 안에서 부른다. 이 구조가 (a) 구조 시험("세션 코드는 검토 대기열을 모른다")을 글자로만 지킨 회피인가 정직한 의존 뒤집기인가, (b) 함수가 던지면 반영 전체가 되돌려지는가, (c) 세션 요청이 대기열에 있는 동안 항목이 다른 길로 처리되면(한도 상향 재개) `settle`이 무엇을 하는가(이미 처리된 항목 → 반영 전체 실패? 규칙은 나뉘고 항목 처리만 실패?), (d) 분할 세션이 아닌 길로 `splitAgentRule`이 불릴 수 있는가.
4. **0031.** 트리거 SQL을 줄마다 읽는다. `rule_splits_insert`가 요구하는 것(짝 `superseded` 기록의 `detail.retirement.split`과 위치 대조)을 직접 SQL로 어긋나게 넣어 본다(위치 건너뛰기 · 위치 1이 `superseded_by`와 다름 · 다른 부모의 규칙 · 내장 규칙 · 이미 폐기된 새 규칙 · 같은 새 규칙을 두 분할에). `review_items_resolve_split_rule`: 분할 행 없이 `split_rule` 처리(거부), 다른 실행의 대상 규칙으로 처리(거부), 분할 행이 1개(거부). **"사람 주체일 때만 본다"**는 조건이 구멍인가(사람 아닌 주체는 0028의 CHECK가 거부한다는 주장을 SQL로 확인). 적용 전후의 `sqlite_master` 비교(0030 적용 DB → 0031 적용 DB: 새 객체만 늘었는가, 0028의 트리거 · 뷰 · `judgments`가 그대로인가). 기존 DB(폐기 기록 · 항목이 있는 것)에 적용. `superseded_by`가 첫 새 규칙만 가리키는 것이 기존 읽는 곳(규칙 상세의 대체 링크 · 규범 입력 · 효력 판정)을 틀리게 하지 않는가(둘째 이후 새 규칙이 "어디서 왔는지" 읽는 곳이 필요한 자리가 있는가).
5. **RPC와 세션 띄우기.** 거부 순서와 코드(위 목록)를 직접 호출해 확인한다. 사람 주체 확인이 저장소를 열기 전인가. 대상 규칙이 여럿인 실행에서 한 규칙만 나눈 뒤 항목이 처리됨이 되면 **나머지 대상 규칙은 영영 처리 액션이 없다**(ADR-147 한계: 문서에 사실대로 있는가). 같은 항목에 분할 세션이 대기 · 진행 중일 때의 거부(프로세스 메모리 잠금): 재기동 뒤 항목이 열림으로 남고 다시 누를 수 있는가, 세션이 실패 · 한도로 끝나면 잠금이 풀리는가(풀리지 않으면 그 항목은 재기동 전까지 못 나눈다). 분할 세션이 도는 동안 사람이 같은 항목에 한도 상향 재개를 누르면(3-(c)).
   - 세션의 예산: 하루 한도 · 세션 한도가 요구사항 세션과 같은 문인가. 분할 세션의 비용이 하루 지출에 잡히는가.
   - 작업 지시에 실리는 글: 규칙의 제목 · 진술(에이전트나 사람이 쓴 글)이 표시 값 변환 · 틀을 거치는가(기존 판단 세션의 방식 그대로인가). 원 실행의 종료 사유 · 멈춘 단계가 고정 값인가(자유 글이 아닌가).
6. **뒤따르는 실행 (수용 기준 3).** 분할 세션이 끝나면 기존 자동 시작이 새 규칙마다 실행 1개를 선언대로의 유형으로 만드는가(새 시작 경로 없음). 시작 근거 대조(`checkRunStartBasis`)가 분할로 생긴 규칙의 신규 기록을 원인으로 받는가. 하루 한도 비움 · 설정 미비 · 대기. 나눈 규칙(폐기됨)의 대기 중이던 다른 실행은 기존 효력 확인으로 끝나는가. 나머지 대상 규칙이 다시 시작되지 않음의 시험.
7. **시험과 구조 시험.** `review-queue-split.test.ts`(1042줄) · `store/test/rule-splits.test.ts` · `auto-start.test.ts`의 새 절 · `integrity.test.ts`의 새 구조 시험 둘을 읽고 단언이 뜻을 고정하는지 본다. 기존 허용 목록이 넓혀지지 않았다는 주장(`integrity.test.ts`의 `-` 줄).
8. **ADR-153과 architecture.md.** 문장마다 코드와 맞는가. 한계가 사실대로인가. ADR 머리줄 순서(151 · 152 · 153). `grep -c 'udb40' docs/decisions.md`는 2.
9. **변이.** 구현자의 것(PR 본문 표: 13행 안팎)과 겹치지 않게 8 ~ 10종. 후보: ⓐ 분할 세션에 `supersede_rule`도 주기, ⓑ 요구사항 세션에 `split_rule` 주기, ⓒ `splitAgentRule`에서 폐기 기록을 새 규칙보다 먼저 쓰고 실패 주입, ⓓ 새 규칙의 부모를 입력에서 받기, ⓔ `settle`이 던져도 반영을 커밋, ⓕ `rule_splits_insert`의 위치 연속 조건 빼기, ⓖ `review_items_resolve_split_rule`에서 대상 규칙 대조 빼기, ⓗ 분할 세션이 끝나도 잠금을 풀지 않기, ⓘ 새 규칙의 동작 선언을 버리고 늘 `new`로, ⓙ 진술 중복 검사를 스키마에서만(반영 모듈에서 빼기), ⓚ 어댑터가 분할 세션에 역할 목록(규범 도구 넷)을 노출. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다(제품에서 생기지 않는 상태면 근거와 함께 비차단).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr320.XXXX)`): orchestrator `review-queue-split` · `review-queue` · `review-queue-budget` · `rule-writer` · `fixed-tools` · `norm-supersede` · `objection` · `auto-start` · `integrity`와 어댑터 관련 시험, store 전체, shared `domain` · `protocol`. 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번(격리 `TMPDIR`). 알려진 두 시험만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- SQL 직접 확인은 scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r320-probe/` 아래의 임시 스크립트로 한다(네 작업 공간의 빌드 산출을 가져다 쓴다. 제품 DB · 다른 작업 공간을 건드리지 않는다).
- 숨은 글자: 바뀐 파일 전부를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(출력이 없어야 한다).
- 끝낼 때 작업 트리가 깨끗한지와 네가 띄운 프로세스가 남지 않았는지 확인한다(네 PID만 끝낸다).
- 시간 제한은 없다. 2번(도구 노출) · 3번(반영) · 4번(0031)을 가장 먼저 한다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 3개별 충족 여부와 근거(파일:줄, 시험).
- 도구 노출 판정(어댑터 변경이 기존 역할에 주는 영향, 무엇이 지키는가), 반영 판정(`settle` 구조 포함), 0031 판정(`sqlite_master` 비교), RPC · 잠금 판정.
- 변이 결과 표(변이, 빨강이 된 시험).
- 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, 못 한 것, 지키지 못한 절차가 있으면 그것.
- 남은 지적이 한 번의 수정으로 닫힐 크기인지 한 줄.
