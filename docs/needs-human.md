# needs-human (GitHub 이슈로 만들지 못해 파일로 기록)

> 2026-10-15 · 세션이 GitHub에 쓰기(브랜치 · 이슈 · PR · push)를 할 수 없어 이슈 대신 여기에 적는다. 접근이 복구되면 각 항목을 `needs-human` 라벨 이슈로 옮기고 이 파일은 지운다.

| # | 항목 | 사람이 할 일 | 막히는 단계 |
|---|---|---|---|
| NH-1 | GitHub 쓰기 권한 없음 (git push 403, API `Resource not accessible by integration`) | https://claude.ai/connect-github 에서 GitHub를 다시 연결하고, `chanrhan/bive`에 Claude GitHub App을 설치한다 (https://github.com/apps/claude/installations/select_target). 새 세션은 저장소를 선택해서 시작한다 | 전부 (📍 이슈 · PR · 발행 · 마일스톤) |
| NH-2 | `CLAUDE.md` 없음 (`<!-- KICKOFF -->` 칸, "막혔을 때" 규칙) | 템플릿 CLAUDE.md를 저장소 루트에 추가 | 2단계 킥오프 |
| NH-3 | `.claude/skills/` 없음 (pr-reviewer · publish-roadmap · run-milestone) | 스킬 디렉터리를 추가 | 2 · 3 · 4단계 |
| NH-4 | `docs/roadmap-format.md` 없음 | 로드맵 형식 문서를 추가 | 2단계 (roadmap.md) |
| NH-5 | `docs/prototype/` 없음 (프로토타입 v5 HTML) | 프로토타입 파일을 `docs/prototype/`에 추가. 파일명 → SCR ID 매핑 제안은 `docs/spec/screens.md` 1.3과 대화 기록 참조 | 2단계 (prototype-map.md) · 4단계 검수 |
| NH-6 | `scripts/gh-rest.sh`, `.github/ISSUE_TEMPLATE/bug.yml` 없음 | 템플릿 스크립트 · 이슈 양식을 추가 | 4단계 (bug 이슈 · 브랜치 보호 등록) |
| NH-7 | ADR-001~014 확인 | `docs/decisions.md`의 각 항목을 채택 · 기각으로 표시. 특히 ADR-003(FE 범위) · ADR-005(블록 선언 위치) · ADR-010(설정을 M1에 포함) · ADR-011(SCR-05에 [재개] 추가) · ADR-012(잠정 승인 기본 사용 안 함) | 2단계 이후 전부 |

## 재개 방법

1. 위 NH-1~6을 해결하고 `main`에 push 한다.
2. 새 클라우드 세션을 저장소 선택 상태로 열고 같은 시작 프롬프트를 붙여넣는다.
3. 세션은 0단계에서 `docs/spec/` · `docs/decisions.md`를 보고 1단계 완료를 확인한 뒤 2단계(킥오프)부터 진행한다.
4. 이 브랜치(`claude/dreamy-pascal-o93gqn`)의 로컬 커밋 3개는 이 세션 컨테이너에만 있다. 컨테이너가 회수되면 사라지므로, 접근 복구 직후 "푸시해줘"로 올리거나, 사라졌으면 재개 세션이 1단계를 다시 수행한다 (Notion 원본 → docs/spec 변환, 약 10분).
