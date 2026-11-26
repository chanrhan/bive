너는 chanrhan/bive 저장소의 PR #312(이슈 #259, 로드맵 M3-31 "M7 후속 구조 시험 보강 (별칭 · 구조 분해 · 동적 import · 대괄호 접근 · 날 SQL · 종료 리터럴 식)")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경
`packages/orchestrator/test/integrity.test.ts`의 구조 시험은 소스를 읽어 "이 저장소 · 이 서비스는 이 모듈만 쓴다" 같은 성질(무결성 NFR-01 · NFR-02의 구조적 보호)을 고정한다. 기존 시험은 정규식이라 별칭 · 구조 분해 · 대괄호 접근 등으로 쓰면 놓쳤다. 이 PR은 TypeScript 컴파일러 API(구문 트리 + 타입 검사기)로 잡는 도우미를 더하고 시험을 보강한다(ADR-142). **제품 코드(`src/`)는 고치지 않았다**고 한다. 바뀐 파일 3개: `test/helpers/source-structure.ts`(새 파일) · `test/integrity.test.ts` · `docs/decisions.md`.

## 받은 값
- PR #312, 브랜치 `chore/259-integrity-structure-tests`, 헤드 `8db67410397daf73443b2355e89b55ce37fc3796`(main `6a356b4` 병합 포함), 기준 main `6a356b4`. +1626 / -1. 조율자가 `ci` 성공(검사 5개 success)과 `clean`을 확인했다. 네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/8db67410397daf73443b2355e89b55ce37fc3796/check-runs`로 한 번 더 보고 `checks` 소요 분을 적는다.
- 네 작업 공간에서 `git fetch origin chore/259-integrity-structure-tests` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 변이 · 임시 위반은 네 작업 공간 안에서만(Edit · Write 도구로) 하고 `git checkout -- <파일>`(새 파일은 지움)로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-259.md`(구현자가 받은 지시서), `pr312-body.md`(PR 본문 사본: "빼면 빨강" 표 · 못 잡는 형태 표).
3. 이슈 본문 수용 기준 4개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/259`).
4. `packages/orchestrator/test/integrity.test.ts` 전부와 `test/helpers/source-structure.ts` 전부, `docs/decisions.md`의 ADR-142(이 PR이 더함) · ADR-101 · ADR-103 · ADR-105 · ADR-112 · ADR-115 · ADR-119.

## 꼭 판정할 것
1. **범위.** `git diff 6a356b4...HEAD --stat`: 세 파일뿐인가. `src/` · `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md` · 워크플로 · `package.json`(새 의존성)이 바뀌지 않았는가. `integrity.test.ts`의 `-` 줄(1줄)이 무엇인가. **기존 구조 시험의 단언 · 허용 목록이 그대로인가**(헐거워지지 않았는가). 새 시험이 "구문 트리가 찾은 파일 = 기존 정규식이 찾은 파일"을 단언한다고 한다: 이 단언이 허용 목록을 한 곳에 두는 방식으로 타당한가, 아니면 기존 정규식이 놓치는 위반을 새 방식이 찾아도 "두 결과가 같다"는 단언 때문에 다른 방식으로 실패할 뿐 결국 빨강인가(빨강이면 됨: 위반이 조용히 통과하는 길이 없는지만 본다).
2. **잡는 도우미의 정확성 (가장 중요).** `source-structure.ts`가 무엇으로 "이 접근이 그 저장소 · 그 서비스를 가리킨다"를 판정하는지 읽는다(타입 검사기의 심벌 · 선언 위치인가, 속성 이름인가).
   - **거짓 음성**(위반을 놓침)을 네가 직접 찾는다. 수용 기준의 형태(별칭 변수 · 구조 분해 · 대괄호 접근 · 동적 `import()` · 큰따옴표 지정자 · `export … from` · `?.` 없는 호출) 말고도: 구조 분해의 이름 바꾸기(`const { normChanges: nc } = store`), 기본값 · 나머지 요소(`const { normChanges, ...rest } = store` 뒤 `rest`), 화살표 함수의 매개변수 구조 분해, 클래스 필드에 담기, `Object.entries(store)` · `store[key as keyof …]`, 옵셔널 호출(`store.normChanges?.append?.(…)`), `as any` · `as unknown as` 캐스팅 뒤 접근, 제네릭 도우미로 감싼 저장소, 다른 파일이 다시 내보낸 것을 가져오기(다시 내보내기 사슬 2단계), `import type`만 있고 값으로 쓰는 경우, `await import('./x.js')`의 결과 구조 분해, 템플릿 리터럴 지정자, `.js` · `.ts` 확장자 · 경로 별칭(`@bive/store`의 하위 경로)으로 가져오기. 형태마다 **제품 소스에 임시 위반을 넣어**(허용 목록 밖 파일 하나에 한 줄, Edit로) 구조 시험이 빨강인지 본다. 빨강이 아닌 형태를 표로 낸다.
   - 그 가운데 ADR-142의 "못 잡는 형태" 목록에 **없는** 것이 있으면 차단 후보다(목록이 사실과 다르다: 목록에 더하거나 잡게 고쳐야 한다). 목록에 있는 것은 그 성질을 지킨다고 적힌 행동 시험이 실제로 있는지(파일 · 이름을 grep으로) 확인한다.
   - **거짓 양성**: 정상 코드(허용된 모듈의 사용, 같은 이름의 다른 것)를 위반으로 잡지 않는가. 구현자가 패턴 쪽을 고쳤다는 세 가지(흔한 이름의 문자열, `update rules` 같은 글, `blockedEnding`)의 예외가 **위반을 통과시키는 구멍**이 되지 않는가: 특히 종료 상태 리터럴에서 "`runEnding`의 결과 · 그것을 그대로 돌려주는 함수의 결과 · 저장된 실행을 그대로 옮기는 값"을 빼는 판정이 이름 기준인가 선언 기준인가(같은 이름의 가짜 함수를 다른 파일에 만들면 통과하는가).
   - 타입 검사기를 쓰므로 **타입 오류가 있는 소스 · 타입이 `any`로 무너진 자리**에서 판정이 어떻게 되는가(놓치는 쪽인가, 잡는 쪽인가). 프로그램을 만들 때 쓰는 `tsconfig`가 제품과 같은가(다른 설정이라 파일이 빠지면 그 파일의 위반을 놓친다: 대상 파일 목록이 `src/` 전체를 덮는지 파일 수를 단언하는가). 새 파일이 `src/`에 생기면 자동으로 대상에 드는가.
3. **날 SQL (수용 기준 2).** 네 표(`confirmations` · `rules` · `norm_changes` · `rule_retirements`)에 쓰는 문장을 무엇으로 찾는가(문자열 리터럴 · 템플릿을 구문 트리에서 모아 정규식으로?). 놓치는 형태: 문자열 이어 붙이기(`'INSERT INTO ' + table`), 변수에 담은 표 이름, 태그드 템플릿, 주석 안의 SQL(거짓 양성), `WITH … INSERT`, `INSERT OR REPLACE`, `UPSERT`, 대소문자 섞임, 표 이름 앞의 스키마 · 따옴표 · 대괄호 · 백틱. 수용 기준은 "오케스트레이터 `src` 전체": 구현자는 app · shared · parser까지 넓혔다고 한다(넓힌 것은 좋다: 그 패키지들에 store를 직접 여는 코드가 있는지). "오케스트레이터가 `store.db`와 SQLite 모듈을 쓰지 않는다"는 추가 단언이 지금 소스에서 참인지와, 방금 병합된 `steps/mutation.ts`(변이 결과 저장)가 그것을 지키는지.
4. **종료 상태 리터럴 (수용 기준 3).** 대상에 `steps/`가 들어갔는가. 삼항 · 변수 · 스프레드 표본이 잡히는가. 기존 `engine.test.ts`의 같은 성질 시험이 그대로 있는가(옮기지 않고 더했는가: 두 곳에 있으면 한쪽만 고쳐지는 위험은 ADR에 적혔는가).
5. **ADR-142의 표.** 성질 8개마다 "구조 시험이 잡는 형태 · 못 잡는 형태 · 행동 시험 이름"이 사실인가(행동 시험 이름을 grep으로 전부 확인한다). "행동 시험이 없는 한계 셋"(규범 변경 기록 행을 어느 경로가 썼는지 DB도 시험도 가리지 않음, 규칙 행을 만드는 모듈을 DB가 가리지 않음, 병합 커밋이 있는 실행을 `failed`로 쓰는 것을 DB가 거부하지 않음)이 사실인가. 이 한계들이 **지금 악용 가능한 결함**인지, 구조 시험과 코드 검토에 기대는 알려진 설계인지 구분해 적는다(결함이면 조율자가 후속 이슈로 만든다. 이 PR의 차단은 아니다). ADR에 악용 절차가 적혀 있지 않은가. ADR 머리줄: 이 브랜치는 139 · 141 · 142다(140은 열린 PR #310의 것). 그대로가 맞다. `grep -c 'udb40' docs/decisions.md`는 2. 앞 ADR 본문을 고치지 않았는가.
6. **시험 시간과 안정성.** `integrity.test.ts` 단독 소요(구현자: 9.6초 → 16초)를 네가 잰다. 프로그램을 몇 번 만드는가(한 번 만들어 재사용하는가). 다른 시험과 병렬로 돌 때 메모리 · 시간 초과 위험(타입 검사기는 무겁다: vitest의 기본 시험 제한 시간 안인가, 시험에 따로 준 제한 시간). CI `checks`가 지금 21 ~ 22분(제한 30분)이다.
7. **변이(도우미 자체).** 구현자는 "옛 정규식으로 되돌리면 표본 시험이 빨강"과 "제품 소스에 임시 위반 22가지"를 했다. 겹치지 않게 도우미의 판정 로직을 약하게 바꾸는 변이 6종 안팎: 별칭 추적 빼기, 구조 분해 추적 빼기, 대괄호(문자열 리터럴 요소 접근) 처리 빼기, 동적 import 처리 빼기, 종료 상태의 삼항 · 스프레드 처리 빼기, 날 SQL의 템플릿 처리 빼기, 허용 판정을 파일 이름 끝 일치로 느슨하게. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다(표본 시험이 형태마다 따로 단언하는지 확인이 된다).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 시험(`TMPDIR=$(mktemp -d /tmp/tr312.XXXX)`): orchestrator `integrity` · `engine`(파일 단위). 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번(격리 `TMPDIR`). 알려진 두 시험("hoist 설정(…) node-gyp bin …" · "닫힘 밖 file: 패키지의 python3 bin …")만 '의존성 설치 시간 초과'로 실패하면 통과로 본다. e2e · 스모크는 돌리지 않는다(제품 코드 변경 없음).
- 숨은 글자: 바뀐 파일 3개를 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션이나 도구를 바꿔 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 끝낼 때 작업 트리가 깨끗한지(`git status`)와 네가 띄운 프로세스가 남지 않았는지 확인한다.

## 보고
- 판정: APPROVE 또는 REQUEST_CHANGES.
- 수용 기준 4개별 충족 여부와 근거(파일:줄, 시험).
- 네가 넣은 임시 위반 형태별 결과 표(형태, 빨강 여부, ADR-142 목록에 있는가).
- 도우미 변이 결과 표.
- ADR-142의 행동 시험 이름 확인 결과와 한계 셋의 성격(결함인가 알려진 설계인가).
- 차단 지적(재현 절차와 함께) · 비차단 지적.
- 실행한 명령과 결과, 시험 시간, `checks` 소요, 못 한 것.
- 남은 지적이 한 번의 수정으로 닫힐 크기인지 한 줄.
