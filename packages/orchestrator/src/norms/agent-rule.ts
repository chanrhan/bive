// 규칙 작성 역할의 규칙 바로 반영 (NRM-02 · NRM-04 · NRM-07, ADR-100 D1 · C2 · A2, M7-02 #214, ADR-103).
// - 규칙 생성 도구(`propose_rule`) 호출 1건 = 규칙 1개(효력 상태, 생성 주체 = 그 에이전트 역할)와 규범 변경 기록 1건(종류 신규,
//   만든 내용 · 사유 · 세션 ID · 시각)을 트랜잭션 1개로 남긴다. 하나라도 실패하면 아무것도 남지 않는다
// - 승인 대기 제안을 만들지 않고 승인 기록에 쓰지 않는다(C2: 승인 기록은 사람 행동만). 확인 상태도 쓰지 않는다:
//   새 규칙에는 확인 기록이 없어 미확인이다(ADR-100 I1, 확인 서비스에 닿지 않는다)
// - 효력 상태는 기존 규범 상태 값 `approved`(ADR-100 용어 "효력"이 그 자리)다. 새 상태 값을 만들지 않는다(ADR-103)
import {
  type AgentAuthor,
  AgentAuthor as AgentAuthorSchema,
  type NormChangeEntry,
  type Rule,
  RuleNewPayload,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

/** 바로 반영할 규칙 (규칙 생성 도구의 인자에서 근거를 뺀 것). */
export interface AgentRuleInput {
  /** 규칙 본문 (`RuleNewPayload`로 검증: 제목 · EARS 진술 · 종류 · 검사 종류 · 부모 요구사항) */
  readonly payload: unknown;
  /** 사유 · 근거 (규범 변경 기록 `reason`) */
  readonly rationale: string;
  /** 규칙을 만든 에이전트 역할 */
  readonly author: AgentAuthor;
  /** 그 행동을 한 세션 (BIVE 세션 기록 ID) */
  readonly sessionId: Ulid;
}

export interface AgentRuleClock {
  /** 시각 (ms) */
  readonly now: () => number;
  /** 새 ULID */
  readonly newId: () => Ulid;
}

export interface AgentRuleResult {
  readonly rule: Rule;
  readonly normChange: NormChangeEntry;
}

/** 규범 변경 기록에 남기는 규칙 내용 (만든 시점의 내용, 뒤의 변경과 비교할 기준). */
const ruleContent = (rule: Rule) => ({
  displayId: rule.displayId,
  title: rule.title,
  statement: rule.statement,
  kind: rule.kind,
  checkKinds: rule.checkKinds,
  parentRequirementId: rule.parentRequirementId,
});

/**
 * 열린 저장소에 규칙을 바로 반영하고 규범 변경 기록을 남긴다 (트랜잭션 1개).
 * @throws {ZodError} 본문 스키마 위반 · 주체가 에이전트가 아님 · 빈 사유
 * @throws {NotFoundError} 부모 요구사항이 없음
 * @throws {ConflictError} 부모 요구사항이 삭제됨
 */
export const createAgentRule = (
  store: ProjectStore,
  input: AgentRuleInput,
  clock: AgentRuleClock,
): AgentRuleResult => {
  const payload = RuleNewPayload.parse(input.payload);
  const author = AgentAuthorSchema.parse(input.author);
  return store.transaction(() => {
    const at = new Date(clock.now()).toISOString();
    const rule = store.rules.create({
      id: clock.newId(),
      title: payload.title,
      statement: payload.statement,
      kind: payload.kind,
      checkKinds: payload.checkKinds,
      parentRequirementId: payload.parentRequirementId,
      builtin: false,
      // 대상 블록 · 위험도는 M3 이후 (NRM-09)
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author,
      normState: 'approved',
      createdAt: at,
    });
    const normChange = store.normChanges.append({
      at,
      kind: 'created',
      actor: author,
      targetRef: { entity: 'Rule', id: rule.id },
      sessionId: input.sessionId,
      runId: null,
      reason: input.rationale,
      detail: { after: ruleContent(rule) },
    });
    return { rule, normChange };
  });
};
