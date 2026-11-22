// 규칙 폐기 기록 리포지토리 (NRM-02 · NRM-06, ADR-100 D5 · D6 · B⑨, M7-09 #221, ADR-112). 테이블 `rule_retirements`(0018).
// - 폐기된 규칙 1개에 1행. 행이 있는 규칙은 효력이 없다. 규칙 행(`rules`) · 판정 이력(`judgments`)은 그대로 남는다
// - 추가(`record`)와 읽기만 있다. 덮어쓰기 · 수정 · 삭제와 내장 구조 규칙 · 삭제된 규칙의 폐기, 짝 기록(`retired` ·
//   `superseded`) 없는 폐기는 DB 트리거가 막는다. 호출한 쪽의 트랜잭션 안에서 부르면 규범 변경 기록과 함께 커밋되거나 되돌려진다
import { RuleRetirement } from '@bive/shared';

import type { SqliteDatabase } from '../database.js';

interface RetirementRow {
  rule_id: string;
  retired_at: string;
  superseded_by: string | null;
  norm_change_seq: number;
}

const COLUMNS = 'rule_id, retired_at, superseded_by, norm_change_seq';

/** 저장된 행을 읽는다. 형식이 깨진 행(저장소 밖에서 고친 행)도 폐기로 본다(효력 판정은 행이 있는지만 본다). */
const toRetirement = (row: RetirementRow): RuleRetirement | null => {
  const parsed = RuleRetirement.safeParse({
    ruleId: row.rule_id,
    retiredAt: row.retired_at,
    supersededBy: row.superseded_by,
    normChangeSeq: row.norm_change_seq,
  });
  return parsed.success ? parsed.data : null;
};

export class RuleRetirementRepository {
  readonly #insert;
  readonly #select;
  readonly #selectAll;
  readonly #selectIds;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare<[RetirementRow]>(
      `INSERT INTO rule_retirements (${COLUMNS})
       VALUES (@rule_id, @retired_at, @superseded_by, @norm_change_seq)`,
    );
    this.#select = db.prepare<[string], RetirementRow>(
      `SELECT ${COLUMNS} FROM rule_retirements WHERE rule_id = ?`,
    );
    this.#selectAll = db.prepare<[], RetirementRow>(
      `SELECT ${COLUMNS} FROM rule_retirements ORDER BY norm_change_seq`,
    );
    this.#selectIds = db.prepare<[], { rule_id: string }>('SELECT rule_id FROM rule_retirements');
  }

  /**
   * 규칙의 폐기를 남긴다. 규범 변경 기록(`retired` · `superseded`)을 먼저 남기고 같은 트랜잭션에서 부른다.
   * @throws {ZodError} 형식 위반
   * @throws {SqliteError} 이미 폐기됨 · 없거나 삭제된 규칙 · 내장 구조 규칙 · 대체한 규칙의 효력 없음 · 짝 기록 없음 (트리거)
   */
  record(input: RuleRetirement): RuleRetirement {
    const retirement = RuleRetirement.parse(input);
    this.#insert.run({
      rule_id: retirement.ruleId,
      retired_at: retirement.retiredAt,
      superseded_by: retirement.supersededBy,
      norm_change_seq: retirement.normChangeSeq,
    });
    return retirement;
  }

  /** 규칙의 폐기 기록. 없거나 형식이 깨졌으면 `null` (깨진 행이 있는지는 {@link retiredRuleIds}가 본다). */
  get(ruleId: string): RuleRetirement | null {
    const row = this.#select.get(ruleId);
    return row === undefined ? null : toRetirement(row);
  }

  /** 모든 폐기 기록 (기록 순번 순). 형식이 깨진 행은 뺀다. */
  list(): RuleRetirement[] {
    return this.#selectAll
      .all()
      .map(toRetirement)
      .filter((item): item is RuleRetirement => item !== null);
  }

  /** 폐기된 규칙 ID (행이 있으면 형식과 무관하게 폐기로 본다: 효력을 잃은 쪽으로 닫는다). */
  retiredRuleIds(): Set<string> {
    return new Set(this.#selectIds.all().map((row) => row.rule_id));
  }
}
