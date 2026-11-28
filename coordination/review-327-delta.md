너는 chanrhan/bive 저장소의 PR #327(이슈 #245, M3-30 "자동 시작의 실행 유형 구분")의 **수정 1회차 차이**를 검토하는 독립 검토자다. 구현에도 첫 검토에도 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다. 범위는 차이다: 처음부터 전체를 다시 검토하지 않는다.

## 받은 값
- PR #327, 브랜치 `feat/245-auto-start-run-type`, 헤드 `2e99f3c683df757ee86a7d7807c37739f82a1b87`(main `e5a8816` 포함). 조율자가 `ci` 성공과 `clean`을 확인했다. 네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/2e99f3c683df757ee86a7d7807c37739f82a1b87/check-runs`로 한 번 더 확인한다.
- 차이의 범위: 첫 검토의 헤드는 `2d817a0`이었다. 그 뒤 main 병합 커밋 `122b72e`(main `e5a8816`: PR #322 · #326)와 수정 커밋 `2e99f3c`가 더해졌다. **수정 커밋의 차이는 `git diff 122b72e 2e99f3c`**(12개 파일 +405 / -76, 제품 코드는 `engine/start-basis.ts` +30 · `rule-writer/prompts.ts` +18 · `runs/auto-start.ts` +4 · `norms/agent-rule.ts` 주석 1줄). 병합 커밋은 충돌 없이 됐다고 한다(`git show 122b72e --stat`으로 확인).
- 네 작업 공간에서 `git fetch origin feat/245-auto-start-run-type` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
`.claude/skills/pr-reviewer/SKILL.md`, `CLAUDE.md`, scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `review-327.md`(첫 검토 지시) · `brief-245.md` · `pr327-body-r1.md`(지금 PR 본문: 검토 반영 절과 변이 표), `docs/decisions.md`의 ADR-151(지금 글) · ADR-110("결정 (사람)") · ADR-109(사람의 규칙 직접 편집 · 편집 뒤 자동 시작) · ADR-105(대기) · ADR-107 · ADR-111 · ADR-136 · ADR-149(이어받는 실행).

## 첫 검토의 지적과 구현자가 한 일 (네가 닫혔는지 판정한다)
- 차단 1 "금지된 길이 시험으로 막혀 있지 않다": `engine.test.ts`의 그 시험을 제품 `createRedCheckExecutor`를 도는 시험으로 바꿈(대상 규칙 2개, 하나는 전부 실패 · 하나는 통과 케이스 → `not_red` · `notFailedCases` · 대상 2개 그대로).
- 차단 2 "사람의 진술 편집 뒤에도 옛 선언이 살아 다시 시작이 유형 C": `declaredBehaviorOf(store, ruleId, changes?)`가 그 규칙의 승인 기록 가운데 진술이 바뀐 `rule_edit`(`ruleStatementEditOf(entry) !== null`)이 하나라도 있으면 `null`(모름 → A)을 돌려줌. 제목만 고친 편집은 해당 없음.
  - **결과로 생긴 동작**: 편집 전에 만들어져 승인 대기 · 실행 대기 · 진행 중이던 유형 C 실행은 편집 뒤 처음 구동될 때 시작 근거 대조에서 `type_mismatch`가 되어 `run_without_log`로 끝난다(진행 중이면 다음 단계를 열지 않고 끝남).
  - **구현자가 적은 빈자리(ADR-151 한계 (g))**: 대기 중이던 C 실행이 있었으면 편집 뒤 자동 시작(ADR-109)이 `pending`을 돌려줘 고친 진술의 실행이 자동으로 생기지 않는다(대기 중이던 C 실행은 `type_mismatch`로 죽는다 → 그 규칙의 실행이 하나도 남지 않는다). 진행 중이던 경우에는 편집 뒤 자동 시작이 새 유형 A 실행을 대기에 세운다고 한다.
- 차단 3 "다시 시작 갈래의 `type_mismatch` 시험 없음": `check-regression.test.ts`에 위조 실행(같은 원인 · 같은 대상 · 유형 A) → `type_mismatch` 단언.
- 권고: `runDeclarationOf`의 `causeLog` 검사 시험, 선언을 읽는 자리의 구조 시험(`integrity.test.ts` 새 시험. `agent-rule.ts` 주석의 `detail.behavior` 표기를 바꿈), `fixed-tools.test.ts`의 대체 도구 선언 필수, `RULE_BEHAVIOR_GUIDE`의 `existing` 문턱을 좁힘(요구사항 본문이 지금 동작을 바꾸지 말고 그대로 지키라고 밝힐 때만) + 판단 세션용 한 줄 `JUDGMENT_SUPERSEDE_BEHAVIOR_LINE`, ADR-151 ⑩과 한계.
- main 병합 뒤: 이어받는 실행(PR #326, 사람 주체 · `run_start` · 원 실행의 유형 그대로)은 사람 갈래라 `type_mismatch`를 보지 않고 `runDeclarationOf`는 `null`.

## 꼭 판정할 것
1. **차단 1이 닫혔는가.** 새 시험이 제품 Red 확인의 판단 코드를 실제로 도는가(주입한 것이 판정 러너뿐인가. 테스트 작성 실행기를 시험용으로 바꾼 것이 Red 확인의 입력을 왜곡하지 않는가). `steps/red-check.ts`에 "한 규칙이라도 Red면 이미 통과하는 규칙은 무시" 변이를 직접 넣어 빨강인지 확인한다. 비슷한 다른 꼴(통과 케이스가 있는 규칙을 대상에서 빼고 `passed` 처리, `notFailedCases`를 비우기)도 하나 더.
2. **차단 2의 수정이 맞는가 (가장 꼼꼼히: 제품 동작이 바뀌었다).**
   - `declaredBehaviorOf`가 편집을 판별하는 방법: 승인 기록을 규칙마다 훑는 비용(자동 시작 · 대조가 실행 구동마다 부른다: 기록이 많은 프로젝트에서 전체를 읽는가, 규칙으로 좁혀 읽는가), `changes?` 인자의 뜻, 편집이 **선언보다 앞**인 경우가 있을 수 있는가(신규 기록 전에 편집은 없다: 맞는가), 대체로 생긴 새 규칙(다른 ID)은 옛 규칙의 편집을 물려받지 않는 것이 맞는가.
   - **대기 · 진행 중이던 유형 C 실행이 `type_mismatch`로 끝나는 동작**: 이것이 "닫힌 쪽"으로 타당한가, 지나친가. 따져 볼 것: ⓐ 사람이 진술을 고친 순간 그 규칙의 대기 중 C 실행은 옛 진술을 "기존 동작"으로 본 실행이다: 죽는 것이 맞다고 볼 수 있다. ⓑ 그런데 편집 뒤 자동 시작(ADR-109)이 `pending`을 돌려줘 **고친 진술의 실행이 하나도 생기지 않는다**(구현자 한계 (g)). 이 PR 전에는 같은 상황(대기 중 유형 A 실행 + 사람 편집)에서 대기 중이던 실행이 고친 진술로 돌았는가(편집 뒤 자동 시작이 `pending`인 까닭이 "이미 그 규칙의 실행이 대기 중이라 그것이 새 진술로 돈다"였다면, 이 PR이 그 전제를 깼다). 실제로 재현해 본다: 기존 동작 선언 규칙 → 자동 시작 C 실행이 실행 대기 → 사람이 진술 편집 → 무엇이 남는가(실행 목록 · 규칙의 상태 · 사람이 알 수 있는 표시). **사람이 진술을 고쳤는데 그 진술을 검사하는 실행이 조용히 없어지는 것**은 사후 확인 모델(ADR-100: 에이전트가 다 하고 사람은 확인만)에서 구멍이다. 차단인지 판정하고, 차단이면 가장 작은 고침을 제안한다(예: `type_mismatch`로 끝난 그 실행의 원인을 편집 뒤 자동 시작이 다시 쓸 수 있게 하거나, 편집 때 대기 중인 C 실행을 A로 볼 수 없으니 편집 뒤 자동 시작이 `pending` 대신 새 A 실행을 대기에 세우게).
   - ⓒ 진행 중이던 C 실행이 중간에 `run_without_log`로 끝나는 것: 작업 폴더 · 브랜치 · 프로젝트의 자리(ADR-105)가 정상적으로 정리되는가, 종료 사유가 사람에게 뜻이 통하는가("기록 없는 실행"이라는 사유가 "사람이 진술을 고쳐서"를 가리는가).
   - ⓓ 병합된 뒤의 편집: 기존 동작 선언으로 이미 병합된 규칙의 진술을 사람이 고치면 편집 뒤 자동 시작은 유형 A(ADR-109 그대로)인가.
3. **`type_mismatch`의 다시 시작 갈래 시험(차단 3)**이 그 반환만 지우는 변이에 빨강인가.
4. **프롬프트.** `RULE_BEHAVIOR_GUIDE`의 새 문장이 사실인가: "작업 지시의 자료에는 요구사항 본문과 효력 있는 규칙의 진술 · 최근 판정의 케이스 이름이 있고, 판정의 통과 · 실패는 없다"를 `renderNormInput`에서 확인한다(세션 종류마다 같은가: 이의 판단 · 검사 실패 판단 세션은 판정 결과(실패 요약)를 받는다. 그 세션에도 "통과 · 실패는 없다"가 사실인가. 사실이 아니면 그 세션의 프롬프트에서 이 문장이 거짓이 된다). `existing`의 문턱("요구사항 본문이 지금 동작을 바꾸지 말고 그대로 지키라고 밝힐 때만")이 요구사항 본문(사람 또는 프로젝트의 글)에 기대는 것이 프롬프트 주입의 새 길을 여는가(요구사항 글에 "이 규칙은 existing으로 선언하라"가 있으면: 기존 방어(자료 틀 · "지시 아님" 표기)가 그대로 걸리는가). `JUDGMENT_SUPERSEDE_BEHAVIOR_LINE`이 들어간 프롬프트와 안 들어간 프롬프트가 맞는가. 스냅샷의 변경이 이 문장들뿐인가.
5. **구조 시험.** `integrity.test.ts`의 새 시험이 정규식 기반이다: `detail.behavior`를 읽는 다른 꼴(별칭 · 구조 분해 뒤 다른 이름 · `['behavior']`)을 실제로 잡는가(하나 넣어 본다). `agent-rule.ts`의 주석을 바꿔 시험을 지나게 한 것이 시험을 약하게 하지 않는가.
6. **main 병합과 #326.** 병합 커밋이 충돌 없이 됐는가, 두 PR이 함께 고친 파일(`engine/pipeline-engine.ts` · `runs/run-service.ts` · `ipc/run-handlers.ts`)에서 한쪽의 변경이 빠지지 않았는가(`git diff e5a8816 HEAD -- <파일>`이 이 PR의 변경만 보이는가). 이어받는 실행에 대한 주장을 시험으로 확인: 원 실행이 선언으로 유형 C였던 자동 시작 실행 → 예산 초과 → `resumeWithBudget` → 이어받는 실행(유형 C, 사람 주체)이 대조를 지나 구동되는가. **그 실행은 보강 실행이 아닌 유형 C다**(변이 주입 `skipped`): 원 실행과 같은 길인가.
7. **ADR-151.** 고친 문장(⑤ · ⑩ · 한계 맨 앞 두 문장 · (g))이 코드와 맞는가. 앞 ADR 본문을 고치지 않았는가. ADR 순서 148 · 149 · 150 · 151, `grep -c udb40 docs/decisions.md`는 2.
8. **변이** 5 ~ 7종(구현자의 6종과 겹치지 않게): 예 ⓐ 편집 판별이 제목만 고친 편집도 "모름"으로, ⓑ 편집 판별이 다른 규칙의 편집을 봄, ⓒ `runDeclarationOf`가 이어받는 실행에 선언을 싣기, ⓓ `JUDGMENT_SUPERSEDE_BEHAVIOR_LINE`을 요구사항 세션에도 넣기, ⓔ `type_mismatch`를 자동 시작 갈래에서만 지우기, ⓕ 대기 중 C 실행이 편집 뒤에도 그대로 돌게(대조에서 편집을 안 봄). 변이마다 빨강이 된 시험을 표로.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr327d.XXXX)`): orchestrator `engine` · `auto-start` · `check-regression` · `rule-writer` · `fixed-tools` · `integrity` · `rule-edit-start` · `objection` · `run-queue` · `review-queue-budget`, shared `domain`. 전체 `pnpm test` · 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- 숨은 글자: 수정 커밋이 바꾼 12개 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션 · 작업 폴더 · 경로 표기를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다("못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 끝낼 때 작업 트리가 깨끗한지와 네가 띄운 프로세스가 남지 않았는지 확인한다.

## 보고
판정(APPROVE / REQUEST_CHANGES)을 맨 앞에. 첫 검토의 차단 3건이 각각 닫혔는지, **2번(대기 · 진행 중이던 C 실행과 편집 뒤 빈자리)의 재현 결과와 판정**, 프롬프트 문장의 사실 여부(세션 종류별), 변이 표, 차단 · 비차단 지적, 실행한 명령과 결과, 못 한 것. 짧게.
