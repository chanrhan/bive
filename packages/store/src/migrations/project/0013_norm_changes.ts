import type { Migration } from '../../migrate.js';

/**
 * 규범 변경 기록 (NRM-07, NFR-01, ADR-100 C2 · A2, M7-02 #214, ADR-103).
 * - `norm_changes`: 에이전트 · 오케스트레이터 행동 1건마다 1행인 추가 전용 기록. 사람 행동은 승인 기록(`approval_log`)에
 *   남으므로 주체는 에이전트 · 오케스트레이터만 받는다(CHECK). 에이전트 주체는 세션 ID와 사유가 필수다
 * - 종류(`kind`)는 뒤 이슈가 쓸 값까지 한 번에 연다(신규 · 수정 · 폐기 · 대체 · 판단 · 이의 · 확인 풀림 · 자동 시작 ·
 *   테스트 변경). SQLite는 CHECK를 바꾸는 ALTER가 없어 값을 늘리려면 표를 다시 만들어야 하므로 0012의 승인 기록 행동과
 *   같은 방식으로 미리 둔다. M7-02가 쓰는 값은 신규뿐이다
 * - 각 행은 앞 행의 해시(`prev_hash`)를 포함한 SHA-256 해시 체인이다. 계산 · 검증은 `norm-change-chain.ts`이고 해시 입력의
 *   접두가 승인 기록과 달라 두 체인의 항목은 서로 바꿔 끼울 수 없다. 체인은 이 표가 생긴 시점부터 새로 시작한다(A1)
 * - 수정 · 삭제는 트리거로 막는다. `INSERT OR REPLACE`는 `recursive_triggers`가 꺼진 연결에서 DELETE 트리거를 건너뛰므로
 *   같은 키 행이 이미 있으면 거부하는 BEFORE INSERT 트리거를 둔다 (0003 승인 기록과 같다, ADR-050)
 * - 세션 · 실행 ID는 외래 키로 묶지 않는다: 세션 기록 저장은 실패해도 세션을 막지 않으므로(ADR-066) 기록이 없는 세션일 수 있다
 * 형식 검증(ULID · 시각 · 주체 형태 · 종류별 상세)은 `@bive/shared` 스키마가 맡고, 여기서는 기본 제약만 둔다.
 */
export const migration: Migration = {
  version: 13,
  name: 'norm_changes',
  up: `
CREATE TABLE norm_changes (
  seq INTEGER PRIMARY KEY NOT NULL CHECK (seq >= 1),
  at TEXT NOT NULL CHECK (length(at) > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'created', 'updated', 'retired', 'superseded', 'judgment', 'objection',
    'unconfirmed', 'auto_start', 'test_changed'
  )),
  actor TEXT NOT NULL CHECK (
    json_valid(actor) AND json_extract(actor, '$.kind') IN ('agent', 'orchestrator')
  ),
  target_ref TEXT NOT NULL CHECK (json_valid(target_ref)),
  session_id TEXT CHECK (session_id IS NULL OR length(session_id) = 26),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) = 26),
  reason TEXT CHECK (reason IS NULL OR length(reason) > 0),
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64),
  CHECK (
    json_extract(actor, '$.kind') <> 'agent' OR (session_id IS NOT NULL AND reason IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER norm_changes_no_replace BEFORE INSERT ON norm_changes
WHEN EXISTS (SELECT 1 FROM norm_changes WHERE seq = NEW.seq OR hash = NEW.hash)
BEGIN
  SELECT RAISE(ABORT, 'norm_changes: 규범 변경 기록은 추가만 할 수 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER norm_changes_no_update BEFORE UPDATE ON norm_changes
BEGIN
  SELECT RAISE(ABORT, 'norm_changes: 규범 변경 기록은 추가만 할 수 있습니다');
END;

CREATE TRIGGER norm_changes_no_delete BEFORE DELETE ON norm_changes
BEGIN
  SELECT RAISE(ABORT, 'norm_changes: 규범 변경 기록은 추가만 할 수 있습니다');
END;
`,
};
