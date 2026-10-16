import type { Migration } from '../../migrate.js';

/**
 * 규칙 · 제안 · 승인 기록 (NRM-02, NRM-04, TODO-01, NFR-01, architecture.md 3장, ADR-027 · ADR-050).
 * - `rules`: 승인된 규칙만 둔다(승인 전 제안은 `proposals`에만 있다, NRM-04). 부모 요구사항이 삭제되면
 *   `parent_requirement_id`를 비우고 `parent_detached_at`에 그 시각을 남긴다 (추적성 결함 표시는 M3-11).
 *   위험도 · 대상 블록은 M2 이후 채운다. 판정 · 변이 상태는 파생 값이라 열이 없다
 * - `proposals`: 에이전트 제안. 본문 · diff · 처리 기록은 JSON. 본문은 등록 뒤 바뀌지 않고(수정 후 승인의
 *   수정 본문은 처리 기록에 남는다), 처리된 제안의 상태 · 처리 기록은 다시 바뀌지 않는다(트리거로 막는다).
 *   잠정 승인(`provisional`)은 상태 값만 예약한다 (ADR-012, M3-17)
 * - `approval_log`: 추가 전용 승인 기록. 수정 · 삭제는 트리거로 막는다. 각 행은 앞 행의 해시(`prev_hash`)를 포함한
 *   SHA-256 해시 체인이다 (계산 · 검증은 `approval-chain.ts`)
 * - `INSERT OR REPLACE`(`REPLACE INTO`)는 충돌 행을 지우고 새로 넣는데, `recursive_triggers`가 꺼진 연결에서는
 *   DELETE · UPDATE 트리거가 돌지 않는다. 연결 설정에 기대지 않도록 두 테이블에 같은 키 행이 이미 있으면 거부하는
 *   BEFORE INSERT 트리거를 둔다 (ADR-050)
 * 형식 검증(ULID · 시각 · 표시 ID · 주체 형태)은 `@bive/shared` 스키마가 맡고, 여기서는 기본 제약만 둔다.
 */
export const migration: Migration = {
  version: 3,
  name: 'rules_proposals_approval_log',
  up: `
CREATE TABLE rules (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  display_id TEXT NOT NULL UNIQUE CHECK (display_id GLOB 'RULE-[0-9][0-9][0-9]*'),
  title TEXT NOT NULL CHECK (length(title) > 0),
  statement TEXT NOT NULL CHECK (length(statement) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('architecture', 'tech-constraint', 'business')),
  check_kinds TEXT NOT NULL CHECK (
    json_valid(check_kinds) AND json_type(check_kinds) = 'array' AND json_array_length(check_kinds) >= 1
  ),
  parent_requirement_id TEXT REFERENCES requirements (id),
  parent_detached_at TEXT CHECK (parent_detached_at IS NULL OR length(parent_detached_at) > 0),
  builtin INTEGER NOT NULL CHECK (builtin IN (0, 1)),
  target_block_ids TEXT NOT NULL CHECK (
    json_valid(target_block_ids) AND json_type(target_block_ids) = 'array'
  ),
  risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high')),
  contract_id TEXT CHECK (contract_id IS NULL OR length(contract_id) = 26),
  author TEXT NOT NULL CHECK (json_valid(author)),
  norm_state TEXT NOT NULL CHECK (norm_state IN ('approved', 'provisional')),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  deleted_at TEXT CHECK (deleted_at IS NULL OR length(deleted_at) > 0),
  CHECK (builtin = 1 OR parent_requirement_id IS NOT NULL OR parent_detached_at IS NOT NULL),
  CHECK (parent_detached_at IS NULL OR parent_requirement_id IS NULL)
) STRICT;

CREATE INDEX rules_parent_requirement ON rules (parent_requirement_id);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  display_id TEXT NOT NULL UNIQUE CHECK (display_id GLOB 'PRP-[0-9][0-9][0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN (
    'requirement_new', 'requirement_change', 'rule_new', 'rule_change',
    'contract_new', 'design_change', 'rule_title_change', 'contract_change'
  )),
  target_ref TEXT CHECK (target_ref IS NULL OR json_valid(target_ref)),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  diff TEXT NOT NULL CHECK (json_valid(diff)),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  author TEXT NOT NULL CHECK (json_valid(author) AND json_extract(author, '$.kind') = 'agent'),
  source TEXT NOT NULL CHECK (source IN (
    'rule_generation', 'chat', 'reverse_extraction', 'writing_rules', 'implementation'
  )),
  risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high')),
  read_at TEXT CHECK (read_at IS NULL OR length(read_at) > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'provisional')),
  decision TEXT CHECK (decision IS NULL OR json_valid(decision)),
  adr_id TEXT CHECK (adr_id IS NULL OR length(adr_id) = 26),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) = 26),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  CHECK ((state = 'pending') = (decision IS NULL))
) STRICT;

CREATE INDEX proposals_state ON proposals (state);

CREATE TRIGGER proposals_no_replace BEFORE INSERT ON proposals
WHEN EXISTS (SELECT 1 FROM proposals WHERE id = NEW.id OR display_id = NEW.display_id)
BEGIN
  SELECT RAISE(ABORT, 'proposals: 같은 제안이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER proposals_content_immutable BEFORE UPDATE ON proposals
WHEN NEW.id IS NOT OLD.id OR NEW.display_id IS NOT OLD.display_id OR NEW.kind IS NOT OLD.kind
  OR NEW.target_ref IS NOT OLD.target_ref OR NEW.payload IS NOT OLD.payload
  OR NEW.diff IS NOT OLD.diff OR NEW.rationale IS NOT OLD.rationale
  OR NEW.author IS NOT OLD.author OR NEW.source IS NOT OLD.source
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'proposals: 제안 본문은 바꿀 수 없습니다');
END;

CREATE TRIGGER proposals_decision_final BEFORE UPDATE ON proposals
WHEN OLD.state <> 'pending'
  AND (NEW.state IS NOT OLD.state OR NEW.decision IS NOT OLD.decision)
BEGIN
  SELECT RAISE(ABORT, 'proposals: 처리된 제안은 다시 처리할 수 없습니다');
END;

CREATE TRIGGER proposals_no_delete BEFORE DELETE ON proposals
BEGIN
  SELECT RAISE(ABORT, 'proposals: 제안은 지울 수 없습니다');
END;

CREATE TABLE approval_log (
  seq INTEGER PRIMARY KEY NOT NULL CHECK (seq >= 1),
  at TEXT NOT NULL CHECK (length(at) > 0),
  action TEXT NOT NULL CHECK (action IN (
    'approve', 'approve_edited', 'reject', 'run_start', 'provisional_grant'
  )),
  actor TEXT NOT NULL CHECK (json_valid(actor)),
  target_ref TEXT NOT NULL CHECK (json_valid(target_ref)),
  client_id TEXT CHECK (client_id IS NULL OR length(client_id) > 0),
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
) STRICT;

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
`,
};
