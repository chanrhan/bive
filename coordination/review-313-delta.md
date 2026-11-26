너는 chanrhan/bive 저장소의 PR #313(이슈 #311, M3-54 "변이 주입 단계 켜기 · 변이 생존의 자동 테스트 보강 · 변이 재주입")의 **수정 1회차 차이**를 검토하는 독립 검토자다. 구현에도 첫 검토에도 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 받은 값
- PR #313, 브랜치 `feat/311-mutation-step-reinforcement`. 첫 검토 헤드 `9b6e98725b2f3743b0e32f85188dac5ca9689152`, 지금 헤드 `2aaf7903384505ae18d4f20f26c2bfbd8f16a874`. 커밋 셋: `2e8b644`(main `e59a4dd` 병합: PR #312의 구조 시험 · ADR-142) · `3a53df5`(수정 본체) · `2aaf790`(e2e 단언 순서). `ci`는 조율자가 따로 확인한다: 끝낼 때 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/2aaf7903384505ae18d4f20f26c2bfbd8f16a874/check-runs`를 한 번 보고 적는다(기다리지 않는다).
- 네 작업 공간에서 `git fetch origin feat/311-mutation-step-reinforcement` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.
- **볼 차이**: `git diff 2e8b644 2aaf790`(수정 본체와 e2e 고침. 18개 파일 +779 / -64). 병합 커밋 `2e8b644`는 충돌 해결만 본다: `git diff e59a4dd 2e8b644 -- docs/decisions.md`에서 ADR 머리줄 순서 140 · 141 · 142 · 143, ADR-142 본문이 main과 같은지(지운 줄 0), `grep -c 'udb40' docs/decisions.md`가 2.
- 제품 차이의 자리: `steps/test-writing.ts`(+71) · `steps/run-type.ts`(+57: `isReinforcementRun` · `ruleFolderFilesAt` · `existingTestViolations`) · `steps/green-check.ts`(+24) · `steps/merge.ts`(+28) · `test-writer/inputs.ts`(+21) · `test-writer/prompts.ts`(+17) · shared `domain.ts`(주석) · 앱 설정 화면 세 파일(CSS 선택자).

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `review-313.md`(첫 검토가 받은 지시서: 배경과 "꼭 판정할 것" 3), `brief-311.md`, `m3-handoff.md`의 "M3-06"(유형 C: Green 확인 · 소스 변경 거부 세 겹) · "M3-07" · "M3-31"(구조 시험) 절.
3. `docs/decisions.md`의 ADR-143(수정된 ⑪ · ⑮와 한계) · ADR-141 · ADR-136 · ADR-128 · ADR-100(B④).

## 첫 검토의 차단 지적 (이번에 닫혔는지 판정한다)
- **차단 1**: 보강 실행이 대상 규칙의 기존 인수 테스트를 지운 채 '변이 검증됨'으로 병합됐다(테스트 작성 결과가 규칙 폴더를 통째로 대신했다). 요구: 오케스트레이터가 "더하기만"을 강제한다(기존 파일의 덮어쓰기 · 삭제 금지, Green 확인 전과 병합 직전에 기존 파일이 기준 커밋과 바이트까지 같은지 대조). 보강이 아닌 테스트 작성은 글자까지 그대로.
- **차단 2**: 시험 공백 셋 — ⓐ 보강 실행의 프로젝트당 실행 1개 · 대기(차례에 하루 한도 재확인), ⓒ 시작 근거 대조의 "병합된 실행의 기록" 조건, ⓘ 보강이 아닌 유형 C의 변이 단계 생략.
- 비차단: 사실과 다른 문장(고리 방지의 근거), architecture.md · 낡은 주석, 정적 검사 서술, `requireServerAlive` 범위 시험, 변이 자료의 서로게이트 자르기, 설정 CSS 선택자, PR 본문 꼬리.

## 구현자가 보고한 수정 (믿지 말고 확인한다)
- 세션 입력: 기준 커밋의 대상 규칙 폴더 `*.acc.ts`를 같은 경로에 읽기 전용 사본으로 준다(앞 시도의 파일은 넣지 않는다).
- 결과 받기(`steps/test-writing.ts` `checkOutputs`): 기존 파일과 같은 경로의 결과는 옮기지 않는다. 바이트까지 같으면 목록에서 빼고, 다르면 미충족 `existing_modified`(기존 재시도 길, 사유 "기존 인수 테스트 파일은 고칠 수 없다 (새 파일만 더한다)").
- 옮기기(`test-writer/inputs.ts` `applyTestWriterOutputs`의 `preserved`): 기존 파일은 지우지 않고, 앞 시도의 파일은 예전처럼 지운다. 기존 경로를 쓰려 하면 아무것도 바꾸지 않고 던진다.
- 대조(`steps/run-type.ts` `existingTestViolations`): 기준 커밋의 대상 규칙 폴더 파일 가운데 기준 커밋과 판정 커밋 사이에 바뀐(지움 포함) 경로. Green 확인과 병합 직전에서 돌고, 걸리면 `guard_violation`(`stage: 'test_only'`).
- 작업 지시 고정 문장 추가. 보강이 아닌 실행에는 `preservedFiles`가 붙지 않는다.
- 시험: `mutation.test.ts` "더하기만"(가 · 나 · 라 Green · 라 병합), `test-writer.test.ts`(다), `auto-start.test.ts`(ⓐ · ⓒ), `mutation.test.ts`(ⓘ · 고리 고정), e2e와 시나리오("새 파일 하나만", main의 기존 파일 바이트 · 폴더 목록 · 첫 병합 이후 변경이 새 파일 하나뿐).

## 꼭 판정할 것
1. **차단 1이 정말 닫혔는가 (가장 중요).** 보강 실행에서 대상 규칙의 기존 인수 테스트가 **바뀌거나 사라진 채 병합되는 길**을 네가 직접 찾는다.
   - "기존 파일"의 정의: `ruleFolderFilesAt(baseCommit, 대상 규칙 폴더)`. `baseCommit`이 보강 실행의 기준 커밋(첫 유형 A 실행이 병합된 뒤의 기준 브랜치)인가. 보강 실행이 **회귀로 여러 번** 테스트 작성을 돌 때(재주입 생존 → 회귀) 앞 시도가 더한 새 파일은 "기존"이 아니라 지워지고 다시 쓰이는가(의도대로인가), 그 사이 기준 브랜치가 앞으로 가면(`baseCommit`이 갱신되는가, 실행 시작 때 고정인가).
   - 우회 후보: 기존 파일의 **이름 바꾸기**(git은 지움 + 추가로 본다: `changedPathsBetween`가 rename 감지를 끄는가. 켜져 있으면 옛 경로가 목록에 안 나올 수 있다), **대소문자만 다른 이름**(파일 시스템이 대소문자를 가리지 않는 곳에서 `Health.acc.ts`를 쓰면 `health.acc.ts`를 덮는가: 이 VM은 Linux지만 제품은 Windows · macOS에서 돈다. `checkOutputs`의 경로 비교가 대소문자 · 유니코드 정규화를 어떻게 다루는가), **하위 폴더**(`bive-acceptance/RULE-003/sub/x.acc.ts`), **`*.acc.ts`가 아닌 기존 파일**(도우미 `helpers.ts` · 픽스처 json: 사본은 `*.acc.ts`만 준다고 했다. 대조는 폴더의 모든 파일을 보는가. 세션이 기존 도우미 파일을 같은 이름으로 내면 `checkOutputs`가 어떻게 하는가), 파일 **모드** 변경 · 심볼릭 링크로 바꾸기, 기존 테스트를 **무력화하는 새 파일**(같은 폴더에 vitest 설정 · `setup` 파일 · 전역을 바꾸는 `*.acc.ts`를 더해 기존 케이스가 늘 통과하게 하기: 판정은 BIVE 전용 vitest 설정을 쓰므로 설정 파일은 무시되는가. 새 `*.acc.ts`가 다른 테스트 파일의 동작을 바꿀 수 있는가(vitest 파일 격리)), 새 파일에서 기존 케이스와 **같은 이름의 케이스**를 선언(케이스 이름 대조 · 규범 자료에 영향).
   - 세 겹이 각각 독립인가: (i) `checkOutputs`의 미충족 (ii) `applyTestWriterOutputs`의 보존 · 던짐 (iii) Green 확인 전 대조 (iv) 병합 직전 대조. 하나씩 빼는 변이를 네가 다시 넣어 어느 시험이 빨강인지 표로 낸다(구현자 표를 믿지 않는다). 특히 (iii)과 (iv)가 **(i) · (ii)를 지나친 변경을 시험이 직접 커밋에 넣는** 방식으로 따로 고정돼 있는가.
   - Green 확인과 재주입이 **기존 + 새 케이스 전부**를 판정하는가(기존 테스트가 새 파일 때문에 깨지면 Green이 아니다): 코드와 시험으로.
   - 읽기 전용 사본: 세션이 세션 폴더의 사본을 고쳐도 결과에 반영되지 않는가(같은 경로의 결과는 (i)이 거른다: 바이트가 같으면 조용히 빼고 다르면 미충족. "조용히 빼기"가 문제를 숨기지 않는가). 사본을 주는 것이 역할 분리에 어긋나지 않는가(테스트 작성 역할이 자기 규칙의 테스트를 본다: 유형 A의 다시 쓰기에서는 주지 않았다. 그 차이의 근거가 ADR에 있는가). 사본에 **다른 규칙의 테스트**가 섞이지 않는가.
   - `existing_modified` 미충족의 사유 글이 다음 시도에 전달될 때 표시 값 · 상한을 거치는가(파일 경로 목록).
2. **보강이 아닌 테스트 작성은 그대로인가.** `steps/test-writing.ts`(+71) · `inputs.ts`(+21) · `prompts.ts`(+17)의 새 분기가 유형 A와 보강 아닌 유형 C에서 **하나도 돌지 않는가**(`isReinforcementRun`이 거짓이면 예전 경로와 글자까지 같은가). 기존 시험의 `-` 줄(이 차이에서 지운 단언)이 있는가. `isReinforcementRun`은 저장소를 읽는다: 유형 A 실행마다 읽기가 한 번 늘었는가(성능은 사소하지만 `context.read`가 없는 시험 하네스에서 깨지지 않는가).
3. **차단 2.** ⓐ · ⓒ · ⓘ의 새 시험을 읽고, 첫 검토의 변이(ⓐ 보강 실행에서만 빈자리 판정을 참으로, ⓒ `origin.status !== 'merged'` 빼기, ⓘ 보강 아닌 유형 C에서 새 변이 단계 돌리기)를 네가 다시 넣어 빨강을 확인한다.
4. **새로 생긴 문제.** `mutation-harness.ts`(+64: `testWriter` · `executors` 옵션, 제품 병합 실행기를 쓰려고 `ensureBuiltinStructureRules`를 부름)가 기존 변이 시험의 뜻을 바꾸지 않았는가. e2e `mutant-survives.test.ts`의 고친 단언이 약해지지 않았는가(첫 검토가 확인한 항목: 첫 실행 병합 · '변이 생존' · 사람 조작 없는 유형 C · 구현 생략 · Green 확인 · 변이 단계 통과 · '변이 검증됨' · 변이가 어떤 ref에도 없음이 그대로 있는가). 설정 화면의 선택자 변경(`form.ts` `ROLE_ROW_LABEL_KINDS`, `BudgetModelSection.tsx`의 속성 하나)이 다른 행의 모양 · 기존 e2e를 깨지 않는가(`scr-21*.spec.ts`를 돌린다). 새 구조 시험(M3-31: 종료 상태 리터럴 · 저장소 접근)에 수정분이 걸리지 않는가(`integrity.test.ts` 통과). `guard_violation`으로 끝내는 새 자리가 `halt`(→ `runEnding`)를 거치는가.
5. **문서.** ADR-143의 ⑪(고리 방지의 근거: 유형 A 조건 · 최신 기록 · 트리거)과 ⑮(더하기만)가 코드와 맞는가. 지운 한계 문장과 남은 한계가 사실대로인가. 정적 검사 서술이 `judge/acceptance-lint.ts`의 실제와 맞는가. `docs/architecture.md` 4장의 유형 C 행 · 자동 보강 · 시작 근거 대조 서술. 악용 절차가 적혀 있지 않은가. PR 본문(`scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/313`)의 끝 표기와 사실 문장.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr313d.XXXX)`): orchestrator `mutation` · `test-writer` · `auto-start` · `integrity` · `engine` · `run-types`(유형 C의 기존 시험) · `judge-runner`(알려진 두 시험 제외). 화면 e2e는 `scr-21.spec.ts` · `scr-21-mutation-role.spec.ts`만(`--trace off`, `BIVE_E2E_PORT` 지정). 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번(격리 `TMPDIR`). 알려진 두 시험만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 부하로 보이는 시간 초과는 그 파일만 다시 돌려 가린다.
- 파이프라인 e2e: 픽스처 설치 뒤 `mutant-survives.test.ts` 한 파일(실제 판정 러너, 약 4분). 그리고 첫 검토의 재현을 다시 한다: 시나리오의 보강 세션이 **기존 파일을 다른 내용으로 다시 쓰게** 임시로 바꿔(Edit, 뒤에 되돌림) 돌리면 병합되지 않고 기존 파일이 그대로인지.
- 숨은 글자: 이 차이가 바꾼 파일 18개를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션이나 도구를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다. 판정 격리를 돌아가는 대처를 하지 않는다. 실제 API 키를 쓰지 않는다.
- 끝낼 때 작업 트리가 깨끗한지와 네가 띄운 프로세스가 남지 않았는지 확인한다(PID · cmdline · cwd를 확인한 네 PID만 끝낸다. 다른 작업 공간의 프로세스는 건드리지 않는다).
- **시간**: 한국 시간 08:10까지 보고한다(`TZ=Asia/Seoul date +%T`). 모자라면 1 · 2 · 3 · 4 · 5 순서로 하고 못 한 것은 "못 함"으로 적는다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 차단 1 · 2별 닫힘 여부와 근거(파일:줄, 시험, 재현 결과).
- 우회 후보별 결과 표(후보, 막히는가, 무엇이 막는가).
- 세 겹(네 자리) 변이 결과 표와 ⓐ · ⓒ · ⓘ 변이 결과.
- 보강이 아닌 테스트 작성이 그대로라는 확인.
- 새 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, check-runs 상태, 못 한 것.
- 이것은 수정 1회차다(최대 2회). 남은 지적이 한 번의 수정으로 닫힐 크기인지 한 줄.
