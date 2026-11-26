import type { Migration } from '../../migrate.js';

/** 밀리초 3자리 UTC 시각 형식 (다른 표의 시각 칸과 같다). */
const TIMESTAMP_GLOB =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

/** 실행이 끝난 시각(형식이 맞을 때) 또는 지금 (등록 시각). 종료 저장을 형식 때문에 막지 않는다. */
const REGISTERED_AT = `CASE WHEN NEW.ended_at GLOB ${TIMESTAMP_GLOB} THEN NEW.ended_at
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END`;

/** 변이 기록 `id`의 규칙이 지금(가장 최근 기록 기준) '변이 생존'인지. 가장 최근 = 기록 시각 → ID 순 (0026 리포지토리와 같다). */
const STILL_SURVIVED = (resultId: string): string => `(
  SELECT latest.status FROM mutation_results AS latest
  WHERE latest.rule_id = (SELECT cause.rule_id FROM mutation_results AS cause WHERE cause.id = ${resultId})
  ORDER BY latest.recorded_at DESC, latest.id DESC LIMIT 1
) = 'survived'`;

/** 실행의 변이 보강 연결 (자동 보강 0027 · 사람이 시작한 보강 이 마이그레이션). */
const REINFORCEMENT_LINKS = (runId: string): string => `(
  SELECT mutation_result_id FROM mutation_reinforcements WHERE run_id = ${runId}
  UNION ALL
  SELECT mutation_result_id FROM review_reinforcements WHERE run_id = ${runId}
)`;

/**
 * 검토 대기열 (TODO-02 · COST-01 · JDG-04, M3-08 #53, ADR-100 B④ · A17, ADR-145). 새 표 둘과 트리거만 더한다(기존 표를 다시 만들지
 * 않는다).
 * - `review_items`: 항목 1건 = 실행 1개의 사람 판단 자리. 종류는 `budget_exceeded`(실행이 예산 초과로 끝남, 유형 무관) ·
 *   `mutant_survived`(변이 보강 실행(유형 C)이 실패로 끝났고 원인 변이 기록의 규칙이 지금도 '변이 생존', 원인 기록 ID를 가진다).
 *   **등록은 DB가 한다**: 실행의 상태가 그 종료 상태로 바뀌는 같은 문장(AFTER UPDATE 트리거, 0021의 테스트 변경 확인 행과 같은
 *   방식)이라 종료는 저장됐는데 항목이 없는 틈이 없고, 코드의 어느 종료 경로(엔진 · 실행 대기 시작 · 재개 불가)든 같다.
 *   종료 상태는 다시 바뀌지 않으므로(0016 `runs_terminal_final`) 같은 종료로 항목이 둘 생기지 않는다
 * - 열린 항목은 실행마다 많아야 하나다(부분 UNIQUE). 처리된 항목과 별개로 같은 실행에 새 항목이 생기는 것은 그 실행이 다시
 *   끝났을 때뿐이다
 * - 처리(액션 · 주체 · 사유 · 시각 · 결과)는 열림 → 처리됨 한 번만 쓴다. 주체는 사람만, 종류마다 받는 액션이 정해져 있고(CHECK),
 *   판정 격리는 사유가 필수다. 처리 결과가 실제로 있어야 한다(테스트 보강 = 그 항목의 보강 연결, 판정 격리 = 그 규칙의 '격리'
 *   판정 기록). 넣을 때는 열림이어야 하고 종류의 조건이 맞아야 한다(직접 넣는 행도). 수정 · 삭제 거부
 * - `review_reinforcements`: 사람이 시작한 테스트 보강 실행과 원인 변이 기록(항목마다 하나 · 실행마다 하나). 0027
 *   `mutation_reinforcements`(자동 보강, 변이 기록마다 하나)를 넓히지 않고 따로 둔다: 자동 보강의 "같은 기록으로 다시 만들지 않음"과
 *   원인 = 유형 A 기록 트리거가 그대로다. 잇는 실행은 사람이 시작한 유형 C이고 원인 규칙을 대상으로 해야 한다. 추가 전용
 * 머지된 0016 · 0021 · 0026 · 0027은 고치지 않는다.
 */
export const migration: Migration = {
  version: 28,
  name: 'review_queue',
  up: `
CREATE TABLE review_items (
  seq INTEGER PRIMARY KEY NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL CHECK (kind IN ('budget_exceeded', 'mutant_survived')),
  run_id TEXT NOT NULL REFERENCES runs (id),
  mutation_result_id TEXT REFERENCES mutation_results (id),
  created_at TEXT NOT NULL CHECK (created_at GLOB ${TIMESTAMP_GLOB}),
  resolved_at TEXT CHECK (resolved_at IS NULL OR resolved_at GLOB ${TIMESTAMP_GLOB}),
  action TEXT CHECK (action IS NULL OR action IN (
    'raise_limit_resume', 'narrow_allowlist_resume', 'split_rule', 'reinforce', 'quarantine'
  )),
  resolved_by TEXT CHECK (resolved_by IS NULL OR resolved_by = '{"kind":"human"}'),
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) > 0),
  detail TEXT CHECK (detail IS NULL OR (json_valid(detail) AND json_type(detail) = 'object')),
  CHECK ((kind = 'mutant_survived') = (mutation_result_id IS NOT NULL)),
  CHECK (
    (resolved_at IS NULL AND action IS NULL AND resolved_by IS NULL AND reason IS NULL AND detail IS NULL)
    OR (resolved_at IS NOT NULL AND action IS NOT NULL AND resolved_by IS NOT NULL AND detail IS NOT NULL)
  ),
  CHECK (
    action IS NULL
    OR (kind = 'budget_exceeded' AND action IN ('raise_limit_resume', 'narrow_allowlist_resume', 'split_rule'))
    OR (kind = 'mutant_survived' AND action IN ('reinforce', 'quarantine'))
  ),
  CHECK (action IS NOT 'quarantine' OR reason IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX review_items_open_run ON review_items (run_id) WHERE resolved_at IS NULL;
CREATE INDEX review_items_run ON review_items (run_id);

CREATE TABLE review_reinforcements (
  review_seq INTEGER PRIMARY KEY NOT NULL REFERENCES review_items (seq),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (id),
  mutation_result_id TEXT NOT NULL REFERENCES mutation_results (id),
  created_at TEXT NOT NULL CHECK (created_at GLOB ${TIMESTAMP_GLOB})
) STRICT;

CREATE TRIGGER review_items_insert BEFORE INSERT ON review_items
WHEN NEW.resolved_at IS NOT NULL OR NOT coalesce(CASE NEW.kind
  WHEN 'budget_exceeded' THEN EXISTS (
    SELECT 1 FROM runs WHERE id = NEW.run_id AND status = 'budget_exceeded'
  )
  WHEN 'mutant_survived' THEN EXISTS (
    SELECT 1 FROM runs AS r
    WHERE r.id = NEW.run_id AND r.status = 'failed' AND r.type = 'C'
      AND NEW.mutation_result_id IN ${REINFORCEMENT_LINKS('r.id')}
  ) AND ${STILL_SURVIVED('NEW.mutation_result_id')}
  ELSE 0 END, 0)
BEGIN
  SELECT RAISE(ABORT, 'review_items: 열린 항목만, 종류의 조건(예산 초과로 끝난 실행 · 실패한 변이 보강 실행과 아직 생존인 원인)이 맞아야 합니다');
END;

CREATE TRIGGER review_items_resolve_once BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL
  OR NEW.seq IS NOT OLD.seq OR NEW.kind IS NOT OLD.kind OR NEW.run_id IS NOT OLD.run_id
  OR NEW.mutation_result_id IS NOT OLD.mutation_result_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'review_items: 처리는 열린 항목에 한 번만 기록합니다 (항목 칸은 바꿀 수 없습니다)');
END;

CREATE TRIGGER review_items_resolve_reinforce BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NULL AND NEW.kind = 'mutant_survived' AND NEW.action = 'reinforce' AND NOT EXISTS (
  SELECT 1 FROM review_reinforcements
  WHERE review_seq = NEW.seq AND run_id = json_extract(NEW.detail, '$.runId')
)
BEGIN
  SELECT RAISE(ABORT, 'review_items: 테스트 보강 처리에는 그 항목의 보강 실행 연결이 있어야 합니다');
END;

CREATE TRIGGER review_items_resolve_quarantine BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NULL AND NEW.kind = 'mutant_survived' AND NEW.action = 'quarantine' AND NOT EXISTS (
  SELECT 1 FROM judgments AS j JOIN mutation_results AS cause ON cause.id = NEW.mutation_result_id
  WHERE j.id = json_extract(NEW.detail, '$.judgmentId') AND j.rule_id = cause.rule_id
    AND j.status = 'quarantined' AND j.quarantine_reason = NEW.reason
)
BEGIN
  SELECT RAISE(ABORT, 'review_items: 판정 격리 처리에는 그 규칙의 같은 사유 격리 판정 기록이 있어야 합니다');
END;

CREATE TRIGGER review_items_no_delete BEFORE DELETE ON review_items
BEGIN
  SELECT RAISE(ABORT, 'review_items: 검토 대기열 항목은 지울 수 없습니다');
END;

CREATE TRIGGER runs_review_budget_exceeded AFTER UPDATE OF status ON runs
WHEN NEW.status = 'budget_exceeded' AND OLD.status IS NOT 'budget_exceeded'
BEGIN
  INSERT INTO review_items (kind, run_id, mutation_result_id, created_at)
  VALUES ('budget_exceeded', NEW.id, NULL, ${REGISTERED_AT});
END;

CREATE TRIGGER runs_review_mutant_survived AFTER UPDATE OF status ON runs
WHEN NEW.status = 'failed' AND OLD.status IS NOT 'failed' AND NEW.type = 'C'
BEGIN
  INSERT INTO review_items (kind, run_id, mutation_result_id, created_at)
  SELECT 'mutant_survived', NEW.id, link.mutation_result_id, ${REGISTERED_AT}
  FROM ${REINFORCEMENT_LINKS('NEW.id')} AS link
  WHERE ${STILL_SURVIVED('link.mutation_result_id')};
END;

CREATE TRIGGER review_reinforcements_insert BEFORE INSERT ON review_reinforcements
WHEN NOT EXISTS (
  SELECT 1 FROM review_items AS item
  JOIN mutation_results AS cause ON cause.id = item.mutation_result_id
  JOIN runs AS r ON r.id = NEW.run_id
  JOIN run_target_rules AS t ON t.run_id = r.id AND t.rule_id = cause.rule_id
  WHERE item.seq = NEW.review_seq AND item.kind = 'mutant_survived' AND item.resolved_at IS NULL
    AND item.mutation_result_id = NEW.mutation_result_id
    AND r.type = 'C' AND json_extract(r.started_by, '$.kind') = 'human'
) OR EXISTS (SELECT 1 FROM mutation_reinforcements WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'review_reinforcements: 열린 변이 생존 항목의 원인 규칙을 대상으로 사람이 시작한 유형 C 실행이어야 합니다');
END;

CREATE TRIGGER review_reinforcements_no_update BEFORE UPDATE ON review_reinforcements
BEGIN
  SELECT RAISE(ABORT, 'review_reinforcements: 보강 연결은 바꿀 수 없습니다');
END;

CREATE TRIGGER review_reinforcements_no_delete BEFORE DELETE ON review_reinforcements
BEGIN
  SELECT RAISE(ABORT, 'review_reinforcements: 보강 연결은 지울 수 없습니다');
END;
`,
};
