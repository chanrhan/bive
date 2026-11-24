# 구현 서브에이전트 공통 지침

브리핑에서 받은 값: 이슈 번호 `<N>`, 브랜치 `<B>`, ADR 번호 `<A>`, 커밋 type(scope) `<T>`, 화면 변경 여부.

## 시작
1. 네 작업 공간(격리된 git worktree)에서 `git fetch origin main && git checkout -b <B> origin/main`. `git merge-base --is-ancestor 97b4d86 HEAD`가 성공하는지 확인한다(성공해야 단위 테스트를 돌릴 수 있다. 이유는 `dev-env` 스킬).
2. `CLAUDE.md`(전체)와 `.claude/skills/dev-env/SKILL.md`를 읽는다. 이슈 본문은 `scripts/gh-rest.sh GET repos/chanrhan/bive/issues/<N>`으로 다시 확인한다.
3. `pnpm install --frozen-lockfile`.

## 규칙 (CLAUDE.md 4장 요약 + 조율 규칙)
- 사람에게 묻지 않는다. 문서 우선순위(PRD > 화면 정의서 > 기획서)로 풀고, 문서에 없으면 가장 보수적인 해석을 고르고 `docs/decisions.md` 끝에 ADR(맥락 · 결정 · 결과, 상태 `제안 (에이전트)`)을 더한다. 번호는 브리핑이 준 `<A>`만 쓴다(병렬 작업과 겹치지 않게). 필요 없으면 쓰지 않는다.
- 범위 밖 변경 금지(리팩터링 · 포맷 변경 포함). 테스트를 끄거나 `skip` · `only`를 남기지 않는다. 시험을 약하게 해 통과시키지 않는다.
- 화면 데이터는 실행 · 판정 결과에서만 만든다(NFR-03). 목 데이터 · 추정 공식 · 하드코딩 값은 테스트 코드 안에서만.
- 머지된 마이그레이션은 고치지 않는다. 필요하면 새 번호로 더한다.
- 언어: 문서 · 주석 · 커밋 · PR · UI 문구는 한국어, 식별자 · 파일명은 영어. UI 문구는 `docs/spec/screens.md` 1.1(명사형, 이모지 금지, 화면에 PRD · SCR · ADR 코드 표기 금지). 코드 · 주석 · PR 제목 · 본문에 모델 이름을 쓰지 않는다.
- 임시 파일 격리: 테스트는 `TMPDIR=$(mktemp -d /tmp/t<N>.XXXX)`를 준다. 공용 scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`에 두는 파일은 `a<N>-` 접두. `BIVE_HOME`은 짧은 경로(`mktemp -d /tmp/bh.XXXX`).
- 전역 pnpm 저장소나 하드 링크된 `node_modules` 안의 파일을 고치지 않는다.
- **권한 · 격리 검사가 명령을 거부했을 때**: 묶음 명령이 "복잡해서 확인 불가"로 거부되면 검사기가 볼 수 있는 단순한 명령 하나씩으로 다시 내는 것은 된다. 스크립트 파일로 감싸 실행하기, 다른 도구로 같은 일을 대신하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다. 그런 경우는 그 확인을 "못 함"으로 두고 보고에 적는다. 프록시 환경 변수 값을 출력하지 않는다.
- **방어 코드마다 시험**: 검토에서 가장 자주 걸린 것은 "방어는 있는데 시험이 없다"다. 새로 넣은 조건 · 거부 · 복구 · 표시마다 그것을 빼면 빨강이 되는 시험을 두고, 실제로 빼서 빨강인지 확인한 결과를 PR 본문 표에 적는다. 시험은 "보이는지"만이 아니라 내용 · 순서 · 자리를 단언한다. 시험용 가짜 응답은 shared 스키마를 지나는 것만 쓴다.
- 에이전트가 쓴 글이나 서버가 준 글을 화면에 그릴 때는 `visibleText` · `visibleLines` · `visibleDisplayText`를 거친다. 새 enum 값은 shared와 app의 표시명 표에 함께 더한다. 서버가 기록에 쓰는 고정 사유 글에 문서 기호(ADR · PRD · SCR 번호)를 넣지 않는다.
- ADR · `docs/architecture.md`에 적는 사실 문장은 코드 위치를 확인한 것만 적는다. 발행 스크립트(`scripts/publish-roadmap.py`)는 돌리지 않는다(조율자가 한다).
- 제품 코드의 결함을 만나면: 작고 이 이슈에 필수면 고치고 시험을 더하고 PR 본문에 적는다. 크면 고치지 말고 보고에 적는다(조율자가 이슈로 만든다).
- 다른 서브에이전트가 병렬로 다른 이슈를 구현한다. 공용 파일(라우터, IPC 스키마 색인, preload, `docs/decisions.md`)은 필요한 줄만 최소로 더한다.

## 완료 조건
1. `pnpm lint` · `pnpm typecheck` · `TMPDIR=… pnpm test` · `pnpm build` · `pnpm format:check` 종료 코드 0. 화면을 고쳤으면 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome) pnpm e2e`와 `xvfb-run -a pnpm smoke`도 0(포트 충돌이면 `BIVE_E2E_PORT` 지정).
2. 커밋: `<T>: 요약 (#<N>)`. 작성자는 git 기본 설정 그대로 둔다(`-c user.name` · `-c user.email`로 바꾸지 않는다. 바꾸면 서명되지 않는다). 메시지 끝에 아래 두 줄을 그대로 넣는다.
   Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01RMMsfjyreRirrN2USds5x4
3. `git push -u origin <B>`(503 등 실패 시 간격을 늘려 4번까지 재시도, `git ls-remote`로 반영 확인).
4. PR 생성: `scripts/gh-rest.sh POST repos/chanrhan/bive/pulls --input <json 파일>`(title = 이슈 제목 그대로, head = `<B>`, base = main). 본문은 `.github/pull_request_template.md`의 절을 채우고 첫 줄 `Closes #<N>`. 본문 끝에 아래 두 줄.
   🤖 Generated with [Claude Code](https://claude.com/claude-code)

   https://claude.ai/code/session_01RMMsfjyreRirrN2USds5x4
5. CI(`ci`) 확인: `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<sha>/check-runs`. 대기는 15분까지. PR `mergeable_state`가 `dirty`면 CI가 생기지 않으니 `git fetch origin main && git merge origin/main`으로 풀고 다시 푸시한다. CI가 빨강이면 원인을 고친 실제 커밋을 푸시한다. **금지: 강제 푸시, 리베이스, 빈 커밋, PR 닫았다 열기.** 그래도 안 되면 멈추고 보고한다.

## 이 VM의 환경 (CLAUDE.md 5장 · dev-env 스킬과 같다)
- `pnpm test`: 이 VM에서는 `packages/orchestrator/test/judge-runner.test.ts`의 실제 설치 시험 두 개(hoist node-gyp bin, python3 bin)가 "의존성 설치 시간 초과"로 실패한다(프록시 환경, CI는 통과). 그 둘이 그 이유로만 실패하면 로컬은 통과로 보고 보고에 실패한 시험 이름을 적는다. 다른 실패는 네 변경 탓인지 확인하고, 부하로 시간 초과된 것으로 보이면 그 파일만 다시 돌려 판단한다(ADR-064). 판정 자식에 프록시를 넘기거나 시험을 끄는 식의 대처는 하지 않는다.
- Electron 스모크가 바이너리 문제로 실패하면 `dev-env` 스킬의 재설치 절차(`node install.js`)를 따른다.
- 완료 판단은 CI의 `ci` 검사다(`checks` · `pipeline-e2e`를 모은다).
- 새 이슈 · 로드맵 행은 만들지 않는다(조율자가 한다). 로드맵을 고쳐야 하는 이슈가 아니면 `docs/roadmap.md`를 건드리지 않는다.
- 새 시험은 "수정을 되돌리면 빨강이 되는지" 직접 확인하고 PR 본문에 그 결과를 적는다(검토자가 다시 확인한다).

## 보고 (최종 메시지)
PR 번호, 최종 커밋 SHA, 수용 기준별 충족 근거(시험 이름), 실행한 명령과 종료 코드, CI 결과, 추가한 ADR, 발견했지만 고치지 않은 결함, 남긴 것.
