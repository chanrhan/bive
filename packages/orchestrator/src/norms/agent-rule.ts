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
//   ({@link quotesRule}, 형식 검사일 뿐이다, A6). EARS 틀 글자 · 공백을 뺀 나머지로 세고, 효력 있는 다른 규칙에도 있는 조각은
//   인용으로 치지 않는다(M7-11 #223, ADR-115)
// - 이의 판단(M7-11 #223, ADR-100 D4 · A4, ADR-115): 실행 안의 판단 세션이 이의 대상 규칙을 폐기 · 대체하면 같은 트랜잭션에서
//   판단 기록(주제 `objection`, 결과 `retired` · `superseded`, 원인 = 이의 기록 순번)을 폐기 쪽 쓰기({@link writeRetirement}) 바로
//   앞에 남긴다(확인 풀림의 쓰기 순서는 그대로). 유지는 {@link upholdAgentRule}이 판단 기록 1건만 남긴다(규칙은 그대로). 같은
//   이의의 같은 규칙에 판단은 1건이다
// - 요구사항 변경 판단(M7-10 #222, ADR-100 NRM-01 · NRM-02 행 · D5 · D6, ADR-116): 사람이 자식 규칙 있는 요구사항을 고치거나 지우면
//   재판단 세션이 자식 규칙을 폐기 · 대체 · 유지한다. 판단 기록(주제 `requirement_change`, 원인 = 요구사항 · 변경 종류 · 시각 · 본문
//   해시)은 이의 판단과 같은 자리(폐기 쪽 쓰기 앞)에 같은 트랜잭션으로 남는다. 같은 변경(요구사항 · 종류 · 시각 · 본문 해시)의 같은 규칙에 판단은 1건이고,
//   판단하지 못한 자식 규칙은 {@link settleRequirementChange}가 오케스트레이터의 유지(`undecided`)로 마무리한다(판단 없음은 폐기가
//   아니다). 지운 요구사항의 자식 규칙은 대체할 수 없다
// - 검사 실패 판단(M7-12 #224, ADR-100 B⑧ · A4, ADR-118): 검사 단계 · 병합 재검사에서 실패한 대상 밖 규칙을 판단 세션이 폐기 ·
//   대체하면 판단 기록(주제 `check_failure`, 결과 모순, 모순 대상 = 실행의 대상 규칙, 원인 = 단계 시도 · 케이스 이름)을 같은 자리에,
//   유지하면 결과 모순 없음의 판단 기록 1건을 남긴다. 실행 · 규칙마다 판단은 1건이다
import {
  type AgentAuthor,
  AgentAuthor as AgentAuthorSchema,
  type NormChangeEntry,
  type NormJudgmentRequirementChange,
  type NormJudgmentRuleRef,
  Risk,
  type Rule,
  RuleNewPayload,
  type RuleRetirement,
  RuleTargetBlocks,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { releaseConfirmation } from '../confirmations/confirmation-service.js';
import { type CaseNameFilter, NO_KNOWN_CASES } from './case-names.js';
import {
  checkFailureCause,
  checkJudgmentsOf,
  type CheckJudgmentContext,
} from './check-contradiction.js';
import { displayText } from '../text-limit.js';
import { MIN_QUOTE_LENGTH } from '../tools/definitions.js';
import { EARS_FRAME_WORDS } from '../tools/ears.js';
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

/**
 * 에이전트가 새로 만드는 규칙의 본문 (M3-01 #46, NRM-09, ADR-122): 규칙 본문(`RuleNewPayload`)에 대상 블록(블록 이름 1개 이상)과
 * 위험도가 필수로 붙는다. 옛 제안 본문(`RuleNewPayload`)과 옛 규칙 행은 바꾸지 않는다(새로 만드는 이 경로에서만 강제한다).
 */
export const AgentRulePayload = RuleNewPayload.extend({
  targetBlocks: RuleTargetBlocks,
  risk: Risk,
});
export type AgentRulePayload = ReturnType<typeof AgentRulePayload.parse>;

/**
 * 대상 블록을 지금 블록 선언과 대조한다 (부른 쪽 트랜잭션 안, ADR-122). 선언이 있으면 이름이 모두 선언에 있어야 하고(없으면
 * 도구 인자 오류로 돌아가는 스키마 오류, 아무것도 쓰지 않는다), 선언이 없으면 대조하지 않고 받은 이름을 그대로 둔다. 대조한 선언의
 * 판(선언이 없으면 `null`)을 돌려준다: 신규 기록의 만든 내용에 남아 "선언 없이 받은 이름"이 조회 결과에 드러난다.
 * @throws {ZodError} 선언에 없는 블록 이름
 */
const checkTargetBlocks = (store: ProjectStore, targetBlocks: readonly string[]): number | null => {
  const current = store.blockDeclarations.current();
  if (current === null) return null;
  const declared = current.declaration.blocks.map((block) => block.name);
  AgentRulePayload.pick({ targetBlocks: true })
    .superRefine(({ targetBlocks: names }, ctx) => {
      names.forEach((name, index) => {
        if (!declared.includes(name)) {
          ctx.addIssue({
            code: 'custom',
            message: `블록 선언에 없는 블록: ${name} (선언된 블록: ${declared.join(', ')})`,
            path: ['targetBlocks', index],
          });
        }
      });
    })
    .parse({ targetBlocks });
  return current.version;
};

/** 바로 반영할 규칙 (규칙 생성 도구의 인자에서 근거를 뺀 것). */
export interface AgentRuleInput {
  /** 규칙 본문 (`AgentRulePayload`로 검증: 제목 · EARS 진술 · 종류 · 검사 종류 · 부모 요구사항 · 대상 블록 · 위험도) */
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
  targetBlockIds: rule.targetBlockIds,
  risk: rule.risk,
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
  const payload = AgentRulePayload.parse(input.payload);
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
      runId: null,
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
    readonly payload: AgentRulePayload;
    readonly author: AgentAuthor;
    readonly at: string;
    readonly id: Ulid;
    readonly sessionId: Ulid;
    /** 연결 실행 (실행 안의 판단 세션이면 그 실행, 아니면 `null`) */
    readonly runId: Ulid | null;
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
  const blockDeclarationVersion = checkTargetBlocks(store, payload.targetBlocks);
  const rule = store.rules.create({
    id: input.id,
    title: payload.title,
    statement: payload.statement,
    kind: payload.kind,
    checkKinds: payload.checkKinds,
    parentRequirementId: payload.parentRequirementId,
    builtin: false,
    // 대상 블록 · 위험도 (NRM-09, M3-01 #46): 새로 만드는 규칙에는 필수
    targetBlockIds: [...payload.targetBlocks],
    risk: payload.risk,
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
    runId: input.runId,
    reason: input.rationale,
    // 대조한 블록 선언의 판 (`null` = 블록 선언 없음: 대상 블록 이름을 대조하지 않고 받은 그대로 둠, ADR-122)
    detail: { after: { ...ruleContent(rule), blockDeclarationVersion } },
  });
  const { requirements, rules } = input.normInput;
  const judgment = store.normChanges.append({
    at,
    kind: 'judgment',
    actor: author,
    targetRef: { entity: 'Rule', id: rule.id },
    sessionId: input.sessionId,
    runId: input.runId,
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

/** EARS 틀 글자 (대문자 낱말, 앞뒤가 영문자가 아닐 때만). 모든 진술에 있어 인용으로 세지 않는다 (ADR-115). */
const EARS_FRAME_PATTERN = new RegExp(
  `(?<![A-Za-z])(?:${EARS_FRAME_WORDS.join('|')})(?![A-Za-z])`,
  'gu',
);

/**
 * 인용으로 세는 글자 (코드 포인트 목록, ADR-115): 정규화(NFC · 공백 정리) 뒤 EARS 틀 글자(`WHEN` · `THE` · `SYSTEM` · `SHALL` 등,
 * {@link EARS_FRAME_WORDS})와 공백을 모두 뺀 나머지. `THE SYSTEM`처럼 틀 글자만 옮긴 근거는 남는 글자가 없다.
 */
export const quoteCore = (text: string): string[] =>
  Array.from(normalizeQuoteText(text).replace(EARS_FRAME_PATTERN, '').replace(/\s+/gu, ''));

/**
 * 근거가 대상 규칙의 글(진술 · 최근 판정의 인수 테스트 케이스 이름)을 글자 그대로 인용하는지 (ADR-100 A6, ADR-112 · ADR-115).
 * 글은 저장된 원문과 규범 입력의 표시 값(ADR-089 `displayText`, 에이전트가 작업 지시에서 본 모양) 둘 다로 대조한다. 대소문자 구분.
 * - 센다: 근거와 글 모두 {@link quoteCore}(EARS 틀 글자 · 공백을 뺀 나머지)로 바꾼 뒤, 글의 연속 {@link MIN_QUOTE_LENGTH}
 *   코드 포인트 조각이 근거에 있으면 인용 조각이다
 * - 고유: `others`(효력 있는 다른 규칙의 글)의 어느 하나에라도 들어 있는 조각은 인용으로 치지 않는다(규칙끼리 겹치는 머리말로
 *   다른 규칙을 겨누지 못하게)
 * - 대상의 글에 고유 조각이 하나도 없으면(다른 규칙과 글이 거의 같음) 겹치는 조각의 인용도 받는다(그렇지 않으면 그 규칙은 폐기할
 *   수 없게 된다)
 */
export const quotesRule = (
  grounds: string,
  sources: readonly string[],
  others: readonly string[] = [],
): boolean => {
  const haystack = quoteCore(grounds).join('');
  const shared = others.map((text) => quoteCore(text).join(''));
  let uniqueExists = false;
  let sharedQuoted = false;
  for (const source of sources) {
    const points = quoteCore(source);
    for (let start = 0; start + MIN_QUOTE_LENGTH <= points.length; start += 1) {
      const piece = points.slice(start, start + MIN_QUOTE_LENGTH).join('');
      const unique = !shared.some((text) => text.includes(piece));
      if (unique) uniqueExists = true;
      if (!haystack.includes(piece)) continue;
      if (unique) return true;
      sharedQuoted = true;
    }
  }
  return !uniqueExists && sharedQuoted;
};

/**
 * 인용 대조에 쓰는 규칙의 글: 진술 · 최근 판정의 케이스 이름, 각각 원문과 규범 입력의 표시 값. 케이스 이름은 규범 자료와 같은
 * 기준(`isKnownCase`, 그 규칙의 인수 테스트 파일에 적힌 이름)을 지난 것만 쓴다: 모르는 이름은 인용 출처가 될 수 없다(M3-37,
 * ADR-121).
 */
const quoteSources = (store: ProjectStore, rule: Rule, isKnownCase: CaseNameFilter): string[] => {
  const names = (
    store.judgments.latestByRule(rule.id)?.cases.map((testCase) => testCase.name) ?? []
  ).filter((name) => isKnownCase(rule.displayId, name));
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
const assertQuoted = (
  store: ProjectStore,
  rule: Rule,
  grounds: string,
  isKnownCase: CaseNameFilter,
): void => {
  // 고유 조각의 기준: 효력 있는 다른 규칙의 글 (ADR-115). 다른 규칙의 케이스 이름도 같은 기준으로 거른다
  const others = effectiveRules(store)
    .filter((other) => other.id !== rule.id)
    .flatMap((other) => quoteSources(store, other, isKnownCase));
  if (!quotesRule(grounds, quoteSources(store, rule, isKnownCase), others)) {
    throw new NormRetirementInputError(
      'invalid_args',
      `grounds가 ${rule.displayId}의 진술이나 최근 판정의 인수 테스트 케이스 이름을 인용하지 않음 (EARS 틀 글자 · 공백을 뺀 연속 ${String(MIN_QUOTE_LENGTH)}자 이상을 글자 그대로 옮긴다. 효력 있는 다른 규칙에도 있는 조각은 세지 않는다)`,
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

/** 확인 풀림 기록의 사유 (오케스트레이터의 고정 문장, 화면에 그대로 보인다). 문서 기호를 섞지 않는다 (M7-21 #268). */
export const RELEASE_REASON = '사람이 확인한 규칙을 에이전트가 폐기 · 대체해 확인 풀림';

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
    readonly runId: Ulid | null;
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
    runId: input.runId,
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
  /** 이의 판단이면 그 판단의 원인 · 실행 (M7-11, ADR-115). 없으면 요구사항 세션의 폐기 */
  readonly objection?: AgentObjectionJudgment;
  /** 검사 실패 판단이면 그 판단의 원인 · 실행 (M7-12, ADR-118). `objection`과 함께 쓰지 않는다 */
  readonly check?: AgentCheckJudgment;
  /** 요구사항 변경 판단이면 그 원인 (M7-10, ADR-116). `objection`과 함께 줄 수 없다 */
  readonly requirementChange?: AgentRequirementChangeJudgment;
  /**
   * 인용 출처로 쓸 케이스 이름의 기준 (세션이 받은 규범 자료와 같은 `knownCaseMatcher`, M3-37 · ADR-121). 없으면 케이스 이름을
   * 인용 출처로 쓰지 않는다(진술만)
   */
  readonly isKnownCase?: CaseNameFilter;
}

/** 요구사항 변경 재판단 세션의 판단 문맥 (M7-10, ADR-116). */
export interface AgentRequirementChangeJudgment {
  /** 원인: 고치거나 지운 요구사항 · 변경 종류 · 그 시각 · 판단에 쓴 본문의 해시 */
  readonly cause: NormJudgmentRequirementChange;
  /** 재판단 세션이 받은 규범 입력의 요약 */
  readonly normInput: NormInputSummary;
}

/** 실행 안 판단 세션의 이의 판단 문맥 (M7-11, ADR-115). */
export interface AgentObjectionJudgment {
  /** 원인 이의 기록 순번 */
  readonly causeSeq: number;
  /** 이의가 난 실행 (기록의 연결 실행) */
  readonly runId: Ulid;
  /** 판단 세션이 받은 규범 입력의 요약 */
  readonly normInput: NormInputSummary;
}

/** 실행 안 판단 세션의 검사 실패 판단 문맥 (M7-12, ADR-118). */
export interface AgentCheckJudgment extends CheckJudgmentContext {
  /** 판단 세션이 받은 규범 입력의 요약 */
  readonly normInput: NormInputSummary;
}

type RunJudgment =
  | { readonly kind: 'objection'; readonly context: AgentObjectionJudgment }
  | { readonly kind: 'check'; readonly context: AgentCheckJudgment };

/** 실행 안 판단 문맥: 이의 또는 검사 실패 (둘 다 없으면 요구사항 세션). */
const runJudgmentOf = (input: {
  readonly objection?: AgentObjectionJudgment | undefined;
  readonly check?: AgentCheckJudgment | undefined;
}): RunJudgment | null => {
  if (input.objection !== undefined && input.check !== undefined) {
    throw new Error('이의 판단과 검사 실패 판단을 함께 쓸 수 없다');
  }
  if (input.objection !== undefined) return { kind: 'objection', context: input.objection };
  if (input.check !== undefined) return { kind: 'check', context: input.check };
  return null;
};

export interface AgentRetireResult extends RetirementWrite {
  /** 폐기된 규칙 (폐기 직전 내용) */
  readonly rule: Rule;
  /** 이의 판단 기록 (이의 판단일 때만) */
  readonly judgment: NormChangeEntry | null;
}

/**
 * 실행 안 판단 기록 (부른 쪽 트랜잭션 안): 대상 규칙 하나에 대한 폐기 · 대체 · 유지. 이의 판단은 결과 그대로(주제 `objection`),
 * 검사 실패 판단은 유지 = 모순 없음 · 폐기 · 대체 = 모순(주제 `check_failure`, 모순 대상 = 실행의 대상 규칙)으로 남긴다. 같은 이의 ·
 * 같은 실행의 같은 규칙에 판단이 이미 있으면 거부한다.
 * @throws {NormRetirementInputError} 이미 판단함 · 검사 실패 판단의 대상이 실패한 규칙이 아님
 */
const writeRunJudgment = (
  store: ProjectStore,
  input: {
    readonly target: Rule;
    readonly author: AgentAuthor;
    readonly at: string;
    readonly sessionId: Ulid;
    readonly grounds: string;
    readonly verdict: 'upheld' | 'retired' | 'superseded';
    readonly createdSeq?: number;
    readonly judgment: RunJudgment;
  },
): NormChangeEntry => {
  const { target, judgment } = input;
  const { requirements, rules } = judgment.context.normInput;
  const counts = {
    requirements: { total: requirements.total, included: requirements.included },
    rules: { total: rules.total, included: rules.included },
  };
  const created = input.createdSeq === undefined ? {} : { createdSeq: input.createdSeq };
  if (judgment.kind === 'check') {
    const context = judgment.context;
    if (!context.failures.some((failure) => failure.ruleId === target.id)) {
      throw new NormRetirementInputError(
        'invalid_args',
        `${target.displayId}는 이 검사에서 실패한 판단 대상 규칙이 아님`,
      );
    }
    if (checkJudgmentsOf(store, context.runId).some((entry) => entry.targetRef.id === target.id)) {
      throw new NormRetirementInputError(
        'invalid_args',
        `이 실행의 ${target.displayId}는 이미 판단함 (실행 · 규칙마다 판단은 한 번)`,
      );
    }
    const contradiction = input.verdict !== 'upheld';
    return store.normChanges.append({
      at: input.at,
      kind: 'judgment',
      actor: input.author,
      targetRef: { entity: 'Rule', id: target.id },
      sessionId: input.sessionId,
      runId: context.runId,
      reason: input.grounds,
      detail: {
        judgment: {
          subject: 'check_failure',
          verdict: contradiction ? 'contradiction' : 'no_contradiction',
          contradicts: contradiction
            ? context.targets.map((rule) => ({ id: rule.id, displayId: rule.displayId }))
            : [],
          ...created,
          check: checkFailureCause(context, target.id),
          input: counts,
        },
      },
    });
  }
  const objection = judgment.context;
  const judged = store.normChanges
    .list()
    .some(
      (entry) =>
        entry.kind === 'judgment' &&
        entry.detail.judgment?.subject === 'objection' &&
        entry.detail.judgment.causeSeq === objection.causeSeq &&
        entry.targetRef.id === target.id,
    );
  if (judged) {
    throw new NormRetirementInputError(
      'invalid_args',
      `이 이의의 ${target.displayId}는 이미 판단함 (규칙마다 판단은 한 번)`,
    );
  }
  return store.normChanges.append({
    at: input.at,
    kind: 'judgment',
    actor: input.author,
    targetRef: { entity: 'Rule', id: target.id },
    sessionId: input.sessionId,
    runId: objection.runId,
    reason: input.grounds,
    detail: {
      judgment: {
        subject: 'objection',
        verdict: input.verdict,
        contradicts: [],
        ...created,
        causeSeq: objection.causeSeq,
        input: counts,
      },
    },
  });
};

/**
 * 같은 요구사항 변경(요구사항 · 변경 종류 · 시각 · 본문 해시)의 그 규칙 판단 기록 (판단 없음 포함). 없으면 `undefined`. 같은 시각의
 * 수정 뒤 삭제처럼 시각만 같은 다른 변경은 따로 판단한다 (ADR-116 검토 1회차).
 */
const requirementChangeJudgmentOf = (
  store: ProjectStore,
  cause: NormJudgmentRequirementChange,
  ruleId: Ulid,
): NormChangeEntry | undefined =>
  store.normChanges.list().find((entry) => {
    const judged = entry.detail.judgment;
    const change = judged?.requirementChange;
    return (
      entry.kind === 'judgment' &&
      judged?.subject === 'requirement_change' &&
      change?.requirement.id === cause.requirement.id &&
      change.change === cause.change &&
      change.at === cause.at &&
      change.textHash === cause.textHash &&
      entry.targetRef.id === ruleId
    );
  });

/**
 * 요구사항 변경 판단 기록 (부른 쪽 트랜잭션 안, M7-10 · ADR-116): 자식 규칙 하나에 대한 폐기 · 대체 · 유지. 같은 변경의 같은 규칙에
 * 판단이 이미 있으면(판단 없음 포함) 거부하고, 지운 요구사항의 자식 규칙은 대체하지 못한다.
 * @throws {NormRetirementInputError} 이미 판단함 · 지운 요구사항의 대체
 */
const writeRequirementChangeJudgment = (
  store: ProjectStore,
  input: {
    readonly target: Rule;
    readonly author: AgentAuthor;
    readonly at: string;
    readonly sessionId: Ulid;
    readonly grounds: string;
    readonly verdict: 'upheld' | 'retired' | 'superseded';
    readonly createdSeq?: number;
    readonly judgment: AgentRequirementChangeJudgment;
  },
): NormChangeEntry => {
  const { target, judgment } = input;
  const { cause } = judgment;
  if (cause.change === 'deleted' && input.verdict === 'superseded') {
    throw new NormRetirementInputError(
      'invalid_args',
      `지운 요구사항 ${cause.requirement.displayId}의 자식 규칙은 대체할 수 없음 (폐기 또는 유지)`,
    );
  }
  if (requirementChangeJudgmentOf(store, cause, target.id) !== undefined) {
    throw new NormRetirementInputError(
      'invalid_args',
      `이 요구사항 변경의 ${target.displayId}는 이미 판단함 (규칙마다 판단은 한 번)`,
    );
  }
  const { requirements, rules } = judgment.normInput;
  return store.normChanges.append({
    at: input.at,
    kind: 'judgment',
    actor: input.author,
    targetRef: { entity: 'Rule', id: target.id },
    sessionId: input.sessionId,
    runId: null,
    reason: input.grounds,
    detail: {
      judgment: {
        subject: 'requirement_change',
        verdict: input.verdict,
        contradicts: [],
        ...(input.createdSeq === undefined ? {} : { createdSeq: input.createdSeq }),
        requirementChange: cause,
        input: {
          requirements: { total: requirements.total, included: requirements.included },
          rules: { total: rules.total, included: rules.included },
        },
      },
    },
  });
};

/** @throws {Error} 이의 · 검사 실패 · 요구사항 변경 판단 문맥을 둘 이상 줌 (부르는 쪽 결함, 세 문맥은 서로 배타적이다) */
const assertOneCause = (input: {
  readonly objection?: AgentObjectionJudgment | undefined;
  readonly check?: AgentCheckJudgment | undefined;
  readonly requirementChange?: AgentRequirementChangeJudgment | undefined;
}): void => {
  const given = [input.objection, input.check, input.requirementChange].filter(
    (context) => context !== undefined,
  );
  if (given.length > 1) {
    throw new Error('이의 · 검사 실패 · 요구사항 변경 판단 문맥은 함께 줄 수 없음 (하나만)');
  }
};

/** 판단 문맥에 맞는 판단 기록을 쓴다 (부른 쪽 트랜잭션 안). 문맥이 없으면(요구사항 세션의 폐기 · 대체) `null`. */
const writeCauseJudgment = (
  store: ProjectStore,
  judged: {
    readonly target: Rule;
    readonly author: AgentAuthor;
    readonly at: string;
    readonly sessionId: Ulid;
    readonly grounds: string;
    readonly verdict: 'upheld' | 'retired' | 'superseded';
    readonly createdSeq?: number;
  },
  input: {
    readonly objection?: AgentObjectionJudgment | undefined;
    readonly check?: AgentCheckJudgment | undefined;
    readonly requirementChange?: AgentRequirementChangeJudgment | undefined;
  },
): NormChangeEntry | null => {
  const runJudgment = runJudgmentOf(input);
  if (runJudgment !== null) return writeRunJudgment(store, { ...judged, judgment: runJudgment });
  if (input.requirementChange !== undefined) {
    return writeRequirementChangeJudgment(store, { ...judged, judgment: input.requirementChange });
  }
  return null;
};

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
  assertOneCause(input);
  return store.transaction(() => {
    const rule = resolveTarget(store, input.ruleId);
    assertQuoted(store, rule, input.grounds, input.isKnownCase ?? NO_KNOWN_CASES);
    const at = new Date(clock.now()).toISOString();
    const runJudgment = runJudgmentOf(input);
    // 이의 · 검사 실패 · 요구사항 변경 판단은 폐기 쪽 쓰기 앞에 둔다 (폐기 기록 → 폐기 행 → 확인 풀림의 순서 사이에 끼우지 않는다,
    // ADR-113)
    const judgment = writeCauseJudgment(
      store,
      {
        target: rule,
        author,
        at,
        sessionId: input.sessionId,
        grounds: input.grounds,
        verdict: 'retired',
      },
      input,
    );
    const written = writeRetirement(store, {
      target: rule,
      author,
      at,
      sessionId: input.sessionId,
      runId: runJudgment?.context.runId ?? null,
      grounds: input.grounds,
      supersede: null,
    });
    return { rule, ...written, judgment };
  });
};

/** 대체 입력: 새 규칙(규칙 생성 입력)에 대상 · 근거를 더한 것. `contradiction`은 대상 밖 효력 있는 규칙과의 판단이다. */
export interface AgentSupersedeInput extends AgentRuleInput {
  /** 대체할 규칙의 표시 ID 또는 ID */
  readonly ruleId: string;
  /** 근거 (대상 규칙의 진술 · 케이스 이름 인용 필수, 대체 · 판단 기록의 사유) */
  readonly grounds: string;
  /** 이의 판단이면 그 판단의 원인 · 실행 (M7-11, ADR-115) */
  readonly objection?: AgentObjectionJudgment;
  /** 검사 실패 판단이면 그 판단의 원인 · 실행 (M7-12, ADR-118) */
  readonly check?: AgentCheckJudgment;
  /** 요구사항 변경 판단이면 그 원인 (M7-10, ADR-116). 삭제의 판단은 대체할 수 없다 */
  readonly requirementChange?: AgentRequirementChangeJudgment;
  /**
   * 인용 출처로 쓸 케이스 이름의 기준 (세션이 받은 규범 자료와 같은 `knownCaseMatcher`, M3-37 · ADR-121). 없으면 케이스 이름을
   * 인용 출처로 쓰지 않는다(진술만)
   */
  readonly isKnownCase?: CaseNameFilter;
}

export interface AgentSupersedeResult extends AgentRuleResult {
  /** 대체된(폐기된) 규칙 (폐기 직전 내용) */
  readonly superseded: Rule;
  /** 대체 기록 (`superseded`) + 폐기 기록 */
  readonly retirement: RetirementWrite;
  /** 실행 안 판단 기록 (이의 · 검사 실패 판단일 때만) */
  readonly objectionJudgment: NormChangeEntry | null;
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
  const payload = AgentRulePayload.parse(input.payload);
  const author = AgentAuthorSchema.parse(input.author);
  assertOneCause(input);
  return store.transaction(() => {
    // 대상 · 인용 · 모순 대상은 새 규칙을 만들기 전에 확인한다 (같은 호출이 만들 규칙은 대상이 될 수 없다)
    const target = resolveTarget(store, input.ruleId);
    assertQuoted(store, target, input.grounds, input.isKnownCase ?? NO_KNOWN_CASES);
    const others = resolveContradicts(store, input.contradiction, target);
    const at = new Date(clock.now()).toISOString();
    const runJudgment = runJudgmentOf(input);
    const runId = runJudgment?.context.runId ?? null;
    const created = writeAgentRule(store, {
      payload,
      author,
      at,
      id: clock.newId(),
      sessionId: input.sessionId,
      runId,
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
    // 이의 · 검사 실패 · 요구사항 변경 판단은 새 규칙 쪽 쓰기 뒤 · 폐기 쪽 쓰기 앞 (확인 풀림의 쓰기 순서 사이에 끼우지 않는다, ADR-113)
    const objectionJudgment = writeCauseJudgment(
      store,
      {
        target,
        author,
        at,
        sessionId: input.sessionId,
        grounds: input.grounds,
        verdict: 'superseded',
        createdSeq: created.normChange.seq,
      },
      input,
    );
    const retirement = writeRetirement(store, {
      target,
      author,
      at,
      sessionId: input.sessionId,
      runId,
      grounds: input.grounds,
      supersede: {
        rule: created.rule,
        createdSeq: created.normChange.seq,
        judgmentSeq: created.judgment.seq,
      },
    });
    return { ...created, superseded: target, retirement, objectionJudgment };
  });
};

/**
 * 유지 입력 (`uphold_rule`의 인자에 주체 · 세션 · 판단 문맥을 더한 것, M7-11 · M7-10). 문맥은 이의 판단 · 요구사항 변경 판단 가운데
 * 정확히 하나다.
 */
export type AgentUpholdInput = {
  /** 대상 규칙의 표시 ID 또는 ID */
  readonly ruleId: string;
  /** 근거 (판단 기록의 사유. 이의 판단이면 구현 역할에게 전해진다) */
  readonly grounds: string;
  readonly author: AgentAuthor;
  readonly sessionId: Ulid;
} & (
  | {
      readonly objection: AgentObjectionJudgment;
      readonly check?: undefined;
      readonly requirementChange?: undefined;
    }
  | {
      readonly objection?: undefined;
      /** 검사 실패 판단 문맥 (M7-12: 유지 = 모순 없음) */
      readonly check: AgentCheckJudgment;
      readonly requirementChange?: undefined;
    }
  | {
      readonly objection?: undefined;
      readonly check?: undefined;
      readonly requirementChange: AgentRequirementChangeJudgment;
    }
);

/**
 * 이의 · 검사 실패 판단의 대상 규칙을 유지한다고 판단한다 (트랜잭션 1개: 판단 기록 `judgment` 1건, 주제 `objection` · 결과 `upheld`
 * 또는 주제 `check_failure` · 결과 `no_contradiction`). 규칙 · 인수
 * 테스트 · 폐기 기록은 바꾸지 않는다(M7-11, ADR-115).
 * @throws {ZodError} 주체가 에이전트가 아님 · 빈 근거
 * @throws {NormRetirementInputError} 대상이 없음 · 효력 없음 · 내장 구조 규칙 · 이미 판단함
 */
export const upholdAgentRule = (
  store: ProjectStore,
  input: AgentUpholdInput,
  clock: Pick<AgentRuleClock, 'now'>,
): { readonly rule: Rule; readonly judgment: NormChangeEntry } => {
  const author = AgentAuthorSchema.parse(input.author);
  assertOneCause(input);
  return store.transaction(() => {
    const rule = resolveTarget(store, input.ruleId);
    const judgment = writeCauseJudgment(
      store,
      {
        target: rule,
        author,
        at: new Date(clock.now()).toISOString(),
        sessionId: input.sessionId,
        grounds: input.grounds,
        verdict: 'upheld',
      },
      input,
    );
    if (judgment === null) {
      throw new Error('유지 판단에는 이의 · 검사 실패 · 요구사항 변경 판단 문맥이 필요하다');
    }
    return { rule, judgment };
  });
};

/**
 * 판단 없는 자식 규칙의 유지 기록 사유 (오케스트레이터의 고정 문장, 화면에 그대로 보인다). 종료 사유는
 * `detail.judgment.undecided.endReason`에만 둔다 (ADR-115와 같다).
 */
export const REQUIREMENT_CHANGE_UNDECIDED_REASON =
  '재판단 세션이 이 규칙을 판단하지 못하고 끝나 유지로 봄. 판단 없음은 폐기가 아니다';

/**
 * 요구사항 변경 재판단을 마무리한다 (트랜잭션 1개, M7-10 · ADR-116): 대상 규칙 가운데 그 변경의 판단 기록이 없고 지금도 효력 있는
 * 규칙마다 오케스트레이터 주체의 유지 기록(`undecided`)을 남긴다. 이미 판단했거나(멱등) 효력을 잃은 규칙(다른 세션의 폐기 · 삭제)은
 * 건너뛴다. 판단 없음을 폐기로 보지 않는다. 남긴 기록을 대상 순서대로 돌려준다.
 */
export const settleRequirementChange = (
  store: ProjectStore,
  input: {
    readonly cause: NormJudgmentRequirementChange;
    /** 재판단 세션 (열었으면 연결 세션 ID로 싣는다. 열지 못했으면 `null`) */
    readonly sessionId: Ulid | null;
    readonly ruleIds: readonly Ulid[];
    /** 세션의 종료 사유 또는 열지 못한 사유 (`NormUndecidedReason`의 값) */
    readonly endReason: string;
    /** 세션이 받은 규범 입력의 요약 (열지 못했으면 `null`) */
    readonly normInput: NormInputSummary | null;
  },
  clock: Pick<AgentRuleClock, 'now'>,
): NormChangeEntry[] =>
  store.transaction(() => {
    const retired = retiredRuleSet(store);
    const at = new Date(clock.now()).toISOString();
    const count = (key: 'requirements' | 'rules') => ({
      total: input.normInput?.[key].total ?? 0,
      included: input.normInput?.[key].included ?? 0,
    });
    const written: NormChangeEntry[] = [];
    for (const ruleId of input.ruleIds) {
      const rule = store.rules.get(ruleId);
      if (rule === null || !isEffectiveRule(rule, retired)) continue;
      if (requirementChangeJudgmentOf(store, input.cause, rule.id) !== undefined) continue;
      written.push(
        store.normChanges.append({
          at,
          kind: 'judgment',
          actor: { kind: 'orchestrator' },
          targetRef: { entity: 'Rule', id: rule.id },
          sessionId: input.sessionId,
          runId: null,
          reason: REQUIREMENT_CHANGE_UNDECIDED_REASON,
          detail: {
            judgment: {
              subject: 'requirement_change',
              verdict: 'upheld',
              contradicts: [],
              requirementChange: input.cause,
              undecided: { endReason: input.endReason.slice(0, 64) },
              input: { requirements: count('requirements'), rules: count('rules') },
            },
          },
        }),
      );
    }
    return written;
  });
