// 규칙 작성 역할의 규칙 바로 반영 (NRM-02 · NRM-04 · NRM-07, ADR-100 D1 · C2 · A2, M7-02 #214, ADR-103).
// - 규칙 생성 도구(`propose_rule`) 호출 1건 = 규칙 1개(효력 상태, 생성 주체 = 그 에이전트 역할)와 규범 변경 기록 1건(종류 신규,
//   만든 내용 · 사유 · 세션 ID · 시각)을 트랜잭션 1개로 남긴다. 하나라도 실패하면 아무것도 남지 않는다
// - 승인 대기 제안을 만들지 않고 승인 기록에 쓰지 않는다(C2: 승인 기록은 사람 행동만). 확인 상태도 쓰지 않는다:
//   새 규칙에는 확인 기록이 없어 미확인이다(ADR-100 I1, 확인 서비스에 닿지 않는다)
// - 효력 상태는 기존 규범 상태 값 `approved`(ADR-100 용어 "효력"이 그 자리)다. 새 상태 값을 만들지 않는다(ADR-103)
// - 모순 판단(M7-07 #219, ADR-100 D5, ADR-106): 규칙마다 효력 있는 기존 규칙과의 모순 판단을 받아 같은 트랜잭션에서 판단 기록
//   (종류 `judgment`, 대상 = 새 규칙, 상세 = 결과 · 대상 규칙 · 신규 기록 순번 · 받은 규범 입력의 수)을 신규 기록 바로 뒤에 남긴다.
//   대상 규칙은 지금 효력 있는 규칙이어야 한다(없거나 효력이 없으면 아무것도 남기지 않고 `NormJudgmentInputError`).
//   모순이어도 새 규칙은 반영되고 기존 규칙은 그대로다
// - 폐기 · 대체(M7-09 #221, ADR-100 D5 · D6 · B⑨ · A6, ADR-112): `retireAgentRule`은 규칙 폐기 기록 + 규범 변경 기록 `retired`,
//   `supersedeAgentRule`은 새 규칙 + 신규 · 판단(주제 `supersede`) 기록 + 규범 변경 기록 `superseded` + 폐기 기록을 각각
//   트랜잭션 1개로 남긴다. 하나라도 실패하면 아무것도 남지 않아, 모순된 두 규칙이 함께 효력을 갖는 시점이나 옛 규칙만 폐기된
//   시점이 없다. 폐기의 쓰기(규범 변경 기록 + 폐기 기록 + 확인 풀림)는 {@link writeRetirement} 한 함수에만 있다
// - 확인 풀림(M7-13 #225, ADR-100 D3 · C2, ADR-113): 폐기 · 대체되는 규칙이 사람이 확인한 규칙이면 {@link writeRetirement}가 같은
//   트랜잭션에서 폐기 기록 뒤에 확인 풀림 기록(종류 `unconfirmed`, 주체 오케스트레이터, 원인 = 폐기 · 대체 기록 순번, 앞선 확인)을
//   남기고 확인 서비스의 `releaseConfirmation`으로 미확인으로 되돌린다. 이 모듈이 확인 서비스에서 가져오는 것은 그 함수뿐이다
//   (확인됨을 만드는 함수는 가져오지 않는다). 미확인 규칙이면 아무것도 더하지 않는다. 대체로 생긴 새 규칙은 미확인이다
// - 대상 검증: 없는 규칙(다른 프로젝트 · 같은 호출이 만들 규칙 포함) · 삭제 · 폐기 · 잠정 규칙은 `invalid_args`, 내장 구조
//   규칙은 `builtin_rule`. 근거는 대상 규칙의 진술이나 최근 판정의 인수 테스트 케이스 이름을 글자 그대로 인용해야 한다
//   ({@link quotesRule}, 형식 검사일 뿐이다, A6)
import {
  type AgentAuthor,
  AgentAuthor as AgentAuthorSchema,
  type NormChangeEntry,
  type NormJudgmentRuleRef,
  type Rule,
  RuleNewPayload,
  type RuleRetirement,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { releaseConfirmation } from '../confirmations/confirmation-service.js';
import { displayText } from '../text-limit.js';
import { MIN_QUOTE_LENGTH } from '../tools/definitions.js';
import { isEffectiveRule, retiredRuleSet } from './effective.js';
import { effectiveRules, NORM_INPUT_LIMITS, type NormInputSummary } from './norm-input.js';

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
 * 모순 대상(표시 ID 또는 ID)을 지금 효력 있는 규칙으로 바꾼다. `exclude`(대체의 대상)를 가리키면 거부한다.
 * @throws {NormJudgmentInputError} 없거나 효력이 없는 규칙 · 같은 규칙을 두 번 가리킴 · 대체 대상을 가리킴
 */
const resolveContradicts = (
  store: ProjectStore,
  contradiction: AgentRuleContradiction,
  exclude: Rule | null = null,
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
    if (exclude !== null && rule.id === exclude.id) {
      throw new NormJudgmentInputError(
        `대체 대상 ${rule.displayId}는 넣지 않는다 (대체가 그 규칙과의 모순 판단이다)`,
      );
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
    return writeAgentRule(store, {
      payload,
      author,
      at,
      id: clock.newId(),
      sessionId: input.sessionId,
      rationale: input.rationale,
      normInput: input.normInput,
      judgment: {
        subject: 'new_rule',
        contradicts,
        reason:
          input.contradiction.verdict === 'none'
            ? NO_CONTRADICTION_REASON
            : input.contradiction.grounds,
      },
    });
  });
};

/** 새 규칙의 쓰기 (부른 쪽 트랜잭션 안): 규칙 + 신규 기록 + 판단 기록. */
const writeAgentRule = (
  store: ProjectStore,
  input: {
    readonly payload: RuleNewPayload;
    readonly author: AgentAuthor;
    readonly at: string;
    readonly id: Ulid;
    readonly sessionId: Ulid;
    readonly rationale: string;
    readonly normInput: NormInputSummary;
    readonly judgment: {
      readonly subject: 'new_rule' | 'supersede';
      readonly contradicts: NormJudgmentRuleRef[];
      readonly reason: string;
    };
  },
): AgentRuleResult => {
  const { payload, author, at, judgment: judged } = input;
  const contradicts = judged.contradicts;
  const rule = store.rules.create({
    id: input.id,
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
    reason: judged.reason,
    detail: {
      judgment: {
        subject: judged.subject,
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
};

// ── 폐기 · 대체 (M7-09 #221, ADR-112) ─────────────────────────

/** 폐기 · 대체 입력이 지금 저장소와 맞지 않음. `code`는 도구 결과의 거부 사유다. */
export class NormRetirementInputError extends Error {
  override readonly name = 'NormRetirementInputError';
  constructor(
    readonly code: 'invalid_args' | 'builtin_rule',
    message: string,
  ) {
    super(message);
  }
}

/** 인용 대조의 정규화: NFC, 공백류 연속을 공백 한 칸으로, 앞뒤 공백 제거 (ADR-112). */
export const normalizeQuoteText = (text: string): string =>
  text.normalize('NFC').replace(/\s+/gu, ' ').trim();

/**
 * 근거가 대상 규칙의 글(진술 · 최근 판정의 인수 테스트 케이스 이름)을 글자 그대로 인용하는지 (ADR-100 A6, ADR-112): 정규화한
 * 근거가 정규화한 글 하나의 연속 {@link MIN_QUOTE_LENGTH}자(코드 포인트) 이상을 포함하면 인용이다. 글은 저장된 원문과 규범 입력의
 * 표시 값(ADR-089 `displayText`, 에이전트가 작업 지시에서 본 모양) 둘 다로 대조한다. 대소문자 구분.
 */
export const quotesRule = (grounds: string, sources: readonly string[]): boolean => {
  const haystack = normalizeQuoteText(grounds);
  for (const source of sources) {
    const points = Array.from(normalizeQuoteText(source));
    for (let start = 0; start + MIN_QUOTE_LENGTH <= points.length; start += 1) {
      if (haystack.includes(points.slice(start, start + MIN_QUOTE_LENGTH).join(''))) return true;
    }
  }
  return false;
};

/** 인용 대조에 쓰는 대상 규칙의 글: 진술 · 최근 판정의 케이스 이름, 각각 원문과 규범 입력의 표시 값. */
const quoteSources = (store: ProjectStore, rule: Rule): string[] => {
  const names = store.judgments.latestByRule(rule.id)?.cases.map((testCase) => testCase.name) ?? [];
  return [
    rule.statement,
    displayText(rule.statement, NORM_INPUT_LIMITS.ruleStatement).text,
    ...names,
    ...names.map((name) => displayText(name, NORM_INPUT_LIMITS.caseName).text),
  ];
};

/**
 * 폐기 · 대체 대상(표시 ID 또는 ID)을 지금 효력 있는 규칙으로 바꾼다 (`propose_rule.contradiction`과 같은 방식).
 * @throws {NormRetirementInputError} 없음 · 내장 구조 규칙(`builtin_rule`) · 삭제 · 폐기 · 잠정
 */
const resolveTarget = (store: ProjectStore, given: string): Rule => {
  const rule =
    store.rules.get(given) ?? store.rules.list().find((item) => item.displayId === given) ?? null;
  if (rule === null) {
    throw new NormRetirementInputError('invalid_args', `규칙이 없음: ${JSON.stringify(given)}`);
  }
  // 내장 구조 규칙은 상태와 무관하게 거부한다 (ADR-100 B⑨)
  if (rule.builtin) {
    throw new NormRetirementInputError(
      'builtin_rule',
      `내장 구조 규칙은 폐기 · 대체할 수 없음: ${rule.displayId}`,
    );
  }
  const retired = retiredRuleSet(store);
  if (rule.deletedAt !== null) {
    throw new NormRetirementInputError('invalid_args', `삭제된 규칙: ${rule.displayId}`);
  }
  if (retired.has(rule.id)) {
    throw new NormRetirementInputError('invalid_args', `이미 폐기된 규칙: ${rule.displayId}`);
  }
  if (!isEffectiveRule(rule, retired)) {
    throw new NormRetirementInputError('invalid_args', `효력 없는 규칙(잠정): ${rule.displayId}`);
  }
  return rule;
};

/** @throws {NormRetirementInputError} 근거가 대상 규칙의 글을 인용하지 않음 */
const assertQuoted = (store: ProjectStore, rule: Rule, grounds: string): void => {
  if (!quotesRule(grounds, quoteSources(store, rule))) {
    throw new NormRetirementInputError(
      'invalid_args',
      `grounds가 ${rule.displayId}의 진술이나 최근 판정의 인수 테스트 케이스 이름을 인용하지 않음 (공백 정리 뒤 연속 ${String(MIN_QUOTE_LENGTH)}자 이상을 글자 그대로 옮긴다)`,
    );
  }
};

/** 폐기 · 대체 결과의 폐기 쪽 (규범 변경 기록 + 폐기 기록 + 확인 풀림 기록). */
export interface RetirementWrite {
  /** 규범 변경 기록 (`retired` · `superseded`) */
  readonly normChange: NormChangeEntry;
  readonly retirement: RuleRetirement;
  /** 확인 풀림 기록 (`unconfirmed`). 대상이 사람이 확인한 규칙이 아니었으면 `null` */
  readonly released: NormChangeEntry | null;
}

/** 확인 풀림 기록의 사유 (오케스트레이터의 고정 문장). */
export const RELEASE_REASON =
  '사람이 확인한 규칙을 에이전트가 폐기 · 대체해 확인이 풀림 (ADR-100 D3)';

/**
 * 폐기의 쓰기 (부른 쪽 트랜잭션 안, 폐기 · 대체 공통): 규범 변경 기록(`retired` · `superseded`, 사유 = 근거, `before` = 폐기 직전
 * 규칙 내용) 뒤 폐기 기록. 폐기 기록은 그 순번을 가리킨다(DB 트리거가 짝을 확인한다). 대상이 확인됨이면 이어서 확인 풀림 기록
 * (주체 오케스트레이터, 같은 시각, 원인 = 폐기 · 대체 기록 순번, 앞선 확인)과 확인 상태 되돌리기(M7-13, ADR-113).
 */
const writeRetirement = (
  store: ProjectStore,
  input: {
    readonly target: Rule;
    readonly author: AgentAuthor;
    readonly at: string;
    readonly sessionId: Ulid;
    readonly grounds: string;
    readonly supersede: {
      readonly rule: Rule;
      readonly createdSeq: number;
      readonly judgmentSeq: number;
    } | null;
  },
): RetirementWrite => {
  const { target, supersede } = input;
  const normChange = store.normChanges.append({
    at: input.at,
    kind: supersede === null ? 'retired' : 'superseded',
    actor: input.author,
    targetRef: { entity: 'Rule', id: target.id },
    sessionId: input.sessionId,
    runId: null,
    reason: input.grounds,
    detail: {
      before: ruleContent(target),
      retirement:
        supersede === null
          ? { supersededBy: null }
          : {
              supersededBy: { id: supersede.rule.id, displayId: supersede.rule.displayId },
              createdSeq: supersede.createdSeq,
              judgmentSeq: supersede.judgmentSeq,
            },
    },
  });
  const retirement = store.ruleRetirements.record({
    ruleId: target.id,
    retiredAt: input.at,
    supersededBy: supersede?.rule.id ?? null,
    normChangeSeq: normChange.seq,
  });
  // 확인 상태는 트랜잭션 안에서 읽은 대상 규칙의 값이다 (대상은 이 트랜잭션에서 찾았다)
  const previous = target.confirmation;
  if (previous.state !== 'confirmed') return { normChange, retirement, released: null };
  const released = store.normChanges.append({
    at: input.at,
    kind: 'unconfirmed',
    actor: { kind: 'orchestrator' },
    targetRef: { entity: 'Rule', id: target.id },
    sessionId: null,
    runId: null,
    reason: RELEASE_REASON,
    detail: { unconfirm: { causeSeq: normChange.seq, previous } },
  });
  releaseConfirmation(store, released);
  return { normChange, retirement, released };
};

/** 폐기 입력 (`retire_rule`의 인자에 주체 · 세션을 더한 것). */
export interface AgentRetireInput {
  /** 대상 규칙의 표시 ID 또는 ID */
  readonly ruleId: string;
  /** 근거 (대상 규칙의 진술 · 케이스 이름 인용 필수) */
  readonly grounds: string;
  readonly author: AgentAuthor;
  readonly sessionId: Ulid;
}

export interface AgentRetireResult extends RetirementWrite {
  /** 폐기된 규칙 (폐기 직전 내용) */
  readonly rule: Rule;
}

/**
 * 규칙을 폐기한다 (트랜잭션 1개: 규범 변경 기록 `retired` + 폐기 기록). 새 규칙 · 새 실행은 없다(ADR-100 A4).
 * @throws {ZodError} 주체가 에이전트가 아님 · 빈 근거
 * @throws {NormRetirementInputError} 대상이 없음 · 효력 없음 · 내장 구조 규칙 · 근거가 인용하지 않음
 */
export const retireAgentRule = (
  store: ProjectStore,
  input: AgentRetireInput,
  clock: Pick<AgentRuleClock, 'now'>,
): AgentRetireResult => {
  const author = AgentAuthorSchema.parse(input.author);
  return store.transaction(() => {
    const rule = resolveTarget(store, input.ruleId);
    assertQuoted(store, rule, input.grounds);
    const at = new Date(clock.now()).toISOString();
    const written = writeRetirement(store, {
      target: rule,
      author,
      at,
      sessionId: input.sessionId,
      grounds: input.grounds,
      supersede: null,
    });
    return { rule, ...written };
  });
};

/** 대체 입력: 새 규칙(규칙 생성 입력)에 대상 · 근거를 더한 것. `contradiction`은 대상 밖 효력 있는 규칙과의 판단이다. */
export interface AgentSupersedeInput extends AgentRuleInput {
  /** 대체할 규칙의 표시 ID 또는 ID */
  readonly ruleId: string;
  /** 근거 (대상 규칙의 진술 · 케이스 이름 인용 필수, 대체 · 판단 기록의 사유) */
  readonly grounds: string;
}

export interface AgentSupersedeResult extends AgentRuleResult {
  /** 대체된(폐기된) 규칙 (폐기 직전 내용) */
  readonly superseded: Rule;
  /** 대체 기록 (`superseded`) + 폐기 기록 */
  readonly retirement: RetirementWrite;
}

/**
 * 규칙을 대체한다 (트랜잭션 1개, ADR-100 D6): 새 규칙 + 신규 기록 + 판단 기록(주제 `supersede`, 결과 모순, 대상 = 대체된 규칙과
 * `contradiction`의 규칙) + 대체 기록(`superseded`, 대체된 규칙 대상) + 폐기 기록. 판단 기록의 사유는 근거이고, 대상 밖 규칙과도
 * 모순이면 그 근거를 줄을 바꿔 덧붙인다.
 * @throws {ZodError} 본문 스키마 위반 · 주체가 에이전트가 아님 · 빈 사유 · 빈 근거
 * @throws {NotFoundError} 부모 요구사항이 없음
 * @throws {ConflictError} 부모 요구사항이 삭제됨
 * @throws {NormRetirementInputError} 대상이 없음 · 효력 없음 · 내장 구조 규칙 · 근거가 인용하지 않음
 * @throws {NormJudgmentInputError} 모순 대상이 효력 있는 규칙이 아님 · 대체 대상을 가리킴
 */
export const supersedeAgentRule = (
  store: ProjectStore,
  input: AgentSupersedeInput,
  clock: AgentRuleClock,
): AgentSupersedeResult => {
  const payload = RuleNewPayload.parse(input.payload);
  const author = AgentAuthorSchema.parse(input.author);
  return store.transaction(() => {
    // 대상 · 인용 · 모순 대상은 새 규칙을 만들기 전에 확인한다 (같은 호출이 만들 규칙은 대상이 될 수 없다)
    const target = resolveTarget(store, input.ruleId);
    assertQuoted(store, target, input.grounds);
    const others = resolveContradicts(store, input.contradiction, target);
    const at = new Date(clock.now()).toISOString();
    const created = writeAgentRule(store, {
      payload,
      author,
      at,
      id: clock.newId(),
      sessionId: input.sessionId,
      rationale: input.rationale,
      normInput: input.normInput,
      judgment: {
        subject: 'supersede',
        contradicts: [{ id: target.id, displayId: target.displayId }, ...others],
        reason:
          input.contradiction.verdict === 'none'
            ? input.grounds
            : `${input.grounds}\n${input.contradiction.grounds}`,
      },
    });
    const retirement = writeRetirement(store, {
      target,
      author,
      at,
      sessionId: input.sessionId,
      grounds: input.grounds,
      supersede: {
        rule: created.rule,
        createdSeq: created.normChange.seq,
        judgmentSeq: created.judgment.seq,
      },
    });
    return { ...created, superseded: target, retirement };
  });
};
