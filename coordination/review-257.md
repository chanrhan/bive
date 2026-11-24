너는 chanrhan/bive 저장소의 PR #257(이슈 #229, 로드맵 M7-17 "파이프라인 e2e: 모순 해소 · 실수로 깬 기존 규칙 · 이의 제기 · 확인 풀림")를 검토하는 독립 검토자다. 구현에 관여하지 않았다. 구현자의 결론을 믿지 말고 코드와 실행으로 확인한다.

## 받은 값
- PR #257, 브랜치 `chore/229-pipeline-e2e-contradiction`, 헤드 `21aa86732458969ce46f530e370399bd48e45786`, 기준 main `e00089a`. 시험만 더하는 PR이다(제품 코드 · 시나리오 · 마이그레이션 · ADR 변경 없음이라고 보고받았다. 직접 확인한다).
- 바뀐 것(보고): 새 파일 `packages/orchestrator/e2e/pipeline/contradiction.test.ts`, `harness.ts`에 도우미 `waitForRunCreated`, `.github/workflows/ci.yml`의 `PIPELINE_E2E_GROUP1`에 `run-queue` · `false-pass` · `merge-conflict` · `happy-path`를 옮김.
- 네 작업 공간에서 `git fetch origin chore/229-pipeline-e2e-contradiction && git checkout --detach FETCH_HEAD`로 본다. 변이는 네 작업 공간 안에서만 하고 `git checkout -- <파일>`로 되돌린다. 푸시 · 커밋 · PR 수정 · GitHub 댓글을 하지 않는다.

## 먼저 읽을 것
1. `.claude/skills/pr-reviewer/SKILL.md`, `.claude/skills/dev-env/SKILL.md`(파이프라인 e2e 기동, 픽스처 설치, `TMPDIR`, 포트).
2. `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/brief-229.md`(구현자가 받은 지시서), `m7-handoff.md`의 M7-09 · M7-11 · M7-12 · M7-13 · M7-19 절(기준값. 단, M7-11 절의 "이의 판단 세션이 `run.get`에 안 나온다"는 낡았다. M7-12 뒤로는 `rule-writer`로 나온다).
3. 이슈 본문 수용 기준 4개(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/229`), PR 본문(`scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/257`).
4. `docs/decisions.md`의 ADR-071 · ADR-077(파이프라인 e2e, CI 묶음), ADR-112 · ADR-113 · ADR-115 · ADR-118.

## 꼭 판정할 것
1. **범위.** `git diff e00089a...HEAD --stat`. 제품 코드(`packages/*/src`) · 시나리오가 바뀌지 않았는가.
2. **수용 기준 4개**가 시험으로 고정됐는가.
3. **단언이 흐름을 고정하는가.** 네 흐름마다: 실행 표시 ID별 상태 · 종료 사유, 단계 시도별 결과, 규범 변경 기록의 종류 순서(정확한 배열 비교인가, 부분 포함인가), `run.get` 세션 목록, 병합 커밋 수(git으로 세는가), 폐기 · 대체 건수, `confirmation.list` 첫 항목과 `released`, 모순으로 끝난 실행의 브랜치가 main의 조상이 아님(git으로 확인하는가). "끝 상태만" 보는 단언, `toContain`만 있는 자리, 조건문 안에 숨은 단언(`if (x) expect…`)을 찾는다.
4. **사람 주체.** contradiction 흐름의 `confirmation.set`이 사람 주체 경로로 불리는가(시험이 에이전트 주체로 확인을 쓰는 뒷문을 쓰지 않는가).
5. **대기.** 고정 `sleep` · `setTimeout` 대기가 없는가. `waitForRunCreated`가 하네스의 기존 대기 도우미 위에 있고 시간 제한이 기존 파일 수준인가. 흐름끼리 상태가 섞이지 않는가(흐름마다 새 픽스처 · 오케스트레이터). 정리(프로세스 · 임시 폴더)가 실패 경로에서도 되는가. 불안정 요소(실행 생성 순서에 기댄 표시 ID, 시각 비교)가 있는가.
6. **CI 묶음.** `ci.yml`의 변경이 묶음 옮기기와 주석뿐인가. `scripts/check-pipeline-groups.py`의 대조가 새 파일을 포함해 성공했는가(`pipeline-e2e` 로그 또는 스크립트를 로컬에서 실행). 최종 헤드의 두 묶음 소요 시간을 check-runs의 `started_at` · `completed_at`으로 직접 계산한다(보고값: 묶음 1 15:05, 묶음 2 11:52. 제한 30분, 목표는 둘 다 20분 아래).
7. **변이.** 구현자의 6종(확인 풀림 건너뛰기, `effective.ts`의 폐기 제외 빼기, 모순 거르기 끄기, 다시 시작 끄기, 모순 없음을 모순으로, 이의 유지를 반영으로)과 겹치지 않게 5종 안팎. 한 흐름이 약 3분이라 변이마다 그 흐름만 `-t`로 돌린다. 후보: ⓐ `confirmation.list` 정렬에서 폐기 · 대체를 맨 위로 올리는 줄 빼기(contradiction), ⓑ 확인 풀림 기록의 `causeSeq`를 다른 순번으로(contradiction), ⓒ 모순으로 끝난 실행을 병합하게 하기 또는 `contradictionHalt` 한쪽 빼기(contradiction-missed), ⓓ 다시 시작의 원인 순번을 다른 기록으로(contradiction-missed), ⓔ 판단 세션 행을 단계 시도에 묶는 줄 빼기(accidental-break 또는 objection의 세션 목록 단언), ⓕ 이의 유지 뒤 구현 재시도를 건너뛰어 실패로 끝내기(objection). 변이마다 어느 단언이 빨강이 됐는지 표로 낸다. 빨강이 안 된 변이는 차단 후보다.

## 실행
- `pnpm install --frozen-lockfile`, `pnpm -C fixtures/sample-next-app install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`.
- 새 파일 전체 1회(약 13분): `package.json`의 `e2e:pipeline` 스크립트가 쓰는 설정으로 `contradiction.test.ts`만. `TMPDIR`은 짧은 격리 경로.
- 전체 `pnpm e2e:pipeline` · `pnpm test` · 화면 e2e · 스모크는 돌리지 않는다(CI `ci`가 이 헤드에서 success다).
- 숨은 글자: 바뀐 파일을 `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs <파일들>`로 훑는다.
- 권한 시스템이나 격리 검사가 명령을 거부하면 다른 명령으로 대신하지 말고 그 사실만 보고에 적는다. 프록시 환경 변수 값을 출력하지 않는다.

## 판정 기준
- 차단: 수용 기준 미충족, 흐름을 고정하지 못하는 단언(변이 생존), 고정 대기, 흐름 간 상태 섞임, 제품 코드 변경, 묶음 대조 누락, 묶음 하나가 20분 초과.
- 비차단: 취향, 범위 밖. 후속 후보로 따로 적는다.

## 보고
`APPROVE` 또는 `REQUEST_CHANGES` 한 줄, 차단(B1…, 파일 · 줄 · 재현 · 고칠 방향), 비차단(N1…), 위 7개 항목별 한 줄 결론, 실행한 명령과 종료 코드, 변이 표, 두 묶음 소요 시간. 한국어로, 짧게.
