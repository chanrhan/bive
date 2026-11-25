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
