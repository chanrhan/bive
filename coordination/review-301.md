너는 chanrhan/bive 저장소의 PR #301(이슈 #61, 로드맵 M3-16 "규칙 상세 최신 실행 링크 비용 · 턴")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경 한 줄
PRD COST-02("비용 · 턴 집계. 값 없으면 '없음', 0 표시 금지. P1은 규칙 목록의 실행 링크(실행 합계)")와 화면 정의서 SCR-03의 "최신 실행 링크"에 따라, `rule.get`이 그 규칙의 최신 실행과 실행 합계 비용 · 턴을 돌려주고 규칙 상세가 그것을 보인다(ADR-134). 마이그레이션 없음.

## 받은 값
- PR #301, 브랜치 `feat/61-rule-latest-run-cost`, 헤드 `5ae15577b180d1ae20b308b43c3359f2a68937fb`, 기준 main `97c8b50`. 바뀐 파일 14개(+772 / -10). 조율자가 `ci` 성공(검사 5개 success)과 `clean`을 확인했다. 네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/5ae15577b180d1ae20b308b43c3359f2a68937fb/check-runs`로 한 번 더 확인해 보고에 적는다.
- 네 작업 공간에서 `git fetch origin feat/61-rule-latest-run-cost` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-61.md`(구현자가 받은 지시서), `brief-common.md`, `m3-handoff.md`의 "M3-35" · "M3-23" 절, `pr301-body.md`(PR 본문 사본, 변이 표 포함).
3. 이슈 본문 수용 기준 2개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/61`), `docs/spec/prd.md`의 COST-01 · COST-02 · 4.7절, `docs/spec/screens.md`의 1.1 · 1.4 · SCR-03 · SCR-06.
4. `docs/decisions.md`의 ADR-134(이 PR이 더함) · ADR-067(실행 사용량 집계) · ADR-072 · ADR-073 · ADR-123 · ADR-060 · #135 관련 ADR(비용을 모르는 세션).

## 구현자가 정한 것 (네가 타당성을 판정한다)
- 최신 = 그 규칙을 대상으로 한 실행(`run_target_rules`) 가운데 표시 ID가 가장 큰 것. 질의는 `ORDER BY length(display_id) DESC, display_id DESC LIMIT 1`.
- 합계 = 기존 `runs.usage(runId).run`. `costUnknownCount > 0`이면 비용 `null`, `turnsUnknownCount > 0`이면 턴 `null`. 세션이 없으면 둘 다 `null`.
- 응답 칸 `latestRun: {id, displayId, costUsd, turns} | null`은 **선택 칸**(옛 응답에는 없음). 앱은 칸이 없으면 "최신 실행 불러오기 실패"로 보인다.
- 링크는 이동 없이 글자만. 비용 형식은 검증 화면의 `formatUsd`.
- 다시 읽기: `event.run.updated` · `event.step.updated` · 재접속. 늦은 응답은 요청 순번으로 버림.

## 꼭 판정할 것
1. **범위.** `git diff 97c8b50...HEAD --stat`. `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · `.github/workflows` · 마이그레이션 · `rule.list` 응답과 카드가 바뀌지 않았는가. `rule.update` 결과의 형식이 바뀌지 않았는가(`rule-edit.test.ts`의 고친 단언 1건이 무엇을 뜻하는지: `rule.update` 결과가 아니라 그 뒤의 `rule.get` 결과 단언인가). `RuleGetResult`를 쓰는 다른 자리(preload · main의 다리, CLI, 다른 화면)가 깨지거나 뜻이 바뀌지 않는가.
2. **"없음"과 0 (가장 중요, NFR-03 · COST-02).** `latestRunLink`와 `summarizeRunUsage`(ADR-067)를 끝까지 읽는다.
   - `usage(run.id)`가 `null`을 돌려주는 조건은 무엇인가. 그때 `null`(없음)이 맞는가.
   - 세션이 하나도 없는 실행에서 `run.costUsd`가 0이고 `costUnknownCount`도 0이면 **0이 나간다**. 구현자는 "세션이 없어도 `null`"이라고 했다: 어디서 그렇게 되는지 코드로 확인하고(집계가 세션 0건일 때 `null`을 주는가, 아니면 0을 주는가), 시험이 그 경우를 단언하는지 본다.
   - 비용을 아는 세션과 모르는 세션(진행 중, 결과 없이 끝남, 값이 `null`로 저장됨)이 섞인 경우 각각. 턴만 모르는 세션이 실제로 생길 수 있는가.
   - 부동소수 합(0.1 + 0.2)의 표시가 `formatUsd`에서 어떻게 되는가. 음수 · NaN · 무한대가 저장소 밖에서 들어온 행으로 올 수 있는가, 오면 스키마(`UsdOrNull`)가 어떻게 하는가(응답 검증 실패로 `rule.get` 전체가 실패하는가: 한계로 적혔는가).
   - 화면: `null`이면 "없음", 0이면 0(`$0.00` 등)으로 구분해 보이는가. `costUsd`가 `undefined`(옛 응답의 부분 칸)일 때는?
3. **최신의 기준.** 표시 ID 순서가 생성 순서와 같다는 전제가 저장소에서 지켜지는가(표시 ID 발급 방식). `length` 다음 글자 비교가 `EXE-9` · `EXE-10` · `EXE-100`에서 맞는가(시험이 자리수 넘김을 보는가). 규칙 상세의 실행 이력(`judgment.list`, ADR-073)이 쓰는 "최신"과 어긋나는 경우(판정 기록이 없는 진행 중 실행이 최신 실행 줄에는 보이고 실행 이력에는 없는 것)가 ADR에 적혔는가. 폐기된 규칙 · 내장 규칙(구조 · 계약 검사 규칙: 실행의 대상이 되는가)에서의 동작.
4. **질의와 성능.** `EXPLAIN QUERY PLAN`으로 그 질의가 `run_target_rules_rule` 색인을 쓰고 `runs` 전체를 훑지 않는지 본다(시험 DB를 하나 만들어 읽기 전용으로 확인. 실행이 수천 건일 때 정렬 비용: `IN` 하위 질의 결과만 정렬하는가). `rule.get` 한 번에 세션을 읽는 실행이 1건인지. `rule.list`에 N+1이 생기지 않았는지.
5. **화면 (SCR-06 규칙 상세).** 문구가 1.1(명사형, 코드 표기 금지, 이모지 금지)과 화면 정의서의 낱말을 따르는가("최신 실행", "비용", "턴", "없음"). "최신 실행 불러오기 실패"라는 문구의 선례가 있는가(ADR-073의 로딩 · 에러 방식과 같은가). 옛 응답(칸 없음)을 "실패"로 보이는 판단이 타당한가(없음으로 보이면 거짓, 실패로 보이면 과함: 어느 쪽이 보수적인지 판정). 표시 ID · 값이 `visibleText` 계열을 거치는가. 긴 값 · 좁은 폭(820px)에서 배치. 링크처럼 보이는데 누를 수 없는 모양은 아닌가(접근성: 역할 · 탭 순서).
   - **다시 읽기와 늦은 응답**: `useRuleDetailData.ts`의 요청 순번 처리를 읽는다. 규칙을 바꿀 때 옛 규칙의 응답이 새 규칙 상세에 그려지지 않는가. 다른 프로젝트의 알림에 읽지 않는가. 알림이 몰릴 때 요청이 겹겹이 쌓이지 않는가(기존 다시 읽기와 같은 방식인가). 기존 실행 이력 · 규칙 본문의 다시 읽기를 바꾸지 않았는가.
   - 다른 e2e 파일(scr-03 · scr-17 등)에서 `rule.get` 가짜 응답이 없어 상세에 "최신 실행 불러오기 실패"가 보인다고 한다. 그 파일들의 가짜 응답이 `rule.get`을 주는데 `latestRun`만 없는 것인가, `rule.get` 자체가 없는 것인가. 실제 제품에서는 생기지 않는 상태인지 확인한다.
6. **시험.** `rule.test.ts`의 새 시험 9개와 e2e 12개를 읽고, 단언이 구현을 그대로 베낀 것이 아니라 뜻을 고정하는지 본다. e2e에 `waitForTimeout` · 글자 폭이나 픽셀 단언 · 숨은 글자가 없는가. 목 데이터가 제품 코드 경로에 없는가.
7. **ADR-134와 architecture.md.** 문장마다 코드와 맞는가. 한계(검증 화면 목록의 실행 링크는 하한을 그대로 보여 두 화면이 다를 수 있음, 진행 중 실행은 "없음")가 사실대로 적혔는가. ADR 머리줄 순서(지금 131 · 133 · 134. 132는 PR #299에 있다. 그대로가 맞다).
8. **변이.** 구현자의 10종(PR 본문 표)과 겹치지 않게 6종 안팎. 후보: ⓐ `costUnknownCount > 0` 조건을 `turnsUnknownCount`로 바꿔치기(비용 · 턴의 모름이 서로 섞임), ⓑ 세션 없는 실행에서 0 내보내기, ⓒ `length(display_id)` 정렬 빼기(자리수 넘김), ⓓ `rule.list` 항목에도 `latestRun` 싣기, ⓔ 화면에서 0을 "없음"으로 보이기(실제 0을 숨김), ⓕ 규칙을 바꿀 때 순번을 올리지 않기(옛 규칙 응답이 그려짐), ⓖ 다른 프로젝트 알림에도 읽기, ⓗ 재접속 때 다시 읽기 빼기. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr301.XXXX)`): orchestrator `rule` · `rule-edit`, app `rule-detail-view`, store의 실행 저장소 시험. 화면 e2e는 `scr-06-rule.spec.ts`만(`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome)`, `--trace off`, 포트 충돌은 `dev-env` 스킬). 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험("hoist 설정(…) node-gyp bin …" · "닫힘 밖 file: 패키지의 python3 bin …")만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 전체 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- 기본 · "없음" · 실제 0 세 상태의 규칙 상세 화면 사진을 e2e의 가짜 응답으로 찍어 `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r301-shots/`에 두고 눈으로 본 것을 보고에 적는다(시험 파일을 고쳐 찍었으면 되돌린다).
- 숨은 글자: 바뀐 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(파일 명시). `grep -c 'udb40' docs/decisions.md`는 2.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션을 바꿔 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다. 실제 API 키를 쓰지 않는다.
- **시간**: 한국 시간 08:10까지 보고한다. 시간이 모자라면 2 · 5 · 8 · 3 · 4 순서로 하고 못 한 것은 "못 함"으로 적는다. 끝낼 때 네가 띄운 프로세스(개발 서버 등)가 남지 않았는지 확인한다(네 PID만 끝낸다).

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 2개별 충족 여부와 근거(파일:줄, 시험).
- "없음과 0" 표(상태, 응답 값, 화면 표시, 근거 시험).
- 변이 결과 표(변이, 빨강이 된 시험).
- 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, 못 한 것, 화면 사진에서 본 것.
