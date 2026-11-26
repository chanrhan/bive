너는 chanrhan/bive 저장소 PR #275(이슈 #201, M3-23 화면 보완: 공통 툴팁 등)의 **차이 재검토자**다. 1회차 검토(REQUEST_CHANGES)의 지적이 반영됐는지와, 그 수정이 새 문제를 만들지 않았는지만 본다. 구현에 관여하지 않았다. 한국어로 일한다. 범위는 **바뀐 7개 파일**이다. 그 밖의 파일을 다시 검토하지 않는다.

## 받은 값
- 1회차에 본 헤드 `5225aad`, 새 헤드 `6eb9299af58a8b21c176d86b3a46b6762da36c53`(이 헤드에서 CI `ci` success, 조율자 확인). 차이: `git diff 5225aad 6eb9299`(7파일, +301 / -27): `components/Tooltip/TooltipHost.tsx`(+66 / 제품 코드는 이것 하나), `e2e/card-line.spec.ts` · `code-link.spec.ts` · `scr-05.spec.ts` · `scr-06-rule.spec.ts` · `support/overflow.ts`, `docs/decisions.md`(ADR-124).
- 네 작업 공간에서 `git fetch origin fix/201-screen-followups && git checkout --detach FETCH_HEAD`, `git rev-parse HEAD`가 새 헤드인지 확인. 변이는 네 작업 공간 안에서만(Edit 도구로), `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · GitHub 쓰기를 하지 않는다.
- 읽을 것: scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `review-275.md`(1회차 지시서), `brief-common.md`의 표시 규칙, `.claude/skills/dev-env/SKILL.md`(화면 e2e 실행). PR 본문의 변이 표(`scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/275`). ADR-124 전체.

## 1회차 지적과 구현자가 한 일 (확인 대상)
1. **B1 Esc 전파.** 툴팁의 Esc를 창 캡처 단계에서 받고, 툴팁을 실제로 닫을 때만 `preventDefault` · `stopPropagation`을 부른다. 닫혀 있으면 리스너가 없다.
   - 따질 것: 캡처 단계 + `stopPropagation`이 `ChatPanel`의 `window` keydown과 `Modal.tsx`의 Esc 처리보다 먼저 받는가(같은 `window`에 걸린 리스너끼리는 `stopPropagation`으로 막히지 않는다. 캡처 단계 리스너가 버블 단계 리스너보다 먼저 불리는 것과, 같은 대상 · 같은 단계의 다른 리스너를 막으려면 `stopImmediatePropagation`이 필요하다는 점을 실제 등록 방식으로 확인한다. `ChatPanel` · `Modal` · 그 밖의 Esc 처리기를 grep으로 전부 찾아 각각 툴팁이 열린 상태의 Esc에서 불리지 않는지 본다). 입력란에 초점이 있을 때 · IME 조합 중 Esc(`isComposing`)에 툴팁이 열려 있으면 어떻게 되는가. 툴팁이 **모달 안 대상**에서 열렸을 때 Esc 한 번이 툴팁만 닫는가(지금 모달 안에 툴팁 대상이 있는가: 설정 IDE 섹션에는 없다고 했다. 있다면 시험, 없으면 코드로 판단).
   - 새 시험 둘(채팅 겹침, 모달)이 위를 고정하는가. 구현자 변이 둘(전파 안 멈춤, 닫힌 뒤에도 삼킴)을 직접 재현한다.
2. **B2 스크롤 · 창 크기.** 구현자는 **지시와 다르게** "스크롤마다 닫기"가 아니라 "대상이 보이는 영역(창과 넘침을 자르는 조상 상자를 겹친 영역) 밖으로 나갈 때만 닫고, 보이는 동안에는 따라간다"로 했다. 이유: 키보드 초점이 닿은 카드를 브라우저가 보이게 스크롤하는 것도 스크롤 이벤트라, 스크롤마다 닫으면 목록 아래쪽 카드의 툴팁이 뜨자마자 닫힌다. 창 크기 변경에는 항상 닫는다.
   - 이 판단이 타당한가를 판정한다(1회차 지시서의 요구는 "닫히거나 따라간다. 떠 있는 채 어긋나지 않는다"였으므로 따라가기도 허용 범위다). 따라가기 구현: 스크롤 이벤트마다 위치를 다시 재는 비용(카드 수백 개 목록에서 빠른 스크롤 때 강제 레이아웃이 프레임마다 여러 번 일어나는가, `requestAnimationFrame`으로 묶였는가), 캡처 단계 `scroll` 리스너가 열린 동안만 붙는가.
   - "보이는 영역" 계산이 맞는가: 대상이 **일부만** 보일 때(반쯤 잘림), 넘침을 자르는 조상이 여러 겹일 때, 가로 스크롤, `position: fixed` · `sticky` 조상, 조상이 `overflow: visible`일 때. 일부만 보이는 대상에서 툴팁이 엉뚱한 곳(목록 머리 · 다른 카드 위)에 뜨지 않는가.
   - 1회차 재현(1280×500, RULE-199 카드 초점 → `list-items` 맨 위로 스크롤)을 직접 다시 해 본다. 창 크기 변경 · 보이는 영역 밖 대상의 올림 시험이 실제로 그 성질을 고정하는가.
   - `support/overflow.ts`의 `listPaneOverflow`가 "잘린 카드 글자를 보이게 스크롤한 뒤 툴팁을 확인하고 스크롤 위치를 되돌린다"로 바뀌었다. 이 도우미를 쓰는 기존 시험들의 뜻이 느슨해지지 않았는가(스크롤 때문에 다른 단언의 전제가 달라지지 않는가, 되돌리기가 실패 경로에서도 되는가).
3. **B3.** `code-link.spec.ts`의 IDE 선택 단계 단언(legend 보임, `ide-path-hint` 없음, 입력에 `aria-describedby` 없음). 1회차 변이 ⓕ(`legendHidden` · `pathHint` 기본값 `true`)를 직접 재현해 빨강을 확인한다.
4. **B4.** ADR-124의 머리 배치 문장과 동작 표(Esc 전파, 스크롤, 창 크기 변경)가 지금 코드 · 시험과 맞는가. 문장마다 확인한다.
5. **N1.** `card-line.spec.ts`의 양방향 제어 문자가 이스케이프로 바뀌었는가: 바뀐 7개 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`(파일 명시)로 훑어 검출이 없어야 한다. 이스케이프로 바꾸면서 시험이 보는 값(실제 글자)이 달라지지 않았는가. PR 전체(main 대비 바뀐 25개 파일)도 한 번 훑는다. `grep -c 'udb40' docs/decisions.md`는 2.
6. **N4 · N5.** 창 오른쪽 끝 시험이 "시험 전용 스타일로 대상을 오른쪽 끝에 붙인다"는 방식이다. 제품 화면에서 일어날 수 있는 배치를 대표하는가, 시험이 제품 코드의 배치 계산을 실제로 지나는가. 긴 표시 ID · 배지 여러 개 데이터가 shared 스키마를 통과하는 가짜 응답인가.
7. **새 문제 · 안정성.** 수정이 1회차에 통과한 것(대상별 동작, 잘린 줄만, 리스너가 열린 동안만, 카드 배치 유지, 접근성 이름)을 깨지 않았는가. 리스너 수 시험이 새 리스너 4개를 세는 방식이 타당한가. 새 시험에 `waitForTimeout` · 고정 지연이 없는가. 스크롤 · 창 크기 시험이 프레임 시점에 기대 흔들리지 않는가.
8. **변이.** 위 재현 셋에 더해 넷: (가) Esc를 버블 단계에서 받게, (나) 보이는 영역 판정에서 조상 자르기를 빼고 창만 보게, (다) 스크롤 때 위치를 다시 재지 않게(따라가지 않음), (라) 창 크기 변경에 닫지 않게. 변이마다 빨강이 된 시험을 표로.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`.
- 화면 e2e는 바뀐 spec만: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome)`을 주고 `card-line` · `code-link` · `scr-05` · `scr-06-rule` · `list` · `scr-03`(`--trace off`. 뒤 둘은 `listPaneOverflow`를 쓰는 기존 시험). 새 시험은 `--repeat-each 5`로 한 번 더. 전체 `pnpm e2e` · 스모크 · `pnpm test` · 파이프라인 e2e는 돌리지 않는다(CI success).
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit 도구로 한다. 스크립트 파일로 감싸기, 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 다른 구현자가 같은 VM에서 이슈 #47(파서)을 작업 중이다. 그 작업 공간 · 프로세스 · 포트를 건드리지 않는다. 끝나면 네 프로세스 · 임시 파일 · 임시 폴더를 정리한다(네 PID만). 45분 안에 끝내는 것을 목표로 한다.

## 판정과 보고
- 차단: 1회차 차단이 고쳐지지 않음, 툴팁이 열린 Esc가 다른 처리기까지 감 · 닫힌 뒤에도 Esc를 삼킴, 떠 있는 채 어긋나는 툴팁, 스크롤 때 눈에 띄는 비용, 느슨해진 기존 시험, 불안정한 새 시험, 남은 숨은 글자, 변이 생존, 사실과 다른 ADR 문장. 그 밖은 비차단(후속 후보).
- 보고: `APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(파일 · 줄 · 재현 · 고칠 방향), 비차단, 위 8개 항목별 한 줄 결론, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. 한국어로, 짧게.
