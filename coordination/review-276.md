너는 chanrhan/bive 저장소의 PR #276(이슈 #47, 로드맵 M3-02 "파서 기초: import 그래프 · 블록 판정 (dependency-cruiser)")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일한다. `packages/parser`의 첫 실제 기능이고, 뒤 이슈 M3-03(#48, 구조 검사 내장 규칙 · 검사 단계 통합)이 이 결과 위에 선다.

## 받은 값
- PR #276, 브랜치 `feat/47-parser-graph`, 헤드 `413e8583014918f37a1725ed6486949c73351c56`, 기준 main `03756a7`. 바뀐 파일 27개(+2692 / -2): `packages/parser/src/*`(11파일) · `packages/parser/runner/cruise.mjs` · 파서 시험 4개 + 도우미, `scripts/make-variant.sh` · `test-make-variant.sh` · `variant-violations.mjs`, 루트 `package.json`(`pnpm.packageExtensions`) · `pnpm-lock.yaml`(+284) · `.github/workflows/ci.yml`(단계 하나), `docs/decisions.md`(ADR-125) · `docs/architecture.md`. 이 헤드에서 CI `ci` · `checks` · `pipeline-e2e` 두 묶음은 모두 success다(조율자가 check-runs로 확인).
- 네 작업 공간에서 `git fetch origin feat/47-parser-graph && git checkout --detach FETCH_HEAD`로 본다. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-47.md`(구현자가 받은 지시서. 특히 "반드시 지킬 것 (무결성)"), `brief-common.md`, `m3-handoff.md`의 "M3-01" 절, `pr276-body.md`(PR 본문 사본, 변이 표 M1 ~ M34 · V1 ~ V8).
3. 이슈 본문 수용 기준 4개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/47`)와 뒤 이슈 #48 본문.
4. `docs/decisions.md`의 ADR-125(이 PR이 더함) · ADR-033 · ADR-122 · ADR-026 · ADR-120, `docs/architecture.md` 2장(패키지 의존 방향), 명세 `docs/spec/prd.md`의 DSN-01 · JDG-05와 블록 · 공개 인터페이스 · 의존 방향 절.

## 꼭 판정할 것
1. **범위와 의존 방향.** `git diff 03756a7...HEAD --stat`. 오케스트레이터 · store · app · 시나리오 · `docs/spec/*` · `CLAUDE.md` · 구조 시험이 바뀌지 않았는가. parser가 shared에만 기대는가(architecture 2장). 픽스처 원본(`fixtures/sample-next-app`) 소스가 바뀌지 않았는가.
2. **분석 대상 프로젝트의 코드를 실행하지 않는가(가장 중요).** 대상 프로젝트의 파일은 구현 에이전트가 쓴다. 분석은 오케스트레이터 권한으로 돈다(판정 격리 밖).
   - 구현자는 CLI 대신 공식 API `cruise`를 자식 프로세스(`packages/parser/runner/cruise.mjs`)에서 부르고, 허용 옵션 밖을 거부하며, 환경 변수를 비우고, 프로젝트 밖 작업 폴더에서 돌린다고 한다. `node_modules/dependency-cruiser`(18.7.2)의 소스를 직접 읽어 `cruise` API 경로에서 **대상 프로젝트의 파일을 `require` · `import` · `eval`하거나 자식 프로세스로 실행하는 곳**을 전부 찾는다: 설정 찾기(`.dependency-cruiser.*`), `extends`, webpack 설정(`webpackConfig`), babel 설정(`babelConfig`), tsconfig 읽기(`tsConfig` · `tsPreCompilationDeps` · `extends`가 `node_modules` 패키지를 가리킬 때의 해석), 변환기 찾기(대상 프로젝트의 `typescript` · `svelte` · `vue` · `coffeescript` 등을 대상 프로젝트의 `node_modules`에서 `require`하는가: **가장 의심스러운 곳이다**. "dependency-cruiser 자신의 자리에서만 찾음"이라는 주장을 소스로 확인한다. 작업 폴더(`cwd`) · `baseDir` 기준으로 찾는 경로가 하나라도 있으면 그 폴더가 어디인지 본다), enhanced-resolve의 플러그인 · `package.json`의 `exports` · `main`(데이터로만 읽히는가), 캐시(`cache` 옵션이 대상 폴더에 쓰는가), 보고서 플러그인, `.npmrc` · `.pnpmfile.cjs`.
   - 실행기가 받는 입력(옵션 · 규칙 · 경로)을 대상 프로젝트의 글이 바꿀 수 있는 길이 있는가(파일 이름이 인자 · 정규식 · JSON에 들어가는 자리에서 이스케이프 · 구조 유지).
   - 자식 프로세스: 실행 파일이 무엇이고 어디서 찾는가(`process.execPath`인가, PATH의 `node`인가), 인자가 배열인가, `cwd`가 프로젝트 밖인가, 환경 변수가 정말 비었는가(`NODE_OPTIONS` · `NODE_PATH` · `PATH` · `HOME`. 빈 환경에서 node가 `~/.noderc` 류를 읽는 길은 없는가), 시간 제한 뒤 자식과 손자 프로세스가 죽는가, 출력 상한을 넘으면 닫힌 쪽인가, stderr가 오류 메시지에 실려 화면 · 로그로 새는가(값 크기 · 내용).
   - `isolation.test.ts`: 심은 파일 종류마다 "대조군에서는 표시 파일이 생기고 분석에서는 안 생긴다"를 보는가(대조군이 없으면 시험이 아무것도 증명하지 않는다). 빠진 종류가 있는가: 대상 프로젝트 `node_modules` 안의 가짜 `typescript` · `@swc/core` · `svelte/compiler` · `vue-template-compiler` · `coffeescript` · `livescript`, 가짜 `enhanced-resolve` 플러그인, `tsconfig.json`의 `extends`가 가리키는 **JS 파일**, 기호 링크로 프로젝트 밖을 가리키는 소스 · 폴더, 프로젝트 루트 자체가 기호 링크. 네가 빠진 종류 두세 개를 직접 심어 본다(작업 공간 안의 임시 폴더에서, 표시 파일도 그 안에).
   - 끌 수 없는 실행 경로가 하나라도 있으면 차단이다(그 경우 판정 격리 안에서 돌려야 하는지는 조율자가 정한다. 경로와 근거 소스 위치를 정확히 적는다).
3. **ADR-033: 변환만 하는가.** parser 소스에 자체 모듈 해석(별칭 풀기, 확장자 추측, `index` 찾기)과 자체 위반 판별 엔진이 없는가. `violations.ts` · `rules.ts`가 dependency-cruiser의 위반 출력을 옮기기만 하는가, 아니면 그래프를 직접 걸어 위반을 계산하는가(순환을 "같은 순환은 하나로 모은다"는 후처리가 판별 엔진이 되지 않았는가). 구조 단언(시험)이 이것을 무엇으로 고정하는가.
4. **블록 매핑.** `matchesBlockPattern`만 쓰는가(패턴을 정규식으로 옮기지 않는가). 규칙의 `path`는 이스케이프한 파일 경로 나열인가. `regex.ts`의 이스케이프가 dependency-cruiser가 쓰는 정규식 엔진 · 플래그에서 정확한가(직접 시험: `[id]` · `(group)` · `@slot` · `.` · `+` · `$` · `^` · `|` · `\` · 공백 · 한글 · `{` · `}` · `-`가 든 파일 이름이 정확히 그 파일만 잡는가. 앞뒤 고정(`^…$`)이 되어 `a.ts`가 `xa.ts`나 `a.tsx`를 잡지 않는가).
   - 네 가지 결정: 겹침(`overlap`이면 위반을 판별하지 않는다. M3-03이 이것을 통과로 읽지 않게 결과 모양이 강제하는가: 타입상 `checked`와 구별되는가), include 밖 `public`, 대소문자 · 경로 형태, 선언 `null`. 각각 명세 · ADR-122와 맞고 시험이 있는가.
   - 미분류 파일: "미분류 파일을 거친 간접 접근은 위반이 아니다"(남는 틈). 구현 에이전트가 **어느 블록에도 안 맞는 경로에 파일을 만들어** 선언 외 방향 · 공개 API 외 접근을 돌아갈 수 있다는 뜻이다. 이것이 JDG-05 · 이슈 수용 기준 범위에서 받아들일 수 있는 한계인가(미분류 목록이 결과에 드러나고 M3-03 · 화면이 그것을 결함으로 다룰 수 있는가), ADR-125에 그 한계와 뒤 이슈의 몫이 분명히 적혔는가를 판정한다. 미분류 → 블록, 블록 → 미분류 import가 결과에서 조회 가능한가.
5. **위반 판별의 정확성.** 예제 선언 + 픽스처에서 0건, 두 변형에서 각각 정확히 1건임을 네가 직접 재현한다(`scripts/reset-fixture.sh`로 사본, `scripts/make-variant.sh`, 분석). 직접 만든 작은 프로젝트로 더 본다: 공개 파일을 거친 재수출(`index.ts`가 내부 파일을 다시 내보냄)은 통과인가, 타입 전용 import · 동적 import · `require` · 재수출 · 사이드 이펙트 import가 각각 어떻게 세어지는가(결정이 ADR에 있고 명세와 맞는가), `shared` 종류 블록의 취급, 블록 A → B → A(블록 사이 순환)와 블록 안 파일 순환, `dependsOn`의 전이(A가 B에 기대고 B가 C에 기댈 때 A → C import는 위반인가. 명세 문장으로 판정).
6. **오류와 상한.** `ParserError` 11가지가 "위반 0건"으로 읽히지 않는가(반환 타입상 결과와 섞이지 않는가). 시간 초과(120초) · 출력 상한(256 MiB) · 깨진 JSON · 0이 아닌 종료 · TypeScript 파서 없음 각각 닫힌 쪽인가. 256 MiB를 부모가 통째로 메모리에 받는 것이 오케스트레이터에 부담이 되지 않는가. 결과 목록의 `{items, total}` 상한이 잘림을 드러내는가. "2천 파일 전체가 한 순환이면 120초를 넘어 시간 초과"가 구현 에이전트가 일부러 만들 수 있는 입력이라는 점(검사를 영영 실패시키는 길)이 ADR에 한계로 적혔는가.
7. **의존성과 공급망.** `dependency-cruiser` 18.7.2 고정, lockfile 패키지 52개 증가. `pnpm.packageExtensions`로 `typescript@6.0.3`을 dependency-cruiser의 의존성으로 준 방식이 워크스페이스의 다른 패키지(이미 `typescript6` 별칭을 쓰는 오케스트레이터 포함)의 해석 · 빌드 · 설치 스크립트 정책(`onlyBuiltDependencies`)에 영향을 주지 않는가. 새 패키지 가운데 설치 스크립트가 있는 것이 있는가(`pnpm-lock.yaml`의 `requiresBuild` 류 표시, `onlyBuiltDependencies` 변경 여부). `pnpm install --frozen-lockfile`이 깨끗한 작업 공간에서 통과하는가. 설치 · CI 시간 증가가 보고와 같은가(`checks` 648초).
8. **변형 스크립트.** `scripts/make-variant.sh`: 인자 검증(모르는 이름, 없는 폴더, 픽스처가 아닌 폴더, 더러운 작업 트리, **원본 `fixtures/sample-next-app` 자체**, 저장소 루트, 기호 링크), 셸 안전(`set -euo pipefail`, 따옴표, 경로에 공백), 변형마다 커밋 하나이고 `git revert --no-edit HEAD`로 깨끗이 돌아가는가, 커밋 서명 설정을 어떻게 다루는가(전역 설정을 바꾸지 않는가). `scripts/variant-violations.mjs`가 무엇을 하는가(시험 보조인가, 제품 경로인가). `ci.yml` 변경이 단계 하나뿐이고 그 단계가 파서 빌드 뒤에 있는가. `scripts/test-make-variant.sh`를 직접 한 번 돌린다.
9. **시험 설정.** 파서 `vitest.config.ts`의 `testTimeout: 60_000`이 실패를 가리는 넓은 제한이 되지 않는가(느린 시험이 어느 것이고 왜 느린가. 실행기를 띄우는 시험만 느린 것이 맞는가). 파서 시험 전체 소요 시간. 루트 `pnpm test`에 파서가 포함되는가.
10. **문서.** ADR-125의 결정 · 끈 방법 표 · 남는 틈 · M3-03에 넘기는 사실이 코드와 맞는가(문장마다). `docs/architecture.md` 변경이 사실인가.
11. **변이.** 구현자의 M1 ~ M34 · V1 ~ V8과 겹치지 않게 7종 안팎. 후보: ⓐ 실행기의 허용 옵션 검사를 빼고 `webpackConfig`를 통과시키기, ⓑ 자식 환경 변수에 부모 환경을 그대로 넘기기, ⓒ 자식 `cwd`를 대상 프로젝트로, ⓓ `regex.ts`에서 앞뒤 고정을 빼기, ⓔ `overlap`일 때도 위반을 계산해 `checked`로 내기, ⓕ 시간 초과를 빈 결과(위반 0건)로 돌려주기, ⓖ include 밖 `public` 파일을 공개로 치기, ⓗ `make-variant.sh`가 더러운 작업 트리를 받게. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 파서 시험 전체: `TMPDIR=$(mktemp -d /tmp/tr276.XXXX) pnpm --filter @bive/parser test`. `scripts/test-make-variant.sh` · `scripts/test-reset-fixture.sh` 한 번씩.
- 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험('의존성 설치 시간 초과')만 실패하면 통과로 본다. 파이프라인 e2e · 화면 e2e · 스모크는 돌리지 않는다(CI success).
- 숨은 글자: 바뀐 파일(잠금 파일 제외)을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(파일 명시). `grep -c 'udb40' docs/decisions.md`는 2.
- 실험용 프로젝트 · 심는 파일 · 표시 파일은 모두 네 작업 공간 또는 네 임시 폴더 안에만 둔다. 격리 시험은 **분석이 대상 코드를 실행하지 않음을 확인**하는 것이고, 이 VM의 격리 · 권한 검사를 깨 보는 시도는 하지 않는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 다른 검토자가 같은 VM에서 PR #275(앱 화면)를 보고 있다. 그 작업 공간 · 프로세스 · 포트를 건드리지 않는다. 끝나면 네 프로세스 · 임시 파일 · 임시 폴더를 정리한다(네 PID만).

## 판정 기준
- 차단: 수용 기준 미충족, 대상 프로젝트 코드를 실행할 수 있는 길(끌 수 없거나 꺼지지 않은 것), 자체 해석기 · 판별 엔진, 틀린 위반 수 · 틀린 매핑, 이스케이프 오류, 오류가 "위반 0건"으로 읽히는 길, 설치 스크립트가 새로 도는 패키지, 원본 픽스처를 바꿀 수 있는 스크립트, 실패를 가리는 시험 설정, 변이 생존, 사실과 다른 ADR 문장, M3-03이 이 결과 모양으로 구현될 수 없는 결함.
- 비차단: 취향, 범위 밖 개선. 후속 후보로 따로 적는다(#48에 넘길 것, 새 이슈가 필요한 것 구분).

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(B1…, 파일 · 줄 · 재현 · 고칠 방향), 비차단(N1…), 위 11개 항목별 한 줄 결론, 2번에서 읽은 dependency-cruiser 소스 위치와 결론 표, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. 한국어로, 짧게.
