너는 chanrhan/bive 저장소의 이슈 #47(로드맵 M3-02 "파서 기초: import 그래프 · 블록 판정 (dependency-cruiser)")를 구현하는 서브에이전트다. `packages/parser`의 첫 실제 기능이다. 뒤 이슈 M3-03(#48, 구조 검사 내장 규칙 · 검사 단계 통합)이 이 결과 위에 선다.

## 받은 값
- 이슈 번호 `<N>` = 47, 브랜치 `<B>` = `feat/47-parser-graph`, ADR 번호 `<A>` = ADR-125, 커밋 `<T>` = `feat(parser)`, 화면 변경 없음(화면 e2e · 스모크는 돌리지 않는다). 마이그레이션 없음.
- 기준 main `03756a7`(PR #274 = M3-01 병합 뒤). `git fetch origin main && git checkout -b feat/47-parser-graph origin/main`. `git merge-base --is-ancestor 97b4d86 HEAD` 확인.
- 병렬로 PR(이슈 #201, 앱 화면, ADR-124)이 진행 중이다. `packages/app/src/renderer`와 화면 시험만 고친다. 겹치지 않는다. 먼저 병합되면 main을 병합해 ADR을 번호 순서대로 둔다.
- 이 이슈는 **파서 패키지와 스크립트, 픽스처 변형**만 다룬다. 오케스트레이터의 검사 단계에 잇는 일 · 내장 규칙 · RPC · 화면은 M3-03 이후다. 오케스트레이터 · store · app을 고치지 않는다(필요해 보이면 멈추고 보고).

## 먼저 읽을 것 (순서대로, 전부)
1. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-common.md` 공통 지침. 그대로 따른다.
2. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/m3-handoff.md` 전부. 특히 "M3-01" 절(블록 선언 스키마, `matchesBlockPattern`, 정규식 변환 함수가 없는 이유, 예제 선언, 넘겨받은 결정 거리).
3. `docs/decisions.md`의 ADR-033(기존 도구의 출력을 변환만 한다. 모듈 해석기 · 판별 규칙 엔진을 직접 만들지 않는다), ADR-122(특히 ② 패턴과 M3-02가 쓸 방법, ③ 저장 때 보지 않는 것), ADR-005, ADR-026(판정 격리), ADR-120(깨진 입력은 닫힌 쪽).
4. 명세: `docs/spec/prd.md`의 DSN-01 · JDG-05와 블록 · 공개 인터페이스 · 의존 방향을 다루는 절, `docs/spec/plan.md`의 블록 용어, `docs/spec/screens.md`에서 아키텍처 화면이 보이는 값(이 이슈가 만드는 데이터의 나중 소비자). 내용이 다르면 PRD > 화면 정의서 > 기획서.
5. 이슈 본문 수용 기준 4개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/47`)와 뒤 이슈 #48 본문(이 결과를 어떻게 쓰는지), 로드맵 `docs/roadmap.md`의 M3 완료 흐름에서 `make-variant.sh`가 나오는 줄(변형 이름: `undeclared-import` · `cycle`은 이 이슈, `touch-lib` · `contract-mismatch` · `flaky` · `postgres`는 뒤 이슈).
6. `docs/architecture.md` 2장(패키지 의존 방향: parser가 무엇에 기대도 되는가), `packages/parser`의 현재 내용(거의 비어 있다), `packages/shared/src/blocks.ts`, `fixtures/sample-next-app`의 구조와 `fixtures/blocks/sample-next-app.json`, `scripts/reset-fixture.sh` · `scripts/test-reset-fixture.sh`, `.claude/skills/dev-env/SKILL.md`(픽스처 설치 · 초기화).

## 해야 할 것 (수용 기준 순서)
1. **import 그래프.** `dependency-cruiser`를 parser의 의존성으로 더한다(ADR-033이 정한 도구. 버전은 npm 조회 뒤 정확한 버전으로 고정, lockfile 갱신. 설치가 이 VM의 네트워크 정책에 막히면 돌아가지 말고 멈춰서 보고한다). 그 JSON 출력(`--output-type json` 또는 같은 내용을 주는 공식 API)을 **변환만** 해 그래프(모듈 = 프로젝트 루트 기준 상대 경로, 간선 = import)를 만든다. 자체 모듈 해석기(경로 별칭 풀기, 확장자 추측, `index` 찾기)를 만들지 않는다. `parser/test/graph.test.ts`가 그래프와 "자체 해석기를 쓰지 않음"을 단언한다(무엇으로 단언할지 정한다: 예를 들어 tsconfig 경로 별칭(`@/…`)으로 쓴 import가 dependency-cruiser가 푼 경로로 나오고 parser 소스에 해석 코드가 없음을 구조 단언으로).
   - 어떤 파일을 그래프에 넣는가(소스 확장자, `node_modules` · 빌드 산출물 · `bive-acceptance/` · 테스트 파일 · 타입 전용 import · 동적 import · 프로젝트 밖으로 푼 경로)를 명세와 뒤 이슈의 쓰임에 맞게 정해 ADR-125에 적는다. 모호하면 가장 작은 쪽.
2. **파일과 블록 매핑.** 블록 선언(shared 스키마)과 파일 목록으로 파일 → 블록을 정한다. 판정은 **`matchesBlockPattern`만** 쓴다(패턴을 정규식으로 옮기지 않는다. 그 함수는 폭주 때문에 지워졌다). 미분류 파일 목록(어느 블록의 `include`에도 안 맞는 파일)을 낸다. M3-01이 넘긴 결정 거리를 여기서 정해 ADR-125에 적는다:
   - 한 파일이 두 블록의 `include`에 맞을 때(저장 때는 글자가 같은 패턴만 거부했다): 오류로 드러낼지, 우선순위를 둘지. **조용히 하나를 고르지 않는다.**
   - `public` 패턴이 그 블록 `include` 밖을 가리킬 때.
   - 대소문자, 경로 정규화(`src//a`, 역슬래시, `./`): dependency-cruiser가 주는 경로 형태를 확인하고 한 가지 형태로 맞춘다.
   - 선언이 없을 때(`null`): 블록 판정 · 위반 판별을 하지 않고 그래프만 낸다(M3-03은 선언이 있을 때만 구조 검사를 한다).
3. **위반 판별.** 선언 외 방향(`dependsOn`에 없는 블록으로의 import), 공개 API 외 접근(다른 블록의 `public` 밖 파일을 import), 순환을 **블록 선언에서 생성한 dependency-cruiser 규칙의 위반 출력으로** 판별한다(판별 규칙 엔진을 직접 만들지 않는다). ADR-122 ②의 안내대로, 규칙의 `path`에는 패턴을 옮긴 정규식이 아니라 2번에서 정한 **파일 경로를 정규식 이스케이프해 넣은 것**을 쓴다(파일 목록을 먼저 얻는 실행 한 번 + 규칙을 넣은 실행 한 번이 되어도 된다).
   - 파일이 많은 프로젝트에서 규칙의 `path`가 길어지는 비용을 재서(픽스처와, 파일 2천 개쯤의 합성 입력) ADR에 적는다. 생성한 정규식이 폭주하지 않음을 시험한다(이스케이프한 글자 그대로의 대안 나열이라 역추적이 없어야 한다. 파일 이름에 정규식 특수 글자 · 공백 · 유니코드가 든 경우 포함).
   - 위반 한 건의 모양(종류, from 파일 · 블록, to 파일 · 블록, 순환이면 경로)을 M3-03이 판정 기록으로 저장하고 화면이 보일 수 있게 정한다. 종류 이름은 로드맵의 내장 규칙 이름(`structure.public-api-only` · `structure.declared-direction`)과 순환에 대응되게 한다.
   - 같은 블록 안 import, 미분류 파일이 낀 import, `shared` 종류 블록(명세가 어떤 뜻을 주는지 확인)의 취급을 명세에서 정하고 ADR에 적는다.
4. **변형 스크립트.** `scripts/make-variant.sh <dir> <이름>`을 더한다. `<dir>`은 `scripts/reset-fixture.sh`로 만든 픽스처 사본이다. `undeclared-import`(선언 외 방향 import 하나)와 `cycle`(순환 하나) 변형을 만들고, 로드맵 완료 흐름이 `git -C $FX revert --no-edit HEAD`로 되돌리므로 **변형마다 커밋 하나**를 만든다. 모르는 이름 · 없는 폴더 · 픽스처가 아닌 폴더 · 더러운 작업 트리는 0이 아닌 종료 코드와 한 줄 안내로 거부한다(원본 `fixtures/sample-next-app`에 직접 쓰지 못하게 한다). 뒤 이슈가 변형을 더하기 쉬운 모양으로 둔다(이름별 함수). `scripts/test-reset-fixture.sh`와 같은 방식의 스크립트 시험을 두고 CI `checks`에서 돌게 한다(기존 스크립트 시험이 CI에서 어떻게 도는지 보고 맞춘다). 시험이 예제 선언(`fixtures/blocks/sample-next-app.json`)으로 원본에서 위반 0건, 두 변형에서 **각각 정확히 1건**(종류도 맞게)임을 단언한다. 변형의 git 커밋은 서명 설정 때문에 실패할 수 있다(`dev-env` 스킬의 방법을 따른다).

## 반드시 지킬 것 (무결성)
- **분석 대상 프로젝트의 코드를 실행하지 않는다.** 대상 프로젝트의 파일은 구현 역할이 쓴다. dependency-cruiser가 대상 프로젝트 안의 설정 파일(`.dependency-cruiser.js|cjs|mjs|json`), webpack · babel 설정, `tsconfig`가 가리키는 JS 플러그인, `package.json`의 스크립트 등을 **읽어 실행하는 길이 없어야 한다**. 규칙 설정은 parser가 만들어 프로젝트 폴더 **밖**(임시 폴더)에 두거나 메모리로 넘기고, 대상 프로젝트의 설정을 자동으로 찾는 기능을 끈다. dependency-cruiser 문서 · 소스에서 어떤 옵션이 프로젝트 코드를 `require`/`import`하는지 확인해 목록과 끈 방법을 ADR-125에 적고, "대상 프로젝트에 실행하면 파일을 남기는 설정 파일을 심어 두고 분석해도 그 파일이 생기지 않는다"를 시험으로 고정한다(설정 파일 종류별로). `tsconfig.json`은 데이터로만 읽히는지(확장 `extends`가 프로젝트 밖 · `node_modules`를 가리키는 경우 포함) 확인한다. 끌 수 없는 실행 경로가 있으면 구현하지 말고 멈춰서 보고한다(ADR-026의 판정 격리 안에서 돌려야 하는지는 조율자가 정한다).
- 자식 프로세스로 돌린다면: 실행 파일은 parser 자신의 의존성에서 찾고(대상 프로젝트의 `node_modules/.bin`이 아니다), 인자는 배열로 넘기며(셸 문자열 금지), 작업 디렉터리 · 환경 변수(특히 `NODE_OPTIONS` · `NODE_PATH`)를 통제하고, 시간 제한과 출력 크기 상한을 둔다. 시간 초과 · 깨진 JSON · 0이 아닌 종료는 닫힌 쪽(오류)이고 "위반 0건"으로 읽히지 않는다. 기호 링크로 프로젝트 밖을 가리키는 파일은 따라가지 않는다.
- 출력의 경로 · 모듈 이름은 구현 역할이 정할 수 있는 글이다. 이 이슈는 화면 · 세션 입력에 싣지 않지만, 결과 모양에 길이 · 개수 상한을 두고(넘으면 잘랐다는 사실이 결과에 드러나게) ADR에 적는다.
- parser의 의존 방향은 `docs/architecture.md` 2장을 따른다(shared에만 기대는 것이 맞는지 확인. store · orchestrator에 기대지 않는다).
- 방어 · 판정 규칙마다 "빼면 빨강"인 시험을 두고 변이 결과 표를 PR 본문에 낸다.
- `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md`를 고치지 않는다. 구조 시험을 느슨하게 만들지 않는다. 기존 픽스처 원본의 소스는 바꾸지 않는다(변형은 사본에만).
- 바뀐 파일이 40개를 넘을 것 같으면 멈추고 보고한다. 쪼갤 경계는 "(1 · 2) 그래프와 매핑" / "(3) 위반 판별" / "(4) 변형 스크립트".
- 완료 조건 명령: 설치 · 린트 · 타입 · 빌드 · 형식 · 단위 테스트(격리 `TMPDIR`, 알려진 두 시험만 실패 허용). 오케스트레이터를 고치지 않으므로 파이프라인 e2e는 CI에 맡긴다. 새 의존성으로 설치 시간 · CI `checks` 시간이 얼마나 늘었는지 보고한다.

## 보고
공통 지침의 보고 항목에 더해: 수용 기준 4개별 한 일과 근거 시험, 고른 dependency-cruiser 버전과 부르는 방식(CLI · API)과 그 이유, 프로젝트 코드를 실행할 수 있는 옵션 목록과 끈 방법 · 시험, 결과 모양(그래프 · 매핑 · 미분류 · 위반)의 형식, 2번의 결정 네 가지, 비용 측정(픽스처 · 합성 2천 파일의 실행 시간과 규칙 크기), 변이 결과 표, M3-03(#48)에 넘길 사실, 발견했지만 고치지 않은 것. 짧게, 한국어로.
