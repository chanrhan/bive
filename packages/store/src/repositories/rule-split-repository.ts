// 규칙 분할 기록 리포지토리 (TODO-02 · NRM-02 · NRM-07, M3-57 #320, ADR-147 ⑧, ADR-153). 표 `rule_splits`(0031).
// - 분할로 폐기된 규칙 1개와 그것을 대체한 새 규칙들(만든 순서). 폐기 기록(`rule_retirements`)의 `superseded_by`는 첫 새 규칙뿐이라
//   나머지까지 이 표가 잇는다
// - 추가(`record`)와 읽기만 있다. 짝 폐기 기록 · 규범 변경 기록(분할 상세)과 맞지 않는 행, 수정 · 삭제는 DB 트리거가 막는다. 호출한
//   쪽의 트랜잭션 안에서 부르면 폐기 · 새 규칙과 함께 커밋되거나 되돌려진다. 쓰는 곳은 오케스트레이터의 규칙 반영 모듈 하나다(구조 시험)
import type { SqliteDatabase } from '../database.js';

export class RuleSplitRepository {
  readonly #insert;
  readonly #byRule;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare<[{ rule_id: string; position: number; new_rule_id: string }]>(
      `INSERT INTO rule_splits (rule_id, position, new_rule_id)
       VALUES (@rule_id, @position, @new_rule_id)`,
    );
    this.#byRule = db.prepare<[string], { new_rule_id: string }>(
      'SELECT new_rule_id FROM rule_splits WHERE rule_id = ? ORDER BY position',
    );
  }

  /**
   * 분할로 폐기된 규칙과 새 규칙들을 잇는다 (만든 순서대로 위치 1부터). 폐기 기록 · 규범 변경 기록을 먼저 남기고 같은 트랜잭션에서 부른다.
   * @throws {SqliteError} 폐기 기록 · 분할 상세와 맞지 않음 · 부모 요구사항이 다름 · 이미 이어진 새 규칙 (트리거 · UNIQUE)
   */
  record(input: { readonly ruleId: string; readonly newRuleIds: readonly string[] }): void {
    input.newRuleIds.forEach((newRuleId, index) => {
      this.#insert.run({ rule_id: input.ruleId, position: index + 1, new_rule_id: newRuleId });
    });
  }

  /** 분할로 폐기된 규칙을 대체한 새 규칙 ID (만든 순서). 분할이 아니면 빈 배열. */
  newRulesOf(ruleId: string): string[] {
    return this.#byRule.all(ruleId).map((row) => row.new_rule_id);
  }
}
