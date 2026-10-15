프로토타입 원본(docs/prototype/)이 아직 없어 모든 행의 프로토타입 파일은 '없음 (needs-human)'이며, 상태는 '신규'다.

# BIVE 프로토타입 맵

> 상태: 초안 v0.1 · 2026-10-15 · 기준 문서 화면 정의서 v0.5 (`docs/spec/screens.md`) · ADR-001 · ADR-011 · `docs/architecture.md` 7장
> 용도: 프로토타입 파일 → 화면(SCR ID) → 렌더러 모듈 대응표. 프로토타입이 도착하면(needs-human NH-5) 표 1의 '프로토타입 파일/영역'과 '상태'(신규 → 변환 · 재사용)를 채운다.
> 상태 값: `신규` (screens.md 기준 새로 작성) · `변환` (프로토타입 HTML → React) · `재사용` (토큰 · 정적 자원 그대로)
> 경로 규칙: 화면 모듈 `packages/app/src/renderer/screens/<name>/`, 공용 컴포넌트 `packages/app/src/renderer/components/<Name>/`, 토큰 `packages/app/src/renderer/styles/tokens.css`

## 1. 화면 대응표

| 화면 ID | 원본 ID | 화면 | 프로토타입 파일/영역 | 대상 모듈 | 공유 컴포넌트 | 상태 |
|---|---|---|---|---|---|---|
| SCR-01 | S-01 | 프로젝트 시작 | 없음 (needs-human) | `packages/app/src/renderer/screens/project-start` | — (사이드바 · 채팅 없는 최상위 화면) | 신규 |
| SCR-02 | P-01 | 요구사항 | 없음 (needs-human) | `packages/app/src/renderer/screens/requirements` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 카드 2줄 · 상태 배지 · 생성 주체 · 잠정 표시 · 접힘 상세 | 신규 |
| SCR-03 | P-02 | 규칙 | 없음 (needs-human) | `packages/app/src/renderer/screens/rules` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 카드 2줄 · 상태 배지 · 생성 주체 · 잠정 표시 · 접힘 상세 · 코드 열기 링크 | 신규 |
| SCR-04 | P-03 | 계약 | 없음 (needs-human) | `packages/app/src/renderer/screens/contracts` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 카드 2줄 · 상태 배지 · 생성 주체 | 신규 |
| SCR-05 | P-04 | 검증 | 없음 (needs-human) | `packages/app/src/renderer/screens/verification` | 사이드바 · 오른쪽 채팅 · 지표 카드 · 목록 · 상태 배지 · 파이프라인 스테퍼 | 신규 |
| SCR-06 | P-05 | 규범 상세 | 없음 (needs-human) | `packages/app/src/renderer/screens/norm-detail` (SCR-02~04 상세 영역으로 삽입) | 중앙 2단(상세 영역) · 상태 배지 · 생성 주체 · 접힘 상세 · 코드 열기 링크 | 신규 |
| SCR-07 | P-06 | 추적성 맵 | 없음 (needs-human) | `packages/app/src/renderer/screens/traceability-map` | 사이드바 · 오른쪽 채팅 · 캔버스 · 상태 배지 | 신규 |
| SCR-08 | D-01 | 아키텍처 | 없음 (needs-human) | `packages/app/src/renderer/screens/architecture` | 사이드바 · 오른쪽 채팅 · 지표 카드 · 접힘 상세 · 코드 열기 링크 | 신규 |
| SCR-09 | D-01a | L0 시스템 | 없음 (needs-human) | `packages/app/src/renderer/screens/l0-system` | 사이드바 · 오른쪽 채팅 · 캔버스 · 빠른 강조 칩 | 신규 |
| SCR-10 | D-01b | L1 블록 | 없음 (needs-human) | `packages/app/src/renderer/screens/l1-blocks` | 사이드바 · 오른쪽 채팅 · 캔버스 · 빠른 강조 칩 | 신규 |
| SCR-11 | D-02 | 흐름도 | 없음 (needs-human) | `packages/app/src/renderer/screens/flows` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 코드 열기 링크 | 신규 |
| SCR-12 | D-03 | ERD | 없음 (needs-human) | `packages/app/src/renderer/screens/erd` | 사이드바 · 오른쪽 채팅 · 캔버스 · 빠른 강조 칩 | 신규 |
| SCR-13 | D-04 | 의존성 | 없음 (needs-human) | `packages/app/src/renderer/screens/dependencies` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 카드 2줄 | 신규 |
| SCR-14 | D-05 | 변경 로그 | 없음 (needs-human) | `packages/app/src/renderer/screens/change-log` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 카드 2줄 · 생성 주체 · 코드 열기 링크 | 신규 |
| SCR-15 | D-06 | ADR | 없음 (needs-human) | `packages/app/src/renderer/screens/adr` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 카드 2줄 · 생성 주체 | 신규 |
| SCR-16 | R-01 | 실행 추적 | 없음 (needs-human) | `packages/app/src/renderer/screens/run-trace` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 목록 · 필터 칩 · 카드 2줄 · 상태 배지 · 파이프라인 스테퍼 · 생성 주체 | 신규 |
| SCR-17 | T-01 | 승인 대기 | 없음 (needs-human) | `packages/app/src/renderer/screens/todo/approvals` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 할 일 탭 · 목록 · 필터 칩 · 카드 2줄 · 생성 주체 · 잠정 표시 · 떠 있는 액션 버튼 | 신규 |
| SCR-18 | T-02 | 검토 대기열 | 없음 (needs-human) | `packages/app/src/renderer/screens/todo/review-queue` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 할 일 탭 · 목록 · 필터 칩 · 카드 2줄 | 신규 |
| SCR-19 | T-03 | 계약 변경 승인 | 없음 (needs-human) | `packages/app/src/renderer/screens/todo/contract-changes` | 사이드바 · 중앙 2단 · 오른쪽 채팅 · 할 일 탭 · 목록 · 필터 칩 · 카드 2줄 | 신규 |
| SCR-20 | X-01 | 에이전트 채팅 | 없음 (needs-human) | `packages/app/src/renderer/screens/agent-chat` (레이아웃 오른쪽 고정 영역) | 오른쪽 채팅 · 참조 칩 · 생성 주체 | 신규 |
| SCR-21 | X-02 | 설정 | 없음 (needs-human) | `packages/app/src/renderer/screens/settings-modal` | 모달 | 신규 |

- SCR-05 파이프라인 영역의 '중단' 표시 · [재개] 버튼은 ADR-011로 추가된 요소. 프로토타입에 없어도 신규로 유지
- SCR-06은 별도 라우트가 아니라 SCR-02 · 03 · 04의 상세 영역 (screens.md SCR-06 위치)

## 2. 공용 컴포넌트 후보

| 컴포넌트 | 쓰이는 화면 | 출처 (screens.md 절) | 상태 (가져야 하는 것) |
|---|---|---|---|
| `Sidebar` (프로젝트명 · 할 일 배지 · 기획/설계/실행 메뉴 · 오케스트레이터 연결 상태 · 설정 톱니) | SCR-02~19 | 1.2 화면 구조 · 할 일 공통 · SCR-21 위치 | 기본 · 로딩 (프로젝트 조회 중) · 에러 (오케스트레이터 연결 끊김) |
| `TwoPaneLayout` (중앙 목록 + 상세) | SCR-02 · 03 · 04 · 11 · 13 · 14 · 15 · 16 · 17 · 18 · 19 | 1.2 · SCR-06 위치 | 기본 · 빈 (선택 항목 없음) |
| `ChatPanel` (오른쪽 고정 360px, 1100px 미만 44px 띠) | 사이드바가 있는 전 화면 · SCR-20 | 1.2 · 1.5 → SCR-20 | 기본 · 빈 (참조 없음 → 전송 비활성, ADR-004) · 로딩 (답변 대기) · 에러 (전송 실패) |
| `Modal` (820 × 600, 바깥 클릭 · Esc · × 닫기) | SCR-21 | 1.2 · SCR-21 | 기본 · 로딩 (설정 조회) · 에러 (저장 실패 · 필수값 누락) |
| `ListView` (검색 `/` · 필터 칩 · [문제만] 토글 · 결과 줄 "n개 중 m개 · 초기화" · 문제 우선 정렬) | SCR-02 · 03 · 04 · 05 · 11 · 13 · 14 · 15 · 16 · 17 · 18 · 19 | 1.4 목록 | 기본 · 빈 (항목 0건 / 필터 결과 0건 구분) · 로딩 · 에러 |
| `FilterChips` (기준 안 OR · 기준끼리 AND · 개수 · 0건 비활성 · 값 표시 · × 해제, 목록별 상태 유지) | ListView 사용 화면 전부 | 1.4 목록 | 기본 · 빈 (0건 칩 비활성) |
| `Card2Line` (1줄 제목 · 2줄 ID · 예외 · 시각, 말줄임 + 툴팁) | SCR-02 · 03 · 04 · 13 · 14 · 15 · 16 · 17 · 18 · 19 | 1.4 카드 | 기본 (정상 = 예외 비어 있음) · 에러 표시 (예외 글자) |
| `StatusBadge` (판정 5종 · 변이 3종, 정상은 흐린 점 · 예외만 글자 · 색) | SCR-02 · 03 · 04 · 05 · 06 · 07 · 16 | 1.4 상태 배지 | 기본 (흐린 점) · 예외 (글자 · 색) |
| `AuthorMark` (사람 · 에이전트, 목록 아이콘 · 상세 "~ 역할명") | SCR-02 · 03 · 04 · 06 · 14 · 15 · 16 · 17 · 20 | 1.4 생성 주체 · ADR-008 | 기본 |
| `ProvisionalMark` (잠정 승인 별도 표시) | SCR-02 · 03 · 05 · 17 | 1.4 잠정 표시 · ADR-012 | 기본 (정책 off이면 미표시) |
| `RefChip` (C 키 · [채팅에 참조]로 추가, × 제거) | SCR-20 · 참조 가능한 전 화면 | 1.4 질문 · 지시 · SCR-20 | 기본 · 빈 |
| `CodeOpenLink` (`file:line` → IDE, 사유 3종 선택 후 기록) | SCR-03 · 06 · 08 · 11 · 14 | 1.4 코드 열기 · MET-01 | 기본 · 로딩 (IDE 호출 중) · 에러 (IDE 열기 실패) |
| `Canvas` (이동 · 확대 · 맞춤, 왼쪽 위 찾기, 빠른 강조 칩, 오른쪽 아래 정보 카드, 노드 숨김 없음) | SCR-07 · 09 · 10 · 12 | 1.4 캔버스 | 기본 · 빈 (노드 0개) · 로딩 (파서 결과 대기) · 에러 (파서 실패) |
| `HighlightChips` (캔버스 빠른 강조 칩) | SCR-09 · 10 · 12 | 1.4 캔버스 · SCR-09 · 10 · 12 | 기본 · 빈 (해당 0건 비활성) |
| `CollapsibleDetail` (변경 이력 · 테스트 출력 기본 접힘, 판정 실패 시 자동 펼침) | SCR-02 · 03 · 06 · 08 | 1.4 상세 접힘 | 기본 (접힘) · 에러 (실패 시 펼침) |
| `MetricCard` (이름 · 값 · 단위, 정의는 툴팁, 누르면 필터 목록 이동 · 펼침) | SCR-05 · 08 | SCR-05 지표 카드 · SCR-08 카드 | 기본 · 빈 (수집 전 · 기준 부족 → 미표시, COST-02 '없음') · 로딩 · 에러 |
| `PipelineStepper` (가로 점 · 연결선, 칸 최소 52px, 이름 최대 2줄, 지나온 초록 · 미도달 회색 · 생략 흐림) | SCR-05 · 16 | SCR-16 파이프라인 · SCR-05 파이프라인 · ADR-011 | 기본 · 빈 (실행 없음) · 로딩 (진행 중 현재 단계) · 에러 (실패 · 예산 초과 · 중단 + [재개]) |
| `TodoTabs` (승인 대기 · 검토 대기열 · 계약 변경 승인, 마지막 탭 기억) | SCR-17 · 18 · 19 | 할 일 공통 | 기본 |
| `FloatingActions` (오른쪽 아래 [거절] [수정] [승인], 거절 사유 필수) | SCR-17 · 19 | SCR-17 액션 버튼 · NRM-04 | 기본 · 로딩 (처리 중) · 에러 (사유 누락 · 상태 충돌) |

- 빈 · 로딩 · 에러 상태 대부분은 screens.md에 "문서에 정의 없음". 위 '상태' 열은 화면 테스트(architecture.md 8장)가 검사할 최소 집합이며, 문구는 화면 1.1 원칙(명사형 · 짧은 문구)으로 신규 작성

## 3. 디자인 토큰

- 구분: `근거 있음` = screens.md · ADR에 값 또는 규칙이 있음 / `제안` = 근거 없음, 프로토타입 도착 시 교체
- 다크 모드 우선 (1.1). 라이트 모드는 후순위로 `[data-theme="light"]`에서 같은 토큰 이름을 재정의

| 토큰 | 값 | 근거 | 구분 |
|---|---|---|---|
| `--color-scheme` | `dark` | 1.1 테마 (다크 모드 우선) | 근거 있음 |
| `--color-bg` | `#0e1424` (짙은 남색) | 1.1 테마 (짙은 남색 계열). hex는 근거 없음 | 제안 |
| `--color-surface` | `#151c30` | — | 제안 |
| `--color-surface-raised` | `#1c2540` (모달 · 카드 펼침) | — | 제안 |
| `--color-border` | `#2a3452` | — | 제안 |
| `--color-text` | `#e6e9f2` | — | 제안 |
| `--color-text-muted` | `#8a93ad` | — | 제안 |
| `--color-accent` | `#4c8dff` (선택 · 캔버스 찾기 파란 테두리) | 1.4 캔버스 (맞는 노드 파란 테두리). hex는 근거 없음 | 제안 |
| `--color-danger` | `#f0616d` (실패 · 선언 외 의존 · 상한 초과) | SCR-10 (선언 외 의존 빨강) · SCR-17 (상한 초과 빨강). hex는 근거 없음 | 제안 |
| `--color-warning` | `#e5b454` (재검증 필요 · 경고) | SCR-09 · SCR-12 (경고). hex는 근거 없음 | 제안 |
| `--color-success` | `#3fb68b` (스테퍼 지나온 구간) | SCR-16 (지나온 구간 초록). hex는 근거 없음 | 제안 |
| `--color-pending` | `#4a536b` (스테퍼 미도달) | SCR-16 (미도달 회색). hex는 근거 없음 | 제안 |
| `--status-normal` | 글자 없이 흐린 점 (통과 · 변이 검증됨 · 변이 미검증 · 승인 · 처리됨) | 1.4 상태 배지 | 근거 있음 |
| `--status-normal-dot-color` | `color-mix(in srgb, var(--color-text-muted) 50%, transparent)` | 1.4 (흐린 점). 값은 근거 없음 | 제안 |
| `--status-exception` | 예외만 글자 + 색 (실패 · 미판정 · 격리 · 재검증 필요 · 변이 생존) | 1.1 스타일 (예외만 강조) · 1.4 상태 배지 | 근거 있음 |
| `--opacity-dimmed` | `0.4` (캔버스 비매칭 노드 · 스테퍼 생략 단계) | 1.4 캔버스 (나머지 흐림) · SCR-16 (생략 흐림). 값은 근거 없음 | 제안 |
| `--icon-set` | 표준 아이콘 세트 1종 (예: lucide), 이모지 금지 | 1.1 아이콘 · NFR-09. 세트 이름은 근거 없음 | 근거 있음 (세트 선택은 제안) |
| `--icon-color-inline` | `currentColor` (글자와 같은 색) | 1.1 아이콘 | 근거 있음 |
| `--icon-size-inline` | `0.875em` (글자보다 약간 작게) | 1.1 아이콘. 비율 값은 근거 없음 | 근거 있음 (비율은 제안) |
| `--chat-width` | `360px` | 1.5 → SCR-20 위치 | 근거 있음 |
| `--chat-collapsed-width` | `44px` | 1.5 → SCR-20 (44px 띠) | 근거 있음 |
| `--bp-chat-collapse` | `1100px` (미만이면 채팅 접힘, 미디어 쿼리 상수) | 1.5 → SCR-20 (창 폭 1100px 미만) | 근거 있음 |
| `--modal-width` | `820px` | 7장 → SCR-21 위치 (820 × 600) | 근거 있음 |
| `--modal-height` | `600px` | 7장 → SCR-21 위치 | 근거 있음 |
| `--stepper-cell-min` | `52px` | R-01 → SCR-16 파이프라인 (칸 최소 52px) | 근거 있음 |
| `--stepper-label-lines` | `2` (이름 최대 2줄, 좁으면 가로 스크롤) | R-01 → SCR-16 파이프라인 | 근거 있음 |
| `--card-lines` | `2` (1줄 제목 · 2줄 ID · 예외 · 시각) | 1.4 카드 | 근거 있음 |
| `--chat-instruct-border` | `var(--color-accent)` (지시 모드 입력창 테두리 강조) | SCR-20 (지시 모드 테두리 강조). 색은 근거 없음 | 제안 |
| `--font-sans` | `"Pretendard", "Inter", system-ui, sans-serif` | — | 제안 |
| `--font-mono` | `"JetBrains Mono", ui-monospace, monospace` (`file:line` 링크 · 실행기 출력) | — | 제안 |
| `--font-size-1` ~ `--font-size-4` | `12px` · `13px` · `14px` · `16px` | — | 제안 |
| `--line-height` | `1.5` | — | 제안 |
| `--space-1` ~ `--space-6` | `4px` · `8px` · `12px` · `16px` · `24px` · `32px` | — | 제안 |
| `--radius-1` · `--radius-2` | `4px` · `8px` | — | 제안 |
| `--sidebar-width` | `232px` | — | 제안 |
| `--list-pane-width` | `400px` (중앙 2단의 목록 폭) | — | 제안 |
| `--focus-ring` | `0 0 0 2px var(--color-accent)` | — | 제안 |

## 4. 프로토타입 파일명 → SCR ID 매핑 제안

- 파일이 오면 이 이름으로 `docs/prototype/`에 두거나, 다른 이름이면 이 표의 '실제 파일' 열을 채운다
- 한 파일에 여러 화면이 있으면 '실제 파일'에 `파일명#영역 id`로 적는다

| 제안 파일명 | SCR ID | 원본 ID | 화면 | 실제 파일 |
|---|---|---|---|---|
| `scr-01-project-start.html` | SCR-01 | S-01 | 프로젝트 시작 | 없음 (needs-human) |
| `scr-02-requirements.html` | SCR-02 | P-01 | 요구사항 | 없음 (needs-human) |
| `scr-03-rules.html` | SCR-03 | P-02 | 규칙 | 없음 (needs-human) |
| `scr-04-contracts.html` | SCR-04 | P-03 | 계약 | 없음 (needs-human) |
| `scr-05-verification.html` | SCR-05 | P-04 | 검증 | 없음 (needs-human) |
| `scr-06-norm-detail.html` | SCR-06 | P-05 | 규범 상세 | 없음 (needs-human) |
| `scr-07-traceability-map.html` | SCR-07 | P-06 | 추적성 맵 | 없음 (needs-human) |
| `scr-08-architecture.html` | SCR-08 | D-01 | 아키텍처 | 없음 (needs-human) |
| `scr-09-l0-system.html` | SCR-09 | D-01a | L0 시스템 | 없음 (needs-human) |
| `scr-10-l1-blocks.html` | SCR-10 | D-01b | L1 블록 | 없음 (needs-human) |
| `scr-11-flows.html` | SCR-11 | D-02 | 흐름도 | 없음 (needs-human) |
| `scr-12-erd.html` | SCR-12 | D-03 | ERD | 없음 (needs-human) |
| `scr-13-dependencies.html` | SCR-13 | D-04 | 의존성 | 없음 (needs-human) |
| `scr-14-change-log.html` | SCR-14 | D-05 | 변경 로그 | 없음 (needs-human) |
| `scr-15-adr.html` | SCR-15 | D-06 | ADR | 없음 (needs-human) |
| `scr-16-run-trace.html` | SCR-16 | R-01 | 실행 추적 | 없음 (needs-human) |
| `scr-17-approvals.html` | SCR-17 | T-01 | 승인 대기 | 없음 (needs-human) |
| `scr-18-review-queue.html` | SCR-18 | T-02 | 검토 대기열 | 없음 (needs-human) |
| `scr-19-contract-changes.html` | SCR-19 | T-03 | 계약 변경 승인 | 없음 (needs-human) |
| `scr-20-agent-chat.html` | SCR-20 | X-01 | 에이전트 채팅 | 없음 (needs-human) |
| `scr-21-settings-modal.html` | SCR-21 | X-02 | 설정 | 없음 (needs-human) |

- 화면 테스트의 프로토타입 대조(architecture.md 8장)는 이 표의 '실제 파일'을 읽어 `artifacts/screens/<SCR-ID>/prototype.png`를 만든다
