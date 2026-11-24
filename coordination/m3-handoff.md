# M3 인계 문서 (조율자가 이슈가 병합될 때마다 덧붙인다)

M3(판정 확장)는 M7(사후 확인 전환, ADR-100) 위에서 시작한다. main `10ad3d5`(2026-11-24). ADR은 119까지, 마이그레이션은 `project/0020`까지 있다. 번호는 지시서가 준 것만 쓴다.

## M7이 남긴 것 가운데 M3 구현자가 알아야 할 사실
자세한 것은 `m7-handoff.md`(같은 폴더)의 해당 절을 읽는다. 지시서가 절 이름을 준다. 요점:
- **사전 승인이 없다.** 규칙 작성 세션이 만든 규칙은 바로 효력이 있고(`normState: 'approved'`가 효력, 확인 상태는 미확인), 규칙마다 실행 1개가 자동으로 시작된다(ADR-107 · ADR-110 · ADR-111). 사람은 [확인할 것]에서 사후에 확인한다(`confirmation.set`, 사람 전용). 옛 제안 · 승인 화면 코드는 앱에서 지워졌고 오케스트레이터 `proposal.*` RPC만 남아 있다.
- **규범 변경 기록 `norm_changes`**(추가 전용 · 해시 체인): 종류 `created` · `updated` · `retired` · `superseded` · `judgment` · `objection` · `unconfirmed` · `auto_start` · `test_changed`. 쓰는 곳은 구조 시험의 허용 목록(`.normChanges.append(`)에 든 파일뿐이다. 허용 목록을 고치면 이유를 PR 본문에 적는다. `NormChangeDetail`은 넓히기만 한다(조이면 옛 행이 깨져 체인이 깨진다).
- **구조 시험 `orchestrator/test/integrity.test.ts`를 느슨하게 만들지 않는다**: 엔진 · 단계 · 에이전트 · 도구 · 역할 · 판정 · 실행 코드에 `/confirm/i` 글자 금지(주석 포함), `.confirmations`는 `confirmations/confirmation-service.ts`만, `.rules.create(` 허용 목록, 실행 종료 상태는 `runEnding()` 한 곳, 고정 사유 상수 목록(`NORM_CHANGE_FIXED_REASONS`)과 문서 기호 금지.
- **판단 주제 5종**: `new_rule` · `supersede` · `objection` · `requirement_change` · `check_failure`. 표시명 표는 shared(`NORM_JUDGMENT_SUBJECT_LABELS` 등)와 app `normChangeView.ts`에 있고 대조 시험이 있다.
- **프로젝트당 동시 실행 1개**(ADR-105), 멈춤 장치는 프로젝트 하루 예산뿐(ADR-104). 다른 멈춤 장치를 새로 만들지 않는다.
- **화면 다시 읽기**: 규범 변경 기록이 늘면 `event.normChange.appended {projectId, lastSeq}`(내용 없음)가 나간다(`ipc/project-store-access.ts`).
- 역할 분리: 구현 역할은 자기 채점 기준(규칙 · 인수 테스트)을 바꾸지 못하고 이의만 제기한다. 내장 구조 규칙은 에이전트가 폐기하지 못한다.
- 파이프라인 e2e는 CI에서 두 묶음으로 돈다(`ci.yml`의 `PIPELINE_E2E_GROUP1`, 나머지는 묶음 2). 새 파일을 더하면 두 묶음의 소요 시간을 보고한다(제한 30분, 목표 20분 아래).

## 사람 결정 대기 (지금 동작을 유지한다. 구현이 이것을 바꾸지 않는다)
#209(A4 해석 · 진술 편집 자동 시작 · 이의 범위), #239(재기동 뒤 자동 재개), #267(실행 작업 폴더 정책), #117 · #126 · #135 · #158 · #159 · #160 · #108 · #2.

## 병합 뒤 확정 사실

### M3-36 (#264, PR #271, main `87aa8a3`, ADR-120, 마이그레이션 `project/0021_integrity_gaps`)
- **0021은 표를 다시 만들지 않는다.** 새 표 `run_test_change_checks(run_id PK → runs, checked_at)`와 트리거 10개만 더한다. 제약은 표 CHECK가 아니라 BEFORE 트리거다(옛 위반 행은 값 그대로 남는다).
  - `runs`: `runs_merged_commit_insert` · `runs_merged_commit_update`(`merged`로 들어가는 행은 `merge_commit` 필수), `runs_merged_test_change_insert` · `runs_merged_test_change_update`(AFTER, `merged`가 되는 같은 문장에서 확인 전 행을 넣음).
  - `approval_log_actor_human`(주체는 `{"kind":"human"}`만), `rule_retirements_effective_successor` · `rule_retirements_norm_change_successor`, `run_test_change_checks_insert` · `_update` · `_no_delete`.
  - **`runs` 표를 다시 만드는 마이그레이션은 0016의 트리거 8개에 더해 위 `runs` 트리거 4개를 다시 만들어야 한다**(ADR-120 ②에 목록).
- **기동 복구**: `TestChangeNotifier.recoverPending`이 확인 전 실행만 다시 보고 알림 기록과 확인 시각 채우기를 한 트랜잭션으로 쓴다(`recordTestChanges` → `runs.markTestChangeChecked`). 실행을 다시 시작 · 재개하지 않는다. 기동 순서는 `recoverInterruptedRuns`와 `startQueuedRuns` 사이.
- **`ApprovalLogEntry.detail.appliedRef`**는 `approve` · `approve_edited`에만 받는다(읽기 스키마도).
- **병합 직전 확인**: 워크트리 관리자 `merge`의 `MergeOptions.beforeUpdate`(동기). 문장을 돌려주면 `vetoed`, 병합 실행기는 `failed`(`target_rule_retired`, `stage: before_update`). 던지면 실행기 예외 경로(`failed`, `step_error`).
- **깨진 행**: `RunRepository.list`는 형식이 깨진 행만 건너뛰고 경고(`warnOnce`, 건수 · 프로젝트 ID만). ID로 읽으면 여전히 오류. 세션은 `norm_input`만 `null`로 읽고 경고. 하루 합산은 세션을 빼지 않는다. 조회 결과 스키마는 바꾸지 않았다(화면에 안 보임).
- 다음 마이그레이션 번호는 0022, 다음 ADR 번호는 지시서가 준다.
- 후속 후보(아직 이슈 없음): 깨진 실행 행을 화면에 드러내기 · 깨진 `queued` 행으로 같은 규칙 실행이 하나 더 생길 수 있음 · `warnOnce` 건수가 거르기별 · 두 이행 경로의 스키마 직접 비교 단언.

### M3-37 (#265, PR #272, main `3169273`, ADR-121, 마이그레이션 없음)
- **케이스 이름 대조는 `orchestrator/src/norms/case-names.ts` 한 곳**이다(`knownCaseMatcher`, `readJudgedAcceptanceTexts`, `judgedCaseFilter`). `collectNormInput`의 `isKnownCase`는 필수 인자다. 판정 결과의 케이스 이름을 세션 입력 · 규범 자료 · 인용 출처에 싣는 새 자리는 반드시 이 기준을 지난다(구조 시험이 판정 읽는 파일 목록 · 필터 자리 · 폐기 대체 6곳을 고정한다). 모르는 이름은 "알 수 없는 케이스 N건"으로 바뀌고 원문은 세션 입력에 들어가지 않는다.
- **받는 꼴**: `describe` · `it` · `test`와 점 수식 `skip` · `only` · `todo` · `concurrent` · `sequential` · `fails` · `shuffle`의 첫 인자가 문자열 또는 보간 없는 템플릿. `each` · `for` · `skipIf` · `runIf` · `extend`, 이어 붙이기 · 보간 · 변수 · 별칭 · `suite`, 문법 오류 파일, 1 MiB 뒤는 모르는 이름이다. **시나리오 · 시험의 인수 테스트가 `it.each`로 케이스를 만들면 그 이름은 뒤 세션에서 "알 수 없는 케이스"로 보인다.**
- **기준 글의 출처**: 규칙마다 최근 판정 커밋의 `bive-acceptance/<표시 ID>/` 파일을 git 객체에서 읽는다(`--no-replace-objects`, 커밋 형식 16진 40 · 64자만, 일반 파일만). 판정 기록이 없거나 읽지 못하면 전부 모르는 이름(닫힌 쪽).
- **시험 보조**: `orchestrator/test/helpers/acceptance-commit.ts`(브랜치 · 작업 트리를 바꾸지 않는 커밋 객체를 만든다). 판정 기록을 심는 시험은 실제 커밋을 써야 케이스 이름이 알려진 이름이 된다. 규칙 작성 시험 하네스의 프로젝트 폴더는 실제 git 저장소다.
- 남는 길(ADR-121): 테스트 작성 세션의 앞 시도 사유(`steps/test-writing.ts`의 `describeUnmet`)는 Red 확인의 통과 케이스 이름과 수집 오류 메시지를 거르지 않고 싣는다(후속 이슈 후보). 구현 세션의 앞 시도 사유는 같은 역할로 돌아가는 글이라 그대로다.
