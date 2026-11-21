// 요구사항 → 규칙 자동 생성 rule-writer 세션 (NRM-02, NFR-01 · NFR-02 · NFR-07, ADR-009 · ADR-024 · ADR-057 · ADR-062).
// - `requirement.create`가 요구사항을 저장한 같은 저장소 열림 안에서 `start`를 부른다. `start`는 중복 · 설정 검사만
//   동기로 하고 세션은 대기열에서 하나씩 비동기로 돈다(응답을 세션 종료까지 붙잡지 않는다)
// - 설정의 rule-writer 모델 · 한도(`roleSessionSettings(settings, 'rule-writer')`, 실행 전체 한도 검사 포함)가 없으면 세션을 띄우지 않고
//   그 사실을 기록한다. 요구사항 저장 자체는 성공한다 (NRM-01, ADR-062)
// - 세션 도구는 규칙 생성 도구 `propose_rule` 하나다(ADR-024). 호출 1건이 승인 대기 제안 없이 규칙 1개(효력 상태, 미확인,
//   생성 주체 규칙 작성 역할)와 규범 변경 기록 1건(신규)을 트랜잭션 1개로 남긴다(`norms/agent-rule.ts`, M7-02 #214,
//   ADR-100 D1 · C2, ADR-103). 세션 가드가 init의 도구 · MCP 서버 목록을 검사한다(NFR-02)
// - 같은 요구사항에 세션을 두 번 띄우지 않는다: 프로세스 안에서는 요구사항별 기록으로, 재기동 뒤에는 그 요구사항에서
//   규칙 작성 역할이 만든 규칙(또는 이 변경 전의 `rule_generation` 제안)으로 가린다. 재기동 때 끊긴 세션을 다시 띄우지
//   않는다 (PRD 5.1 자동 재개 없음)
// - 세션 기록(도구 호출 · 매니페스트 · 결과)은 메모리 · 로그와 함께 프로젝트 저장소(`sessions` · `tool_calls`,
//   실행 밖 세션, ADR-066)에도 남긴다. 저장 실패는 로그만 남기고 세션을 막지 않는다
// - 중복이 아닌 시도마다 시도 기록(`rule_writer_requests`, 세션 ID와 같은 ID)을 남기고, 세션을 열지 않으면 생략 사유를
//   거기에 채운다. 화면 · `ruleWriter.status`는 이 기록과 세션 기록에서만 상태를 만든다 (M3-26, ADR-099)
// - 시도 기록이 바뀌면(대기 · 시작 · 끝 · 생략) `onChanged`로 알린다 (`event.ruleWriter.changed`)
// - 다시 시도(`retry`): 사람이 요구사항을 직접 편집해 저장했을 때, 가장 최근 시도가 생략 · 실패(`success` 아닌 종료)이고
//   그 요구사항에서 규칙 작성 역할이 만든 규칙(이 변경 전의 규칙 자동 생성 제안 포함)이 없으면 새 시도를 띄운다. 진행 중 · 대기 중이거나 성공한 요구사항은 띄우지 않는다 (ADR-099)
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type AgentRole,
  createUlidGenerator,
  ErrorCode,
  type MissingSetting,
  type Requirement,
  type RuleWriterSkipReason as StoredSkipReason,
  type SessionEndReason,
  SettingsIncompleteData,
  TOOL_CALL_NAME_DISPLAY_MAX,
  type ToolManifestEntry,
} from '@bive/shared';
import { ConflictError, NotFoundError, type ProjectStore } from '@bive/store';

import type {
  AgentAdapter,
  SessionBudget,
  SessionResultEvent,
  ToolResult,
} from '../agent/adapter.js';
import { runGuardedSession } from '../agent/guarded-session.js';
import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { RpcError } from '../ipc/server.js';
import type { TaskTracker } from '../lifecycle.js';
import { createAgentRule } from '../norms/agent-rule.js';
import {
  dailyBudgetReached,
  type DailyBudgetState,
  PROJECT_DAILY_BUDGET_EXCEEDED_TEXT,
  projectDailyBudget,
} from '../settings/project-budget.js';
import { roleSessionSettings } from '../settings/settings-service.js';
import { displayText } from '../text-limit.js';
import type { ProposeRuleInput } from '../tools/definitions.js';
import { createRoleTools, type ToolCallRecord } from '../tools/executor.js';
import { denied, failed, invalidArgs, type IssueList, ok } from '../tools/result.js';
import { RULE_WRITER_SYSTEM_PROMPT, ruleWriterTaskPrompt } from './prompts.js';

/** 이 세션의 역할. 설정 검사도 이 역할만 본다 (ADR-057: 실행 전체 한도는 항상 함께 검사). */
export const RULE_WRITER_ROLE = 'rule-writer' as const satisfies AgentRole;

/**
 * 세션을 띄우지 않은 이유. 저장하는 사유(설정 미비 · 종료 중 · 시작 실패 · 요구사항 없음)는 shared `RuleWriterSkipReason`이고,
 * 중복(같은 요구사항에 이미 세션을 띄웠거나 그 요구사항에서 만든 규칙 · 이 변경 전의 규칙 자동 생성 제안이 있음)은
 * 저장하지 않는다.
 */
export type RuleWriterSkipReason = StoredSkipReason | 'duplicate';

/** 요구사항 하나의 시도 기록이 저장된 뒤 부른다 (`event.ruleWriter.changed`). 던지지 않아야 한다. */
export type RuleWriterChangeListener = (projectId: string, requirementId: string) => void;

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
  /** 이 세션이 바로 반영한 규칙 ID (만든 순서) */
  ruleIds: string[];
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

/** `requirement.create` · `requirement.update` 처리기가 쓰는 창구. 던지지 않는다. */
export interface RuleWriterLauncher {
  start(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult;
  /** 가장 최근 시도가 생략 · 실패일 때만 새 시도를 띄운다. 대상이 아니면 `null` */
  retry(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult | null;
}

export interface RuleWriterServiceOptions {
  /** `$BIVE_HOME` 절대 경로 */
  readonly biveHome: string;
  /** 선택된 어댑터 (`BIVE_AGENT`, 시험은 ScriptedAdapter) */
  readonly adapter: AgentAdapter;
  /** 시계 (ms, 기본 `Date.now`) */
  readonly now?: () => number;
  /** 진행 중 세션이 있으면 유휴 종료를 미룬다 (오케스트레이터의 Lifecycle) */
  readonly tasks?: TaskTracker;
  /** 기록 한 줄 (기본: 버림) */
  readonly log?: (line: string) => void;
  /** `close`가 세션 정리를 기다리는 최대 시간 (기본 5000ms) */
  readonly closeTimeoutMs?: number;
  /** 시도 기록이 저장된 뒤 (기본: 알리지 않음) */
  readonly onChanged?: RuleWriterChangeListener;
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
  readonly #tasks: TaskTracker | undefined;
  readonly #log: (line: string) => void;
  /** 저장소에 세션 행을 만든 기록 ID */
  readonly #persisted = new Set<string>();
  readonly #closeTimeoutMs: number;
  readonly #onChanged: RuleWriterChangeListener | undefined;
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
    this.#onChanged = options.onChanged;
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
    return this.#begin(store, input, false);
  }

  /**
   * 사람이 요구사항을 직접 편집해 저장한 뒤 부른다(같은 저장소 열림). 저장된 가장 최근 시도가 생략이거나 `success`가 아닌
   * 종료일 때만 `start`와 같은 검사(종료 중 · 중복 · 만든 규칙 있음 · 설정)를 거쳐 새 시도를 띄운다. 시도 기록이 없거나
   * 대기 · 진행 중 · 성공이면 `null`. 던지지 않는다.
   */
  retry(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult | null {
    try {
      const latest = store.ruleWriterRequests.latest(input.requirement.id);
      const failed =
        latest !== null &&
        (latest.state === 'skipped' ||
          (latest.state === 'ended' && latest.endReason !== 'success'));
      if (!failed) return null;
    } catch (error) {
      this.#log(
        `규칙 작성 다시 시도 확인 실패 (${input.requirement.displayId}): ${errorMessage(error)}`,
      );
      return null;
    }
    this.#log(`규칙 작성 다시 시도 (${input.requirement.displayId})`);
    return this.#begin(store, input, true);
  }

  #begin(
    store: ProjectStore,
    input: RuleWriterStartInput,
    relaunch: boolean,
  ): RuleWriterStartResult {
    const { projectId, requirement } = input;
    try {
      if (this.#closed) {
        return this.#skip(store, input, 'closed', '오케스트레이터 종료 중', []);
      }
      const launched = this.#launched.get(keyOf(projectId, requirement.id));
      // 다시 시도는 이 프로세스에서 끝난(생략 포함) 세션을 막지 않는다. 대기 · 진행 중이면 중복이다
      const existing =
        relaunch && (launched?.status === 'ended' || launched?.status === 'skipped')
          ? undefined
          : launched;
      if (existing !== undefined || this.#hasGeneratedNorms(store, requirement.id)) {
        this.#log(
          `규칙 작성 생략 (${requirement.displayId}, 이미 세션을 띄웠거나 만든 규칙이 있음)`,
        );
        return {
          status: 'skipped',
          reason: 'duplicate',
          record: existing === undefined ? null : structuredClone(existing),
        };
      }
      let session;
      try {
        // 실행 전체 한도까지 검사하고(ADR-057) rule-writer 모델 · 한도를 쓴다. 실행 밖 세션이라 실행 잔여는 없고,
        // USD 한도는 프로젝트 하루 잔여로 묶는다(ADR-104). 하루 한도에 이르렀으면 세션을 띄우지 않는다
        const settings = store.settings.get();
        const daily = projectDailyBudget(store, settings, this.#now());
        session = roleSessionSettings(
          settings,
          RULE_WRITER_ROLE,
          daily === null ? {} : { maxBudgetUsd: daily.remaining },
        );
        if (dailyBudgetReached(daily)) return this.#skipDaily(store, input, daily);
      } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.SettingsIncomplete) {
          const data = SettingsIncompleteData.safeParse(error.data);
          return this.#skip(
            store,
            input,
            'settings_incomplete',
            error.message,
            data.success ? data.data.missing : [],
          );
        }
        throw error;
      }
      const record = this.#newRecord(input, 'queued');
      record.model = session.model;
      record.budget = { ...session.budget };
      this.#launched.set(keyOf(projectId, requirement.id), record);
      // 시도 기록 저장이 실패해도 세션은 띄운다(세션 행만으로도 시도로 읽힌다)
      this.#saveAttempt(record, () =>
        store.ruleWriterRequests.create({
          id: record.id,
          requirementId: record.requirementId,
          requestedAt: record.createdAt,
        }),
      );
      this.#enqueue(record, requirement);
      return { status: 'queued', record: structuredClone(record) };
    } catch (error) {
      return this.#skip(store, input, 'start_failed', errorMessage(error), []);
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
   * 새 세션을 받지 않고, 진행 중 · 대기 중 세션을 중단한다(기록 `aborted`). 이미 반영된 규칙은 그대로 효력을 갖는다.
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
      ruleIds: [],
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
    store: ProjectStore,
    input: RuleWriterStartInput,
    reason: StoredSkipReason,
    detail: string,
    missing: readonly MissingSetting[],
  ): RuleWriterStartResult {
    const record = this.#newRecord(input, 'skipped');
    record.skipReason = reason;
    record.missing = [...missing];
    record.error = detail;
    const suffix = missing.length > 0 ? `: ${missing.join(', ')}` : '';
    this.#log(`규칙 작성 생략 (${input.requirement.displayId}, ${detail}${suffix})`);
    this.#saveAttempt(record, () =>
      store.ruleWriterRequests.create({
        id: record.id,
        requirementId: record.requirementId,
        requestedAt: record.createdAt,
        skip: { reason, detail, missing, at: record.createdAt },
      }),
    );
    return { status: 'skipped', reason, record: structuredClone(record) };
  }

  /** 하루 한도에 이르러 세션을 띄우지 않는다 (생략 사유 `project_daily_budget_exceeded`, ADR-104). */
  #skipDaily(
    store: ProjectStore,
    input: RuleWriterStartInput,
    daily: DailyBudgetState | null,
  ): RuleWriterStartResult {
    if (daily !== null) this.#logDaily(input.requirement.displayId, daily);
    return this.#skip(
      store,
      input,
      'project_daily_budget_exceeded',
      PROJECT_DAILY_BUDGET_EXCEEDED_TEXT,
      [],
    );
  }

  #logDaily(displayId: string, daily: DailyBudgetState): void {
    this.#log(
      `프로젝트 하루 예산 초과 (${displayId}, ${daily.day.start} 부터, 한도 USD ${String(daily.limit)}, ` +
        `지출 USD ${String(daily.spend.spent)}, 추정 세션 ${String(daily.spend.unknownSessions)}개)`,
    );
  }

  /**
   * 시도 기록을 쓰고(실패는 로그만) 바뀌었음을 알린다. 알림은 지금 저장소 열림 구간이 끝난 뒤 보낸다(ADR-069:
   * 열림 구간 안에서 보내지 않는다).
   */
  #saveAttempt(record: RuleWriterSessionRecord, write: () => unknown): void {
    try {
      write();
    } catch (error) {
      this.#log(
        `규칙 작성 시도 기록 저장 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`,
      );
      return;
    }
    this.#notify(record);
  }

  #notify(record: RuleWriterSessionRecord): void {
    const listener = this.#onChanged;
    if (listener === undefined) return;
    const { projectId, requirementId } = record;
    queueMicrotask(() => {
      try {
        listener(projectId, requirementId);
      } catch (error) {
        this.#log(`규칙 작성 알림 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`);
      }
    });
  }

  /** 세션을 열지 못하고 끝난 시도를 저장소의 시도 기록에 생략으로 남긴다 (실패는 로그만). */
  #saveSkip(
    record: RuleWriterSessionRecord,
    reason: StoredSkipReason,
    detail: string | null,
  ): void {
    this.#saveAttempt(record, () =>
      withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        store.ruleWriterRequests.skip(record.id, {
          reason,
          detail,
          at: record.endedAt ?? this.#timestamp(),
        }),
      ),
    );
  }

  /**
   * 재기동 뒤 중복 방지: 이 요구사항에서 규칙 작성 역할이 이미 규범을 만들었는지. 바로 반영된 규칙(M7-02)과, 이 변경
   * 전부터 있던 규칙 자동 생성 제안(대기 · 처리 무관)을 함께 본다.
   */
  #hasGeneratedNorms(store: ProjectStore, requirementId: string): boolean {
    const madeRule = store.rules
      .listByParent(requirementId)
      .some((rule) => rule.author.kind === 'agent' && rule.author.role === RULE_WRITER_ROLE);
    if (madeRule) return true;
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
    queued: RuleWriterStartInput['requirement'],
  ): Promise<void> {
    if (this.#closed) {
      this.#end(record, 'aborted', '오케스트레이터 종료로 세션을 시작하지 않음');
      return;
    }
    // 대기하는 사이 바뀌었을 수 있으므로 시작 직전에 다시 읽는다: 삭제됐으면 생략, 수정됐으면 최신 본문
    const requirement = this.#reloadRequirement(record, queued);
    if (requirement === null) return;
    const { model } = record;
    if (model === null || record.budget === null) {
      this.#end(record, 'error_during_execution', '세션 설정 없음');
      return;
    }
    // 대기하는 사이 다른 세션이 하루 지출을 늘렸을 수 있으므로 시작 직전에 하루 잔여를 다시 읽는다 (ADR-104)
    const budget = this.#dailyCappedBudget(record, record.budget);
    if (budget === null) return;
    record.budget = budget;
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
    let detail: string | null;
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
            this.#persistToolCall(record, call);
            // 도구 이름은 에이전트가 정한 임의 문자열이다: 줄바꿈 등으로 로그 줄을 꾸미지 못하게 표시 값으로 (ADR-089)
            const name = displayText(call.name, TOOL_CALL_NAME_DISPLAY_MAX).text;
            this.#log(
              `규칙 작성 도구 호출 (${record.requirementDisplayId}, ${name} ${call.status}` +
                `${call.reason === undefined ? '' : ` ${call.reason}`})`,
            );
          },
        },
      });
      this.#persist(record, (store) =>
        store.sessions.start({
          id: record.id,
          runId: null,
          stepId: null,
          requirementId: requirement.id,
          role: RULE_WRITER_ROLE,
          model,
          workDir,
          budget,
          startedAt: record.startedAt ?? this.#timestamp(),
        }),
      );
      if (this.#persisted.has(record.id)) this.#notify(record);
      const outcome = await runGuardedSession({
        adapter: this.#adapter,
        controller,
        spec: {
          role: RULE_WRITER_ROLE,
          systemPrompt: RULE_WRITER_SYSTEM_PROMPT,
          prompt: ruleWriterTaskPrompt(requirement),
          workDir,
          tools,
          budget,
          model,
          vars: {
            projectId: record.projectId,
            requirementId: requirement.id,
            requirementDisplayId: requirement.displayId,
          },
        },
        onInit: (manifest, init) => {
          record.manifest = manifest;
          record.sdkSessionId = init.sessionId;
          tools.setSessionId(init.sessionId);
          this.#persist(record, (store) =>
            store.sessions.recordInit(record.id, {
              sdkSessionId: init.sessionId,
              tools: init.tools,
              mcpServers: init.mcpServers,
            }),
          );
        },
      });
      record.result = outcome.result;
      endReason = outcome.endReason;
      detail = outcome.detail;
    } catch (error) {
      // 작업 폴더 · 도구 준비 실패 (세션 실행 자체의 예외는 runGuardedSession이 분류한다)
      detail = errorMessage(error);
    } finally {
      this.#controllers.delete(controller);
      rmSync(workDir, { recursive: true, force: true });
    }
    this.#end(record, endReason, detail);
  }

  /**
   * 시작 직전의 하루 잔여로 묶은 세션 한도. 하루 한도에 이르렀으면 생략(`project_daily_budget_exceeded`) 기록을 남기고
   * `null`. 하루 지출을 읽지 못하면 시작 실패로 생략한다(한도를 모르고 세션을 열지 않는다).
   */
  #dailyCappedBudget(record: RuleWriterSessionRecord, budget: SessionBudget): SessionBudget | null {
    let reason: StoredSkipReason;
    let detail: string;
    try {
      const daily = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        projectDailyBudget(store, store.settings.get(), this.#now()),
      );
      if (!dailyBudgetReached(daily)) {
        return daily === null
          ? budget
          : { ...budget, maxBudgetUsd: Math.min(budget.maxBudgetUsd, daily.remaining) };
      }
      if (daily !== null) this.#logDaily(record.requirementDisplayId, daily);
      reason = 'project_daily_budget_exceeded';
      detail = PROJECT_DAILY_BUDGET_EXCEEDED_TEXT;
    } catch (error) {
      reason = 'start_failed';
      detail = errorMessage(error);
    }
    record.status = 'skipped';
    record.skipReason = reason;
    record.error = detail;
    record.endedAt = this.#timestamp();
    this.#log(`규칙 작성 생략 (${record.requirementDisplayId}, ${detail})`);
    this.#saveSkip(record, reason, detail);
    return null;
  }

  /** 시작 직전의 요구사항. 삭제 · 없음 · 읽기 실패면 생략 기록을 남기고 `null`. */
  #reloadRequirement(
    record: RuleWriterSessionRecord,
    queued: RuleWriterStartInput['requirement'],
  ): RuleWriterStartInput['requirement'] | null {
    let detail: string;
    try {
      const current = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        store.requirements.get(queued.id),
      );
      if (current !== null && current.deletedAt === null) return current;
      detail = current === null ? '요구사항 없음' : `요구사항 삭제됨 (${current.deletedAt})`;
    } catch (error) {
      detail = errorMessage(error);
    }
    record.status = 'skipped';
    record.skipReason = 'requirement_unavailable';
    record.error = detail;
    record.endedAt = this.#timestamp();
    this.#log(`규칙 작성 생략 (${record.requirementDisplayId}, ${detail})`);
    // 프로젝트 등록이 해제됐으면 저장할 곳이 없어 로그만 남는다
    this.#saveSkip(record, 'requirement_unavailable', detail);
    return null;
  }

  /** 세션 기록을 프로젝트 저장소에 남긴다 (실패는 로그만). 세션 행을 만든 기록은 `#persisted`에 둔다. */
  #persist(record: RuleWriterSessionRecord, fn: (store: ProjectStore) => unknown): void {
    try {
      withRegisteredProjectStore(this.#biveHome, record.projectId, fn);
      this.#persisted.add(record.id);
    } catch (error) {
      this.#log(
        `규칙 작성 세션 기록 저장 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`,
      );
    }
  }

  #persistToolCall(record: RuleWriterSessionRecord, call: ToolCallRecord): void {
    if (!this.#persisted.has(record.id)) return;
    this.#persist(record, (store) =>
      store.sessions.appendToolCall({
        id: this.#newId(),
        runId: null,
        sessionId: record.id,
        at: call.at,
        role: call.role,
        name: call.name,
        argsSummary: call.argsSummary,
        status: call.status,
        reason: call.reason ?? null,
        durationMs: Math.max(0, Math.round(call.durationMs)),
      }),
    );
  }

  #end(record: RuleWriterSessionRecord, endReason: SessionEndReason, detail: string | null): void {
    record.status = 'ended';
    record.endReason = endReason;
    record.error = detail;
    record.endedAt = this.#timestamp();
    const endedAt = record.endedAt;
    if (this.#persisted.has(record.id)) {
      const { result } = record;
      this.#persist(record, (store) =>
        store.sessions.end(record.id, {
          endReason,
          error: detail,
          totalCostUsd: result?.total_cost_usd ?? null,
          numTurns: result?.num_turns ?? null,
          modelUsage: Object.fromEntries(
            Object.entries(result?.modelUsage ?? {}).map(([name, usage]) => [
              name,
              {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadInputTokens: usage.cacheReadInputTokens,
                cacheCreationInputTokens: usage.cacheCreationInputTokens,
                costUsd: usage.costUSD,
              },
            ]),
          ),
          endedAt,
        }),
      );
      this.#notify(record);
    } else {
      // 세션 행을 만들기 전에 끝났다(종료 중 · 준비 실패): 시도 기록에 생략으로 남긴다
      this.#saveSkip(record, endReason === 'aborted' ? 'closed' : 'start_failed', detail);
    }
    const cost = record.result?.total_cost_usd;
    this.#log(
      `규칙 작성 세션 종료 (${record.requirementDisplayId}, ${endReason}, ` +
        `규칙 ${String(record.ruleIds.length)}건, 비용 ${cost === undefined || cost === null ? '없음' : `USD ${String(cost)}`}, ` +
        `턴 ${record.result === null ? '없음' : String(record.result.num_turns)}` +
        `${detail === null ? '' : `, ${detail}`})`,
    );
  }

  /**
   * `propose_rule`(규칙 생성) 콜백: 규칙을 바로 반영하고 규범 변경 기록(신규)을 같은 트랜잭션으로 남긴다.
   * 입력 형식(제목 · EARS 진술 · 검사 종류 등)은 실행기가 이미 검사했다.
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
      const { rule } = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        createAgentRule(
          store,
          {
            payload,
            rationale,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: record.id,
          },
          { now: this.#now, newId: this.#newId },
        ),
      );
      record.ruleIds.push(rule.id);
      return ok(`규칙 ${rule.displayId} 반영 (바로 효력, 사람은 나중에 봄)`);
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
