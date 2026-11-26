너는 chanrhan/bive 저장소의 PR #309(이슈 #307, 로드맵 M3-53 "M3-07 쪼개기: 변이 주입 단계 켜기와 변이 생존의 자동 테스트 보강을 새 행으로")을 검토하는 독립 검토자다. 구현에 관여하지 않았다. 문서 PR이다(`docs/roadmap.md` · `docs/decisions.md`만, +36 / -10). 빠르고 정확하게 본다. 한국어로 일하고 보고도 한국어로 쓴다.

## 받은 값
- PR #309, 브랜치 `docs/307-split-m3-07`, 헤드 `f43ce260935f350671b59db436546fe3889d4ec6`, 기준 main `e5e3a09`. `ci`는 조율자가 따로 확인한다. 끝낼 때 `scripts/gh-rest.sh GET repos/chanrhan/bive/commits/f43ce260935f350671b59db436546fe3889d4ec6/check-runs`의 상태를 한 번 보고 적는다(기다리지 않는다).
- 네 작업 공간에서 `git fetch origin docs/307-split-m3-07` 뒤 `git checkout --detach FETCH_HEAD`. `git rev-parse HEAD` 확인. 푸시 · 커밋 · PR 수정 · GitHub 댓글 · 이슈 생성을 하지 않는다. `scripts/publish-roadmap.py`는 **`--dry-run`으로만** 돌린다(`--dry-run` 없이 돌리면 실제로 발행된다).

## 배경
이슈 #52(M3-07 "변이 주입 역할 · 변이 상태 · 고위험 우선")의 구현이 수용 기준 1 · 2 · 4만으로 41개 파일(+2377)이 되어 PR #308로 올라갔다(독립 검토 APPROVE, ADR-139, 제품의 변이 주입 단계는 그대로 `skipped`). 수용 기준 3(유형 A의 변이 주입 단계 켜기 · 변이 생존의 자동 유형 C 보강 · 변이 재주입 · `mutant-survives`)을 새 행 M3-54로 옮기는 것이 이 PR이다. 조율자가 정한 설계 결정 여섯(시작 근거 · 보강 표시 · 변이 글의 전달 · 예산 소진 · 재주입 · 고리와 중복 방지)이 ADR-141에 들어갔다.

## 먼저 읽을 것
`.claude/skills/pr-reviewer/SKILL.md`(로드맵 문서 검토 절), `CLAUDE.md`, `docs/roadmap-format.md`, scratchpad `/tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/`의 `brief-307.md`(문서 에이전트가 받은 지시서: 조율자 결정이 적혀 있다) · `pr309-body.md`(PR 본문 사본), 이슈 #307 · #52 본문(`scripts/gh-rest.sh GET repos/chanrhan/bive/issues/307` · `…/52`), `docs/decisions.md`의 ADR-141(이 PR이 더함) · ADR-100(B④ · A17 · 명세 변경 목록의 JDG-04 · RUN-07 · TODO-02 행) · ADR-020 · ADR-107 · ADR-111 · ADR-128 · ADR-130(쪼개기 ADR의 선례) · ADR-136, 선례 PR `git show 89d9122 -- docs/roadmap.md docs/decisions.md`. 열린 브랜치의 ADR-139는 `git fetch origin feat/52-mutation-role` 뒤 `git show origin/feat/52-mutation-role:docs/decisions.md`에서 읽는다.

## 판정할 것
1. **범위.** `git diff e5e3a09...HEAD --stat`: 두 파일뿐인가. `docs/spec/*` · `CLAUDE.md` · 제품 코드가 바뀌지 않았는가. 로드맵에서 지시 밖의 행 · 마일스톤을 고치지 않았는가(`-` 줄 전부).
2. **M3-07 행.** 수용 기준이 기존 1 · 2 · 4번 문장 **글자 그대로**인가(main의 행과 문자열로 대조: 3번 문장만 빠졌는가). 영역 `orchestrator·store·app`, 관련 ID에 ADR-139 추가가 사실과 맞는가. 발행된 키 · 이슈 번호가 그대로인가.
3. **새 행 M3-54.** 기존 3번 문장의 뜻이 빠짐없이 옮겨졌는가(유형 A의 변이 단계가 `skipped`가 아님, 변이 생존 → 유형 C 보강이 사람 확인 없이 자동, 재주입에서 '변이 검증됨'이어야 끝남, `mutant-survives` 시나리오, ADR-100 B④, M7-05의 자동 시작 규칙). 수용 기준 세 항목이 형식 규칙(항목 구분 ` · `, 항목 안 `·` 금지, 시험 파일 이름이 있는 검증 가능한 문장, 4개 이내)에 맞는가. 조율자 결정(`brief-307.md`의 1 ~ 6)이 수용 기준과 ADR-141에 사실대로 들어갔는가. **명세에 없는 기능을 새로 만든 문장이 없는가**(PRD JDG-04 · RUN-07, ADR-100 B④ · A17, ADR-020의 범위 안인가). 영역 `orchestrator·store·shared`와 의존 `M3-07·M3-06·M7-05`가 타당한가. PR 크기(파일 20개 이내 목표)에 맞는 한 행인가, 또 쪼개야 할 크기인가(의견).
4. **M3-15와의 경계.** 문서 에이전트는 규칙 카드 예외 '변이 생존'이 M3-15의 수용 기준(`e2e/scr-03.spec.ts`)에 이미 있다고 보고 M3-54에 넣지 않았다. M3-15 행을 읽고 사실인지 확인한다. 그러면 M3 완료 기준 흐름 3번("SCR-03 그 규칙 카드 예외 '변이 생존'")은 M3-07 · M3-54 · M3-15가 모두 끝나야 성립한다는 문장이 맞는가. `rule.list`에 변이 상태 칸을 더하는 일은 어느 행의 몫인지(M3-15의 수용 기준 · 영역 `app·store`로 덮이는가, 빈 곳이 생기는가) 판정한다. 빈 곳이 있으면 차단(어느 행에도 없는 일).
5. **의존을 옮긴 행.** `grep -n 'M3-07' docs/roadmap.md`의 모든 행을 읽고 판단 표(M3-08: M3-54 추가 · 문장의 "(M3-07)" → "(M3-54)", M3-15 · M5-05: 그대로)가 맞는지 본다. M3-09(검토 대기열 화면) · M3-30 · 그 밖에 자동 보강을 전제하는 행이 더 없는가.
6. **흐름 문장.** M3 흐름 머리와 M4 흐름 1에 더한 "변이 주입 역할 칸" 문장이 사실과 맞는가(값 `test-model` · 한도 USD 2 · 턴 100이 M1 · M7 흐름의 다른 역할 값과 같은 방식인가). PR #308 검토자의 지적: M1 흐름(로드맵 80 · 84줄 근처의 "2 · 6번 값")과 M7 "설정 저장"(185줄 근처)은 test-writer · implementer만 채워, #308 병합 뒤에는 그 흐름 그대로는 실행 생성이 막힌다. 문서 에이전트는 끝난 마일스톤(M1 · M7)의 흐름을 고치지 않고 M3 흐름 머리에 한 줄을 더하는 쪽을 골랐다: M3 흐름이 "M7 흐름의 설정 저장을 그대로 쓰고"라고 하므로 그 한 줄로 M3의 QA가 막히지 않는지, M5 · M6 흐름은 M4 흐름의 설정을 물려받는지 확인한다. 막히는 흐름이 남으면 차단.
7. **1장 · 3장 · 5장.** 요약 표의 M3 이슈 수 51 → 53이 맞는가(M3 표의 행 수를 직접 센다). 커버리지 표에 M3-53 · M3-54를 더한 행들이 선례(M3-46)와 같은 방식인가. 5장 변경 이력 줄이 사실인가(날짜 2026-11-26은 문서 에이전트가 작업한 한국 날짜다).
8. **ADR-141.** 형식(상태 · 맥락 · 결정 · 결과 · 다시 정하는 조건)이 ADR-130의 선례와 같은가. 결정 여섯이 `brief-307.md`와 같은가, ADR-100 · ADR-128 · ADR-107 · ADR-111과 모순이 없는가(특히 "변이 글을 테스트 작성 세션에 넘긴다"가 ADR-100의 역할 분리 문장과 부딪치지 않는가: ADR-100이 금지하는 흐름이 무엇인지 원문으로 확인한다). ADR-139를 "(PR 진행 중)"으로만 가리키고 본문을 베끼지 않았는가. "결과"의 과도기 서술(M3-07 병합 뒤 · M3-54 병합 전: 단계는 `skipped`, 변이 결과는 제품에서 저장되지 않음, 실행은 변이 주입 역할 설정을 요구)이 #52 브랜치의 코드와 맞는가. 앞 ADR 본문을 고치지 않았는가. ADR 머리줄이 138 다음 141인 것은 의도다(139 · 140은 열린 PR의 것). `grep -c 'udb40' docs/decisions.md`는 2.
9. **발행 미리 보기.** `python3 scripts/publish-roadmap.py --dry-run`: 이슈 생성 1건(M3-54), 본문 갱신 3건(#52 · #53 · #307), 수동 확인 0건, 검증 OK인지. `python3 -m unittest discover -s scripts -p 'test_*.py'`. 숨은 글자: `node /tmp/claude-0/-home-user-bive/6333409f-cbf4-55aa-b491-463fe23e95e5/scratchpad/r187-scan/r187b-hidden.mjs docs/roadmap.md docs/decisions.md`.

## 실행
`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, 파이썬 시험, `--dry-run`. 단위 테스트 · 빌드 · e2e는 돌리지 않는다. 권한 · 격리 검사가 거부한 일을 다른 길(다른 도구 · 다른 옵션 · 스크립트로 감싸기)로 하지 않는다("못 함"으로 보고). 프록시 환경 변수 값을 출력하지 않는다.

## 보고
판정(APPROVE / REQUEST_CHANGES)을 맨 앞에. 항목 1 ~ 9별 결론과 근거, 차단 · 비차단 지적, 실행한 명령과 결과, check-runs 상태. 짧게.
