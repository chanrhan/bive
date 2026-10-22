// 요구사항 → 규칙 자동 생성 rule-writer 세션 (NRM-02, NFR-01 · NFR-02 · NFR-07, ADR-009 · ADR-024 · ADR-057 · ADR-062).
// - `requirement.create`가 요구사항을 저장한 같은 저장소 열림 안에서 `start`를 부른다. `start`는 중복 · 설정 검사만
//   동기로 하고 세션은 대기열에서 하나씩 비동기로 돈다(응답을 세션 종료까지 붙잡지 않는다)
// - 설정의 rule-writer 모델 · 한도(`requireRunnableSettings(store, ['rule-writer'])`)가 없으면 세션을 띄우지 않고
//   그 사실을 기록한다. 요구사항 저장 자체는 성공한다 (NRM-01, ADR-062)
// - 세션 도구는 `propose_rule` 하나다(ADR-024). 제안은 `ProposalService.submit`으로 승인 대기(`pending`)에만 들어가고
//   규칙 테이블은 건드리지 않는다(NRM-04). 세션 가드가 init의 도구 · MCP 서버 목록을 검사한다(NFR-02)
// - 같은 요구사항에 세션을 두 번 띄우지 않는다: 프로세스 안에서는 요구사항별 기록으로, 재기동 뒤에는 저장된
//   `rule_generation` 제안으로 가린다. 재기동 때 끊긴 세션을 다시 띄우지 않는다 (PRD 5.1 자동 재개 없음)
// - 세션 기록(도구 호출 · 매니페스트 · 결과)은 메모리와 로그에만 남긴다. 저장은 실행 기록 저장(M1-14)이 맡는다
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type AgentRole,
  createUlidGenerator,
  ErrorCode,
  type MissingSetting,
  type Requirement,
  type SessionEndReason,
  SettingsIncompleteData,
  type ToolManifestEntry,
} from '@bive/shared';
import { ConflictError, NotFoundError, type ProjectStore } from '@bive/store';

import type {
  AgentAdapter,
  SessionBudget,
  SessionResultEvent,
  ToolResult,
} from '../agent/adapter.js';
import { RpcError } from '../ipc/server.js';
import type { TaskTracker } from '../lifecycle.js';
import { ProposalService } from '../proposals/proposal-service.js';
import { requireRunnableSettings } from '../settings/settings-service.js';
import type { ProposeRuleInput } from '../tools/definitions.js';
import { createRoleTools, type ToolCallRecord } from '../tools/executor.js';
import { denied, failed, invalidArgs, type IssueList, ok } from '../tools/result.js';
import { guardSession, SessionGuardError } from '../tools/session-guard.js';
import { RULE_WRITER_SYSTEM_PROMPT, ruleWriterTaskPrompt } from './prompts.js';

/** 이 세션의 역할. 설정 검사도 이 역할만 본다 (ADR-057: 실행 전체 한도는 항상 함께 검사). */
export const RULE_WRITER_ROLE = 'rule-writer' as const satisfies AgentRole;
const RULE_WRITER_ROLES = [RULE_WRITER_ROLE] as const;

/** 세션을 띄우지 않은 이유. */
export type RuleWriterSkipReason =
  /** 설정의 rule-writer 모델 · 한도 또는 실행 전체 한도가 비어 있음 (NFR-07) */
  | 'settings_incomplete'
  /** 같은 요구사항에 이미 세션을 띄웠거나 규칙 자동 생성 제안이 있음 */
  | 'duplicate'
  /** 오케스트레이터가 종료 중 */
  | 'closed'
  /** 시작 준비 중 예상하지 못한 오류 */
  | 'start_failed';

export type RuleWriterSessionStatus = 'skipped' | 'queued' | 'running' | 'ended';

/** rule-writer 세션 1개의 기록 (메모리, 저장은 M1-14). */
export interface RuleWriterSessionRecord {
  /** 기록 ID = 세션 작업 폴더 이름 (ULID) */
  readonly id: string;
  readonly projectId: string;
  readonly requirementId: string;
  readonly requirementDisplayId: string;
  status: RuleWriterSessionStatus;
  /** `skipped`일 때만 */
  skipReason: RuleWriterSkipReason | null;
  /** `settings_incomplete`일 때 비어 있는 설정 항목 */
  missing: MissingSetting[];
  /** 세션 시작에 쓴 설정의 rule-writer 모델 (생략이면 `null`) */
  model: string | null;
  /** 세션 시작에 쓴 설정의 rule-writer 한도 */
  budget: SessionBudget | null;
  /** init에 보고된 도구 목록 · MCP 수 (NFR-02, 위반이어도 기록) */
  manifest: ToolManifestEntry | null;
  /** init의 세션 ID */
  sdkSessionId: string | null;
  /** 모든 도구 호출 (거부 · 오류 포함, ADR-052) */
  toolCalls: ToolCallRecord[];
  /** 이 세션이 등록한 제안 ID (등록 순서) */
  proposalIds: string[];
  /** 결과 메시지 (없으면 `null`) */
  result: SessionResultEvent | null;
  /** 종료 사유 (`ended`일 때) */
  endReason: SessionEndReason | null;
  /** 생략 · 실패 설명 */
  error: string | null;
  readonly createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RuleWriterStartInput {
  readonly projectId: string;
  /** 방금 저장한 요구사항 */
  readonly requirement: Pick<Requirement, 'id' | 'displayId' | 'text'>;
}

export type RuleWriterStartResult =
  | { readonly status: 'queued'; readonly record: RuleWriterSessionRecord }
  | {
      readonly status: 'skipped';
      readonly reason: RuleWriterSkipReason;
      /** 새로 남긴 생략 기록. 중복이면 이미 있는 기록(없으면 `null`) */
      readonly record: RuleWriterSessionRecord | null;
    };

/** `requirement.create` 처리기가 쓰는 창구. 던지지 않는다. */
export interface RuleWriterLauncher {
  start(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult;
}

export interface RuleWriterServiceOptions {
  /** `$BIVE_HOME` 절대 경로 */
  readonly biveHome: string;
  /** 선택된 어댑터 (`BIVE_AGENT`, 시험은 ScriptedAdapter) */
  readonly adapter: AgentAdapter;
  /** 시계 (ms, 기본 `Date.now`) */
  readonly now?: () => number;
  /** 제안 등록 창구 (기본: 같은 BIVE_HOME · 시계의 새 인스턴스) */
  readonly proposals?: ProposalService;
  /** 진행 중 세션이 있으면 유휴 종료를 미룬다 (오케스트레이터의 Lifecycle) */
  readonly tasks?: TaskTracker;
  /** 기록 한 줄 (기본: 버림) */
  readonly log?: (line: string) => void;
  /** `close`가 세션 정리를 기다리는 최대 시간 (기본 5000ms) */
  readonly closeTimeoutMs?: number;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

const keyOf = (projectId: string, requirementId: string): string =>
  `${projectId}\u0000${requirementId}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isIssueList = (error: unknown): error is Error & IssueList =>
  error instanceof Error &&
  error.name === 'ZodError' &&
  Array.isArray((error as Partial<IssueList>).issues);

export class RuleWriterService implements RuleWriterLauncher {
  readonly #biveHome: string;
  readonly #adapter: AgentAdapter;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #proposals: ProposalService;
  readonly #tasks: TaskTracker | undefined;
  readonly #log: (line: string) => void;
  readonly #closeTimeoutMs: number;
  /** 모든 기록 (생략 포함, 만든 순서) */
  readonly #records: RuleWriterSessionRecord[] = [];
  /** 세션을 띄운(대기열에 넣은) 요구사항 → 기록 */
  readonly #launched = new Map<string, RuleWriterSessionRecord>();
  /** 기록 ID → 세션이 끝나면 풀리는 약속 */
  readonly #settled = new Map<string, Promise<void>>();
  readonly #controllers = new Set<AbortController>();
  /** 세션을 하나씩 돌리는 대기열 */
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: RuleWriterServiceOptions) {
    this.#biveHome = options.biveHome;
    this.#adapter = options.adapter;
    this.#now = options.now ?? Date.now;
    this.#newId = createUlidGenerator(this.#now);
    this.#proposals =
      options.proposals ?? new ProposalService({ biveHome: options.biveHome, now: this.#now });
    this.#tasks = options.tasks;
    const log = options.log;
    // 기록 함수의 예외가 요구사항 저장 · 세션을 깨지 않게 한다
    this.#log = (line) => {
      try {
        log?.(line);
      } catch {
        // 기록 실패는 무시한다
      }
    };
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  }

  /** 기록 사본 (만든 순서). */
  get records(): readonly RuleWriterSessionRecord[] {
    return this.#records.map((record) => structuredClone(record));
  }

  /** 요구사항의 기록 사본 (만든 순서). */
  recordsFor(projectId: string, requirementId: string): RuleWriterSessionRecord[] {
    return this.#records
      .filter((record) => record.projectId === projectId && record.requirementId === requirementId)
      .map((record) => structuredClone(record));
  }

  /**
   * 요구사항 저장 직후 부른다. 같은 저장소 열림에서 중복 · 설정을 검사하고, 통과하면 세션을 대기열에 넣는다.
   * 던지지 않는다(요구사항 저장 응답을 바꾸지 않음).
   */
  start(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult {
    const { projectId, requirement } = input;
    try {
      if (this.#closed) {
        return this.#skip(input, 'closed', '오케스트레이터 종료 중', []);
      }
      const existing = this.#launched.get(keyOf(projectId, requirement.id));
      if (existing !== undefined || this.#hasGeneratedProposals(store, requirement.id)) {
        this.#log(`규칙 작성 생략 (${requirement.displayId}, 이미 세션을 띄웠거나 제안이 있음)`);
        return {
          status: 'skipped',
          reason: 'duplicate',
          record: existing === undefined ? null : structuredClone(existing),
        };
      }
      let settings;
      try {
        settings = requireRunnableSettings(store, RULE_WRITER_ROLES);
      } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.SettingsIncomplete) {
          const data = SettingsIncompleteData.safeParse(error.data);
          return this.#skip(
            input,
            'settings_incomplete',
            error.message,
            data.success ? data.data.missing : [],
          );
        }
        throw error;
      }
      const role = settings.roles[RULE_WRITER_ROLE];
      // requireRunnableSettings를 통과했으므로 세 값 모두 있다
      if (role.model === null || role.maxBudgetUsd === null || role.maxTurns === null) {
        throw new Error('rule-writer 설정 검사 뒤 값이 비어 있음');
      }
      const record = this.#newRecord(input, 'queued');
      record.model = role.model;
      record.budget = { maxBudgetUsd: role.maxBudgetUsd, maxTurns: role.maxTurns };
      this.#launched.set(keyOf(projectId, requirement.id), record);
      this.#enqueue(record, requirement);
      return { status: 'queued', record: structuredClone(record) };
    } catch (error) {
      return this.#skip(input, 'start_failed', errorMessage(error), []);
    }
  }

  /** 요구사항의 세션이 끝날 때까지 기다린다 (없거나 생략이면 바로). */
  async whenSettled(projectId: string, requirementId: string): Promise<void> {
    const record = this.#launched.get(keyOf(projectId, requirementId));
    if (record !== undefined) await this.#settled.get(record.id);
  }

  /** 대기열이 빌 때까지 기다린다 (기다리는 사이 들어온 세션 포함). */
  async idle(): Promise<void> {
    for (;;) {
      const current = this.#chain;
      await current;
      if (current === this.#chain) return;
    }
  }

  /**
   * 새 세션을 받지 않고, 진행 중 · 대기 중 세션을 중단한다(기록 `aborted`). 이미 등록된 제안은 승인 대기로 남는다.
   * 세션이 중단 신호를 따르지 않아도 `closeTimeoutMs` 뒤에는 돌아온다.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort(new Error('오케스트레이터 종료'));
    const timeout = new AbortController();
    await Promise.race([
      this.idle(),
      delay(this.#closeTimeoutMs, undefined, { signal: timeout.signal }).catch(() => undefined),
    ]);
    timeout.abort();
  }

  #timestamp(): string {
    return new Date(this.#now()).toISOString();
  }

  #newRecord(
    input: RuleWriterStartInput,
    status: RuleWriterSessionStatus,
  ): RuleWriterSessionRecord {
    const record: RuleWriterSessionRecord = {
      id: this.#newId(),
      projectId: input.projectId,
      requirementId: input.requirement.id,
      requirementDisplayId: input.requirement.displayId,
      status,
      skipReason: null,
      missing: [],
      model: null,
      budget: null,
      manifest: null,
      sdkSessionId: null,
      toolCalls: [],
      proposalIds: [],
      result: null,
      endReason: null,
      error: null,
      createdAt: this.#timestamp(),
      startedAt: null,
      endedAt: null,
    };
    this.#records.push(record);
    return record;
  }

  #skip(
    input: RuleWriterStartInput,
    reason: RuleWriterSkipReason,
    detail: string,
    missing: readonly MissingSetting[],
  ): RuleWriterStartResult {
    const record = this.#newRecord(input, 'skipped');
    record.skipReason = reason;
    record.missing = [...missing];
    record.error = detail;
    const suffix = missing.length > 0 ? `: ${missing.join(', ')}` : '';
    this.#log(`규칙 작성 생략 (${input.requirement.displayId}, ${detail}${suffix})`);
    return { status: 'skipped', reason, record: structuredClone(record) };
  }

  /** 재기동 뒤 중복 방지: 이 요구사항을 부모로 하는 규칙 자동 생성 제안이 이미 있는지. */
  #hasGeneratedProposals(store: ProjectStore, requirementId: string): boolean {
    return store.proposals
      .list({ kind: 'rule_new' })
      .some(
        (proposal) =>
          proposal.source === 'rule_generation' &&
          proposal.targetRef?.entity === 'Requirement' &&
          proposal.targetRef.id === requirementId,
      );
  }

  #enqueue(
    record: RuleWriterSessionRecord,
    requirement: RuleWriterStartInput['requirement'],
  ): void {
    const task = this.#tasks?.beginTask();
    const settled = this.#chain.then(async () => {
      try {
        await this.#run(record, requirement);
      } catch (error) {
        // #run은 던지지 않지만, 대기열이 끊기지 않도록 한 번 더 막는다
        if (record.status !== 'ended')
          this.#end(record, 'error_during_execution', errorMessage(error));
      } finally {
        task?.end();
      }
    });
    this.#settled.set(record.id, settled);
    this.#chain = settled;
  }

  /** 세션 1개를 끝까지 돌린다. 던지지 않는다. */
  async #run(
    record: RuleWriterSessionRecord,
    requirement: RuleWriterStartInput['requirement'],
  ): Promise<void> {
    if (this.#closed) {
      this.#end(record, 'aborted', '오케스트레이터 종료로 세션을 시작하지 않음');
      return;
    }
    const { model, budget } = record;
    if (model === null || budget === null) {
      this.#end(record, 'error_during_execution', '세션 설정 없음');
      return;
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const workDir = path.join(this.#biveHome, 'work', record.projectId, 'sessions', record.id);
    record.status = 'running';
    record.startedAt = this.#timestamp();
    this.#log(
      `규칙 작성 세션 시작 (${record.requirementDisplayId}, 모델 ${model}, ` +
        `한도 USD ${String(budget.maxBudgetUsd)} · 턴 ${String(budget.maxTurns)})`,
    );
    let endReason: SessionEndReason = 'error_during_execution';
    let detail: string | null = null;
    try {
      // rule-writer는 파일 도구가 없으므로 작업 폴더는 비어 있다 (ADR-024 허용 목록 방식)
      mkdirSync(workDir, { recursive: true, mode: 0o700 });
      const tools = createRoleTools({
        role: RULE_WRITER_ROLE,
        sessionRoot: workDir,
        biveHome: this.#biveHome,
        now: () => new Date(this.#now()),
        hooks: {
          proposeRule: (input) => this.#propose(record, input),
          onToolCall: (call) => {
            record.toolCalls.push(call);
            this.#log(
              `규칙 작성 도구 호출 (${record.requirementDisplayId}, ${call.name} ${call.status}` +
                `${call.reason === undefined ? '' : ` ${call.reason}`})`,
            );
          },
        },
      });
      const events = guardSession(
        this.#adapter.startSession({
          role: RULE_WRITER_ROLE,
          systemPrompt: RULE_WRITER_SYSTEM_PROMPT,
          prompt: ruleWriterTaskPrompt(requirement),
          workDir,
          tools,
          budget,
          model,
          signal: controller.signal,
          vars: {
            projectId: record.projectId,
            requirementId: requirement.id,
            requirementDisplayId: requirement.displayId,
          },
        }),
        {
          role: RULE_WRITER_ROLE,
          controller,
          onManifest: (manifest, init) => {
            record.manifest = manifest;
            record.sdkSessionId = init.sessionId;
            tools.setSessionId(init.sessionId);
          },
        },
      );
      for await (const event of events) {
        if (event.type === 'result') record.result = event;
      }
      if (record.result === null) {
        detail = '결과 메시지 없이 세션이 끝남';
      } else {
        endReason = record.result.subtype;
      }
    } catch (error) {
      if (error instanceof SessionGuardError) {
        endReason = 'guard_violation';
      } else if (controller.signal.aborted) {
        endReason = 'aborted';
      }
      detail = errorMessage(error);
    } finally {
      this.#controllers.delete(controller);
      rmSync(workDir, { recursive: true, force: true });
    }
    this.#end(record, endReason, detail);
  }

  #end(record: RuleWriterSessionRecord, endReason: SessionEndReason, detail: string | null): void {
    record.status = 'ended';
    record.endReason = endReason;
    record.error = detail;
    record.endedAt = this.#timestamp();
    const cost = record.result?.total_cost_usd;
    this.#log(
      `규칙 작성 세션 종료 (${record.requirementDisplayId}, ${endReason}, ` +
        `제안 ${String(record.proposalIds.length)}건, 비용 ${cost === undefined || cost === null ? '없음' : `USD ${String(cost)}`}, ` +
        `턴 ${record.result === null ? '없음' : String(record.result.num_turns)}` +
        `${detail === null ? '' : `, ${detail}`})`,
    );
  }

  /**
   * `propose_rule` 등록 콜백. 입력 형식(제목 · EARS 진술 · 검사 종류 등)은 실행기가 이미 검사했다.
   * - 부모가 이 세션의 요구사항이 아니면 `denied`(`invalid_args`)
   * - 부모 요구사항 · 프로젝트가 없으면 `error`(`not_found`), 부모가 삭제됐으면 `error`(`state_conflict`)
   */
  async #propose(record: RuleWriterSessionRecord, input: ProposeRuleInput): Promise<ToolResult> {
    if (input.parentRequirementId !== record.requirementId) {
      return denied(
        'invalid_args',
        `propose_rule 인자 오류: parentRequirementId는 이 세션의 요구사항 ${record.requirementId}만 쓸 수 있음`,
      );
    }
    const { rationale, ...payload } = input;
    try {
      const proposal = this.#proposals.submit(record.projectId, {
        kind: 'rule_new',
        payload,
        rationale,
        author: { kind: 'agent', role: RULE_WRITER_ROLE },
        source: 'rule_generation',
      });
      record.proposalIds.push(proposal.id);
      return ok(`제안 ${proposal.displayId} 등록 (승인 대기)`);
    } catch (error) {
      if (error instanceof ConflictError) {
        return failed('state_conflict', `부모 요구사항이 삭제됨: ${input.parentRequirementId}`);
      }
      if (error instanceof NotFoundError) {
        return failed('not_found', `부모 요구사항 없음: ${input.parentRequirementId}`);
      }
      if (error instanceof RpcError && error.code === ErrorCode.NotFound) {
        return failed('not_found', error.message);
      }
      if (isIssueList(error)) return invalidArgs('propose_rule', error);
      throw error;
    }
  }
}
