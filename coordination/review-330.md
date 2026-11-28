너는 chanrhan/bive 저장소의 PR #330(이슈 #329, 로드맵 M3-61 "CI checks 잡 시간 여유 (제한 시간과 단계별 소요 시간 실측)")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 작은 PR이다(워크플로 값 하나 · 파이썬 시험 · ADR-154 · 자기 로드맵 행). 빠르고 정확하게 본다. 한국어로 일하고 보고도 한국어로 쓴다.

**절차**: 파일을 고치는 것(변이 포함)은 Edit · Write 도구로만 하고 `git checkout -- <파일>`로 되돌린다. 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것만 된다(다른 길로 같은 일을 하지 않는다. "못 함"으로 보고). 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다. `scripts/publish-roadmap.py`는 `--dry-run`으로만 돌린다.

## 받은 값
- PR #330, 브랜치 `chore/329-ci-checks-timeout`, 헤드 `56624f6dac8602df64b4d58a83f7ffd6b4dbc5c2`, 기준 main `ed376f0`. 조율자가 `ci` 성공을 확인했다(네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/56624f6dac8602df64b4d58a83f7ffd6b4dbc5c2/check-runs`로 한 번 더).
- 네 작업 공간에서 `git fetch origin chore/329-ci-checks-timeout` 뒤 `git checkout --detach FETCH_HEAD`.

## 먼저 읽을 것
`.claude/skills/pr-reviewer/SKILL.md`, `CLAUDE.md`(5장의 CI 서술), `docs/roadmap-format.md`, scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-329.md` · `pr330-body.md`, 이슈 #329 본문, `docs/decisions.md`의 ADR-154(이 PR이 더함) · ADR-138 · ADR-077, 선례 `git show ea883a7 --stat`(PR #306).

## 판정할 것
1. **범위.** `git diff ed376f0...HEAD --stat`: `.github/workflows/ci.yml` · `scripts/test_ci_workflow.py` · `docs/decisions.md` · `docs/roadmap.md`뿐인가. `CLAUDE.md` · `docs/spec/*` · 제품 코드가 바뀌지 않았는가. 워크플로의 차이가 `checks`의 `timeout-minutes` 30 → 40과 그 주석뿐인가(잡 이름 · `needs` · 단계 · 트리거 · 권한 · 캐시 · 동시성 · 묶음 목록 불변).
2. **시험.** `scripts/test_ci_workflow.py`가 `checks` 40 · 묶음 40 · 집계 잡 5 · `needs` · 잡 이름 네 개를 단언하는가. 제한을 30으로 되돌리는 변이와 잡 이름 하나를 바꾸는 변이를 넣어 빨강인지 확인한다. `python3 -m unittest discover -s scripts -p 'test_*.py'`.
3. **실측의 사실성.** ADR-154의 표에서 두세 행을 골라 GitHub API로 다시 잰다(`scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<sha>/check-runs` → 잡 ID → `scripts/gh-rest.sh GET repos/chanrhan/bive/actions/jobs/<job_id>`의 단계 시각): 값이 맞는가. "25분을 넘긴 두 실행은 단위 테스트와 화면 e2e가 함께 늘었고 같은 트리(`a6a4fb2` 대 `ed376f0`)에서도 25.3분과 17.2분으로 흔들린다" · "8번 가운데 5번은 `checks`가 두 묶음보다 길었다"가 표와 맞는가.
4. **결정의 타당성.** 잡을 나누지 않고 제한을 늘린 이유(집계 잡 `ci`의 `needs`와 CLAUDE.md 5장의 CI 서술이 함께 바뀜, 나눠도 줄어드는 대기는 1.6 ~ 3.4분)가 타당한가. 제한 40분의 비용(멈춘 잡이 10분 더 돌 수 있음)과 다시 정하는 조건(35분)이 ADR에 있는가. CLAUDE.md 5장의 문장 가운데 이 변경으로 틀려지는 것이 있는가(제한 시간 숫자가 CLAUDE.md에 적혀 있는가: 있으면 사람이 고쳐야 하므로 보고).
5. **로드맵.** M3-61 행의 형식(항목 구분 ` · `, 항목 안 `·` 금지) · 유형 `chore` · 영역 `ci` · 의존 `M3-52` · 이슈 `#329`, 요약 표의 M3 이슈 수 59 → 60(행 수를 직접 센다), 5장 변경 이력. `python3 scripts/publish-roadmap.py --dry-run`: 검증 OK, 이슈 생성 0건, 본문 갱신 1건(#329)인지.
6. **ADR-154.** 형식이 ADR-138과 같은가. ADR-138 본문을 고치지 않았는가. ADR 머리줄이 152 다음 154인 것은 의도다(153은 열린 PR #331의 것). `grep -c 'udb40' docs/decisions.md`는 2. 숨은 글자: `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <바뀐 파일 4개>`.

## 실행
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, 파이썬 시험, `--dry-run`. 단위 테스트 · 빌드 · e2e는 돌리지 않는다.

## 보고
판정(APPROVE / REQUEST_CHANGES)을 맨 앞에. 항목 1 ~ 6별 결론과 근거, 다시 잰 값, 변이 결과, 차단 · 비차단 지적, 실행한 명령과 결과. 짧게.
