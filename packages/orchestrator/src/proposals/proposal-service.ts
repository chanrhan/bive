// 제안 등록 · 승인 · 거절 (NRM-04, TODO-01, NFR-01, ADR-027 · ADR-050).
// - 등록(`submit`)은 오케스트레이터 내부 전용이다. 파이프 RPC가 없고, 역할 세션의 제안 도구(#21 `propose_rule` 등)가
//   부른다. 제안은 항상 승인 대기(`pending`)로 들어가고 규범 테이블에는 반영되지 않는다
// - 승인 · 거절은 사람만 한다. 파이프 처리기(`proposal-handlers.ts`)가 토큰 인증된 연결에서만 부른다
// - 승인은 규범 반영 · 제안 처리 · 승인 기록 추가를 트랜잭션 1개로 한다. 하나라도 실패하면 아무것도 남지 않는다
import {
  type AgentAuthor,
  AgentAuthor as AgentAuthorSchema,
  type AppliedNorm,
  type Author,
  createUlidGenerator,
  DomainErrorReason,
  type EntityRef,
  ErrorCode,
  PROPOSAL_PAYLOAD_SCHEMAS,
  type Proposal,
  type ProposalApproveResult,
  type ProposalPayload,
  type ProposalRejectResult,
  type ProposalSource,
  type Risk,
  RuleNewPayload,
  RequirementNewPayload,
  SupportedProposalKind,
  toSchemaIssues,
  type Ulid,
} from '@bive/shared';
import { canonicalJson, ConflictError, NotFoundError, type ProjectStore } from '@bive/store';

import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { RpcError } from '../ipc/server.js';

/** 제안 등록 입력 (`ProposalService.submit`). 표시 ID · diff · 대상 · 상태 · 시각은 서비스가 채운다. */
export interface ProposalSubmitInput {
  /** 지금 등록할 수 있는 종류: 요구사항 신규 · 규칙 신규 (ADR-050) */
  readonly kind: SupportedProposalKind;
  /** 종류별 본문 (`PROPOSAL_PAYLOAD_SCHEMAS[kind]`로 검증) */
  readonly payload: unknown;
  /** 근거 (제안 카드에 표시) */
  readonly rationale: string;
  /** 제안한 에이전트 역할 */
  readonly author: AgentAuthor;
  readonly source: ProposalSource;
  readonly risk?: Risk | null;
  /** 제안이 나온 실행 */
  readonly runId?: Ulid | null;
  readonly adrId?: Ulid | null;
}

export interface ProposalApproveInput {
  readonly id: Ulid;
  readonly author: Author;
  /** 사람이 고친 본문 전체. 원래 본문과 같으면 그대로 승인으로 기록한다 */
  readonly edited?: ProposalPayload;
}

export interface ProposalRejectInput {
  readonly id: Ulid;
  readonly author: Author;
  readonly reason: string;
}

/** 처리 요청이 들어온 연결 (승인 기록 `clientId`). */
export interface DecisionContext {
  readonly clientId: string | null;
}

export interface ProposalClock {
  /** 시각 (ms) */
  readonly now: () => number;
  /** 새 ULID */
  readonly newId: () => Ulid;
}

const timestamp = (clock: ProposalClock): string => new Date(clock.now()).toISOString();

const proposalRef = (id: string): EntityRef => ({ entity: 'Proposal', id });

/** 승인 · 거절 주체는 사람뿐이다 (NFR-01). */
const assertHuman = (author: Author): void => {
  if (author.kind !== 'human') {
    throw new RpcError(
      ErrorCode.Unauthorized,
      '에이전트는 제안을 승인 · 거절할 수 없습니다 (NFR-01)',
    );
  }
};

/** 대기 중인 제안을 찾는다. 없으면 -32004, 이미 처리됐으면 -32009. */
const requirePending = (store: ProjectStore, id: string): Proposal => {
  const proposal = store.proposals.get(id);
  if (proposal === null) throw new RpcError(ErrorCode.NotFound, `제안을 찾을 수 없습니다: ${id}`);
  if (proposal.state !== 'pending') {
    throw new RpcError(ErrorCode.StateConflict, `이미 처리된 제안입니다 (${proposal.state})`);
  }
  return proposal;
};

/** 부모 요구사항이 살아 있는지 확인한다 (등록 시점). */
const assertLiveRequirement = (store: ProjectStore, requirementId: string): void => {
  const requirement = store.requirements.get(requirementId);
  if (requirement === null) throw new NotFoundError('부모 요구사항', requirementId);
  if (requirement.deletedAt !== null) {
    throw new ConflictError(
      '부모 요구사항',
      requirementId,
      `삭제됐습니다 (${requirement.deletedAt})`,
    );
  }
};

/**
 * 열린 저장소에 제안을 승인 대기로 등록한다. 규범 테이블은 건드리지 않는다.
 * @throws {ZodError} 지원하지 않는 종류 · 본문 스키마 위반 · 작성자가 에이전트가 아님
 * @throws {NotFoundError} 규칙 신규의 부모 요구사항이 없음
 * @throws {ConflictError} 규칙 신규의 부모 요구사항이 삭제됨
 */
export const submitProposal = (
  store: ProjectStore,
  input: ProposalSubmitInput,
  clock: ProposalClock,
): Proposal => {
  const kind = SupportedProposalKind.parse(input.kind);
  const author = AgentAuthorSchema.parse(input.author);
  let payload: ProposalPayload;
  let targetRef: EntityRef | null;
  if (kind === 'rule_new') {
    const rule = RuleNewPayload.parse(input.payload);
    assertLiveRequirement(store, rule.parentRequirementId);
    payload = rule;
    targetRef = { entity: 'Requirement', id: rule.parentRequirementId };
  } else {
    payload = RequirementNewPayload.parse(input.payload);
    targetRef = null;
  }
  return store.proposals.create({
    id: clock.newId(),
    kind,
    targetRef,
    payload,
    // 신규 제안의 diff: 없던 것 → 본문
    diff: { before: null, after: payload },
    rationale: input.rationale,
    author,
    source: input.source,
    risk: input.risk ?? null,
    adrId: input.adrId ?? null,
    runId: input.runId ?? null,
    createdAt: timestamp(clock),
  });
};

/** 승인된 본문을 규범으로 반영한다. 생성 주체는 제안한 에이전트다 (ADR-008, ADR-047). */
const applyNorm = (
  store: ProjectStore,
  proposal: Proposal,
  kind: SupportedProposalKind,
  payload: ProposalPayload,
  at: string,
  clock: ProposalClock,
): AppliedNorm => {
  if (kind === 'rule_new') {
    const rule = RuleNewPayload.parse(payload);
    const parent = store.requirements.get(rule.parentRequirementId);
    if (parent === null || parent.deletedAt !== null) {
      throw new RpcError(
        ErrorCode.StateConflict,
        `부모 요구사항이 없거나 삭제됐습니다: ${rule.parentRequirementId}`,
      );
    }
    return {
      entity: 'Rule',
      rule: store.rules.create({
        id: clock.newId(),
        title: rule.title,
        statement: rule.statement,
        kind: rule.kind,
        checkKinds: rule.checkKinds,
        parentRequirementId: rule.parentRequirementId,
        builtin: false,
        // 대상 블록 · 위험도는 M2 이후 (NRM-09)
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: proposal.author,
        normState: 'approved',
        createdAt: at,
      }),
    };
  }
  const requirement = RequirementNewPayload.parse(payload);
  return {
    entity: 'Requirement',
    requirement: store.requirements.create({
      id: clock.newId(),
      text: requirement.text,
      author: proposal.author,
      normState: 'approved',
      createdAt: at,
    }),
  };
};

const appliedRefOf = (applied: AppliedNorm): EntityRef =>
  applied.entity === 'Rule'
    ? { entity: 'Rule', id: applied.rule.id }
    : { entity: 'Requirement', id: applied.requirement.id };

/**
 * 제안을 승인한다(수정 후 승인 포함): 규범 반영 + 제안 처리 + 승인 기록을 한 트랜잭션으로.
 * @throws {RpcError} -32020 에이전트 주체 · -32004 없는 제안 · -32009 이미 처리됨, 부모 요구사항 삭제됨 ·
 *   -32001 수정 본문이 제안 종류와 맞지 않음
 */
export const approveProposal = (
  store: ProjectStore,
  input: ProposalApproveInput,
  context: DecisionContext,
  clock: ProposalClock,
): ProposalApproveResult => {
  assertHuman(input.author);
  return store.transaction(() => {
    const proposal = requirePending(store, input.id);
    const kind = SupportedProposalKind.safeParse(proposal.kind);
    if (!kind.success) {
      throw new RpcError(
        ErrorCode.ValidationFailed,
        `아직 승인할 수 없는 제안 종류: ${proposal.kind}`,
      );
    }
    let payload = PROPOSAL_PAYLOAD_SCHEMAS[kind.data].parse(proposal.payload) as ProposalPayload;
    let edited = false;
    if (input.edited !== undefined) {
      const checked = PROPOSAL_PAYLOAD_SCHEMAS[kind.data].safeParse(input.edited);
      if (!checked.success) {
        throw new RpcError(ErrorCode.ValidationFailed, '수정 본문이 제안 종류와 맞지 않습니다', {
          reason: DomainErrorReason.EditedPayloadInvalid,
          issues: toSchemaIssues(checked.error),
        });
      }
      // 고친 내용이 없으면 그대로 승인으로 기록한다
      if (canonicalJson(checked.data) !== canonicalJson(payload)) {
        payload = checked.data as ProposalPayload;
        edited = true;
      }
    }
    const at = timestamp(clock);
    const applied = applyNorm(store, proposal, kind.data, payload, at, clock);
    const appliedRef = appliedRefOf(applied);
    const decided = store.proposals.decide(proposal.id, {
      state: 'approved',
      decision: edited
        ? { at, by: { kind: 'human' }, appliedRef, editedPayload: payload }
        : { at, by: { kind: 'human' }, appliedRef },
    });
    const approvalLog = store.approvalLog.append({
      at,
      action: edited ? 'approve_edited' : 'approve',
      actor: { kind: 'human' },
      targetRef: proposalRef(proposal.id),
      clientId: context.clientId,
      detail: edited
        ? { diff: { before: proposal.payload, after: payload }, appliedRef }
        : { appliedRef },
    });
    return { proposal: decided, applied, approvalLog };
  });
};

/**
 * 제안을 거절한다: 제안 처리 + 승인 기록을 한 트랜잭션으로. 규범은 바뀌지 않는다.
 * @throws {RpcError} -32020 에이전트 주체 · -32001 빈 사유(`REJECT_REASON_REQUIRED`) · -32004 없는 제안 ·
 *   -32009 이미 처리됨
 */
export const rejectProposal = (
  store: ProjectStore,
  input: ProposalRejectInput,
  context: DecisionContext,
  clock: ProposalClock,
): ProposalRejectResult => {
  assertHuman(input.author);
  if (input.reason.trim().length === 0) {
    throw new RpcError(ErrorCode.ValidationFailed, '거절 사유가 필요합니다 (NRM-04)', {
      reason: DomainErrorReason.RejectReasonRequired,
    });
  }
  return store.transaction(() => {
    const proposal = requirePending(store, input.id);
    const at = timestamp(clock);
    const decided = store.proposals.decide(proposal.id, {
      state: 'rejected',
      decision: { at, by: { kind: 'human' }, rejectReason: input.reason },
    });
    const approvalLog = store.approvalLog.append({
      at,
      action: 'reject',
      actor: { kind: 'human' },
      targetRef: proposalRef(proposal.id),
      clientId: context.clientId,
      detail: { reason: input.reason },
    });
    return { proposal: decided, approvalLog };
  });
};

export interface ProposalServiceDeps {
  /** `$BIVE_HOME` 절대 경로 */
  readonly biveHome: string;
  /** 시계 (ms, 기본 `Date.now`) */
  readonly now?: () => number;
}

/**
 * 오케스트레이터 내부의 제안 등록 창구. 역할 세션의 제안 도구가 쓴다 (파이프 RPC 없음, NFR-01).
 * 프로젝트 저장소를 요청마다 열고 닫는다.
 */
export class ProposalService {
  readonly #biveHome: string;
  readonly #clock: ProposalClock;

  constructor({ biveHome, now = Date.now }: ProposalServiceDeps) {
    this.#biveHome = biveHome;
    this.#clock = { now, newId: createUlidGenerator(now) };
  }

  /**
   * 제안을 승인 대기로 등록한다.
   * @throws {RpcError} -32004 등록되지 않은 프로젝트
   * @throws {ZodError} 지원하지 않는 종류 · 본문 스키마 위반 · 작성자가 에이전트가 아님
   * @throws {NotFoundError} 규칙 신규의 부모 요구사항이 없음
   * @throws {ConflictError} 규칙 신규의 부모 요구사항이 삭제됨
   */
  submit(projectId: string, input: ProposalSubmitInput): Proposal {
    return withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
      submitProposal(store, input, this.#clock),
    );
  }
}
