너는 chanrhan/bive 저장소의 이슈 #294(로드맵 M3-49 "AsyncAPI 계약 검사 실행기 (유효성 검사, 도구 교체)")를 구현하는 서브에이전트다. M3-47(#292, PR #299, ADR-132)이 OpenAPI 계약 검사 실행기를 넣었고, 등록된 AsyncAPI 계약은 지금 실행기가 없어 판정 없음(`no_runner`)이다. 이 이슈는 AsyncAPI 계약의 **유효성만** 판정하게 한다(구현 일치 검사는 범위 밖, ADR-033).

## 받은 값
- 이슈 번호 `<N>` = 294, 브랜치 `<B>` = `feat/294-asyncapi-contract-runner`, ADR 번호 `<A>` = ADR-148, 커밋 `<T>` = `feat(orchestrator)`(store · shared 커밋은 `feat(store)` · `feat(shared)`). 화면 변경은 없는 것이 기본(새 실행기 값의 표시명 표만 shared와 app에 함께 더한다. 그것 때문에 화면 e2e · 스모크가 필요해지면 돌린다).
- 마이그레이션: 판정 기록의 실행기 값(`judgments.runner` CHECK)을 넓혀야 하면 **`project/0029_…` 하나**. 0028은 열린 PR #317(검토 대기열)의 것이다: 이 PR은 #317이 병합된 뒤에 병합된다(번호 빈칸을 만들지 않는다). 0025(`contract_judge_runner`)가 같은 일을 한 선례다: 그 방식(표 다시 만들기 목록 · 트리거 다시 걸기)을 그대로 따른다. **0028이 `judgments`나 `runs`에 트리거를 더했다**(`git fetch origin feat/53-review-queue` 뒤 `git show origin/feat/53-review-queue:packages/store/src/migrations/project/0028_review_queue.ts`로 읽는다): `judgments` 표를 다시 만들면 0028의 트리거 · 뷰가 그 표를 참조하는지 확인하고, 참조하면 0029가 그것들을 다시 걸어야 한다. 그 경우 #317이 병합된 main을 받은 뒤에 0029를 마무리한다(그 전까지는 0028 없는 main 기준으로 만들고, 보고에 "0028 병합 뒤 다시 확인 필요"를 적는다).
- 기준 main은 `git fetch origin main` 뒤의 `origin/main`(지금 `64bac0e`). `git merge-base --is-ancestor 97b4d86 HEAD` 확인.
- 병렬 작업: PR #317(검토 대기열, ADR-145, 0028: `review/` · `ipc/` · `steps/mutation.ts` · `steps/test-writing.ts` · `runs/auto-start.ts` · `protocol.ts` · `domain.ts` · `enums.ts`)이 수정 중이다. `enums.ts` · `protocol.ts` · `docs/decisions.md`는 필요한 줄만 더한다. ADR 순서는 145 · 146 · 147 · 148.

## 먼저 읽을 것 (순서대로, 전부)
1. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-common.md` 공통 지침. 그대로 따른다.
2. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/m3-handoff.md`의 "M3-47"(OpenAPI 실행기: 모듈 · 도구 격리 · 판정할 문서 · 결과 · CI 시간) · "M3-04" · "M3-46"(도구 실측) · "M3-52"(CI 시간) · "M3-31"(구조 시험) 절.
3. 이슈 #294 본문의 수용 기준 2개, `docs/roadmap.md`의 M3-49 · M3-47 · M3-48 행.
4. `docs/decisions.md`: ADR-033(검사 도구, "도구가 요구를 못 채우면 ADR로 교체") · **ADR-130 전부**(`@asyncapi/cli@6.2.3` 실측: 패키지 1047개, 350MB, 잠금 파일 +9784줄, 기본 설정의 익명 사용 기록 전송. ③이 이 이슈에 도구 선택을 넘겼다) · **ADR-132 전부**(OpenAPI 실행기의 격리 · 닫힌 쪽 규칙: 그대로 따른다) · ADR-129(계약 등록) · ADR-125(자식 프로세스 환경 변수) · ADR-026.
5. 관련 코드: `orchestrator/src/contract-check/`(`tool.ts` · `openapi-document.ts` · `openapi.ts`) · `steps/contract-check.ts`(`contractPlanOf` · `no_runner` · 판정 규칙) · `norms/contract.ts` · `norms/contract-source.ts`(`readContractBlob`) · shared `JudgeRunner` · store 0025 · `orchestrator/test/contract-runner.test.ts` · `contract.test.ts` · `scripts/make-variant.sh` · `fixtures/sample-next-app`.

## 해야 할 것
1. **도구 고르기와 실측** (수용 기준 2). `@asyncapi/cli`를 쓰지 않는다(ADR-130의 실측). 대체 후보: AsyncAPI의 공식 라이브러리 `@asyncapi/parser`(문서 파싱 · 유효성 검사)가 첫 후보다. 후보마다 **이 VM에서 직접 잰다**(빈 임시 폴더에 설치해: 패키지 수, 설치 크기, 잠금 파일 증가 줄 수, 설치 스크립트 유무, 유효성 검사 때의 네트워크 호출 여부(바깥 `$ref`를 받아 오는가, 사용 기록 전송이 있는가: 소스와 실행 둘 다로 확인), 지원하는 AsyncAPI 판(2.x · 3.x), 필요한 Node 판). 값은 다시 확인한 것만 ADR에 적는다.
   - 설치 스크립트 허용 목록(`pnpm.onlyBuiltDependencies`)은 **바꾸지 않는다**. 설치 스크립트가 필요하거나 설치 때 외부 실행 파일을 받는 것이 보이면 **멈추고 보고한다**(사람 결정 #287과 같은 종류다).
   - 정확한 판 고정으로 오케스트레이터 패키지의 의존성에 더한다. 잠금 파일은 pnpm으로만 갱신한다. 패키지 수 · 크기가 `@redocly/cli` 수준(ADR-130 · ADR-132의 실측값과 견줌)을 크게 넘으면 다른 후보를 본다. 어떤 후보도 요구(프로젝트 코드 실행 없음 · 네트워크 없음 · 받아들일 크기)를 못 채우면 **멈추고 보고한다**(ADR-130 "다시 정하는 조건").
2. **AsyncAPI 계약 검사 실행기** (수용 기준 1). OpenAPI 실행기의 틀을 그대로 쓴다.
   - 판정할 문서 = 등록 커밋의 git 객체 + 등록 해시 대조(`readContractBlob`). 작업 트리 · 판정 커밋의 파일로 판정하지 않는다.
   - **도구가 대상 프로젝트의 코드를 실행하지 않게 한다**: 라이브러리를 오케스트레이터 프로세스 안에서 부르지 말고 OpenAPI 실행기처럼 **자식 프로세스**로 돌린다(cwd는 프로젝트 밖 빈 도구 폴더, 부모 환경 변수 넘기지 않음, 시간 · 출력 상한, 중단 신호 전달). 라이브러리가 설정 파일 · 플러그인 · 사용자 정의 스키마 파서를 cwd나 문서 위치에서 찾는지 소스로 확인하고 막는다.
   - **네트워크로 나가지 않게 한다**: 바깥 참조(`$ref`가 계약 파일 밖 · http(s)를 가리킴, AsyncAPI의 `schemaFormat`이 바깥 스키마를 부르는 경우, 메시지 `payload`의 Avro · RAML 등 다른 형식 파서)를 받아 오지 않는다. OpenAPI의 사전 검사(`openapi-document.ts`)와 같은 방식으로 도구를 부르기 전에 문서를 읽어 닫힌 쪽으로 끝낸다. 라이브러리의 리졸버를 끄는 선택 항목이 있으면 그것도 건다(둘 다). AsyncAPI에만 있는 참조 자리를 문서 명세에서 찾아 목록을 ADR에 적는다.
   - 결과: 유효한 문서 = `pass`, 유효하지 않은 문서 = `fail`. `fail`이 구현을 회귀시키는가: 등록 문서의 형식 오류는 구현 코드가 고칠 수 없다. ADR-132가 OpenAPI의 "등록 문서의 형식 오류 = `fail`(막지 않음)"으로 정한 것과 **같게** 한다. 도구 오류 · 시간 초과 · 출력 초과 · 예상 밖 출력은 `pass`로 읽히지 않는다(ADR-132의 닫힌 쪽 규칙과 판정 없음 사유를 그대로 따른다: 코드에서 확인해 같은 갈래에 넣는다).
   - 판정 기록의 실행기 값: 새 값(이름은 도구 이름을 따른다. 예: `asyncapi-parser`)을 shared `JudgeRunner` · store CHECK(0029) · 앱 표시명 표에 함께 더한다. AsyncAPI 계약은 이제 `no_runner`가 아니다. DB 스키마(Prisma)는 그대로 `no_runner`다(M3-48 보류).
   - AsyncAPI 판: 도구가 지원하는 판만 판정한다. 지원하지 않는 판의 문서는 `pass`가 아니다(등록 때 이미 거르는지 `norms/contract.ts`를 확인하고, 아니면 닫힌 쪽).
   - 케이스 요약(사람이 읽을 오류 목록)은 표시 값 변환 · 상한을 구조 검사 · OpenAPI 판정 기록의 방식 그대로. 문서 안의 글(설명 · 키 이름)이 오류 메시지에 실린다: 숨은 글자 · 긴 값.
3. **시험** (`orchestrator/test/contract-runner.test.ts`에 더한다. 실제 도구를 돈다).
   - 유효한 문서 → `pass`, 유효하지 않은 문서(필수 칸 없음 · 형식 오류 · 깨진 YAML) → `fail`.
   - 격리(대조군이 있는 시험, `parser/test/isolation.test.ts`와 OpenAPI 실행기 시험의 선례): 프로젝트 폴더에 둔 설정 · 플러그인이 실행되지 않음, 바깥 `$ref`(파일 밖 · http)가 네트워크 · 파일 시스템 접근 없이 닫힌 쪽으로 끝남(로컬 서버를 띄워 요청이 0건임을 센다), 환경 변수가 넘어가지 않음.
   - 도구 오류 · 시간 초과 · 출력 초과 · 중단이 `pass`가 아님.
   - 판정 기록의 실행기 값 · 0029의 CHECK(새 값 허용 · 모르는 값 거부 · 기존 행 보존 · 트리거 그대로).
   - 검사 단계 · 병합 재검사에 끼는 자리의 시험(`contract.test.ts` 또는 기존 OpenAPI 시험의 자리): AsyncAPI 계약 검사 규칙이 판정되고, 실패가 OpenAPI의 형식 오류와 같은 길을 탄다.
   - **CI 시간**: `contract-runner.test.ts`는 무겁다(판정 묶음). 더한 시험의 소요 시간을 재서 보고한다(`checks`가 16 ~ 22분, 다시 보는 선 25분). 사례를 한 번의 도구 실행에 묶을 수 있으면 묶는다.
4. **픽스처**: `fixtures/sample-next-app`에 AsyncAPI 문서를 더할 필요가 있는지 판단한다(수용 기준은 단위 시험만 요구한다. 픽스처 · 변형 스크립트 · 파이프라인 e2e를 넓히지 않는 쪽이 기본. 시험용 문서는 시험 안에서 만든다).
5. **ADR-148**: `@asyncapi/cli`를 쓰지 않는 근거(ADR-130의 실측을 인용: 패키지 1047개와 350MB, 기본 설정의 익명 사용 기록 전송), 대체 도구와 판, 그 실측(패키지 수 · 크기 · 잠금 파일 증가 · 설치 스크립트 · 네트워크 호출 여부와 확인 방법), 격리 방법(자식 프로세스 · cwd · 환경 변수 · 바깥 참조 차단 목록), 결과 규칙(OpenAPI와 같은 갈래), 지원 판, 한계(구현 일치 검사 없음: ADR-033, 그 밖), 다시 정하는 조건. ADR-033의 본문은 고치지 않는다(교체 사실은 ADR-148에). `docs/architecture.md`의 계약 검사 절 · 실행기 표를 사실에 맞게 고친다.

## 하지 않는 것
- AsyncAPI의 구현 일치 검사, Breaking 분류, Prisma 실행기(M3-48 보류, #287), OpenAPI 실행기의 동작 변경, `docs/spec/*` · `docs/roadmap.md` 수정.
- 0001 ~ 0027(과 0028) 마이그레이션 수정.
- CI가 무관한 시험으로 빨강이면 다시 돌리지 말고 보고한다. `ci` 성공까지 확인한 뒤 보고한다(대기 30분까지).
- 엔진 · 판정을 고쳤으므로 파이프라인 e2e 대상이다: 로컬 `pnpm e2e:pipeline`은 오래 걸리므로(약 70분) 계약 관련 파이프라인 e2e 파일만 로컬에서 돌리고 나머지는 CI에 맡긴다.

## 보고
공통 지침의 보고 형식 + 도구 실측 표(후보마다), 고른 도구와 판, 0029의 내용과 0028과의 관계(다시 확인이 필요한지), 새 시험의 소요 시간, 네가 새로 정한 것, 한계, 멈췄다면 어디서 왜.
