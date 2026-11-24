너는 chanrhan/bive 저장소의 PR #256(이슈 #226, 로드맵 M7-14 "확인할 것 화면 · 할 일 배지")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다.

## 받은 값
- PR #256, 브랜치 `feat/226-confirmation-screen`, 헤드 `524f15fe0ad3dc921fd471b4d4422103eb4dae0c`, 기준 main `e8b8f2c`. ADR-119. 마이그레이션 없음. 변경 53파일(지움 14).
- 네 작업 공간에서 `git fetch origin feat/226-confirmation-screen && git checkout --detach FETCH_HEAD`로 본다. 변이는 네 작업 공간 안에서만 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · 댓글을 하지 않는다. 결과는 보고로만 낸다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`(절차와 판정 형식), `.claude/skills/dev-env/SKILL.md`(화면 e2e · 스모크 기동, `TMPDIR`, 포트).
2. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-226.md`(구현자가 받은 지시서. 범위와 범위 밖), `brief-common.md`, `m7-handoff.md`의 M7-13 · M7-11 · M7-12 · M7-10 절.
3. `docs/decisions.md`의 ADR-100(사람 결정. 특히 확인 상태 · 확인할 것 목록 · 명세 변경 목록), ADR-113 · ADR-115(확인 · 확인 풀림 · 목록 순서), ADR-119(이 PR), ADR-035 · ADR-056 · ADR-063 · ADR-082(이 PR이 대체했다고 적은 것).
4. `docs/spec/screens.md`의 SCR-17 · 1.1(문구 원칙) · 할 일 배지 부분. ADR-100의 명세 변경 목록에 든 항목은 ADR-100이 명세 문장보다 우선한다(CLAUDE.md 1장).
5. 이슈 본문 수용 기준(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/226`), PR 본문(`scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/256`).

## 꼭 판정할 것 (각각 근거 파일 · 줄과 함께)
1. **수용 기준 4개**가 시험으로 고정됐는가. 시험이 "보이는지"만이 아니라 내용 · 순서 · 배치를 단언하는가.
2. **지운 시험이 "지워서 통과"가 아닌가.** `test/todo-proposals.test.ts` · `test/todo-proposal-detail.test.ts`와 전면 교체한 e2e 3개가 지키던 성질 가운데, 새 화면에도 여전히 있어야 하는 성질(조회 실패 표시, 재접속 뒤 다시 읽기, 긴 글 줄바꿈, 좁은 창, 숨은 글자 표기 등)이 새 시험에 남아 있는지 `git diff e8b8f2c...HEAD --stat`과 지운 파일 내용으로 대조한다.
3. **탭이 하나뿐인 것.** 지시서는 탭 2개(확인할 것 · 검토 대기열)였는데 구현자는 검토 대기열 탭을 두지 않았다(저장 · RPC가 M3-08 몫이라는 이유, ADR-035). 명세 · ADR-100 · NFR-03(지어낸 데이터 금지)에 비춰 이 선택이 보수적 해석으로 맞는지, ADR-119에 근거가 적혔는지 판정한다. 틀렸다고 보면 차단인지 후속인지 구분한다.
4. **위험도 칩.** 값이 전부 0건인 비활성 칩이 화면 정의서 문구 원칙 · NFR-03에 맞는지, 지어낸 값이 없는지, ADR-119에 결정이 적혔는지.
5. **다시 읽기 알림 `event.normChange.appended`.** `ipc/project-store-access.ts`의 `withRegisteredProjectStore`에서 사용 전후 마지막 순번을 비교해 알린다고 한다. 확인할 것: ⓐ 커밋 뒤에 알리는가(트랜잭션 중 알림 금지), ⓑ 규범 변경 기록을 쓰는 경로 가운데 이 함수를 지나지 않는 것이 있는가(엔진이 저장소를 오래 열고 쓰는 경로, 재기동 복구, 자동 시작, 판단 세션 등. `grep -rn "normChanges.append("`와 호출 경로로 추적), ⓒ 예외로 끝난 경우 · 여러 건이 한꺼번에 늘어난 경우, ⓓ 알림 내용에 기록 본문이 없고 `{projectId, lastSeq}`뿐인가, ⓔ `integrity.test.ts` 구조 시험이 느슨해지지 않았는가(`.normChanges.append(` 허용 목록 그대로, `.normChanges.` 읽기 허용 목록에 더한 파일이 마지막 순번 읽기만 한다는 단언이 실제로 그것을 막는가. 변이로 확인), ⓕ 매 RPC마다 순번 조회 2번이 드는 비용이 문제될 수준인가.
6. **`confirmation.list` 응답의 `totalByKind`.** 선택 칸인가, 합이 `total`과 같은가(시험 있는가), 잘린 목록(상한)일 때도 전체 기준인가, shared 스키마와 오케스트레이터가 같은 모양인가. 서버 순서(ADR-115: 폐기 · 대체가 맨 위)를 렌더러가 다시 정렬하지 않는가.
7. **[확인].** `confirmation.set`을 사람 주체로 정확히 1회 부르는가(연타 · 같은 대상 여러 항목), -32009 처리, 실패 표시. 렌더러가 확인 상태를 스스로 지어내지 않고 다시 읽은 결과만 쓰는가. 에이전트 경로에 확인 쓰기가 새로 생기지 않았는가.
8. **표기.** 에이전트가 쓴 글(사유 · 근거 · 규칙 문장 · 파일 경로 · 케이스 이름)이 모두 `visibleDisplayText` 또는 `visibleText`/`visibleLines`를 거쳐 그려지는가. 새 도우미 `visibleDisplayText`가 숨은 글자 · 양방향 제어 문자 · 꼬리표 문자를 실제로 드러내는가(역슬래시만 그대로 두는 것이 맞는지, 이중 변환 대조 시험이 진짜 대조인지). 빠진 자리를 `grep`으로 찾는다.
9. **표시명 표.** 판단 주제 5종 · 판단 결과 · 판단 없음 사유, 규범 변경 종류, 주체 표시명이 shared 표와 app 표에서 같고 대조 시험이 있는가. 새 enum 값이 표에 빠지지 않았는가. 화면에 코드 표기(`superseded`, `rule-writer` 같은 영어 식별자)가 그대로 나오지 않는가. 문구가 화면 정의서 1.1(명사형, 이모지 없음, 코드 표기 없음)을 지키는가.
10. **죽은 코드.** 지운 뒤 남은 참조 · 안 쓰는 export · 안 쓰는 CSS가 있는가. 오케스트레이터 `proposal.*` RPC는 남기는 것이 범위다.
11. **ADR-119 · `docs/architecture.md` 문장이 코드와 같은가.** 한 문장씩 대조한다. 대체했다고 적은 ADR 번호가 맞는가.
12. **53파일을 한 PR로 둔 것**이 검토 가능한 묶음인지 의견을 낸다(나눠야 한다면 경계).

## 실행으로 확인할 것
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 단위 시험은 app · shared 전체와 오케스트레이터의 바뀐 시험 파일만(`pnpm --filter <패키지> exec vitest run <파일>`). 전체 `pnpm test`는 돌리지 않는다(CI `ci`가 이 헤드에서 success다. `git merge-base --is-ancestor 97b4d86 HEAD`는 참이지만 사용량을 아낀다). `TMPDIR`은 짧은 격리 경로로.
- 화면 e2e는 바뀐 spec만: `scr-17.spec.ts` · `todo-entry.spec.ts` · `todo-badge.spec.ts` · `reconnect` · `card-line` · `min-window`. 스모크 `xvfb-run -a pnpm smoke` 1회.
- **스크린샷을 직접 찍어 눈으로 본다**: 창 폭 820 · 1100 · 1280에서 ⓐ 목록(여러 종류 섞임, 긴 제목), ⓑ 대체 상세(diff), ⓒ 미확인 규칙 상세(판단 카드 2종), ⓓ 테스트 변경 상세(파일 목록이 긴 경우), ⓔ 필터 칩을 켠 상태, ⓕ 빈 상태. 겹침 · 잘림 · 가로 스크롤 · 줄바꿈 깨짐 · 칩 넘침을 본다. 구현자의 스크린샷(`/home/user/bive/.claude/worktrees/agent-ad4152d54e91af75a/artifacts/screens/SCR-17/`)은 참고만 하고 네가 찍은 것으로 판정한다. 긴 글(공백 없는 200자 제목, 긴 경로)을 넣은 경우도 한 장 본다.
- **변이 시험**: 구현자의 8종과 겹치지 않게 최소 10종. 예: 서버 순서를 렌더러에서 뒤집기, [확인] 연타 방지 빼기, -32009 분기 빼기, 배지를 `items.length`로 바꾸기, `totalByKind` 한 종류 누락, 칩 필터 조건 뒤집기, `visibleDisplayText` 한 자리를 날 글자로, 판단 카드 표시명 하나 바꾸기, 알림을 커밋 전으로 옮기기 · 순번 비교 빼기, 알림 구독 한 곳 빼기, 구조 시험 허용 목록의 새 단언을 깨는 코드 넣기. 변이마다 어느 시험이 빨강이 됐는지(또는 안 됐는지) 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 판정 기준
- 차단(REQUEST_CHANGES): 수용 기준 미충족, 지워서 통과, 무결성(NFR-01 · NFR-02) · NFR-03 위반, 구조 시험 느슨해짐, 방어는 있는데 시험이 없는 중요한 자리, 창 폭에서 깨지는 배치, ADR 문장이 코드와 다름(사실 오류), 표기 누락.
- 비차단: 범위 밖 개선, 취향. 후속 이슈 후보로 따로 적는다.
- 반복해서 걸린 것: ⓐ 보이는지만 단언, ⓑ 시험 없는 방어, ⓒ ADR 문장 불일치, ⓓ 표시명 표 누락, ⓔ `visibleText` 누락, ⓕ 창 폭 배치.

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단 목록(B1…, 각 파일 · 줄 · 재현 · 고칠 방향), 비차단 목록(N1…), 위 12개 판정 항목별 한 줄 결론, 실행한 명령과 종료 코드, 변이 표, 스크린샷 경로(네 작업 공간 절대 경로)와 본 것, 후속 이슈 후보. 토큰을 아낀다. 한국어로 쓴다.
