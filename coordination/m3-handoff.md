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

### M3-35 (#263, PR #273, main `3d58faa`, ADR-123, 마이그레이션 없음)
- **확인할 것 화면에는 [문제만] 토글이 없다**(공용 목록의 `problemToggle` 속성, 기본 참, 확인할 것만 끔). 예외 없는 항목 종류가 생기면 다시 둔다(ADR-123).
- **대상 링크의 카드 선택**: `renderer/src/navigation/pendingSelection.ts`(`requestSelection` · `peekPendingSelection` · `clearPendingSelection`). 받는 화면(`RulesScreen` · `RequirementsScreen`)이 마운트할 때 읽어 자기 상태에 두고 마운트 효과에서 지운다. **그 이동 한 번에만** 쓰인다(읽기 실패 · 화면을 떠남 · 프로젝트 전환이면 버림). 링크는 지금 확인할 것 화면에만 있다. 다른 화면에서 같은 화면으로 가는 링크를 새로 만들면 "받는 화면이 새로 마운트된다"는 전제가 깨지므로 수명 처리를 다시 본다.
- **실행 종료 사유 표시명**: shared `RunFailureReason`(42개 값) · `RUN_FAILURE_REASON_LABELS`. app은 같은 표를 다시 적고 시험이 대조한다. `app/test/run-history-view.test.ts`가 "shared 값 집합 = 오케스트레이터 소스가 실행을 끝낼 때 남기는 값"을 고정한다. **오케스트레이터에 새 종료 사유를 더하면 shared 표와 app 표에 표시명을 더해야 그 시험이 통과한다.** 모르는 값은 "알 수 없는 사유". `exitDetail`은 화면에 보이지 않는다.
- **규칙 상세 "실행 이력"은 실행당 한 줄**(ADR-073의 "판정 기록 1건마다 한 줄"을 대체). `run.list`(상한 없음)를 읽어 판정 기록과 실행 표시 ID로 합친다. `event.run.updated` · 재접속 때만 다시 읽는다. 다른 규칙이 대상인 실행이 이 규칙을 판정했으면 그 실행의 사유가 이 규칙 상세에도 보인다(ADR-123 한계).
- 규칙 상세 속성 줄 이름은 "확인 상태"다(목록 칩은 아직 "확인").
- 화면 시험 도우미: `e2e/support/bive-mock.ts`의 `settled()` · `allSettled` · `nextFrame`. "더 부르지 않음"은 그리기 확인 → `nextFrame` → `allSettled` 순서로 본다. 새 화면 시험에 `waitForTimeout`을 쓰지 않는다.
- 공용 카드의 `unread` · 상태 배지의 `decision` 코드는 없다.

### M3-01 (#46, PR #274, main `03756a7`, ADR-122, 마이그레이션 `project/0022_block_declarations`)
- **블록 선언 스키마**: `packages/shared/src/blocks.ts`. `{blocks:[{name, kind, include, public, dependsOn, risk}]}`. 블록 1 ~ 30개, `include` 1 ~ 20개, `public` 0 ~ 20개, 패턴 200자, 이름 40자(소문자로 시작, 소문자 · 숫자 · `-`). `kind`는 `domain` · `shared`, `risk`는 `low` · `medium` · `high`. 모르는 칸은 거부.
- **경로 패턴**: 프로젝트 루트 기준. `**`(구간 0개 이상)와 `*`(구간 안, `/`를 넘지 않음)만 특수 글자다. 판정은 `matchesBlockPattern`(정규식을 쓰지 않는 구간 단위 매처, 시간 상한 시험 있음). **패턴을 정규식으로 옮기는 함수는 없다**(역추적 폭주 때문에 지웠다). M3-02는 파일 → 블록을 `matchesBlockPattern`으로 정하고, dependency-cruiser 규칙에는 그렇게 정한 파일 경로를 이스케이프해 넣는다(ADR-122 ②). 잇달은 `**`는 저장 때 거부. 패턴은 대소문자를 구분하고 경로 정규화(`src//a`, 역슬래시)는 하지 않는다: M3-02가 정한다.
- **저장**: 프로젝트 DB 표 `block_declarations`(판 단위 추가 전용. 사람 주체만 · 다음 판만 · 수정 삭제 금지를 트리거가 강제). 지금 선언은 가장 큰 판: `store.blockDeclarations.current()`(없으면 `null`). 가장 큰 판의 행이 깨졌으면 `StoredBlockDeclarationError`로 던져 세션 시작 · 규칙 생성이 실패하고(닫힌 쪽), 사람이 다음 판을 저장하면 풀린다. 옛 판만 깨졌으면 `list()`만 던진다.
- **RPC**: `blocks.get` · `blocks.set`(사람 주체만, 에이전트는 -32020, 규칙 위반은 -32001 `BLOCKS_INVALID` + `issues`). CLI `pnpm --filter @bive/app cli blocks set <dir> <json>`. 예제 `fixtures/blocks/sample-next-app.json`(auth high, health medium, lib low). 픽스처에 `src/app/api/auth/session/route.ts`(늘 401)가 생겼다.
- **규칙의 대상 블록 · 위험도**: `propose_rule` · `supersede_rule`에 `targetBlocks`(1 ~ 10개) · `risk`가 필수(도구 스키마와 반영 모듈 두 겹). `Rule.targetBlockIds`의 원소는 **블록 이름**이다(칸 이름은 그대로). 선언이 있으면 이름이 모두 선언에 있어야 하고(없으면 `invalid_args`, 아무것도 남기지 않음), 선언이 없으면 받은 이름을 그대로 저장하고 신규 기록 `after.blockDeclarationVersion = null`로 드러낸다. 옛 규칙 행 · 옛 제안 승인 경로 · `rule.update` · 내장 구조 규칙은 두 칸이 비어 있을 수 있다(읽기 스키마가 빈 목록 · `null`을 받는다). **시나리오에서 규칙을 만드는 도구 호출에는 `targetBlocks` · `risk`를 넣어야 한다.**
- **세션 입력**: 규범 자료 끝에 블록 절(선언이 없으면 절 없음). 테스트 작성 세션 디렉터리에 읽기 전용 `blocks.json` 사본(선언이 없으면 없음). 구현 역할에는 파일 사본이 없다(세션 루트가 워크트리).
- `confirmation.list` 규칙 항목에 선택 칸 `risk`가 있다. 화면 칩은 아직 이 값에 이어지지 않았다(M3-19).
- 사람 주체 RPC 위조의 기존 한계(#117)는 `blocks.set`에도 그대로다.
- 뒤 이슈로 넘긴 것: M3-02(겹침 · public 범위를 실제 파일 기준으로, 대소문자 · 경로 정규화), M3-03(선언이 없으면 구조 검사를 하지 않는다. 내장 구조 규칙의 대상 블록 · 위험도), M3-07(`Rule.risk`가 `null`인 옛 규칙의 순서), M3-19(선언에 없는 블록 이름의 표시, 사람 편집의 두 칸, 위험도 칩), M3-29(`blockDeclarationVersion = null` 규칙의 취급).
- 다음 마이그레이션 번호는 0023.

### M3-23 (#201, PR #275, main `1bffbaa`, ADR-124, 마이그레이션 없음)
- **공통 툴팁**: `renderer/src/components/Tooltip/`(`tooltipStore.ts` · `TooltipHost.tsx` · `placement.ts`). 상태는 모듈 하나, `AppLayout`의 `TooltipHost` 하나가 열린 것 하나만 `body`에 그린다(`role="tooltip"`, id `bive-tooltip`, 열린 동안만 대상에 `aria-describedby`). 글은 `visibleDisplayText`를 거친 글자 노드. **새 화면에서 설명 글이 필요하면 `title` 속성 대신 이 툴팁을 쓴다.**
- 동작: 올림 · 키보드 초점(`:focus-visible`)으로 열림. 원래 동작이 없는 대상은 누름으로도 열림. Esc는 창 캡처 단계에서 받아 **툴팁만 닫고 전파를 멈춘다**(IME 조합 중은 삼키지 않음). 닫혀 있으면 리스너가 없다. 대상이 DOM에서 빠지거나 보이는 영역(창 + 넘침을 자르는 조상) 밖으로 나가면 닫히고, 보이는 동안 스크롤하면 따라간다. 창 크기 변경에는 닫힌다. `position: fixed` 대상 · 모달 안 대상은 아직 없다(생기면 `isAnchorVisible`을 다시 본다).
- 카드(`Card2Line`): 잘린 줄에만 툴팁. 카드마다 리스너 · 요소가 늘지 않는다. 카드의 `title` 속성은 없다. 화면 시험 도우미 `listPaneOverflow`는 실제로 열린 툴팁의 글자를 본다.
- 설정 IDE 섹션: `IdeChoiceFields`의 `legendHidden` · `pathHint` 속성(기본 거짓. 코드 열기의 첫 IDE 선택 단계는 그대로).
- 화면 시험: CI와 이 VM의 한글 글꼴 폭이 다르다. 줄바꿈 위치 · 잘림 여부를 고정 값으로 단언하지 않고 순서 규칙("앞 칸 바로 뒤 8px이거나 다음 줄 왼쪽 끝") · 조건 규칙("잘렸으면 툴팁, 아니면 없음")으로 단언한다. 시험 소스에 숨은 글자 · 양방향 제어 문자를 글자 그대로 적지 않고 이스케이프(`‮`)로 적는다.
- 아직 `title` 속성으로 남은 자리(후속): 상태 배지, 생성 주체 아이콘, 필터 칩, 모달 닫기, 코드 링크, 사이드바, 채팅 머리, 검증 화면의 판정 기준 커밋 · 에이전트 폐기 규칙 카드 · 파이프라인 단계, 요구사항 상세의 규칙 작성 상태, 규칙 상세의 커밋 두 곳.

### M3-02 (#47, PR #276, main `13170ce`, ADR-125, 마이그레이션 없음)
- **`@bive/parser`의 `analyzeProject({projectDir, declaration})`** → `{graph, structure}`. 분석을 끝까지 못 하면 결과 대신 `ParserError`(종류 `code`)를 던진다. "위반 0건"으로 읽히지 않는다. `ParserError.message`에는 실행기 stderr 첫 줄(에이전트가 정할 수 있는 경로 글)이 200자까지 실리므로 **기록 · 화면에는 `code`만 쓰거나 표시 값 변환을 거친다.**
- **graph**: `modules`(루트 기준 `/` 경로, 정렬) · `edges` · `unresolved` · `unanalyzed`(`{from, to}`: 소스 확장자가 아닌 파일, 건너뛴 폴더 `.next` 등, 경로로 가리킨 `node_modules`, 프로젝트 밖) · `packages`(`{name, inManifest}`). 목록은 `{items, total}`이고 상한을 넘으면 앞쪽만 담는다. **`inManifest`는 안전 신호가 아니다**(가장 가까운 package.json 기준이고 구현 역할이 바꿀 수 있다).
- **structure**: 선언이 `null`이면 `null`(구조 검사를 하지 않는다). 있으면 블록별 `files` · `publicFiles`, `unclassified`, `publicOutsideInclude`, `outcome`.
  - `outcome.status`는 `checked`(위반 목록) · `overlap`(한 파일이 두 블록에 맞음: 위반을 판별하지 않음) · `incomplete`(블록 파일에서 분석하지 않은 대상으로 간 import가 있음: 위반 목록 + 그 import 목록). **통과는 `status === 'checked'`이고 위반 0건일 때뿐이다.** 겹침과 분석하지 않은 대상이 함께면 `overlap`.
  - 위반 한 건: `{kind, from:{file,block}, to:{file,block}, cycle}`. 종류 `structure.declared-direction` · `structure.public-api-only` · `structure.no-cycle`. 로드맵의 내장 규칙은 앞 둘뿐이다: **순환(`structure.no-cycle`)을 어느 내장 규칙으로 판정할지 M3-03이 정한다.**
  - `dependsOn`은 전이하지 않는다. `shared` 종류 블록도 `dependsOn`에 적어야 가져올 수 있다. 타입 전용 · 동적 import · `require`도 센다. 같은 블록 안 import와 미분류 파일이 낀 import는 위반이 아니다(미분류 목록과 간선으로 드러난다).
- **실행 방식**: dependency-cruiser 18.7.2의 공식 API를 자식 프로세스(`packages/parser/runner/cruise.mjs`)에서 부른다(CLI는 대상 프로젝트의 설정 파일을 실행하므로 쓰지 않는다). 환경 변수는 비우고(Electron 위에서만 `ELECTRON_RUN_AS_NODE=1` 하나), 프로젝트 밖 작업 폴더, 시간 제한 120초, 출력 상한 64 MiB. 비용: 픽스처 약 1초, 합성 2천 파일 약 6초. 루트 `package.json`의 `pnpm.packageExtensions`가 dependency-cruiser에 `typescript@6.0.3`을 준다(TS 7을 못 쓴다).
- **M3-03이 정해야 할 것**(ADR-125 "넘길 사실"): ① 어떤 트리를 분석하는가(예: git이 추적하는 파일만. `node_modules` · 빌드 산출물이 추적 대상이면 실패). 실행 작업 폴더의 설치 산출물(`src/generated` 등)이 소스로 들어와 미분류로 보인다. ② `incomplete` · `overlap` · `ParserError`를 판정에서 어떻게 다루는가(통과가 아니다). ③ 블록 파일이 `.mdx` · `.graphql` · `.wasm` · `.txt`를 가져오면 `incomplete`가 된다(허용 형식). ④ 풀리지 않는 패키지 이름 import는 `unresolved`로만 가고 상태는 `checked`다. ⑤ 위반 경로를 화면 · 세션 입력에 실을 때 표시 값 변환. ⑥ 한 순환이 아주 큰 프로젝트 · 출력 상한 초과는 늘 오류로 끝난다(구현 역할이 검사를 계속 실패시킬 수 있다).
- **변형 스크립트**: `scripts/make-variant.sh <픽스처 사본> <이름>`(`undeclared-import` · `cycle`, 변형마다 커밋 하나, `git revert --no-edit HEAD`로 되돌림. 원본 픽스처 · 저장소 루트 · 더러운 작업 트리는 거부). 뒤 이슈가 변형을 더할 때는 이름별 함수를 더하고 `scripts/test-make-variant.sh`에 검사를 더한다(CI `checks`가 돌린다).
- 파서 시험은 `testTimeout` 20초다(실행기를 띄우는 시험이 느리다).

### M3-19 (#64, PR #277, main `886bff3`, ADR-126, 마이그레이션 없음, 오케스트레이터 · shared 변경 없음)
- **규칙 상세**: 속성 줄 "부모 요구사항" 다음에 대상 블록 · 위험도. 값 없음은 "없음". 블록 이름이 지금 선언(`blocks.get`)에 없으면 이름 뒤 "선언 외", 선언이 없는 프로젝트는 "블록 선언 없음" 한 번, 선언을 못 읽으면 "블록 선언 불러오기 실패"(선언 외 판단 안 함). 판단 코드는 `screens/rules/blockView.ts`, 선언 읽기는 `norm-detail/useBlockDeclaration.ts`, 그리기는 `norm-detail/BlockList.tsx`. 열린 상세는 다시 고를 때까지 옛 선언으로 판단한다(블록 선언 변경 알림이 없다).
- **요구사항 상세의 구현 위치**: 효력 있는 자식 규칙(삭제 · 폐기 아님, `approved`)의 대상 블록만, 중복 제거, 선언 순서(선언에 없는 이름은 뒤에 이름 순).
- **필터 칩**: 규칙 목록 = 블록 · 위험도, 요구사항 목록 = 블록, 확인할 것 = 위험도(화면 정의서의 화면별 필터 문장대로. 요구사항 목록의 위험도 칩과 확인할 것의 블록 칩은 없다). 블록마다 한 번씩 세고 여러 블록은 OR, 다른 기준과는 AND. ADR-119의 "위험도 칩 비활성" 세 문장을 ADR-126이 대체한다.
- 요구사항 화면은 블록 값을 얻으려고 `rule.list`(폐기 포함)를 한 번 읽는다. **다시 읽기는 규범 변경 알림 · 재접속 때만**(`useRules(projectId, NORM_CHANGE_EVENT_NAMES)`, 실행 알림에는 읽지 않는다. 시험이 고정). 상세가 열려 있으면 알림 하나에 `rule.list`가 두 번(인자가 다른 두 조회) 나간다.
- 위험도 표시명: shared `RISK_LABELS`(낮음 · 보통 · 높음, `null`은 "없음").
- 블록 이름은 표시 값 도우미 없이 글자 노드로 그린다. main 프로세스의 `pipe-client.ts`가 응답을 shared 스키마(`BlockName` 형식)로 검사한 뒤에만 렌더러에 넘기기 때문이다.
- 하지 않은 것(후속): 사람이 규칙 편집에서 대상 블록 · 위험도 고치기(`rule.update`), 블록 선언 보기 · 편집 · 변경 알림, 내장 구조 규칙의 두 칸(M3-03).

### M3-39 (#279, PR #280, main `1080f37`, 문서)
- M3 표에 후속 행 5개가 생겼다: M3-40 #281(테스트 작성 세션의 앞 시도 사유에 케이스 이름 대조, orchestrator, 무결성) · M3-41 #282(깨진 실행 행의 표시와 판단 보정, M3-34 뒤) · M3-42 #283(규칙 · 요구사항 상세의 다시 읽기 다듬기, M3-16 뒤) · M3-43 #284(남은 `title` 자리의 공통 툴팁, M3-38 뒤) · M3-45 #285(공통 툴팁 후속, M3-43 뒤). **M3-44는 비워 둔 번호다.**
- 사람 결정 대기(needs-human #286): 사람이 규칙의 대상 블록 · 위험도를 고치는 길, 블록 이름 변경을 규칙이 따라가게 할지, 블록 선언을 화면에서 고칠 자리. 지금 동작을 유지한다(구현이 이것을 바꾸지 않는다).

### M3-03 (#48, PR #278, main `78d5ee0`, ADR-127, 마이그레이션 `project/0023_structure_judge_runner`)
- **내장 구조 규칙**: 사람의 `blocks.set`이 선언을 저장하는 같은 트랜잭션에서 `structure.public-api-only` · `structure.declared-direction` 두 개를 없는 것만 만든다(`norms/builtin-rules.ts`). 부모 요구사항 없음, `builtin: true`, 대상 블록 빈 목록 · 위험도 `null`, 미확인(확인할 것에 뜬다), 자동 시작 없음. 규칙의 생성 주체 칸은 "사람"(실제로는 오케스트레이터가 만든 고정 글), 규범 변경 기록 `created`의 주체는 오케스트레이터(고정 사유 `BUILTIN_RULE_CREATED_REASON`). **식별은 `builtin` 행의 고정 제목**이다(종류 칸이 없다. 제목 글을 바꾸려면 옛 행을 맞추는 마이그레이션이 함께 필요하다).
- 내장 규칙은 `rule.update`(사람 편집) · 폐기 · 대체 · 이의가 `builtin_rule`로 거부되고, `run.create`의 대상이 되면 -32009로 거부된다(`runs/run-service.ts`의 `assertNoBuiltinTarget`. 거부는 `createRun`에만 있다: 자동 시작 · 다시 시작 · 편집 뒤 시작으로는 대상이 될 수 없다). **M3-06이 유형 B에서 이 거부를 실행 생성으로 바꾼다.**
- **구조 검사**(`steps/structure-check.ts`): 선언이 있을 때만 돈다. 검사 단계와 병합 재검사가 `judgeCommit` 안에서, 판정 커밋의 깨끗한 체크아웃(추적 파일만)에서 **해시 대조 뒤 의존성 설치 전**에 파서를 부른다. 선언은 단계를 열 때 읽은 판을 쓰고 판정 기록에 판 번호가 남는다. 중단 신호가 파서까지 이어진다.
  - 통과는 `checked`이고 그 규칙 종류의 위반 0건일 때뿐. 순환(`structure.no-cycle`)은 판정하지 않고 결과에만 센다.
  - `incomplete` · 잘린 위반 목록 · 추적 중인 `node_modules` · 고칠 수 있는 `ParserError`(시간 · 출력 · 파일 수 · 경로 상한, 대소문자, 분석 빠짐) → 두 내장 규칙 `fail` → 구현 회귀(판단 세션 없음) → 상한 초과면 `regression_limit`.
  - `overlap` → 실행 종료 사유 `block_declaration_overlap`(표시명 "블록 선언 겹침"). 그 밖의 `ParserError` · 선언을 못 읽음 → `judge_runner_error`(`code`만). 선언과 내장 규칙 행이 어긋남(선언 있는데 행 없음 · 하나만 · 같은 제목 둘, 선언 없는데 행 있음) → `state_inconsistent`. 판정이 두 내장 규칙을 한 건씩 덮지 않으면 기록 없이 닫힌 쪽(`missingStructureJudgments`).
  - 판정 기록: 실행기 값 `dependency-cruiser`, 케이스 = 요약 1건 + 위반 최대 20건(경로는 표시 값, 300자, 줄 번호 없음). 내장 규칙은 인수 테스트 판정 대상에서 빠진다. 구현 세션의 앞 시도 사유에 위반한 파일 쌍이 실린다(50개 · 4000자).
- 준수 지표: 내장 규칙은 판정 가능 항목에 든다(판정 기록이 없으면 "판정 없음"). 추적성 결함 기준 함수 `parentlessRuleDefects`는 내장 · 폐기 규칙을 뺀다(아직 이 함수를 쓰는 제품 코드는 없다: M3-11 몫).
- 0023은 `judgments` 표를 다시 만든다(색인 2 · 트리거 4 복원). **`judgments`를 다시 만드는 뒤 마이그레이션은 이 목록을 따른다.** 다음 마이그레이션 번호는 0024.
- 오케스트레이터가 `@bive/parser`에 기댄다(architecture 2장의 방향과 같다). 파서 `runCruise`에 `signal` 옵션이 생겼다.
- 한계(ADR-127): 선언만 있고 내장 규칙이 없는 옛 프로젝트는 다음 `blocks.set`까지 `state_inconsistent`(화면에는 "실행 상태 불일치"), 겹친 파일 목록은 어디에도 없다, 환경 탓 시간 초과도 구현 회귀로 간다, `.mdx` 등은 `incomplete`로 실패한다, 내장 규칙 [실행]은 화면에 "실행 시작 실패"로만 보인다.

### M3-40 (#281, PR #288, main `1b64df8`, ADR-128, 마이그레이션 없음)
- **테스트 작성 세션의 앞 시도 사유**(`steps/test-writing.ts`의 `describeUnmet`): 앞 시도가 Red 확인이면, 그 단계 결과의 `exitDetail.commit`(Red 확인이 판정한 테스트 작성 커밋)의 대상 규칙 폴더 파일을 git 객체에서 읽어 대조한다(`norms/case-names.ts`의 `writtenAcceptanceOf`). 통과 케이스는 위치가 그 커밋의 대상 규칙 폴더 파일(정확 일치)이고 이름이 **그 규칙 폴더** 파일의 리터럴일 때만 `- 파일:줄 이름`으로 싣는다(줄은 양의 정수일 때만). 나머지는 "알 수 없는 케이스 N건". 수집 오류 메시지는 원문을 싣지 않는다: BIVE 고정 문구(`케이스 0개` · `인수 테스트 파일 없음` · `수집된 테스트 0개`, 정확 일치)와 스위트 훅 실패 안내 상수만. 커밋을 못 읽으면 전부 모르는 쪽.
- 판정 러너 · Red 확인의 고정 문구는 상수로 나와 있다(`judge/report.ts` · `runner.ts` · `steps/red-check.ts`). 그 글자를 바꾸면 사유 변환도 함께 본다.
- 단계 결과(`exitDetail`)에는 Red 확인의 원문이 그대로 저장된다. `run.get` 응답으로 앱 main · 렌더러 · CLI에 가지만 렌더러는 그리지 않는다(CLI는 원문을 보인다). **Red 확인 결과의 글을 세션 입력에 싣는 새 자리는 이 대조를 지나야 한다**(구조 시험이 `'red_check'`를 읽는 파일 목록을 고정한다. 글자 대조라 토큰을 피한 자리는 못 잡는다).
- 한계(ADR-128, 후속 이슈 후보): 런타임 수집 오류의 고칠 단서가 위치와 고정 문구뿐이라 회귀가 헛돌 수 있다. 테스트 작성 세션이 받는 `routes.md`에 구현이 만든 라우트 폴더 이름이 거르지 않고 실리고(줄 나눔 · 개수 · 길이 상한 없음), `prisma/schema.prisma` 사본은 바이트 그대로이고 상한이 없다.

### M3-46 (#290, PR #291, main `89d9122`, ADR-130, 문서만)
- **M3-04(#49)는 계약 등록 · contract 검사 규칙 · 규범 입력까지**다. 계약 검사 실행기는 종류별 행으로 나뉘었다: M3-47 #292(OpenAPI: `@redocly/cli lint` + 판정 서버 앞 `@stoplight/prism-cli proxy --errors`. **검사 단계가 `contract` 규칙을 실행기로 판정하는 연결과 "실행기 없는 종류는 판정 없음 · 통과로 세지 않음 · 다른 규칙을 막지 않음"도 이 행**) · M3-48 #293(Prisma, **보류**: 사람 결정 #287 전에는 잡지 않는다) · M3-49 #294(AsyncAPI, 유효성만, `@asyncapi/cli` 대신 쓸 도구를 ADR로).
- 도구 실측(ADR-130): `@redocly/cli@2.77.0`은 cwd가 프로젝트 안이면 `redocly.yaml`의 플러그인 JS를 실행하고 원격 `$ref`를 받아 온다(`REDOCLY_TELEMETRY=off`). `@stoplight/prism-cli@5.16.0` 패키지 211개. `prisma@7.10.1`은 설치 스크립트가 엔진을 외부에서 받고 `migrate diff`가 datasource 오류에도 종료 코드 0을 낸다. `@asyncapi/cli@6.2.3`은 패키지 1047개 · 350MB · 익명 사용 기록.
- M3-06(#51, 실행 유형 B · C · D)은 M3-03 · M3-04 · M3-47에 기댄다.
- 후속 행: M3-50 #295(테스트 작성 세션의 `routes.md` · `prisma/schema.prisma` 사본 방어, ADR-131 예정) · M3-51 #296(구조 검사 실패 원인의 표시: 겹친 파일 목록, 옛 프로젝트 안내, 구현 세션 사유의 머리 문장).
- 내장 규칙의 생성 주체 "시스템"은 명세에 없어 행으로 만들지 않았다(사람 결정 후보).
- 다음 ADR 번호: 129는 PR #289, 131은 #295, 그다음 132. 다음 마이그레이션 0025(0024는 PR #289).

### M3-04 (#49, PR #289, main `10a5348`, ADR-129, 마이그레이션 `project/0024_contracts`)
- **저장**: 표 `contracts(id, display_id CON-NNN, kind, source_file UNIQUE, content_hash, source_commit, parent_requirement_id, author, created_at)`. 내용은 저장하지 않는다. 수정 · 삭제 · 덮어쓰기 거부 트리거(고치는 길은 M3-10이 새 마이그레이션으로 연다). `ProjectStore.contracts`(`create` · `get` · `list`). 깨진 행은 `get` · `list`가 던진다(건너뛰지 않음).
- **0024는 `confirmations` 표를 다시 만들었다**(엔터티에 `Contract`, 근거에 `contract_record`). 다시 만든 객체: 0012의 트리거 넷 · 0019의 `confirmations_release_recorded` · 다른 표의 `norm_changes_unconfirmed`. **`confirmations`를 다시 만드는 뒤 마이그레이션은 이 목록을 따른다.** 다음 마이그레이션 번호는 0025.
- **등록**(`contract.register`, 사람 주체만, `ipc/contract-handlers.ts` → `norms/contract.ts`): 트랜잭션 1개로 계약 → 승인 기록(`contract_edit` + `{before: null, after}`) → `contract` 검사 규칙 → 규범 변경 기록 `created`(오케스트레이터, 고정 사유) → 확인됨(근거 `contract_record`). 종류는 OpenAPI · DB 스키마(`.prisma`) · AsyncAPI뿐. 같은 파일 다시 등록은 -32009.
- **파일 읽기**: 작업 트리가 아니라 기준 브랜치 커밋의 git 객체(`readContractSource`, `--no-replace-objects`, `--` 구분, 일반 파일만, 4 MiB, UTF-8). 해시는 그 바이트의 SHA-256. 경로 글자 검사는 git을 부르기 전(영문 · 숫자 · `. _ - @ +`만, `.git` · `..` 구간 거부, 1024자).
- **`contract` 검사 규칙**: 계약마다 하나, `builtin: true` · `contractId` = 그 계약 · 부모 요구사항 없음 · 미확인 · 자동 시작 없음. 제목 "계약 일치: CON-NNN"(고정 글). 내장 규칙의 보호를 그대로 받는다([실행] 대상 거부 -32009, 사람 편집 · 에이전트 폐기 · 대체 · 이의 거부). **검사 단계는 지금 이 규칙을 인수 테스트 판정 대상(`testedRules`)에 두지만 폴더가 없어 판정하지 않는다: 실행기를 붙일 때(M3-47) 구조 규칙처럼 인수 테스트 대상에서 뺀다.** 준수 지표에서는 판정 가능 분모에 들고 "판정 없음"(통과로 세지 않음).
- **판정 기록의 실행기 값은 아직 없다**: M3-47이 0023처럼 `judgments.runner`를 넓힌다(색인 2 · 트리거 4 복원). 판정 커밋의 같은 경로를 `readContractSource`와 같은 방식으로 읽어 등록 해시와 비교할 수 있다.
- **조회**(`contract.list`): `{contracts: [{contract, rule, source}]}`. `source`는 지금 기준 브랜치의 파일과 비교한 `same` · `changed` · `missing` · `unreadable`. 구현 역할은 실행 워크트리에서 계약 파일을 쓸 수 있다(쓰기 금지 목록에 없다).
- **규범 입력**(`norms/norm-input.ts`): 계약이 있으면 규칙 절 뒤에 계약 절(표시 ID · 종류 · 원본 파일만, 상한 50건, 넘치면 머리줄 `… 상한 50건, 최근 등록 순)`). 계약이 없으면 작업 지시가 글자까지 그대로.
- **확인**: 사람의 확인 RPC · 확인할 것 목록은 요구사항 · 규칙만 받는다(`confirmation.set`에 계약을 주면 -32602). 계약 검사 규칙은 미확인 규칙으로 확인할 것에 뜬다.
- 에이전트의 계약 반영 도구는 없다(내부 함수 `reflectAgentContract`만 있고 부르는 제품 코드 없음, 구조 시험).
- CLI: `pnpm --filter @bive/app cli contract register <dir> <file> <kind> [요구사항 ID]`.
- 한계(ADR-129): 오류 글 "내장 구조 규칙"이 계약 검사 규칙에도 나온다, 부모 요구사항이 삭제돼도 계약은 그대로, `contract.list`가 계약마다 git을 세 번 부른다, DB CHECK가 계약의 확인 근거로 `approval_log`도 받는다(M3-05에서 검토), `rules_contract_rule` 트리거는 INSERT만 막는다(M3-10에서 검토).

### M3-50 (#295, PR #298, main `438a630`, ADR-131, 마이그레이션 없음)
- **`routes.md`**(`test-writer/inputs.ts`의 `renderRoutes`): 라우트가 지난 폴더 이름(경로 그룹 포함, `RouteEntry.folders`)을 모두 `isSafeRouteSegment`로 본다(길이 100자 → 선형 정규식. 받는 꼴: `[A-Za-z0-9._%-]+`, `[x]` · `[...x]` · `[[...x]]`, `(이름)`, `@이름`, 가로채기 표기). 패턴 밖 이름이 하나라도 있거나 경로가 200자를 넘으면 그 경로를 통째로 빼고 머리에 수만 적는다(원문은 어디에도 없다). 상한(`ROUTES_LIMITS`): 항목 50건 · 줄 합 4000자. 경로 → 종류의 코드 단위 순으로 싣다가 상한에 닿으면 **멈추고** 넘친 수를 머리에 적는다. 머리 문장은 상수 `ROUTES_NOTICES`.
- **`prisma/schema.prisma` 사본**: 1 MiB 상한. `lstat` 크기 확인 → `O_NOFOLLOW | O_NONBLOCK`로 열기 → `fstat` 일반 파일 확인 → 상한 + 1바이트까지만 읽기. 넘침(`too_large`) · 상위 `prisma/` 또는 파일이 링크 · 일반 아님(`not_regular`) · 열지 못함(`unreadable`)이면 **사본 없이** `routes.md` 머리의 고정 문장으로 알린다. 내용은 바이트 그대로(거르지 않는다).
- 라우트 나열은 링크 폴더를 따라가지 않는다(`src`가 링크여도). `prisma` · `src`가 일반 파일이면 던지지 않고 사본 없음 · 라우트 없음.
- 한계(ADR-131 남는 길): `route.*` 파일을 크기 상한 없이 읽는다(내용은 싣지 않음), 라우트 나열에 개수 · 깊이 상한이 없다(폴더 10만 개에서 약 1초), 상위 폴더 확인과 열기 사이의 틈, 비ASCII 폴더 이름의 라우트는 수로만 보인다, 스키마 주석에 구현 역할이 글을 쓸 수 있다.

### M3-05 (#50, PR #300, main `97c8b50`, ADR-133, 화면만)
- **계약 화면**(사이드바 > 기획 > 계약, `renderer/src/screens/contracts/` + `screens/norm-detail/ContractDetail.tsx`): 값은 `contract.list` · `rule.list {projectId}`(검사 규칙 ID로 최신 판정을 붙인다) · 상세의 `requirement.get`에서만 온다. 오케스트레이터 · store · shared · 다리 변경 없음.
- 카드 1줄 = 원본 파일, 2줄 = 표시 ID · 예외 · 등록 시각. **결함** = 스키마 불일치(검사 규칙의 최신 판정이 실패) · 검사 규칙 없음(`rule === null`). 미판정 · 격리 · 재검증 필요는 결함이 아니다. 예외 순서는 결함 다음 미확인이고 둘 다 [문제만]에 잡힌다.
- 필터 칩 4종: 종류 · 검사 규칙(있음 · 없음) · 판정 · 확인. 종류 표시명 표는 app의 `CONTRACT_KIND_LABELS`.
- **보이지 않는 것**: 기준 브랜치와의 어긋남(`source`) · 등록 해시 · 커밋(M3-10이 정함). **없는 것**: 계약의 [확인](확인 RPC가 계약을 받지 않는다. 미확인 계약이 생기는 경로를 여는 이슈가 RPC · 확인할 것 · 상세의 [확인]을 함께 연다) · 지시 입력.
- 다시 읽기: 실행 알림 · 규범 변경 알림 · 재접속(`NORM_VIEW_EVENT_NAMES`). 늦게 온 응답은 요청 순번으로 버린다(`useContracts.ts`).
- e2e의 "아직 없는 화면" 예는 이제 추적성 맵이다(`layout` · `scr-01` · `reconnect`).
- 한계(ADR-133): 검사 규칙이 폐기되면 판정이 "없음"으로 보이고 결함으로 안 잡힌다(지금은 폐기 경로 없음), 부모 요구사항이 삭제돼도 표시 ID가 보인다.

### M3-16 (#61, PR #301, main `227b070`, ADR-134, 마이그레이션 없음)
- **`rule.get`만** `latestRun: {id, displayId, costUsd, turns} | null`을 더 싣는다(shared `RuleLatestRun` · `RuleGetResult`, 선택 칸). `rule.list` · `rule.update` 결과에는 없다(목록 N+1 방지).
- **최신** = 그 규칙을 대상으로 한 실행(`run_target_rules`) 가운데 표시 ID 순 마지막(`RunRepository.latestTargeting`, `ORDER BY length(display_id) DESC, display_id DESC LIMIT 1`, 색인 `run_target_rules_rule`). 생성 시각은 쓰지 않는다. 실행 이력(`judgment.list`, 판정 시각 순)과 어긋날 수 있다(판정 없는 진행 중 실행).
- **합계** = 기존 `runs.usage(runId).run`(ADR-067). `costUnknownCount > 0`이면 비용 `null`, `turnsUnknownCount > 0`이면 턴 `null`, 세션 0건이면 둘 다 `null`(shared `usage.ts`의 합 함수가 빈 입력에 `null`). 0은 기록이 실제로 0일 때만.
- **화면**(규칙 상세, 확인 상태 다음 줄 "최신 실행"): `EXE-NNN` · `비용 $0.35` · `턴 11`. 값이 없으면 "비용 없음" · "턴 없음", 실행이 없으면 "없음", 못 읽었거나 응답에 칸이 없으면 "최신 실행 불러오기 실패". 글자만이고 누를 수 없다(실행 추적 화면이 없다). 비용 형식은 검증 화면의 `formatUsd`.
- 다시 읽기: `event.run.updated` · `event.step.updated` · 재접속(공용 `useEventRefresh`). 늦은 응답은 요청 순번으로 버린다. `RuleDetail`은 `key={rule.id}`로 규칙마다 새로 마운트된다.
- 한계(ADR-134): 검증 화면 목록의 실행 링크는 하한을 그대로 보여 두 화면이 다를 수 있다, 진행 중 · 결과 없이 끝난 세션이 있는 실행은 "없음", 세션 행이 깨지면 `rule.get` 전체가 오류(화면은 최신 실행 줄만 실패 표시). 다른 e2e 파일(scr-03 · scr-17 등)의 가짜 응답에는 `rule.get`이 없어 상세에 "최신 실행 불러오기 실패"가 보인다(제품에서는 생기지 않는 상태).

### M3-47 (#292, PR #299, main `512bfe1`, ADR-132, 마이그레이션 `project/0025_contract_judge_runner`)
- **OpenAPI 계약 검사 규칙이 판정된다**(검사 단계 · 병합 재검사). 실행기 값 `redocly-prism`(shared `JudgeRunner`, `judgments.runner` CHECK 넓힘). DB 스키마 · AsyncAPI는 실행기 없음 → 판정 없음(`no_runner`).
- **모듈**: `orchestrator/src/contract-check/`(`tool.ts` 도구 실행 · `openapi-document.ts` 바깥 참조 사전 검사 · `openapi.ts` lint · `recorder.ts` 기록 프록시 · `prism.ts` 재생 검증), `steps/contract-check.ts`(판정 규칙 · `trafficVerdict` · `missingContractVerdicts` · `contractPlanOf`), `judge/runner.ts`의 선택 인자 `serverProxy`, `norms/contract-source.ts`(`readContractBlob`: 커밋 하나에서 읽기), `runner/contract-tool.mjs`(도구 진입 스크립트: 표준 입력이 닫히면 끝남).
- **판정할 문서** = 등록 커밋(`Contract.sourceCommit`)의 git 객체 + 등록 해시 대조. 판정 커밋 · 작업 트리의 계약 파일로 판정하지 않는다(구현 역할이 쓸 수 있다).
- **결과**: `pass` = 형식 오류 0건 + 계약 안 요청 1건 이상이 모두 통과. `fail`(구현 회귀, 구조 검사 실패와 같은 길) = 계약과 다른 응답(`response_mismatch`) 또는 검증하지 못한 요청(`response_unverified`: prism이 못 다룬 응답 · 불완전한 기록 · 건수 상한 초과 · 요청 쪽 사유). `fail`(막지 않음) = 등록 문서의 형식 오류. 판정 없음(막지 않음) = `no_runner` · `external_reference` · `no_operations` · `source_unreadable` · `no_traffic`. 도구 오류 = 판정 안 하고 `judge_runner_error`(`stage: contract`).
- **계약 검사 규칙은 인수 테스트 판정 대상(`testedRules`)에서 빠진다**(구조 규칙처럼). 실행 유형별 단계 구성 · 내장 규칙의 `run.create` 거부는 그대로(M3-06이 정한다).
- **기록 프록시**: 트래픽 검증이 필요한 계약이 있을 때만 판정 서버 앞에 낀다(127.0.0.1, 바이트 그대로). 교환 2천 개 · 본문 4 MiB 상한. 교환 번호는 요청이 들어온 순간의 카운터(동시 요청끼리 겹치지 않음). 재생은 판정 뒤 `prism proxy --errors`에 차례로, 교환은 `x-bive-exchange` 머리로만 가린다.
- **도구 격리**: 프로젝트 밖 빈 도구 폴더, BIVE 설정만(`--config`), 부모 환경 변수 넘기지 않음, 바깥 참조 사전 차단(`$ref` · `$dynamicRef` · `$recursiveRef` · `operationRef` · `externalValue` · 판별자 `mapping` · `defaultMapping`. 대응 값으로 받는 스키마 이름은 `isPlainSchemaName`: `A-Za-z0-9._-`만, `.yaml` · `.yml` · `.json` 끝 거부).
- **의존성**: `@redocly/cli@2.77.0` · `@stoplight/prism-cli@5.14.2` + 루트 `pnpm.overrides`(prism 하위 패키지 고정. 5.15+는 Node 24 필요). Node 24로 옮기면 다시 본다.
- **픽스처**: `fixtures/sample-next-app/openapi.yaml`(`GET /api/health` · `GET /api/auth/session`), 변형 `scripts/make-variant.sh contract-mismatch`.
- **CI 시간 주의**: `contract-runner.test.ts`가 판정 묶음(파일 하나씩)에 들어 단위 테스트가 길어졌다. 수정 2회차 중 `checks` 잡이 20분 제한에 한 번 걸렸고(단위 테스트 11분), 응답 모양 일곱 사례를 함께 돌리게 바꾼 뒤 약 14분 30초다. 오케스트레이터에 무거운 시험을 더하는 이슈는 이 여유(약 5분)를 본다.
- 한계(ADR-132): 작업마다 다뤘는지는 보지 않는다, 요청은 검증하지 않는다, 계약에 적힌 3xx와 4 MiB 넘는 응답은 실패로 닫힌다, 인수 테스트가 앱 코드를 불러오면 요청이 프록시를 지나지 않을 수 있다(#117 계열), 패키징된 Electron 앱의 도구 경로는 확인하지 못함.

### M3-42 (#283, PR #302, main `800a7ea`, ADR-135, 마이그레이션 없음)
- **`run.list`의 선택 인자 `ruleId`**: 그 규칙이 대상인 실행 ∪ 그 규칙의 판정 기록이 있는 실행(`RunRepository`의 규칙 기준 질의, 색인 `run_target_rules_rule` · `judgments_rule_latest`, 표시 ID 순, 깨진 행 건너뜀). 없는 규칙 · 다른 프로젝트의 규칙은 -32004. `status`와 함께 주면 둘 다 적용. 인자 없는 호출은 그대로. 앱에서 `run.list`를 부르는 곳은 규칙 상세의 `useRuleRuns` 하나(`{projectId, ruleId}`).
- **요구사항 화면의 `rule.list`**: 알림 · 재접속에는 화면의 `{projectId, includeRetired: true}` 한 번만. 열린 상세의 자식 규칙(`useChildRules`)은 그 결과에서 `retirement` 없는 항목을 골라 쓴다. 상세를 열 때 · 편집 뒤의 자체 읽기는 그대로. 늦은 옛 응답은 `replaced` 횟수로 버린다(이 방어는 시험으로 고정하지 못함: ADR-135 한계).
- **새 알림 `event.blocks.changed {projectId, version}`**: `blocks.set`이 커밋된 뒤에만(`ipc/block-handlers.ts`의 `onChanged`, `events/block-events.ts`). 거부 · 되돌려진 저장에는 없다. 선언을 쓰는 경로는 `blocks.set` 하나(구조 시험). 앱은 `BLOCK_EVENT_NAMES`(공용 `useEventRefresh`)로 `blocks.get`을 다시 읽는다(`useBlockDeclaration`). 저장소 밖 DB 편집에는 알림이 없다.
- **실행 이력 줄**: 접히지 않는 폭(상세 내용 폭 400px 초과)에서 flex-wrap, 상태 칸은 `nowrap` · 줄어들지 않음. 남는 폭에 안 들어가면 칸째 다음 줄로 내려간다(1480px 창에서는 모든 줄이 그렇다). 실행 추적 화면(SCR-16)이 생기면 다시 본다.
- 한계(ADR-135): 규칙 기준 조회에 상한 없음, 판정 50건 밖의 실행은 줄이 없음, e2e의 "1회" 단언은 `judgment.list` 호출 수와의 상대 비교(StrictMode 이중 마운트). 가짜 브리지(`bive-mock`)는 `rule.list`의 `includeRetired`를 무시한다.

### M3-52 (#305, PR #306, main `ea883a7`, ADR-138)
- CI 잡 제한 시간: `checks` 30분(전 20분), `pipeline-e2e-group` 40분(전 30분). 집계 잡 `pipeline-e2e` · `ci`는 5분 그대로. `scripts/test_ci_workflow.py`가 이 값과 `needs`를 단언한다(값을 바꾸려면 시험도 함께).
- 실측(2026-11-26): `checks` 14 ~ 19분, 묶음 12 ~ 21분. 러너 편차가 크다(같은 커밋이 35 ~ 55% 느려진 적 있음). `checks`가 25분을 넘기 시작하면 단위 테스트를 따로 잡으로 나누거나 무거운 시험을 줄인다(ADR-138).
- main의 ADR 끝은 지금 135 · 138이다(136 = PR #303, 137 = PR #304가 채운다).

### M3-06 (#51, PR #303, main `50372e6`, ADR-136, 마이그레이션 · 앱 코드 변경 없음)
- **단계 계획**(shared `RUN_STEP_PLANS`): 생략 단계도 계획에 두고 엔진이 실행기를 부르지 않고 `skipped`(`{reason: 'run_type', runType}`)로 기록한다. B: 승인 · 테스트 작성(생략) · Red(생략) · 구현 · 검사 · 변이(생략) · 병합 · 화면. C: 승인 · 테스트 작성 · Green · 구현(생략) · 검사 · 변이(생략) · 병합 · 화면. D: 승인 · 테스트 작성(생략) · Red(생략) · Green(= 기준 검사, `green_check` 종류 재사용) · 구현 · 검사 · 병합 · 화면. 변이는 지금 모든 유형에서 `skipped`(M3-07).
- **회귀**: B · D는 구현 · 검사 실패 → 구현. C는 Green 미충족 → 테스트 작성(재시도 수, 상한 뒤 `test_retry_limit`), 검사 실패 → 테스트 작성(`regressionCount`). D의 기준 검사 미충족은 회귀 없이 `step_unmet`. 최악 세션 수: A 테스트 작성 3 + 구현 3, B 구현 3, C 테스트 작성 5, D 구현 3. 검사 실패 판단 세션(ADR-118)은 유형 A만.
- **`run.create`**(`runs/run-service.ts`의 `resolveRunType`): 선택 인자 `type`. 없으면 유도(인수 테스트 검사 규칙만 = A, 정적 검사 규칙만 = B, 섞이면 -32009). C · D는 명시할 때만. 정적 검사 규칙 = `builtin`인 구조 규칙 · 계약 검사 규칙(`isStaticCheckRule`: 사람 규칙의 검사 종류가 `structure`여도 아님). B는 정적 검사 규칙만, A · C · D는 인수 테스트 검사 규칙만. 실행기 없는 계약 종류는 B로도 거부. 자동 시작 · 다시 시작 · 편집 뒤 시작은 유형 A 그대로(유형 C 자동 시작은 M3-30).
- **유형 B**: 구현 단계에서 판정하지 않는다. 검사 단계와 병합 재검사 모두 대상 규칙의 판정이 `pass`여야 한다(`steps/run-type.ts`의 `unjudgedStaticTargets`: 판정 없음 · 막지 않는 실패 → 검사 `step_unmet`, 재검사 실패). 대상 밖 규칙의 막는 실패도 막는다. 인수 테스트 보호는 기준 커밋 대비 `bive-acceptance/` 변경 없음(추가 · 삭제 · 수정).
- **유형 C**: Green 확인은 `judgeCommit` + `evaluateGreen`(대상마다 케이스 1개 이상 전부 `passed`. skip · todo · 0건 · 수집 오류 · 러너 오류는 통과 아님). 소스 변경 거부 세 겹: 테스트 작성 세션의 경로 가드, Green 확인 전 대조, 병합 직전 대조(`isTestOnlyPath`: 대상 규칙 폴더와 BIVE 선언 파일만).
- **유형 D**: 기준 커밋을 새로 판정. 막는 판정 전부 `pass` · 대상 판정 있음 · 수집 오류 없음이어야 Green. 판정 없음은 통과로 세지 않지만 막지도 않는다. Green이 아니면 구현 세션 0회 · 커밋 · 병합 · 판정 기록 0건. 대상은 인수 테스트 검사 규칙만.
- 화면: 내장 규칙 [실행]이 유형 B 실행을 만든다(앱 요청은 그대로). 파이프라인 표시는 생략 단계를 "생략"으로, `green_check`를 "Green 확인"으로 보인다.
- 파이프라인 e2e `run-type-b.test.ts` + 시나리오 `scenarios/run-type-b.yaml`(묶음 2). 등록된 프로젝트 폴더는 미추적 `.bive.json` 때문에 `scripts/make-variant.sh`를 쓸 수 없어 변형 내용을 사람 커밋으로 올린다.
- 한계(ADR-136): 인수 테스트가 하나도 없는 프로젝트에서 B · D는 닫힌 쪽으로 끝난다, 유형 C는 통과하는 테스트면 병합된다(변이 재주입 전까지), 유형 C의 검사 실패 사유가 다음 테스트 작성 세션에 전달되지 않는다, D의 구현 세션에 작업 지시를 넘기는 길이 없다, C · D를 만드는 화면 경로가 없다(RPC · CLI만), 승인 기록 `run_start`는 유형을 싣지 않는다.

### M3-11 (#56, PR #304, main `e5e3a09`, ADR-137, 마이그레이션 없음)
- **추적성 결함의 정의는 `orchestrator/src/verification/summary.ts` 한 곳**(`requirementsWithoutRules` · `parentlessRuleDefects` · `traceabilityOf`). 효력 판정은 `norms/effective.ts`의 `isEffectiveRule` 그대로. 규칙 없는 요구사항 = 효력 있는 자식 규칙이 없는 요구사항(자식이 모두 폐기 포함, 규칙 작성 중 포함). 부모 없는 규칙 = 효력 있는 비내장 규칙의 부모가 `null`이거나 삭제됨. 뺌: 규칙화 불가 · 삭제된 요구사항, `builtin` 규칙(구조 · 계약 검사), 폐기 · 삭제 규칙.
- **응답**: `rule.list` 결과에 `traceability`(선택 칸), `verification.summary`에 `traceability` · `unrulable{count,total}`(필수 칸). 화면은 서버 값만 쓰고 다시 세지 않는다.
- **`requirement.markUnrulable({projectId, id, reason, author})`**: 사람만(에이전트 -32020), 공백만인 사유 -32001 `UNRULABLE_REASON_REQUIRED`, 4000자 초과 -32001, 없는 요구사항 -32004, 삭제됨 · 이미 표시됨 · 효력 있는 자식 규칙 있음 -32009(`data.reason`). 승인 기록 없음(ADR-100 A2: 요구사항의 사람 편집은 승인 기록에 쓰지 않는다), 같은 트랜잭션에서 확인됨. 풀기 없음. 규칙 작성 세션 · 재판단을 띄우지 않는다.
- **화면**: 요구사항 상세 [규칙화 불가] + 사유 입력(공백만이면 [확인] 비활성, 요청 중 한 번만). 요구사항 카드 예외 '추적성 결함' · '규칙화 불가'(규칙화 불가가 앞선다), 규칙 카드 예외 '추적성 결함'(부모 없는 규칙). 검증 화면 카드 "규칙화 불가 비율 N / M"(분모 0이면 '없음') · "추적성 결함 N"(부모 없는 규칙 포함, 누르면 요구사항이 상태 필터로 열림). 요구사항 화면은 규칙 작성 알림에도 `rule.list`를 한 번 읽는다.
- 시나리오 `scenarios/no-rules.yaml`.
- 한계(ADR-137): 표시 뒤에도 규칙 작성 세션이 뜰 수 있어 "규칙화 불가이면서 규칙 있음"이 될 수 있다(대기 · 진행 중이던 세션, 마지막 시도가 생략 · 실패인 요구사항을 고칠 때), 검증 화면은 규칙 작성 알림 · 요구사항 변경에 다시 읽지 않는다, 추적성 결함 카드 수와 그 카드로 연 요구사항 목록 수가 다를 수 있다(부모 없는 규칙), 뒤의 요구사항 편집이 수정 시각을 덮어 표시 시각이 사라진다.

### M3-52 · M3-53 뒤의 로드맵 사실 (PR #309, main `0c5fa5b`, ADR-141)
- M3-07(#52)은 수용 기준 1 · 2 · 4번만 맡는다. 3번(변이 주입 단계 켜기 · 변이 생존의 자동 유형 C 보강 · 재주입 · `mutant-survives`)은 **M3-54(#311)**. M3-08(검토 대기열)은 M3-54를 기다린다. 규칙 카드 예외 '변이 생존' · 변이 필터 칩 · `rule.list`의 변이 상태 칸은 M3-15의 몫.
- ADR-141의 결정(M3-54가 구현): 시작 근거 = 변이 결과 기록(생존)을 원인으로 하는 새 원인 종류(마이그레이션), 보강 표시 = 실행과 변이 결과를 잇는 새 표, 변이 글 = ADR-128 방식 자료로 테스트 작성 세션에, 예산 소진 = 기존 규칙, 재주입 = 같은 변이 다시 적용, 보강의 고리 · 중복 방지.

### M3-07 (#52, PR #308, main `6a356b4`, ADR-139, 마이그레이션 `project/0026_mutation_results`)
- **제품의 변이 주입 단계는 아직 `skipped`다**(`DEFAULT_STEP_EXECUTORS.mutation` = `skipMutationStep`). `steps/mutation.ts`의 `createMutationExecutor`는 시험에서만 돈다. 켜는 것은 M3-54(#311).
- **역할 `mutator`**(표시명 "변이 주입", `STEP_ROLES.mutation`). 세션 폴더: `rules/<ID>.md`(대상 규칙 제목 · 진술) + 대상 블록 include에 드는 판정 커밋 파일의 사본(git 객체에서, 일반 blob만, 200개 · 4 MiB 상한, 넘치면 빠진 수를 작업 지시에). 인수 테스트는 사본에서 빠지고 경로 가드가 이 역할의 `bive-acceptance/` 읽기 · 목록을 거부한다. 규범 입력 · 케이스 이름은 주지 않는다. 도구: `read_file` · `list_files` · `search_files` · `propose_mutant`(쓰기 없음).
- **`propose_mutant {path, search, replace}`**(`mutation/mutant.ts`): `search` 1 ~ 2000자, `replace` 0 ~ 2000자, 같은 글 거부, 세션마다 1개(받으면 실행기가 닫힘). 거부: 블록 밖(선언과 같은 매처), 인수 테스트, 숨김 경로, `node_modules`, 루트 `prisma/`, 패키지 · 잠금 파일, `*.config.*` · `tsconfig*`, 계약 원본, `..` · 절대 경로 · 역슬래시, 커밋에 없는 파일, 1 MiB 초과 · 글이 아님, 바꿀 글 없음 · 여러 번 나옴. 도구 호출 기록에는 경로만 남는다.
- **판정**: `judgeCommit`의 선택 인자 `applyMutant`(해시 대조 뒤 · 설치 전에 격리 체크아웃의 파일을 바꿈, 커밋하지 않음). 대상 규칙의 인수 테스트만. 대상 케이스 하나라도 실패 = `killed`(변이 검증됨), 모두 통과 = `survived`(변이 생존, 실행은 그대로), 변이 없음 · 케이스 0 · skip만 · 체크아웃 · 설치 · 수집 · 러너 오류 = 변이 미검증(결과 값으로 구분). 인수 테스트 변조 = 기록 없음 + `guard_violation`.
- **저장**: 표 `mutation_results`(0026: 상태와 결과의 짝 CHECK, 추가 전용 트리거 3개), `MutationResultRepository`. 쓰는 곳은 `steps/mutation.ts` 한 곳. 기록이 없으면 '변이 미검증'.
- **대상과 순서**: 실행의 대상 규칙만. 위험도 high → medium → low → 없음, 같으면 표시 ID 순(길이 → 글자). 대상 아님: 내장 규칙 · 블록 선언 없음 · 대상 블록 없음 · 인수 테스트 없음. 예산 소진이면 실행 `budget_exceeded`(병합 없음).
- **설정**: SCR-21에 "변이 주입" 행. `RUN_REQUIRED_ROLES`에 `mutator` → **모든 유형의 실행 생성 · 자동 시작이 이 칸을 요구**(기본값 없음, 옛 설정은 사람이 채울 때까지 `SETTINGS_INCOMPLETE`). 시험 도우미 `COMPLETE_SETTINGS`와 e2e 가짜 설정은 채워져 있다. 예산 스냅샷의 변이 주입 역할은 유형 A · C에만(유형 B의 변이 단계는 생략 단계, 사유 `run_type`).
- 한계(ADR-139)와 M3-54로 넘긴 것: 변이를 받은 뒤 세션을 끝내는 장치 없음, 서버를 죽이는 변이가 '검증됨'으로 세어짐(판정 러너는 서버 프로세스를 쥐고 있어 가를 수 있다), 세션 폴더의 `rules/<ID>.md`가 블록 include `rules/**`의 사본과 겹칠 수 있음, include `**` 블록의 인수 테스트 사본 제외 시험 · 저장 한 곳 구조 시험 없음, `prisma` 거부가 루트 폴더만 봄, 설정 화면의 "변이 주입" 행 머리가 고정폭 글꼴.
- **CI 시간**: 이 PR 뒤 `checks`가 21 ~ 22분(제한 30분, ADR-138의 다시 보는 선 25분). 무거운 단위 시험을 더하는 이슈는 시간을 재고 보고한다.

### M3-29 (#231, PR #310, main `08bf069`, ADR-140, 마이그레이션 없음)
- **규범 입력의 대상 블록 고르기**(`norms/norm-input.ts`의 `blockScopeOf`, `collectNormInput`의 넷째 선택 인자 `{ blockBasisRuleIds }`). 고르는 때: 효력 있는 요구사항 · 규칙 · 계약 가운데 **어느 종류든 기존 상한(`NORM_INPUT_LIMITS`, 각 50)을 넘고**(ADR-100 K1의 "규범이 많아지면"), 블록 선언이 있고, 기준 규칙이 모두 대상 블록을 가질 때. 그 밖(상한 안 · 선언 없음 · 기준 없음 · 기준 규칙 하나라도 대상 블록이 빔 · 없는 규칙 ID)은 전체이고 글자까지 예전과 같다.
- 세션별 기준: 규칙 작성(새 요구사항 · 다시 시도) = 없음 → 늘 전체. 요구사항 재판단 = 효력 있는 자식 규칙. 테스트 작성 · 구현 = 실행의 대상 규칙. 이의 판단 = 이의 대상 + 실행의 대상 규칙. 검사 실패 판단 = 실행의 대상 + 실패한 규칙. 유형 B(내장 규칙 대상)는 대상 블록이 비어 전체. 역할 목록은 하드코딩하지 않았다(새 역할은 부르는 쪽의 초점 규칙이 기준).
- 겹침 = 대상 블록 이름이 정확히 같음(`dependsOn`으로 넓히지 않음). 늘 넣는 것: 대상 블록이 빈 규칙(내장 구조 · 계약 검사 · 옛 규칙), 초점 요구사항, 고른 규칙의 부모, 효력 있는 자식 규칙이 없는 요구사항. 계약: 검사 규칙 · 부모 요구사항이 고른 범위에 든 것 + 둘 다 없는 것(지금은 사실상 전부).
- 먼저 고르고 그다음 기존 A15 줄이기. 세션 기록 `SessionNormInput`에 선택 칸: 종류별 `outOfBlock`, `summary.blocks`. 고른 세션에만 자료 첫 줄의 고정 문장(`normInputScopeLine`)과 머리말의 수.
- 검사 단계 · 병합 재검사는 그대로(효력 있는 규칙 전체 판정): 최종 방어선.
- 한계(ADR-140): 이름 기준 겹침이라 간접 영향을 못 본다, 판단 세션의 대체 도구가 만든 새 규칙과 블록 밖 규칙의 모순을 그 세션이 못 본다, 인용 검사는 효력 있는 규칙 전체를 기준으로 봐 세션이 못 본 규칙과 겹치는 조각이 거부될 수 있다, 판단 기록의 `input`은 블록 밖 수와 상한으로 잘린 수를 구분하지 않는다.

### M3-31 (#259, PR #312, main `e59a4dd`, ADR-142, 제품 코드 변경 없음)
- **구조 시험이 구문 트리 + 타입 검사기로 잡는다**(`orchestrator/test/helpers/source-structure.ts`, `integrity.test.ts`의 M3-31 절). 기존 정규식 시험과 허용 목록은 그대로이고 새 시험은 "구문 트리가 찾은 파일 = 정규식이 찾은 파일"을 단언한다(허용 목록은 기존 시험 한 곳).
- 잡는 것: 저장소 접근(`normChanges` · `rules.create` · `ruleRetirements` · `confirmations`)과 확인 서비스 · 규범 입력 · 규칙 작성 서비스 모듈의 사용을 별칭 · 구조 분해 · 대괄호 · 동적 import · 큰따옴표 · `export … from` · 네임스페이스 · 다시 내보내기 사슬 · 타입을 지운 값의 흔치 않은 이름으로 써도. 날 SQL(네 표에 쓰는 문장: 오케스트레이터 · app · shared · parser의 src, 주석 · 네 가지 따옴표 · 색인 지정 포함)과 오케스트레이터의 `store.db` · SQLite 모듈 사용. 종료 상태 리터럴(오케스트레이터 src 전체, `engine/run-ending.ts`만 제외: 삼항 · 변수 · 스프레드 · 계산 키. 허용은 정확한 경로의 선언 기준).
- **새 코드를 쓸 때**: 실행의 실패 쪽 종료 상태는 `runEnding`을 거친다(어느 폴더에서든 `{ run: { status: 'failed' … } }`를 직접 쓰면 빨강). 네 표에 쓰는 SQL은 store 패키지 안에서만. 허용 목록을 넓혀야 하면 멈추고 보고.
- 못 잡는 형태와 그 성질을 지키는 행동 시험 이름은 ADR-142의 표. 대상은 `.ts`만이다. `integrity.test.ts` 단독 약 15 ~ 20초.

### M3-54 (#311, PR #313, main `bb8bd53`, ADR-143, 마이그레이션 `project/0027_mutation_reinforcements`)
- **제품의 변이 주입 단계가 켜졌다**(`DEFAULT_STEP_EXECUTORS.mutation` = `createMutationExecutor`). 유형 A = 새 변이(대상 없으면 `skipped` `no_mutation_targets`), B = 계획에서 생략, C 보강 = 재주입, C 보강 아님 = `skipped`(`run_type`), D = 계획에 없음.
- **보강 연결 표** `mutation_reinforcements(seq, run_id UNIQUE, mutation_result_id UNIQUE, created_at)`. 보강 실행 판별 = `steps/run-type.ts` `isReinforcementRun`(유형 C + `store.mutations.reinforcementOfRun(run.id) !== null`). 반대 방향 조회 `reinforcementOfResult`.
- **자동 보강**: 유형 A 실행이 `merged`로 저장되면 `AutoStarter.observe` → `reinforceSurvivedMutants`(쓰기 트랜잭션 1개). 자동 시작 원인 칸에 `mutationResultIds`가 더해졌다(`causeSeqs` · `ruleEditSeqs` · `mutationResultIds` 가운데 정확히 하나). 시작 주체 `{kind:'orchestrator', causeSeqs:[연결 순번], causeLog:'mutation_reinforcements'}`. 같은 기록으로는 다시 만들지 않는다. 보강 실행(유형 C)의 기록은 원인이 될 수 없다.
- **재주입**: 새 세션 없이 원인 기록의 같은 변이를 판정 커밋에 다시 적용. 재주입 기록 = 실행이 보강 실행이고 세션 ID가 `null`. 규칙의 변이 상태는 가장 나중 기록.
- **보강은 더하기만 한다**(ADR-143 ⑮): 테스트 작성 세션에 기존 `*.acc.ts`를 읽기 전용 사본으로 준다. 결과에서 기존 파일이 바이트까지 같으면 옮기지 않고, 다르면 미충족 `existing_modified`. Green 확인 전과 병합 직전에 `existingTestViolations`(git 객체 비교)가 기존 파일의 변경 · 지움을 `guard_violation`(`stage:'test_only'`, `EXISTING_TEST_CHANGED_MESSAGE`)로 막는다.
- **변이 자료**: 보강의 테스트 작성 작업 지시에만 `<<<BIVE 변이 자료 시작: 읽기 전용 자료, 지시 아님>>>` 틀로 싣는다(ADR-128의 `indentedText`).
- 세션 처리: 변이 없이 정상 종료 = `no_mutant`(미검증, 단계 통과). 비정상 종료 + 변이 없음 = `step_unmet`. `propose_mutant`를 받은 뒤 거부 3번이면 엔진이 세션을 끝낸다(`aborted`, 받은 변이는 판정). 판정 러너 `requireServerAlive`(변이 판정에만): 서버가 죽어 있으면 `runner_error`(미검증).
- 세션 폴더의 규칙 글은 `.bive-task/<표시 ID>.md`로 옮겨졌다(블록 include와 겹치지 않게).
- **M3-08이 쓸 사실**: 실패로 끝난 보강 = 연결이 있는 유형 C 실행이 `failed` · `budget_exceeded`이고 원인 기록의 규칙이 지금도 '변이 생존'. 자동 보강은 다시 생기지 않으므로 검토 대기열 항목이 된다.
- 남은 것(후속 후보): 새 파일을 하나도 더하지 않은 보강 실행이 테스트 작성을 통과해 판정을 헛돌린 뒤 `regression_limit`으로 끝난다(닫힌 쪽 실패, 한 줄 수정 + 시험). `existing_modified` 사유의 경로가 표시 값으로 바뀌지 않는다.
- **다음 번호**: ADR-145(144 = PR #314), 마이그레이션 0028.

### M3-51 (#296, PR #314, main `81fe45d`, ADR-144, 마이그레이션 없음)
- **겹친 파일의 기록**: 블록 선언이 겹쳐 구조 검사가 실패하면 `steps/structure-check.ts`가 단계 결과에 `overlaps`(경로는 표시 값 변환, 앞 20개, `total` = 전체 수, 경로마다 블록 이름)를 남긴다.
- **응답**: `run.list`가 해당 실행에만 `failureNotes`를 싣는다(`runs/failure-notes.ts`, 저장된 단계 결과만 읽고 shared 스키마 `safeParse`). 해당 실행이 없으면 응답은 예전과 같은 `{runs}`.
- **화면**: 규칙 상세의 실행 이력(`runHistoryView.ts` `noteFits`)에 "겹친 파일" · 경로 · 블록 이름 · "외 N개". **대상 규칙의 상세에만 보인다**(내장 구조 규칙 상세에는 안 보임: 한계).
- **내장 규칙 없는 프로젝트**: 내장 규칙을 자동으로 만들지 않는다(ADR-127 ①). `state_inconsistent`에 "내장 구조 규칙 없음 · 블록 선언 다시 저장 필요" 안내만 붙는다. 다른 `state_inconsistent` 사유에는 안 붙는다.
- **구현 세션의 앞 시도 사유**: 구조 위반은 별도 머리 문장 아래(`steps/implementation.ts`), 기준은 `structureRuleDisplayIds`(내장 구조 규칙의 고정 제목 대조 `isBuiltinStructureRule`). **계약 검사 규칙도 `builtin: true`지만 기존 머리 `CHECK_FAILED_HEADER` 아래 그대로다**(시험이 고정).
- ADR-127 본문의 한계 문장 두 곳에 "(ADR-144로 닫음)"이 덧붙었다(선례: PR #288 · #298).
- 후속 후보: 겹침을 내장 구조 규칙 상세에서도 보이기(SCR-16 때), "겹친 파일" 글씨 구분, 병합 재검사의 겹침 표시.

### M3-55 뒤의 로드맵 사실 (PR #318, main `7ab8aea`, ADR-147)
- M3-08(#53)은 수용 기준 1 · 2(저장 모델 · 자동 등록 · 변이 생존 액션)만 맡는다. 예산 초과 액션은 **M3-56(#319) 이어받는 실행 · 한도 상향 재개**, **M3-57(#320) 규칙 분할**, **M3-58(#321) 허용 목록 축소 재개(M3-56 뒤)**. 화면 M3-09(#54)는 M3-08 · M3-56 · M3-57 · M3-58을 기다린다.
- ADR-147의 결정(구현 이슈가 따른다): ① 종료 상태 `budget_exceeded`는 그대로(0016 트리거 · `RUN_STATUS_TRANSITIONS` · 저장소 거부를 풀지 않는다). ② 재개 = 이어받는 새 실행(같은 유형 · 대상 · 기준 커밋, 연결은 새 표, 작업 가지는 원 실행의 마지막 완료 단계 산출 커밋에서 시작, 끝나지 않은 이어받는 실행은 원 실행 하나에 하나). ③ 이어받은 단계는 새 실행에서 `skipped`(사유 이어받음)이고 `passed` 행을 만들지 않는다. 판정 근거(Red 해시 · 단계 산출 커밋)는 연결을 거쳐 원 실행의 단계 기록에서 읽는다. ④ 새 한도 = 새 실행의 예산 값(`budgetSnapshot`의 `run` · `roles`, 각 `maxBudgetUsd` · `maxTurns`): 내리면 `-32001`, 이미 닿은 값은 쓴 양보다 커야 함, 사용량은 사슬 전체 누적. ⑤ 사람의 `run.create`의 문 그대로(하루 한도는 세션을 열 때 본다: 닿아 있으면 다시 `budget_exceeded`). ⑥ 허용 목록 축소 = 제외 경로 목록(1개 이상), 쓸 수 있는 곳 = 대상 블록 include의 합에서 제외를 뺀 경로(블록 밖도 거부), 처음 목록이 비면 거부, 새 한도 함께. ⑦ 보강 실행을 이어받은 실행도 보강 실행으로 판별(연결 사슬). ⑧ 규칙 분할: 사람이 나눌 규칙 하나를 줌, 내장 구조 규칙은 RPC 입구에서 거부, 2개 미만이면 항목 열림, 나머지 대상 규칙은 자동으로 다시 시작되지 않음.
- 코드 사실: `worktree-manager.create`는 기준 브랜치의 지금 커밋에서 가지를 만든다(넓혀야 함). `sessionLimits`는 그 실행의 세션 기록만 센다(넓혀야 함). `supersede_rule`은 1 → 1, 폐기 기록의 `superseded_by`는 값 1개.

### M3-15 (#60, PR #315, main `64bac0e`, ADR-146, 마이그레이션 없음)
- **`verification.trend {projectId}` → `{points, truncated}`**(`orchestrator/src/verification/trend.ts`): 점 = 병합 커밋이 기록된 실행, 순서 = 판정 기준을 고르는 순서(`summary.ts`의 `orderedBasisCandidates`, `basisOf`와 공유), 최근 30개. **한 점의 값은 그 실행이 판정 기준이던 동안의 끝(다음 병합 직전, 마지막 점은 지금)의 값**이라 마지막 점 = 요약 카드. 새 표 없이 기록에서 다시 계산한다.
- 통과율 = `verification.summary`의 준수와 같은 정의(`judgmentsAtCommit` 공유: 그 실행 자신의 병합 커밋 판정, 없으면 `headCommit`의 검사 판정. 앞 실행의 판정을 이어받지 않는다. 판정 없는 규칙은 미판정으로 분모에 든다). 변이 검증됨 = 그 점까지 **병합된 실행**의 변이 기록에서 규칙별 가장 나중 기록, 기록 있는 효력 규칙(`tested`) 대비 검증됨(`verified`).
- `verification.summary`에 필수 칸 `mutation {verified, tested}`. `rule.list` 항목에 선택 칸 `mutation`(모든 기록의 가장 나중 상태, 없으면 미검증, 질의 1회).
- `norms/effective.ts`에 지난 시점 효력 `isEffectiveRuleBefore` · `retirementTimesOf`(순간이 무한대면 `isEffectiveRule`과 같음을 성질 시험이 고정). store 묶음 읽기: `judgments.listByRuns` · `runs.stepsOfMergedRuns` · `mutations.list` · `mutations.latestForRules`.
- 화면: SCR-05에 SVG 그래프(통과율 실선 · 변이 검증됨 점선, 눈금 100 · 50 · 0%, 가로축은 첫 · 마지막 병합 시각)와 변이 검증됨 카드(누르면 SCR-03 `변이: 생존`). SCR-03 변이 칩 값 "검증됨 · 미검증 · 생존", 카드 예외 '변이 생존'은 판정 예외 바로 뒤 · 추적성 결함 · 미확인 앞.
- 구조 시험: 효력 판정 모듈 사용처 목록에 `verification/trend.ts`(읽기만), 판정 기록 읽기 정규식이 `listByRuns`도 묶는다.
- 한계(후속 후보): 검증 화면의 변이 값(병합된 실행 기록)과 규칙 화면의 변이 상태(모든 기록의 마지막)가 변이 단계 뒤 병합 실패에서 갈린다, `rule.list` 변이 상태는 미래 시각 기록을 거르지 않는다, 그래프 중간 점 값은 눈금으로만 읽힌다(툴팁 · 화면 읽기 없음), `verification.summary`의 판정 기준 계산이 병합된 실행마다 단계를 따로 읽는다(N+1).

### M3-08 (#53, PR #317, main `22c66c7`, ADR-145, 마이그레이션 `project/0028_review_queue`)
- **표 `review_items`**(`seq, kind, run_id, mutation_result_id, created_at, resolved_at, action, resolved_by, reason, detail`): 종류 `budget_exceeded` · `mutant_survived`. 열린 항목은 실행마다 하나(부분 UNIQUE). 처리는 한 번, 사람 주체만, 처리 결과가 실제로 있어야 함(보강 연결 / 같은 규칙 · 같은 사유의 격리 판정), 수정 · 삭제 거부(트리거).
- **자동 등록은 DB 트리거**(`AFTER UPDATE OF status ON runs` 둘): `budget_exceeded` → 예산 초과 항목(보강 실행 포함, 하나뿐). 보강 실행이 `failed`이고 원인 규칙이 지금도 '변이 생존' → 변이 생존 항목. 유형 A의 생존 · 생략된 자동 보강은 항목 아님. **0028 전에 끝난 실행은 되채우지 않는다.** 엔진 코드에는 등록 코드가 없다.
- **사람 보강 연결 `review_reinforcements`** + **뷰 `run_reinforcement_causes(run_id, mutation_result_id, link_kind)`**(`auto` = 0027 · `review` = 0028). 자동 등록 트리거와 `MutationResultRepository.reinforcementCauseOfRun`이 이 뷰 하나를 읽는다 → `isReinforcementRun` · 재주입 · 변이 자료 · "더하기만" · 자동 보강의 중복 확인이 두 시작 길에 똑같이 걸린다. **M3-56은 이 뷰를 바꿔 이어받는 실행을 사슬로 잇는다**(뷰를 다시 만드는 새 마이그레이션). 한 실행은 두 연결 가운데 하나만(양쪽 넣기 거부 트리거).
- **RPC**: `reviewQueue.list {kind?, state?}` · `get {seq}` · `reinforce` · `quarantine`(사람만, 에이전트 -32020). 응답 항목 `{item, run: {id, displayId, type, status, failureReason}, rules: [{id, displayId, title}]}`. 알림 `event.reviewQueue.changed {projectId}`(`ipc/project-store-access.ts`가 저장소 사용 전후의 변경 표지를 비교). 이의 제기 메서드는 없다(-32601).
- **`reviewQueue.reinforce` 처리기는 `ipc/run-handlers.ts`에 있다**(구조 시험 "`createRun(`을 부르는 곳은 `run-handlers.ts`뿐"). 항목 확인 · 연결 · 처리는 `review/review-queue.ts`(처리와 사람 연결을 쓰는 유일한 모듈, 구조 시험). 실행 생성 · 연결 · 처리는 트랜잭션 1개. **M3-56 · M3-57 · M3-58의 재개 · 분할 처리기도 실행을 만들면 `run-handlers.ts`에 둔다.**
- **판정 격리**: `judgments` 1행(`quarantined`, 사유, `runId`/`stepId` = null, 커밋 = 원인 변이 기록의 판정 커밋, 케이스 없음). 규칙 목록 · 상세의 최신 판정에만 보이고 `verification.summary` · `verification.trend`에는 들지 않는다(둘 다 실행의 기록만 읽는다). 검사 단계 · 병합 재검사 · 자동 시작은 저장된 판정을 읽지 않는다. 격리된 규칙의 자동 보강 · 변이 주입은 계속되고 변이 상태는 '변이 생존' 그대로. 격리를 되돌리는 길 없음. **격리의 지표 반영 · 전이는 M3-14(#59).**
- 앱: 렌더러는 `rpc-bridge.ts`의 `isMethodName`으로 새 메서드를 이미 부를 수 있다. M3-09에 남는 것은 화면과 앱 표시명 표.
- 한계(후속 후보): 폐기된 규칙의 변이 생존 항목에서 테스트 보강이 거부되지 않아 승인 단계에서 끝나는 실행과 새 항목이 생긴다(#266 쪽), `reviewQueue.list`가 전체를 읽고 항목마다 조회 3번 · 저장소 사용마다 `count(*)` 2번, 숨은 글자만으로 된 사유.
- **다음 번호**: ADR-149(148 = #294), 마이그레이션 0030(0029 = #294).

### M3-59 뒤의 로드맵 사실 (PR #324, main `bf4d534`, ADR-150)
- M3-56(#319)은 "이어받는 실행 만들기 · 연결 표 · 새 한도의 검증과 누적 · 사람의 문과 트랜잭션 · 항목 처리 · 다시 예산 초과의 새 항목 · 보강 사슬 판별"만 맡는다. **M3-56까지의 동작: 이어받는 실행은 기준 커밋에서 첫 단계부터 돈다.** 중간 시작은 **M3-60(#325)**.
- ADR-150의 결정(M3-60이 구현): ⓐ 시작 단계 = 원 실행에서 예산 초과를 낸 시도의 단계(기존 `interrupted` 재개와 같은 자리). **이어받는 것은 파이프라인 순서에서 그 앞 단계뿐**(새 실행에 `skipped`, 사유 이어받음, 원 실행의 그 단계 시도를 가리킴. `passed` 행을 만들지 않는다). **시작 단계와 그 뒤의 단계는 원 실행의 앞 시도가 `passed`였어도 다시 돈다**(회귀 중 예산 초과: 구현 2회차에서 초과면 구현 · Green 확인 · 검사를 다시 돈다). ⓑ 작업 가지 = 원 실행의 `headCommit`(없으면 기준 커밋)에서 시작, 커밋되지 않은 변경은 이어받지 않는다. ⓒ 판정 근거를 읽는 자리는 한 함수(원 실행들의 단계 + 자기 단계), 복사하지 않는다. ⓓ 회귀 상한은 사슬 전체로 센다.
- 판정 근거를 읽는 지금 자리: `green-check.ts` · `merge.ts`는 `lastPassed`, `check.ts` · `implementation.ts` · `mutation.ts`는 `acceptanceBaselineOf`, `red-check.ts`는 `context.steps`와 `run.headCommit`을 직접.
- M3-58(#321)은 M3-56에만 기댄다. M3-09(#54)는 M3-56 · M3-57 · M3-58에 기댄다. M3 흐름 4번은 M3-60까지 끝나야 성립한다.

### M3-49 (#294, PR #322, main `25bc959`, ADR-148, 마이그레이션 `project/0029_asyncapi_judge_runner`)
- **AsyncAPI 계약 검사 규칙이 판정된다**(유효성만. 구현 일치 검사는 범위 밖: ADR-033). 실행기 값 `asyncapi-parser`(shared `JudgeRunner`, `judgments.runner` CHECK). DB 스키마(Prisma)는 그대로 `no_runner`(M3-48 보류, #287).
- **도구**: `@asyncapi/parser@3.6.3` + 루트 `pnpm.overrides` 세 줄(`@asyncapi/parser@3.6.3>@stoplight/spectral-core: 1.23.0` · `…>spectral-functions: 1.10.3` · `spectral-functions@1.10.3>spectral-formats: 1.8.3`). 최신 3.6.6은 `@scarf/scarf`(postinstall로 사용 기록 전송)를 끌어온다. **도구 판을 올릴 때**: scarf가 닫힘에 들어오는지, 시험 "사전 검사를 건너뛰어 진입 스크립트를 불러도 가로채는 리졸버가 읽지 않는다"가 통과하는지 본다(둘째 겹은 라이브러리의 `__unstable` 선택 항목에 기댄다).
- **모듈**: `orchestrator/runner/asyncapi-validate.mjs`(도구 자식 프로세스의 진입 스크립트) · `contract-check/asyncapi-document.ts`(사전 검사: `$ref` · `$dynamicRef` · `$recursiveRef`가 `#`로 시작하지 않으면 도구를 부르지 않음, 검사하지 못하는 `schemaFormat`) · `contract-check/asyncapi.ts` · `steps/contract-check.ts`(계약 종류별 실행기 표 `CONTRACT_JUDGE_RUNNERS`).
- **결과**: 유효 = `pass`. 유효성 오류 · 읽지 못하는 문서 · 지원하지 않는 판 = 막지 않는 `fail`(OpenAPI 형식 오류와 같은 길). 바깥 참조 · `unsupported_schema_format`(Avro 등) = 판정 없음. 도구 오류 = `judge_runner_error`(`stage: contract`). **판정할 문서 = 등록 때 커밋의 내용**(판정 커밋의 파일이 바뀌어도, 시험이 고정). 지원 판 2.0.0 ~ 2.6.0 · 3.0.0 · 3.1.0.
- 유형 B가 AsyncAPI 계약 검사 규칙을 대상으로 받는다(실행기가 있는 종류만 받는 기존 규칙의 결과).
- **0029는 `judgments` 표를 다시 만든다. 뒤에 `judgments`를 다시 만드는 마이그레이션은 0028의 트리거 `review_items_resolve_quarantine`을 표를 지우기 전에 지웠다가 0028과 글자까지 같게 다시 만들어야 한다**(안 그러면 표 이름 바꾸기가 `no such table: main.judgments`로 실패).
- **시험 소스에 숨은 글자를 글자 그대로 넣지 않는다**: `String.fromCodePoint(0x202e)` 같은 식으로 만든다(편집 도구가 `‮` 표기를 실제 글자로 바꿔 넣는 경우가 있다).
- 한계(후속 후보): `pnpm audit --prod`가 기존 의존성에서 18건(높음 4)을 보고한다(이 PR이 더한 112개에는 0건). 패키징된 Electron 앱에서 진입 스크립트 경로 미확인. 형식이 틀린 계약이 있어도 실행은 병합된다(ADR-132와 같음).

### M3-56 (#319, PR #326, main `e5a8816`, ADR-149, 마이그레이션 `project/0030_run_continuations`)
- **한도 상향 재개 = 이어받는 새 실행**(원 실행은 `budget_exceeded` 그대로: 0016 트리거 · `RUN_STATUS_TRANSITIONS`를 풀지 않는다). **이 행까지의 동작: 이어받는 실행은 원 실행의 기준 커밋에서 첫 단계부터 돈다**(`skipped` 이어받음 행 없음, 판정 근거와 회귀 수는 그 실행 자신의 것). 중간 시작은 M3-60(#325).
- **표 `run_continuations`**: 이어받는 실행 ID UNIQUE, **원 실행 ID UNIQUE**(사슬 원 → 1차 → 2차는 되고 가지는 없다). 넣을 때의 조건(트리거): 원 실행이 `budget_exceeded`, 새 실행이 막 만든 사람 시작 실행, 유형 · 대상 규칙이 같음. 기준 커밋은 새 실행의 `base_commit`을 쓸 때 원 실행과 같은지 본다(`runs_continuation_base_commit`). 수정 · 삭제 거부. 저장소 `RunContinuationRepository`(`ancestorsOf` 등).
- **뷰 `run_reinforcement_causes`는 0030에서 `WITH RECURSIVE`로 다시 만들어졌다**(사슬을 따라 원인 변이 기록에 닿음, `link_kind`는 사슬 뿌리의 종류). 이어받는 실행은 보강 연결 표 둘에 직접 행을 가질 수 없다(트리거).
- **RPC `reviewQueue.resumeWithBudget`**(`ipc/run-handlers.ts`, 사람만 -32020): 항목 확인 → 한도 검증 → `createRun`(다섯째 인자 `RunContinuationSeed`: 사람의 `run.create`로는 닿지 않음) → 연결 → 항목 처리(액션 `raise_limit_resume`), 트랜잭션 1개. 처리 결과 트리거 `review_items_resolve_raise_limit`.
- **한도**: 새 한도는 `BudgetSnapshot` 모양으로 새 실행의 예산 값이 된다. 검증 `assertRaisedBudget`(-32001 + `data.fields`): `BUDGET_SHAPE_MISMATCH` · `BUDGET_LOWERED` · `BUDGET_NOT_ABOVE_SPENT`(닿은 값은 USD · 턴 모두, `session-budget.ts`의 `budgetValueUsages` · `limitReached`). 엔진의 `sessionLimits` · `budgetOverrun` · `runRemaining`(판단 세션 포함)은 `lineageSessions`(사슬 전체의 세션)를 센다. 이어받는 실행이 아니면 자기 세션 그대로. 설정은 바뀌지 않는다. 하루 한도는 사람 실행 규칙(세션을 열 때).
- **작업 가지**: `worktree-manager.create`에 `start` 입력(시작 커밋이 원 실행 브랜치에 있고 기준 커밋이 그 조상인지 git 객체로 확인, 아니면 `start_commit_unavailable`). 지금 시작 커밋 = 기준 커밋(`runs/run-continuation.ts`의 `continuationWorktreeStart`). **M3-60이 이것을 원 실행의 `headCommit`으로 바꾼다.**
- 한계: 사람이 원 실행 브랜치를 지웠으면 이어받는 실행은 `worktree_error`로 실패하고 원 실행은 다시 이을 수 없다(새 `run.create`만). 이어받는 실행이 예산 초과가 아닌 이유로 끝나도 원 실행은 다시 이을 수 없다. 실행 목록에 실행이 둘, 비용은 실행마다. 날 SQL로 이어받는 실행에 `run_target_rules` 행을 더할 수 있다(0005부터의 느슨함). `narrow_allowlist_resume` · `split_rule` 처리에는 결과 확인 트리거가 아직 없다(M3-58 · M3-57 몫).
- **M3-60(#325)이 알 것**: 중간 시작의 작업 패치 `a319-full-wip.patch`(시험 없음, 0030 병합 전 기준). 단계 실행기 6개가 판정 근거를 `context.steps`에서 읽는다 → 한 함수(`basisSteps`: 원 실행들의 단계 + 자기 단계)로 모은다. 회귀 상한은 지금 실행마다 센다 → 사슬 전체로. `skipped`(사유 `inherited`)의 표시명. 이 PR의 엔진 배선 시험(판단 세션의 사슬 잔여 · `budget_aggregate_exceeded`)을 재사용.
- **다음 번호**: ADR-152(151 = PR #327), 마이그레이션 0031.

### M3-30 (#245, PR #327, main `1b486c2`, ADR-151, 마이그레이션 없음)
- **동작 선언**: `propose_rule` · `supersede_rule`의 필수 칸 `behavior: 'new' | 'existing'`(shared `RuleBehavior`, 빠지면 `invalid_args`). 그 규칙의 신규 기록(`norm_changes`의 `created`) `detail.behavior`에만 남는다. **시험 · 시나리오에서 이 도구를 부를 때는 선언을 넣어야 한다.**
- **읽는 곳은 `engine/start-basis.ts`의 `declaredBehaviorOf` 하나**(구조 시험: 낱말 `behavior`가 나오는 파일 목록을 고정). 선언 없는 옛 기록 = 모름. **그 규칙에 진술이 바뀐 사람의 편집(`rule_edit`)이 있으면 모름**(제목만 고친 편집은 아님).
- **유형 고르기**: 자동 시작(`autoStartRun`)과 다시 시작(`restartAfterContradiction`)이 선언으로 고른다(`existing` → 유형 C, `new` · 모름 → 유형 A). 다시 시작은 끝난 실행의 유형이 아니라 규칙의 선언을 따른다. 변이 보강 = 늘 유형 C 보강, 진술 편집 뒤 시작 = A, 사람의 [실행] · 이어받는 실행 = 선언 무시. 유형 C "기존 동작" 실행은 보강 실행이 아니다(변이 주입 `skipped` `run_type`).
- **시작 근거 대조에 `type_mismatch`**: 신규 기록 · 다시 시작이 원인인 오케스트레이터 실행은 유형이 선언과 맞아야 한다(아니면 `run_without_log`). 편집 전에 대기 · 진행 중이던 유형 C 실행은 편집 뒤 `type_mismatch`로 끝난다. **편집 뒤 자동 시작(`runs/rule-edit-start.ts`)의 `pending` 탐색은 시작 근거 대조가 맞는 대기 실행만 센다** → 새 유형 A 실행이 만들어진다.
- **어긋남**: 새 동작인데 Red 확인에서 이미 통과 · 기존 동작인데 Green 확인에서 실패 → 둘 다 `test_retry_limit`. 유형 · 대상 규칙 불변, 반대 유형의 실행은 자동으로 생기지 않는다. 실행을 끝낸 Red · Green 확인 시도의 종료 상세에 `declaredBehavior`(오케스트레이터가 신규 기록 · 다시 시작으로 시작한 실행에만).
- 프롬프트 `RULE_BEHAVIOR_GUIDE`(요구사항 · 이의 판단 · 검사 실패 판단 · 요구사항 수정 재판단): `existing`은 요구사항 본문이 지금 동작의 유지를 밝힐 때만, 그 밖에는 `new`. 판단 세션에는 `JUDGMENT_SUPERSEDE_BEHAVIOR_LINE`.
- **한계(사람에게 알림)**: 기존 동작으로 선언된 규칙은 코드를 바꾸지 않고 새 테스트가 지금 코드에서 통과하기만 하면 병합되고, 그 테스트가 무엇을 검사하는지는 변이 주입을 포함해 어떤 단계도 다시 보지 않는다. 선언은 코드를 보지 못한 추정이고 틀렸다는 표시는 실행 기록의 종료 상세에만 남는다(화면 없음). 진행 중이던 C 실행이 편집 뒤 끝날 때 사유가 `run_without_log`뿐이라 원인을 읽을 수 없다.
- 후속 후보: 선언 · 어긋남의 화면 표시, 기존 동작 실행에도 변이 주입, 같은 유형 규칙 묶기(ADR-110 다시 볼 조건).

### M3-60 (#325, PR #328, main `ed376f0`, ADR-152, 마이그레이션 없음)
- **이어받는 실행은 원 실행에서 예산 초과를 낸 단계부터 돈다**(`runs/run-continuation.ts`의 `continuationStartOf`, `createRun`의 `RunContinuationSeed.inherited`). 시작 단계 = 원 실행의 `currentStep`. 파이프라인 순서에서 그 앞 단계의 마지막 시도가 통과 · 실행기의 생략이면 새 실행에 `skipped` + shared `InheritedStepDetail = {reason:'inherited', fromRunId, fromStepId, fromStatus}`로 남는다(`passed` 행을 만들지 않는다). 유형 생략(`run_type`) 단계는 이어받지 않고 엔진이 다시 유형 생략으로 기록한다. 사슬 2단에서는 실제로 그 단계를 돈 시도를 가리킨다. 시작 단계와 그 뒤는 다시 돈다.
- **작업 가지 · `headCommit`** = 원 실행의 `headCommit`(없으면 기준 커밋). 엔진 `#drive`는 `#prepare`가 저장한 레코드로 첫 단계를 돈다. 원 브랜치를 지웠으면 `start_commit_unavailable` → `worktree_error`.
- **판정 근거는 `basisSteps(context)` 하나**(이어받은 시도가 가리키는 시도 + 자기 단계, 이 순서: 자기 시도가 나중이라 `lastPassed`가 자기 것을 고른다). 단계 실행기(check · green-check · implementation · merge · mutation · red-check)는 `lastPassed` · `acceptanceBaselineOf`에 `context.steps`를 직접 넘기지 않는다(구조 시험: 단계 폴더의 `context.steps` 구조 분해 · 별칭 금지, 읽기 수 고정). **새 단계 실행기를 쓸 때 근거는 `basisSteps`로 읽는다.**
- **가리킴은 읽을 때 대조한다**: 가리킨 실행이 연결 사슬의 조상, 같은 단계 종류, 상태가 `fromStatus`와 같고 통과 · 실행기의 생략. 어긋나면 이어받은 근거를 하나도 싣지 않아 근거가 필요한 실행기가 `state_inconsistent`로 멈춘다.
- **회귀 상한은 사슬 전체**(엔진 `#unmet`의 `lineageCounts`: 구현 · 검사 회귀는 사슬의 `regressionCount` 합 + 자기 회귀, 테스트 작성 재시도는 원 실행들의 시도에서 재기동 중단 · 이어받은 시도 · 멈춘 시도를 뺀 수).
- 보통 실행(이어받는 실행 아님)은 저장소를 읽지 않고 그대로다.
- 한계(후속 후보): 이어받는 실행의 첫 구현 세션이 원 실행의 앞 시도 사유(ADR-128)를 받지 않는다(비용), 이어받음 표시명 없음(앱은 단계 `exitDetail`을 보이지 않음), 실행기의 생략 · 변이 주입 통과를 이어받을 때 그 사이 바뀐 블록 선언을 다시 보지 않는다(병합 재검사가 다시 판정).
- **다음 번호**: ADR-154(153 = #320), 마이그레이션 0031(#320이 쓸 수 있음).

### M3-61 (#329, PR #330, main `322bc72`, ADR-154)
- CI `checks` 잡의 제한 시간은 **40분**(묶음 40분, 집계 잡 5분 그대로). `scripts/test_ci_workflow.py`가 제한 값 · `needs` · 잡 이름 네 개를 단언한다.
- 실측(2026-11-28): `checks`는 보통 16 ~ 18분(단위 테스트 9분대 · 화면 e2e 6분대). 러너가 느리면 같은 트리에서도 25분(단위 14분대 · 화면 e2e 9분대). 묶음은 14.6 ~ 24.0분.
- 다시 정하는 조건: `checks`가 35분을 넘으면 단위 테스트를 따로 잡으로 나눈다(그때 CLAUDE.md 5장의 CI 서술을 사람이 고쳐야 하므로 needs-human 이슈).

### M3-57 (#320, PR #331, main `0580ad2`, ADR-153, 마이그레이션 `project/0031_rule_splits`)
- **RPC `reviewQueue.splitRule {projectId, seq, ruleId, author}` → `{entry, sessionId}`**(`ipc/review-queue-handlers.ts`: 실행을 만들지 않는다). 거부 순서: 에이전트 -32020 → 없는 항목 -32004 / 처리됨 · 다른 종류 -32009 → 대상 규칙 아님 -32001 `SPLIT_RULE_NOT_TARGET` → 내장 규칙 `builtin_rule` → 효력 없음 `rule_not_effective` · 부모 없음 `rule_without_parent` → 같은 항목의 분할 세션이 대기 · 진행 중 `split_in_progress` → 설정 미비 -32010 · 하루 한도. 어느 거부도 세션을 열지 않는다.
- **새 도구 `split_rule {ruleId, grounds, rules: 2 ~ 5}`은 분할 세션에만 있다**(`RULE_SPLIT_SESSION_TOOL_NAMES`, 실행기 `toolSet: 'rule_split'`, `sessionToolDefinitions`). 새 규칙 칸은 `ProposeRuleInput`에서 부모만 뺀 것(동작 선언 필수). 분할 세션에는 다른 규범 도구가 없고 다른 세션에는 `split_rule`이 없다. **`agent/claude-sdk-adapter.ts`는 역할이 아니라 실행기의 이름 목록으로 SDK `allowedTools`와 MCP `tools/list`를 만든다**(기존 역할은 글자까지 같음: integrity의 역할별 `buildQueryOptions` 대조).
- **반영 `splitAgentRule`**(`norms/agent-rule.ts`, 트랜잭션 1개): 새 규칙마다 규칙 + 신규 기록(동작 선언) + 모순 판단 기록(`new_rule`) → 나눈 규칙의 `superseded` 기록(`detail.retirement.split`) + 폐기 기록 + 확인 풀림 → 분할 기록 → 처리 함수 `settle`(처리기가 `splitSettlement`로 만들어 세션 요청에 실어 넘긴다: 세션 코드는 검토 대기열을 모른다). 거부: 2개 미만 · 새 규칙끼리 같은 진술 · **나눈 규칙과 같은 진술** · 부모를 칸으로 줌.
- **0031**: 표 `rule_splits(rule_id → rule_retirements, position, new_rule_id UNIQUE)`(폐기 기록의 `superseded_by`는 첫 새 규칙, 나머지는 이 표). 트리거 `rule_splits_insert`(위치 연속 · 위치 1 = `superseded_by` · 새 규칙이 살아 있고 폐기되지 않았으며 내장이 아니고 부모가 같음) · 수정 · 삭제 거부 · `review_items_resolve_split_rule`(`detail.ruleId`가 그 항목 실행의 대상 규칙, 분할 행 2개 이상이고 그 수 = 분할 상세의 수).
- 분할 세션: 규칙 작성 역할, 실행 밖 세션(요구사항 세션과 같은 예산 문), 작업 지시는 나눌 규칙의 제목 · 진술 · 부모 요구사항과 원 실행의 표시 ID · 종료 사유 · 멈춘 단계, 규범 자료. 세션이 정상 종료하면 기존 자동 시작이 새 규칙마다 실행 1개를 선언대로의 유형으로 만든다.
- 한계(후속 후보): 뜻이 같은 다른 글로 "나눈 척"은 가리지 못한다, 규칙 진술의 숨은 글자(U+200B 등) 정규화, 원 실행의 나머지 대상 규칙은 처리 액션이 없고 다시 시작되지 않는다, 화면의 대체 규칙 링크는 첫 새 규칙만, 분할 세션의 중복 잠금은 프로세스 메모리, 반영 뒤 세션이 정상 종료가 아니면 새 규칙의 실행이 자동으로 생기지 않는다.
- **다음 번호**: ADR-156(155 = #321), 마이그레이션 0033(0032 = #321).

## M3-58 허용 목록 축소 재개 (#321, PR #333, main `0ca39c2`, ADR-155)
- RPC `reviewQueue.resumeNarrowed {projectId, seq, budget, exclude, author}`(`ipc/run-handlers.ts`). 순서: 사람 주체 -32020(저장소 열기 전) → 제외 형식 -32001(저장소 열기 전: 빈 목록 `WRITE_SCOPE_EXCLUDE_REQUIRED`, 형식 `WRITE_SCOPE_EXCLUDE_INVALID` + `data.fields`) → 트랜잭션 1개(열린 예산 초과 항목 → `assertRaisedBudget`(`budgetContinuation`) → 처음 목록(비면 `WRITE_SCOPE_ALLOW_EMPTY`) → `createRun` → 연결 → 범위 저장 → 처리 `narrow_allowlist_resume`).
- 제외 문법 = 블록 선언 include와 같은 문법 · 매처(shared `blockPatternProblem` · `matchesBlockPattern`). 요청당 20개, 실행당 100개, 중복 거부. **`src/x`는 그 경로 하나만 막고 폴더 아래는 막지 않는다(`src/x/**`가 필요): 화면 안내 문구는 M3-09 몫.**
- 처음 목록 = 이어받는 실행을 만드는 순간의 블록 선언에서 대상 블록 include의 합. 실행에 고정.
- 0032 `run_write_scopes`(실행 ID 기본 키, 추가 전용) + 트리거 6. 사슬은 복사: 한도 상향 재개는 원 실행의 범위를 그대로, 다시 좁히기는 허용 그대로 + 제외 합집합. `raise_limit_resume` 처리 트리거는 "이어받는 실행의 범위가 원 실행과 같을 것".
- 경로 가드 `PathGuardOptions.writeScope`(선택 칸, implementer의 쓰기만, 기존 금지 뒤). 값이 가드에 닿는 길은 엔진 `#runSession` 하나. 고정 거부 문장 `WRITE_SCOPE_DENIALS.outside` · `.excluded`.
- 병합 전 대조 `steps/write-scope.ts`의 `writeScopeViolations`: 검사 단계를 열 때 + 병합 직전, 시작 커밋 → 판정할 커밋의 git 객체 비교. 위반이면 `guard_violation`(`stage: 'write_scope'`, `changed` 경로 50개까지).
- 한계(후속 후보): 범위가 붙은 실행에서 `install_package` · `prisma_migrate`를 쓰면 검사 단계의 대조에서 끝난다(쓰는 순간이 아님), 구현 세션의 작업 지시에 범위가 실리지 않는다, 범위는 이어받는 사슬에만(보강 · 자동 시작 · 분할 뒤 실행 · `run.create`는 물려받지 않음), SQL 수준에서 `[""]` 원소를 받는다(읽기가 던짐).
- 검토 대기열의 RPC 전체(M3-09가 쓴다): `reviewQueue.list` · `get` · `reinforce` · `quarantine` · `resumeWithBudget` · `resumeNarrowed` · `splitRule`, 알림 `event.reviewQueue.changed`.

## M3-14 재검증 필요 · 격리 전이 · 감시자 (#59, PR #334, main `c82f705`, ADR-156)
- 표시는 `judgments`의 실행 밖 기록 1건(`runId` · `stepId` = null, 케이스 없음). 쓰는 곳은 `judgments/judgment-marks.ts` 하나(상태는 `needs_recheck` · `quarantined` 둘뿐: 동작 시험 + 구조 시험). 마이그레이션 없음. 근거 칸은 없다(감시자 표시 = 커밋이 그때의 머리, 편집 = 같은 시각의 승인 기록 `rule_edit`, 선언 = 같은 시각의 선언 판).
- 감시자 `watcher/recheck-watcher.ts`: 기동 뒤 한 번 + 앞 회차가 끝나고 5초마다. 머리 = 판정 기준이면 끝. 다르면 블록 대상 규칙마다 "최신 판정 커밋과 머리의 공통 조상 → 머리"의 변경 파일(`--no-renames`, 지운 파일 포함)이 대상 블록 include에 걸리면 표시. 조상이 아니거나 커밋이 없으면 닫힌 쪽으로 표시. 실행을 만들지 않는다. 격리인 규칙은 덮지 않는다.
- 규칙 변경: `rule.update`의 진술 편집(같은 트랜잭션), `blocks.set`(블록 지움 · 이름 바꿈 · include 변경, 같은 트랜잭션). 제목만 · 첫 선언 · public/위험도만 바뀐 판은 표시 안 함.
- 재현성 `judgments/reproducibility.ts` `checkReproducibility`: **제품 호출처 0곳**(시험만). 사유 고정 글 '재판정 불일치'. `flaky` 변형은 같은 체크아웃을 다시 판정할 때만 흔들린다(제품의 `judgeCommit`은 새 체크아웃).
- 지표: `overlayMarks`가 요약 · 추이(지난 점은 그 시각 앞의 표시만)에 덧씌운다. 재검증 필요는 분모에 들고 통과 아님, 격리는 분모에서 빠짐. M3-08의 사람 격리도 같은 규칙(ADR-145 ④ 닫힘).
- **한계(후속 필수)**: 감시자 표시 뒤 화면 알림이 없다 → 로드맵 M3 완료 기준 흐름 8번("10초 안에 SCR-03")은 화면 다시 읽기 알림이 있어야 충족(#332의 항목 ㊳). 그 밖: 재현성 확인의 요청 창구 없음, 블록 밖 변경 · 작업 트리는 못 잡음, 감시자 회차마다 저장소 읽기, 사람 격리와 재판정 불일치를 가르는 주체 칸 없음.
