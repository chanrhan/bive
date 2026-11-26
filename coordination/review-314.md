너는 chanrhan/bive 저장소의 PR #314(이슈 #296, 로드맵 M3-51 "구조 검사 후속: 실패 원인의 표시 (겹친 파일 · 옛 프로젝트 안내 · 구현 세션 사유의 머리 문장)")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경 한 줄
M3-03(구조 검사, ADR-127)의 검토에서 넘긴 세 가지: ① 블록 선언 겹침(`block_declaration_overlap`)으로 끝난 실행에 겹친 파일 목록을 남기고 보이기 ② 블록 선언만 있고 내장 구조 규칙이 없는 프로젝트(`state_inconsistent`)의 처리 ③ 구현 세션의 앞 시도 사유에서 구조 위반을 인수 테스트 실패와 다른 머리 문장 아래에 싣기(ADR-144). 마이그레이션 없음.

## 받은 값
- PR #314, 브랜치 `fix/296-structure-check-failure-display`, 헤드 `35ff480fc66abbc5ddc6454919965afa3a12bd30`, 기준 main `e59a4dd`. 바뀐 파일 16개(+912 / -38). 조율자가 `ci` 성공(검사 5개 success: `checks` 15.3분 · 묶음 23.7 / 15.1분)과 `clean`을 확인했다. 네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/35ff480fc66abbc5ddc6454919965afa3a12bd30/check-runs`로 한 번 더 확인한다.
- 네 작업 공간에서 `git fetch origin fix/296-structure-check-failure-display` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-296.md`(구현자가 받은 지시서), `brief-common.md`, `m3-handoff.md`의 "M3-03" · "M3-35" · "M3-42" · "M3-23" · "M3-31" 절, `pr314-body.md`(PR 본문 사본, 변이 표 포함).
3. 이슈 본문 수용 기준 3개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/296`).
4. `docs/decisions.md`의 ADR-144(이 PR이 더함) · ADR-127 · ADR-123 · ADR-128 · ADR-135. `docs/spec/screens.md`의 1.1 · 1.4 · SCR-03 · SCR-06, `docs/spec/prd.md`의 JDG-05 · NFR-03.

## 구현자가 정한 것 (네가 타당성을 판정한다)
- ① 저장: 단계 결과의 구조 검사 요약(`exitDetail.detail.structure`)에 선택 칸 `overlaps: {items: [{file, blocks}], total}`. 경로는 판정 기록 케이스와 같은 표시 값 함수, 상한 20개(shared `RUN_OVERLAP_FILES_LIMIT`), `total`은 전체 수, 파일마다 겹친 블록 이름. 보이는 자리: 규칙 상세 실행 이력 줄의 종료 사유 아래. 응답: `run.list` 결과의 선택 칸 `failureNotes`(shared `RunFailureNote`, 새 파일 `orchestrator/src/runs/failure-notes.ts`), 해당하는 실행이 없으면 칸 자체를 싣지 않음. 그 실행의 **대상 규칙** 상세에만 보인다(대상이 아닌 내장 구조 규칙 상세에는 안 보임: `run.list {ruleId}`를 넓히지 않았다).
- ② (가) 처리 그대로(`state_inconsistent`, 단계 결과 불변) + 실행 이력 줄에 고정 안내 "내장 구조 규칙 없음 · 블록 선언 다시 저장 필요". 서버는 `{kind: 'builtin_rules_missing', runId}`만 보낸다. 같은 제목 행이 둘이거나 선언 없이 내장 행만 있는 경우는 안내하지 않는다. 고르는 기준이 기존 단계 결과 모양이라 옛 실행에도 붙는다. 자동 복구 없음.
- ③ 머리 문장: 구조 위반만 = 새 머리 `구조 검사(블록 선언): 통과하지 않은 내장 구조 규칙이 있다 (인수 테스트 실패가 아니다)`만. 인수 테스트 실패만 = 기존 글과 글자까지 같음. 둘 다 = 기존 머리와 항목 뒤에 새 머리와 구조 항목. 계약 검사 실패는 기존 머리 아래 그대로(한계).
- **ADR-127의 한계 문장 두 곳에 "(ADR-144로 닫음 …)"을 덧붙였다**(`docs/decisions.md`의 지운 줄 1).
- 구조 시험의 `builtin-rules.js` 가져오기 허용 목록을 넓히지 않으려고 `structure-check.ts`에 헬퍼를 두었다.
- 남긴 것: 병합 재검사에서 겹침이 생기면 종료 사유가 "병합 재검사 실패"라 겹친 파일이 화면에 안 보인다. 내장 규칙 상세에는 대상이 아닌 실행의 겹침이 안 보인다.

## 꼭 판정할 것
1. **범위와 불변.** `git diff e59a4dd...HEAD --stat`. `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · 워크플로 · 마이그레이션이 바뀌지 않았는가. 기존 시험 파일의 `-` 줄 전부(`structure-check.test.ts` -3 등): 고친 단언이 이 이슈가 바꾸는 동작인가. **구조 검사의 판정 · 회귀 · 병합 동작이 그대로인가**(`steps/structure-check.ts` +32 · `steps/implementation.ts` +41 -16이 표시와 기록만 바꾸는가). 인자 없는 `run.list` · `run.list {ruleId}`의 기존 칸이 그대로이고 새 칸은 선택 칸인가(해당 실행이 없으면 응답이 글자까지 같은가). **`docs/decisions.md`에서 앞 ADR(ADR-127) 본문을 고친 것**: 이 저장소의 관행은 "앞 ADR 본문은 고치지 않고, 닫았다는 사실은 새 ADR에만 적는다"다(최근 ADR-135 · 139 · 143이 그렇게 했다). 이 PR의 ADR-127 수정이 그 관행을 깨는지 `git log -p -- docs/decisions.md`의 선례(앞 ADR에 "닫음" 표기를 덧붙인 적이 있는가)로 판정한다. 선례가 없으면 되돌리라고 차단으로 적는다(작은 수정).
2. **① 겹친 파일.**
   - 저장: 겹친 파일을 계산하는 자리와 `overlaps`를 만드는 자리. 표시 값 변환이 판정 기록의 케이스 위치와 **같은 함수**인가. 상한 20과 `total`. 블록 이름은 선언 스키마가 정규화한 값인가. 파일이 아주 많을 때(수만 개) 계산 · 기록 크기. 겹침이 병합 재검사에서 생긴 경우의 기록.
   - 응답 `failureNotes`: `runs/failure-notes.ts`가 단계 결과에서 무엇을 읽는가(저장된 기록에서만: NFR-03). 실행마다 단계 결과를 읽는 N+1이 `run.list`에 생겼는가(인자 없는 `run.list`에도 붙는가, `ruleId`가 있을 때만인가. 실행이 수천 건일 때의 비용). 옛 단계 결과(칸 없음 · 모양이 다른 것 · 깨진 것)에서 던지지 않는가. 스키마가 엄격 객체인데 선택 칸으로 넓힌 것이 옛 앱 · 옛 응답과 호환되는가.
   - 화면: 실행 이력 줄에 붙는 조건(`noteFits`: 실행이 `failed`이고 종료 사유가 맞을 때만). 경로가 `visibleDisplayText`를 거치는가, 긴 경로의 잘림 · 공통 툴팁(`title` 속성 없음), "외 N개", 블록 이름의 표시. 문구가 1.1(명사형, 코드 표기 금지)과 화면 정의서의 낱말인가("겹친 파일"). 접힌 폭(820px)과 넓은 폭에서 넘침이 없는가(M3-42의 상태 칸 한 줄 단언을 깨지 않는가). 화면 사진을 찍어 본다(겹침 줄, 안내 줄).
   - "대상 규칙 상세에만 보인다"가 수용 기준("겹친 파일 목록을 보이는 자리가 문서 우선순위에 따라 ADR에 있으며")과 사용자의 필요(겹침은 내장 구조 규칙과 관련된 실패다: 사람이 그 규칙 상세에서 찾을 가능성)에 비춰 타당한가. 차단까지는 아니면 비차단으로.
3. **② 내장 규칙 없는 프로젝트.** (가)를 택한 근거가 ADR-144에 있는가. 안내를 고르는 기준(기존 단계 결과 모양)이 다른 `state_inconsistent` 사유(같은 제목 행이 둘, 선언 없이 내장 행만, 그 밖의 불일치)와 섞이지 않는가(그 경우들에 "블록 선언 다시 저장 필요"가 잘못 붙으면 거짓 안내다). 안내 문장이 사실인가(선언을 다시 저장하면 `blocks.set`이 내장 규칙을 만든다: ADR-127 ①). 문구가 1.1에 맞는가. `structure-check.test.ts`가 그 상태를 "그대로 단언"하는가(단계 결과 전체 `toEqual`).
4. **③ 머리 문장.** `describeImplementationUnmet`을 읽는다. 구조 위반과 인수 테스트 실패를 무엇으로 가르는가(`structureRuleDisplayIds`: 내장 구조 규칙의 표시 ID). **인수 테스트 실패만일 때의 글이 글자까지 예전과 같은가**(기존 글자 단언 시험이 고쳐지지 않았는가). 새 머리 문장의 "(인수 테스트 실패가 아니다)"가 구현 세션에 주는 글로 적절한가(고정 글, 문서 기호 없음). 항목의 틀 · 상한 · 표시 값 변환이 ADR-128 그대로인가(구조 위반 케이스의 메시지에는 프로젝트의 파일 경로 · import 글이 실린다). 계약 검사 실패가 기존 머리 "…인수 테스트…" 아래에 남는 한계가 ADR에 사실대로 적혔는가. 구현 세션 말고 이 글을 받는 곳(판단 세션 · 화면)이 있는가.
5. **시험.** `structure-check.test.ts`(+134) · `implementer.test.ts`(+90) · `scr-06-rule.spec.ts`(+167) · `run-history-view.test.ts`(+77)를 읽고 단언이 뜻을 고정하는지 본다. e2e에 `waitForTimeout` · 픽셀 숫자 단언 · 숨은 글자(글자 그대로)가 없는가. 목 데이터가 제품 코드 경로에 없는가. 새 구조 시험(M3-31)에 걸리지 않는가(`integrity.test.ts` 통과. `builtin-rules.js` 가져오기 허용 목록을 넓히지 않았다는 주장과 `structure-check.ts`에 둔 헬퍼가 내장 규칙을 **만드는** 코드가 아닌지 확인).
6. **ADR-144와 architecture.md.** 문장마다 코드와 맞는가. 남는 한계가 사실대로인가. ADR 머리줄: 이 브랜치는 142 다음 144다(143은 열린 PR #313의 것). 그대로가 맞다. `grep -c 'udb40' docs/decisions.md`는 2.
7. **변이.** 구현자의 14종(PR 본문 표)과 겹치지 않게 6종 안팎. 후보: ⓐ `failureNotes`를 겹침이 아닌 실패 실행(다른 종료 사유)에도 붙이기(서버 쪽), ⓑ 다른 `state_inconsistent` 사유에도 안내 붙이기, ⓒ 겹친 파일의 블록 이름 빼기, ⓓ `total`을 상한으로 자른 뒤의 수로, ⓔ 화면이 `total`이 `items` 길이와 같을 때도 "외 0개" 보이기, ⓕ 구조 위반과 인수 테스트 실패가 둘 다일 때 순서 뒤집기, ⓖ 내장 규칙 표시 ID 판정을 고정 제목 대신 `builtin` 전체로(계약 검사 규칙의 실패가 구조 머리 아래로 감), ⓗ `run.list`가 해당 실행이 없어도 빈 `failureNotes: []`를 싣기(글자 불변 깨기). 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다(제품에서 생기지 않는 상태면 근거와 함께 비차단).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr314.XXXX)`): orchestrator `structure-check` · `implementer` · `run` · `integrity` · `check-regression`, shared `protocol`, app `run-history-view`. 화면 e2e는 `scr-06-rule.spec.ts`만(`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome)`, `--trace off`, `BIVE_E2E_PORT` 지정). 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번(격리 `TMPDIR`). 알려진 두 시험만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 전체 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- 화면 사진은 `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r314-shots/`에 둔다(시험 파일을 고쳐 찍었으면 되돌린다).
- 숨은 글자: 바뀐 파일 16개를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션이나 도구를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 끝낼 때 작업 트리가 깨끗한지와 네가 띄운 프로세스가 남지 않았는지 확인한다(네 PID만 끝낸다. 다른 작업 공간의 프로세스는 건드리지 않는다).
- **시간**: 한국 시간 08:15까지 보고한다(`TZ=Asia/Seoul date +%T`). 모자라면 1 · 2 · 4 · 3 · 7 순서로 하고 못 한 것은 "못 함"으로 적는다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 3개별 충족 여부와 근거(파일:줄, 시험).
- ADR-127 본문 수정에 대한 판정(선례와 함께).
- 변이 결과 표(변이, 빨강이 된 시험).
- 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, 못 한 것, 화면 사진에서 본 것.
- 남은 지적이 한 번의 수정으로 닫힐 크기인지 한 줄.
