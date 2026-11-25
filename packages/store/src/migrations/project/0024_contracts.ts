import type { Migration } from '../../migrate.js';

/**
 * 계약 등록 (NRM-03, ADR-019 · ADR-100 D2 · C2 · K1, M3-04 #49, ADR-129).
 * 1. `contracts`: 계약 1건 = 원본 파일 1개(등록 단위, 같은 파일은 한 번만). 내용은 저장하지 않고 등록 때 기준 브랜치 커밋의 그 파일
 *    내용 해시(SHA-256)와 그 커밋을 남긴다. 부모 요구사항 0~1개(연결 단위 = 파일, ADR-019). 지금은 고치거나 지우지 않는다(변경 반영은
 *    M3-10이 새 마이그레이션으로 연다). 덮어쓰기 · 수정 · 삭제 · 삭제된 부모는 트리거가 거부한다
 * 2. `rules`의 계약 검사 규칙: `contract_id`가 있는 규칙은 있는 계약 1개마다 하나뿐이고, 내장(`builtin = 1`) · 부모 요구사항 없음 ·
 *    검사 종류 `["contract"]`일 때만 받는다(트리거 하나. `rules` 표는 다시 만들지 않는다)
 * 3. `confirmations`: 엔터티 CHECK에 계약, 근거 CHECK에 계약의 작성 기록(`contract_record`, 계약에만)을 더한다. SQLite는 CHECK를
 *    바꾸는 ALTER가 없어 0012 · 0023과 같은 순서로 표를 다시 만든다: 새 표 → 행 복사(rowid 순, 값 그대로) → 옛 트리거 · 표 삭제 →
 *    이름 바꾸기 → 트리거 다시 만들기. 칸 순서 · 이름 · 나머지 CHECK는 0012와 같다. 다시 만드는 트리거는 0012의 넷(대상이 있어야
 *    하는 트리거는 계약을 더해 바뀌고, 셋은 글자까지 같다)과 0019의 `confirmations_release_recorded`(글자까지 같다)다.
 *    0019의 `norm_changes_unconfirmed`(다른 표의 트리거)는 본문이 이 표를 읽어서, 표를 지운 채로는 이름 바꾸기가 거부된다
 *    (SQLite가 모든 트리거 본문을 다시 해석한다). 그래서 먼저 지우고 끝에 글자까지 같게 다시 만든다. 이 표를 외래 키로 가리키는
 *    표는 없다. 승인 기록 · 규범 변경 기록은 건드리지 않으므로 두 해시 체인은 그대로다
 * 머지된 0003 · 0012 · 0019는 고치지 않는다.
 */
export const migration: Migration = {
  version: 24,
  name: 'contracts',
  up: `
CREATE TABLE contracts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  display_id TEXT NOT NULL UNIQUE CHECK (display_id GLOB 'CON-[0-9][0-9][0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN (
    'openapi', 'db-schema', 'asyncapi', 'external-api', 'cache', 'json-schema'
  )),
  source_file TEXT NOT NULL UNIQUE CHECK (length(source_file) BETWEEN 1 AND 1024),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  source_commit TEXT NOT NULL CHECK (length(source_commit) IN (40, 64)),
  parent_requirement_id TEXT REFERENCES requirements (id),
  author TEXT NOT NULL CHECK (
    json_valid(author) AND json_extract(author, '$.kind') IN ('human', 'agent')
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT;

CREATE TRIGGER contracts_no_replace BEFORE INSERT ON contracts
WHEN EXISTS (
  SELECT 1 FROM contracts
  WHERE id = NEW.id OR display_id = NEW.display_id OR source_file = NEW.source_file
)
BEGIN
  SELECT RAISE(ABORT, 'contracts: 같은 계약 · 같은 파일의 계약이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER contracts_parent_live BEFORE INSERT ON contracts
WHEN NEW.parent_requirement_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM requirements WHERE id = NEW.parent_requirement_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'contracts: 부모 요구사항이 없거나 삭제됐습니다');
END;

CREATE TRIGGER contracts_no_update BEFORE UPDATE ON contracts
BEGIN
  SELECT RAISE(ABORT, 'contracts: 계약은 바꿀 수 없습니다');
END;

CREATE TRIGGER contracts_no_delete BEFORE DELETE ON contracts
BEGIN
  SELECT RAISE(ABORT, 'contracts: 계약은 지울 수 없습니다');
END;

CREATE TRIGGER rules_contract_rule BEFORE INSERT ON rules
WHEN NEW.contract_id IS NOT NULL AND NOT coalesce((
  NEW.builtin = 1
  AND NEW.parent_requirement_id IS NULL
  AND NEW.check_kinds = '["contract"]'
  AND EXISTS (SELECT 1 FROM contracts WHERE id = NEW.contract_id)
  AND NOT EXISTS (SELECT 1 FROM rules WHERE contract_id = NEW.contract_id)
), 0)
BEGIN
  SELECT RAISE(ABORT, 'rules: 계약 검사 규칙은 있는 계약마다 하나이고 내장 · 부모 없음 · 검사 종류 계약뿐입니다');
END;

DROP TRIGGER norm_changes_unconfirmed;

CREATE TABLE confirmations_v24 (
  entity TEXT NOT NULL CHECK (entity IN ('Requirement', 'Rule', 'Contract')),
  target_id TEXT NOT NULL CHECK (length(target_id) = 26),
  state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'confirmed')),
  confirmed_at TEXT CHECK (confirmed_at IS NULL OR length(confirmed_at) > 0),
  confirmed_by TEXT CHECK (
    confirmed_by IS NULL OR (json_valid(confirmed_by) AND json_extract(confirmed_by, '$.kind') = 'human')
  ),
  basis TEXT CHECK (
    basis IS NULL OR (
      json_valid(basis)
      AND json_extract(basis, '$.kind') IN ('approval_log', 'requirement_record', 'contract_record')
    )
  ),
  PRIMARY KEY (entity, target_id),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK ((state = 'confirmed') = (confirmed_by IS NOT NULL)),
  CHECK ((state = 'confirmed') = (basis IS NOT NULL)),
  CHECK (basis IS NULL OR json_extract(basis, '$.kind') <> 'contract_record' OR entity = 'Contract')
) STRICT;

INSERT INTO confirmations_v24 (entity, target_id, state, confirmed_at, confirmed_by, basis)
SELECT entity, target_id, state, confirmed_at, confirmed_by, basis
FROM confirmations ORDER BY rowid;

DROP TRIGGER confirmations_no_replace;
DROP TRIGGER confirmations_target_exists;
DROP TRIGGER confirmations_target_immutable;
DROP TRIGGER confirmations_no_delete;
DROP TRIGGER confirmations_release_recorded;
DROP TABLE confirmations;
ALTER TABLE confirmations_v24 RENAME TO confirmations;

CREATE TRIGGER confirmations_no_replace BEFORE INSERT ON confirmations
WHEN EXISTS (SELECT 1 FROM confirmations WHERE entity = NEW.entity AND target_id = NEW.target_id)
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 같은 항목의 확인 상태가 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER confirmations_target_exists BEFORE INSERT ON confirmations
WHEN (NEW.entity = 'Requirement' AND NOT EXISTS (SELECT 1 FROM requirements WHERE id = NEW.target_id))
  OR (NEW.entity = 'Rule' AND NOT EXISTS (SELECT 1 FROM rules WHERE id = NEW.target_id))
  OR (NEW.entity = 'Contract' AND NOT EXISTS (SELECT 1 FROM contracts WHERE id = NEW.target_id))
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 없는 요구사항 · 규칙 · 계약의 확인 상태는 둘 수 없습니다');
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

CREATE TRIGGER confirmations_release_recorded BEFORE UPDATE ON confirmations
WHEN OLD.state = 'confirmed' AND NEW.state = 'unconfirmed' AND NOT coalesce((
  SELECT last.kind = 'unconfirmed'
    AND json_extract(last.target_ref, '$.entity') = OLD.entity
    AND json_extract(last.target_ref, '$.id') = OLD.target_id
    AND json_extract(last.detail, '$.unconfirm.previous.at') = OLD.confirmed_at
    AND json_extract(last.detail, '$.unconfirm.previous.basis.kind') = json_extract(OLD.basis, '$.kind')
    AND json_extract(last.detail, '$.unconfirm.previous.basis.seq') IS json_extract(OLD.basis, '$.seq')
    AND json_extract(last.detail, '$.unconfirm.previous.basis.at') IS json_extract(OLD.basis, '$.at')
  FROM norm_changes AS last
  ORDER BY last.seq DESC
  LIMIT 1
), 0)
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 확인 풀림 기록 없이 확인을 풀 수 없습니다');
END;

CREATE TRIGGER norm_changes_unconfirmed BEFORE INSERT ON norm_changes
WHEN NEW.kind = 'unconfirmed' AND NOT coalesce((
  json_valid(NEW.actor) AND json_valid(NEW.target_ref) AND json_valid(NEW.detail)
  AND json_type(NEW.actor) = 'object'
  AND json_extract(NEW.actor, '$.kind') = 'orchestrator'
  AND json_extract(NEW.target_ref, '$.entity') = 'Rule'
  AND json_type(NEW.detail, '$.unconfirm.causeSeq') = 'integer'
  AND EXISTS (
    SELECT 1 FROM norm_changes AS cause
    WHERE cause.seq = json_extract(NEW.detail, '$.unconfirm.causeSeq')
      AND cause.kind IN ('retired', 'superseded')
      AND json_extract(cause.target_ref, '$.entity') = 'Rule'
      AND json_extract(cause.target_ref, '$.id') = json_extract(NEW.target_ref, '$.id')
  )
  AND EXISTS (
    SELECT 1 FROM confirmations AS c
    WHERE c.entity = 'Rule' AND c.target_id = json_extract(NEW.target_ref, '$.id')
      AND c.state = 'confirmed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM norm_changes AS other
    WHERE other.kind = 'unconfirmed'
      AND json_extract(other.detail, '$.unconfirm.causeSeq') = json_extract(NEW.detail, '$.unconfirm.causeSeq')
  )
), 0)
BEGIN
  SELECT RAISE(ABORT, 'norm_changes: 확인 풀림은 오케스트레이터가 확인됨 규칙의 폐기 · 대체 기록 1건마다 한 번만 남깁니다');
END;
`,
};
