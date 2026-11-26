너는 chanrhan/bive 저장소의 PR #306(이슈 #305, 로드맵 M3-52 "CI 잡 시간 여유")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 작은 PR이다(4개 파일, +175 / -4). 빠르고 정확하게 본다. 한국어로 일하고 보고도 한국어로 쓴다.

## 받은 값
- PR #306, 브랜치 `chore/305-ci-timeouts`, 헤드 `18ba3adb966f9efa69d941e4654211838aa4b035`, 기준 main `800a7ea`. `ci`는 조율자가 따로 확인한다(지금 진행 중). 네가 끝낼 때 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/18ba3adb966f9efa69d941e4654211838aa4b035/check-runs`의 상태를 한 번 보고 보고에 적는다(기다리지 않는다).
- 네 작업 공간에서 `git fetch origin chore/305-ci-timeouts` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다. `scripts/publish-roadmap.py`는 **`--dry-run`으로만** 돌린다(`--dry-run` 없이 돌리면 실제로 발행된다).

## 먼저 읽을 것
`.claude/skills/pr-reviewer/SKILL.md`(로드맵 문서 검토 절 포함), `CLAUDE.md`, scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-305.md`(구현자가 받은 지시서) · `pr306-body.md`(PR 본문 사본), 이슈 #305 본문(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/305`), `docs/roadmap-format.md`, `docs/decisions.md`의 ADR-077과 ADR-138(이 PR이 더함), `.github/workflows/ci.yml` 전부.

## 판정할 것
1. **워크플로.** `git diff 800a7ea...HEAD -- .github/workflows/ci.yml`. 바뀐 것이 `checks` 20 → 30, `pipeline-e2e-group` 30 → 40, 주석 세 곳뿐인가. 트리거 · 권한 · 동시성 · 단계 · 묶음 목록 · 집계 잡이 글자까지 그대로인가. YAML로서 유효한가(들여쓰기, 주석 위치). 제한을 늘린 것이 "실패를 숨기는" 변경은 아닌지(시간 제한은 판정이 아니라 낭비 방지다: 타당하면 그렇게 적는다).
2. **파이썬 시험** `scripts/test_ci_workflow.py`. 표준 라이브러리만 쓰는가. 파서가 잡 블록과 키를 맞게 읽는가(단계 안의 `timeout-minutes`를 잡의 값으로 잘못 집지 않는가, 주석 줄 · 빈 줄 · `needs`의 두 모양). CI의 기존 단계(`python3 -m unittest discover -s scripts -p 'test_*.py'`)가 이 파일을 집는가(작업 폴더 기준 경로: 시험이 워크플로 파일을 어떤 경로로 여는가. 다른 폴더에서 돌려도 찾는가). 변이를 직접 넣어 본다: `checks`를 29로, 묶음을 30으로, `ci`의 `needs`에서 `pipeline-e2e` 빼기, `pipeline-e2e`의 제한을 10으로, 잡 이름을 바꾸기. 각각 빨강인지 표로.
3. **ADR-138.** 실측 표의 값을 check-runs로 두세 개 골라 다시 계산해 본다. 결정 · 결과 · 다시 정하는 조건이 사실이고 과장이 없는가. ADR-077 본문을 고치지 않았는가. ADR 머리줄이 135 다음 138인 것은 의도다(136 · 137은 열린 PR #303 · #304의 것): 그대로가 맞다. `grep -c 'udb40' docs/decisions.md`는 2.
4. **로드맵.** M3-52 행이 `docs/roadmap-format.md`의 형식(열 수, 유형 · 영역 값, 수용 기준 항목 구분과 항목 안 `·` 금지, 관련 ID는 ID만, 이슈 `#305`)에 맞는가. 수용 기준 문장이 이슈 #305 본문과 뜻이 같은가(달라진 두 곳이 형식 규칙 때문인가). 1장 요약 표의 이슈 수 50 → 51이 맞는가(M3 표의 행 수를 직접 센다). 5장 변경 이력 줄이 사실인가. 문서 머리 상태 줄을 고치지 않은 것이 기존 방식과 맞는가(최근 변경 PR들의 선례를 `git log -p -3 -- docs/roadmap.md`로 본다). 커버리지 표를 안 고친 것이 맞는가. `python3 scripts/publish-roadmap.py --dry-run`을 돌려 "이슈 생성 0건, 본문 갱신 1건(#305), 수동 확인 0건, 검증 OK"인지 확인한다.
5. **범위.** `docs/spec/*` · `CLAUDE.md` · 제품 코드 · 다른 스크립트가 바뀌지 않았는가. 숨은 글자: 바뀐 파일 4개를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.

## 실행
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `python3 -m unittest discover -s scripts -p 'test_*.py'`, `--dry-run`. 단위 테스트 · 빌드 · e2e는 돌리지 않는다(제품 코드 변경 없음). 권한 · 격리 검사가 거부한 일을 다른 길로 하지 않는다("못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.

## 보고
판정(APPROVE / REQUEST_CHANGES)을 맨 앞에. 항목 1~5별 결론과 근거, 변이 표, 차단 · 비차단 지적, 실행한 명령과 결과, check-runs 상태. 짧게.
