너는 chanrhan/bive 저장소의 이슈 #229(로드맵 M7-17 "파이프라인 e2e: 모순 해소 · 실수로 깬 기존 규칙 · 이의 제기 · 확인 풀림")를 구현하는 서브에이전트다.

배경: 사후 확인 전환(ADR-100)의 서버 쪽 동작은 모두 main에 있다(M7-01 ~ M7-13 · M7-19). 단위 시험과 검토자의 임시 e2e로는 확인했지만, 실제 git과 판정 러너로 끝까지 도는 파이프라인 e2e가 저장소에 없다. 이 이슈는 그 시험 파일 하나를 더한다. **제품 코드를 고치는 이슈가 아니다.**

## 받은 값
- 이슈 번호 `<N>` = 229, 브랜치 `<B>` = `chore/229-pipeline-e2e-contradiction`, ADR 번호 `<A>` = ADR-120(필요할 때만. 시험이 지금 동작을 고정하면서 정한 것이 있으면 적는다. 없으면 쓰지 않는다), 커밋 `<T>` = `test(orchestrator)`, 화면 변경 없음(화면 e2e · 스모크는 돌리지 않는다).
- 마이그레이션은 쓰지 않는다.
- 병렬로 이슈 #226(M7-14 확인할 것 화면, ADR-119)이 진행된다. 그쪽은 `packages/app`과 `confirmation.list` 응답(선택 칸을 더할 수 있다)을 고친다. 너는 `packages/orchestrator/e2e/pipeline/`과 `.github/workflows/ci.yml` · `scripts/check-pipeline-groups.py`(필요하면)만 고친다. 먼저 병합되는 쪽이 생기면 조율자가 알린다.

## 먼저 읽을 것 (순서대로, 전부)
1. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-common.md` 공통 지침.
2. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/m7-handoff.md` 전부. 특히 M7-09(시나리오 `contradiction`, 폐기 · 대체), M7-13(확인 풀림 · `confirmation.list` 순서 · 테스트 변경 알림 `test_changed`가 기록 순서에 끼는 경우), M7-11(시나리오 `objection`의 기준값), M7-12(시나리오 `contradiction-missed` · `accidental-break`의 기준값과 기록 순서, 다시 시작), M7-19(규칙마다 실행 1개) 절.
3. `.claude/skills/dev-env/SKILL.md`(파이프라인 e2e 기동, 픽스처 설치, `TMPDIR`, 포트).
4. 지금 있는 파이프라인 e2e: `packages/orchestrator/e2e/pipeline/harness.ts`, `happy-path.test.ts`, `auto-start-per-rule.test.ts`, `norm-input.test.ts`, `multi-rule.test.ts`. 새 파일은 이 방식(하네스의 기동 · RPC · 대기 · 정리)을 그대로 쓴다. 하네스에 꼭 필요한 도우미만 더한다.
5. 시나리오 정의(`packages/orchestrator/src/agent/scenario.ts` 등 `BIVE_SCENARIO` 값 `contradiction` · `contradiction-missed` · `accidental-break` · `objection`)와 그 단위 시험(`check-regression.test.ts` · `objection.test.ts` · `rule-writer.test.ts`).
6. `docs/decisions.md`의 ADR-071(파이프라인 e2e), ADR-077(CI 세 검사 · 묶음), ADR-112 · ADR-113 · ADR-115 · ADR-118.
7. 이슈 본문의 수용 기준 4개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/229`).

## 해야 할 것
`packages/orchestrator/e2e/pipeline/contradiction.test.ts` 하나에 네 흐름을 둔다. 모두 실제 git과 판정 러너로 돈다(가짜는 에이전트 어댑터뿐, ADR-016).
1. **`contradiction`(모순 해소)**: RULE-001이 병합된 뒤 모순 요구사항을 저장하면 규칙 작성 세션이 RULE-001을 대체하고, 자동 시작 실행이 `merged`이며, 그 실행의 검사 단계 판정에 RULE-001이 없다(폐기된 규칙은 검사 대상이 아니다). **RULE-001이 확인됨이었으면**(시험에서 사람 주체로 `confirmation.set`을 먼저 부른다) 확인이 풀리고 그 대체 항목이 `confirmation.list`의 맨 앞이며 `released`가 실려 있다. 규범 변경 기록에 `superseded` → `unconfirmed` 순서가 있다.
2. **`contradiction-missed`(규칙 작성 때 놓친 모순)**: 첫 실행이 기존 규칙 모순(`failed` · `existing_rule_contradiction`)으로 끝나고 병합되지 않는다. 대체 뒤 대체 규칙의 실행이 `merged`, 원래 대상 규칙을 다시 시작한 실행도 `merged`(병합 3). 모순으로 끝난 실행의 브랜치가 main에 들어가지 않았음을 git으로 확인한다.
3. **`accidental-break`(실수로 깬 기존 규칙)**: 판단이 모순 없음(`no_contradiction`)이고 같은 실행이 구현 재시도로 `merged`(implementation 시도 2, check 시도 2), 폐기 · 대체 0건.
4. **`objection`(이의 제기)**: 판단 유지(`upheld`) 뒤 구현 시도 2로 `merged`, 폐기 0건.

단언은 "끝 상태만"이 아니라 흐름을 본다: 실행 표시 ID별 상태와 종료 사유, 단계 시도별 결과, 규범 변경 기록의 종류 순서(인계 문서의 기준값과 대조. 하루 한도를 두면 `auto_start`가 끼고, 확인됨 규칙의 기존 테스트가 바뀐 병합이면 `test_changed`가 낀다. 시험이 그 조건을 스스로 정해 순서를 **정확히** 단언한다), `run.get`의 세션 목록(판단 세션이 `rule-writer`로 실행에 묶여 나온다), 병합 커밋 수, 폐기 · 대체 건수. 기준값이 인계 문서와 다르게 나오면 시험을 맞추기 전에 어느 쪽이 맞는지 코드로 확인하고 보고에 적는다(제품 결함이면 고치지 말고 보고한다. 작고 이 시험에 필수인 경우만 공통 지침대로).

## CI 묶음
- 새 파일은 `ci.yml`의 `PIPELINE_E2E_GROUP1`에 넣지 않으면 묶음 2에서 돈다. 최근 실행 시간은 묶음 1이 약 15분, 묶음 2가 9 ~ 14분이고 제한은 30분이다. 새 파일은 묶음 2에 둔다. 푸시 뒤 두 묶음의 실제 소요 시간을 check-runs에서 읽어 보고에 적는다. 묶음 2가 20분을 넘으면 파일을 옮겨 균형을 맞춘다(`scripts/check-pipeline-groups.py`가 목록 대조를 한다. 수용 기준 4: 새 시험이 `pipeline-e2e`에 포함됨을 그 대조가 보인다).
- 한 파일에 네 흐름이라 길다. 흐름마다 저장소 · 오케스트레이터를 새로 띄우는지, 한 번 띄워 이어 쓰는지는 기존 파일의 방식과 소요 시간을 보고 정한다(흐름끼리 상태가 섞여 단언이 약해지면 안 된다).
- 로컬 확인: `pnpm -C fixtures/sample-next-app install --frozen-lockfile` 뒤 새 파일만(`pnpm --filter @bive/orchestrator exec vitest run --config <파이프라인 e2e 설정> e2e/pipeline/contradiction.test.ts` 식. 정확한 명령은 `package.json`의 `e2e:pipeline` 스크립트에서 읽는다). 전체 `pnpm e2e:pipeline`은 PR을 올리기 전 한 번만. 전체 `pnpm test`는 제품 코드를 고치지 않았으면 돌리지 않는다(CI가 기준).

## 반드시 지킬 것
- 시험을 통과시키려고 제품 코드 · 시나리오를 느슨하게 고치지 않는다. 시나리오를 고쳐야만 한다면 이유를 보고에 적는다.
- 대기는 하네스의 대기 도우미로 한다(고정 `sleep` 금지). 시간 제한은 기존 파일 수준으로.
- 새 시험이 실제로 성질을 지키는지 확인한다: 각 흐름에서 제품 코드 한 줄을 잠시 바꿔(예: 모순 판단의 halt 빼기, 폐기 규칙을 검사 대상에서 빼는 줄, 확인 풀림 쓰기) 빨강이 되는지 보고 되돌린다. 결과 표를 PR 본문에 적는다.
- `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md`를 고치지 않는다. CLAUDE.md 5장의 파이프라인 e2e 명령은 그대로 유효해야 한다.
- 숨은 글자: `pnpm format:check` 뒤 바뀐 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 토큰을 아낀다.

## 보고
공통 지침의 보고 항목에 더해: 네 흐름의 실제 기준값(실행 · 단계 · 기록 순서 · 세션 · 병합 수), 인계 문서와 다른 점, 변이 결과 표, 두 묶음의 CI 소요 시간, 하네스에 더한 도우미, 찾은 제품 결함(있으면).
