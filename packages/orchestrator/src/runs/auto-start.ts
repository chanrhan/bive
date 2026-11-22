// 실행 자동 시작 (RUN-01 · RUN-02 · NFR-07, ADR-100 D1 · B⑤ · B⑥ · A2 · A12 · C2, M7-05 #217 · M7-19 #244, ADR-107 · ADR-110 ·
// ADR-111).
// - 규칙 작성 세션이 규칙을 만들고 정상 종료하면, 오케스트레이터가 세션이 끝난 뒤 그 세션이 만든 규칙마다 실행 1개를
//   (규칙 N개면 실행 N개, 신규 기록 순번 순) 사람 확인 없이 만든다(ADR-110). 에이전트 세션에는 실행을 만드는 도구가 없다:
//   이 모듈은 규칙 작성 서비스의 세션 종료 알림을 받는 오케스트레이터 배선(`orchestrator.ts`)만 가져온다
// - 실행 N개의 저장(`saveNewRun`, 사람의 [실행]과 같은 모양 `waiting_approval`, 대상 규칙 1개)과 규범 변경 기록 자동 시작 항목
//   N건(실행마다 1건, 주체 오케스트레이터, 원인 = 그 규칙의 신규 기록 순번 1개, 실행 ID)을 트랜잭션 1개로 남긴다. 하나라도
//   실패하면 아무것도 남지 않는다. 승인 기록에는 쓰지 않는다(C2: 사람 행동만)
// - 저장 뒤 엔진의 `onRunCreated`를 만든 순서대로 실행마다 부른다: 승인 단계(효력 확인) → 첫 실행은 진행 중, 나머지는 프로젝트에
//   자리가 없어 실행 대기(B⑥, ADR-105). 실행 대기에 선 자동 시작 실행은 시작할 차례에 하루 한도를 다시 본다(ADR-111)
// - 만들지 않는 경우: 세션이 규칙을 하나도 만들지 못함 · 정상 종료가 아님(규칙 작성 실패 · 한도 초과 · 가드 위반 · 중단),
//   하루 한도가 비어 있음(B⑤) · 오늘 지출이 하루 한도에 이름(A12) · 실행이 쓰는 역할의 설정 미비. 뒤의 셋은 세션마다 생략
//   기록(`auto_start_skips`) 1건에 남겨 요구사항 상세의 규칙 작성 상태 줄이 보인다(실행은 하나도 만들지 않는다)
// - 멱등: 그 세션의 원인 순번 중 하나라도 쓰는 자동 시작 항목이 이미 있으면(또는 그 세션의 생략 기록이 있으면) 아무것도 만들지
//   않는다. 일부 원인만 쓰인 상태(저장소 밖 변조로만 생긴다)에서도 나머지를 채우지 않는다. 검사와 저장이 같은 쓰기
//   트랜잭션이라 두 번 불려도 실행은 N개다. 엔진의 시작 근거 대조도 원인 순번의 재사용을 거부한다
// - 멈춤 장치는 하루 예산뿐이다(ADR-100 D8 · B⑤). 요구사항 세션은 사람의 요구사항 저장 · 편집에서만 시작한다. 실행 안의 판단
//   세션(구현 역할의 이의, M7-11 · ADR-115)이 대체로 새 규칙을 만들면 그 세션 종료 뒤 이 모듈이 새 실행을 만든다: "실행 → 판단 →
//   대체 → 자동 시작"의 연쇄가 생길 수 있고 그것을 끊는 것도 하루 예산뿐이다(ADR-115에 근거와 비용)
// - 기존 규칙 모순으로 끝난 실행의 대상 규칙 다시 시작(M7-12 #224, ADR-100 B⑧ · A4, ADR-118, {@link restartAfterContradiction}):
//   검사 단계 · 병합 재검사에서 대상 밖 규칙이 모순으로 판단돼 폐기 · 대체되면 그 실행은 병합 없이 끝난다. 그 실행의 대상 규칙(아직
//   병합되지 못한 새 규칙)은 실행이 끝난 뒤 대상 규칙마다 실행 1개로 다시 시작한다(원인 = 그 실행의 첫 모순 판단 기록 순번, 대상 규칙
//   1개). 대체로 생긴 규칙의 실행은 판단 세션 종료 뒤 위의 기존 경로가 만든다(신규 기록이 원인). 하루 한도 문 · 멱등(같은 원인 ·
//   같은 대상 규칙은 한 번)은 같고, 생략은 기록하지 않는다(로그만). 실행 종료 저장 이벤트를 받는 오케스트레이터 배선이 부른다
import {
  type AutoStartSkipReason,
  createUlidGenerator,
  type MissingSetting,
  type NormChangeEntry,
  type SessionEndReason,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

import type { EngineEvent } from '../engine/types.js';
import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { contradictionJudgmentsOf } from '../norms/check-contradiction.js';
import { isEffectiveRule, retiredRuleSet } from '../norms/effective.js';
import { autoStartBlock } from '../settings/auto-start-gate.js';
import { saveNewRun } from './run-service.js';

/** 자동 시작을 부르는 규칙 작성 역할 (그 역할이 만든 신규 기록만 원인이 된다). */
const RULE_WRITER_ROLE = 'rule-writer';

/** 자동 시작 항목의 사유 (주체가 오케스트레이터라 필수는 아니지만 기록을 읽는 사람을 위해 남긴다). */
export const AUTO_START_REASON = '규칙 작성 세션이 만든 규칙의 실행 자동 시작';

/** 자동 시작한 실행 1개와 그 시작 근거(자동 시작 항목). */
export interface AutoStartedRun {
  readonly detail: RunDetail;
  readonly normChange: NormChangeEntry;
}

export type AutoStartOutcome =
  /** 규칙마다 실행을 만들고 실행마다 자동 시작 항목을 남겼다 (신규 기록 순번 순) */
  | { readonly status: 'started'; readonly runs: readonly AutoStartedRun[] }
  /** 만들지 않고 생략 기록을 남겼다 */
  | {
      readonly status: 'skipped';
      readonly reason: AutoStartSkipReason;
      readonly missing: MissingSetting[];
    }
  /** 세션이 만든 규칙이 없다 (기록 없음) */
  | { readonly status: 'no_rules' }
  /** 같은 원인으로 이미 실행을 만들었거나(그 실행들, 항목 순번 순) 생략했다(빈 목록). 기록 없음 */
  | { readonly status: 'duplicate'; readonly runIds: readonly Ulid[] };

export interface AutoStartClock {
  readonly now: () => number;
  readonly newId: () => Ulid;
}

/** 세션이 만든 규칙의 신규 기록 (만든 순서 = 순번 순). */
const creationsOf = (changes: readonly NormChangeEntry[], sessionId: string): NormChangeEntry[] =>
  changes.filter(
    (entry) =>
      entry.kind === 'created' &&
      entry.sessionId === sessionId &&
      entry.actor.kind === 'agent' &&
      entry.actor.role === RULE_WRITER_ROLE &&
      entry.targetRef.entity === 'Rule',
  );

/**
 * 열린 저장소에서 규칙 작성 세션 `sessionId`가 만든 규칙마다 실행 1개를 자동 시작한다 (쓰기 트랜잭션 1개).
 * @throws {NotFoundError} 프로젝트 · 대상 규칙이 없음 (아무것도 남지 않는다)
 * @throws {ConflictError} 대상 규칙이 삭제됨 (아무것도 남지 않는다)
 */
export const autoStartRun = (
  store: ProjectStore,
  input: { readonly sessionId: Ulid },
  clock: AutoStartClock,
): AutoStartOutcome =>
  store.transaction(() => {
    const changes = store.normChanges.list();
    const causes = creationsOf(changes, input.sessionId);
    if (causes.length === 0) return { status: 'no_rules' };
    const causeSeqs = causes.map((entry) => entry.seq);
    // 원인 하나라도 이미 쓰였으면 아무것도 만들지 않는다 (일부만 쓰인 변조 상태에서 나머지를 채우지 않는다)
    const existing = changes.filter(
      (entry) =>
        entry.kind === 'auto_start' &&
        (entry.detail.causeSeqs ?? []).some((seq) => causeSeqs.includes(seq)),
    );
    if (existing.length > 0) {
      return { status: 'duplicate', runIds: [...new Set(existing.map((e) => e.targetRef.id))] };
    }
    if (store.autoStartSkips.get(input.sessionId) !== null) {
      return { status: 'duplicate', runIds: [] };
    }
    const now = clock.now();
    const at = new Date(now).toISOString();
    const settings = store.settings.get();
    // 하루 한도 비움(B⑤) · 설정 미비 · 오늘 지출이 하루 한도에 이름(A12)이면 실행을 하나도 만들지 않고 생략 기록 1건
    const block = autoStartBlock(store, settings, now);
    if (block !== null) {
      store.autoStartSkips.record({
        sessionId: input.sessionId,
        reason: block.reason,
        missing: block.missing,
        skippedAt: at,
      });
      return { status: 'skipped', reason: block.reason, missing: block.missing };
    }
    // 규칙마다 실행 1개 (ADR-110): 대상 규칙 1개 · 원인 = 그 규칙의 신규 기록 1건. 만든 순서 = 표시 ID 순 = 실행 대기 순
    const runs = causes.map((cause): AutoStartedRun => {
      const runId = clock.newId();
      const detail = saveNewRun(
        store,
        settings,
        {
          runId,
          ruleIds: [cause.targetRef.id],
          startedBy: { kind: 'orchestrator', causeSeqs: [cause.seq] },
        },
        at,
        clock.newId,
      );
      const normChange = store.normChanges.append({
        at,
        kind: 'auto_start',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: runId },
        sessionId: null,
        runId,
        reason: AUTO_START_REASON,
        detail: { causeSeqs: [cause.seq], ruleIds: [...detail.run.targetRuleIds] },
      });
      return { detail, normChange };
    });
    return { status: 'started', runs };
  });

/** 다시 시작 항목의 사유 (주체가 오케스트레이터라 필수는 아니지만 기록을 읽는 사람을 위해 남긴다). */
export const CONTRADICTION_RESTART_REASON =
  '기존 규칙 모순으로 병합 없이 끝난 실행의 대상 규칙 실행 다시 시작';

/** 기존 규칙 모순으로 끝난 실행의 실패 사유 (`steps/existing-rule.ts`와 같은 값). */
const EXISTING_RULE_CONTRADICTION = 'existing_rule_contradiction';

export type ContradictionRestartOutcome =
  /** 대상 규칙마다 실행을 만들었다 (대상 규칙 순) */
  | { readonly status: 'started'; readonly runs: readonly AutoStartedRun[] }
  /** 하루 한도 문에 걸려 만들지 않았다 (기록 없음) */
  | { readonly status: 'skipped'; readonly reason: AutoStartSkipReason }
  /** 이미 만들었거나(`duplicate`) 다시 시작할 대상 규칙이 없다(`no_rules`, 효력 없음) */
  | { readonly status: 'duplicate' | 'no_rules' }
  /** 기존 규칙 모순으로 끝난 실행이 아니다 */
  | { readonly status: 'not_applicable' };

/**
 * 기존 규칙 모순으로 끝난 실행 `runId`의 대상 규칙마다 실행 1개를 다시 시작한다 (쓰기 트랜잭션 1개). 원인은 그 실행의 첫 모순 판단
 * 기록(검사 실패 판단, 결과 모순)이고 대상 규칙마다 한 번만 쓴다. 효력이 없어진 대상 규칙은 건너뛴다.
 */
export const restartAfterContradiction = (
  store: ProjectStore,
  input: { readonly runId: Ulid },
  clock: AutoStartClock,
): ContradictionRestartOutcome =>
  store.transaction(() => {
    const ended = store.runs.get(input.runId);
    if (
      ended === null ||
      ended.status !== 'failed' ||
      ended.failureReason !== EXISTING_RULE_CONTRADICTION
    ) {
      return { status: 'not_applicable' };
    }
    const [cause] = contradictionJudgmentsOf(store, ended.id);
    if (cause === undefined) return { status: 'not_applicable' };
    const changes = store.normChanges.list();
    const retired = retiredRuleSet(store);
    const ruleIds = ended.targetRuleIds.filter((ruleId) => {
      const rule = store.rules.get(ruleId);
      return rule !== null && isEffectiveRule(rule, retired);
    });
    if (ruleIds.length === 0) return { status: 'no_rules' };
    const pending = ruleIds.filter(
      (ruleId) =>
        !changes.some(
          (entry) =>
            entry.kind === 'auto_start' &&
            (entry.detail.causeSeqs ?? []).includes(cause.seq) &&
            entry.detail.ruleIds?.length === 1 &&
            entry.detail.ruleIds[0] === ruleId,
        ),
    );
    if (pending.length === 0) return { status: 'duplicate' };
    const now = clock.now();
    const settings = store.settings.get();
    const block = autoStartBlock(store, settings, now);
    if (block !== null) return { status: 'skipped', reason: block.reason };
    const at = new Date(now).toISOString();
    const runs = pending.map((ruleId): AutoStartedRun => {
      const runId = clock.newId();
      const detail = saveNewRun(
        store,
        settings,
        { runId, ruleIds: [ruleId], startedBy: { kind: 'orchestrator', causeSeqs: [cause.seq] } },
        at,
        clock.newId,
      );
      const normChange = store.normChanges.append({
        at,
        kind: 'auto_start',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: runId },
        sessionId: null,
        runId,
        reason: CONTRADICTION_RESTART_REASON,
        detail: { causeSeqs: [cause.seq], ruleIds: [ruleId] },
      });
      return { detail, normChange };
    });
    return { status: 'started', runs };
  });

/** 실행 생성 뒤 엔진이 할 일 (`PipelineEngine.onRunCreated`: 승인 단계 판정 → 실행 · 실행 대기). */
export interface AutoStartEngine {
  onRunCreated(projectId: string, runId: string): void;
}

export interface AutoStarterOptions {
  /** `$BIVE_HOME` 절대 경로 */
  readonly biveHome: string;
  readonly engine: AutoStartEngine;
  /** 시계 (ms, 기본 `Date.now`) */
  readonly now?: () => number;
  /** 기록 한 줄 (기본: 버림) */
  readonly log?: (line: string) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 규칙 작성 세션 종료 알림을 받아 실행을 자동 시작하는 창구 (오케스트레이터 배선만 쓴다). 던지지 않는다. */
export class AutoStarter {
  readonly #biveHome: string;
  readonly #engine: AutoStartEngine;
  readonly #clock: AutoStartClock;
  readonly #log: (line: string) => void;
  /** 이 프로세스에서 다시 시작을 본 실행 (저장소의 멱등이 한 번 더 막는다) */
  readonly #restarted = new Set<string>();
  readonly #pending = new Set<Promise<void>>();

  constructor({ biveHome, engine, now = Date.now, log }: AutoStarterOptions) {
    this.#biveHome = biveHome;
    this.#engine = engine;
    this.#clock = { now, newId: createUlidGenerator(now) };
    this.#log = (line) => {
      try {
        log?.(line);
      } catch {
        // 기록 실패는 무시한다
      }
    };
  }

  /**
   * 규칙 작성 세션이 끝나고 세션 기록(비용)이 저장된 뒤 부른다. 정상 종료가 아니면 아무것도 하지 않는다(`null`).
   * 저장 실패 · 대상 규칙 없음 같은 예외는 로그만 남기고 `null`.
   */
  afterRuleWriterSession(
    projectId: string,
    sessionId: Ulid,
    endReason: SessionEndReason,
  ): AutoStartOutcome | null {
    if (endReason !== 'success') return null;
    let outcome: AutoStartOutcome;
    try {
      outcome = withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
        autoStartRun(store, { sessionId }, this.#clock),
      );
    } catch (error) {
      this.#log(`실행 자동 시작 실패 (세션 ${sessionId}): ${errorMessage(error)}`);
      return null;
    }
    if (outcome.status === 'skipped') {
      this.#log(`실행 자동 시작 생략 (세션 ${sessionId}, ${outcome.reason})`);
    }
    this.#announce(projectId, outcome);
    return outcome;
  }

  /**
   * 엔진의 저장 이벤트 하나 (오케스트레이터 배선이 넘긴다). 기존 규칙 모순으로 끝난 실행을 처음 보면 그 대상 규칙의 실행을 다시
   * 시작한다(M7-12, ADR-118). 엔진의 종료 처리가 끝난 다음 차례에 하고 기다리지 않는다. 던지지 않는다.
   */
  observe(event: EngineEvent): void {
    if (event.type !== 'run.saved') return;
    const { run } = event.detail;
    if (run.status !== 'failed' || run.failureReason !== EXISTING_RULE_CONTRADICTION) return;
    if (this.#restarted.has(run.id)) return;
    this.#restarted.add(run.id);
    const task = Promise.resolve().then(() => {
      this.afterContradiction(event.projectId, run.id);
    });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  /** 진행 중인 다시 시작이 모두 끝날 때까지 (종료 · 시험용). */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  /** 기존 규칙 모순으로 끝난 실행의 대상 규칙을 다시 시작한다 (실행 종료 저장 뒤). 예외는 로그만 남기고 `null`. */
  afterContradiction(projectId: string, runId: Ulid): ContradictionRestartOutcome | null {
    let outcome: ContradictionRestartOutcome;
    try {
      outcome = withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
        restartAfterContradiction(store, { runId }, this.#clock),
      );
    } catch (error) {
      this.#log(`대상 규칙 다시 시작 실패 (실행 ${runId}): ${errorMessage(error)}`);
      return null;
    }
    if (outcome.status === 'skipped') {
      this.#log(`대상 규칙 다시 시작 생략 (실행 ${runId}, ${outcome.reason})`);
    }
    this.#announce(projectId, outcome);
    return outcome;
  }

  #announce(projectId: string, outcome: AutoStartOutcome | ContradictionRestartOutcome): void {
    switch (outcome.status) {
      case 'started':
        // 만든 순서대로 알린다: 엔진의 생성 뒤 처리는 부른 순서로 판정하므로 첫 실행이 자리를 잡고 나머지는 실행 대기다
        for (const { detail, normChange } of outcome.runs) {
          this.#log(
            `실행 자동 시작 (${detail.run.displayId}, 규칙 ${String(detail.run.targetRuleIds.length)}건, ` +
              `규범 변경 기록 ${String(normChange.seq)})`,
          );
          this.#engine.onRunCreated(projectId, detail.run.id);
        }
        break;
      default:
        break;
    }
  }
}
