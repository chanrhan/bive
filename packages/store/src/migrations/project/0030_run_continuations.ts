import type { Migration } from '../../migrate.js';

/** 밀리초 3자리 UTC 시각 형식 (다른 표의 시각 칸과 같다). */
const TIMESTAMP_GLOB =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

/**
 * 이어받는 실행 (TODO-02 · COST-01 · NFR-01, M3-56 #319, ADR-147 ② ⑦, ADR-149). 새 표 하나와 트리거 · 뷰만 더한다(기존 표를 다시
 * 만들지 않는다).
 * - `run_continuations(run_id, origin_run_id, created_at)`: 예산 초과로 끝난 원 실행과 그것을 이어받는 새 실행 1쌍. 원 실행은 종료
 *   상태 그대로다(0016 `runs_terminal_final`을 풀지 않는다). 이어받는 실행은 실행마다 하나(`run_id` 기본 키), **원 실행도 하나에 한 번만
 *   이어진다**(`origin_run_id` UNIQUE): 원 실행의 예산 초과 항목은 하나뿐이고 처리는 한 번이며 종료된 실행에는 새 항목이 생기지 않으므로
 *   같은 원 실행을 두 번 잇는 길이 없다. 이어받는 실행이 다시 예산 초과로 끝나면 그 실행의 새 항목에서 다시 이어 사슬(원 → 1차 →
 *   2차)이 된다. 가지(같은 원 실행을 두 번)는 UNIQUE가 막는다
 * - 넣을 때(트리거): 원 실행이 `budget_exceeded`, 이어받는 실행은 막 만든 실행(승인 대기 · 워크트리 없음)이고 사람이 시작했으며 원
 *   실행과 유형 · 대상 규칙(순서까지)이 같고, 변이 보강 연결(0027 자동 · 0028 사람)이 없다(보강 원인은 사슬로만 닿는다). 추가 전용
 * - 기준 커밋: 이어받는 실행의 기준 커밋은 워크트리를 만들 때 정해지므로 넣을 때가 아니라 `runs.base_commit`을 쓸 때 본다(원 실행에
 *   기준 커밋이 있으면 같아야 한다. 원 실행이 워크트리를 만들기 전에 끝났으면 기준 브랜치의 그때 커밋)
 * - 이어받는 실행에는 변이 보강 연결을 더할 수 없다(두 연결 표의 넣기 트리거): 한 실행의 보강 원인이 둘이 되지 않게 한다
 * - 뷰 `run_reinforcement_causes`를 다시 만든다(0028 파일은 고치지 않는다): 보강 연결이 있는 실행과 그 실행을 이어받은 실행들
 *   (사슬을 따라, `WITH RECURSIVE`)이 원인 변이 기록에 닿는다. `link_kind`는 사슬의 뿌리 연결 종류(`auto` · `review`)다. 이 뷰를 이름으로
 *   읽는 0028의 트리거 셋(자동 등록 둘 · `review_items_insert`)과 저장소의 보강 판별은 그대로 새 뷰를 읽는다
 * - 검토 대기열의 한도 상향 재개 처리(`raise_limit_resume`)는 그 항목의 실행을 잇는 연결이 있어야 한다(처리 결과 트리거). 액션 값은 0028의
 *   CHECK에 이미 있어 표를 다시 만들지 않는다
 * 머지된 0016 · 0027 · 0028은 고치지 않는다.
 */
export const migration: Migration = {
  version: 30,
  name: 'run_continuations',
  up: `
CREATE TABLE run_continuations (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs (id),
  origin_run_id TEXT NOT NULL UNIQUE REFERENCES runs (id),
  created_at TEXT NOT NULL CHECK (created_at GLOB ${TIMESTAMP_GLOB}),
  CHECK (run_id <> origin_run_id)
) STRICT;

CREATE TRIGGER run_continuations_insert BEFORE INSERT ON run_continuations
WHEN NOT EXISTS (
  SELECT 1 FROM runs AS origin JOIN runs AS r ON r.id = NEW.run_id
  WHERE origin.id = NEW.origin_run_id AND origin.status = 'budget_exceeded'
    AND r.status = 'waiting_approval' AND r.base_commit IS NULL AND r.branch IS NULL
    AND json_extract(r.started_by, '$.kind') = 'human'
    AND r.type = origin.type
    AND (SELECT count(*) FROM run_target_rules WHERE run_id = r.id)
      = (SELECT count(*) FROM run_target_rules WHERE run_id = origin.id)
    AND NOT EXISTS (
      SELECT 1 FROM run_target_rules AS t
      WHERE t.run_id = r.id AND NOT EXISTS (
        SELECT 1 FROM run_target_rules AS o
        WHERE o.run_id = origin.id AND o.rule_id = t.rule_id AND o.position = t.position
      )
    )
) OR EXISTS (SELECT 1 FROM mutation_reinforcements WHERE run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM review_reinforcements WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'run_continuations: 예산 초과로 끝난 원 실행과 같은 유형 · 대상 규칙으로 사람이 막 시작한 실행만 이을 수 있습니다');
END;

CREATE TRIGGER run_continuations_no_update BEFORE UPDATE ON run_continuations
BEGIN
  SELECT RAISE(ABORT, 'run_continuations: 이어받는 실행의 연결은 바꿀 수 없습니다');
END;

CREATE TRIGGER run_continuations_no_delete BEFORE DELETE ON run_continuations
BEGIN
  SELECT RAISE(ABORT, 'run_continuations: 이어받는 실행의 연결은 지울 수 없습니다');
END;

CREATE TRIGGER runs_continuation_base_commit BEFORE UPDATE OF base_commit ON runs
WHEN NEW.base_commit IS NOT NULL AND EXISTS (
  SELECT 1 FROM run_continuations AS c JOIN runs AS origin ON origin.id = c.origin_run_id
  WHERE c.run_id = NEW.id AND origin.base_commit IS NOT NULL AND origin.base_commit IS NOT NEW.base_commit
)
BEGIN
  SELECT RAISE(ABORT, 'runs: 이어받는 실행의 기준 커밋은 원 실행과 같아야 합니다');
END;

CREATE TRIGGER mutation_reinforcements_continuation BEFORE INSERT ON mutation_reinforcements
WHEN EXISTS (SELECT 1 FROM run_continuations WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'mutation_reinforcements: 이어받는 실행에는 변이 보강 연결을 더할 수 없습니다');
END;

CREATE TRIGGER review_reinforcements_continuation BEFORE INSERT ON review_reinforcements
WHEN EXISTS (SELECT 1 FROM run_continuations WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'review_reinforcements: 이어받는 실행에는 변이 보강 연결을 더할 수 없습니다');
END;

DROP VIEW run_reinforcement_causes;

CREATE VIEW run_reinforcement_causes (run_id, mutation_result_id, link_kind) AS
WITH RECURSIVE chain (run_id, mutation_result_id, link_kind) AS (
  SELECT run_id, mutation_result_id, 'auto' FROM mutation_reinforcements
  UNION ALL
  SELECT run_id, mutation_result_id, 'review' FROM review_reinforcements
  UNION ALL
  SELECT c.run_id, chain.mutation_result_id, chain.link_kind
  FROM run_continuations AS c JOIN chain ON c.origin_run_id = chain.run_id
)
SELECT run_id, mutation_result_id, link_kind FROM chain;

CREATE TRIGGER review_items_resolve_raise_limit BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NULL AND NEW.kind = 'budget_exceeded' AND NEW.action = 'raise_limit_resume'
  AND NOT EXISTS (
    SELECT 1 FROM run_continuations
    WHERE origin_run_id = NEW.run_id AND run_id = json_extract(NEW.detail, '$.runId')
  )
BEGIN
  SELECT RAISE(ABORT, 'review_items: 한도 상향 재개 처리에는 그 항목의 실행을 이어받는 실행의 연결이 있어야 합니다');
END;
`,
};
