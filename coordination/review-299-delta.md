너는 chanrhan/bive 저장소의 PR #299(이슈 #292, M3-47 "OpenAPI 계약 검사 실행기")의 **수정 1회차 차이**를 검토하는 독립 검토자다. 구현에도 첫 검토에도 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 받은 값
- PR #299, 브랜치 `feat/292-openapi-contract-runner`. 첫 검토 헤드 `b5c0858ed5bd4c839e39810d00c1c3927083b5a2`, 지금 헤드 `0ba1d0d897e9c6c158134b74198ff2bb644e5ecc`(수정 커밋 `3dfeccd` + main `97c8b50` 병합 커밋). 조율자가 `ci` 성공(검사 5개 모두 success)과 `clean`을 확인했다. 네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/0ba1d0d897e9c6c158134b74198ff2bb644e5ecc/check-runs`로 한 번 더 확인해 보고에 적는다.
- 네 작업 공간에서 `git fetch origin feat/292-openapi-contract-runner` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.
- **볼 차이**: `git diff b5c0858 3dfeccd`(수정 커밋만. 병합 커밋이 들인 main 쪽 변경(계약 화면 · 테스트 작성 입력 방어)은 이미 검토 · 병합된 것이라 대상이 아니다). 병합 커밋 `0ba1d0d`는 충돌 해결이 맞는지만 본다: `git show 0ba1d0d --stat`와 `docs/decisions.md`의 ADR 머리줄 순서(131 · 132 · 133), ADR-133 본문이 main(`97c8b50`)과 글자까지 같은지(`git diff 97c8b50 0ba1d0d -- docs/decisions.md`에서 ADR-132 절 추가 말고 다른 줄이 없는지), `grep -c 'udb40' docs/decisions.md`가 2.
- 제품 차이의 자리: `packages/orchestrator/runner/contract-tool.mjs`(새 파일) · `src/contract-check/{openapi-document,prism,tool}.ts` · `src/steps/contract-check.ts` · `package.json`(`files`에 `runner`) · `test/contract-runner.test.ts`(+611) · `docs/decisions.md`의 ADR-132.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `review-299.md`(첫 검토가 받은 지시서. 특히 "꼭 판정할 것" 2 · 3 · 4 · 5), `brief-292.md`, `pr299-body-r1.md`(지금 PR 본문 사본, 결과 표 · 변이 표).
3. `docs/decisions.md`의 ADR-132 전부(수정된 결과 표 · ③ 바깥 자료를 푸는 칸 · 한계) · ADR-033 · ADR-129 · ADR-130.

## 첫 검토의 차단 지적 (이번에 닫혔는지 판정한다)
- **B1**: 구현 코드(판정받는 쪽)가 응답 모양(501 · 304 · 302 · 깨진 JSON · 가짜 `content-encoding` · 기록 상한 4 MiB를 넘는 본문)으로 계약 위반을 "판정 없음(막지 않음)"으로 바꿔 병합까지 갈 수 있었다. 요구: 구현이 통제할 수 있는 사유는 모두 닫힌 쪽(`fail` = 구현 회귀, 또는 실행 종료). 판정 없음은 구현이 통제할 수 없는 사유(실행기 없는 종류, 등록 문서 자체의 문제, 계약 안 요청 0건)만.
- **B2**: `redocly`가 `discriminator.mapping`의 URL 값을 받아 온다(사전 검사가 `$ref` 계열만 막았다). 요구: 문서 안 참조가 아닌 `mapping` 값을 막고, 두 도구가 바깥 자료를 푸는 칸을 전부 찾아 ADR-132 ③에 적고, 칸마다 대조군 시험.
- **B3**: 살아남은 변이 여섯: ⓑ 검증하지 못한 요청의 처리 빼기, ⓘ `missingContractVerdicts`가 늘 빈 배열, ⓙ 병합 재검사에서 계약 계획 빼기, ⓖ 기록 프록시가 응답 헤더(`location` · `set-cookie` · `cache-control` · `x-*`)를 떨어뜨림, ⓗ 계약 규칙을 `testedRules`에 다시 넣기, ⓛ 등록 해시 대조 빼기.
- **B4**: 부모 프로세스가 죽으면 prism이 고아로 남아 CPU를 쓴다(실제로 2시간 돈 것을 조율자가 발견). 요구: 부모가 사라지면 도구가 끝나게 하고 시험 · ADR.
- 비차단: N1(ADR의 "같은 읽기, 옮기고" 문장이 사실과 다름), N2(ADR 한계의 우회 절차 문장), N5(패키징된 Electron 앱의 도구 경로 한계).

## 구현자가 보고한 수정 (믿지 말고 확인한다)
- B1: `steps/contract-check.ts`의 `trafficVerdict`와 `contract-check/prism.ts`. 검증하지 못한 요청은 `fail`(사유 `response_unverified`). 기록이 불완전한 교환도 요청은 prism에 보내 계약 밖인지 먼저 가린다. 요청 쪽 사유(보안 요구 · 본문 있는 GET)도 `fail`. 계약에 적힌 204 · 304는 통과, 계약에 적힌 302는 prism 상류 호출이 리다이렉트를 따라가 검증하지 못해 `fail`(ADR 한계). 판정 없음으로 남긴 사유: 실행기 없는 종류, 바깥 참조, 경로 없는 문서, 등록 원본을 읽지 못함, 계약 안 요청 0건.
- B2: `openapi-document.ts`가 `mapping` · `defaultMapping` 값 가운데 문서 안 참조(`#`)도 스키마 이름도 아닌 값을 바깥 참조로 막는다. redocly에서 `resolveDocument`를 부르는 자리 넷, prism은 json-schema-ref-parser가 `$ref`만 푼다고 ADR에 적음.
- B3: 여섯 변이마다 시험을 더함.
- B4: 도구를 진입 스크립트 `runner/contract-tool.mjs`로 띄움. 표준 입력이 부모가 쥔 파이프라 부모가 사라지면 닫히고 도구도 끝남.

## 꼭 판정할 것
1. **B1이 정말 닫혔는가 (가장 중요).** `trafficVerdict`와 prism 재생 코드를 끝까지 읽고, "판정 없음(막지 않음)"이나 `pass`로 가는 갈래를 전부 적는다. 그 가운데 **구현 코드가 고를 수 있는 것**이 남았는지 본다. 후보:
   - "계약 안 요청 0건": 구현이 이것을 만들 수 있는가. 요청이 "계약 밖"으로 분류되는 조건(prism의 계약 밖 오류)을 구현의 응답이 바꿀 수 있는가. 요청 분류가 요청 바이트(인수 테스트가 보냄)에만 기대는가, 응답에도 기대는가. 구현이 리다이렉트로 테스트 클라이언트를 계약 밖 경로로 보내 "계약 안 요청"을 줄이는 길은(첫 요청은 계약 안이므로 남는가)? 구현이 기록 프록시를 거치지 않게 만드는 길(다른 포트로 서버를 띄우기 등)은 첫 검토가 #117 계열 한계로 봤다: ADR 한계에 한 줄이 있는지만 확인한다.
   - "계약 밖인지 먼저 가린다": 기록이 불완전한 교환을 prism에 보낼 때 무엇을 응답으로 재생하는가. 구현이 그 경로로 "계약 밖"이라는 결론을 유도할 수 있는가.
   - 상태 코드 · 헤더 · 본문 조합을 더 넣어 본다: 100-continue, 1xx, HEAD에 본문, `transfer-encoding` 이상 값, `content-length` 불일치, 아주 많은 헤더, 응답 도중 끊기, 응답 지연으로 시간 상한 넘기(시간 초과는 어느 쪽인가: 구현이 통제할 수 있으므로 닫힌 쪽이어야 한다), `content-type` 없음 · 이상한 문자셋, 기록 건수 상한 넘기(요청 수는 테스트가 정하지만 구현이 리다이렉트 고리로 늘릴 수 있는가), 계약에 `default` 응답만 있을 때.
   - 구현자의 시험이 일곱 사례를 **검사 단계 끝까지** 보내 `fail` 기록 · `regression_limit` · 병합 0건을 단언하는지 읽고, "처리 빼기" 변이를 네가 한 번 재현한다.
   - 닫힌 쪽으로 옮긴 결과 **정상 구현이 억울하게 막히는 경우**가 생겼는지: 계약에 적힌 302가 `fail`이 되는 한계는 구현이 고칠 수 없는 실패다(회귀 상한까지 돈 뒤 실패). 이것이 ADR에 사실대로 적혔는지, 픽스처 · 파이프라인 e2e의 정상 흐름에 영향이 없는지(기준값 변화 없음 주장) 판단한다. 요청 쪽 사유(보안 요구 · 본문 있는 GET)를 `fail`(구현 회귀)로 둔 것이 타당한지도 판정한다: 요청은 인수 테스트(다른 역할)가 만든다. 구현이 고칠 수 없는 사유를 구현 회귀로 돌리면 헛도는 회귀가 생기지만 병합은 막힌다(보수적). 차단까지는 아니라고 보면 비차단으로, 역할 책임이 뒤바뀐다고 보면 근거와 함께 적는다.
2. **B2.** `openapi-document.ts`의 `mapping` · `defaultMapping` 판정을 읽고 빠져나가는 값을 찾는다: 스키마 이름으로 보이게 꾸민 값(점 · 슬래시 · 퍼센트 인코딩 · `./` · 파일 이름처럼 생긴 것 · 스킴 없는 `//host/path` · 대문자 스킴 · 공백 앞뒤 · 빈 글자열 · 글자열이 아닌 값), `mapping`이 객체가 아닐 때, YAML 별칭으로 넣은 값. "스키마 이름"의 허용 패턴이 redocly가 그 값을 파일 · URL 참조로 다루는 조건과 맞물리는지(redocly 소스의 판정 함수를 `node_modules`에서 찾아 읽는다). ADR ③의 "`resolveDocument`를 부르는 자리 넷"과 "prism은 `$ref`만"이 사실인지 도구 소스로 확인한다(설치된 판의 파일 경로를 보고에 적는다). 대조군 시험이 방어를 뺀 쪽에서 127.0.0.1 서버에 실제 요청이 오는 것으로 가르는지.
3. **B3.** 여섯 변이를 네 작업 공간에서 하나씩 다시 넣고(Edit) 관련 시험 파일만 돌려 빨강인지 표로 낸다. 구현자의 변이 기록(`a292-mut-*.log`)을 믿지 않는다.
4. **B4.** `runner/contract-tool.mjs`(23줄)와 `tool.ts`를 읽는다. (a) 진입 스크립트가 도구를 어떻게 띄우는가(같은 프로세스에서 `import`인가, 또 자식을 띄우는가. 자식이면 손자가 남지 않는가). (b) 표준 입력이 닫히면 끝나는 방식이 도구가 표준 입력을 읽는 경우와 부딪치지 않는가. (c) 인수 · 환경 변수 전달이 첫 검토가 확인한 격리(부모 환경을 넘기지 않음, cwd가 프로젝트 밖 빈 폴더, `--config`)를 그대로 지키는가: 진입 스크립트 경로가 대상 프로젝트가 아니라 오케스트레이터 패키지에서 풀리는가. (d) 패키지 `files`에 `runner`가 들어가 빌드 · 패키징 뒤에도 경로가 맞는가(`dist`에서 `runner/`를 가리키는 상대 경로 계산을 본다. `pnpm build` 뒤 실제로 그 경로에 파일이 있는가). (e) 부모를 SIGKILL하는 시험을 네가 한 번 돌리고, 돌린 뒤 `ps -eo pid,ppid,etimes,args`에서 네 작업 공간 · 네 `TMPDIR` 경로의 prism · redocly · contract-tool 프로세스가 남지 않았는지 본다. 남았으면 PID · cmdline · cwd를 확인한 뒤 **네가 띄운 그 PID만** 끝내고 보고한다(이름 · 패턴으로 한꺼번에 끝내지 않는다). 진입 스크립트를 빼는 변이도 한 번 재현한다.
5. **새로 생긴 문제.** 수정 커밋이 첫 검토가 통과시킨 것을 깨지 않았는가: 도구 격리(환경 변수 · cwd · 설정), 기록 프록시의 바이트 보존, 실행기 없는 종류의 판정 없음, 병합 재검사, 판정 기록의 사유 글이 화면 · 다른 역할로 흐를 때의 표시 값 변환과 길이 상한(새 사유 `response_unverified`의 글에 구현 응답의 값이 실리는가, 실리면 상한 · 변환을 거치는가), shared 열거형 · 앱 표시명 표에 새 값이 필요한데 빠지지 않았는가(화면에 날값이 보이는 길).
6. **ADR-132 문장.** 결과 표 · 판정 없음 목록 · ③ · 한계가 코드와 맞는가. 한계에 악용 절차(어떻게 하면 피할 수 있다는 식의 순서)가 남아 있지 않은가. N1 · N2 · N5가 고쳐졌는가.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험: orchestrator `contract-runner` · `check-regression` · `judge-runner` · `integrity`(파일 단위로, `TMPDIR=$(mktemp -d /tmp/tr299d.XXXX)`). 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험("hoist 설정(…) node-gyp bin …" · "닫힘 밖 file: 패키지의 python3 bin …")만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. `pnpm e2e:pipeline` · 화면 e2e · 스모크는 돌리지 않는다(CI가 기준).
- 숨은 글자: 수정 커밋이 바꾼 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(파일 명시).
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션을 바꿔 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다. 판정 격리를 돌아가는 대처를 하지 않는다. 실제 API 키를 쓰지 않는다.
- **시간**: 2시간 안에 끝낸다(한국 시간 08:20까지 보고). 시간이 모자라면 1(B1) · 4(B4) · 3(B3) · 2(B2) 순서로 하고, 못 한 것은 "못 함"으로 적는다. 끝낼 때 네가 띄운 프로세스가 남지 않았는지 확인한다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- B1~B4별 닫힘 여부와 근거(파일:줄, 돌린 시험, 재현한 변이).
- "판정 없음 · 통과로 가는 갈래" 표(갈래, 구현이 고를 수 있는가, 근거).
- 변이 결과 표(변이, 빨강이 된 시험).
- 새 차단 지적(있으면 재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, 못 한 것.
- 이것은 수정 1회차다(최대 2회). 남은 지적이 한 번의 수정으로 닫힐 크기인지도 한 줄로 적는다.
