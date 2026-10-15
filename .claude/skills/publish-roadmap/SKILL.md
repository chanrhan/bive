---
name: publish-roadmap
description: docs/roadmap.md 를 GitHub 라벨 · 마일스톤 · 이슈로 발행하고 이슈 번호를 로드맵에 되써 넣는 절차. 멱등.
---

# publish-roadmap

서브에이전트(모델 sonnet)에게 맡길 수 있는 기계적 작업. GitHub 호출은 전부 `scripts/gh-rest.sh`(= `gh api`)로 한다. 형식은 `docs/roadmap-format.md`.

## 절차

1. **라벨**: 아래 목록을 `GET repos/chanrhan/bive/labels --paginate`로 대조하고 없는 것만 `POST`.
   - `type:feature` `#1d76db` · `type:bug` `#d73a4a` · `type:chore` `#6a737d` · `type:docs` `#0075ca`
   - `area:app` `area:orchestrator` `area:store` `area:parser` `area:shared` `area:ci` `area:docs` (색 `#bfd4f2`)
   - `needs-human` `#d93f0b`
2. **마일스톤**: `GET repos/chanrhan/bive/milestones?state=all --paginate`. 로드맵 2.x 절의 `Mn 이름`과 제목이 같은 것이 없으면 `POST repos/chanrhan/bive/milestones -f title='Mn 이름' -f description='<목표 + 완료 기준 흐름>'`. 번호를 기억한다.
3. **이슈**: 마일스톤 순서, 표의 행 순서대로. `GET repos/chanrhan/bive/issues?state=all&milestone=<번호>&per_page=100 --paginate`에서 제목 `[Mn] 제목`이 이미 있으면 건너뛰고 번호만 기록. 없으면 `POST repos/chanrhan/bive/issues --input <json>` (title, body, labels, milestone). 본문 틀은 roadmap-format 4절. 의존 키는 이미 발행된 이슈 번호로 바꿔 적는다 (아직 번호가 없으면 키 그대로).
   - 한 번에 많이 만들면 2차 제한에 걸린다. 요청 사이에 1초 쉬고, 403 · 429가 오면 60초 뒤 재시도 1회.
4. **되써 넣기**: 로드맵 표의 `이슈` 열을 `#번호`로 채우고, 의존 열의 키 옆에 번호를 병기하지 않는다(키 유지). 커버리지 표의 `이슈 키`는 그대로.
5. **검증**: 마일스톤별 열린 이슈 수가 표의 행 수와 같은지 `GET .../milestones/<번호>`의 `open_issues`로 확인. 다르면 차이를 보고.
6. 변경 이력에 "발행: 마일스톤 n개, 이슈 m개" 한 줄을 추가하고 `docs(roadmap): 이슈 번호 기록` 으로 커밋 · push.

## 다시 실행할 때

로드맵에 이슈가 추가되거나 수용 기준이 바뀌면 같은 절차를 다시 돈다. 기존 이슈는 제목으로 찾고 본문이 달라졌으면 `PATCH repos/chanrhan/bive/issues/<번호>`로 갱신한다. 삭제된 행의 이슈는 닫지 않고 보고만 한다(사람이 판단).

## 출력

- 만든 라벨 · 마일스톤 · 이슈 수, 건너뛴 수, 실패 목록
- 마일스톤 번호 ↔ 이름 표
