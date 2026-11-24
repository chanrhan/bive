너는 chanrhan/bive 저장소의 PR #274(이슈 #46, 로드맵 M3-01 "블록 선언 모델")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일한다. 이 PR은 M3의 뿌리 이슈라 뒤 이슈(M3-02 파서의 블록 판정, M3-03 구조 검사, M3-07, M3-19, M3-29)가 이 모양 위에 선다. 모양의 실수는 뒤에서 비싸다.

## 받은 값
- PR #274, 브랜치 `feat/46-block-declaration`, 헤드 `134fffdeec35be1ac6e678d02b3c130708cb82ab`, 기준 main `3169273`. 바뀐 파일 60개(+1842 / -31): 시나리오 20개(도구 호출에 두 칸 추가), shared `blocks.ts` · `domain.ts` · `protocol.ts`, store 마이그레이션 `project/0022_block_declarations` + 저장소, 오케스트레이터 `ipc/block-handlers.ts` · `norms/agent-rule.ts` · `norms/norm-input.ts` · `tools/definitions.ts` · 테스트 작성 입력 · `confirmation-list.ts`, app CLI, 픽스처(`fixtures/blocks/sample-next-app.json`, 새 라우트 `fixtures/sample-next-app/src/app/api/auth/session/route.ts`), ADR-122. 이 헤드에서 CI `ci` · `checks` · `pipeline-e2e` 두 묶음은 모두 success다(조율자가 check-runs로 확인).
- 네 작업 공간에서 `git fetch origin feat/46-block-declaration && git checkout --detach FETCH_HEAD`로 본다. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-46.md`(구현자가 받은 지시서. "블록 선언이 없는 프로젝트"의 기본 방침과 멈춤 조건이 있다), `brief-common.md`, `m3-handoff.md`, `pr274-body.md`(PR 본문 사본).
3. 이슈 본문 수용 기준(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/46`)과 코멘트.
4. 명세에서 블록 · 위험도를 다루는 곳: `docs/spec/prd.md`(`DSN-*` · `NRM-*` · `JDG-*`에서 블록, 공개 인터페이스, 의존 방향, 위험도), `docs/spec/plan.md`의 블록 용어, `docs/spec/screens.md`의 위험도 칩. `docs/decisions.md`의 ADR-122(이 PR이 더함) · ADR-005 · ADR-100(사람 결정) · ADR-110 · ADR-112 · ADR-120 · ADR-121. 뒤 이슈 본문: #47(M3-02) · #48 · #49(M3-03 근처)를 읽어 이 모양으로 구현할 수 있는지 본다.

## 꼭 판정할 것
1. **범위.** `git diff 3169273...HEAD --stat`. 화면(`packages/app/src/renderer`) · `docs/spec/*` · `CLAUDE.md`가 바뀌지 않았는가. 구조 시험 `integrity.test.ts`는 추가만인가(`-` 줄 0). 마이그레이션이 0022 하나인가.
2. **사람 전용 쓰기와 주체 위조(가장 중요).** `blocks.set`은 사람 주체만 받는다(-32020).
   - RPC에서 "사람 주체"가 어떻게 정해지는가(연결 종류, 토큰, 호출자가 보내는 칸?). `confirmation.set`의 사람 전용과 **같은 장치**인가.
   - 이 PR은 CLI `cli blocks set <dir> <json>`을 더했다. 지금까지 CLI는 조회 메서드만 불렀다. CLI가 사람 주체로 `blocks.set`을 부르는 길이 **에이전트 역할이 쓸 수 있는 길인가**를 따진다: 구현 · 테스트 작성 · 규칙 작성 역할에게 셸 실행 도구가 있는가, 있으면 그 셸에서 `pnpm --filter @bive/app cli blocks set …`을 돌릴 수 있는가(작업 디렉터리, `BIVE_HOME`, 소켓 경로 접근, 판정 격리). 판정(인수 테스트 실행) 프로세스나 구현 코드가 실행 중에 오케스트레이터 소켓에 붙어 `blocks.set` · `confirmation.set`을 사람 주체로 부를 수 있는가. 같은 길이 이 PR 전에도 `confirmation.set`에 있었다면 "이 PR이 새로 연 것"과 "원래 있던 것"을 구분해 적는다. 새로 연 길이 있으면 차단이다.
   - 에이전트 도구에 블록 선언 쓰기가 없음을 고정하는 구조 시험이 실제로 무엇을 보는가(도구 정의 목록, 역할별 허용 도구, `.blockDeclarations.` 쓰기 호출의 허용 파일 목록). 새 쓰기 경로를 다른 파일에 더하면 빨강이 되는가.
3. **0022와 저장.** 새 표 `block_declarations`(판 단위 추가 전용).
   - DB가 강제한다는 "저장 주체 사람만 · 다음 판만 · 수정 삭제 금지"를 트리거 · 제약으로 직접 확인하고 돌아갈 길(`INSERT OR REPLACE`, 판 번호 건너뛰기, 같은 판 두 번, 첫 판이 1이 아닌 값)을 시험해 본다. 내용 칸이 JSON 형식 · 스키마에 맞지 않는 값이면 읽을 때 어떻게 되는가(ADR-120의 "깨진 행 하나" 원칙: 조용히 삼키지 않고, 닫힌 쪽).
   - 기존 표를 다시 만들지 않았는가(`runs` · `rules` · `norm_changes` 트리거 목록이 그대로인가. `migrate.test.ts`의 스키마 객체 단언이 0022를 포함하는가). 옛 DB(0021 상태, 데이터 있음)에서 0022만 올리는 시험이 있는가. 두 해시 체인이 그대로 유효한가.
   - "쓰기 장부 대조가 저장소 밖 변경을 잡는다"는 주장을 코드로 확인한다(새 표가 대조 대상에 정말 드는가, 시험이 있는가).
4. **스키마 모양(뒤 이슈가 설 자리).** `packages/shared/src/blocks.ts`.
   - 칸의 뜻 · 허용 값이 명세와 맞는가(`kind` · `risk`의 값 집합이 PRD · 화면 정의서의 낱말과 같은가. 다르면 차단). 명세에 없는 것을 정한 곳이 ADR-122에 적혔는가.
   - 경로 패턴: `**` · `*`만 특수. `matchesBlockPattern` · `blockPatternRegExp`를 직접 시험한다: `src/app/**`가 `src/app` 자체 · `src/application/x`를 잡는가, `*`가 `/`를 넘는가, 정규식 특수 글자(`.` `+` `(` `[` `$` `^` `|` `\`)가 든 경로, 대소문자, 끝의 `/`, 유니코드 · 숨은 글자 · 제어 글자, 아주 긴 패턴과 `**/**/**…`(정규식 폭주), 윈도 경로. 저장 때 거부한다는 표의 각 줄에 시험이 있는가.
   - 상한(블록 30, include 20, public 20, 이름 형식)이 픽스처와 흔한 Next.js 프로젝트에 무리가 없는가. 근거가 ADR에 있는가.
   - M3-02 · M3-03이 필요로 할 정보가 빠지지 않았는가(공개 인터페이스 판정, 의존 방향 위반 판정, 어느 블록에도 속하지 않는 파일). 빠졌다면 "뒤에서 넓히면 되는가, 지금 모양을 바꿔야 하는가"를 구분한다.
5. **규칙의 대상 블록 · 위험도.**
   - `Rule.targetBlockIds`의 원소 뜻을 ULID에서 블록 이름으로 바꿨다. 옛 DB에 ULID가 든 행이 있을 수 있는가(main의 쓰기 경로를 `git log -S targetBlockIds`와 grep으로 확인). 있으면 그 값이 이제 블록 이름으로 읽혀 무엇이 달라지는가. 칸 이름과 뜻이 어긋난 채 두는 것이 ADR에 적혔는가.
   - 필수 검사가 도구 스키마와 반영 모듈 두 겹인가. 한 겹씩 빼는 변이가 각각 빨강인가. 선언이 있을 때 없는 이름 · 중복 이름 · 빈 목록 · 31개 이상이 어떻게 되는가. 거부 시 아무것도 남기지 않는가(규칙 행, 규범 변경 기록, 자동 시작 실행).
   - **선언이 없는 프로젝트**: 받은 이름을 그대로 저장하고 `after.blockDeclarationVersion = null`로 드러낸다는 결정. `NormChangeDetail`을 넓히기만 했는가(옛 행이 지금 스키마로 유효한가, 체인 검증 시험). 선언이 없을 때 받는 이름에도 형식 제한(블록 이름 형식 · 개수)이 걸리는가. 에이전트가 지어낸 글이 이 칸으로 화면 · 뒤 세션 입력에 실리는 새 길이 되는가(ADR-121의 관점: 규칙 작성 역할이 쓴 글이 어디로 흐르는가. 표시 값 처리).
   - 수용 기준 "규칙마다 대상 블록 1개 이상과 위험도 필수"와, 고치지 않은 두 경로(옛 제안 승인 `proposal.*`으로 만드는 규칙, 사람의 `rule.update`, 내장 구조 규칙)의 관계. 그 경로로 두 칸 없는 규칙이 새로 생길 수 있다면 수용 기준 위반인가, ADR-122에 근거와 함께 적힌 범위 밖인가를 이슈 문장으로 판정한다.
6. **세션 입력.** 규범 자료 끝의 블록 절과 테스트 작성 세션의 `blocks.json` 사본.
   - 블록 절의 글은 사람이 저장한 선언에서만 오는가. `displayText` · 상한 처리가 다른 규범 자료와 같은가. 선언이 없을 때 절이 어떻게 보이는가(없음을 알리는가, 절이 빠지는가. 규칙 작성 역할이 이름을 어떻게 고르라고 안내받는가).
   - 사본 쓰기를 경로 가드가 거부하는 것이 시험으로 고정됐는가(구현자: 가드가 두 겹이라 한 겹만 빼면 초록). 사본이 워크트리 · 커밋 · 병합에 섞여 들어가지 않는가. 구현 역할에 사본을 두지 않은 이유가 사실인가.
   - 세션 도중 선언이 바뀌는 경우의 동작이 ADR에 적힌 대로인가.
7. **`confirmation.list`의 `risk`.** 선택 칸이고 shared 스키마의 refine(`totalByKind` 합 = `total`)과 화면 시험의 가짜 응답이 깨지지 않는가. 화면이 이 값을 아직 쓰지 않는가(칩 비활성 그대로).
8. **CLI와 예제.** `cli blocks set`의 인자 처리(없는 파일, 깨진 JSON, 스키마 위반 시 종료 코드와 메시지, 등록되지 않은 프로젝트 폴더), 출력에 코드 표기가 과하지 않은가. 예제 `fixtures/blocks/sample-next-app.json`의 패턴이 실제 픽스처 파일을 가리킴을 시험이 확인하는가. 픽스처에 새 라우트(`api/auth/session`, 늘 401)를 더한 것이 파서 결과 · 화면 e2e · 파이프라인 e2e 기준값 · README의 픽스처 설명을 바꾸는가(바뀐 단언이 `test-writer.test.ts` 한 줄뿐인지 확인. 픽스처는 독립 프로젝트라 그 잠금 파일 · 타입 검사도 본다).
9. **시나리오 20개.** 변경이 `propose_rule` · `supersede_rule` 호출에 두 칸을 더한 것뿐인가(`git diff 3169273...HEAD -- '*scenarios*'`에서 다른 줄이 바뀌지 않았는가). 파이프라인 e2e의 기록 순서 · 실행 수 기준값 파일이 바뀌지 않았는가.
10. **문서.** ADR-122의 문장마다 코드 위치가 맞는가. 결정(파일이 아니라 DB 표, 판 단위, 선언 없는 프로젝트의 방침, 저장 때 보지 않는 것 세 가지, 옛 행 처리)과 다시 정하는 조건이 적혔는가. `docs/architecture.md` 변경이 사실인가(RPC 목록, 표 목록).
11. **변이.** 구현자의 변이(PR 본문 표)와 겹치지 않게 7종 안팎. 후보: ⓐ `block_declarations`의 다음 판 검사 빼기(판 건너뛰기 허용), ⓑ 수정 금지 트리거 빼기, ⓒ `blockPatternRegExp`에서 `*`가 `/`를 넘게, ⓓ 정규식 특수 글자 이스케이프 빼기, ⓔ 선언이 없을 때 `blockDeclarationVersion`을 빼고 저장, ⓕ 거부 뒤에도 규범 변경 기록을 남기게(순서 바꾸기), ⓖ 블록 절을 `displayText` 없이 싣기, ⓗ `confirmation.list`의 `risk`를 늘 `null`로, ⓘ CLI가 스키마 위반에도 종료 코드 0. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 바뀐 시험 파일만: orchestrator의 `blocks` · `integrity` · `test-writer` · `rule-writer` · `norm-supersede` · `confirmation` · `fixed-tools`, store의 `migrate`, shared의 블록 · 도메인 시험, app의 `cli-blocks`. `TMPDIR=$(mktemp -d /tmp/tr274.XXXX)`.
- 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험('의존성 설치 시간 초과')만 실패하면 통과로 본다. 전체 `pnpm e2e:pipeline` · 화면 e2e · 스모크는 돌리지 않는다(CI가 이 헤드에서 success다).
- 숨은 글자: 바뀐 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(파일을 명시. 시나리오 20개 포함). `grep -c 'udb40' docs/decisions.md`는 2여야 한다.
- 권한 시스템이나 격리 검사가 복합 명령을 "확인하기에 너무 복잡하다"로 거부하면, 검사기가 볼 수 있는 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 스크립트 파일로 감싸기, 다른 도구로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다. 그 확인은 "못 함"으로 보고한다. 프록시 환경 변수 값을 출력하지 않는다. 판정 격리를 돌아가는 대처를 하지 않는다. 주체 위조 길(2번)은 **코드로 따져서** 판정하고, 실제 앱에서 격리를 깨 보는 시도는 하지 않는다.
- 다른 구현자가 같은 VM에서 PR #273을 고치는 중이다(화면 e2e 포트를 쓴다). 그 작업 공간 · 프로세스 · 포트를 건드리지 않는다. 끝나면 네가 띄운 프로세스와 임시 폴더를 정리한다(네 PID만).

## 판정 기준
- 차단: 수용 기준 미충족, 에이전트 · 판정 프로세스가 사람 주체로 쓸 수 있는 새 길, 돌아갈 수 있는 DB 제약, 명세와 다른 값 집합, 패턴 판정의 오류(잘못 잡거나 폭주), 거부 뒤 남는 기록, 옛 행이 깨지는 스키마 변경, 느슨해진 구조 시험 · 기존 시험, 변이 생존, 사실과 다른 ADR 문장, 뒤 이슈가 지금 모양으로 구현될 수 없는 결함.
- 비차단: 취향, 범위 밖 개선. 후속 후보로 따로 적는다(어느 열린 이슈에 붙일지 제안: #47 ~ #54, M3-19 등).

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(B1…, 파일 · 줄 · 재현 · 고칠 방향), 비차단(N1…), 위 11개 항목별 한 줄 결론, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. 한국어로, 짧게.
