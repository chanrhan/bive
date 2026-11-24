# M7 이슈 사이의 전달 사항 (조율자가 브리핑에 넣는다)

## M7-01(#213, PR #234, main f582e40)이 만든 것
- 마이그레이션 `project/0012_confirmations`: `approval_log.action` CHECK에 `confirm` · `rule_edit` · `contract_edit`(편집 행동은 diff 필수). 표 `confirmations(entity, target_id, state, confirmed_at, confirmed_by, basis)`: 행이 없으면 미확인, 엔터티는 Requirement · Rule뿐.
- `ProjectStore.confirmations`(`get`, `confirm(target, {by: HumanAuthor, at, basis})`), 오케스트레이터 `confirmations/confirmation-service.ts`, RPC `confirmation.set`.
- `Requirement` · `Rule`에 필수 필드 `confirmation`. `requirement.*` · `rule.*` · `proposal.approve` · `verification.summary` 응답에 실림.
- 사람의 `requirement.create` · `update`, 사람의 제안 승인 = 같은 트랜잭션에서 확인됨.

## [전달] 뒤 이슈가 알아야 할 것 (#234 검토에서)
- 구조 시험(`orchestrator/test/integrity.test.ts` "확인됨을 쓰는 경로…")이 engine · steps · agent · tools · rule-writer · test-writer · implementer · judge · runs 아홉 디렉터리에서 `/confirm/i` 글자 자체를 금지한다(주석 포함). `.confirmations` 접근 허용 목록은 `confirmations/confirmation-service.ts` 하나, 그 모듈을 가져올 수 있는 곳은 `ipc/confirmation-handlers.ts` · `ipc/requirement-handlers.ts` · `proposals/proposal-service.ts` 셋.
- M7-13: 확인 풀림(미확인으로 되돌리는 쓰기)은 오케스트레이터 경로에서 일어나므로 confirm과 unconfirm을 구분해 구조 시험을 의도적으로 고쳐야 한다. DB는 상태 값 UPDATE를 허용하고 CHECK가 시각 · 주체 · 근거를 함께 NULL로 만들게 강제한다(앞선 확인의 근거가 행에서 사라짐: 이력은 규범 변경 기록에). `ConfirmationRepository.confirm`은 이미 확인됨인 행을 UPDATE로 덮어쓴다(이미 확인됨 → -32009는 RPC에만 있음).
- M7-03: `rule.update` 사람 편집을 확인됨으로 만들려면 confirmation-service에 함수를 더하고 `ipc/rule-handlers.ts`를 구조 시험의 가져오기 목록에 넣는다. 근거 종류는 `approval_log`(`rule_edit` 순번).
- M7-02: 에이전트 규칙의 바로 반영은 `rules.create`만 하면 미확인이 된다(확인 서비스에 닿지 않게).
- M7-14 · M7-15: 이미 확인됨 · 삭제된 대상의 `confirmation.set`은 -32009. `confirmation.set`은 렌더러에서 부를 수 있다.
- 공통: `confirmation.set`의 `author`는 요청 본문 값이다(파이프 토큰 인증 위에서 `proposal.approve` · `run.create`와 같은 수준). ADR-100 무결성 표의 "위조된 사람 RPC"(#117) 한계는 그대로.

## [후속] 후보 (M7 마무리 문서 또는 뒤 이슈에)
- 구조 시험이 다른 디렉터리의 날 SQL(`INSERT INTO confirmations`)을 놓침 → `/\bconfirmations\b/`를 src 전체에(M7-13에서 구조 시험을 고칠 때 함께).
- `ApprovalLogEntry.appliedRef`를 승인 행동에만 허용.
- DB CHECK가 읽기 스키마보다 느슨(`$.kind`만 봄) → ADR-101 한계에 한 줄.
- 규칙 행 물리 삭제 시 고아 확인 행(지금은 소프트 삭제만).
- 사람이 쓰고 마지막 수정 주체가 에이전트인 요구사항의 이행 근거가 작성 기록을 가리킴.
- M3-04(#49): 계약 '등록'에 쓸 `approval_log.action` 값이 없다(M7-01은 확인 · 규칙 편집 · 계약 편집만) → 구현 때 계약 편집 값을 쓸지 새 값 + ADR인지 정한다.

## M7-02(#214, PR #236)가 만든 것 (머지 뒤 확정)
- 마이그레이션 `project/0013_norm_changes`: 표 `norm_changes(seq, at, kind, actor, target_ref, session_id, run_id, reason, detail, prev_hash, hash)`. 주체는 에이전트 역할 또는 오케스트레이터만. 에이전트 주체는 세션 ID · 사유 필수. 추가 전용. 종류 9개: `created` · `updated` · `retired` · `superseded` · `judgment` · `objection` · `unconfirmed` · `auto_start` · `test_changed`(이 PR은 `created`만 씀).
- 해시 체인 접두 `bive-norm-change-v1\n`. `verifyNormWatch`가 깨진 체인을 `norm_change_chain_broken`으로 보고.
- RPC `normChange.list {projectId, targetRef?}` → `{entries, chain}`. 문자열은 표시 값(상한 4000, `textTruncated`), 저장 · 해시는 원문.
- `norms/agent-rule.ts`의 `createAgentRule`: 규칙(기존 `normState: 'approved'`를 효력으로, 확인 상태 미확인) + `created` 항목을 트랜잭션 1개로. 도구 이름은 `propose_rule` 그대로(바로 반영). 제품 코드에서 제안을 등록하는 곳은 없음. 승인 단계 · 화면은 바뀌지 않음.

## [전달] (#236 구현자 · 검토에서)
- 구조 시험이 `.normChanges.append(`는 `norms/agent-rule.ts`, `.rules.create(`는 `norms/agent-rule.ts` · `proposals/proposal-service.ts`로 고정한다. 뒤 이슈는 그 목록을 의도적으로 갱신한다. 규범을 쓰는 도구 목록은 제품 `NORM_TOOL_NAMES`와 시험 `NORM_WRITE_TOOLS`(M7-09는 `retire_rule` · `supersede_rule`을 더한다).
- `NormChangeDetail`은 `strictObject({before?, after?})`다. 원인 규범 변경 기록 ID · 바뀐 파일 같은 칸은 그 이슈가 스키마를 넓힌다. `verify()`는 체인 검증 때 지금 스키마로 형식도 보므로, 뒤에서 `superRefine`을 조이면 옛 행이 `malformed`가 되어 체인이 깨질 수 있다(넓히기만 한다).
- "원인 규범 변경 기록 ID"는 정수 `seq`다. `EntityRef`(ULID)로는 가리킬 수 없으니 `detail` 칸에 둔다. `detail`에는 JSON으로 왕복해도 값이 같은 것만 넣는다(`Date` 객체 금지). `run_id` · `session_id`는 외래 키가 아니다.
- 종류별 쓰임: `auto_start` = M7-05(주체 오케스트레이터, `target_ref` = 실행), `judgment` = M7-07 · 11 · 12, `retired` · `superseded` = M7-09, `objection` = M7-11(구현 역할 주체라 세션 ID · 사유 필수), `unconfirmed` · `test_changed` = M7-13.
- **화면 공백(M7-14 · M7-15에 넣을 것)**: 제안 알림과 할 일 배지가 사라져 사람이 새 규칙을 알아차릴 계기가 줄었다. 규칙 화면(`useRules`)은 들어올 때와 실행 알림 때만 다시 읽고, 요구사항 상세의 자식 규칙 목록(`useChildRules`)은 규칙 작성 세션이 끝나도 다시 들어오기 전까지 갱신되지 않는다. 규칙 생성 알림이 없다.
- 요구사항의 둘째 규칙도 효력이 있다(인수 테스트 폴더가 없으면 검사 단계에서 판정되지 않음). 규칙 작성 서비스는 `ProposalService`를 더 받지 않는다(M7-04가 예산 검사를 넣을 때 참고).
- 끝 항목 삭제는 체인만으로 못 잡는다(승인 기록과 같은 성질). "에이전트가 만든 규칙마다 `created` 항목이 있는지" 대조는 M7-13 후보(제안 승인으로 생긴 규칙은 대조에서 뺀다).

## [후속] 후보 추가
- 구조 시험이 날 SQL(`INSERT INTO rules`)과 별칭(`const r = store.rules; r.create(`)을 놓침 → M7-13에서 구조 시험을 고칠 때 `\brules\b` · `\bnorm_changes\b` 날 SQL 검사도.
- `approval_log.actor`의 DB CHECK가 `json_valid`만 봄(표 재구성 필요).
- 시나리오 YAML의 최종 메시지 문구가 옛 표현("규칙 제안 N건을 등록했습니다").

## M7-04(#216, PR #237, main b5590b6)가 만든 것
- 설정 본문 JSON `dailyBudgetUsd`(0 이상 수 또는 `null`). 비움 = 한도 없음(자동 시작만 안 함), `0` = 그날 새 에이전트 세션을 모두 막음. `settings.update`는 사람 주체만.
- 마이그레이션 `project/0014_rule_writer_daily_budget_skip`(`rule_writer_requests` 재구성, 생략 사유 `project_daily_budget_exceeded`).
- `orchestrator/src/settings/project-budget.ts`: `projectDailyBudget(store, settings, now)` · `dailyBudgetReached`. 원천은 저장된 `sessions` 행, 경계는 기기 로컬 날짜, 세션은 시작한 날에 셈.
- 세션 USD 한도 = min(역할 잔여, 실행 잔여, 프로젝트 하루 잔여)(`sessionLimits` 넷째 인자). 실행은 `budget_exceeded` + `failureReason: project_daily_budget_exceeded`로 끝남.
- **M7-05가 부를 것**: `settings/settings-service.ts`의 `validateSettingsForAutoStart(settings, roles?)` → `{ok:true, dailyBudgetUsd}` | `{ok:false, dailyBudgetUnset, missing}`. 오늘 지출이 한도에 이르렀는지는 이 함수가 보지 않는다(세션을 열 때 엔진이 막음). 미리 보려면 `projectDailyBudget` + `dailyBudgetReached`.
- [전달] `run.create`는 한도에 이른 날에도 실행을 만들고 막는 것은 첫 세션이다. **M7-05: ADR-100 A12는 한도에 이르면 자동 시작 실행이 생기지 않는다고 하므로, 자동 시작 직전에 `projectDailyBudget` + `dailyBudgetReached`로 확인해 생략해야 한다.** 진행 중 세션은 넘긴 한도 전부로 센다(예약: 겹쳐 도는 세션의 한도 합 + 끝난 지출 ≤ 하루 한도. 남는 넘침은 세션마다 SDK 한도 판정의 한 턴 분량). 규칙 작성 세션이 도는 동안의 실행은 그 세션 한도만큼 덜 받는다. 세션이 도중에 죽으면 재기동 복구가 닫을 때까지 그 한도가 묶인다. 규칙 작성 세션은 세션 행 저장에 실패하면 세션을 열지 않는다. 진행 중 세션의 집계 초과로는 실행을 멈추지 않는다.

## M7-06(#218, PR #238)이 만든 것 (머지 뒤 확정)
- 실행 상태 `queued`("실행 대기"). 전이 `waiting_approval → running | queued`, `queued → running | failed`.
- 마이그레이션 `project/0015_run_queue`(#237이 0014를 써서 0015로 올림): `runs` 재구성, `steps` 트리거 2개 재생성, 새 트리거 `runs_one_running_insert` · `runs_one_running_update`. 러너에 `disableForeignKeys` 선택. `started_by` CHECK는 넓히지 않음(M7-05가 넓힌다).
- 대기 진입은 승인 단계 통과 트랜잭션에서. 자리를 차지하는 것은 `running` · `interrupted`. 깨우는 종료 상태는 `merged` · `failed` · `budget_exceeded`. 순서는 표시 ID. `startNextQueuedRun`(`runs/run-service.ts`), 엔진 `#advanceQueue`, 기동 때 `engine.startQueuedRuns()`.
- 워크트리 · 브랜치 · `baseCommit`은 시작 때, 예산 · 모델 스냅샷은 생성 때.
- **[전달] M7-05**: 자동 시작 실행도 `createRun`과 같은 모양(`waiting_approval`, 승인 단계 진행 중)으로 저장한 뒤 `engine.onRunCreated(projectId, runId)`(또는 `evaluateApproval`)를 부르면 대기열 규칙이 자동으로 적용된다. `runs.started_by` CHECK를 넓히는 재구성이 필요하고, 0014처럼 `disableForeignKeys: true`를 쓰며 `steps` 트리거 2개와 `runs_one_running_*` 트리거 2개도 같은 글자로 다시 만들어야 한다. 대기에서 시작하는 실행도 `#prepare`의 `run_start` 대조를 지난다.
- 한계: `interrupted`가 자리를 지켜 사람이 [재개]할 때까지 그 프로젝트의 대기가 멈춘다. 대기 · 진행 중 · 중단된 실행의 취소 경로 없음. SCR-05는 최근 실행 하나만 보인다. `run.create` 응답의 상태는 `waiting_approval`이고 대기 여부는 알림으로.

## M7-06 (#218, PR #238) 병합 뒤 확정 사실 (main ae03101, ADR-105, 마이그레이션 0015)
- [전달] 상태 기계: `interrupted → running | failed | merged`. `interrupted → merged`는 `#failUnresumable` → `runEnding()` 한 경로에서만 쓴다(병합 커밋이 기록된 실행만).
- [전달] 종료 상태는 `runEnding()` 한 곳에서 정한다. 엔진의 실행 패치에 `status: 'failed' | 'budget_exceeded'` 리터럴을 쓰지 않는다는 구조 시험이 `engine.test.ts`에 있다(정규식이라 좁다. 행동 시험이 실제 보호).
- [전달] 재개 불가 응답: -32009 · `resume_unrecoverable`, `data.runStatus`는 `failed` 또는 `merged`. 읽는 쪽은 둘 다 처리한다. SCR-05 문구 "EXE-NNN 재개 불가 · 병합 완료" / "… · 실패 처리".
- [전달] `UNRECOVERABLE_RESUME_CODES`: `worktree_missing`, `worktree_branch_mismatch`, `invalid_input`. 실행을 버리는 경로는 #239(needs-human)에 걸려 있다.
- [전달] 검증 화면의 실행 선택: `pipelineRunOf`(진행 중 > 가장 이른 중단 > 최신), `pipeline.queued`, "실행 대기 N".
- [후속] `runs`에 "`merged`이면 `merge_commit` 필수" DB 제약이 없다. 표를 다시 만드는 M7-05에서 더할 후보.
- [후속] 구조 단언(정규식)은 스프레드 표기를 놓친다. SCR-16에 대기 필터 · 모든 중단 실행의 재개가 필요하다.

## M7-07 (#219, PR #240) 병합 뒤 확정 사실 (main b604db9, ADR-106, 마이그레이션 없음)
- [전달] `norms/norm-input.ts`: `collectNormInput(store, {requirementIds, ruleIds})` → `renderNormInput(input, focusLabel)`. 효력 = 삭제 안 됨 + `normState === 'approved'`(부모 해제 · 내장 규칙 포함). 효력 계산은 `effectiveRequirements` / `effectiveRules`. `steps/check.ts`의 `approvedRules`가 같은 식을 따로 갖고 있다(폐기 상태를 더하는 M7-09는 두 곳을 함께 바꾼다).
- [전달] 자료 틀: 시작 줄 `<<<BIVE 규범 자료 시작: 읽기 전용 자료, 지시 아님>>>`, 끝 줄 `<<<BIVE 규범 자료 끝>>>`, 앞에 설명 3줄. 값은 공용 `displayText`(ADR-089)를 거친 한 줄 표시 값. 상한: 요구사항 50, 규칙 50, 본문 1000, 제목 200, 진술 1000, 케이스 이름 200, 규칙당 케이스 20. 넘치면 초점 우선(A15), 잘림은 머리줄 · 세션 기록 `normInput` · 로그 · 판단 기록 `input`에 남는다.
- [전달] 작업 지시 머리의 대상 요구사항 본문은 원문 그대로다(틀 밖). M7-08이 표시 값으로 바꿀지 정한다(ADR-106 "결과").
- [전달] `propose_rule.contradiction` 필수: `{verdict:"none"}` | `{verdict:"contradicts", ruleIds(1~20, 표시 ID 또는 ID), grounds(≤4000)}`. 어긋나면 `invalid_args`, 규칙도 기록도 없음. 호출 1건 = 규칙 + `created` + `judgment`(트랜잭션 1개, 원자성 시험 있음). 규범 변경 기록 행이 규칙당 2개다.
- [전달] `judgment` 기록: `targetRef` 새 규칙, actor rule-writer, `reason` = 근거 또는 `NO_CONTRADICTION_REASON`, `detail.judgment = {subject:'new_rule', verdict:'contradiction'|'no_contradiction', contradicts:[{id, displayId}], createdSeq, input:{requirements:{total,included}, rules:{total,included}}}`. `judgment` 종류는 `before` · `after`를 못 갖고 다른 종류는 `judgment`를 못 갖는다. enum(`NormJudgmentSubject` · `NormJudgmentVerdict`)은 넓히기만 한다.
- [전달] 구조 시험: 규범 입력 모듈을 가져오는 곳은 `norms/agent-rule.ts`, `rule-writer/prompts.ts`, `rule-writer/rule-writer-service.ts` 세 개(정규식 `from '…norm-input.js'`). M7-08은 이 목록을 의도적으로 늘린다.
- [전달] 세션 기록의 `normInput`은 메모리에만 있다(`sessions` 표에 칸 없음). 저장과 `run.get` 노출은 M7-08 몫(마이그레이션 필요).
- [전달] 시나리오 `contradiction-noted.yaml`(규칙 작성 세션만, 둘째 요구사항에서 RULE-001과 모순 기록, 새 규칙은 그대로 생김). `contradiction`(M7-09) · `contradiction-missed`(M7-12)는 아직 없다.
- [후속] 구조 시험 정규식이 동적 import · 큰따옴표 · `export … from`을 놓친다. 규칙 작성 세션이 겹치면 서로의 새 규칙을 입력으로 못 본다. 시나리오 마지막 메시지 문구가 옛 표현.

## M7-05 (#217, PR #241) 병합 뒤 확정 사실 (main 8935a73, ADR-107, 마이그레이션 0016)
- [전달] 자동 시작: `runs/auto-start.ts`의 `autoStartRun`. 규칙 작성 세션이 **정상 종료**하면 `RuleWriterService` 옵션 `onSessionEnded`(종료 기록 저장 뒤, 끝남 알림 전) → `orchestrator.ts` → `AutoStarter`가 부른다. 지금은 세션이 만든 규칙 전부로 실행 1개(M7-19가 규칙마다 1개로 바꾼다, ADR-110). 실행 저장과 `auto_start` 항목은 트랜잭션 1개(원자성 시험 있음).
- [전달] `auto_start` 기록: `actor {kind:'orchestrator'}`, `targetRef {entity:'Run', id}`, `runId` = 실행, `sessionId: null`, `detail {causeSeqs: [created 순번…], ruleIds: [대상 규칙…]}`(같은 순서 · 같은 수). 실행의 `startedBy`는 `{kind:'human'}` 또는 `{kind:'orchestrator', causeSeqs}`(`RunStarter`).
- [전달] 멱등: 같은 원인 순번의 `auto_start`가 있거나 그 세션의 생략 기록이 있으면 `duplicate`. 엔진 대조의 `cause_reused`가 한 번 더 막는다.
- [전달] 생략: 하루 한도 비움 · 설정 미비 · 오늘 지출이 한도에 이름이면 실행을 만들지 않고 새 표 `auto_start_skips`(append-only 트리거 3개)에 남긴다. `ruleWriter.status` 항목에 `autoStart`(필수 칸, `skipped` · `started` · `null`)가 생겼다. 앱의 가짜 응답에도 필요하다. 생략 사유 enum `AutoStartSkipReason`, 표시명은 shared와 앱 양쪽(시험이 대조).
- [전달] 시작 근거 대조: `engine/start-basis.ts`. 사람 `run_start` 1건 또는 `auto_start` 1건이 아니면 `run_without_log`. `mismatch` 7종(`no_entry` · `multiple_entries` · `both_entries` · `starter_mismatch` · `rules_mismatch` · `cause_mismatch` · `cause_reused`), `exitDetail.detail = {runStartEntries, autoStartEntries, mismatch}`. 원인은 대상 규칙의 `kind === 'created'` 순번만 받는다(`judgment` 순번은 거부). 원인 종류를 넓히려면 `creationsOf`와 `start-basis.ts`를 함께 바꾼다.
- [전달] 승인 단계 자리는 효력 확인이다. 사람을 기다리지 않는다. 효력 없는 대상 규칙이면 `waiting_approval → failed`(`target_rule_unavailable`, `exitDetail {reason, unavailableRuleIds}`, `runEnding()` 경유). `waiting_approval`은 "생성 직후, 판정 전"의 짧은 순간만 뜻한다. 기동 때 `startQueuedRuns`가 남은 `waiting_approval`(사람이 만든 것 포함)을 생성 순으로 판정한다.
- [전달] 효력 판정이 세 곳에 따로 있다: `runs/run-service.ts`의 `unapprovedTargets`, `steps/check.ts`의 `approvedRules`, `norms/norm-input.ts`의 `effectiveRules`. 폐기 상태를 더하는 M7-09는 셋을 함께 바꾼다.
- [전달] `saveNewRun`(`runs/run-service.ts`)이 실행 저장 모양을 한 곳에서 정한다.
- [전달] 마이그레이션 0016이 다시 만든 것: 색인 `runs_status`, 트리거 `runs_no_replace` · `runs_identity_immutable` · `runs_terminal_final` · `runs_no_delete` · `runs_one_running_insert` · `runs_one_running_update` · `steps_run_terminal_insert` · `steps_final`. `runs`를 또 재구성하면 이 여덟 개를 빠짐없이 다시 만든다. `started_by` CHECK는 원인 목록의 첫 원소만 본다(읽기 스키마 `Run.parse`가 나머지를 막는다).
- [전달] e2e: 시나리오 `auto-start.yaml`(규칙 1개). `harness.saveRequirement`의 기본은 '생략(하루 한도 비움)을 단언하고 실행 수가 늘지 않음'이다. 자동 시작을 쓰려면 `settings.update {dailyBudgetUsd}`와 `{autoStart:'started'}`를 준다. 가짜 시나리오의 테스트 작성 세션은 `{{ruleId}}`(첫 대상 규칙) 폴더에만 쓴다. `happy-path` · `pause-implement` 시나리오는 규칙 2개를 만들고 둘째는 이미 통과하는 동작이다.
- [전달] 구조 시험: `.normChanges.append(` 허용에 `runs/auto-start.ts` 추가, `.normChanges.` 읽기 허용에 `engine/start-basis.ts` · `ipc/rule-writer-handlers.ts` · `runs/auto-start.ts`. "엔진 · 단계 · 실행 · 판정 · 도구 · 에이전트는 rule-writer-service를 가져오지 않는다", "`ruleWriter?.start|retry`는 `ipc/requirement-handlers.ts`만"(M7-11 · 12가 엔진에서 규칙 작성 세션을 띄우면 의도적으로 고친다. 그때 연쇄 경로가 처음 생긴다).
- [전달] `docs/architecture.md`는 동작을 바꾸는 PR마다 함께 고친다(이 PR 검토의 차단 지적이었다).
- [후속] 대기 중인 자동 시작 실행은 시작 때 하루 한도를 다시 보지 않는다(M7-19가 고친다). 상태 줄 생략 경고가 한도를 채운 뒤에도 남는다(M7-14). 자동 시작 성공 알림이 따로 없다(M7-14). 변조된 `runs` 행 하나가 `runs.list` 전체를 던지게 한다(저장소 밖 변조). "`merged`이면 `merge_commit` 필수" DB 제약은 미적용(`test-writer.test.ts` 병합 대역이 병합 커밋 없이 `merged`).

## M7-08 (#220, PR #246) 병합 뒤 확정 사실 (main fe393f4, ADR-108, 마이그레이션 0017)
- [전달] 세 역할(규칙 작성 · 테스트 작성 · 구현)의 작업 지시가 같은 틀(`renderNormInput`)로 효력 있는 규범을 받는다. 초점은 실행의 대상 규칙, 대상과 그 부모에 `(이번 작업 대상)`(`NORM_INPUT_FOCUS_LABEL`).
- [전달] 작업 지시 머리의 글도 표시 값이다: `taskHeaderText`(한 줄, 상한 `TASK_HEADER_LIMITS`: 본문 16000 · 제목 1000 · 진술 8000 · 위치 1024 · 사유 한 줄 4000), 앞 시도의 사유는 `indentedText`(줄마다 표시 값 + 두 칸 들여쓰기). 새로 작업 지시에 글을 넣는 이슈(M7-11 이의 제기, M7-12 모순 판단)는 이 둘을 쓴다. 날 원문을 넣지 않는다.
- [전달] 테스트 작성 역할의 세션 디렉터리 허용 입력(`test-writer/inputs.ts`)은 그대로다. 진술 원문은 `rules/<ID>.md` 파일로 받는다.
- [전달] 세션 기록: `sessions.norm_input`(JSON 객체, 트리거 `sessions_norm_input_immutable`로 변경 불가, 세션 행을 만들 때 함께 쓴다). 모양 `SessionNormInput = {summary:{requirements:{total,included,omitted}, rules:{total,included,omitted}, truncated}, requirementDisplayIds, ruleDisplayIds}`(`strictObject`. 넓힐 때는 선택 칸으로). 규칙 작성 세션도 같은 칸에 저장하지만 RPC로 내보내지 않는다(M7-14 몫. 그 저장을 단언하는 시험이 아직 없다. M7-14가 더한다).
- [전달] `run.get` 결과에 `sessions: [{id, stepId, role, startedAt, endedAt, endReason, normInput}]`(시작 순). 앱 e2e의 가짜 `run.get` 응답(`packages/app/e2e/scr-03.spec.ts`)에는 `sessions`가 없다(화면이 읽게 되면 더한다).
- [전달] 새 세션을 열기 직전마다 규범을 다시 읽는다(같은 실행의 테스트 작성과 구현이 서로 다른 규범을 볼 수 있다).
- [전달] 규범 입력 모듈을 가져오는 곳은 7개 파일(구조 시험 목록): `norms/agent-rule.ts`, `rule-writer/prompts.ts`, `rule-writer/rule-writer-service.ts`, `test-writer/prompts.ts`, `implementer/prompts.ts`, `steps/test-writing.ts`, `steps/implementation.ts`.
- [전달] 시나리오 `norm-input.yaml`(요구사항마다 규칙 1개, 규칙 작성 세션은 `requirementDisplayId`로, 실행 안 세션은 `when.ruleId`로 고름), e2e `norm-input.test.ts`는 `ci.yml`의 `PIPELINE_E2E_GROUP1`. 묶음 시간: 묶음 1 약 9분, 묶음 2 약 14분(제한 30분).
- [후속] 머리 글이 16000(표시 값 기준)에서 잘려도 기록이 없다(ADR-108 문장 정정 필요). 테스트 작성 재시도의 다시 읽기를 단언하는 시험 없음. 케이스 이름이 실행 값(`it.each` 등)으로 만들어지면 구현 코드가 만든 글이 뒤 실행의 작업 지시에 들어갈 수 있다(틀 안, 표시 값). 대상 규칙이 50개를 넘는 사람 [실행]은 자료에서 대상 일부가 빠진다. 변조된 `sessions.norm_input` 행 하나가 `run.get` · 하루 예산 합산 · 재기동 복구를 던지게 한다(저장소 밖 변조).

## M7-19 (#244, PR #247) 병합 뒤 확정 사실 (main b425125, ADR-110 · ADR-111, 마이그레이션 없음)
- [전달] 자동 시작은 규칙마다 실행 1개다(사람 결정 ADR-110). `autoStartRun`이 세션의 `created` 기록 N건에 대해 실행 N개 · `auto_start` 항목 N건(실행마다 대상 규칙 1개 · 원인 1건)을 쓰기 트랜잭션 1개로 만든다. 결과 `{status:'started', runs:[…]}` | `{status:'duplicate', runIds}` | 생략. 엔진 호출(`onRunCreated`)은 커밋 뒤 만든 순서대로. 첫 실행이 진행 중, 나머지는 실행 대기.
- [전달] 멱등: 원인 순번 중 하나라도 쓴 `auto_start`가 있으면 아무것도 만들지 않는다(일부만 쓰인 상태에서도 채우지 않는다).
- [전달] 시작 근거 대조에 `not_single_rule` 추가: 오케스트레이터가 시작한 실행은 대상 규칙 1개 · 원인 1건이어야 한다. DB CHECK와 읽기 스키마는 1개 이상을 받는다(엔진 대조만 강제). 사람 [실행]은 규칙 여러 개를 한 실행으로 받는다.
- [전달] 시작 때 하루 한도 재확인: `settings/auto-start-gate.ts`의 `autoStartBlock`(비움 → 설정 미비 → 한도에 이름). 오케스트레이터가 시작한 실행에만 적용. `evaluateApprovalStep`은 문에 걸리면 `queued`로 두고, `startNextQueuedRun`이 차례에 문에 걸린 실행을 `runEnding()`으로 끝낸다(작업 폴더 · 브랜치 없음). 종료: 한도에 이름 → `budget_exceeded` · `project_daily_budget_exceeded`, 비움 → `failed` · `project_daily_budget_unset`, 설정 미비 → `failed` · `settings_incomplete`. 전이 `queued → budget_exceeded` 추가. 끝난 실행은 되살리지 않는다.
- [전달] `runEnding`은 `engine/run-ending.ts`에 있다(`pipeline-engine.ts`가 다시 내보냄). 종료 리터럴 구조 시험은 `pipeline-engine.ts`와 `run-service.ts`를 본다.
- [전달] e2e: `auto-start-per-rule.test.ts`(묶음 1). `harness.saveRequirement(…, {autoStart:'started'})`는 실행 수가 규칙 수만큼 늘어남을 단언하고 첫 규칙의 실행을 돌려준다. CI 묶음 1은 약 15분, 묶음 2는 약 9분(제한 30분). 새 e2e는 묶음 2에 두는 쪽이 균형이 맞는다(`ci.yml`의 `PIPELINE_E2E_GROUP1` 목록에 넣지 않으면 묶음 2다).
- [전달] 상태 줄의 `autoStart.started`는 첫 실행만 싣는다(앱은 `skipped`일 때만 그린다).
- [후속] 종료 리터럴 구조 시험이 `status: 식` 형태를 못 잡는다. 생성 뒤 판정이 예외로 끝나면 같은 세션의 뒤 실행이 먼저 진행 중이 될 수 있다. 대기에서 끝난 자동 시작 실행의 화면 알림 없음(M7-14).

## M7-03 (#215, PR #248) 병합 뒤 확정 사실 (main 931502f, ADR-109, 마이그레이션 없음)
- [전달] RPC `rule.update {projectId, id, author, title?, statement?, expectedUpdatedAt?}` → `{rule, judgment, approvalLog, autoStart}`. 사람 주체만(-32020은 저장소를 열기 전). 처리기는 `ipc/rule-handlers.ts`. 오류: -32602, -32004, -32009(`rule_deleted` · `builtin_rule` · `rule_not_effective` · `rule_changed`), -32001(`RULE_EDIT_NO_CHANGE` · `RULE_EDIT_INVALID`: 제목 한 줄 · 앞뒤 공백(유니코드 공백 포함) 금지 · 200자, 진술 4000자 · EARS. 바뀐 칸만 검사).
- [전달] 편집 · 승인 기록 · 확인됨이 트랜잭션 1개. 승인 기록: `{action:'rule_edit', actor:{kind:'human'}, targetRef:{entity:'Rule', id}, detail:{diff:{before:{title,statement}, after:{title,statement}}}}`. 확인 근거 `{kind:'approval_log', seq}`. 이미 확인됨인 규칙을 고치면 확인 행을 갱신해 근거가 새 편집 순번이 된다. `approvalLog.list`는 diff를 원문으로 내보낸다(화면에 그릴 때 표시 값으로 거친다).
- [전달] 내장 구조 규칙은 사람 편집도 거부한다(`builtin_rule`), 화면에 [편집] 없음.
- [전달] 진술이 바뀌면 자동 시작: `runs/rule-edit-start.ts`(가져오는 곳은 `orchestrator.ts`뿐). 원인은 승인 기록 `rule_edit` 1건. `auto_start.detail.ruleEditSeqs`에 싣는다(`causeSeqs`와 다른 칸). 실행의 `startedBy`는 `{kind:'orchestrator', causeSeqs:[편집 순번], causeLog:'approval_log'}`. **`startedBy.causeSeqs`는 `causeLog`에 따라 다른 기록의 순번이다. 새로 읽는 코드는 `causeLog`를 반드시 본다.** `engine/start-basis.ts`에 분기 하나와 `ruleEditMismatch`.
- [전달] 조건: 제목만 바뀌면 실행 없음. 그 규칙이 대상인 승인 대기 · 실행 대기 실행이 있으면 새로 만들지 않고 `pending`. 진행 중 · 중단 실행만 있으면 새 실행을 대기에 세움. 생략은 응답으로만(기록 없음). 하루 한도 문은 만들 때와 시작 때 모두 적용.
- [전달] 효력 검사가 두 곳 더 생겼다: `ipc/rule-handlers.ts`(`normState !== 'approved'` → `rule_not_effective`)와 `runs/rule-edit-start.ts`. 화면의 `canEditRule`도 같은 식이다. 폐기 상태를 더하는 M7-09는 기존 세 곳(`unapprovedTargets` · `approvedRules` · `effectiveRules`)과 함께 이 세 곳도 바꾼다.
- [전달] 구조 시험: `.rules.update(`는 `ipc/rule-handlers.ts`만. `action: 'rule_edit'` 쓰기도 그 처리기만. 확인 서비스를 가져오는 곳이 넷(`ipc/rule-handlers.ts` 추가). `.normChanges.append(` · `saveNewRun(` · `'auto_start'` 허용 목록에 `runs/rule-edit-start.ts` 추가. `proposal-guard.test.ts` · `protocol.test.ts`는 "규칙 쓰기 RPC는 `rule.update` 하나"를 단언한다(새 규칙 쓰기 RPC를 더하면 이 단언을 의도적으로 고친다).
- [전달] 화면: 규칙 상세 머리줄이 줄을 바꿀 수 있다(좁은 창에서 제목 한 줄, 다음 줄에 ID · 판정 · [편집] · [실행]). 속성 줄에 "확인 · 확인됨/미확인". `useRules` · `useChildRules`에 `replace`(편집 결과로 목록 항목 바꾸기, 버린 요청이 있으면 한 번 다시 읽음).
- [후속] 진술 편집 뒤 병합 전까지 판정 · 준수가 옛 테스트 기준인데 표시가 없다(M7-15). 규칙 상세의 제목 · 진술이 원문 렌더링이라 방향 제어 글자가 든 글이 다른 순서로 보인다(M7-15). 편집 뒤 자동 시작 생략은 기록이 없다(M7-14). `replace` 뒤 다시 읽기를 단언하는 시험 없음. 문구만 다듬은 진술 편집은 Red 확인을 넘지 못해 실패한 실행을 남긴다(M3-30).

## M7-09 (#221, PR #249) 병합 뒤 확정 사실 (main 49059af, ADR-112, 마이그레이션 0018)
- [전달] 폐기 저장: 새 표 `rule_retirements(rule_id PK→rules, retired_at, superseded_by→rules|NULL, norm_change_seq UNIQUE→norm_changes)`. 트리거 6개: 덮어쓰기 · 수정 · 삭제 거부(폐기는 되돌릴 수 없다), 없거나 삭제된 규칙 · `builtin = 1` 규칙 거부, 대체한 규칙이 삭제 · 폐기면 거부, 짝 기록(`retired` 또는 `superseded`, 같은 대상) 없으면 거부. `rules` 표와 `Rule` 스키마에는 폐기 칸이 없다(`store.ruleRetirements.get(ruleId)`로 읽는다. 접근은 `norms/agent-rule.ts` · `norms/effective.ts`에서만 한다는 구조 시험이 있다).
- [전달] 도구(규칙 작성 역할만): `retire_rule {ruleId, grounds}`, `supersede_rule {propose_rule의 칸 + ruleId, grounds}`(`contradiction`은 대상 밖 효력 규칙과의 판단, 필수). `ruleId`는 표시 ID · ID 둘 다. 거부: `invalid_args`(스키마, 대상 없음 · 삭제 · 이미 폐기 · 잠정, 인용 없음), `builtin_rule`(내장 규칙), `state_conflict` · `not_found`(부모 요구사항). 세션의 요구사항과 무관하게 내장이 아닌 어떤 효력 규칙이든 겨눌 수 있다(D5).
- [전달] 인용 검사(`norms/agent-rule.ts`의 `quotesRule`, `MIN_QUOTE_LENGTH = 10`): NFC · 연속 공백 한 칸 · 앞뒤 자름 뒤, 근거가 대상 규칙의 진술이나 최근 판정 케이스 이름과 연속 10 코드 포인트 이상 같아야 한다(원문과 표시 값 둘 다 대조). **지금은 사실상 아무것도 거르지 않는다**: `THE SYSTEM`(10자)이 모든 EARS 진술에 있어 그 두 낱말만으로 어떤 규칙이든 통과한다. 조율자 결정: M7-11(이의 제기)이 이 검사를 조인다(EARS 틀 글자를 빼고 세기 등).
- [전달] 한 트랜잭션의 쓰기. 대체: ① 새 규칙 ② `created` ③ `judgment`(`subject:'supersede'`, `verdict:'contradiction'`, `contradicts:[대체된 규칙, 대상 밖 규칙…]`, `createdSeq`, 사유는 근거) ④ `superseded`(대상은 옛 규칙, `detail.before` = 폐기 직전 내용, `detail.retirement:{supersededBy, createdSeq, judgmentSeq}`) ⑤ 폐기 행. 폐기: `retired`(`before`, `retirement:{supersededBy:null}`) → 폐기 행. 폐기 쪽 쓰기는 `writeRetirement` 한 함수(M7-13이 확인 풀림을 여기에 끼운다). `'retired'|'superseded'` 글자는 `agent-rule.ts`에만 있다는 구조 시험이 있다.
- [전달] 효력 판정은 `norms/effective.ts`의 `isEffectiveRule` 한 곳이다(`normState` 비교는 이 파일에만 있다는 구조 시험, 가져오는 9개 파일 고정). 쓰는 곳: 검사 · 병합 재검사 대상, 승인 단계 · 대기 재검사, 세 역할의 규범 입력, 준수 분모와 검증 화면 규칙 목록, `rule.list` 기본 결과, 엔진의 단계 사이 확인, `rule.update`(폐기면 -32009 `rule_not_effective`), `runs/rule-edit-start.ts`. `rule.get` · `judgment.list`는 폐기된 규칙도 돌려준다(판정 이력은 남는다). `rule.list`에 폐기 포함 옵션은 아직 없다(M7-15).
- [전달] 폐기된 규칙의 인수 테스트 폴더(`bive-acceptance/<RULE>/…`)는 지우지 않는다. 작업 트리와 main에 남고 검사 단계에서 `unjudgedDirs`로 빠진다(실행도 판정도 하지 않는다). 정리 경로는 없다. 폐기 규칙만 자식으로 남은 요구사항은 그대로 효력이고 화면에서는 자식 규칙이 없는 요구사항으로 보인다. 규칙 작성의 중복 방지는 폐기와 무관하게 "만든 규칙 있음"을 본다(폐기 규칙만 남은 요구사항은 다시 다루지 않는다).
- [전달] 대체는 새 규칙의 `created`를 남겨 기존 자동 시작 경로를 탄다(실행 1개, 유형 A). 폐기만이면 실행 없음. 같은 세션이 만든 규칙을 그 세션에서 폐기하면 실행이 생겼다가 승인 단계에서 `target_rule_unavailable`로 끝난다.
- [전달] 실행 도중 폐기: 엔진 `#prepare`가 병합 커밋 전 단계를 열 때마다 대상 규칙의 폐기를 확인해 그 단계 시도를 `failed`(`target_rule_retired`, `exitDetail.retiredRuleIds`는 표시 ID)로 닫고 `runEnding()`을 거친다. 병합 실행기는 `before_merge`와 `merge_recheck`에서 다시 확인한다. 정당한 폐기는 `guard_violation`을 일으키지 않는다. 남는 틈: 병합 실행 안에서 폐기되면 병합된다.
- [전달] 시나리오 `contradiction`(둘째 요구사항에서 RULE-001 대체, 요구사항마다 규칙 1개). 검토자가 임시 e2e로 끝까지 확인: EXE-001 merged → REQ-002 저장 → `rule.list`는 `["RULE-002"]` → EXE-002 merged(검사 `ruleIds:["RULE-002"]`, `unjudgedDirs:["RULE-001"]`) → 병합 수 2 → 규범 변경 기록 순서 `created, judgment, auto_start, created, judgment, superseded, auto_start` → 준수 1/1. M7-17의 `contradiction.test.ts`가 이 단언을 그대로 쓸 수 있다.
- [전달] 확인 상태는 건드리지 않았다. 확인됨 규칙을 폐기해도 확인 행이 그대로 남는다(M7-13이 푼다). `confirmation.set`은 삭제만 보므로 폐기된 규칙의 확인도 받을 것으로 보인다(M7-13이 정한다).
- [전달] 앱에는 실행 화면과 실패 사유를 그리는 곳이 아직 없다(`RUN_STATUS_TEXT`로 상태만). 규칙 화면에서 선택된 규칙이 폐기되면 목록에서 빠지고 상세는 빈 상태가 된다. `target_rule_retired` · `builtin_rule`의 화면 표시명이 없다(M7-14 · M7-15가 그릴 때 더한다).
- [후속] 0018의 대체 규칙 효력 확인이 `normState`를 보지 않는다 · 짝 기록의 `detail.retirement.supersededBy`를 행과 대조하지 않는다. 구조 시험이 글자 대조라 `.includes` · 대괄호 접근을 놓친다. 케이스 이름을 통한 주입 길(인수 테스트가 앱 코드를 import하면 구현 코드가 임의 이름의 케이스를 등록할 수 있다. 케이스 이름은 규칙 작성 세션의 규범 입력과 인용 원천이 된다). `docs/architecture.md`의 "rule-writer는 자기 요구사항의 규칙 제안만" 행 제목이 낡았다. ADR-112의 "실행 화면의 대상 규칙 표시 ID 조회" 문장(앱에 그 화면이 아직 없다).

## M7-13 (#225, PR #250) 병합 뒤 확정 사실 (main d2e2259, ADR-113, 마이그레이션 0019)
- [전달] 확인 풀림: 확인됨 규칙을 에이전트가 폐기 · 대체하면 같은 트랜잭션에서 확인 행이 `unconfirmed`가 되고(시각 · 주체 · 근거 NULL, 행은 지우지 않는다) 규범 변경 기록 `unconfirmed`(주체 오케스트레이터, `detail.unconfirm = {causeSeq, previous}`)가 남는다. `writeRetirement`의 쓰기 순서: 폐기 · 대체 기록 → 폐기 행 → 풀림 기록 → 확인 상태. **풀림 기록과 확인 상태 쓰기 사이에 다른 규범 변경 기록을 끼우면 0019가 거부한다. 이 순서를 유지한다.** 미확인 규칙의 폐기 · 대체에는 풀림 기록이 없다. 풀 수 있는 것은 확인 서비스의 `releaseConfirmation`뿐이고 `agent-rule.ts`만 부른다(구조 시험이 가져오는 이름까지 고정, 네임스페이스 · 동적 가져오기 금지).
- [전달] 0019의 트리거 3개: `norm_changes_unconfirmed`(주체 오케스트레이터 · 대상 규칙 · `causeSeq`가 같은 규칙의 `retired` · `superseded` · 그 규칙이 지금 확인됨 · 같은 원인의 풀림 없음), `norm_changes_test_changed`(주체 오케스트레이터 · 대상 규칙 · `run_id` 있음), `confirmations_release_recorded`(확인됨 → 미확인은 바로 앞 기록이 그 대상의 풀림 기록이고 `previous`가 지금 행과 짝이 맞을 때만). 풀림의 원인 종류를 넓히려면(에이전트가 규칙을 제자리에서 고치는 도구 등) 새 마이그레이션이 필요하다.
- [전달] 확인됨을 만드는 경로는 사람 RPC뿐이다(구조 시험). 폐기된 규칙도 사람이 [확인]할 수 있다(뜻은 "이 폐기를 봤다", 폐기는 그대로). **폐기된 규칙이 확인됨일 수 있다.** 사람 확인 기준의 집계(M7-16)는 폐기 규칙을 반드시 뺀다.
- [전달] `confirmation.set`의 승인 기록 `confirm` 항목은 `detail: {seenNormChangeSeq: N}`(그 순간 규범 변경 기록의 마지막 순번, 서버가 정한다. 요청으로 줄 수 없다)을 싣는다. 이 칸이 없는 옛 `confirm`은 0으로 읽는다. `rule.update` · 요구사항 작성 · 편집 · 옛 제안 승인의 승인 기록에는 이 칸이 없다.
- [전달] `confirmation.list {projectId}` → `{items, total, truncated}`. 종류 `ConfirmationItemKind` = `retired` · `superseded` · `test_changed` · `unconfirmed_norm`. 순서: ① 에이전트의 폐기 · 대체(확인 여부와 무관. 시각 최신순, 같으면 순번 큰 것 먼저. 칸 `before` · `after` · `grounds` · `rationale` · `released`. 확인 풀림은 따로 항목이 없고 `released`에 실린다. `after`는 대체 당시 새 규칙의 내용이다) ② 테스트 변경 ③ 미확인 요구사항 · 규칙(마지막 수정 시각 최신순. 삭제 · 폐기된 것은 빠진다. 대체로 생긴 새 규칙은 여기에 따로 나온다). 에이전트가 쓴 글은 표시 값(문자열마다 4000자, 잘리면 `textTruncated`). 200개까지, `total`은 자르기 전 수(배지 수로 정함. 지금 화면 배지 `proposal.count`는 아직 그대로다).
- [전달] 내려가는 조건: 항목은 사람이 그 대상을 [확인](`confirmation.set`)했을 때만 내려간다. ① · ②는 그 규칙의 `confirm` 가운데 `seenNormChangeSeq`가 그 기록의 순번 이상인 것이 있으면, ③은 확인됨이면 빠진다. **사람의 편집이나 확인 행의 시각으로는 내려가지 않는다**(조율자 결정). 한 번의 [확인]은 그 규칙에 그 순간까지 쌓인 ① · ② 항목을 함께 내린다(항목 하나만 내리는 길 없음. 화면이 본 순번을 요청에 싣는 방식은 M7-14가 정할 수 있다). 확인됨 규칙도 보지 않은 ① · ② 항목이 있으면 다시 [확인]을 받고, 없으면 -32009다. 폐기된 규칙의 테스트 변경 알림은 그 폐기 항목이 남아 있는 동안 숨고, 폐기를 확인한 뒤에 생긴 것은 ②에 나온다. 삭제된 대상의 항목은 빠진다.
- [전달] 테스트 변경 알림(G): 실행이 `merged`로 끝났을 때 `norms/test-change.ts`의 `TestChangeNotifier`가 한 번 쓴다(`orchestrator.ts`가 엔진의 `onEvent`를 `observeThenPublish`로 넘긴다. 엔진은 기다리지 않고, 실패하면 로그 한 줄). 기준: 실행의 `baseCommit..headCommit` 사이 대상 규칙 폴더의 `git diff --raw`에서 기준 커밋에 있던 파일의 내용 바뀜 · 지움(새 파일 · 같은 내용 · 모드만 바뀜 · 다른 규칙 폴더는 뺌). 확인됨 규칙에만, 실행 · 규칙마다 1건. 기록 `test_changed`: 주체 오케스트레이터, `runId`, `detail.testChange = {files:[{path, change: modified|removed}](1~100), fileCount, baseCommit, headCommit}`. **병합된 실행이 확인됨 규칙의 기존 테스트를 바꾸면 규범 변경 기록에 `test_changed`가 낀다. 기록 순서를 정확히 단언하는 시험(M7-17 등)은 이를 감안한다.** 사람의 진술 편집으로 시작된 실행도 대상이다.
- [전달] 구조 시험 허용 목록: 확인 서비스 가져오기에 `norms/agent-rule.ts`(이름 `releaseConfirmation`만), `.normChanges.`에 `confirmations/confirmation-list.ts` · `confirmations/confirmation-service.ts` · `norms/test-change.ts`, `.normChanges.append(`에 `norms/test-change.ts`, `'retired'|'superseded'` 글자에 목록 모듈(쓰기는 여전히 `agent-rule.ts`만), `effective.js` 가져오기에 목록 모듈. `/confirm/i` 금지 대상 파일은 그대로다.
- [전달] 앱은 아직 `confirmation.list`를 부르지 않는다(M7-14가 처음 쓴다. 가짜 응답도 없다).
- [후속] 오케스트레이터가 병합 저장과 알림 쓰기 사이에 죽으면 그 실행의 테스트 변경 알림이 빠지고 기동 때 되짚지 않는다. 목록은 호출마다 규범 변경 기록 전체를 읽는다. 사람이 폐기된 규칙을 지우면 그 폐기 항목이 빠진다. 0019 짝 검사의 `previous.at` 줄만 빼는 변이를 잡는 시험이 없다.

## M7-15 (#227, PR #251) 병합 뒤 확정 사실 (main 1dfcd41, ADR-114, 마이그레이션 없음)
- [전달] `rule.list {projectId, includeRetired?}`(읽기 전용. 없으면 폐기 규칙을 뺀다. 켜면 폐기 규칙이 표시 ID 순으로 섞여 온다). `rule.list` · `rule.get` 항목에 폐기된 규칙만 `retirement?: {retiredAt, supersededBy: {id, displayId} | null, normChangeSeq}`(shared `RuleRetirementView`, `RuleWithJudgment`의 선택 칸. 폐기 기록 행을 읽을 수 없으면 세 칸이 `null`). 읽는 함수 `listedRules` · `ruleRetirementView`는 `norms/effective.ts`. 엔진 · 규범 입력 · 준수 분모는 이 옵션과 무관하다.
- [전달] 렌더러의 숨은 글자 표기: `packages/app/src/renderer/src/components/VisibleText/visibleText.ts`의 `visibleText`(한 줄 표기)와 `visibleLines`(LF만 줄로 살리고 나머지는 표기). 오케스트레이터의 `displayText`와 같은 글자 범위(대조 시험 `app/test/visible-text.test.ts`가 오케스트레이터 소스를 경로로 가져와 비교). **에이전트가 쓴 글을 화면에 그릴 때는 이것을 쓴다.** 적용된 곳: 규칙 제목 · 진술(상세 · 카드 · 검색 대상 · 자식 규칙 줄), 케이스 이름, 실패 메시지, [실행] 확인 대화. 편집 입력은 원문. 아직 원문인 곳: SCR-05 규칙 제목(`VerificationScreen.tsx`, M7-16이 고친다), 요구사항 본문 · 부모 요구사항 줄, SCR-17 `ProposalDetail`. 서버가 표시 값으로 주는 응답(`normChange.list`, `confirmation.list`)은 다시 변환하지 않는다(이중 표기 금지).
- [전달] SCR-03: 카드 예외 순서는 판정 예외 → "폐기" → "미확인". 폐기된 규칙의 카드는 판정 배지 · 판정 예외 없이 "폐기"(+미확인). 칩 7종에 "확인"(미확인 · 확인됨). 준수 집계 칩 값: 판정 가능 · 사람 확인 · 격리. "사람 확인" = 판정 가능 ∩ 확인됨(폐기 · 효력 아님 제외), `rules/rulesView.ts`의 `complianceValues`. "폐기 포함" 토글은 `FilterState.includeHidden`(화면을 옮겨도 유지, [초기화]로 꺼짐). 검증 화면의 `COMPLIANCE_FILTER`는 지금 "판정 가능"만 쓴다(`includeHidden: false`).
- [전달] SCR-02: 예외 "미확인", 칩 "확인"(옛 "잠정" · "승인"은 이 세 화면에 없다).
- [전달] SCR-06 규칙 상세: [확인] 버튼(미확인 · 폐기 아님 · 편집 중 아님일 때만. `confirmation.set` 1회. 실패 문구는 -32009를 "이미 확인됨 또는 삭제된 규칙" 하나로 묶는다). 폐기된 규칙: 머리줄 "폐기", "대체 규칙 RULE-NNN" 링크, 폐기 시각, [편집] · [실행] · [확인] 없음. 변경 이력 묶음(`normChange.list {targetRef}`, 기본 접힘. 폐기 규칙과 검증 실패면 펼침. 종류 표시명 9종, 주체, 판단 · 대체 대상 링크, 사유 · 근거, 일부 생략). `unconfirmed` → "확인 풀림", `test_changed` → "테스트 변경"으로 보이지만 줄에 원인 기록 · 바뀐 파일은 없다. 폐기 규칙을 가리키는 링크(`onOpenRule`)는 [폐기 포함]을 켠다.
- [전달] 이 화면들은 규칙 작성 세션이 끝나거나 폐기가 일어나도 다시 읽지 않는다(규범 변경 알림이 없다. 실행 알림에만 다시 읽는다). M7-14가 알림과 다시 읽기를 맡는다. 확인됨 규칙 · 폐기된 규칙에는 [확인]이 없어, 서버가 받는 "다시 확인"(보지 않은 폐기 · 대체 · 테스트 변경이 있는 확인됨 규칙)과 "폐기를 봤다" 확인은 이 화면에서 할 수 없다. 그 버튼은 M7-14의 확인할 것 화면이 둔다.
- [전달] 앱 e2e의 가짜 데이터(`e2e/checklists/` 등)를 여러 spec이 함께 쓴다. 고치면 `reconnect` · `run-start` · `scr-05` · `scr-06-requirement`도 같이 깨질 수 있다. 가짜 데이터를 고쳤으면 전체 화면 e2e를 한 번 돌린다. `checklists/scr-05.ts`의 가짜 요약은 2 / 5다.
- [후속] ADR-114의 원문 표기 항목에 옛 괄호("대조 시험 대신 글자 범주별 단위 시험")가 남아 새 문장과 어긋난다(마무리 문서 PR에서 지운다). `visibleLines`가 U+2028 등으로 줄을 지어낼 때 잡는 시험 없음(코드는 맞다). 진술 편집 뒤 병합 전까지 판정이 옛 테스트 기준인데 표시 없음(응답에 근거 없음). 폐기된 규칙 상세의 판정이 폐기 전 기록이라는 표시 없음. 속성 줄 "확인 · 미확인 [확인]"의 낱말 겹침.

## M7-16 (#228, PR #252) 병합 뒤 확정 사실 (main 72fbc24, ADR-117, 마이그레이션 없음)
- [전달] `verification.summary`에 세 칸 추가(기존 `compliance` · `denominator`는 전체 기준으로 그대로): `confirmedCompliance: {passed, judgeable, confirmed} | null`(사람 확인 기준. 전체 기준 분모 가운데 지금 확인됨인 규칙만. `confirmed`는 효력 있는 확인됨 규칙 수), `confirmedDenominator`(그 분모 목록), `agentRetiredRules`(규범 변경 기록의 에이전트 주체 `retired` · `superseded` 대상 규칙의 서로 다른 수, 전체 누적, 그 뒤 지워진 규칙도 센다). 효력 있는 확인됨 규칙이 없으면 `null`(확인됨이 폐기 규칙뿐일 때도), 확인됨이 모두 격리면 `{0, 0, N}`. 계산은 `verification/summary.ts`(`/confirm/i` 금지 대상 밖). 폐기된 규칙은 확인됨이어도 두 분모에서 빠진다.
- [전달] 내장 규칙은 확인 상태 `unconfirmed`로 온다(전체 기준 분모에는 들고 사람 확인 기준에는 사람이 확인하기 전까지 안 든다). 사람이 진술을 편집해 확인됨이 된 규칙은 옛 판정 그대로 사람 확인 기준에 든다(ADR-117 한계).
- [전달] SCR-05: 지표 카드 3개(준수 · 에이전트 폐기 규칙 · 실행당 비용). 준수 카드 안 "전체 기준" · "사람 확인 기준" 버튼. 사람 확인 기준 → SCR-03이 `준수 집계: 판정 가능` + `확인: 확인됨`으로 열림. 폐기 수 카드 → [폐기 포함]만 켜짐(`AGENT_RETIRED_FILTER`). **폐기 수 카드의 수와 열린 목록의 카드 수가 다르다**(폐기되지 않은 규칙도 함께 보이고 폐기 카드는 표시 ID 순서 속에 섞인다. 지워진 폐기 규칙은 수에는 들고 목록에는 없다). 폐기만 보는 칩이나 폐기 카드 정렬은 M7-14가 정할 수 있다. 검증 화면 규칙 제목은 `visibleText`.
- [전달] 검증 화면 · 규칙 화면은 규범 변경 알림이 없어 폐기 · 확인이 일어나도 실행 알림 전까지 다시 읽지 않는다(M7-14). 요약은 호출마다 규범 변경 기록 전체를 읽는다.
- [전달] 구조 시험 허용 목록: `.normChanges.` 읽기와 `'retired'|'superseded'` 글자에 `verification/summary.ts` 추가(읽기만).
- [전달] 확인됨 규칙을 폐기하면 규범 변경 기록에 `retired` 뒤 오케스트레이터의 `unconfirmed`가 낀다. 시나리오 `contradiction` 뒤 요약은 `agentRetiredRules: 1`, 에이전트 규칙만 있는 흐름의 사람 확인 기준은 `null`이다(M7-17).
- [후속] ADR-117에 "지워진 폐기 규칙은 수에는 들고 [폐기 포함] 목록에는 없다" 한 줄. "'없음'을 누르면 빈 목록"을 단언하는 시험 없음(e2e 가짜 데이터가 서로 맞지 않는다). 스키마가 `confirmedDenominator`를 `rules[]`의 확인 상태와 대조하지 않는다. 좁은 창에서 비용 카드가 둘째 줄로 내려간다.

## M7-11 (#223, PR #253) 병합 뒤 확정 사실 (main a294c2d, ADR-115, 마이그레이션 0020)
- [전달] 도구 `raise_objection {ruleIds(효력 있는 규칙 1~5개. 실행의 대상이 아닌 규칙도 받는다), reason(빈 글 불가, 2000자)}`: 구현 역할에만. 기록 추가만 한다. 거부: `invalid_args`(형식, 없는 · 삭제 · 폐기 · 잠정 규칙, 중복, 같은 시도의 두 번째 이의), `builtin_rule`, `not_configured`, `session_closed`(닫힌 뒤의 모든 호출). 이의 기록 `objection`: 주체 `{agent, implementer}`, 대상 `{Run}`(규칙 기준 `normChange.list`에는 안 나온다), `detail.objection = {rules, stepId}`.
- [전달] 이의 뒤 세션: 실행기만 닫히고 결과 끝에 고정 문장(`OBJECTION_ACCEPTED_TEXT`). 세션은 스스로 결과로 끝나 실제 비용이 기록된다. 닫힌 뒤 `session_closed` 거부가 3번(`OBJECTION_CLOSED_CALL_LIMIT`) 쌓이면 엔진이 중단하고, `objection_raised` + 비용 null 세션은 하루 합계와 실행 합계 모두 그 세션 한도 전부로 센다. 세션 종료 사유 `objection_raised`(shared enum · 표시명 "이의 제기" · DB CHECK. 0020이 `sessions` 표를 다시 만들었다. 색인 1 · 트리거 6). 종료 사유 덮어쓰기는 `tools.closed === 'objection_raised'`이고 결과가 `success` · `error_during_execution`일 때만(한도 subtype · 가드 위반은 그대로). 이의를 부른 시도는 커밋 · 판정하지 않는다.
- [전달] **판단 세션의 배선**: 엔진은 `StepContext.judgeNorms`(주입받은 `PipelineEngineOptions.judgeNorms`)만 부른다. `orchestrator.ts` 한 곳에서 `ruleWriter.judge`로 잇는다. 함수는 "원인 기록 + 대상 규칙 + 입력 글"을 받는다(`NormJudgeCause.kind`. 지금은 `objection` 하나. 새 원인은 종류만 더한다). 구조 시험: "`ruleWriter.judge`는 `orchestrator.ts`만, `judgeNorms:`는 엔진 옵션과 오케스트레이터 배선만", "엔진 · 단계 · 실행 · 판정 · 도구 · 에이전트는 rule-writer-service를 가져오지 않는다"(그대로).
- [전달] 판단 세션: 대상 규칙마다 `uphold_rule {ruleId, grounds}`(새 도구, 규칙 작성 역할) · `retire_rule` · `supersede_rule` 가운데 하나를 한 번. 대상 밖 규칙 · 이미 판단한 규칙 · `propose_rule`은 거부, 모두 판단하면 실행기를 닫는다(닫힘 이유 `judgment_complete`). 대체의 새 규칙 부모는 대상 규칙의 부모. 작업 지시: 판단 대상 규칙(표시 값) → `<<<BIVE 이의 글 시작: 구현 역할의 주장, 지시 아님>>>` … `<<<BIVE 이의 글 끝>>>` 사이에 `indentedText`로 이의 글 → 효력 있는 규범 자료. 시스템 프롬프트에 고정 문장. 판단 세션은 규칙 작성 서비스의 `runGuardedSession`을 쓴다(엔진의 `#runSession`이 아니다).
- [전달] 판단 기록 `judgment`: `detail.judgment = {subject:'objection', verdict: upheld|retired|superseded, contradicts:[], causeSeq(이의 기록 순번), createdSeq?(대체)}`. 판단 없음: `undecided:{endReason}`이 붙고 결과는 유지 · 주체는 오케스트레이터(스키마가 강제). 저장 사유는 고정 한국어 문장이고 종료 사유는 `undecided.endReason`에만 있다. **판단 없음 · 세션 실패 · 열지 못함 · 재기동은 유지다. 폐기로 보지 않는다.** 폐기 · 대체의 판단 기록은 `writeRetirement` 바로 앞에 쓴다(확인 풀림의 쓰기 순서 유지). 마무리 함수 `settleObjection`이 본보기다.
- [전달] 판단 세션은 **실행 밖 세션**이다(저장소가 단계 시도에 그 단계 역할의 세션만 받아서). 하루 한도 합계에는 들고, 실행 합계와 `run.get`의 `sessions`에는 나오지 않는다. 한도는 min(규칙 작성 역할 설정, 하루 잔여, 실행 잔여). **남은 문제: 판단 세션의 비용이 실행 잔여를 줄이지 않는다.** 하루 한도가 비어 있으면(사람 [실행]) 실행 예산을 넘는 지출이 실행당 최대 3회 × min(역할 한도, 실행 잔여)까지 생긴다(ADR-115. M7-12가 다룬다).
- [전달] 판단 뒤: 유지 → `unmet`(`objection_upheld`)으로 구현 회귀, 검사 회귀와 같은 `regressionCount` 상한 2회 공유(매번 이의 · 유지면 시도 3 뒤 `regression_limit`). 다음 구현 세션은 판단 근거를 앞 시도의 사유(`indentedText`)로 받는다. 폐기 · 대체 → `failed`(`objection_applied` "이의 반영"), `runEnding()` 경유, 병합 없음(대상 밖 규칙에 대한 판단이어도 끝낸다. `target_rule_retired`보다 이 사유가 먼저). 대체면 판단 세션 종료 뒤 자동 시작으로 새 실행. 판단 세션을 열지 못한 경우: 하루 한도 · 실행 예산 → `budget_exceeded`, 규칙 작성 역할 설정 미비 → `failed`(`settings_missing`), 시작 실패 · 배선 없음 → 유지로 회귀. 연쇄(실행 → 이의 → 판단 → 대체 → 자동 시작)를 멈추는 장치는 하루 예산뿐이다.
- [전달] **인용 검사가 조여졌다**(ADR-115가 ADR-112의 인용 문장을 대체): EARS 틀 글자(`EARS_FRAME_WORDS`)와 공백을 뺀 나머지로 연속 10 코드 포인트, 그리고 그 조각이 효력 있는 다른 규칙의 글에 없어야 한다(고유 조각). 고유 조각이 하나도 없는 규칙만 겹치는 조각 인용을 받는다. 시험 · 시나리오의 근거 글은 이 규칙을 통과해야 한다(예: `time 필드에 응답 시점의` 통과, `THE SYSTEM` 거부, 다른 규칙과 겹치는 머리말 거부).
- [전달] 화면 표시명: shared에 `NORM_JUDGMENT_SUBJECT_LABELS` · `NORM_JUDGMENT_VERDICT_LABELS` · `NormUndecidedReason`/`NORM_UNDECIDED_REASON_LABELS`(13종), 앱이 같은 표를 다시 적고 시험이 대조한다. 새 주제 · 결과 · 사정을 더하면 두 표를 함께 넓힌다. 규칙 상세의 변경 이력은 "이의 판단 · 유지/폐기/대체", "이의 판단 · 유지 · 판단 없음 (사정)"으로 그리고 모르는 값은 "알 수 없음". `objection_applied` · `objection_upheld` · `session_closed` · `settings_missing`은 아직 앱에 그려지는 곳이 없다(실행 실패 사유 · 단계 결과를 그리는 화면이 없다. M7-14가 그리면 표시명을 넣는다).
- [전달] 시나리오 `objection`(구현 시도 1이 이의 → 판단 유지 → 구현 시도 2 통과, 요구사항마다 규칙 1개). 검토자의 임시 e2e 기준값: `merged`, 회귀 1, 단계 `implementation#1:failed` · `#2:passed`, 규범 변경 기록 `created · judgment(no_contradiction) · [auto_start] · objection · judgment(upheld)`(하루 한도를 두면 `auto_start`가 낀다), `run.get`의 세션 `test-writer:success · implementer:objection_raised · implementer:success`(판단 세션은 안 나온다), 폐기 0.
- [후속] `ruleWriter.judge` 구조 시험이 별칭 · 구조 분해를 놓친다. 종료 사유 덮어쓰기가 한도 subtype을 덮지 않음을 단언하는 시험 없음. ADR-115 "다시 정하는 조건"의 "이의 뒤 세션을 끝내는 방식(지금은 중단)" 문구가 낡았다. 대체 뒤 자동 시작이 빠지는 경우(재기동 · 사람 중단 · 정상 종료가 아닌 판단 세션). 같은 실행 앞 시도의 케이스 이름이 판단 입력에 들어갈 수 있다.

## M7-10 (#222, PR #254) 병합 뒤 확정 사실 (main d6808f0, ADR-116, 마이그레이션 없음)
- [전달] 사람이 요구사항 본문을 고치거나(본문이 실제로 다를 때만) 지우면, 효력 있는 자식 규칙이 하나 이상일 때 규칙 작성 역할의 재판단 세션이 뜬다(`RuleWriterService.rejudge`. 부르는 곳은 `ipc/requirement-handlers.ts`뿐). 세션은 실행 밖(`runId` 없음, `requirementId` = 그 요구사항)이다.
- [전달] 판단 기록: 규범 변경 기록 `judgment`, `detail.judgment = {subject: 'requirement_change', verdict: 'upheld' | 'retired' | 'superseded', contradicts: [], createdSeq?, requirementChange: {requirement: {id, displayId}, change: 'updated' | 'deleted', at, textHash}, input}`. 판단 없음은 오케스트레이터 주체의 `upheld` + `undecided: {endReason}`(`settleRequirementChange`, 멱등). 화면은 주제 `requirement_change`의 판단 카드(유지 · 폐기 · 대체 · 판단 없음)를 보여야 한다. 표시명은 shared 표(`NORM_JUDGMENT_SUBJECT_LABELS` 등)에 있다.
- [전달] 삭제의 재판단: 삭제 RPC는 그대로 소프트 삭제 + 부모 해제(한 트랜잭션), 커밋 뒤 재판단. 세션이 돌기 전 · 도는 동안 자식 규칙은 부모 없는 효력 규칙. 삭제 세션은 `propose_rule` · `supersede_rule`을 거부한다(폐기 · 유지만).
- [전달] 겹친 변경은 요구사항마다 1건으로 접는다(메모리 `#launched`). 재판단의 시도 기록 행(`rule_writer_requests`)은 `#run`이 ① 본문이 다름 ② 대상 자식 규칙 있음 ③ 하루 한도 · 설정을 확인한 뒤 세션 직전에 만든다. 판단할 것이 없으면(A → B → A, 대상 없음) 시도 기록 · 판단 없음 기록이 없고 상태 줄은 앞 상태 그대로다. 재판단이 대기열에서 기다리는 동안 "규칙 작성 대기"는 보이지 않는다(M7-14에서 다시 볼 만함).
- [전달] 자동 시작: 재판단 세션이 정상 종료하면 대체로 생긴 새 규칙마다 실행 1개(M7-19와 같은 길). 폐기만 · 유지만이면 실행 없음.
- [후속] 진짜 생략(대기 중 하루 한도 → 생략 행)을 지키는 시험이 없다(변이 MB · MD 통과). `close` 때 접어 둔 재판단이 있으면 `#drainPending`이 닫힌 뒤에도 `rejudge`를 불러 생략 행 1개와 `aborted` 판단 없음이 한 번 더 남는다(`#closed`이면 `#drainPending` 건너뛰기). ADR-116 한계 ⓐ의 "시도 기록은 `closed`로 닫히고"는 진행 중 재판단에만 맞다(대기 중 재판단은 재기동 뒤 흔적 없음. 문장 고칠 것).
- [후속] 비정상 종료로 끊긴 재판단은 판단 없음 기록 없이 끝나고, 같은 글 재저장으로 다시 띄울 수 없다(시도 기록 표에 종류 · 대상 칸 + 사람이 다시 띄우는 계기. 후속 이슈 후보).

## M7-12 (#224, PR #255) 병합 뒤 확정 사실 (main e8b8f2c, ADR-118, 마이그레이션 없음)
- [전달] 검사 단계에서 실패한 규칙이 모두 대상 밖 · 내장 아님이면 규범 역할의 판단 세션이 한 번 뜬다(`norms/check-contradiction.ts`, 엔진은 `StepContext.judgeNorms`만 부른다. `NormJudgeCause.kind`에 검사 실패가 더해짐). 판단 기록 `judgment`: `detail.judgment.subject = 'check_failure'`, 결과 `no_contradiction` · `contradiction`, 판단 없음은 모순 없음에만. 판단 주제는 이제 다섯(`new_rule` · `supersede` · `objection` · `requirement_change` · `check_failure`). 표시명은 shared 표와 앱 `normChangeView.ts` 표(대조 시험 있음). 표시명은 "모순 없음"이다(로드맵 · 이슈 본문의 "모순 아님"이 아니다).
- [전달] 판단 입력: 실패한 규칙 ID와 케이스 이름뿐(실행기 출력 원문 · 구현 세션의 글 없음). 케이스 이름은 그 규칙 폴더 인수 테스트 파일의 **문자열 리터럴 값 전체**(작은 · 큰따옴표 · 보간 없는 백틱)를 ` > `로 이은 것과 같을 때만 "알려진 케이스"이고, 나머지는 "알 수 없는 케이스 N건"으로 센다(`knownCaseMatcher`). 한계: 주석 속 따옴표 글 · import 지정자도 리터럴로 읽힌다(그 파일은 Red 해시로 잠긴 글).
- [전달] 모순 → 실행 `failed`(`existing_rule_contradiction`, `failedRuleIds`), 병합 없음(검사 단계 halt + 단계를 열 때의 `contradictionHalt` 이중). 모순 판단이 하나라도 있으면 끝난다. 모순 없음 → 구현 회귀(상한 2회 공유). 병합 재검사 실패에도 같은 판단(모순이면 `existing_rule_contradiction` · `stage: merge_recheck`).
- [전달] **다시 시작**: 기존 규칙 모순 또는 이의 반영(`objection_applied`)으로 끝난 실행의 대상 규칙이 여전히 효력이면 대상 규칙마다 실행 1개를 다시 시작한다(`runs/auto-start.ts` `restartAfterContradiction`, 폐기만일 때도. `AutoStarter.observe`가 엔진 저장 이벤트에서 부른다). 원인 = 그 끝난 실행의 첫 모순 판단 / 첫 폐기 · 대체 이의 판단 순번(`restartCauseOf`), `auto_start` 기록의 `causeSeqs`에 그 순번. 엔진 대조(`start-basis.ts` `isRestartCause`)는 그 순번과 같은지 본다. 하루 한도 문(`autoStartBlock`) · 멱등 같음. 대상 규칙 자체가 폐기 · 대체됐으면 다시 시작 없음. 유지로 끝난 이의는 다시 시작 없음. **생략(하루 한도 · 재기동 틈)은 기록 없이 로그만 남는다.**
- [전달] 판단 세션 행(이의 · 검사 실패)은 판단을 청한 단계 시도에 묶인다: 실행 합계와 `run.get`의 `sessions`에 `rule-writer`로 나온다. 요구사항 재판단 세션은 실행 밖(`runId` null) 그대로다.
- [전달] M7-17 기대값: 시나리오 `contradiction-missed` = EXE-001 merged → EXE-002 `failed`(기존 규칙 모순) → EXE-003(대체 규칙) merged → EXE-004(RULE-002 다시 시작) merged, 병합 3. 기록 순서 `created, judgment(new_rule), auto_start, created, judgment(new_rule), auto_start, created, judgment(supersede), judgment(check_failure:contradiction), superseded, auto_start, auto_start`. 시나리오 `accidental-break` = EXE-002 merged(implementation#1 · #2 passed, check#1 failed · check#2 passed), 마지막 기록 `judgment(check_failure:no_contradiction)`, 폐기 0, 병합 2. `objection` 시나리오는 유지로 끝나 영향 없음.
- [후속] "유지로 끝난 이의는 다시 시작하지 않는다"를 직접 단언하는 시험 없음. ADR-118 "무엇의 새 실행인가"의 대조 항목 문장이 낡음(지금은 `restartCauseOf` 순번 일치). 리터럴 대조를 `it`/`describe`/`test` 호출 인자로 좁힐 수 있음. 다시 시작 생략의 기록 · 화면 표시 없음. 종료 리터럴 구조 시험을 `steps/`까지 넓히기. ADR-100 A4("폐기만 있고 새 규칙이 없으면 새 실행을 만들지 않는다")를 ADR-118이 "폐기된 규칙 쪽의 새 실행"으로 좁혀 읽음(사람에게 알림).

## M7-14 (#226, PR #256) 병합 뒤 확정 사실 (main e00089a, ADR-119, 마이그레이션 없음)
- SCR-17 할 일 화면의 탭은 [확인할 것] 하나다(검토 대기열 탭은 M3-08이 저장 · RPC와 함께 더한다. `TODO_TABS` · 배지 합계 · 툴팁에 더할 것).
- 목록 = `confirmation.list`의 `items`를 서버 순서 그대로(렌더러는 다시 정렬하지 않는다). 카드: 종류 태그(대체 · 폐기 · 변경 · 신규 · 요구사항) + 제목, 표시 ID + 예외(미확인 · 확인 풀림 · 테스트 변경) + 시각.
- `confirmation.list` 결과에 선택 칸 `totalByKind`(합 = `total`, shared 스키마 refine이 지킨다. 잘린 목록도 전체 기준). 배지 = `total`(테스트 변경 항목도 센다), 툴팁 = 종류별 건수. 배지와 목록은 조회 하나(`TodoListProvider`)를 같이 쓴다. `proposal.count` 배지 코드는 없다.
- [확인] = 사람 주체 `confirmation.set` 1회. 같은 틱 중복 방지(`inFlight`), 성공 · -32009 뒤에는 목록 다시 읽기가 끝난 뒤에 버튼을 다시 켠다. 판단 기록을 못 읽어도 [확인]은 막지 않는다. 같은 대상 항목은 함께 내려간다.
- 새 알림 `event.normChange.appended {projectId, lastSeq}`: 오케스트레이터 `ipc/project-store-access.ts`의 `withRegisteredProjectStore`가 사용 전후 마지막 순번을 비교해, 늘었으면 저장소를 닫은 뒤 보낸다. 내용은 없다. 렌더러에서 배지 · 확인할 것 · `useRules` · `useVerification` · `useChildRules` · 열린 상세의 판단 카드가 이 알림으로 다시 읽는다. 사람의 확인 · 편집(승인 기록)은 이 알림이 없다(재접속 · 화면 이동 때 보인다).
- 구조 시험: `.normChanges.append(` 허용 목록은 그대로. `.normChanges.` 읽기 허용 목록에 `ipc/project-store-access.ts`가 들었고 마지막 순번 읽기만 한다는 단언이 있다.
- 표기: 서버 표시 값은 `visibleDisplayText`(역슬래시만 그대로 두는 `visibleText`)로 그린다.
- 필터 칩 4종: 확인 상태 · 종류 · 위험도(항목에 `risk` 칸이 없어 전부 0건 비활성. M3-01이 칸을 더한다) · 생성 주체. [문제만] 토글은 이 화면에서 모든 항목을 남긴다(모든 항목이 예외를 가짐).
- 지운 것: 앱의 승인 대기 화면(`ApprovalTab` · `ProposalDetail` · `DecisionInputs` · `editDraftStore` 등), `FloatingActions`, 렌더러의 `PROPOSAL_EVENT_NAMES`. 남긴 것: 오케스트레이터 `proposal.*` RPC · 제안 저장 · `event.proposal.changed`.
- [후속] [문제만] 토글의 뜻 정하기 또는 감추기, 알림을 닫은 뒤 보낸다는 시험, 구조 시험의 대괄호 접근(`store['normChanges']`), 1280에서 상세 칸 약 288px, 상세 다시 읽기 횟수 시험, 공용 카드의 `unread` · 상태 배지 `decision` 죽은 코드, 대상 링크가 카드 선택까지는 안 함, 확인한 항목의 기록(M3-12).

## 바로잡음 (M7-17 구현 중 확인, 11-24)
- M7-11 절의 "이의 판단 세션이 `run.get`에 안 나온다"는 낡았다. M7-12 뒤로 이의 · 검사 실패 판단 세션은 판단을 청한 단계 시도에 묶여 `run.get`의 세션 목록에 `rule-writer`로 나온다.
- 기존 규칙 모순으로 끝난 실행의 종료 상세는 `exitDetail.detail` 아래에 있다(엔진 `#halt`가 `{reason, detail:{failedRuleIds}}`로 감싼다).
- (11-24 바로잡음, PR #270 검토) 192행의 "ADR-116 한계 ⓐ의 `closed`로 닫히고는 진행 중 재판단에만 참"은 틀렸다. `closePending`은 세션 행이 없는 시도만 닫는다. 재판단은 시도 ID = 세션 ID이고 시도 기록 직후 세션 행을 쓰므로, 진행 중이던 재판단의 시도는 `closed`가 아니라 세션 `aborted`로 읽혀 끝남으로 보인다. `closed` 생략은 세션 전에 대기하던 새 요구사항의 규칙 작성 시도에만 붙는다.
