// 사람의 규칙 진술 편집 뒤 인수 테스트를 다시 쓰는 실행의 자동 시작 (NRM-04 · RUN-01 · NFR-07, ADR-100 A8 · A2 · C2 · B⑤ ·
// B⑥ · D8, ADR-107 · ADR-110, M7-03 #215 · ADR-109).
// - 원인: 승인 기록의 사람 행동 `rule_edit` 1건 가운데 진술이 바뀐 것. 제목만 바뀐 편집은 원인이 아니다(검사할 내용이 그대로)
// - 실행: 그 규칙 1개를 대상으로 실행 1개(규칙마다 실행 1개, ADR-110). 유형 · 단계는 사람의 [실행] · 규칙 작성 뒤 자동 시작과
//   같다(`saveNewRun`): 테스트 작성 역할이 대상 규칙 폴더를 새 진술로 통째로 다시 쓰고, Red 확인은 새 테스트가 모두 실패해야
//   넘어간다(Red 확인을 느슨하게 하지 않는다. 동작이 이미 새 진술과 맞으면 그 실행은 실패로 끝난다, ADR-109 한계)
// - 저장(트랜잭션 1개): 실행 + 규범 변경 기록 `auto_start` 1건(주체 오케스트레이터, `ruleEditSeqs` = 그 승인 기록 순번,
//   `ruleIds` = 그 규칙). 사람 행동(편집)은 승인 기록에, 그로 인한 오케스트레이터 행동(자동 시작)은 규범 변경 기록에 남는다(C2).
//   실행의 시작 주체는 `{kind: 'orchestrator', causeSeqs: [편집 순번], causeLog: 'approval_log'}`다. 승인 기록에는 쓰지 않는다
// - 만들지 않는 경우: 같은 편집으로 이미 시작함(멱등), 그 규칙이 대상인 시작 전 실행(승인 대기 · 실행 대기)이 있음(그 실행이
//   시작할 때 새 진술을 읽는다), 편집 뒤 진술이 또 바뀜(뒤 편집이 원인), 규칙이 효력을 잃음, 하루 한도 비움 · 설정 미비 ·
//   오늘 지출이 한도에 이름(규칙 작성 뒤 자동 시작과 같은 문. 생략은 기록하지 않고 응답으로만 알린다)
// - 이 모듈을 가져오는 곳은 오케스트레이터 배선(`orchestrator.ts`)뿐이다. 에이전트 세션 · 도구에는 실행을 만드는 길이 없다
import {
  type AutoStartSkipReason,
  createUlidGenerator,
  type MissingSetting,
  type NormChangeEntry,
  type RuleEditAutoStart,
  ruleStatementEditOf,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { isEffectiveRule, retiredRuleSet } from '../norms/effective.js';
import { autoStartBlock } from '../settings/auto-start-gate.js';
import { saveNewRun } from './run-service.js';

/** 자동 시작 항목의 사유 (주체가 오케스트레이터라 필수는 아니지만 기록을 읽는 사람을 위해 남긴다). */
export const RULE_EDIT_START_REASON =
  '사람의 규칙 진술 편집 뒤 인수 테스트 다시 쓰기 실행 자동 시작';

/** 시작 전 실행 상태: 이 상태의 실행은 테스트 작성 세션을 열 때 규칙을 새로 읽는다. */
const NOT_STARTED = ['waiting_approval', 'queued'] as const;

export type RuleEditStartOutcome =
  /** 실행을 만들고 자동 시작 항목을 남겼다 */
  | { readonly status: 'started'; readonly detail: RunDetail; readonly normChange: NormChangeEntry }
  /** 그 규칙이 대상인 시작 전 실행이 이미 있다 (만들지 않음, 기록 없음) */
  | { readonly status: 'pending'; readonly runId: Ulid; readonly runDisplayId: string }
  /** 하루 한도 · 설정 때문에 만들지 않았다 (기록 없음) */
  | {
      readonly status: 'skipped';
      readonly reason: AutoStartSkipReason;
      readonly missing: MissingSetting[];
    }
  /** 같은 편집으로 이미 실행을 만들었다 (기록 없음) */
  | { readonly status: 'duplicate'; readonly runId: Ulid }
  /** 원인이 아니다: 없는 순번 · 규칙 편집이 아님 · 진술이 그대로 · 뒤 편집이 진술을 또 바꿈 · 규칙이 효력을 잃음 */
  | { readonly status: 'not_applicable' };

export interface RuleEditStartClock {
  readonly now: () => number;
  readonly newId: () => Ulid;
}

/**
 * 열린 저장소에서 승인 기록 `approvalSeq`(사람의 규칙 진술 편집)를 원인으로 그 규칙의 실행 1개를 자동 시작한다
 * (쓰기 트랜잭션 1개: 검사와 저장이 함께라 같은 편집으로 두 번 불려도 실행은 1개).
 */
export const autoStartRuleEditRun = (
  store: ProjectStore,
  input: { readonly approvalSeq: number },
  clock: RuleEditStartClock,
): RuleEditStartOutcome =>
  store.transaction(() => {
    const entry = store.approvalLog.list().find((item) => item.seq === input.approvalSeq);
    const edit = entry === undefined ? null : ruleStatementEditOf(entry);
    if (edit === null) return { status: 'not_applicable' };
    const existing = store.normChanges
      .list()
      .find(
        (change) =>
          change.kind === 'auto_start' && (change.detail.ruleEditSeqs ?? []).includes(edit.seq),
      );
    if (existing !== undefined) return { status: 'duplicate', runId: existing.targetRef.id };
    const rule = store.rules.get(edit.ruleId);
    if (
      rule === null ||
      rule.deletedAt !== null ||
      rule.builtin ||
      // 효력 판정은 효력 모듈 한 곳 (폐기된 규칙의 편집으로는 실행이 생기지 않는다, M7-09 · ADR-112)
      !isEffectiveRule(rule, retiredRuleSet(store)) ||
      rule.statement !== edit.diff.after.statement
    ) {
      return { status: 'not_applicable' };
    }
    const pending = NOT_STARTED.flatMap((status) => store.runs.list({ status })).find((run) =>
      run.targetRuleIds.includes(rule.id),
    );
    if (pending !== undefined) {
      return { status: 'pending', runId: pending.id, runDisplayId: pending.displayId };
    }
    const now = clock.now();
    const settings = store.settings.get();
    // 하루 한도 비움(B⑤) · 설정 미비 · 오늘 지출이 한도에 이름(A12)이면 만들지 않는다. 규칙 작성 뒤 자동 시작과 같은 문이고,
    // 실행 대기에 선 뒤 시작할 차례에도 같은 문을 다시 지난다(ADR-111)
    const block = autoStartBlock(store, settings, now);
    if (block !== null) return { status: 'skipped', reason: block.reason, missing: block.missing };
    const at = new Date(now).toISOString();
    const runId = clock.newId();
    const detail = saveNewRun(
      store,
      settings,
      {
        runId,
        ruleIds: [rule.id],
        startedBy: { kind: 'orchestrator', causeSeqs: [edit.seq], causeLog: 'approval_log' },
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
      reason: RULE_EDIT_START_REASON,
      detail: { ruleEditSeqs: [edit.seq], ruleIds: [...detail.run.targetRuleIds] },
    });
    return { status: 'started', detail, normChange };
  });

/** 실행 생성 뒤 엔진이 할 일 (`PipelineEngine.onRunCreated`: 승인 단계 판정 → 실행 · 실행 대기). */
export interface RuleEditStartEngine {
  onRunCreated(projectId: string, runId: string): void;
}

export interface RuleEditAutoStarterOptions {
  /** `$BIVE_HOME` 절대 경로 */
  readonly biveHome: string;
  readonly engine: RuleEditStartEngine;
  /** 시계 (ms, 기본 `Date.now`) */
  readonly now?: () => number;
  /** 기록 한 줄 (기본: 버림) */
  readonly log?: (line: string) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 결과 → `rule.update` 응답의 `autoStart`. 만들지 않았고 알릴 것도 없으면 `null`. */
export const ruleEditAutoStartOf = (outcome: RuleEditStartOutcome): RuleEditAutoStart | null => {
  switch (outcome.status) {
    case 'started':
      return {
        state: 'started',
        runId: outcome.detail.run.id,
        runDisplayId: outcome.detail.run.displayId,
      };
    case 'pending':
      return { state: 'pending', runId: outcome.runId, runDisplayId: outcome.runDisplayId };
    case 'skipped':
      return { state: 'skipped', reason: outcome.reason, missing: outcome.missing };
    case 'duplicate':
    case 'not_applicable':
      return null;
  }
};

/** 사람의 규칙 진술 편집이 저장된 뒤 실행을 자동 시작하는 창구 (오케스트레이터 배선만 쓴다). 던지지 않는다. */
export class RuleEditAutoStarter {
  readonly #biveHome: string;
  readonly #engine: RuleEditStartEngine;
  readonly #clock: RuleEditStartClock;
  readonly #log: (line: string) => void;

  constructor({ biveHome, engine, now = Date.now, log }: RuleEditAutoStarterOptions) {
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

  /** 편집 트랜잭션이 커밋된 뒤 부른다. 저장 실패 같은 예외는 로그만 남기고 `null`. */
  afterRuleEdit(projectId: string, approvalSeq: number): RuleEditAutoStart | null {
    let outcome: RuleEditStartOutcome;
    try {
      outcome = withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
        autoStartRuleEditRun(store, { approvalSeq }, this.#clock),
      );
    } catch (error) {
      this.#log(
        `규칙 편집 뒤 실행 자동 시작 실패 (승인 기록 ${String(approvalSeq)}): ${errorMessage(error)}`,
      );
      return null;
    }
    switch (outcome.status) {
      case 'started':
        this.#log(
          `규칙 편집 뒤 실행 자동 시작 (${outcome.detail.run.displayId}, 승인 기록 ${String(approvalSeq)}, ` +
            `규범 변경 기록 ${String(outcome.normChange.seq)})`,
        );
        this.#engine.onRunCreated(projectId, outcome.detail.run.id);
        break;
      case 'skipped':
        this.#log(
          `규칙 편집 뒤 실행 자동 시작 생략 (승인 기록 ${String(approvalSeq)}, ${outcome.reason})`,
        );
        break;
      case 'pending':
      case 'duplicate':
      case 'not_applicable':
        break;
    }
    return ruleEditAutoStartOf(outcome);
  }
}
