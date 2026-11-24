너는 chanrhan/bive 저장소의 이슈 #217(로드맵 M7-05 "실행 자동 시작 · 승인 단계 자리의 효력 확인 · 시작 근거 대조")을 구현하는 서브에이전트다.

## 받은 값
- 이슈 번호 `<N>` = 217, 브랜치 `<B>` = `feat/217-auto-start`, ADR 번호 `<A>` = ADR-107, 커밋 `<T>` = `feat(orchestrator)`, 화면 변경: 상태 줄 표시만(고치면 화면 e2e · 스모크도 돌린다).
- 새 마이그레이션 번호는 `0016`만 쓴다(main에는 0015까지 있다).

## 먼저 읽을 것 (순서대로, 전부)
1. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-common.md` 공통 지침. 그대로 따른다.
2. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/m7-handoff.md` 앞선 M7 이슈가 만든 것과 [전달] 사실. 전부 읽는다.
3. `docs/decisions.md`의 ADR-100(사람 결정. 특히 A3, B⑤, B⑥, C2와 명세 변경 목록), ADR-103(규범 변경 기록), ADR-104(하루 예산), ADR-105(동시 1개 · 실행 대기), ADR-106(규범 입력 · 모순 판단. main에 있을 때만), ADR-061 · ADR-066 · ADR-076(시작 근거 대조 · `run_without_log`).
4. 이슈 본문의 수용 기준 4개. 이것이 완료 기준이다.

## 이미 있는 것 (새로 만들지 말고 쓴다)
- 규범 변경 기록: `norm_changes`, 종류에 `auto_start`가 이미 있다. 쓰기는 `norms/agent-rule.ts`만 한다는 구조 시험(`.normChanges.append(` 허용 목록)이 있다. 자동 시작 항목을 쓰는 자리를 새 파일로 두면 그 허용 목록에 그 파일을 의도적으로 더하고 PR 본문에 적는다. `NormChangeDetail`은 넓히기만 한다. 원인 기록은 정수 `seq`로 `detail`에 둔다.
- 하루 예산: `validateSettingsForAutoStart(settings, roles?)`는 오늘 쓴 금액을 보지 않는다. 자동 시작 전에 `projectDailyBudget(store, settings, now)`와 `dailyBudgetReached`로 미리 확인하고, 닿았으면 실행을 만들지 않는다. 한도가 비어 있으면(`dailyBudgetUnset`) 자동 시작을 생략하고 그 사실을 상태 줄(`ruleWriter.status` 쪽)에 보인다.
- 실행 대기: 자동 시작 실행도 `createRun`과 같은 모양(`waiting_approval`)으로 저장한 뒤 `engine.onRunCreated(projectId, runId)`를 부른다. 다른 실행이 진행 중이면 `queued`가 된다. `startNextQueuedRun` · `#advanceQueue` · `engine.startQueuedRuns()`를 그대로 쓴다.
- 종료 상태는 `runEnding()` 한 곳에서만 정한다(ADR-091 · ADR-094 · ADR-105). 실행 패치에 `status: 'failed'`를 직접 쓰지 않는다는 구조 시험이 있다.

## 해야 할 것
1. **자동 시작.** 규칙 작성 세션이 규칙을 만들고 끝나면, 그 세션이 만든 규칙들을 대상으로 실행 1개를 사람 확인 없이 만든다. 규범 변경 기록에 `auto_start` 항목 1건(주체 오케스트레이터, 원인 = 그 규칙들의 `created` 기록 `seq`, 실행 ID)을 남긴다. 승인 기록(`approval_log`)에는 아무것도 쓰지 않는다(사람 전용). 세션이 규칙을 하나도 못 만들었으면 실행을 만들지 않는다.
2. **`runs.started_by` CHECK 넓히기.** 0005의 CHECK(사람만)를 표 재구성 마이그레이션 0016으로 바꾼다. 오케스트레이터 주체는 원인 규범 변경 기록 ID가 있을 때만 받는다. 실행기 옵션 `disableForeignKeys: true`를 쓰고, `steps` 트리거와 0015의 `runs_one_running_insert` · `runs_one_running_update` 트리거, 색인을 빠짐없이 다시 만든다. 0015가 한 재구성을 본보기로 삼되 0015 파일은 고치지 않는다. 이행 전 데이터(사람이 시작한 실행, `queued` · `interrupted` 실행)가 그대로 남는지 `store/test/migrate.test.ts`에 단언한다. NULL 구멍을 조심한다(`coalesce(json_extract(...), '')`, `json_type = 'object'`. 0013에서 같은 구멍이 검토에 걸렸다).
3. **시작 근거 대조.** 엔진이 실행을 시작할 때 사람 `run_start` 1건 또는 `auto_start` 항목 1건이 정확히 있어야 한다. 0건, 2건 이상, 둘 다, 다른 실행의 항목, 원인 `seq`가 실제 `created` 기록이 아닌 경우는 `run_without_log`다. 에이전트가 이 항목을 만들 길이 없음을 구조 시험으로 보인다.
4. **승인 단계.** 대상 규칙이 모두 효력 상태(삭제 안 됨, `normState === 'approved'`)인지만 보고 사람을 기다리지 않는다. `waiting_approval`에 머무는 경로가 없어야 한다. 효력이 아닌 규칙이 섞였을 때의 종료는 `runEnding()`을 거친다. 상태 이름 `waiting_approval` 자체를 없애는 것은 범위 밖이다(저장 모양 · 대기 전이가 이 이름에 걸려 있다). 남기는 이유를 ADR-107에 적는다.
5. **사람의 [실행]**(SCR-03 확인 대화)은 그대로 실행을 만든다. 승인 관련 사람 RPC를 지우는 것은 범위 밖이다.
6. **파이프라인 e2e.** `happy-path.test.ts`가 요구사항 저장부터 사람 조작 없이 `merged`까지 가는 것을 단언한다. 다른 파이프라인 e2e와 시나리오는 새 흐름에 맞게 고친다. 새 e2e 파일을 더하면 `scripts/check-pipeline-groups.py`의 두 묶음 가운데 하나에 넣는다(안 넣으면 `pipeline-e2e`가 빨강이다).

## 반드시 지킬 것
- `integrity.test.ts`의 구조 시험: 엔진 · 단계 · 에이전트 · 도구 · 역할 · 판정 · 실행 코드에 `/confirm/i` 글자 금지(주석 포함), `.confirmations`는 `confirmations/confirmation-service.ts`만, `.rules.create(`는 두 파일만. 느슨하게 만들지 않는다. 허용 목록을 고치면 이유를 PR 본문에 적는다.
- 에이전트 세션(규칙 작성 · 테스트 작성 · 구현)에 실행을 시작하는 도구를 주지 않는다. 자동 시작은 오케스트레이터 코드가 세션이 끝난 뒤에 한다.
- 재기동 중에 세션이 끝났거나 자동 시작 직전에 죽은 경우를 생각한다. 같은 원인 `seq`로 실행이 두 번 생기지 않아야 한다(멱등). 어떻게 막았는지 시험과 ADR에 적는다.
- 자동 시작이 연쇄로 무한히 돌지 않음을 보인다(실행이 규칙 작성 세션을 다시 일으키는 길이 있는지 확인한다). 멈춤 장치는 하루 예산뿐이라는 것이 사람 결정이다. 다른 멈춤 장치를 새로 만들지 않는다.
- `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md`를 고치지 않는다.
- 검토에서 반복해서 걸린 것: ⓐ 보이는지만 단언하고 내용 · 배치는 단언하지 않는 시험, ⓑ 방어 코드는 있는데 시험이 없는 곳, ⓒ ADR 문장이 코드와 다른 것. 셋 다 스스로 점검하고 낸다.

## 보고
공통 지침의 보고 항목에 더해: 자동 시작 항목의 `detail` 모양, 0016이 다시 만든 트리거 · 색인 목록, 시작 근거 대조의 경우별 결과 표, 멱등을 지키는 방법, 고친 시나리오 · e2e 목록, 뒤 이슈(M7-08 · 09 · 12 · 14 · 17)에 넘길 사실.
