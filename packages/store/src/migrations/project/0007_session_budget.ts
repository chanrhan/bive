import type { Migration } from '../../migrate.js';

/**
 * 세션에 넘긴 한도 (COST-01, NFR-07, ADR-067).
 * - `budget_max_usd` · `budget_max_turns`: 세션을 열 때 어댑터에 넘긴 `maxBudgetUsd` · `maxTurns`
 *   (= min(역할 잔여, 실행 잔여)). 결과 없이 끝난 세션(비정상 종료로 `aborted` · 어댑터 오류)은 비용 · 턴을 모르므로,
 *   잔여 한도를 계산할 때 이 한도를 다 쓴 것으로 본다. 한도 없이 연 세션(실행 밖 세션, 이 마이그레이션 전 세션)은
 *   둘 다 `NULL`이다. 둘은 함께 있거나 함께 없다(CHECK, `@bive/shared`의 `Session` 스키마도 같은 검사)
 * - 세션을 열 때 정해지고 바뀌지 않는다 (트리거)
 */
export const migration: Migration = {
  version: 7,
  name: 'session_budget',
  up: `
ALTER TABLE sessions ADD COLUMN budget_max_usd REAL CHECK (budget_max_usd IS NULL OR budget_max_usd > 0);
ALTER TABLE sessions ADD COLUMN budget_max_turns INTEGER
  CHECK (budget_max_turns IS NULL OR budget_max_turns > 0)
  CHECK ((budget_max_usd IS NULL) = (budget_max_turns IS NULL));

CREATE TRIGGER sessions_budget_immutable BEFORE UPDATE ON sessions
WHEN NEW.budget_max_usd IS NOT OLD.budget_max_usd OR NEW.budget_max_turns IS NOT OLD.budget_max_turns
BEGIN
  SELECT RAISE(ABORT, 'sessions: 세션 한도는 바꿀 수 없습니다');
END;
`,
};
