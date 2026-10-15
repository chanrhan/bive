---
name: run-milestone
description: 마일스톤 하나의 이슈를 의존 순서대로 서브에이전트에게 구현시키고 CI · 리뷰 · 머지까지 끝내는 조율 절차.
---

# run-milestone

조율자가 직접 따른다. 구현 · 리뷰 · QA는 전부 서브에이전트. 조율자는 브랜치 이름, PR 번호, 판정만 기억한다.

## 준비

1. `scripts/gh-rest.sh GET "repos/chanrhan/bive/issues?milestone=<번호>&state=open&per_page=100"`로 이슈 목록을 받고, 본문의 `## 의존`과 로드맵 표로 위상 정렬한다. 의존이 다른 마일스톤의 미완료 이슈면 그 이슈를 먼저 처리하거나 needs-human으로 보고.
2. 📍 이슈(#1)에 "Mn 시작: 이슈 k개" 한 줄.
3. 기본 브랜치를 최신으로: `git fetch origin main && git checkout main && git reset --hard origin/main`.

## 이슈 처리 (의존이 풀린 이슈는 2~3개까지 병렬, 같은 패키지를 크게 고치는 이슈는 직렬)

### a. 구현 서브에이전트 (모델 opus, `isolation: worktree`)

브리핑에 반드시 넣을 것: 이슈 번호 · 제목 · 본문 전체(수용 기준), 관련 PRD · SCR · ADR 절의 **본문 발췌**, 브랜치 이름 `feat/<번호>-<slug>`(bug면 `fix/`, chore면 `chore/`), CLAUDE.md 4장 규칙, "테스트를 끄지 말 것", "범위 밖 변경 금지", 완료 조건 = `pnpm lint && pnpm typecheck && pnpm test && pnpm build`(해당하면 `pnpm e2e`) 통과 후 push + PR 생성(제목 = 이슈 제목, 본문 템플릿 채움, 첫 줄 `Closes #번호`). PR 번호와 실행한 명령 · 결과를 보고하게 한다.

### b. CI

PR 최신 커밋의 체크를 `GET repos/chanrhan/bive/commits/<sha>/check-runs`로 확인. 빨강이면 같은 서브에이전트(SendMessage)에게 로그(`get_job_logs`)를 주고 고치게 한다. 3회 실패하면 이슈에 코멘트를 남기고 needs-human 여부를 판단.

### c. 리뷰

`pr-reviewer` 스킬 절차로 새 서브에이전트에게 검토시킨다. REQUEST_CHANGES면 차단 지적만 구현 서브에이전트에게 넘겨 수정 → CI → 재검토. 최대 2회. 그래도 남으면 PR을 그대로 두고 이슈를 쪼개 로드맵 · GitHub에 반영한다.

### d. 머지

APPROVE + CI 초록이면 `merge_pull_request`(squash, 제목 = 이슈 제목). 머지 후 `git fetch origin main`. 이슈가 `Closes`로 안 닫혔으면 닫는다.

### e. 기록

📍 이슈에는 이슈마다 코멘트하지 않는다. 마일스톤 끝에만 회고.

## 마일스톤 마무리

1. 모든 이슈가 닫혔는지 확인. 남은 이슈는 사유(needs-human · 분할 · 다음 마일스톤 이월)를 이슈 코멘트에 적는다.
2. CLAUDE.md `<!-- KICKOFF -->` 명령 표가 현재 저장소에서 실제로 도는지 한 번 실행해 보고 다르면 고친다(PR `chore/kickoff-commands`).
3. QA는 운영 프롬프트 4-b 절차로 **구현에 관여하지 않은 새 서브에이전트**에게 맡긴다. 버그 이슈가 생기면 이 스킬의 "이슈 처리"로 같은 마일스톤에서 처리. 검수 → 수정 반복은 최대 2회.
4. 📍 이슈에 회고 코멘트: 머지된 PR 수 · 검수 판정 · needs-human 목록 · 새 ADR · 로드맵 조정이 필요해 보이는 점.
5. 다음 마일스톤은 사용자 지시를 기다린다. (운영 프롬프트가 "계속"을 대신 지시한 경우 바로 다음 마일스톤으로 간다.)
