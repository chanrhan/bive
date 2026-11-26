너는 chanrhan/bive 저장소의 이슈 #305(로드맵 M3-52 "CI 잡 시간 여유 (checks · 파이프라인 e2e 묶음의 제한 시간)")를 구현하는 서브에이전트다. 작고 급한 일이다: 열린 PR #303의 `checks` 잡이 20분 제한에 한 번 걸려 취소됐고 다시 돌려 19.3분에 통과했다. 이 제한을 늘리기 전에는 그 PR을 병합할 수 없다.

## 받은 값
- 이슈 번호 `<N>` = 305, 브랜치 `<B>` = `chore/305-ci-timeouts`, ADR 번호 `<A>` = ADR-138, 커밋 `<T>` = `chore(ci)`, 화면 변경 없음, 마이그레이션 없음.
- 기준 main은 `git fetch origin main` 뒤의 `origin/main`(지금 `800a7ea`). `git checkout -b chore/305-ci-timeouts origin/main`.
- 병렬로 PR #303(ADR-136)과 PR #304(ADR-137)가 검토 중이다. 둘 다 `.github/workflows` · `scripts/` · `docs/roadmap.md`를 건드리지 않는다. `docs/decisions.md` 끝에 ADR을 더하는 것만 겹친다: 네 ADR은 **ADR-138**이고 지금 main의 끝은 135다. 번호를 건너뛴 채(135 다음 138) 둔다. 136 · 137은 그 PR들이 채운다.

## 먼저 읽을 것
1. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-common.md` 공통 지침(이 일에 해당하는 부분만: 커밋 · 푸시 · PR · 권한 규칙).
2. 이슈 본문(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/305`), `.github/workflows/ci.yml` 전부, `docs/decisions.md`의 ADR-077(CI 세 검사)과 M3-24(파이프라인 e2e 두 묶음)를 정한 ADR, `docs/roadmap-format.md`, `docs/roadmap.md`의 M3 이슈 표 끝(M3-50 · M3-51 행)과 1장 요약 표 · 5장 변경 이력의 최근 줄, `scripts/test_check_pipeline_groups.py`(파이썬 시험의 기존 방식), `ci.yml`에서 파이썬 시험을 도는 단계(`python3 -m unittest discover -s scripts -p 'test_*.py'`).

## 해야 할 것
1. **`.github/workflows/ci.yml`**: `checks` 잡의 `timeout-minutes`를 20 → **30**, `pipeline-e2e-group` 잡을 30 → **40**. 다른 것은 건드리지 않는다(`pipeline-e2e` · `ci` 집계 잡의 제한 5분, `needs`, 단계, 묶음 목록). 잡 머리 주석에 시간 서술이 있으면 사실만 맞춘다.
2. **파이썬 시험** `scripts/test_ci_workflow.py`(기존 `test_*.py`와 같은 `unittest` 방식, CI의 기존 단계가 그대로 돌린다): 워크플로 파일을 읽어 단언한다 — `checks`의 제한 30, `pipeline-e2e-group`의 제한 40, `pipeline-e2e` · `ci`의 제한이 그대로(지금 값), `ci` 잡의 `needs`가 `checks`와 `pipeline-e2e`를 담고 `pipeline-e2e`의 `needs`가 `pipeline-e2e-group`임(지금 파일에서 실제 값을 읽어 그대로 고정). YAML 파서가 CI 러너의 기본 파이썬에 있는지 확신할 수 없으므로 **표준 라이브러리만** 쓴다(줄 단위로 잡 블록을 찾아 값을 읽는 작은 함수. 들여쓰기 두 칸 잡 키 기준). 값 하나를 바꾸면 빨강이 되는지 직접 확인하고 결과를 PR 본문에 적는다.
3. **ADR-138**: 맥락(잡별 소요 시간 실측: 아래 표를 네가 check-runs로 다시 확인해 적는다), 결정(제한을 늘린다: 가장 작고 되돌리기 쉽다. 잡을 나누면 `ci` 집계 · CLAUDE.md 5장의 서술 · 묶음 대조 스크립트가 함께 바뀐다), 결과(실패가 늦게 드러나는 비용: 걸린 잡이 최대 10분 더 돈다), 다시 정하는 조건(`checks`가 다시 25분을 넘으면 단위 테스트를 따로 잡으로 나누거나 무거운 시험을 줄인다). 상태 `제안 (에이전트)`.
   - 실측(조율자가 본 값, 분): main `97c8b50` checks 14.5 · 묶음 15.0 / 17.9, main `227b070` checks 14.8 · 묶음 21.2 / 16.1, main `512bfe1` checks 14.4 · 묶음 15.0 / 12.1, PR #302 `601d5cc` checks 15.2, PR #304 `404ca68` checks 15.3 · 묶음 21.1 / 12.4, PR #303 `ff18bcf` checks 19.3(첫 시도는 20분 제한으로 취소) · 묶음 20.9 / 18.1. `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<sha>/check-runs`의 시작 · 끝 시각으로 다시 계산한다.
4. **로드맵 행** (`docs/roadmap.md`, 이 이슈는 로드맵 행을 스스로 더하는 이슈다: 조율자가 이슈 #305를 먼저 만들었다):
   - M3 이슈 표 끝(M3-51 다음)에 행 하나: 키 `M3-52`, 제목 `CI 잡 시간 여유 (checks · 파이프라인 e2e 묶음의 제한 시간)`, 유형 `chore`, 영역 `ci`, 의존 `—`, 수용 기준은 **이슈 #305 본문의 두 문장과 글자까지 같게**(형식 규칙: 항목은 ` · `로 구분하고 항목 안에서는 `·`를 쓰지 않는다. 이슈 본문의 문장에 `·`가 들어 있으면 형식 규칙에 맞게 **로드맵 쪽 문장을 정하고**, 발행 스크립트가 이슈 본문을 그것으로 갱신하게 된다는 점을 보고에 적는다), 관련 ID `ADR-077 · ADR-138`, 이슈 `#305`.
   - 1장 요약 표의 M3 이슈 수, 문서 머리의 상태 줄(버전 · 갱신일)과 5장 변경 이력 한 줄을 기존 방식대로 고친다(최근 줄의 형식을 따른다). 3장 커버리지 표는 PRD · 화면 ID만 다루므로 바꾸지 않는다(관련 ID가 ADR뿐이다. 기존 chore 행의 선례를 확인한다).
   - `python3 scripts/publish-roadmap.py --dry-run`을 돌려 출력을 보고에 붙인다. **`--dry-run` 없이 돌리지 않는다**(실제 발행은 조율자가 한다). `python3 -m unittest discover -s scripts -p 'test_*.py'`도 돌린다.
5. `docs/architecture.md` · `CLAUDE.md` · `dev-env` 스킬에 `checks` 잡의 제한 시간 숫자가 적혀 있으면 사실만 맞춘다(`CLAUDE.md`는 고치지 않는다: 숫자가 거기 있으면 보고에 적는다). `docs/spec/*`는 고치지 않는다.

## 반드시 지킬 것
- 워크플로의 다른 동작을 바꾸지 않는다(트리거 · 권한 · 캐시 · 단계 · 동시성). 범위 밖 정리를 하지 않는다.
- 커밋은 서명 설정을 끄지 않는다. 작성자를 바꾸지 않는다. 강제 푸시 · 리베이스 · 빈 커밋 금지. main에 직접 푸시하지 않는다.
- 권한 · 격리 검사가 거부한 일을 다른 길로 하지 않는다. 프록시 환경 변수 값을 출력하지 않는다.
- 실행: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`(대상이 아닌 파일뿐이어도 한 번), 파이썬 시험, `--dry-run`. 단위 테스트 · e2e · 빌드는 돌리지 않아도 된다(제품 코드 변경 없음, `ci`가 기준).
- PR: 제목은 이슈 제목 그대로, 본문 첫 줄 `Closes #305`, 공통 지침의 본문 끝 두 줄. **푸시하고 PR을 만든 뒤 `ci`를 기다리지 말고 바로 보고한다**(조율자가 `ci`를 확인한다. 이 PR의 `checks`가 새 제한으로 도는지도 조율자가 본다).

## 보고
PR 번호, 최종 SHA, 바꾼 줄(파일:줄), 파이썬 시험의 단언 목록과 빼면 빨강 확인, 실측 표, `--dry-run` 출력, 로드맵 수용 기준 문장과 이슈 본문의 차이 유무, 숫자가 적혀 있던 다른 문서. 짧게, 한국어로.
