너는 chanrhan/bive 저장소의 이슈 #329(로드맵 M3-61 "CI checks 잡 시간 여유 (제한 시간과 단계별 소요 시간 실측)")를 구현하는 서브에이전트다. 작은 일이다: `checks` 잡이 최근 두 번 약 25분이 걸렸다(제한 30분, ADR-138이 "25분을 넘으면 다시 본다"고 정한 선). 제한에 걸려 병합이 막히기 전에 여유를 둔다. 선례: 이슈 #305(M3-52, PR #306, ADR-138: `git show ea883a7 --stat`). 그 PR의 방식(워크플로 값 · 파이썬 시험 · ADR · 자기 로드맵 행)을 그대로 따른다.

**절차(먼저 읽는다)**: 파일을 고치는 것은 Edit · Write 도구로만 한다. 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것만 된다. 스크립트 파일로 감싸 거부를 피하기, 옵션 · 작업 폴더 · 경로 표기를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다("못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.

## 받은 값
- 이슈 번호 `<N>` = 329, 브랜치 `<B>` = `chore/329-ci-checks-timeout`, ADR 번호 `<A>` = ADR-154, 커밋 `<T>` = `chore(ci)`. 화면 변경 없음, 마이그레이션 없음.
- 기준 main은 `git fetch origin main` 뒤의 `origin/main`(지금 `ed376f0`). main의 ADR 끝은 152다. 153은 열린 작업(#320)의 것이라 **비워 두고** 152 다음에 154를 둔다.
- 병렬 작업: 이슈 #320(규칙 분할, ADR-153, 마이그레이션 0031)이 구현 중이다. `.github/workflows` · `scripts/` · `docs/roadmap.md`는 건드리지 않는다. `docs/decisions.md` 끝만 겹친다.

## 먼저 읽을 것
1. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-common.md` 공통 지침(커밋 · 푸시 · PR · 권한 규칙).
2. 이슈 #329 본문, `.github/workflows/ci.yml` 전부, `docs/decisions.md`의 **ADR-138 전부**(다시 정하는 조건) · ADR-077 · 파이프라인 e2e 두 묶음을 정한 ADR, `scripts/test_ci_workflow.py`(지금 단언), `docs/roadmap-format.md`, `docs/roadmap.md`의 M3 이슈 표 끝(M3-52 · M3-59 · M3-60 행)과 1장 요약 표 · 5장 변경 이력의 최근 줄, `CLAUDE.md` 5장(CI 서술: **고치지 않는다. 사람만 고친다**).

## 해야 할 것
1. **실측** (수용 기준 2). GitHub API로 최근 실행의 `checks` 잡 단계별 소요 시간을 잰다: `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/<sha>/check-runs`로 잡 ID를 얻고 `scripts/gh-rest.sh GET repos/chanrhan/bive/actions/jobs/<job_id>`의 `steps[].started_at` · `completed_at`으로 단계(의존성 설치 · 린트 · 타입 검사 · 단위 테스트 · 빌드 · 픽스처 · 화면 e2e 등)별 분을 낸다. 대상: 최근 main 커밋 `ed376f0` · `1b486c2` · `e5a8816` · `25bc959` · `22c66c7` · `64bac0e`와, 약 25분이 걸린 PR 실행 둘(PR #322의 커밋 `95c48a083173b2567163480d6e4b47a46df457c2`, PR #328의 커밋 `a6a4fb21c476648b28197db61af43582eaf9937d`). 병합된 PR의 커밋은 check-runs가 남아 있는 것만 쓴다(없으면 표에서 빼고 그렇게 적는다). 묶음 잡 (1) · (2)의 전체 시간도 함께. 표로 ADR에 싣는다. 어느 단계가 늘었는지(단위 테스트인지 화면 e2e인지)와 같은 커밋 계열에서 실행마다 얼마나 흔들리는지를 사실대로 적는다.
2. **제한 시간** (수용 기준 1). `checks`의 `timeout-minutes`를 30 → 40으로 올린다. `pipeline-e2e-group`(40) · 집계 잡 `pipeline-e2e` · `ci`(5)와 `needs` · 잡 이름 · 단계 · 트리거 · 권한 · 캐시 · 동시성 · 묶음 목록은 그대로다. `scripts/test_ci_workflow.py`의 단언을 맞춘다(`checks` 40, 나머지 그대로, **잡 이름 네 개가 그대로**임을 단언에 더한다).
   - 잡을 나누지 않는다. 까닭을 ADR에 적는다: `checks`를 나누면 집계 잡 `ci`의 `needs`와 CLAUDE.md 5장의 CI 서술("CI는 세 검사다: `checks`(린트 · 타입 · 단위 · 빌드 · 형식 · 픽스처 · 화면 e2e) …")이 함께 바뀌는데 CLAUDE.md는 사람만 고친다. 그리고 전체 대기 시간은 파이프라인 e2e 묶음(15 ~ 22분)이 정하므로 `checks`를 나눠도 한 PR이 기다리는 시간은 거의 줄지 않는다(실측으로 확인해 사실이면 적는다).
   - 실측에서 단위 테스트가 눈에 띄게 늘어난 원인이 특정 시험 파일이면(예: 판정 묶음 `contract-runner.test.ts` · `judge-runner.test.ts`) **고치지 말고** ADR의 "다시 정하는 조건"과 보고에 적는다(무거운 시험 줄이기는 뒤 이슈).
3. **ADR-154**: 제목 예 `CI checks 잡 제한 시간 40분 (단계별 실측, 잡은 나누지 않음)`. 상태 `제안 (에이전트) · <오늘>`(`TZ=Asia/Seoul date +%F`). 맥락(실측 표, 25분을 넘긴 실행), 결정, 결과(실패가 늦게 드러나는 비용), 다시 정하는 조건(`checks`가 35분을 넘으면 단위 테스트를 따로 잡으로 나누고 그때 CLAUDE.md 5장의 문장을 사람이 고치도록 needs-human 이슈를 낸다 · 무거운 시험 줄이기). ADR-138의 "`checks` 30분"은 이 ADR이 40분으로 바꾼다(ADR-138 본문은 고치지 않는다).
4. **자기 로드맵 행 M3-61** (M3 이슈 표 끝, M3-60 다음): 제목은 이슈 #329의 제목(`[M3] ` 뺀 것) 그대로, 유형 `chore`, 영역 `ci`, 의존 `M3-52`, 수용 기준은 이슈 본문의 두 문장과 뜻이 같게(형식: 항목은 ` · `로 구분, 항목 안에서는 `·`를 쓰지 않는다), 관련 ID `ADR-077 · ADR-138 · ADR-154`, 이슈 `#329`. 1장 요약 표의 M3 이슈 수(59 → 60), 5장 변경 이력 한 줄. 커버리지 표는 M3-52의 선례대로(M3-52가 들어간 행이 있으면 같게, 없으면 넣지 않는다).
5. `python3 -m unittest discover -s scripts -p 'test_*.py'`, `python3 scripts/publish-roadmap.py --dry-run`(검증 OK, 이슈 생성 0건이어야 한다: 이슈는 이미 있다. 본문 갱신이 있으면 무엇인지 보고. **`--dry-run` 없이 돌리지 않는다**), `pnpm install --frozen-lockfile` · `pnpm lint` · `pnpm format:check`.

## 반드시 지킬 것
- `CLAUDE.md` · `docs/spec/*` · 제품 코드를 고치지 않는다. 워크플로에서 `checks`의 제한 값 말고는 고치지 않는다.
- 사실 문장은 API에서 읽은 값만 적는다(추정으로 표를 채우지 않는다).
- 숨은 글자를 넣지 않는다. `grep -c 'udb40' docs/decisions.md`는 2.
- 커밋은 서명 설정을 끄지 않는다. 작성자를 바꾸지 않는다. 강제 푸시 · 리베이스 · 빈 커밋 금지. main에 직접 푸시하지 않는다.
- PR: 제목은 이슈 #329의 제목 그대로, 본문 첫 줄 `Closes #329`, 실측 표 요약, `--dry-run` 요약, 본문 끝에 공통 지침의 두 줄. `ci` 성공까지 확인한 뒤 보고한다(대기 40분까지. 빨강이면 다시 돌리지 말고 보고).

## 보고
PR 번호, 최종 SHA, 실측 표(단계별 분), 무엇이 늘었는지, 바꾼 것, `--dry-run` 요약, CI 결과와 이번 실행의 `checks` 소요 시간, 못 한 것. 짧게, 한국어로.
