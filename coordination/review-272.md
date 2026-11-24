너는 chanrhan/bive 저장소의 PR #272(이슈 #265, 로드맵 M3-37 "케이스 이름을 통한 글 주입 길 좁히기")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일한다.

## 받은 값
- PR #272, 브랜치 `fix/265-case-name-literals`, 헤드 `f46b40b4fd7da11dfedaf34ee3f7cead8338dd25`, 기준 main `10ad3d5`. 바뀐 파일 24개(+1178 / -139). 이 헤드에서 CI `ci` · `checks` · `pipeline-e2e` 두 묶음은 모두 success다(조율자가 check-runs로 확인).
- 네 작업 공간에서 `git fetch origin fix/265-case-name-literals && git checkout --detach FETCH_HEAD`로 본다. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-265.md`(구현자가 받은 지시서), `brief-common.md`, `m3-handoff.md`, `pr272-body.md`(PR 본문 사본, 변이 표 M1 ~ M14 포함).
3. 이슈 본문 수용 기준(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/265`).
4. `docs/decisions.md`의 ADR-121(이 PR이 더함)과 그것이 가리키는 ADR(역할 분리 ADR-100 · ADR-110, 규범 자료 ADR-112 · ADR-113 · ADR-115, 인용 검사 ADR).

## 배경 한 줄
판정 결과의 케이스 이름은 구현 코드가 실행 중에 지어낼 수 있는 글이다. 그 글이 규범 역할 · 테스트 작성 역할의 세션 입력에 그대로 실리면 구현 역할이 채점 기준을 쓰는 역할에게 글을 주입하는 길이 된다. 이 PR은 그 이름을 "인수 테스트 파일에 리터럴로 적힌 이름"과 대조해 모르는 이름을 "알 수 없는 케이스 N건"으로 바꾼다.

## 꼭 판정할 것
1. **범위.** `git diff 10ad3d5...HEAD --stat`. 화면(`packages/app`) · 시나리오 · 마이그레이션 · `docs/spec/*` · `CLAUDE.md`가 바뀌지 않았는가. 새 의존성이 없는가(`package.json` · 잠금 파일).
2. **길이 정말 닫혔는가.** 케이스 이름(또는 판정 출력에서 온 글)이 세션 입력 · 규범 자료 · 인용 출처에 들어가는 자리를 네가 직접 전부 찾는다(구현자의 표를 출발점으로만 쓴다. `caseName` · `failed` · `passed` · `cases` · `message` · `stderr` · `collectNormInput` · 판정 결과 형식의 필드를 grep). 구현자가 "고침"이라 한 자리가 모두 같은 `knownCaseMatcher`를 지나는가. 표에 없는 자리가 있는가.
   - "그대로"(`existing-rule.ts:105`)와 "안 고침"(`implementation.ts:101`, `test-writing.ts:74`) 세 자리를 각각 판정한다. 그 글이 **역할 경계를 넘는가**(구현 역할이 지어낸 글이 테스트 작성 · 규범 역할의 입력에 실리는가)가 기준이다. `test-writing.ts:74`(테스트 작성 세션의 앞 시도 사유에 Red 확인의 통과 케이스 이름 · 수집 오류 메시지)는 구현자 스스로 "이미 병합된 구현 코드의 출력이 섞일 수 있다"고 적었다. 이것이 이슈 #265의 수용 기준 범위 안인가, 범위 밖 후속인가를 이슈 본문 문장으로 판정한다. 범위 안이면 차단이다.
   - 이름 말고 **메시지 · 스택 · 수집 오류 글**이 같은 길로 실리는 자리가 고친 네 길 안에 남았는가.
3. **대조 기준의 출처.** 기준(알려진 이름 집합)을 "규칙마다 최근 판정 커밋의 인수 테스트 파일을 git 객체에서" 읽는다고 했다.
   - 그 파일은 테스트 작성 역할만 쓸 수 있는 경로인가. 구현 역할이 쓸 수 있는 파일 · 작업 트리 · 기호 링크 · 다른 규칙 폴더에서 읽는 길이 없는가. 커밋을 고르는 값이 변조 가능한 곳에서 오는가.
   - 판정 기록이 없는 규칙, 커밋 객체가 없는 경우, 파일이 없는 경우에 닫힌 쪽(전부 모르는 이름)인가.
   - "기준은 세션 시작 때 만들어진다"(남는 길 ⓔ)가 세션 도중 생긴 판정 결과와 어긋나 이름을 잘못 통과시키는 순서가 있는가.
4. **파싱이 좁은가.** 받는 꼴: `describe` · `it` · `test`와 점 수식 `skip` · `only` · `todo` · `concurrent` · `sequential` · `fails` · `shuffle`, 첫 인자가 문자열 또는 보간 없는 템플릿. 직접 시험해 볼 꼴: 주석 안의 호출, 문자열 안의 호출 글, 다른 객체의 메서드(`foo.it("x")`), 가려진 이름(`const it = …`), `describe`의 중첩에서 판정이 보고하는 이름 형식(`A > B`)과 대조 방식(전체 경로인가 마지막 조각인가. 조각별 대조라면 서로 다른 리터럴을 이어 붙여 임의 글을 만들 수 있는가), 이스케이프(`\n`, `\u…`, 제어 글자, 숨은 글자)가 든 리터럴, 아주 긴 리터럴, 1 MiB 경계, 문법 오류 파일. 모호하면 모르는 이름이 되는가. 대조가 정확 일치인가(부분 포함 · 정규화 뒤 일치가 아닌가).
5. **모르는 이름의 표시.** "알 수 없는 케이스 N건"의 N이 정확한가(중복, 0건일 때). 이 글이 화면 · 기록에 나갈 때 `brief-common.md`의 표시 규칙을 지키는가. 모르는 이름의 **원문이 다른 칸**(기록 상세, 로그가 아닌 세션 입력)으로 새지 않는가.
6. **구조 시험.** `integrity.test.ts`가 +89줄 바뀌었다. 기존 단언이 지워지거나 느슨해지지 않았는가(`git diff 10ad3d5...HEAD -- packages/orchestrator/test/integrity.test.ts`에서 `-` 줄을 하나씩 본다). 새 구조 시험이 "글자 대조라 별칭 · 구조 분해는 놓친다"는 한계 안에서 실제로 무엇을 고정하는가.
7. **고친 기존 시험 · 하네스.** `test-writer.test.ts`의 바뀐 단언, 판정 기록을 실제 커밋으로 심게 바꾼 시험들, `engine-harness.ts` · `project-harness.ts` · `real-cli.test.ts`의 변경이 원래 고정하던 것을 여전히 고정하는가. 하네스가 실제 git 저장소를 쓰게 되면서 정리 누락 · 서명 오류 · 병렬 간섭이 생기지 않는가. `engine/types.ts` · `acceptance-lint.ts` · `existing-rule.ts`의 제품 코드 변경이 필요한 최소인가.
8. **시나리오 기준값.** 파이프라인 e2e 기준값이 그대로라는 보고를 `git diff --stat`으로 확인한다(e2e 폴더 변경 없음).
9. **문서.** ADR-121의 닫은 길 · 남는 길이 코드와 맞는가, 악용 절차를 적지 않았는가. `docs/architecture.md` 3곳이 사실인가.
10. **변이.** 구현자의 M1 ~ M14와 겹치지 않게 6종 안팎. 후보: ⓐ 정확 일치를 부분 포함으로, ⓑ `foo.it("x")` 같은 다른 객체의 호출도 받게, ⓒ 보간 있는 템플릿의 고정 부분을 받게, ⓓ 판정 기록이 없는 규칙에서 전부 통과시키게(열린 쪽), ⓔ 모르는 이름 건수 대신 원문을 싣게, ⓕ 커밋 대신 작업 트리 파일에서 읽게, ⓖ 중첩 이름을 조각별로 대조하게(지금이 전체 대조라면). 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`.
- 바뀐 시험 파일만(orchestrator): `case-names` · `check-regression` · `implementer` · `integrity` · `norm-supersede` · `objection` · `rule-writer` · `test-writer` · `real-cli`. `TMPDIR=$(mktemp -d /tmp/tr272.XXXX)`를 준다.
- 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험('의존성 설치 시간 초과')만 실패하면 통과로 본다. 전체 `pnpm e2e:pipeline` · 화면 e2e · 스모크는 돌리지 않는다(CI가 이 헤드에서 success다).
- 숨은 글자: 바뀐 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다. `grep -c 'udb40' docs/decisions.md`는 2여야 한다.
- 권한 시스템이나 격리 검사가 복합 명령을 "확인하기에 너무 복잡하다"로 거부하면, 검사기가 볼 수 있는 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 스크립트 파일로 감싸기, 다른 도구로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다. 그 확인은 "못 함"으로 보고한다. 프록시 환경 변수 값을 출력하지 않는다. 판정 격리를 돌아가는 대처를 하지 않는다.
- 다른 검토자가 같은 VM에서 PR #271을 보고 있다. 그 작업 공간 · 프로세스를 건드리지 않는다. 끝나면 네가 띄운 프로세스와 임시 폴더를 정리한다(네 PID만).

## 판정 기준
- 차단: 수용 기준 미충족, 표에 없는 열린 길(역할 경계를 넘는 것), 구현 역할이 쓸 수 있는 곳에서 기준을 읽음, 열린 쪽 기본값, 원문 누출, 느슨해진 구조 시험 · 기존 시험, 변이 생존, 사실과 다른 ADR 문장.
- 비차단: 취향, 범위 밖 개선. 후속 후보로 따로 적는다(새 이슈가 필요한지, 어느 열린 이슈에 붙일지 제안).

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(B1…, 파일 · 줄 · 재현 · 고칠 방향), 비차단(N1…), 위 10개 항목별 한 줄 결론, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. 한국어로, 짧게.
