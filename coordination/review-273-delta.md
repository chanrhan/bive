너는 chanrhan/bive 저장소 PR #273(이슈 #263, M3-35 화면 다듬기)의 **차이 재검토자**다. 1회차 검토(REQUEST_CHANGES)의 지적이 반영됐는지와, 그 수정이 새 문제를 만들지 않았는지만 본다. 구현에 관여하지 않았다. 한국어로 일한다. 범위는 **바뀐 11개 파일**이다. 그 밖의 파일을 다시 검토하지 않는다.

## 받은 값
- 1회차에 본 헤드 `14bf269`, 새 헤드 `be6b671c455dd2710cad2b6f1d83b3df1a321af0`(이 헤드에서 CI `ci` success, 조율자 확인). 차이: `git diff 14bf269 be6b671`(11파일, +334 / -131).
- 네 작업 공간에서 `git fetch origin fix/263-confirm-screen-polish && git checkout --detach FETCH_HEAD`, `git rev-parse HEAD`가 새 헤드인지 확인. 변이는 네 작업 공간 안에서만, `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · GitHub 쓰기를 하지 않는다.
- 읽을 것: scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `review-273.md`(1회차 지시서), `brief-common.md`의 표시 규칙, `.claude/skills/dev-env/SKILL.md`(화면 e2e 실행). PR 본문(`scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/273`)의 변이 표.

## 1회차 지적과 구현자가 한 일 (확인 대상)
- **B1 · N1 고를 항목의 수명.** `navigation/pendingSelection.ts`가 `requestSelection` · `peekPendingSelection` · `clearPendingSelection`으로 바뀌었다. 받는 화면(`RulesScreen` · `RequirementsScreen`)이 마운트할 때 읽어 자기 상태에 두고 마운트 효과에서 지운다. 목록을 다 읽으면 그 카드를 고르고, 읽기 실패 · 화면을 떠남 · 프로젝트 전환이면 버린다. 구현자는 **지시와 달리** `useResetFiltersOnProjectChange.ts`의 `clearPendingSelections()` 호출을 main과 같게 되돌렸다(받는 화면이 마운트 때 지우므로 실행될 일이 없다는 이유).
  - 따질 것: ① 읽기(렌더 중 `peek`)와 지우기(효과)를 나눈 방식이 React 규칙에 맞는가(렌더 중 부수 효과 없음, StrictMode의 두 번 렌더 · 두 번 마운트에서 값이 한 번만 쓰이는가, 프로덕션 빌드와 개발 빌드에서 같은가). ② 링크를 눌렀는데 받는 화면이 **마운트되지 않는 경우**가 있는가(이미 그 화면에 있는 상태에서 같은 화면의 링크, 라우팅이 화면을 다시 만들지 않는 경우, 프로젝트가 없는 상태). 그때 값이 남아 다음에 엉뚱하게 쓰이는가. 되돌린 `clearPendingSelections()`가 정말 필요 없는가를 이 경우들로 판정한다. ③ 화면이 값을 쥔 뒤 프로젝트가 바뀌면 버려지는가(같은 표시 ID가 새 프로젝트에 있어도). ④ 목록 읽기가 실패했다가 재시도로 성공하면 어떻게 되는가(버림이 맞다). ⑤ 사용자가 목록이 뜨기 전에 다른 카드를 누르면 사용자의 선택이 이기는가. ⑥ 규칙 · 요구사항 두 화면의 구현이 같은 모양인가.
  - 새 e2e 5개가 위 성질을 고정하는가. 구현자 변이(마운트 때 지우기 삭제 → 3 failed 등) 가운데 둘을 골라 직접 재현하고, 겹치지 않는 변이 둘을 더 한다: (가) 프로젝트가 바뀌어도 쥔 값을 버리지 않게, (나) 사용자가 먼저 고른 카드를 링크 대상이 덮게.
- **N2 죽은 단언 삭제.** `e2e/card-line.spec.ts`(-100줄쯤) · `support/overflow.ts`. 안 읽음 점 갈래만 지웠는가. 남은 단언(한 줄, 8px 간격, 시각 오른쪽 끝, 최소 3em, 넘침)이 그대로인가(`-` 줄을 하나씩 본다. 다른 단언이 함께 사라지거나 느슨해졌으면 차단).
- **N3 가장 긴 표시명.** `RuleDetail.css`에서 상태 칸이 줄 전체 폭을 쓰고 `word-break: keep-all`로 접히게 했다. 4개 창 폭에서 가로 넘침 · 겹침이 없고, 짧은 사유의 기존 배치가 달라지지 않았는가(시험 또는 캡처 한두 장으로). 상태 칸이 두 줄이 될 때 화면 정의서 1.1 · 카드 줄 규칙과 부딪치지 않는가.
- **N4 시간 대기 제거.** `support/bive-mock.ts`의 `settled()` · `allSettled` · `nextFrame`. "더 부르지 않음"을 보는 단언이 이제 무엇에 기대는가(응답 도착 + 다음 프레임 뒤 호출 수). 거짓 초록(아직 안 나간 호출을 놓침)이 가능한 순서가 있는가. 가짜 브리지 변경이 다른 spec의 동작을 바꾸지 않는가.
- **N5 늦은 응답.** `scr-06-rule.spec.ts`의 새 시험이 1.5초 지연 응답에 기대는 방식이 불안정하지 않은가(지연은 가짜 응답 쪽이고 단언은 조건 대기인가).
- **N6 · N7 ADR-123.** 고친 문장이 화면 정의서 1.4 · ADR-034의 실제 문장과 맞는가. 고를 항목의 수명 · 다른 규칙 실행의 사유가 보이는 한계가 코드와 맞게 적혔는가.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`.
- 화면 e2e는 바뀐 spec만: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome)`을 주고 `scr-17` · `scr-06-rule` · `card-line`(`--trace off`). 새 시험 5개와 늦은 응답 시험은 `--repeat-each 5`로 한 번 더 돌려 불안정한지 본다. 전체 `pnpm e2e` · 스모크 · `pnpm test` · 파이프라인 e2e는 돌리지 않는다(CI success).
- 숨은 글자: 바뀐 11개 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`(파일 명시). `grep -c 'udb40' docs/decisions.md`는 2.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 스크립트 파일로 감싸기, 다른 도구 · 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 다른 구현자가 같은 VM에서 PR #274를 고치는 중이다. 그 작업 공간 · 프로세스 · 포트를 건드리지 않는다. 끝나면 네 프로세스 · 임시 폴더를 정리한다(네 PID만). 40분 안에 끝내는 것을 목표로 한다.

## 판정과 보고
- 차단: 1회차 차단이 고쳐지지 않음, 값이 남아 엉뚱한 카드가 골라지는 순서, 사용자 선택을 덮음, 느슨해진 기존 단언, 불안정한 새 시험, 변이 생존, 사실과 다른 ADR 문장. 그 밖은 비차단(후속 후보).
- 보고: `APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(파일 · 줄 · 재현 · 고칠 방향), 비차단, 위 항목별 한 줄 결론, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. 한국어로, 짧게.
