import type { Migration } from '../../migrate.js';

/**
 * 변이 판정 기록 (JDG-04 · RUN-04, M3-07 #52, ADR-033 · ADR-139).
 * - `mutation_results`: 실행의 변이 주입 단계가 규칙 하나에 세션 1개를 열고 남기는 기록 1행. 세션이 낸 변이(`mutant`: 파일 하나 ·
 *   한 군데의 바꿀 글 · 바꾼 글, 에이전트가 쓴 글 원문, 내지 않았으면 NULL)와 그 변이를 격리 체크아웃에 적용한 판정 결과(`outcome`)
 *   · 변이 상태(`status`). 상태는 판정 결과에서만 정해진다(검출 `killed` = 검증됨, 생존 `survived` = 생존, 나머지 = 미검증). 이 짝을
 *   표 CHECK로 강제한다(읽기 스키마 `MutationResult`와 이중)
 * - 규칙의 변이 상태 = 그 규칙의 가장 최근 기록(기록 시각 → ID 순)의 상태, 기록이 없으면 '변이 미검증'
 * - 추가 전용: 덮어쓰기 · 수정 · 삭제 트리거. 실행 · 단계 시도 · 규칙은 외래 키로 묶고, 세션 ID는 묶지 않는다(0013과 같은 이유)
 * - 새 표만 더한다(다른 표를 다시 만들지 않는다)
 */
export const migration: Migration = {
  version: 26,
  name: 'mutation_results',
  up: `
CREATE TABLE mutation_results (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  rule_id TEXT NOT NULL REFERENCES rules (id),
  run_id TEXT NOT NULL REFERENCES runs (id),
  step_id TEXT NOT NULL REFERENCES steps (id),
  session_id TEXT CHECK (session_id IS NULL OR length(session_id) = 26),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64)),
  status TEXT NOT NULL CHECK (status IN ('verified', 'unverified', 'survived')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'killed', 'survived', 'no_mutant', 'no_cases', 'checkout_error', 'install_error',
    'collect_error', 'runner_error'
  )),
  mutant TEXT CHECK (mutant IS NULL OR (json_valid(mutant) AND json_type(mutant) = 'object')),
  recorded_at TEXT NOT NULL CHECK (
    recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  CHECK (
    (outcome = 'killed' AND status = 'verified')
    OR (outcome = 'survived' AND status = 'survived')
    OR (outcome NOT IN ('killed', 'survived') AND status = 'unverified')
  ),
  CHECK ((outcome = 'no_mutant') = (mutant IS NULL))
) STRICT;

CREATE INDEX mutation_results_rule_latest ON mutation_results (rule_id, recorded_at, id);
CREATE INDEX mutation_results_run ON mutation_results (run_id);

CREATE TRIGGER mutation_results_no_replace BEFORE INSERT ON mutation_results
WHEN EXISTS (SELECT 1 FROM mutation_results WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'mutation_results: 같은 변이 기록이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER mutation_results_no_update BEFORE UPDATE ON mutation_results
BEGIN
  SELECT RAISE(ABORT, 'mutation_results: 변이 기록은 바꿀 수 없습니다');
END;

CREATE TRIGGER mutation_results_no_delete BEFORE DELETE ON mutation_results
BEGIN
  SELECT RAISE(ABORT, 'mutation_results: 변이 기록은 지울 수 없습니다');
END;
`,
};
