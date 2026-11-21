import type { Migration } from '../../migrate.js';

/**
 * 확인 상태 · 승인 기록 행동 넓히기 · 기존 데이터 이행 (NFR-01, ADR-100 D2 · C1 · C2 · A1 · A2, M7-01 #213, ADR-101).
 * 1. `approval_log.action` CHECK에 사람의 확인(`confirm`) · 규칙 직접 편집(`rule_edit`, M7-03) · 계약 직접 편집
 *    (`contract_edit`, M3-10)을 한 번에 더한다. SQLite는 CHECK를 바꾸는 ALTER가 없어 표를 다시 만든다(0010과 같은 순서):
 *    새 표 → 행 복사(순번 순, 값 그대로) → 옛 트리거 · 표 삭제 → 이름 바꾸기 → 트리거 다시 만들기. 해시는 행 값에서
 *    계산하므로 해시 체인은 그대로 검증된다. 다른 표가 `approval_log`를 참조하지 않는다. 나머지 칸 · 트리거는 0003과 같다
 * 2. `confirmations`: 규범 항목(요구사항 · 규칙)마다 확인 상태 1행. 행이 없으면 미확인(기본). 확인됨은 확인한 사람 · 시각 ·
 *    근거(승인 기록 순번 또는 요구사항 자체의 작성 · 수정 기록)를 함께 갖고, 확인한 주체는 사람만 DB가 받는다.
 *    대상은 있는 요구사항 · 규칙이어야 하고(트리거), 대상 · 행은 바뀌거나 지워지지 않는다. 상태 값의 변경(확인 풀림)은
 *    M7-13이 쓴다
 * 3. 이행(A1): 이 변경 전에 사람이 OK한 것을 확인됨으로 옮긴다. 승인 기록에 새 항목을 만들지 않는다(새 사람 행동이 아님)
 *    - 요구사항: 마지막 수정 주체가 사람이고 삭제되지 않았으면 그 수정 시각, 아니면 작성 주체가 사람이면 작성 시각이
 *      근거(`requirement_record`). 에이전트가 쓰고 사람이 고치지 않은 요구사항은 미확인이다
 *    - 승인 기록 `approve` · `approve_edited`의 반영 규범(`detail.appliedRef`, 규칙 · 요구사항): 그 기록의 순번이 근거
 *      (`approval_log`). 같은 대상에 기록이 여럿이면 가장 앞 순번. 요구사항 기록으로 이미 확인됨이면 건너뛴다
 *    - 그 밖의 항목(제안 승인 없이 생긴 규칙 등)은 미확인이다
 * 머지된 0003은 고치지 않는다.
 */
export const migration: Migration = {
  version: 12,
  name: 'confirmations',
  up: `
CREATE TABLE approval_log_v12 (
  seq INTEGER PRIMARY KEY NOT NULL CHECK (seq >= 1),
  at TEXT NOT NULL CHECK (length(at) > 0),
  action TEXT NOT NULL CHECK (action IN (
    'approve', 'approve_edited', 'reject', 'run_start', 'provisional_grant',
    'confirm', 'rule_edit', 'contract_edit'
  )),
  actor TEXT NOT NULL CHECK (json_valid(actor)),
  target_ref TEXT NOT NULL CHECK (json_valid(target_ref)),
  client_id TEXT CHECK (client_id IS NULL OR length(client_id) > 0),
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
) STRICT;

INSERT INTO approval_log_v12 (seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash)
SELECT seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash
FROM approval_log ORDER BY seq;

DROP TRIGGER approval_log_no_replace;
DROP TRIGGER approval_log_no_update;
DROP TRIGGER approval_log_no_delete;
DROP TABLE approval_log;
ALTER TABLE approval_log_v12 RENAME TO approval_log;

CREATE TRIGGER approval_log_no_replace BEFORE INSERT ON approval_log
WHEN EXISTS (SELECT 1 FROM approval_log WHERE seq = NEW.seq OR hash = NEW.hash)
BEGIN
  SELECT RAISE(ABORT, 'approval_log: 승인 기록은 추가만 할 수 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER approval_log_no_update BEFORE UPDATE ON approval_log
BEGIN
  SELECT RAISE(ABORT, 'approval_log: 승인 기록은 추가만 할 수 있습니다');
END;

CREATE TRIGGER approval_log_no_delete BEFORE DELETE ON approval_log
BEGIN
  SELECT RAISE(ABORT, 'approval_log: 승인 기록은 추가만 할 수 있습니다');
END;

CREATE TABLE confirmations (
  entity TEXT NOT NULL CHECK (entity IN ('Requirement', 'Rule')),
  target_id TEXT NOT NULL CHECK (length(target_id) = 26),
  state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'confirmed')),
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR length(confirmed_at) > 0),
  confirmed_by TEXT CHECK (
    confirmed_by IS NULL OR (json_valid(confirmed_by) AND json_extract(confirmed_by, '$.kind') = 'human')
  ),
  basis TEXT CHECK (
    basis IS NULL OR (json_valid(basis) AND json_extract(basis, '$.kind') IN ('approval_log', 'requirement_record'))
  ),
  PRIMARY KEY (entity, target_id),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK ((state = 'confirmed') = (confirmed_by IS NOT NULL)),
  CHECK ((state = 'confirmed') = (basis IS NOT NULL))
) STRICT;

INSERT INTO confirmations (entity, target_id, state, confirmed_at, confirmed_by, basis)
SELECT 'Requirement', id, 'confirmed', at, '{"kind":"human"}', json_object('kind', 'requirement_record', 'at', at)
FROM (
  SELECT rowid AS rid, id,
    CASE
      WHEN deleted_at IS NULL AND json_extract(updated_by, '$.kind') = 'human' THEN updated_at
      ELSE created_at
    END AS at
  FROM requirements
  WHERE (deleted_at IS NULL AND json_extract(updated_by, '$.kind') = 'human')
    OR json_extract(author, '$.kind') = 'human'
)
ORDER BY rid;

INSERT INTO confirmations (entity, target_id, state, confirmed_at, confirmed_by, basis)
SELECT f.entity, f.target_id, 'confirmed', l.at, '{"kind":"human"}',
  json_object('kind', 'approval_log', 'seq', f.seq)
FROM (
  SELECT json_extract(detail, '$.appliedRef.entity') AS entity,
    json_extract(detail, '$.appliedRef.id') AS target_id,
    min(seq) AS seq
  FROM approval_log
  WHERE action IN ('approve', 'approve_edited') AND json_extract(actor, '$.kind') = 'human'
  GROUP BY 1, 2
) AS f
JOIN approval_log AS l ON l.seq = f.seq
WHERE (
    (f.entity = 'Rule' AND EXISTS (SELECT 1 FROM rules WHERE id = f.target_id))
    OR (f.entity = 'Requirement' AND EXISTS (SELECT 1 FROM requirements WHERE id = f.target_id))
  )
  AND NOT EXISTS (
    SELECT 1 FROM confirmations AS c WHERE c.entity = f.entity AND c.target_id = f.target_id
  )
ORDER BY f.seq;

CREATE TRIGGER confirmations_no_replace BEFORE INSERT ON confirmations
WHEN EXISTS (SELECT 1 FROM confirmations WHERE entity = NEW.entity AND target_id = NEW.target_id)
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 같은 항목의 확인 상태가 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER confirmations_target_exists BEFORE INSERT ON confirmations
WHEN (NEW.entity = 'Requirement' AND NOT EXISTS (SELECT 1 FROM requirements WHERE id = NEW.target_id))
  OR (NEW.entity = 'Rule' AND NOT EXISTS (SELECT 1 FROM rules WHERE id = NEW.target_id))
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 없는 요구사항 · 규칙의 확인 상태는 둘 수 없습니다');
END;

CREATE TRIGGER confirmations_target_immutable BEFORE UPDATE ON confirmations
WHEN NEW.entity IS NOT OLD.entity OR NEW.target_id IS NOT OLD.target_id
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 확인 상태의 대상은 바꿀 수 없습니다');
END;

CREATE TRIGGER confirmations_no_delete BEFORE DELETE ON confirmations
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 확인 상태는 지울 수 없습니다');
END;
`,
};
