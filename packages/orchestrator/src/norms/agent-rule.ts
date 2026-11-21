// 규칙 작성 역할의 규칙 바로 반영 (NRM-02 · NRM-04 · NRM-07, ADR-100 D1 · C2 · A2, M7-02 #214, ADR-103).
// - 규칙 생성 도구(`propose_rule`) 호출 1건 = 규칙 1개(효력 상태, 생성 주체 = 그 에이전트 역할)와 규범 변경 기록 1건(종류 신규,
//   만든 내용 · 사유 · 세션 ID · 시각)을 트랜잭션 1개로 남긴다. 하나라도 실패하면 아무것도 남지 않는다
// - 승인 대기 제안을 만들지 않고 승인 기록에 쓰지 않는다(C2: 승인 기록은 사람 행동만). 확인 상태도 쓰지 않는다:
//   새 규칙에는 확인 기록이 없어 미확인이다(ADR-100 I1, 확인 서비스에 닿지 않는다)
// - 효력 상태는 기존 규범 상태 값 `approved`(ADR-100 용어 "효력"이 그 자리)다. 새 상태 값을 만들지 않는다(ADR-103)
// - 모순 판단(M7-07 #219, ADR-100 D5, ADR-106): 규칙마다 효력 있는 기존 규칙과의 모순 판단을 받아 같은 트랜잭션에서 판단 기록
//   (종류 `judgment`, 대상 = 새 규칙, 상세 = 결과 · 대상 규칙 · 신규 기록 순번 · 받은 규범 입력의 수)을 신규 기록 바로 뒤에 남긴다.
//   대상 규칙은 지금 효력 있는 규칙이어야 한다(없거나 효력이 없으면 아무것도 남기지 않고 `NormJudgmentInputError`).
//   모순이어도 새 규칙은 반영되고 기존 규칙은 그대로다(폐기 · 대체는 M7-09)
import {
  type AgentAuthor,
  AgentAuthor as AgentAuthorSchema,
  type NormChangeEntry,
  type NormJudgmentRuleRef,
  type Rule,
  RuleNewPayload,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { effectiveRules, type NormInputSummary } from './norm-input.js';

/** 모순 판단 입력 (규칙 생성 도구의 `contradiction`과 같은 모양). */
export type AgentRuleContradiction =
  | { readonly verdict: 'none' }
  | {
      readonly verdict: 'contradicts';
      /** 대상 규칙의 표시 ID 또는 ID */
      readonly ruleIds: readonly string[];
      /** 근거 (판단 기록의 `reason`) */
      readonly grounds: string;
    };

/** 모순 판단이 지금 저장소와 맞지 않음 (대상 규칙이 없거나 효력이 없음 · 같은 규칙을 두 번 가리킴). */
export class NormJudgmentInputError extends Error {
  override readonly name = 'NormJudgmentInputError';
}

/** 모순 없음 판단 기록의 사유 (판단 결과를 옮긴 고정 문장, 근거 글은 모순일 때만 받는다). */
export const NO_CONTRADICTION_REASON = '효력 있는 기존 규칙과 모순 없음 (규칙 작성 역할의 판단)';

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
  /** 효력 있는 기존 규칙과의 모순 판단 (M7-07) */
  readonly contradiction: AgentRuleContradiction;
  /** 그 세션이 작업 지시로 받은 규범 입력의 요약 (판단 기록에 수를 남긴다) */
  readonly normInput: NormInputSummary;
}

export interface AgentRuleClock {
  /** 시각 (ms) */
  readonly now: () => number;
  /** 새 ULID */
  readonly newId: () => Ulid;
}

export interface AgentRuleResult {
  readonly rule: Rule;
  /** 신규 기록 */
  readonly normChange: NormChangeEntry;
  /** 모순 판단 기록 (신규 기록 바로 뒤) */
  readonly judgment: NormChangeEntry;
}

/**
 * 모순 대상(표시 ID 또는 ID)을 지금 효력 있는 규칙으로 바꾼다.
 * @throws {NormJudgmentInputError} 없거나 효력이 없는 규칙 · 같은 규칙을 두 번 가리킴
 */
const resolveContradicts = (
  store: ProjectStore,
  contradiction: AgentRuleContradiction,
): NormJudgmentRuleRef[] => {
  if (contradiction.verdict === 'none') return [];
  const rules = effectiveRules(store);
  const refs: NormJudgmentRuleRef[] = [];
  const missing: string[] = [];
  for (const given of contradiction.ruleIds) {
    const rule = rules.find((candidate) => candidate.id === given || candidate.displayId === given);
    if (rule === undefined) {
      missing.push(given);
      continue;
    }
    if (refs.some((ref) => ref.id === rule.id)) {
      throw new NormJudgmentInputError(`같은 규칙을 두 번 가리킴: ${rule.displayId}`);
    }
    refs.push({ id: rule.id, displayId: rule.displayId });
  }
  if (missing.length > 0) {
    throw new NormJudgmentInputError(
      `효력 있는 규칙이 아님: ${missing.map((id) => JSON.stringify(id)).join(', ')}`,
    );
  }
  return refs;
};

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
 * 열린 저장소에 규칙을 바로 반영하고 규범 변경 기록(신규 · 모순 판단)을 남긴다 (트랜잭션 1개).
 * @throws {ZodError} 본문 스키마 위반 · 주체가 에이전트가 아님 · 빈 사유 · 빈 근거
 * @throws {NotFoundError} 부모 요구사항이 없음
 * @throws {ConflictError} 부모 요구사항이 삭제됨
 * @throws {NormJudgmentInputError} 모순 대상이 지금 효력 있는 규칙이 아님
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
    // 대상은 새 규칙을 만들기 전에 고른다 (새 규칙 자신을 가리킬 수 없다)
    const contradicts = resolveContradicts(store, input.contradiction);
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
    const { requirements, rules } = input.normInput;
    const judgment = store.normChanges.append({
      at,
      kind: 'judgment',
      actor: author,
      targetRef: { entity: 'Rule', id: rule.id },
      sessionId: input.sessionId,
      runId: null,
      reason:
        input.contradiction.verdict === 'none'
          ? NO_CONTRADICTION_REASON
          : input.contradiction.grounds,
      detail: {
        judgment: {
          subject: 'new_rule',
          verdict: contradicts.length > 0 ? 'contradiction' : 'no_contradiction',
          contradicts,
          createdSeq: normChange.seq,
          input: {
            requirements: { total: requirements.total, included: requirements.included },
            rules: { total: rules.total, included: rules.included },
          },
        },
      },
    });
    return { rule, normChange, judgment };
  });
};
