너는 chanrhan/bive 저장소 PR #276(이슈 #47, M3-02 파서: import 그래프 · 블록 판정)의 **차이 재검토자**다. 1회차 검토(REQUEST_CHANGES)의 지적이 반영됐는지와, 그 수정이 새 문제를 만들지 않았는지만 본다. 구현에 관여하지 않았다. 한국어로 일한다(보고도 한국어). 범위는 **수정 커밋이 바꾼 파서 · 스크립트 · 문서 파일**이다.

## 받은 값
- 1회차에 본 헤드 `413e858`. 그 뒤 커밋: `0a16748`(main `1bffbaa` 병합. 앱 화면 변경은 이 PR의 것이 아니다) → `dcb5eb0`(B1) → `a483a13`(B2 · N1 · N6 · N8) → `997ef61`(ADR · 출력 상한). 새 헤드 `997ef61bead7ee5c71b7fa6168883184814c9e96`(이 헤드에서 CI `ci` success, 조율자 확인). 볼 차이: `git diff 0a16748 997ef61`(파서 `runner/cruise.mjs` · `src/analyze.ts` · `cruise.ts` · `graph.ts` · `index.ts` · `limits.ts` · 그 밖에 바뀐 소스, 파서 시험 3개, `vitest.config.ts`, `scripts/make-variant.sh` · `test-make-variant.sh`, `docs/decisions.md`의 ADR-125). 병합 커밋은 `docs/decisions.md`의 ADR 순서(124 → 125)만 확인한다.
- 네 작업 공간에서 `git fetch origin feat/47-parser-graph && git checkout --detach FETCH_HEAD`, `git rev-parse HEAD`가 새 헤드인지 확인. 변이는 네 작업 공간 안에서만(Edit 도구로), `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · GitHub 쓰기를 하지 않는다.
- 읽을 것: scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `review-276.md`(1회차 지시서), `brief-47.md`의 "반드시 지킬 것 (무결성)", `brief-common.md`. PR 본문의 변이 표(`scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/276`). ADR-125 전체. 뒤 이슈 #48 본문.

## 1회차 지적과 구현자가 한 일 (확인 대상)
1. **B1 분석하지 않은 파일로 가는 import.** 건너뛰는 자리(`node_modules` · `.next` · `bive-acceptance` · 기호 링크 · 프로젝트 밖)를 `exclude` 대신 `doNotFollow`로 넘긴다. 결과에 `graph.unanalyzed`(`{from, to}`, 상한 · `total`)와 `graph.packages`(`{name, inManifest}`)가 생겼고, 블록 파일에서 나간 `unanalyzed`가 하나라도 있으면 `outcome.status = 'incomplete'`(위반 목록과 그 import 목록을 함께 실음)다. 목록에서 빼는 것은 JSON · CSS류 · 그림 · 글꼴뿐.
   - **`doNotFollow`가 대상 코드를 더 읽거나 실행하게 만들지 않는가(가장 중요).** dependency-cruiser 18.7.2 소스에서 `doNotFollow`된 모듈이 어떻게 다뤄지는지 직접 읽는다: 그 파일을 열어 파싱하는가(파싱은 실행이 아니지만 변환기를 부르는가), `node_modules` 안 패키지의 `package.json`을 데이터로만 읽는가, `exclude`였을 때는 닿지 않던 코드 경로(패키지 매니페스트 읽기, 라이선스 · `dependencyTypes` 판정, `exports` 해석)에 프로젝트 코드를 `require` · `import`하는 곳이 없는가. 1회차 격리 시험이 그대로 통과하는 것만으로 믿지 말고, `doNotFollow` 대상 자리에 실행되면 표시 파일을 남기는 것들(패키지 `main` · `exports`가 가리키는 JS, 패키지 `package.json`의 스크립트, `.next` 안 JS)을 네가 직접 심어 본다(대조군 포함. 모두 네 작업 공간 · 임시 폴더 안).
   - 1회차의 세 재현(`.es6` 중계, 프로젝트 `node_modules`의 `relay-pkg`, `.next/relay.js`)을 직접 다시 해 본다: 각각 결과에 드러나는가, 상태가 `incomplete`인가(`relay-pkg`는 패키지 이름 import라 `packages`로만 가고 `incomplete`가 아닌 것이 구현자의 설계다. 이 구분이 받아들일 만한가: `inManifest: false`가 M3-03에 충분한 신호인가, `package.json`에 이름을 적어 두면 `inManifest: true`가 되어 구별이 안 되는 한계가 ADR에 정확히 적혔는가).
   - `incomplete`가 타입상 `checked` · `overlap`과 구별되어 M3-03이 통과로 읽을 수 없는가. `overlap`과 `incomplete`가 동시에 해당할 때는 무엇이 나오는가. **미분류 파일에서 나간** `unanalyzed`는 `incomplete`를 만들지 않는다는 결정: 블록 파일 → 미분류 파일 → 분석 안 된 파일 → 다른 블록 내부의 길은 결과에서 어떻게 보이는가(미분류 목록 + 간선 + `graph.unanalyzed`에는 남는가). 남으면 한계로 적힌 것이 맞는지 본다.
   - 빼는 데이터 형식 목록: "그 안에서 JS를 가져올 수 없다"가 형식마다 사실인가(SVG는 그림으로 치는가: 번들러에 따라 컴포넌트로 읽히는 경우, CSS의 `@import` · `url()`은 JS가 아니다, `.json`은 데이터). 목록이 `files.ts` · `graph.ts` 어디에 있고 대소문자 · 겹 확장자(`a.json.js`)를 어떻게 다루는가.
   - **정상 프로젝트에서 늘 `incomplete`가 되지 않는가.** 픽스처(설치한 사본 포함)에서 `unanalyzed`가 비는 것을 직접 확인한다. 흔한 Next.js 프로젝트에서 블록 파일이 가져오는 것 가운데 `unanalyzed`로 떨어질 만한 것(`.mdx`, `.graphql`, `.svg`, `.wasm`, `next/font`, 생성 코드 `src/generated/*.js`, `.d.ts`)을 몇 개 시험해 보고, 과하게 막히는 형식이 있으면 비차단으로 적는다(M3-03에서 정할 몫).
   - `graph.packages`의 상한 · 정렬 · 중복 제거, `inManifest` 판정(어느 `package.json`을 보는가, `devDependencies` · `peerDependencies` · 워크스페이스, Node 내장 모듈 `node:fs`는 어떻게 되는가).
2. **B2.** 공유 블록 시험. 1회차 변이 X7(`shared` 블록은 `dependsOn` 없이 허용)을 직접 재현해 빨강을 확인한다.
3. **N1 Electron 위 자식 환경.** `childEnv()`: `process.versions.electron`이 있을 때만 `ELECTRON_RUN_AS_NODE=1` 하나. 실제 배포 구성(`packages/app/src/main/orchestrator-launch.ts`)에서 오케스트레이터 프로세스의 `process.versions.electron`이 정말 정의되는가(`ELECTRON_RUN_AS_NODE=1`로 뜬 Electron 바이너리에서 그 값이 있는지 Electron 문서 · 저장소의 기존 코드로 판단. 확인 못 하면 "못 함"). 그 변수 말고 넘어가는 것이 없는가. 시험이 두 경우와 `NODE_OPTIONS` · `NODE_PATH` 차단을 고정하는가.
4. **N6 격리 시험 보강.** 더한 종류마다 대조군이 있는가. 구조 시험이 `runner/cruise.mjs`를 훑는가.
5. **문서 · 상한.** ADR-125의 ④ · ⑤ · ⑨ · 남는 틈 · "M3-03에 넘길 사실"이 지금 코드와 맞는가(문장마다). 악용 절차가 적혀 있지 않은가. 출력 상한 256 → 64 MiB의 근거(합성 2천 파일 1.1 MB)가 타당한가, 상한을 넘으면 닫힌 쪽인가.
6. **N8.** `testTimeout` 20초가 CI에서 거짓 빨강을 낼 만큼 빠듯하지 않은가(CI의 파서 시험 소요를 check-run 로그에서 볼 수 있으면 본다. 못 보면 로컬 최대값의 배수로 판단). `make-variant.sh` 따옴표, 기호 링크 거부 시험.
7. **새 문제.** 1회차에 통과한 것(변환만 함, 매핑 · 이스케이프, 위반 수 0 · 1 · 1, 오류가 "위반 0건"으로 읽히지 않음, 변형 스크립트)을 깨지 않았는가. `scripts/reset-fixture.sh` + `make-variant.sh` + 분석으로 0 · 1 · 1을 직접 재현한다. 비용이 보고와 같은 범위인가(픽스처 약 1초).
8. **변이.** 위 재현(X7)에 더해 다섯: (가) `doNotFollow`를 `exclude`로 되돌림, (나) `incomplete`일 때 `checked`로 냄, (다) 데이터 형식 목록에 `.js`를 더함(분석 안 된 JS를 데이터로 침), (라) `childEnv`가 Electron이 아닐 때도 변수를 넘김, (마) `unanalyzed`의 상한을 넘을 때 `total`을 잘린 길이로 냄. 변이마다 빨강이 된 시험을 표로(구현자 M35 ~ M44와 겹치면 번호를 적고 직접 재현한 것만 "재현"이라 쓴다).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 파서 시험 전체: `TMPDIR=$(mktemp -d /tmp/tr276d.XXXX) pnpm --filter @bive/parser test`. `scripts/test-make-variant.sh` 한 번. 전체 `pnpm test` · 파이프라인 e2e · 화면 e2e · 스모크는 돌리지 않는다(CI success).
- 숨은 글자: 바뀐 파서 · 스크립트 · 문서 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`(파일 명시). `grep -c 'udb40' docs/decisions.md`는 2.
- 실험용 프로젝트 · 심는 파일 · 표시 파일은 모두 네 작업 공간 또는 네 임시 폴더 안에만 둔다. 이 VM의 격리 · 권한 검사를 깨 보는 시도는 하지 않는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 다른 구현자가 같은 VM에서 이슈 #64(앱 화면)를 작업 중이다. 그 작업 공간 · 프로세스 · 포트를 건드리지 않는다. 끝나면 네 프로세스 · 임시 파일 · 임시 폴더를 정리한다(네 PID만). 50분 안에 끝내는 것을 목표로 한다.

## 판정과 보고
- 차단: 1회차 차단이 고쳐지지 않음, `doNotFollow`로 새로 열린 실행 · 읽기 경로, `incomplete`가 통과로 읽히는 길, 정상 픽스처가 `incomplete`가 됨, 틀린 위반 수, 느슨해진 시험, 변이 생존, 사실과 다른 ADR 문장, M3-03이 이 결과 모양으로 구현될 수 없는 결함. 그 밖은 비차단(#48에 넘길 것과 새 이슈가 필요한 것을 구분).
- 보고: `APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(파일 · 줄 · 재현 · 고칠 방향), 비차단, 위 8개 항목별 한 줄 결론, `doNotFollow` 관련해 읽은 dependency-cruiser 소스 위치와 결론, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. **한국어로**, 짧게.
