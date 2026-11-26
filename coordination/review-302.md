너는 chanrhan/bive 저장소의 PR #302(이슈 #283, 로드맵 M3-42 "규칙 · 요구사항 상세의 다시 읽기 다듬기")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경 한 줄
앞선 이슈들(M3-19 블록 선언, M3-35 규칙 상세 다듬기, M3-16 최신 실행 줄)의 검토에서 넘긴 네 가지를 닫는다: ① 규칙 상세의 실행 이력이 상한 없는 `run.list` 대신 규칙 기준 조회를 1회 부름 ② 요구사항 화면에서 규범 변경 알림 하나에 `rule.list` 한 번 ③ 블록 선언이 바뀌면 열린 상세가 다시 읽음 ④ 실행 이력 줄의 상태 칸 한 줄. ADR-135, 마이그레이션 없음.

## 받은 값
- PR #302, 브랜치 `fix/283-detail-refresh-polish`, 헤드 `601d5cceb5d8fe97b46c9b74bd5396e24aae563e`(main `512bfe1` 병합 포함), 기준 main `512bfe1`. 바뀐 파일 24개(+1208 / -73: 코드 13 · 시험 9 · 문서 2). 조율자가 `ci` 성공(검사 5개 success)과 `clean`을 확인했다. 네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/601d5cceb5d8fe97b46c9b74bd5396e24aae563e/check-runs`로 한 번 더 확인해 보고에 적는다.
- 네 작업 공간에서 `git fetch origin fix/283-detail-refresh-polish` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.
- 구현자는 바뀐 파일이 24개라 "20개 넘으면 멈춤" 기준에 걸려 보고했고, 조율자가 한 PR로 받기로 했다. 범위가 이슈 밖으로 넓어진 것인지(쪼개야 하는지)는 네가 판정한다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-283.md`(구현자가 받은 지시서), `brief-common.md`, `m3-handoff.md`의 "M3-19" · "M3-35" · "M3-16" · "M3-23" 절, `pr-283-body.md`(PR 본문 사본, 변이 표 포함).
3. 이슈 본문 수용 기준 4개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/283`).
4. `docs/decisions.md`의 ADR-135(이 PR이 더함) · ADR-122 · ADR-123 · ADR-126 · ADR-134 · ADR-073 · ADR-094 · ADR-120. `docs/spec/screens.md`의 1.1 · 1.4 · SCR-02 · SCR-03 · SCR-06, `docs/spec/prd.md`의 NRM-09.

## 구현자가 정한 것 (네가 타당성을 판정한다)
- ① `run.list`에 선택 인자 `ruleId`. 돌려주는 실행 = 그 규칙이 대상인 실행 ∪ 그 규칙의 판정 기록이 있는 실행. 없는 규칙 · 다른 프로젝트의 규칙은 -32004. 표시 ID 순, 깨진 행은 건너뜀.
- ② 알림 · 재접속에는 화면의 폐기 포함 조회(`rule.list {projectId, includeRetired: true}`) 한 번만 나가고, 열린 요구사항 상세의 자식 규칙은 그 결과에서 `retirement` 칸이 없는 항목을 골라 쓴다. 상세를 열 때와 편집 뒤의 읽기는 그대로.
- ③ 새 알림 `event.blocks.changed {projectId, version}`: `blocks.set`이 저장(커밋)된 뒤 보낸다(`orchestrator/src/events/block-events.ts` · `ipc/block-handlers.ts` · `orchestrator.ts`, shared `protocol.ts`). 앱은 이 알림과 재접속 때 `blocks.get`을 다시 읽는다.
- ④ 접히지 않는 폭에서 실행 이력 줄을 flex-wrap으로 바꾸고 상태 칸은 `nowrap`. 남는 폭에 안 들어가면 **칸째 다음 줄로** 넘어간다.
- 기존 시험 단언 하나를 고쳤다: `e2e/todo-badge.spec.ts`의 `children + 2` → `+1`("이번에 고친 결함을 그대로 고정하던 단언"이라는 주장).
- 로컬 `pnpm e2e:pipeline`은 끝내지 못했다(35분 출력 없음, 구현자가 자기 프로세스 중단). CI의 `pipeline-e2e`는 성공이다.

## 꼭 판정할 것
1. **범위.** `git diff 512bfe1...HEAD --stat`. `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · `.github/workflows` · 마이그레이션이 바뀌지 않았는가. 24개 파일이 네 수용 기준 안인가. `refreshCoalescer.ts`(+6)와 그 시험의 변경이 무엇이고 다른 화면(실행 목록 · 계약 화면 등 공용 합치기를 쓰는 곳)의 동작을 바꾸지 않는가. 인자 없는 `run.list` · `rule.list` · `judgment.list` · `rule.get`의 결과가 글자까지 같은가(기존 시험의 `-` 줄을 전부 본다: 고친 단언은 `todo-badge.spec.ts` 하나뿐인가).
2. **① 규칙 기준 조회.** `run-repository.ts`의 새 질의와 `ipc/run-handlers.ts`를 읽는다.
   - "대상 ∪ 판정 기록"이 실행 이력 줄에 필요한 실행을 빠짐없이 덮는가: 규칙 상세의 실행 이력(`judgment.list`의 줄 → 실행 단위 줄, ADR-123)이 참조하는 모든 실행이 결과에 있는가. 판정 50건 상한 밖의 실행 · 판정 기록의 실행이 지워진 경우 · 격리된 판정은.
   - 질의 계획: 네가 메모리 DB에 마이그레이션을 적용해 `EXPLAIN QUERY PLAN`을 직접 본다(`SCAN runs`가 없어야 한다). `UNION` · `IN` 하위 질의의 중복 제거와 정렬(자리수 넘김 EXE-999 · EXE-1000).
   - 오류 방식: 없는 규칙 -32004가 기존 `judgment.list` · `rule.get`과 같은 방식인가. `ruleId`에 제안 ID · 다른 프로젝트의 규칙 ID · 형식이 틀린 값을 주면. 폐기된 규칙 · 내장 규칙.
   - 인자 조합: `ruleId`와 기존 인자(`status` 등)가 함께 오면 어떻게 되는가(스키마가 막는가, 둘 다 적용되는가. 시험이 있는가).
   - 앱: 규칙 상세가 열릴 때 · 실행 알림 뒤 그 조회가 `{projectId, ruleId}`로 나가고 인자 없는 `run.list`가 **규칙 상세 때문에는** 나가지 않는가. "개발 모드는 2회"라는 구현자 설명(StrictMode 이중 마운트)이 수용 기준의 "1회 부름"과 맞는 단언인가(시험이 횟수를 어떻게 고정했는지: 판정 이력 읽기와 같은 수라는 상대 비교가 결함을 숨기지 않는가).
   - 최신 실행 줄(`rule.get`)과 실행 이력이 어긋나 보이는 경우에 대한 ADR 한계 문장이 사실인가.
3. **② `rule.list` 한 번.** `useChildRules.ts` · `RequirementsScreen.tsx` · `RequirementDetail.tsx`를 읽는다.
   - 폐기 포함 조회에서 `retirement` 없는 항목을 고른 값이 기본 조회(`{projectId}`)의 결과와 **정확히 같은가**: 오케스트레이터의 `rule.list` 처리기에서 `includeRetired`가 바꾸는 것이 "폐기된 규칙 포함 + `retirement` 칸"뿐인지 확인한다(정렬 · 다른 칸 · 효력 계산이 달라지지 않는가). 요구사항 기준 거르기(`requirementId`)는 어디서 하는가.
   - 상세를 여는 순간과 알림이 겹칠 때(상세의 자체 읽기 응답이 알림 뒤 화면 결과보다 늦게 오면) 옛 값이 새 값을 덮지 않는가. 구현자가 뺀 `replaced` 카운터 증가가 정말 중복 방어였는가(빼도 초록이라 지웠다고 함: 그 방어가 막던 상황을 네가 구성해 본다).
   - `todo-badge.spec.ts`에서 고친 단언: 고치기 전 `+2`가 무엇을 세고 있었는지 읽고, `+1`이 맞는 새 값인지(다른 조회가 숨어서 줄어든 것은 아닌지) 판정한다.
   - 가짜 브리지(`bive-mock`)가 `includeRetired`를 무시하고 같은 응답을 준다는 점 때문에 시험이 "폐기 거르기"를 실제로 지키는지(가짜 응답에 폐기된 항목을 넣은 시험이 있는지) 본다.
4. **③ 블록 선언 알림.** 
   - 선언을 쓰는 경로가 정말 `blocks.set` 하나뿐인가(`store`의 선언 저장 함수를 부르는 곳을 grep으로 전부 찾는다: 파서 재실행 · 실행 병합 · 프로젝트 등록 · CLI · 마이그레이션). 구조 시험이 그것을 고정한다는 주장 확인.
   - 알림이 **커밋 뒤에** 나가는가(트랜잭션 안에서 내보내 실패한 저장이 알려지는 일이 없는가). 거부된 저장(판 충돌 등) · 내용이 같은 저장에는. 알림의 `version`이 저장된 판과 같은가. 알림 본문에 선언 내용(에이전트 · 사람이 쓴 글)이 실리지 않는가(실리면 표시 값 변환 · 크기 문제).
   - shared 프로토콜: 알림 이름 · 스키마가 기존 알림과 같은 방식인가(엄격 객체, 이름 목록 · preload/main 다리의 허용 목록에 더해졌는가: 다리에서 막혀 화면에 안 오는 일이 없는가. Electron 스모크 · e2e가 그 다리를 지나는가). 옛 클라이언트가 모르는 알림을 받으면.
   - 앱: `useBlockDeclaration.ts`의 다시 읽기. 다른 프로젝트 알림 거르기, 늦은 응답(요청 순번), 재접속. 펼친 자식 규칙이 받은 선언을 쓰는가. 규칙 목록의 블록 칩 · 필터 등 선언을 쓰는 **다른 자리**가 옛 선언으로 남아 화면 안에서 서로 어긋나지 않는가(수용 기준은 상세 둘이지만 같은 화면의 다른 자리가 어긋나면 비차단 이상으로 적는다).
   - ADR-135가 계기 · 남는 경로(저장소 밖 DB 편집)를 사실대로 적었는가.
5. **④ 한 줄.** `RuleDetail.css`(+30)를 읽는다. 수용 기준은 "상세가 접히지 않는 창 폭에서 실행 이력 줄의 상태 칸이 한 줄"이다. 상태 칸이 **칸째 다음 줄로 넘어가는** 것은 "상태 칸이 한 줄"(칸 안에서 줄 바꿈 없음)을 채우지만, 줄 전체는 두 줄이 될 수 있다: 이것이 수용 기준과 화면 정의서(1.4의 목록 줄)에 맞는 해석인지 판정한다(이슈가 나온 원래 지적: M3-35 검토의 "상태 칸이 두 줄로 꺾임"). 시험이 글자 폭에 기대지 않는가(상대 비교). 1480 · 1920 · 2560px와 접힌 폭(820px)의 화면 사진을 네가 찍어 눈으로 본다. 접힘 기준(400px)과 "이 VM에서는 1440px도 접힌 상태"라는 설명이 사실인지.
6. **시험.** 새 시험이 단언을 구현에서 베끼지 않고 뜻을 고정하는가. `waitForTimeout` · 픽셀 숫자 단언 · 숨은 글자가 없는가. 목 데이터가 제품 코드 경로에 없는가. `events.test.ts`가 오케스트레이터를 실제로 띄우는 시험의 시간(CI `checks` 잡 제한 20분, 지금 약 14분 30초: 이 PR의 `checks` 소요 시간을 check-runs의 시작 · 끝 시각으로 계산해 적는다).
7. **ADR-135와 architecture.md.** 문장마다 코드와 맞는가. 닫았다고 적은 앞 ADR의 문장(ADR-123 · ADR-126 · ADR-122)이 실제로 닫혔는가. 앞 ADR 본문을 고치지 않았는가. ADR 머리줄 순서 131~135, `grep -c 'udb40' docs/decisions.md`는 2. `docs/architecture.md` 충돌 해결(main 쪽 문장을 살렸다는 주장)이 맞는가: `git diff 512bfe1 HEAD -- docs/architecture.md`.
8. **변이.** 구현자의 12종(PR 본문 표)과 겹치지 않게 8종 안팎. 후보: ⓐ 조회에서 `UNION`의 대상 쪽 빼기(판정만 남김), ⓑ 없는 규칙에 빈 목록 돌려주기(-32004 빼기), ⓒ 정렬에서 `length` 빼기, ⓓ 알림을 커밋 전에 보내기 / 거부된 저장에도 보내기, ⓔ 알림의 `projectId`를 다른 값으로, ⓕ 앱이 알림을 받아도 `version`이 같으면 안 읽게(또는 반대로 늘 옛 응답 쓰기), ⓖ 폐기 포함 결과에서 `retirement` 있는 항목을 거르지 않기, ⓗ 상태 칸의 `flex-shrink: 0` 빼기, ⓘ 접힌 폭의 배치를 접히지 않는 폭 규칙으로 덮기, ⓙ 재접속 때 `blocks.get` 다시 읽기 빼기. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다(제품에서 생기지 않는 상태면 근거와 함께 비차단).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr302.XXXX)`): orchestrator `run` · `events` · `blocks` · `integrity`, shared `protocol`, store의 실행 저장소 시험, app `refresh-coalescer`. 화면 e2e는 `scr-06-rule.spec.ts` · `scr-06-requirement.spec.ts` · `todo-badge.spec.ts`(`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome)`, `--trace off`, 포트 충돌은 `dev-env` 스킬). 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험("hoist 설정(…) node-gyp bin …" · "닫힘 밖 file: 패키지의 python3 bin …")만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 구현자가 본 `code-open.test.ts` "상한(500건)" 실패가 다시 나면 그 파일만 다시 돌려 부하 탓인지 가린다. 전체 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- 화면 사진은 `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r302-shots/`에 두고 눈으로 본 것을 보고에 적는다(시험 파일을 고쳐 찍었으면 되돌린다).
- 숨은 글자: 바뀐 파일 24개를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(파일 명시).
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션을 바꿔 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다. 실제 API 키를 쓰지 않는다.
- 끝낼 때 네가 띄운 프로세스(개발 서버 등)가 남지 않았는지 확인한다(PID · cmdline · cwd를 확인한 네 PID만 끝낸다).

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 4개별 충족 여부와 근거(파일:줄, 시험).
- 변이 결과 표(변이, 빨강이 된 시험).
- 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, `checks` 잡 소요 시간, 못 한 것, 화면 사진에서 본 것.
