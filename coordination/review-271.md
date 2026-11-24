너는 chanrhan/bive 저장소의 PR #271(이슈 #264, 로드맵 M3-36 "무결성 틈 보강")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다. 한국어로 일한다.

## 받은 값
- PR #271, 브랜치 `fix/264-integrity-gaps`, 헤드 `10e9eb81217bcb2de7b01eb014effd0c561377cd`, 기준 main `10ad3d5`. 바뀐 파일 20개(+1517 / -61). 이 헤드에서 CI `ci` · `checks` · `pipeline-e2e` 두 묶음은 모두 success다(조율자가 check-runs로 확인).
- 네 작업 공간에서 `git fetch origin fix/264-integrity-gaps && git checkout --detach FETCH_HEAD`로 본다. `git rev-parse HEAD`가 위 헤드와 같은지 확인한다. 변이는 네 작업 공간 안에서만 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`, `CLAUDE.md`.
2. scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-264.md`(구현자가 받은 지시서), `brief-common.md`, `m3-handoff.md`, `pr271-body.md`(PR 본문 사본, 변이 표 M1 ~ M21 포함).
3. 이슈 본문 수용 기준(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/264`).
4. `docs/decisions.md`의 ADR-120(이 PR이 더함)과 그것이 가리키는 ADR(ADR-100, ADR-112, ADR-114, ADR-116, 마이그레이션 0016 · 0018을 설명한 ADR).

## 꼭 판정할 것
1. **범위.** `git diff 10ad3d5...HEAD --stat`. 화면(`packages/app`) · 시나리오 · `docs/spec/*` · `CLAUDE.md` · 구조 시험 `packages/orchestrator/test/integrity.test.ts`가 바뀌지 않았는가. 마이그레이션이 0021 하나인가.
2. **기동 때 빠진 알림 복구.**
   - "실행마다 정확히 한 번"이 실제로 지켜지는가. 병합 저장 → 표시 행 삽입(트리거) → 알림 기록 + 확인 시각 채우기(한 트랜잭션)의 각 틈에서 프로세스가 죽는 경우를 손으로 따져 본다. 두 번 기록되거나 영영 안 기록되는 순서가 있는가.
   - `recoverPending`이 실행을 다시 시작 · 재개하지 않는가(#239는 사람 결정 대기다). 기동 순서에서 다른 복구와 겹쳐 경합하지 않는가. 복구가 던지면 기동이 죽는가, 삼키는가, 드러나는가.
   - 보고된 남는 틈 "되짚을 때의 확인 상태는 병합 순간이 아니라 되짚는 순간의 값"이 잘못된 알림(없어야 할 알림, 빠지는 알림)을 만들 수 있는 구체적 순서가 있는가. 있으면 ADR-120에 그 한계가 정확히 적혔는가.
   - 엔진이 확인 상태를 모른다는 구조 시험을 돌아가지 않았는가(예: 엔진 밖 모듈로 옮겼을 뿐 같은 정보를 엔진 결정에 쓰는 길).
3. **0021 저장 제약.**
   - 구현자는 표 CHECK 대신 BEFORE 트리거만 썼다(옛 위반 행을 그대로 두려고). 이 선택이 이슈 수용 기준과 지시서를 만족하는가, 트리거를 지우지 않고 돌아갈 쓰기 경로(`INSERT OR REPLACE`, `UPDATE`로 `merged`가 아닌 상태를 거쳐 가는 길, `ON CONFLICT`, 다른 열만 고치는 UPDATE)가 있는가. 각 제약마다 INSERT와 UPDATE 두 길이 다 막혔는가.
   - `approval_log_actor_human`: 제품 코드의 모든 승인 기록 쓰기 경로가 이 모양을 통과하는가(파이프라인 e2e 통과만으로 믿지 말고 쓰는 곳을 grep으로 센다). 승인 기록 · 규범 변경 기록 해시 체인이 이행 뒤 그대로 유효한가(시험이 실제로 체인 검증 함수를 부르는가).
   - 폐기 기록 제약 둘(`rule_retirements_effective_successor` · `_norm_change_successor`)이 "대체 규칙이 유효함"과 "`detail.retirement.supersededBy` 일치"를 정말 강제하는가. JSON 값이 깨졌거나 키가 없을 때 통과하는가, 거부하는가.
   - `run_test_change_checks`의 삭제 금지 · 갱신 제약이 "확인 시각을 한 번만 채움"을 강제하는가(채운 뒤 다시 NULL로, 다른 시각으로).
   - 빈 DB에서 0001 ~ 0021을 올린 결과와 0020 상태의 실제 데이터가 있는 DB에서 0021만 올린 결과의 스키마가 같은가. 옛 위반 행이 있어도 이행이 성공하는가(시험이 그 행을 실제로 넣는가).
   - `runs`를 다시 만드는 뒤 이슈가 다시 만들어야 할 트리거 목록(0016의 8개 + 이번 4개)이 ADR 또는 코드 주석에 정확히 적혔는가.
4. **`appliedRef`와 병합 시점 폐기.**
   - `ApprovalLogEntry.appliedRef`를 `approve` · `approve_edited`로 좁힌 것이 읽기 스키마에서 옛 행을 깨뜨리지 않는가(쓰기만 좁혔는가, 읽기도 좁혔는가. 읽기도 좁혔다면 옛 DB에 다른 결정 종류에 이 칸이 든 행이 있을 수 없음을 코드로 확인한다).
   - `merge`의 `beforeUpdate`: 확인과 기준 브랜치 갱신 사이에 다른 쓰기가 끼어들 틈이 정말 없는가(동기인가, `await`가 사이에 있는가). `target_rule_retired`로 끝난 실행의 상태 · 종료 사유 · 브랜치(main의 조상이 아님) · 워크트리 정리가 기존 실패 경로와 같은가. 화면에 보이는 사유 글자에 코드 표기가 새로 드러나지 않는가(`brief-common.md`의 표시 규칙).
5. **변조 행 하나의 영향.** 지시서는 "조용히 삼키지 않는다"를 요구했다. 구현은 "건너뛰고 로그 경고 한 줄(`warnOnce`), 조회 결과에는 없음"이다.
   - 이것이 이슈 수용 기준을 만족하는가를 근거와 함께 판정한다. `warnOnce`가 프로세스당 한 번이라면 두 번째 변조 행 · 다른 프로젝트의 변조 행은 어떻게 되는가. 건수가 정확한가.
   - `sessions.norm_input`을 `null`로 읽을 때, 그 값을 쓰는 곳(모순 판단, 이의 판단, 재판단, 화면의 규범 입력 표시)이 "입력 없음"으로 잘못 동작해 무결성 결정이 달라지는 길이 있는가(예: 변조로 모순 판단을 건너뛰게 만들기). 있으면 차단이다.
   - 하루 한도 합산이 변조 행 때문에 덜 세지 않는가(비용 칸 자체가 깨진 행은 어떻게 되는가. 닫힌 쪽인가).
   - `runs.list`가 건너뛴 행 때문에 "프로젝트당 동시 실행 1개"(ADR-110), 대기 실행, 자동 시작 판단이 달라지는 길이 있는가(예: 실행 중인 행이 깨져 목록에서 빠지면 두 번째 실행이 시작되는가).
6. **고친 기존 시험 둘.** `migrate.test.ts`의 0018 시험(범위를 0018까지로 좁힘)과 `norm-changes.test.ts` 하나가 원래 고정하던 것을 여전히 고정하는가. 느슨해졌으면 차단이다.
7. **문서.** ADR-120의 문장마다 가리키는 코드 위치가 실제와 맞는가. 닫힌 길 · 남는 틈이 정확한가(악용 절차를 적지 않았는가). `docs/architecture.md` 변경이 사실인가.
8. **변이.** 구현자의 M1 ~ M21과 겹치지 않게 6종 안팎을 직접 한다. 후보: ⓐ `run_test_change_checks` 확인 시각 채우기를 알림 기록 트랜잭션 밖으로 빼기, ⓑ `recoverPending`이 확인 끝난 실행도 다시 보게 하기, ⓒ `runs_merged_commit_update` 트리거의 조건을 INSERT 쪽과 다르게 느슨하게, ⓓ 폐기 기록 트리거에서 `supersededBy` 비교 빼기, ⓔ `beforeUpdate` 확인을 기준 브랜치 갱신 뒤로 옮기기, ⓕ 변조 `runs` 행을 건너뛸 때 경고를 빼기, ⓖ 하루 합산에서 `norm_input`이 깨진 세션을 빼기. 변이마다 어느 시험이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다(구현자 표에 같은 방어가 이미 있으면 그 번호를 적는다).

## 실행
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`.
- 바뀐 시험 파일만: store의 `migrate` · `norm-changes` · `runs` · `sessions`, shared의 `domain`, orchestrator의 `test-change` · `tampered-rows` · `implementer` · `integrity`. `TMPDIR=$(mktemp -d /tmp/tr271.XXXX)`를 준다.
- 전체 `pnpm test`는 `git merge-base --is-ancestor 97b4d86 HEAD`가 성공일 때 한 번만(격리 `TMPDIR`). 알려진 두 시험('의존성 설치 시간 초과')만 실패하면 통과로 본다. 전체 `pnpm e2e:pipeline` · 화면 e2e · 스모크는 돌리지 않는다(CI가 이 헤드에서 success다).
- 숨은 글자: 바뀐 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다. `grep -c 'udb40' docs/decisions.md`는 2여야 한다.
- 권한 시스템이나 격리 검사가 복합 명령을 "확인하기에 너무 복잡하다"로 거부하면, 검사기가 볼 수 있는 단순한 개별 명령으로 나눠 다시 내는 것은 된다. 스크립트 파일로 감싸기, 다른 도구로 같은 일 하기, 거부된 경로를 다른 길로 건드리기는 하지 않는다. 그 확인은 "못 함"으로 보고한다. 프록시 환경 변수 값을 출력하지 않는다. 판정 격리를 돌아가는 대처를 하지 않는다.
- 끝나면 네가 띄운 프로세스와 임시 폴더를 정리한다(네 PID만).

## 판정 기준
- 차단: 수용 기준 미충족, 한 번만 보장이 깨지는 순서, 돌아갈 수 있는 제약, 변조 행으로 무결성 결정(모순 판단 · 동시 실행 · 한도)이 달라지는 길, 조용히 삼킴, 느슨해진 기존 시험, 변이 생존, 옛 DB 이행 실패, 사실과 다른 ADR 문장.
- 비차단: 취향, 범위 밖 개선. 후속 후보로 따로 적는다(어느 열린 이슈에 붙일지 제안: #259 ~ #262, #266 등).

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(B1…, 파일 · 줄 · 재현 · 고칠 방향), 비차단(N1…), 위 8개 항목별 한 줄 결론, 실행한 명령과 종료 코드, 변이 표, "못 함" 목록. 한국어로, 짧게.
