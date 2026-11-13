# CLAUDE.md — BIVE 개발 규칙

이 저장소는 BIVE(Baseline-Integrated Verification Environment)를 `docs/spec/`의 기획서 · PRD · 화면 정의서대로 만든다. 사람이 상시 지켜보지 않으므로 아래 규칙이 곧 운영 방식이다. 운영 프롬프트와 이 문서가 충돌하면 이 문서가 우선한다.

## 1. 문서 우선순위와 ID

- 원본: `docs/spec/prd.md`(요구사항) · `docs/spec/screens.md`(화면) · `docs/spec/plan.md`(용어 · 동작). 내용이 다르면 **PRD > 화면 정의서 > 기획서** 순으로 따른다 (PRD v0.9가 가장 최신, ADR-002).
- 요구사항은 PRD ID(`PRJ-01` `NRM-02` `RUN-08` `JDG-01` `DSN-07` `TODO-01` `COST-01` `MET-01` `COL-01` `NFR-01`)로, 화면은 `SCR-01`~`SCR-21`로 부른다. 매핑은 `docs/spec/screens.md` 1.3.
- 결정은 `docs/decisions.md`에 ADR로만 남긴다. 원본 `docs/spec/*`는 사람만 고친다.
- 로드맵은 `docs/roadmap.md`, 형식은 `docs/roadmap-format.md`. 이슈 키(`M1-03`)와 GitHub 이슈 번호를 함께 쓴다.

## 2. 막혔을 때 (사람에게 묻지 않는다)

1. 문서 우선순위로 풀리면 그대로 따른다.
2. 문서에 없으면 **가장 보수적인 해석**(범위가 작고, 되돌리기 쉽고, 무결성 NFR-01 · NFR-02를 더 지키는 쪽)을 고르고 `docs/decisions.md`에 ADR(맥락 · 결정 · 결과, 상태 `제안 (에이전트)`)을 추가한다.
3. 사람만 할 수 있는 일(권한, 외부 계정, 실기기 확인, 제품 방향)은 `needs-human` 라벨 이슈를 만들고, 그것에 의존하지 않는 작업을 계속한다.
4. 같은 오류를 세 번 다르게 시도해도 못 풀면 needs-human 이슈로 남기고 다음 일로 넘어간다.
5. 테스트를 끄거나 건너뛰어 통과시키지 않는다. 임시 우회는 ADR 없이는 금지.

## 3. 저장소 구조

pnpm 워크스페이스 · TypeScript strict · ESM. 패키지 5개(`packages/shared` · `store` · `orchestrator` · `parser` · `app`)와 테스트용 픽스처 `fixtures/sample-next-app`(루트 워크스페이스 밖의 독립 프로젝트). 패키지 역할과 의존 방향은 `docs/architecture.md` 2장, 폴더 트리는 README 4장.

## 4. 작업 방식

- 이슈 1개 = 브랜치 1개 = PR 1개. 브랜치 `feat/<이슈번호>-<slug>` · `fix/` · `chore/` · `docs/`. PR 본문 첫 줄 `Closes #<번호>`, 머지는 squash.
- 커밋: `type(scope): 요약 (#이슈)`. type = feat · fix · chore · docs · test · refactor. 코드 · 주석 · PR 제목 · 본문에 모델 이름을 쓰지 않는다. 커밋 메시지 끝의 공동 작성자(`Co-Authored-By`) · 세션 링크 트레일러는 세션이 지정한 값을 그대로 쓴다.
- 언어: 문서 · 이슈 · PR · UI 문구 · 주석은 한국어, 식별자 · 파일명은 영어. UI 문구는 `docs/spec/screens.md` 1.1 원칙(명사형, 이모지 금지, 코드 표기 금지)을 따른다.
- 라벨: `type:feature` `type:bug` `type:chore` `type:docs` · `area:app` `area:orchestrator` `area:store` `area:parser` `area:shared` `area:ci` `area:docs` · `needs-human`.
- 모든 PR은 CI(`ci`) 통과 + `pr-reviewer` 스킬 검토 후 머지. 리뷰 지적은 최대 2회 수정 반복, 그래도 안 되면 이슈를 쪼갠다.
- 화면 데이터는 파서 · 실행 결과에서만 만든다(NFR-03). 목 데이터는 테스트 코드 안에서만 허용하고 제품 코드 경로에 두지 않는다.
- 마일스톤 조율(서브에이전트 모델 · 동시 실행 수 · 진행 기록 · 일시 정지)은 `run-milestone` 스킬을 따른다.

<!-- KICKOFF -->
## 5. 완료 조건 명령 (이 VM에서 실제로 실행해 확인한 것만 적는다)

구현 PR은 아래를 모두 통과해야 한다(화면을 고치지 않았으면 e2e · 스모크 제외). 단위 테스트를 뺀 7개는 2026-11-13 `main`(`224e914`)에서 순서대로 실행해 종료 코드 0을 확인했다. 단위 테스트는 같은 날 이 VM에서 다시 돌리지 못했고(이유는 `dev-env` 스킬), 같은 커밋의 CI(`ci`) 성공으로 확인했다. 실측 시간 · 테스트 개수는 금방 낡으므로 적지 않는다.

| 작업 | 명령 |
|---|---|
| 설치 | `pnpm install --frozen-lockfile` |
| 린트 | `pnpm lint` |
| 타입 검사 | `pnpm typecheck` |
| 단위 테스트 | `pnpm test` (작업 트리가 커밋 `97b4d86`을 포함할 때만. 이유는 `dev-env` 스킬) |
| 빌드 | `pnpm build` |
| 형식 검사 | `pnpm format:check` (`*.md` · `docs/` · `scripts/` · `fixtures/`는 대상 아님) |
| 화면 e2e (헤드리스) | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm e2e` |
| Electron 스모크 | `xvfb-run -a pnpm smoke` |

- GitHub 호출은 `scripts/gh-rest.sh <METHOD> <경로>`(= `gh api`)로 한다. `git push`는 그대로 동작한다.
- 이 VM에는 `ANTHROPIC_API_KEY`가 없어 실제 에이전트 SDK를 부를 수 없다. 테스트는 가짜 에이전트 어댑터로 한다 (ADR-016).
- 앱 · 오케스트레이터 기동, 픽스처, 환경 변수, VM 제약, 자주 겪는 오류(브라우저 경로 · Electron 샌드박스 · 소켓 경로 길이 · 포트 충돌 · 커밋 서명)는 `dev-env` 스킬에 있다.
<!-- /KICKOFF -->
