import type { Migration } from '../../migrate.js';

/** 밀리초 3자리 UTC 시각 형식 (다른 표의 시각 칸과 같다). */
const TIMESTAMP_GLOB =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

/** 글자 원소만 든 1개 이상의 JSON 배열인지 (칸 이름을 받는다). */
const patternList = (column: string): string =>
  `json_valid(${column}) AND json_type(${column}) = 'array' AND json_array_length(${column}) >= 1`;

/**
 * 이어받는 실행의 쓰기 허용 범위 (TODO-02 · NFR-01 · NFR-02, M3-58 #321, ADR-147 ⑥, ADR-155). 새 표 하나와 트리거만 더한다(기존 표를
 * 다시 만들지 않는다).
 * - `run_write_scopes(run_id, allow_patterns, exclude_patterns, created_at)`: 허용 목록 축소 재개로 만든 이어받는 실행(과 그 실행을 다시
 *   이어받은 실행)의 쓰기 허용 범위. 패턴은 블록 선언의 포함 경로와 같은 문법이다(형식은 오케스트레이터 · shared 스키마가 본다). 실행마다
 *   하나(`run_id` 기본 키)
 * - 넣을 때(트리거): 그 실행이 이어받는 실행(`run_continuations`에 행이 있음)이고 막 만든 실행(승인 대기 · 워크트리 없음)이며, 허용 · 제외
 *   목록이 글자 원소 1개 이상의 배열이다. 원 실행에도 범위가 붙어 있으면 허용 목록은 원 실행과 같고 제외 목록은 원 실행의 제외 목록을 모두
 *   담아야 한다(사슬에서 넓어지는 길이 없다)
 * - 추가 전용(수정 · 삭제 거부): 실행에 붙은 값은 바뀌지 않는다
 * - 검토 대기열의 처리 결과(0028의 액션 값을 그대로 쓴다, 표를 다시 만들지 않는다):
 *   - `narrow_allowlist_resume`: 그 항목의 실행을 원 실행으로 하고 `detail.runId`를 이어받는 실행으로 하는 연결이 있고, 그 이어받는 실행에
 *     범위가 붙어 있어야 한다
 *   - `raise_limit_resume`(0030의 연결 확인 트리거는 그대로 둔다): 이어받는 실행의 범위는 원 실행의 범위와 같아야 한다(원 실행에 없으면
 *     없고, 있으면 글자까지 같은 값). 범위가 붙은 실행의 한도 상향 재개가 범위를 조용히 풀지 않고, 범위 없는 실행의 한도 상향 재개가
 *     범위를 얻지 않는다
 * 머지된 0001 ~ 0031은 고치지 않는다.
 */
export const migration: Migration = {
  version: 32,
  name: 'run_write_scopes',
  up: `
CREATE TABLE run_write_scopes (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs (id),
  allow_patterns TEXT NOT NULL CHECK (${patternList('allow_patterns')}),
  exclude_patterns TEXT NOT NULL CHECK (${patternList('exclude_patterns')}),
  created_at TEXT NOT NULL CHECK (created_at GLOB ${TIMESTAMP_GLOB})
) STRICT;

CREATE TRIGGER run_write_scopes_insert BEFORE INSERT ON run_write_scopes
WHEN NOT EXISTS (
  SELECT 1 FROM run_continuations AS c JOIN runs AS r ON r.id = c.run_id
  WHERE c.run_id = NEW.run_id
    AND r.status = 'waiting_approval' AND r.base_commit IS NULL AND r.branch IS NULL
) OR NOT (${patternList('NEW.allow_patterns')}) OR NOT (${patternList('NEW.exclude_patterns')})
  OR EXISTS (SELECT 1 FROM json_each(NEW.allow_patterns) WHERE type <> 'text')
  OR EXISTS (SELECT 1 FROM json_each(NEW.exclude_patterns) WHERE type <> 'text')
BEGIN
  SELECT RAISE(ABORT, 'run_write_scopes: 쓰기 허용 범위는 막 만든 이어받는 실행에 1개 이상의 허용 · 제외 경로로만 붙일 수 있습니다');
END;

CREATE TRIGGER run_write_scopes_inherit BEFORE INSERT ON run_write_scopes
WHEN EXISTS (
  SELECT 1 FROM run_continuations AS c JOIN run_write_scopes AS o ON o.run_id = c.origin_run_id
  WHERE c.run_id = NEW.run_id AND (
    json(o.allow_patterns) IS NOT json(NEW.allow_patterns)
    OR EXISTS (
      SELECT 1 FROM json_each(o.exclude_patterns) AS old
      WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.exclude_patterns) AS cur WHERE cur.value = old.value)
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'run_write_scopes: 원 실행에 붙은 쓰기 허용 범위를 넓힐 수 없습니다');
END;

CREATE TRIGGER run_write_scopes_no_update BEFORE UPDATE ON run_write_scopes
BEGIN
  SELECT RAISE(ABORT, 'run_write_scopes: 실행에 붙은 쓰기 허용 범위는 바꿀 수 없습니다');
END;

CREATE TRIGGER run_write_scopes_no_delete BEFORE DELETE ON run_write_scopes
BEGIN
  SELECT RAISE(ABORT, 'run_write_scopes: 실행에 붙은 쓰기 허용 범위는 지울 수 없습니다');
END;

CREATE TRIGGER review_items_resolve_narrow BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NULL AND NEW.kind = 'budget_exceeded' AND NEW.action = 'narrow_allowlist_resume'
  AND NOT EXISTS (
    SELECT 1 FROM run_continuations AS c JOIN run_write_scopes AS s ON s.run_id = c.run_id
    WHERE c.origin_run_id = NEW.run_id AND c.run_id = json_extract(NEW.detail, '$.runId')
  )
BEGIN
  SELECT RAISE(ABORT, 'review_items: 허용 목록 축소 재개 처리에는 그 항목의 실행을 이어받고 쓰기 허용 범위가 붙은 실행이 있어야 합니다');
END;

CREATE TRIGGER review_items_resolve_raise_limit_scope BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NULL AND NEW.kind = 'budget_exceeded' AND NEW.action = 'raise_limit_resume'
  AND (
    (SELECT count(*) FROM run_write_scopes WHERE run_id = NEW.run_id)
      <> (SELECT count(*) FROM run_write_scopes WHERE run_id = json_extract(NEW.detail, '$.runId'))
    OR EXISTS (
      SELECT 1 FROM run_write_scopes AS o JOIN run_write_scopes AS n
        ON n.run_id = json_extract(NEW.detail, '$.runId')
      WHERE o.run_id = NEW.run_id AND (
        json(o.allow_patterns) IS NOT json(n.allow_patterns)
        OR json(o.exclude_patterns) IS NOT json(n.exclude_patterns)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'review_items: 한도 상향 재개의 이어받는 실행은 원 실행의 쓰기 허용 범위를 그대로 이어야 합니다');
END;
`,
};
