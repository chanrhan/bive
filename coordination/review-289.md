너는 chanrhan/bive 저장소의 PR #289(이슈 #49, 로드맵 M3-04의 앞부분 "계약 등록 · contract 검사 규칙 · 규범 입력 · CLI")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 받은 값
- PR #289, 브랜치 `feat/49-contract-register`, 헤드 `55e478f41fbba8b686369177154733163adb5212`(main `1b64df8` 병합 포함), 기준 main `1b64df8`. 바뀐 파일 26개(+3272 / -55): 새 `orchestrator/src/norms/contract.ts`(368줄) · `ipc/contract-handlers.ts`(151줄), 고친 `confirmations/confirmation-service.ts` · `norms/effective.ts` · `norms/norm-input.ts`, shared `domain.ts` · `protocol.ts`, store 마이그레이션 `project/0024_contracts`(184줄: 새 표와 `confirmations` 표 재구성) · `contract-repository.ts` · `confirmation-repository.ts`, app `cli-core.ts`, 시험(`contract.test.ts` 825줄 등), `integrity.test.ts`(+81), ADR-129, `docs/architecture.md`. 이 헤드에서 CI `ci` · `checks` · `pipeline-e2e` 두 묶음은 모두 success다(조율자가 check-runs로 확인).
- **범위에 대한 조율자 결정**: 이슈 #49의 수용 기준 4개 가운데 이 PR은 1번(등록)과 4번(CLI · 규범 입력)만 한다. 2번 · 3번(계약 검사 실행기, 픽스처 `openapi.yaml`, `contract-mismatch` 변형)은 새 이슈로 옮긴다(로드맵 문서 PR #290 계열이 따로 간다). 2 · 3번이 없다는 것은 지적 사항이 아니다.
- 네 작업 공간에서 `git fetch origin feat/49-contract-register && git checkout --detach FETCH_HEAD`로 본다. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-49a.md`와 그것이 가리키는 `brief-49.md`의 "(가) 등록과 규범 입력" · "반드시 지킬 것", `brief-common.md`, `m3-handoff.md`의 "M3-01" · "M3-03" · "M3-36" 절, `pr289-body.md`(PR 본문 사본: 변이 표 41종, 구조 시험 허용 목록을 고친 이유).
3. 이슈 본문 수용 기준과 코멘트(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/49`, `…/issues/49/comments`), 뒤 이슈 #50 · #51 · #55 본문.
4. 명세: `docs/spec/prd.md`의 NRM-03 · NRM-02와 계약 절, `docs/spec/plan.md`의 계약 용어. `docs/decisions.md`의 ADR-129(이 PR이 더함) · ADR-019 · ADR-100(사람 결정: C2 계약 등록의 기록, K1 · A14 규범 입력, D2 · I1 확인, B⑨) · ADR-110 · ADR-112 · ADR-120 · ADR-122 · ADR-127.

## 꼭 판정할 것
1. **범위.** `git diff 1b64df8...HEAD --stat`. 화면(`packages/app/src/renderer`) · 시나리오 · 파이프라인 e2e 파일 · 픽스처 · 판정 러너(`judge/`) · `docs/spec/*` · `CLAUDE.md`가 바뀌지 않았는가. 새 의존성 · 잠금 파일 변경이 없는가. 마이그레이션이 0024 하나인가.
2. **수용 기준 1(등록)의 기록 규칙.** `contract.register`가 한 트랜잭션에서 남기는 것을 직접 따라간다. ADR-100 C2: 사람의 CLI 계약 등록은 승인 기록에 남고, 그에 따라 오케스트레이터가 만드는 `contract` 검사 규칙의 생성은 규범 변경 기록에 남는다. 에이전트 반영은 규범 변경 기록에만.
   - 구현: 승인 기록의 행동 값은 새 값이 아니라 기존 `contract_edit` + `diff.before = null`로 등록을 구별한다. 이 선택이 승인 기록을 읽는 기존 코드 · 화면 · 체인 검증에서 "편집"으로 잘못 읽히지 않는가. `ApprovalLogEntry`에 더한 검사("대상은 계약 · diff는 `ContractEditDiff`")가 **읽기 스키마를 조였다**면 옛 DB의 승인 기록이 `malformed`가 되지 않는가(이 값을 쓴 제품 코드가 이번이 처음이라는 주장을 `git log -S contract_edit`와 grep으로 확인한다).
   - 사람 등록 시 계약 대상 규범 변경 기록은 없고 규칙의 `created`만 남는다는 것이 C2 문장과 맞는가. 계약 자체의 생성이 승인 기록에만 있어도 화면 · 이력(M3-12)이 그것을 읽을 수 있는가.
   - **에이전트 반영 함수 `reflectAgentContract`**: 제품 코드에서 부르는 곳이 없고 구조 시험이 그것을 고정한다. 수용 기준 1의 "에이전트 반영이면 미확인 … 규범 변경 기록에만 남음을 단언"을 내부 함수 시험으로 만족시킨 것이 이슈 문장에 비춰 받아들일 만한가. 죽은 코드를 제품에 둔 것의 위험(나중에 누가 검사 없이 배선)이 구조 시험으로 충분히 막히는가(새 호출 자리를 더하면 빨강이 되는지 직접 해 본다).
3. **사람 전용 쓰기.** `contract.register` RPC가 사람 주체만 받는가(에이전트 -32020). `blocks.set` · `confirmation.set`과 같은 장치인가. 에이전트 역할의 고정 도구 목록이 바뀌지 않았는가. `proposal-guard.test.ts`의 변경(쓰기 RPC 목록에 `contract.register` 추가)이 무엇을 고정하는 시험이고 느슨해지지 않았는가.
4. **파일과 해시.** 해시의 대상은 기준 브랜치 커밋의 git 객체 바이트다.
   - 경로 검사(상대 경로, `..` · `.git` 구간 없음, 영숫자와 `._-@+`만)를 직접 시험한다: 절대 경로, `a/../b`, `./a`, 끝의 `/`, 빈 구간, 공백 · 한글 · 줄 나눔 · 숨은 글자, 아주 긴 경로, `-`로 시작하는 경로(git 인자로 넘어갈 때 옵션으로 읽히지 않는가: `--` 구분과 인자 배열), 대소문자만 다른 두 경로.
   - git 읽기: 기호 링크 · 디렉터리 · 하위 모듈 · 4 MiB 초과 · UTF-8 아님을 거부하는가. `--no-replace-objects`를 쓰는가(M3-37에서 정한 방식). 기준 브랜치 이름은 어디서 오고 옵션으로 읽힐 수 없는가. "등록의 git 읽기는 저장소 트랜잭션 밖에서 한다"(구현자가 남긴 사실): 그 사이 기준 브랜치가 바뀌어도 기록된 커밋과 해시가 서로 맞는가.
   - 구현자가 지운 "시험이 잡을 수 없는 중복 방어 세 곳"(커밋 형식 정규식, 바이트 길이 대조, 저장소의 고유 위반 처리): 각각 무엇이 대신 막고 있는지 확인한다. 지워서 열린 길이 있으면 차단이다(특히 같은 파일을 동시에 두 번 등록할 때 DB 고유 제약 위반이 어떻게 드러나는가).
   - 등록 뒤 파일이 바뀐 것(`source`가 `changed` · `missing`)이 `contract.list`에서 맞게 나오는가. 구현 역할이 계약 파일을 쓸 수 있다는 사실이 ADR에 적혔는가.
5. **`contract` 검사 규칙을 "내장 규칙(`builtin`)"으로 둔 결정(가장 중요).** 부모 요구사항이 없는 `builtin` 행에 `contractId`를 매었다. M3-03(PR #278)이 `builtin`을 "내장 구조 규칙"의 뜻으로 여러 곳에서 쓴다. **계약을 등록한 프로젝트에서 기존 흐름이 깨지지 않는가**를 코드로 따라가고 가능하면 시험으로 확인한다:
   - `steps/structure-check.ts`의 `readStructurePlan`: 블록 선언이 **없고** 계약만 등록된 프로젝트에서 `none`인가(내장 행이 있다는 이유로 `state_inconsistent`가 되지 않는가). 선언이 있고 계약도 있는 프로젝트에서 구조 규칙 식별(고정 제목)이 계약 규칙과 섞이지 않는가. `missingStructureJudgments`.
   - `steps/check.ts` · `merge.ts`: 계약 검사 규칙이 인수 테스트 판정 대상(`testedRules`)에 든다고 구현자가 적었다("폴더가 없어 판정하지 않는다"). 폴더가 없는 규칙이 검사 단계에서 어떻게 다뤄지는가: 판정 기록이 안 남는가, "판정 없음"이 통과를 막는가, 계약을 등록하면 **모든 실행이 검사 단계에서 막히거나 반대로 계약 규칙이 통과로 세어지는가**. 직접 따라가 결과를 적는다. 엔진 수준 시험(계약이 등록된 프로젝트에서 일반 규칙 실행이 병합까지 간다)이 PR에 있는가. 없으면 네가 기존 시험 도우미로 임시 시험을 써서 확인한다.
   - `steps/existing-rule.ts`(내장 규칙 실패는 판단 세션 없음), `runs/run-service.ts`의 `assertNoBuiltinTarget`(계약 규칙도 [실행] 거부), `rule.update` 거부, 폐기 · 대체 · 이의 거부의 오류 글이 "내장 구조 규칙"으로 나오는 것(구현자가 남긴 사실): 값은 같고 글만 틀리다. 화면에 그 글이 보이는가.
   - 준수 지표(`verification/summary.ts`)와 추적성 결함: 계약 검사 규칙이 판정 가능 항목에 들어 "판정 없음"으로 세어지는가. 실행기가 아직 없으므로 **영영 판정되지 않는 규칙이 분모에 들어 준수율을 낮추는가**: 의도인지, ADR에 적혔는지 판정한다.
   - 규칙 목록 · 확인할 것 · 블록/위험도 칩(M3-19)에 계약 검사 규칙이 미확인 내장 규칙으로 뜬다. 화면이 깨지지 않는가(화면은 고치지 않았다: 앱 단위 · 화면 시험이 통과하는 것과, `contractId`가 있는 규칙을 앱이 그릴 때의 모양을 코드로 확인).
   - DB 트리거 `rules_contract_rule`("계약마다 하나 · 내장 · 부모 없음 · 검사 종류 `contract`")이 INSERT · UPDATE 두 길에서 듣는가. 구조 규칙 생성(`norms/builtin-rules.ts`)을 막지 않는가.
6. **확인 상태와 0024.** `confirmations` 표를 다시 만들어 엔터티 `Contract`와 근거 `contract_record`를 더했다.
   - 복원한 객체: 0012의 트리거 4개(`target_exists`만 글자가 바뀜), 0019의 `confirmations_release_recorded`, 그리고 `norm_changes_unconfirmed`(지웠다가 같은 글자로 다시 만듦). `migrate.test.ts`가 0023까지의 객체와 글자까지 비교하는가. **`norm_changes` 표의 트리거를 지웠다 다시 만드는 사이에 이행이 실패하면** 어떻게 되는가(이행 전체가 한 트랜잭션인가). 0021이 `confirmations`나 관련 표에 더한 트리거가 빠지지 않았는가(0012 ~ 0023 전체에서 `confirmations`를 가리키는 트리거 · 색인 · 외래 키를 네가 직접 센다).
   - 옛 DB(0023, 확인 행 · 확인 풀림 기록이 있는 데이터)에서 0024만 올리는 시험, 두 해시 체인, 쓰기 장부 대조.
   - 사람 등록 계약 = 확인됨(근거 `contract_record`). 근거 종류 `contract_record`는 계약에만 쓸 수 있게 DB가 막는가. `confirmation.set`을 계약에 부르면 -32602. `confirmation.list`가 계약 때문에 달라지지 않는가(계약 검사 **규칙**은 미확인 규칙으로 뜬다).
   - 새 표 `contracts`의 제약(추가 전용? 수정 금지 트리거, 사람 주체, 파일 고유)과 깨진 행을 읽을 때의 동작(ADR-120: 닫힌 쪽, 조용히 삼키지 않음).
7. **수용 기준 4(CLI · 규범 입력).**
   - CLI `contract register <dir> <file> <kind> [요구사항 ID]`: 인자 처리 · 종료 코드. `blocks set`과 함께 쓰게 뽑은 도우미가 기존 동작을 바꾸지 않았는가(`cli-blocks.test.ts` 통과).
   - 규범 입력의 계약 절: 모든 역할(규칙 작성 · 테스트 작성 · 구현, 판단 세션 포함) 세션에 실리는가. 목록만(표시 ID, 종류, 원본 파일의 표시 값), 상한 50건, 계약이 없으면 절이 없고 기존 프롬프트 스냅샷이 글자까지 같은가. 파일 경로가 표시 값 도우미를 거치는가. `SessionNormInput`에 더한 선택 칸이 옛 세션 행을 깨지 않는가(넓히기만).
   - 구현자가 남긴 사실 "계약 절이 상한을 넘을 때 머리줄 글에 '대상과 같은 부모 먼저'라는, 계약에는 맞지 않는 말이 섞인다": 세션에 틀린 안내가 가는 것이다. 차단으로 볼지 판정한다(계약 50건을 넘는 프로젝트에서만 보인다).
8. **구조 시험 허용 목록.** `integrity.test.ts`의 `-` 줄을 하나씩 본다. 더한 것(`norms/contract.ts`를 규칙 생성 · 규범 변경 기록 쓰기 허용 목록에, `ipc/contract-handlers.ts`를 확인 서비스 가져오기 허용에, `norms/contract.ts`를 `effective.js` 가져오기 허용에, 고정 사유 상수)이 필요한 최소이고 이유가 타당한가. 엔진 · 단계 코드에 확인 상태가 들어오지 않았는가(`ipc/contract-handlers.ts`가 확인 서비스를 가져오는 것이 `/confirm/i` 금지 대상 경로 밖인가).
9. **문서.** ADR-129의 문장마다 코드와 맞는가. 정한 것 · 한계 · 넘길 사실(실행기 이슈, M3-05, M3-06, M3-10). 구현자가 "발견했지만 고치지 않은 것" 다섯 가지가 ADR 한계에 적혔는가. `docs/architecture.md` 변경이 사실인가.
10. **변이.** 구현자의 41종과 겹치지 않게 8종 안팎. 후보: ⓐ 사람 등록의 승인 기록 쓰기를 트랜잭션 밖으로, ⓑ 에이전트 주체 거부를 빼기, ⓒ 해시를 작업 트리 파일에서 계산, ⓓ `--no-replace-objects` 빼기(있다면), ⓔ 경로 검사에서 `-` 시작 허용 뒤 git 인자 구분 빼기, ⓕ 계약 검사 규칙을 `builtin: false`로 만들기(DB 트리거가 막는지), ⓖ 계약 절을 계약이 없을 때도 빈 머리줄로 싣기, ⓗ 0024에서 `norm_changes_unconfirmed`를 다시 만들지 않기, ⓘ `contract_record` 근거를 규칙에도 허용, ⓙ `contract.list`가 깨진 계약 행을 조용히 건너뛰기. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 바뀐 시험 파일: orchestrator `contract` · `integrity` · `proposal-guard` · `rule-writer` · `implementer` · `structure-check` · `verification`, store `migrate` · `contracts`, shared `domain`, app `cli-contract` · `cli-blocks`. `TMPDIR=$(mktemp -d /tmp/tr289.XXXX)`. 실제 판정 · 실제 오케스트레이터를 띄우는 시험이 이 VM에서 '의존성 설치 시간 초과'로 실패하면 어느 시험인지와 사유를 적는다.
- 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험만 실패하면 통과로 본다. 전체 `pnpm e2e:pipeline` · 화면 e2e · 스모크는 돌리지 않는다(CI success).
- 숨은 글자: 바뀐 26개 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(파일 명시). `grep -c 'udb40' docs/decisions.md`는 2.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다. 판정 격리를 돌아가는 대처를 하지 않는다.
- 다른 담당이 같은 VM에서 문서 PR(이슈 #290)을 작업 중이다. 건드리지 않는다. 끝나면 네 프로세스 · 임시 파일 · 임시 폴더를 정리한다(네 PID만).

## 판정 기준
- 차단: 수용 기준 1 · 4 미충족, ADR-100 C2와 어긋나는 기록, 에이전트가 계약을 쓰는 길, 계약을 등록하면 기존 실행 흐름이 막히거나 계약 규칙이 판정 없이 통과로 세어지는 길, 옛 행이 깨지는 스키마 변경 · 다시 만들지 않은 트리거, 지운 방어로 열린 길, 느슨해진 구조 시험 · 기존 시험, 변이 생존, 사실과 다른 ADR 문장, 뒤 이슈(실행기 · M3-05 · M3-06)가 이 위에 설 수 없는 결함.
- 비차단: 취향, 범위 밖 개선. 후속 후보로 따로 적는다(어느 이슈에 붙일지 제안).

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(B1…, 파일 · 줄 · 재현 · 고칠 방향), 비차단(N1…), 위 10개 항목별 한 줄 결론, 5번의 경우별 결과 표(계약만 등록 / 선언 + 계약 / 계약 없음에서 검사 단계 · 지표가 어떻게 되는가), 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. **한국어로**, 짧게.
