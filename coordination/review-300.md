너는 chanrhan/bive 저장소의 PR #300(이슈 #50, 로드맵 M3-05 "계약 화면 (SCR-04)")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일하고 보고도 한국어로 쓴다.

## 배경 한 줄
M3-04(ADR-129)가 계약 등록과 조회(`contract.list`)를 만들었다. 이 PR은 사이드바 > 기획 > 계약 화면(목록 + 상세 2단)을 앱 렌더러에만 더한다(ADR-133). 오케스트레이터 · store · shared · 다리(preload · main)는 고치지 않았다고 한다.

## 받은 값
- PR #300, 브랜치 `feat/50-contract-screen`, 헤드 `ac42fdc2eb76eea24bfb3d73095150690041d834`, 기준 main `438a630`. 바뀐 파일 14개(+1515 / -10): 렌더러 `screens/contracts/`(화면 · 뷰 모델 · 훅 · CSS) · `screens/norm-detail/ContractDetail.tsx` · `screens/registry.ts`, e2e `checklists/scr-04.ts` · `scr-04.spec.ts` · 기존 e2e 3곳(`layout` · `scr-01` · `reconnect`), 단위 `test/contracts-view.test.ts`, `docs/decisions.md`(ADR-133). 조율자가 지시서를 쓸 때 이 헤드의 `ci`는 성공이었다(네가 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/ac42fdc2eb76eea24bfb3d73095150690041d834/check-runs`로 다시 확인해 적는다).
- 네 작업 공간에서 `git fetch origin feat/50-contract-screen && git checkout --detach FETCH_HEAD`로 본다. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만(Edit 도구로) 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-50.md`(구현자가 받은 지시서), `brief-common.md`, `m3-handoff.md`의 "M3-04" · "M3-19" · "M3-23" · "M3-35" 절, `pr300-body.md`(PR 본문 사본, 변이 표 포함).
3. 이슈 본문 수용 기준 3개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/50`)와 댓글.
4. `docs/spec/screens.md`의 1.1 · 1.4 · SCR-04 절 · SCR-06, `docs/decisions.md`의 ADR-133(이 PR이 더함) · ADR-129 · ADR-100(명세 변경 목록의 SCR-04 · I3) · ADR-029 · ADR-060 · ADR-073 · 확인 칩과 [문제만]을 정한 M7-15의 ADR.
5. 선례 코드: 요구사항 · 규칙 화면(`screens/` 아래)과 그 체크리스트 · e2e.

## 꼭 판정할 것
1. **범위.** `git diff 438a630...HEAD --stat`. 오케스트레이터 · store · shared · preload · main · `docs/spec/*` · `docs/roadmap.md` · `CLAUDE.md`가 바뀌지 않았는가. 기존 e2e 3곳의 변경: "계약을 아직 없는 화면으로 쓰던 자리를 추적성 맵으로 바꿨다"가 사실인가, 그 시험들이 **같은 것을 같은 세기로** 단언하는가(단언이 지워지거나 느슨해지지 않았는가. `-` · `+` 줄 대조). 추적성 맵 화면이 정말 아직 없는 화면인가.
2. **데이터 출처(NFR-03).** 카드 · 상세의 값마다 출처를 따라간다: `contract.list`의 `contract` · `rule`, `rule.list`의 `judgment.status`, `requirement.get`의 표시 ID. 제품 코드에 목 데이터 · 예시 값 · 추정이 없는가. "판정"을 `rule.list`에서 검사 규칙 ID로 찾는 방식이 규칙 화면이 최신 판정을 읽는 방식과 같은가(내장 규칙이 `rule.list`에 들어 있는가, 폐기 · 삭제 규칙 처리, 규칙이 목록에 없을 때의 표시). `rule`이 `null`인 계약과 "규칙은 있는데 판정을 모름"이 구분되는가. 부모 요구사항을 계약마다 `requirement.get`으로 부르면 계약 50건에서 호출이 몇 번인가, 실패하면 어떻게 보이는가(한 건의 실패가 화면 전체를 에러로 만드는가, 조용히 빠지는가).
3. **수용 기준 1: 기본 · 빈 상태.** 체크리스트 `checklists/scr-04.ts`의 기본 상태가 종류 · 원본 파일 · 연결 규칙 · 판정 · 생성 주체 · 확인 상태를 실제 화면에서 단언하는가(값까지인가, 줄의 존재만인가). 빈 상태 "계약 없음"(ADR-029의 문구 규칙). 로딩 · 에러가 요구사항 · 규칙 화면과 같은 방식인가.
4. **수용 기준 2: 결함 · 미확인 예외와 [문제만].** 스키마 불일치 = 검사 규칙 최신 판정 `fail`, 검사 규칙 없는 계약 = `rule === null`. 미판정 · 통과 · 격리 · 재검증 필요가 결함으로 보이지 않는가. 예외 문구가 화면 정의서의 낱말("스키마 불일치", "검사 규칙 없음" 꼴이 명사형인가, 화면에 코드 표기가 없는가). 결함이 [문제만]에 잡히는가. 미확인도 [문제만]에 잡히게 한 것이 요구사항 · 규칙 화면(M7-15)과 정말 같은가(그 ADR과 코드를 확인). 수용 기준 문장은 "결함이 [문제만]에 잡힘"이다: 미확인이 함께 잡히는 것이 ADR-100 I3과 어긋나지 않는가.
5. **수용 기준 3: 필터 칩 3종 + 확인 칩.** 종류 · 검사 규칙(있음 · 없음) · 판정 · 확인(미확인 · 확인됨). 값과 개수를 목록 항목에서만 세는가. 0건 값의 비활성, 기준 안 여러 값 · 기준 사이의 결합 방식이 다른 화면과 같은가(1.4). 판정 칩의 값 목록이 규칙 화면과 같은 낱말인가.
6. **표시 값과 화면 문구.** 원본 파일 경로 · 표시 ID · 종류 등 서버가 준 글을 그릴 때 `visibleText` · `visibleDisplayText`를 거치는가(카드 · 상세 · 툴팁 · `aria-label` 모두). 새 `title` 속성이 없는가(공통 툴팁). 모르는 종류 값이 와도 깨지지 않는가. 문구가 1.1(명사형, 이모지 금지, PRD · SCR · ADR 코드 표기 금지)을 지키는가: 화면 문구 검사(M0-07)가 이 화면 파일을 훑는가. 종류 표시명이 화면 정의서의 낱말(API · DB · 이벤트 · 외부 API · 캐시 · JSON 스키마)인가.
7. **동작.** 연결 규칙을 누르면 규칙 화면이 그 규칙을 고른 채 열리는가(기존 이동 방식). 필터 선택이 화면을 오가도 유지되고 프로젝트를 바꾸면 지워지는가(다른 화면과 같은가). 알림 구독으로 다시 읽을 때 겹친 요청 · 뒤늦은 응답이 화면을 옛 값으로 덮지 않는가(M3-35에서 고친 것과 같은 종류의 결함: 프로젝트를 바꾼 직후 앞 프로젝트의 응답이 도착하는 경우를 직접 만들어 본다). [확인] 버튼과 지시 입력이 없는가.
8. **화면 시험의 질.** `waitForTimeout`이 없는가. 글자 폭 · 픽셀 · 줄 바꿈 위치에 기대는 단언이 없는가. 색 단언은 무엇으로 하는가(계산된 색 값 비교면 테마 값과 묶여 있는가). 숨은 글자는 이스케이프인가. 목 데이터가 시험 코드 안에만 있는가.
9. **ADR-133.** 문장마다 코드와 맞는가. "기준 브랜치 어긋남 · 해시 · 커밋을 보이지 않는다", "[확인] 없음", "지시 동작 없음"의 근거가 문서 우선순위와 맞는가. 수용 기준이 요구하는데 ADR로 뺀 것이 없는가.
10. **변이.** 구현자의 16종(PR 본문 표)과 겹치지 않게 7종 안팎. 후보: ⓐ 격리 · 재검증 필요를 결함으로 세기, ⓑ 판정을 규칙 ID가 아닌 표시 ID · 목록 순서로 찾기, ⓒ 프로젝트를 바꿔도 필터 선택 유지, ⓓ 뒤늦은 응답이 덮게(요청 순번 확인 빼기), ⓔ 칩 개수를 걸러진 목록에서 세기, ⓕ 부모 요구사항 조회 실패를 화면 전체 에러로 / 조용히 빈 값으로(구현의 반대로), ⓖ 상세의 속성 줄 순서 바꾸기, ⓗ 예외 순서(결함 다음 미확인) 바꾸기, ⓘ `visibleText`를 `aria-label`에서만 빼기. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`.
- 단위: app `contracts-view.test.ts`와 app 전체 단위 시험. `TMPDIR=$(mktemp -d /tmp/tr300.XXXX)`.
- 화면 e2e: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(ls -d /opt/pw-browsers/chromium-*/chrome-linux*/chrome) pnpm e2e`를 `--trace off`로 한 번(전체). 변이 확인은 `scr-04.spec.ts`만 골라 돌린다. Vite 포트 충돌이 나면 `dev-env` 스킬대로 한다(다른 작업 공간의 프로세스를 죽이지 않는다). 직접 화면을 볼 때는 Playwright로 스크린샷을 찍어 확인한다(기본 · 결함 · 빈 상태 한 장씩, `deviceScaleFactor: 1`).
- Electron 스모크 `xvfb-run -a pnpm smoke` 한 번.
- 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험만 실패하면 통과로 본다. `pnpm e2e:pipeline`은 돌리지 않는다.
- 숨은 글자: 바뀐 14개 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다(파일 명시). `grep -c 'udb40' docs/decisions.md`는 2.
- 권한 · 격리 검사가 복합 명령을 거부하면 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 파일 고치기는 Edit · Write 도구로 한다. 스크립트 파일로 감싸 거부를 피하기, 옵션을 바꿔 다른 실행 방식으로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다(그 확인은 "못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.
- 다른 검토자가 같은 VM에서 PR #299를 검토 중이다(무거운 시험을 돌린다). 그 작업 공간 · 프로세스를 건드리지 않는다. 끝나면 네 프로세스 · 임시 파일 · 임시 폴더를 정리한다(네 PID만).

## 판정 기준
- 차단: 수용 기준 미충족, 근거 없는 값 · 목 데이터가 제품 코드에 있음, 결함 판정이 틀림, 서버가 준 글을 변환 없이 그림, 화면 문구 원칙 위반, 기존 e2e 단언의 약화, 뒤늦은 응답이 화면을 덮는 결함, 오케스트레이터 · shared 동작 변화, 변이 생존, 사실과 다른 ADR 문장, `ci` 실패.
- 비차단: 취향, 범위 밖 개선. 후속 후보로 따로 적는다.

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(B1…, 파일 · 줄 · 재현 · 고칠 방향), 비차단(N1…), 위 10개 항목별 한 줄 결론, `ci` 결과, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. **한국어로**, 짧게.
