너는 chanrhan/bive 저장소의 PR #324(이슈 #323, 로드맵 M3-59 "M3-56 쪼개기: 이어받는 실행의 중간 시작을 새 행으로")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 문서 PR이다(`docs/roadmap.md` · `docs/decisions.md`만). 빠르고 정확하게 본다. 한국어로 일하고 보고도 한국어로 쓴다.

## 받은 값
- PR #324, 브랜치 `docs/323-split-m3-56`, 헤드 `99648ad60f3addb223158259bced8f8888a46245`, 기준 main `22c66c7`. `ci`는 조율자가 따로 확인한다. 끝낼 때 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/99648ad60f3addb223158259bced8f8888a46245/check-runs`의 상태를 한 번 보고 적는다(기다리지 않는다).
- 네 작업 공간에서 `git fetch origin docs/323-split-m3-56` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다. `scripts/publish-roadmap.py`는 **`--dry-run`으로만** 돌린다(`--dry-run` 없이 돌리면 실제로 발행된다).

## 배경
이슈 #319(M3-56 "예산 초과 액션: 이어받는 실행 · 한도 상향 재개", ADR-147의 결정을 구현)의 구현이 저장 · 실행 만들기 · 한도 검증과 누적까지로 21개 파일(+2063)이 되어 멈췄다(브랜치 `feat/319-run-continuation`, 커밋 `1e4bc3b`, ADR-149, 0030. PR은 #322(0029)가 병합된 뒤 올라간다). 남은 "중간 시작"(원 실행의 마지막 완료 단계 다음부터 돎 · 이어받은 단계의 `skipped` 기록 · 판정 근거를 원 실행에서 읽기 · 회귀 상한의 사슬 누적)을 새 행 M3-60으로 옮기는 것이 이 PR이다(ADR-150). M3-56만 병합된 기간에는 이어받는 실행이 기준 커밋에서 첫 단계부터 돈다.

## 먼저 읽을 것
`.claude/skills/pr-reviewer/SKILL.md`(로드맵 문서 검토 절), `CLAUDE.md`, `docs/roadmap-format.md`, scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-323.md`(문서 에이전트가 받은 지시서: 조율자 결정이 적혀 있다) · `brief-319.md`(구현 지시서) · `pr324-body.md`(PR 본문 사본), 이슈 #323 · #319 본문, `docs/decisions.md`의 ADR-150(이 PR이 더함) · **ADR-147 전부** · ADR-145 · ADR-143 · ADR-141, 선례 PR `git show 7ab8aea -- docs/roadmap.md docs/decisions.md`. 열린 브랜치: `git fetch origin feat/319-run-continuation` 뒤 `git show origin/feat/319-run-continuation:docs/decisions.md`의 ADR-149와 그 브랜치의 코드(`packages/orchestrator/src/engine/pipeline-engine.ts` · `runs/run-continuation.ts` · `review/review-queue.ts` · `steps/` · store 0030).

## 판정할 것
1. **범위.** `git diff 22c66c7...HEAD --stat`: 두 파일뿐인가. `docs/spec/*` · `CLAUDE.md` · 제품 코드가 바뀌지 않았는가. 로드맵에서 지시 밖의 행 · 마일스톤을 고치지 않았는가(`-` 줄 전부). 앞 ADR(특히 ADR-147) 본문을 고치지 않았는가.
2. **M3-56 행.** 수용 기준 2 · 3이 main과 글자까지 같은가. 기준 1 · 4에서 빠진 구절이 중간 시작에 해당하는 것뿐이고 M3-60에 빠짐없이 옮겨졌는가(main의 문장과 구절 단위로 대조: 어느 행에도 없는 구절이 생기지 않았는가). 새로 넣은 문장 "이어받는 실행은 기준 커밋에서 첫 단계부터 돎"과 기준 4의 "첫 단계부터 도는 그 실행의 재주입과 더하기만이 자기 단계의 근거로 걸리며"가 **#319 브랜치의 코드에서 사실인가**(직접 읽는다: 이어받는 보강 실행에서 `isReinforcementRun` · `green-check.ts` · `merge.ts`의 "더하기만" 대조가 무엇을 기준으로 도는가. 기준 커밋이 원 실행과 같으므로 "기존 파일"의 뜻이 원 실행과 같은가. 첫 단계부터 돌면 테스트 작성이 새 파일을 다시 쓰는데 원 실행이 쓴 파일과 이름이 겹칠 때의 동작). 사실이 아니거나 시험이 없는 것을 수용 기준이 단언한다고 적었으면 지적한다(문서 에이전트는 "코드로는 맞지만 그 브랜치의 시험은 판별 · 자동 보강 막기 · 변이 생존 항목까지만 단언한다. #319 구현자가 시험을 더해야 한다"고 보고했다: 그 판단이 맞는지, 수용 기준에 남기는 것이 맞는지).
3. **새 행 M3-60.** 형식 규칙(항목 구분 ` · `, 항목 안 `·` 금지, 시험 파일 이름이 있는 검증 가능한 문장, 4개 이내). ADR-147의 결정 ② ③ ⑦과 `brief-323.md`의 결정 3(ⓐ ~ ⓓ)이 사실대로 들어갔는가. **명세 · ADR-147에 없는 새 기능이 없는가.** "예산 초과를 낸 시도의 단계(기존 `interrupted` 재개와 같은 자리)부터"가 ADR-147 ②의 "마지막 완료 단계 다음 단계부터"와 같은 뜻인가(회귀 중이던 실행: 예 구현 2번째 시도 중 예산 초과 → 시작 단계는 구현이고 앞 단계는 `skipped`. 검사 실패로 구현에 회귀한 상태에서 예산 초과 → 그 사이 `passed`였던 검사 단계의 기록은 어떻게 이어받는가: 문장이 이 경우를 가리는가). 영역 `orchestrator`만으로 충분한가(`skipped` 사유 `inherited`가 shared 스키마 · 앱 표시에 닿는가: #319 브랜치와 main의 `exitDetail` 표시 코드를 확인). 이슈 1개 크기인가.
4. **조율자 결정의 타당성.** ⓐ M3-56만 병합된 기간의 동작(첫 단계부터 다시 돎)이 무결성 · 비용 면에서 받아들일 만한가: 원 실행의 완료 단계를 다시 도는 동안 **원 실행의 Red 확인 결과와 다른 인수 테스트가 새로 쓰여** 원래 실패하던 구현이 통과하는 길이 생기지 않는가(새 실행이 자기 테스트 작성 · Red 확인을 실제로 돌므로 일반 실행과 같은 보호인가). 사슬 누적 한도가 실제로 재실행 비용을 새 한도 안에 가두는가. ⓑ M3-58 · M3-09가 M3-60 없이 성립한다는 판단. ⓒ 흐름 4번이 M3-60까지 끝나야 성립한다는 목표 문단의 문장.
5. **1장 · 3장 · 5장.** M3 이슈 수 57 → 59(행 수를 직접 센다). 커버리지 표에 더한 키가 선례와 같은 방식인가. 변경 이력 줄이 사실인가.
6. **ADR-150.** 형식(상태 · 맥락 · 결정 · 결과 · 한계 · 다시 정하는 조건)이 ADR-141 · ADR-147의 선례와 같은가. 맥락의 사실(파일 수 21 · +2063, 남은 일이 고칠 파일)이 브랜치와 맞는가. ADR-149를 "(PR 진행 중)"으로만 가리키는가. ADR 머리줄이 147 다음 150인 것은 의도다(148 · 149는 열린 작업의 것). `grep -c 'udb40' docs/decisions.md`는 2.
7. **발행 미리 보기.** `python3 scripts/publish-roadmap.py --dry-run`: 이슈 생성 1건(M3-60), 본문 갱신 2건(#319 · #323), 수동 확인 0건, 검증 OK인지. `python3 -m unittest discover -s scripts -p 'test_*.py'`. 숨은 글자: `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs docs/roadmap.md docs/decisions.md`.

## 실행
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, 파이썬 시험, `--dry-run`. 단위 테스트 · 빌드 · e2e는 돌리지 않는다. 파일을 고치지 않는다. 권한 · 격리 검사가 거부한 일을 다른 길(스크립트로 감싸기 · 거부된 경로를 다른 길로)로 하지 않는다("못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.

## 보고
판정(APPROVE / REQUEST_CHANGES)을 맨 앞에. 항목 1 ~ 7별 결론과 근거, 차단 · 비차단 지적, #319 구현자가 PR을 올리기 전에 더해야 할 시험 목록(있으면), 실행한 명령과 결과, check-runs 상태. 짧게.
