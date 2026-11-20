import type { Migration } from '../../migrate.js';

/**
 * 빈 도구 이름의 호출도 기록한다 (NFR-02 "모든 도구 호출 기록", M2-11 #190 · ADR-094).
 * - 에이전트가 이름 `""`로 도구를 부르면 실행기는 `denied`(`unknown_tool`)로 거부하지만, 0006의 `tool_calls.name`
 *   CHECK(`length(name) > 0`)가 그 행을 받지 않아 기록이 사라졌다. 값을 지어내지 않고(`"(없음)"` 등으로 바꾸지 않음) 받은
 *   그대로 남기도록 이 CHECK만 푼다. 나머지 칸 · 색인 · 트리거는 0006과 같다
 * - SQLite는 CHECK를 바꾸는 ALTER가 없어 표를 다시 만든다: 새 표 → 행 복사(순서 · 값 그대로) → 옛 트리거 · 표 삭제 →
 *   이름 바꾸기 → 색인 · 트리거 다시 만들기. 다른 표가 `tool_calls`를 참조하지 않으므로 외래 키 검사에 걸리지 않는다
 *   (러너가 이번 마이그레이션 전체를 트랜잭션 하나로 묶는다)
 * 머지된 0006은 고치지 않는다.
 */
export const migration: Migration = {
  version: 10,
  name: 'tool_call_empty_name',
  up: `
CREATE TABLE tool_calls_v10 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  run_id TEXT REFERENCES runs (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  at TEXT NOT NULL CHECK (length(at) > 0),
  role TEXT NOT NULL CHECK (length(role) > 0),
  name TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'denied', 'error')),
  reason TEXT CHECK (reason IS NULL OR length(reason) > 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  UNIQUE (session_id, seq)
) STRICT;

INSERT INTO tool_calls_v10 (id, run_id, session_id, seq, at, role, name, args_summary, status, reason, duration_ms)
SELECT id, run_id, session_id, seq, at, role, name, args_summary, status, reason, duration_ms
FROM tool_calls ORDER BY rowid;

DROP TRIGGER tool_calls_no_replace;
DROP TRIGGER tool_calls_no_update;
DROP TRIGGER tool_calls_no_delete;
DROP TABLE tool_calls;
ALTER TABLE tool_calls_v10 RENAME TO tool_calls;

CREATE INDEX tool_calls_run ON tool_calls (run_id);
CREATE INDEX tool_calls_session ON tool_calls (session_id);

CREATE TRIGGER tool_calls_no_replace BEFORE INSERT ON tool_calls
WHEN EXISTS (
  SELECT 1 FROM tool_calls WHERE id = NEW.id OR (session_id = NEW.session_id AND seq = NEW.seq)
)
BEGIN
  SELECT RAISE(ABORT, 'tool_calls: 같은 도구 호출 기록이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER tool_calls_no_update BEFORE UPDATE ON tool_calls
BEGIN
  SELECT RAISE(ABORT, 'tool_calls: 도구 호출 기록은 바꿀 수 없습니다');
END;

CREATE TRIGGER tool_calls_no_delete BEFORE DELETE ON tool_calls
BEGIN
  SELECT RAISE(ABORT, 'tool_calls: 도구 호출 기록은 지울 수 없습니다');
END;
`,
};
