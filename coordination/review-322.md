너는 chanrhan/bive 저장소의 PR #322(이슈 #294, 로드맵 M3-49 "AsyncAPI 계약 검사 실행기 (유효성 검사, 도구 교체)")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경 한 줄
등록된 AsyncAPI 계약의 유효성만 판정하는 실행기(ADR-148). `@asyncapi/cli` 대신 `@asyncapi/parser@3.6.3`을 도구 자식 프로세스의 BIVE 진입 스크립트(`packages/orchestrator/runner/asyncapi-validate.mjs`)에서 부른다. 판정 실행기 값 `asyncapi-parser`, 마이그레이션 `project/0029_asyncapi_judge_runner`(`judgments` 표 다시 만들기). 구현 일치 검사는 범위 밖(ADR-033).

## 받은 값
- PR #322, 브랜치 `feat/294-asyncapi-contract-runner`, 헤드 `95c48a083173b2567163480d6e4b47a46df457c2`, 기준 main `22c66c7`. 바뀐 파일 18개(+2758 / -45, 그 가운데 `pnpm-lock.yaml` +1177). `ci`는 네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/95c48a083173b2567163480d6e4b47a46df457c2/check-runs`로 확인한다(검토를 시작할 때는 도는 중일 수 있다. 끝낼 때 한 번 더 보고 그 상태를 적는다. 기다리지 않는다).
- 네 작업 공간에서 `git fetch origin feat/294-asyncapi-contract-runner` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-294.md`(구현자가 받은 지시서), `brief-common.md`, `m3-handoff.md`의 "M3-47" · "M3-04" · "M3-46" · "M3-08" · "M3-31" · "M3-52" 절, `pr322-body.md`(PR 본문 사본, 변이 표 포함).
3. 이슈 본문 수용 기준 2개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/294`).
4. `docs/decisions.md`의 ADR-148(이 PR이 더함) · ADR-033 · ADR-130 · ADR-132 전부 · ADR-129 · ADR-125 · ADR-136(유형 B) · ADR-145(0028의 트리거). `docs/spec/prd.md`의 NRM-03 · NFR-01 · NFR-02 · NFR-04.

## 구현자가 정한 것 (네가 타당성을 판정한다)
- 도구: `@asyncapi/parser@3.6.3`(최신 3.6.6은 `@scarf/scarf`의 postinstall이 설치 때 사용 기록을 보낸다고 함). 루트 `pnpm.overrides`에 부모 선택자로 `@asyncapi/parser@3.6.3>@stoplight/spectral-core: 1.23.0` · `…>@stoplight/spectral-functions: 1.10.3` · `@stoplight/spectral-functions@1.10.3>@stoplight/spectral-formats: 1.8.3`을 넣어 scarf를 피했다. 실측: 닫힘 패키지 159개, 44MB, 잠금 파일 +1177줄, 설치 스크립트 없음.
- 격리: OpenAPI 실행기와 같은 도구 자식 프로세스(`contract-check/tool.ts`)에서 진입 스크립트가 `parse`를 부른다. 라이브러리는 오케스트레이터 패키지에서 불러온다.
- 바깥 참조 차단 두 겹: 사전 검사 `asyncapi-document.ts`(`$ref` · `$dynamicRef` · `$recursiveRef` 값이 `#`로 시작하지 않으면 도구를 부르지 않음) + 진입 스크립트의 가로채는 리졸버(기본 리졸버보다 먼저 돌게 순서 값 1, 라이브러리의 `__unstable` 선택 항목에 기댐).
- 결과: 유효 = `pass`. 유효성 오류 · 읽지 못하는 문서 = 막지 않는 `fail`(ADR-132의 OpenAPI 형식 오류와 같은 길). 바깥 참조 · 도구가 검사하지 못하는 `schemaFormat`(Avro 등) = 판정 없음(새 사유 `unsupported_schema_format`). 도구 오류 = `judge_runner_error`(`stage: contract`).
- 0029: `judgments` 표를 0025처럼 다시 만들고, 본문이 `judgments`를 읽는 0028의 트리거 `review_items_resolve_quarantine`을 지웠다가 0028과 글자까지 같게 다시 만든다.
- **유형 B: AsyncAPI 계약 검사 규칙을 유형 B 실행 대상으로 받게 됐다**(`run.test.ts`의 기존 시험 하나를 고침).
- 판정 기록의 실행기 값을 계약 종류별 표 `CONTRACT_JUDGE_RUNNERS`에서 꺼낸다. 시험용 시간 제한 옵션 `contractAsyncApiTimeoutMs`.
- 픽스처 · 변형 스크립트 · 파이프라인 e2e는 넓히지 않았다. 앱 표시명 표는 더하지 않았다(판정 실행기 표시명 표가 원래 없다고 함).

## 꼭 판정할 것
1. **범위와 불변.** `git diff 22c66c7...HEAD --stat`. `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · 워크플로 · 머지된 마이그레이션(0001 ~ 0028)이 바뀌지 않았는가. 기존 시험 파일의 `-` 줄 전부. **OpenAPI 실행기의 동작이 그대로인가**(`steps/contract-check.ts` +160 · `tool.ts` +8 · `judging.ts` +5가 OpenAPI 갈래를 바꾸지 않는가: 기존 OpenAPI 시험이 고쳐지지 않고 통과하는가, `CONTRACT_JUDGE_RUNNERS`로 바꾼 것이 기존 값 `redocly-prism`을 그대로 내는가). ADR-033 본문을 고치지 않았는가.
2. **공급망 (가장 먼저, 꼼꼼히).**
   - `pnpm-lock.yaml`의 `+` 줄에서 더해진 패키지 전부를 훑는다: `@scarf/scarf`가 없는가, `requiresBuild` · 설치 스크립트를 가진 패키지가 없는가(잠금 파일의 표시와 `node_modules/.pnpm/*/node_modules/*/package.json`의 `scripts.preinstall|install|postinstall` · `binding.gyp`를 직접 센다), `pnpm.onlyBuiltDependencies`가 그대로인가. 잠금 파일의 `-` 6줄이 무엇인가(**기존 패키지의 판이 바뀌었는가**: `@redocly/cli` · `@stoplight/prism-cli`가 쓰는 spectral · ajv 등의 판이 이 PR로 달라지면 OpenAPI 실행기의 동작이 바뀔 수 있다. overrides가 부모 선택자라 다른 부모에는 안 걸린다는 주장을 잠금 파일로 확인).
   - 구현자의 주장 "3.6.6은 scarf의 postinstall이 있고 3.6.3 + 하위 판 고정에는 없다"를 직접 확인한다(레지스트리의 `package.json` 의존성 나열로: `pnpm view @asyncapi/parser@3.6.6 dependencies` · `pnpm view @stoplight/spectral-core@<판> dependencies` 등. 네트워크가 막히면 "못 함"). 고정한 판들이 서로의 요구 범위 안인가.
   - 3.6.3이 최신이 아닌 것의 비용: 3.6.3과 고정한 하위 판들에 알려진 취약점이 있는가(`pnpm audit --prod`가 되면 이 PR 전후의 차이만. 안 되면 "못 함"). ADR-148이 "최신으로 올리는 조건"을 적었는가.
   - 설치가 `--frozen-lockfile`로 재현되는가, `pnpm install` 로그에 건너뛴 빌드 스크립트 경고에 새 패키지가 있는가.
3. **격리 · 네트워크 (NFR-02 · NFR-04).**
   - 진입 스크립트 `runner/asyncapi-validate.mjs`(68줄)를 줄마다 읽는다. 무엇을 입력으로 받고(문서 내용을 인자 · 표준 입력 · 파일 가운데 무엇으로) 무엇을 출력하는가. 자식 프로세스의 cwd · 환경 변수(`tool.ts`의 허용 목록 그대로인가. `NODE_OPTIONS` · `NODE_PATH` · 프록시 변수가 넘어가지 않는가) · 시간 · 출력 상한 · 중단 신호.
   - **라이브러리가 어디서 불려 오는가**: 진입 스크립트의 `import`가 오케스트레이터 패키지의 `node_modules`로만 풀리는가. 도구 폴더(cwd)나 대상 프로젝트에 같은 이름의 패키지를 두면 그쪽이 불리는가(구현자의 대조군 시험을 읽고, 없는 경우를 직접 시도). 패키징된 앱에서의 경로는 한계로 적혔는가.
   - **바깥 참조**: 사전 검사가 보는 열쇠가 `$ref` · `$dynamicRef` · `$recursiveRef`뿐이다. AsyncAPI 2.x · 3.x 명세와 `@asyncapi/parser` · spectral · `@stoplight/json-ref-resolver`의 소스에서 **바깥을 읽을 수 있는 다른 자리**를 찾는다: 예 `schemaFormat`에 따른 스키마 파서, 메시지 `payload`의 문자열 참조, `externalDocs`(읽지 않는 것이 맞는가), 서버 · 채널의 `$ref`, YAML 앵커 · 병합 키로 숨긴 `$ref`, 열쇠 이름을 이스케이프한 JSON, `$ref` 값이 `#`로 시작하지만 리졸버가 바깥으로 해석하는 꼴, **`#`로 시작하지 않는 같은 문서 안 참조**(상대 조각)로 유효한 문서가 판정 없음이 되는 경우. 둘째 겹(가로채는 리졸버)이 첫 겹 없이도 막는가(첫 겹을 끄고 로컬 서버 요청 0건 · 파일 읽기 0건을 센다). `__unstable` 선택 항목이 없어지는 판에서 조용히 뚫리는가(둘째 겹이 동작하지 않을 때 닫힌 쪽으로 끝나는 확인이 코드에 있는가).
   - 문서가 도구를 오래 붙잡거나 메모리를 터뜨리는 입력(깊은 중첩 · 순환 `$ref` · 아주 큰 문서)에서 시간 초과 · 출력 초과가 닫힌 쪽인가.
4. **결과 규칙.**
   - `pass`가 나오는 길을 전부 추적한다: 도구가 "유효"라고 한 경우뿐인가. 도구 출력의 모양 검사(종료 코드만 믿지 않음), 진단 0건인데 문서 객체가 없는 경우, 경고만 있는 경우(경고는 `pass`인가: ADR에 정했는가), 내부 오류.
   - **유효성 오류 = 막지 않는 `fail`**: ADR-132의 OpenAPI 형식 오류와 같은 갈래에 들어갔는가(코드로 대조). 그 결과 "형식이 틀린 AsyncAPI 계약이 있어도 실행은 병합된다"가 ADR 한계에 사실대로 있는가.
   - **판정 없음**: 바깥 참조와 `unsupported_schema_format`. 판정 없음이 "통과로 세지 않음 · 막지 않음 · 기록 없음"(ADR-132)과 같은가. 구현 코드가 고를 수 있는 사유가 판정 없음에 들어가 있지 않은가(계약 문서는 등록 커밋의 것이라 구현 역할이 못 바꾼다: 맞는지 `readContractBlob` 호출 자리로 확인). `schemaFormat`의 판별(기본 형식 · AsyncAPI 스키마 · JSON Schema draft · OpenAPI 스키마는 검사됨, Avro · RAML · Protobuf는 판정 없음)이 라이브러리가 실제로 검사하는 것과 맞는가(라이브러리가 모르는 형식을 "유효"라고 하는지 직접 실행).
   - 지원하지 않는 판(1.2.0 · 9.9.9) · AsyncAPI가 아닌 문서 = `fail`이 맞는가(등록 때 `norms/contract.ts`가 무엇을 거르는가와 견줌).
   - 케이스 요약: 진단 메시지에 문서 안의 글이 실린다. 표시 값 변환 · 건수와 길이 상한이 OpenAPI 판정 기록과 같은 함수인가.
5. **마이그레이션 0029.**
   - 0025와 줄마다 견준다: `judgments` 표의 칸 · CHECK · 색인 · 트리거가 다시 만든 뒤 **0028까지 적용된 DB와 글자까지 같은가**(CHECK의 실행기 값만 다름). `sqlite_master`를 0028 적용 뒤와 0029 적용 뒤로 떠서 `judgments` 관련 객체와 그 밖의 객체 전부를 비교한다(시험 안에서 하거나 scratchpad의 임시 스크립트로).
   - 0028의 트리거 `review_items_resolve_quarantine`을 지웠다 다시 만드는 SQL이 0028의 것과 글자까지 같은가(0028의 상수를 가져다 쓰는가, 베껴 적었는가: 베꼈으면 어긋날 수 있다). `judgments`를 본문에서 읽는 **다른** 트리거 · 뷰가 0001 ~ 0028에 더 없는가(전부 grep). `review_items`의 트리거 순서가 그대로라는 주장.
   - 행 보존: 판정 기록이 있는 DB(격리 기록 `runId`/`stepId` null 포함)에 적용해 행 수 · 값이 같은가. 외래 키 검사. 트랜잭션 안에서 도는가(중간 실패 시 되돌림).
   - 병렬 이슈 #319가 0030을 쓴다(`review_items` · 뷰를 건드릴 수 있다): 0029가 남기는 "뒤에 `judgments`를 다시 만드는 마이그레이션도 이 트리거를 다시 만들어야 한다"가 코드 주석 · ADR에 있는가.
6. **유형 B 변경.** AsyncAPI 계약 검사 규칙을 유형 B 실행 대상으로 받게 한 것이 이 이슈의 범위인가. ADR-136 · ADR-132가 OpenAPI 계약 검사 규칙에 대해 정한 것과 같은 규칙을 AsyncAPI에 적용한 것인가(실행기가 있는 계약 종류만 유형 B 대상이라는 기존 규칙의 자연스러운 결과인가, 새 결정인가). `run.test.ts`의 고친 단언이 약해지지 않았는가. 유형 B에서 AsyncAPI 규칙만 대상인 실행이 무엇을 하는가(판정 서버를 띄우는가: 유효성 검사만이면 서버 · 기록 프록시가 필요 없다. 헛도는 설치 · 빌드가 있는가).
7. **시험.** `contract-runner.test.ts`(+750)를 읽고 단언이 뜻을 고정하는지 본다. 실제 도구를 도는 시험과 가짜 도구를 쓰는 시험의 구분. 격리 대조군이 "방어를 끄면 실제로 뚫린다"를 보이는가. `migrate.test.ts`(+116). 새 시험의 소요 시간(구현자: 약 14초)을 재 본다. `integrity.test.ts`가 그대로 통과하는가.
8. **ADR-148과 architecture.md.** 수용 기준 2의 근거(패키지 1047개와 350MB, 익명 사용 기록 전송)와 대체 도구의 실측(패키지 수 · 네트워크 호출 여부)이 ADR에 있는가. 문장마다 코드와 맞는가. ADR 머리줄 순서 147 · 148. `grep -c 'udb40' docs/decisions.md`는 2.
9. **변이.** 구현자의 것(PR 본문 표: 리졸버 순서 · 둘째 겹의 판정 없음 · 내부 오류 거부 · `schemaFormat` 검사 · 0028 트리거 다시 만들기)과 겹치지 않게 7 ~ 9종. 후보: ⓐ 사전 검사에서 `$dynamicRef` 빼기, ⓑ 유효성 오류를 회귀하는 `fail`로, ⓒ 도구 종료 코드 0이면 출력 검사 없이 `pass`, ⓓ 경고를 오류로 세기(또는 반대), ⓔ `unsupported_schema_format`을 `pass`로, ⓕ 자식 프로세스에 부모 환경 변수 넘기기, ⓖ 0029의 CHECK에서 기존 값 하나 빼기, ⓗ `CONTRACT_JUDGE_RUNNERS`에서 OpenAPI 값을 새 값으로 바꾸기, ⓘ 시간 초과를 판정 없음으로, ⓙ 등록 해시 대조 없이 문서 읽기. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다(제품에서 생기지 않는 상태면 근거와 함께 비차단).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(파일 단위, `TMPDIR=$(mktemp -d /tmp/tr322.XXXX)`): orchestrator `contract-runner` · `contract` · `run` · `integrity` · `review-queue`, store `migrate` · `review-queue`, shared `enums` · `protocol`. 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번(격리 `TMPDIR`). 알려진 두 시험만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. 화면 e2e · 스모크 · `pnpm e2e:pipeline`은 돌리지 않는다(CI가 기준).
- 직접 확인용 임시 파일은 scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r322-probe/` 아래에 둔다. 로컬 서버는 127.0.0.1의 임의 포트만 쓰고 끝나면 닫는다. 바깥 네트워크로 나가는 시험을 하지 않는다(레지스트리 조회 `pnpm view`만 예외).
- 숨은 글자: 바뀐 파일 가운데 `pnpm-lock.yaml`을 뺀 17개를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다(python · sed 한 줄로 고치지 않는다). 스크립트 파일로 감싸 거부를 피하기, 옵션이나 도구를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 끝낼 때 작업 트리가 깨끗한지와 네가 띄운 프로세스가 남지 않았는지 확인한다(네 PID만 끝낸다).
- 시간 제한은 없다. 2번(공급망) · 3번(격리) · 5번(마이그레이션)을 가장 먼저 한다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 2개별 충족 여부와 근거(파일:줄, 시험).
- 공급망 판정(더해진 패키지 수 · 설치 스크립트 유무 · 기존 패키지의 판 변화 · scarf 주장 확인 결과).
- 격리 판정(바깥 참조의 다른 자리 목록과 각각의 결과), 결과 규칙 판정, 0029 판정(`sqlite_master` 비교 결과), 유형 B 변경 판정.
- 변이 결과 표(변이, 빨강이 된 시험).
- 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, 못 한 것, 끝낼 때의 check-runs 상태.
- 남은 지적이 한 번의 수정으로 닫힐 크기인지 한 줄.
