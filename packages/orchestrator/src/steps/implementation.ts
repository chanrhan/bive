// 구현 단계 실행기 (RUN-02 · RUN-04 · JDG-01 · NFR-01 · NFR-02, architecture.md 4장 4단계, ADR-024 · ADR-026 · ADR-052 · ADR-069).
// 1. 실행 워크트리에 의존성을 lockfile 기준으로 설치한다(오케스트레이터 몫, ADR-024 · C-14). 실패는 환경 문제라 `failed`
// 2. implementer 세션을 연다: 세션 루트 = 실행 워크트리. 경로 가드가 `bive-acceptance/**` · `node_modules/**` · `.git` ·
//    `.bive.json` 쓰기를 거부한다(ADR-052). 세션의 보고 내용은 어디에도 쓰지 않는다(JDG-01: 판정 근거는 실행기 결과뿐).
//    작업 지시에는 세션을 열기 직전에 읽은 효력 있는 규범(초점 = 대상 규칙)을 싣고, 받은 표시 ID · 수를 세션 행에 남긴다
//    (M7-08 #220, ADR-108). 재시도 · 재개의 새 세션은 그때 다시 읽는다
// 3. 세션 뒤 규범 저장소를 세션 전 스냅숏과 대조한다(에이전트 코드가 `run_tests`로 돌았던 구간, #117 기본 조치)
// 4. 변경을 커밋하고(판정한 코드 = 병합될 코드) 그 커밋의 깨끗한 체크아웃에서: Red 확인 때의 인수 테스트 해시와 대조
//    (다르면 `failed`(`guard_violation`)) → 의존성 새로 설치 → 판정 직전 규범 확인 → 대상 규칙만 판정 → 판정 뒤 규범 확인
// 5. 대상 규칙의 케이스가 전부 통과하면 `passed`(엔진의 커밋은 바뀐 것이 없어 같은 커밋), 아니면 `unmet` → 엔진이 구현을
//    다시 한다(회귀 1회로 셈, ADR-026). 빌드 실패 등 러너 오류 · 체크아웃 설치 실패도 구현이 만든 문제로 보고 `unmet`이다
//    (같은 환경에서 Red 확인이 이미 빌드 · 설치를 통과했다)
// 이의 제기 (M7-11 #223, ADR-100 D4 · A4, ADR-115): 세션이 `raise_objection`을 부르면 주입한 콜백이 이의 기록 1건만 남기고(규범
// 저장소의 다른 표 · 규칙 · 인수 테스트는 그대로) 엔진이 세션을 끝낸다. 세션 뒤 규범 확인을 지난 다음 판단 세션을 한 번 청하고
// (`judgeNorms`), 판단 기록이 없는 대상 규칙은 유지로 마무리한다(판단 없음을 폐기로 보지 않는다). 대상 규칙 가운데 하나라도
// 폐기 · 대체면 `failed`(`objection_applied`, 병합 없음). 모두 유지면 `unmet`(`objection_upheld`) → 엔진이 구현으로 회귀하며 검사
// 회귀와 같은 상한(`regressionCount`, 2회)을 쓴다. 다음 구현 세션은 판단의 근거를 앞 시도의 사유로 받는다. 판단 세션을 열지 못한
// 사유가 예산(하루 한도 · 실행 예산)이면 `budget_exceeded`, 규칙 작성 역할 설정 미비면 `failed`(`settings_missing`)로 끝낸다.
// 재기동으로 이의의 마무리가 끊겼으면 다음 시도의 시작에서 판단 없이 유지로 마무리하고 같은 규칙으로 진행한다
import type { JudgmentCase, NormChangeEntry, Rule, Step } from '@bive/shared';

import {
  type StepContext,
  type StepExecutor,
  type StepOutcome,
  stepCommitMessage,
} from '../engine/types.js';
import { IMPLEMENTER_SYSTEM_PROMPT, implementerTaskPrompt } from '../implementer/prompts.js';
import { DEFAULT_INSTALL_TIMEOUT_MS, JudgeCheckoutError } from '../judge/checkout.js';
import { installDependencies } from '../judge/checkout.js';
import type { JudgeRunResult } from '../judge/runner.js';
import { checkFailureFeedback } from '../norms/check-contradiction.js';
import { latestJudgedCaseFilter } from '../norms/case-names.js';
import { collectNormInput, normInputRecord } from '../norms/norm-input.js';
import {
  ObjectionInputError,
  objectionFeedback,
  recordObjection,
  settleObjection,
  unsettledObjection,
} from '../norms/objection.js';
import { denied, failed, ok } from '../tools/result.js';
import { JUDGE_RUNNER_ERROR_REASON } from './red-check.js';
import {
  caseSummary,
  casesOf,
  createNormGuard,
  installLogFile,
  judgeCommit,
  judgeSummary,
  judgmentDigest,
  judgmentsFrom,
  type JudgingOptions,
  MAX_LISTED,
  normHalt,
  recordJudgments,
  redAcceptanceHashes,
} from './judging.js';

/** 실행 워크트리 의존성 설치가 실패했을 때의 실행 실패 사유 (`Run.failureReason`). */
export const DEPENDENCY_INSTALL_FAILED_REASON = 'dependency_install_failed';

/** 구현 단계 미충족 사유 (`exitDetail.reason`). `objection_upheld`는 이의가 유지로 판단됨 (M7-11, ADR-115). */
export type ImplementationUnmetReason =
  | 'session_error'
  | 'not_green'
  | 'collect_error'
  | 'judge_runner_error'
  | 'install_error'
  | 'objection_upheld';

/** 이의에 폐기 · 대체 판단이 나와 실행을 병합 없이 끝낼 때의 실패 사유 ("이의 반영", ADR-115). */
export const OBJECTION_APPLIED_REASON = 'objection_applied';

/** 재기동으로 마무리가 끊긴 이의를 판단 없이 유지로 마무리할 때의 사정 (`undecided.endReason`). */
export const OBJECTION_INTERRUPTED = 'interrupted';

export type ImplementationOptions = JudgingOptions;

const MAX_FEEDBACK_CHARS = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInterrupted = (step: Step): boolean =>
  isRecord(step.exitDetail) && step.exitDetail.interrupted === true;

const describeItems = (items: unknown): string[] =>
  Array.isArray(items)
    ? items.slice(0, MAX_LISTED).map((item) => {
        if (!isRecord(item)) return `- ${String(item)}`;
        const where = [item.file, item.line].filter((part) => part !== undefined && part !== null);
        const head = where.length > 0 ? `${where.map(String).join(':')} ` : '';
        const name = item.name ?? item.ruleId ?? '';
        const message = typeof item.message === 'string' ? ` (${item.message})` : '';
        return `- ${head}${String(name)}${message}`.trimEnd();
      })
    : [];

/** 앞 시도의 미충족 결과를 다음 implementer 세션에 줄 문장으로 바꾼다. 모르는 모양이면 `null`. */
export const describeImplementationUnmet = (exitDetail: unknown): string | null => {
  if (!isRecord(exitDetail)) return null;
  switch (exitDetail.reason) {
    case 'not_green':
      return [
        '구현 뒤 판정: 통과하지 않은 대상 케이스가 있다',
        ...describeItems(exitDetail.failingCases),
      ].join('\n');
    case 'check_failed':
      return [
        '검사(승인된 규칙 전체 인수 테스트): 실패한 규칙이 있다',
        ...(Array.isArray(exitDetail.judgments)
          ? exitDetail.judgments
              .filter((item) => isRecord(item) && item.status !== 'pass')
              .flatMap((item) => [
                `- ${String((item as Record<string, unknown>).ruleId)}`,
                ...describeItems((item as Record<string, unknown>).failedCases).map(
                  (line) => `  ${line}`,
                ),
              ])
          : []),
      ].join('\n');
    case 'collect_error':
      return [
        '판정: 인수 테스트 파일을 불러오거나 수집하지 못했다',
        ...describeItems(exitDetail.problems),
      ].join('\n');
    case 'judge_runner_error':
      return `판정 서버를 빌드 · 기동하지 못했다: ${String(exitDetail.message ?? '')}`;
    case 'install_error':
      return `의존성 설치 실패 (package.json과 lockfile이 맞지 않을 수 있다): ${String(exitDetail.message ?? '')}`;
    case 'session_error':
      return `세션이 정상 종료되지 않았다: ${String(exitDetail.detail ?? exitDetail.endReason ?? '')}`;
    case 'objection_upheld':
      return '이의 제기에 규칙을 맡는 역할이 유지로 판단했다. 규칙과 인수 테스트는 그대로다';
    default:
      return null;
  }
};

/** 이번 시도 앞의 마지막 미충족 시도 (구현 · 검사, 재기동 중단 제외). */
const lastUnmetAttempt = (steps: readonly Step[], current: Step): Step | undefined =>
  steps
    .filter(
      (step) =>
        step.id !== current.id &&
        (step.kind === 'implementation' || step.kind === 'check') &&
        step.status === 'failed' &&
        step.endedAt !== null &&
        !isInterrupted(step),
    )
    .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)))
    .at(-1);

const clipFeedback = (text: string): string =>
  text.length <= MAX_FEEDBACK_CHARS ? text : `${text.slice(0, MAX_FEEDBACK_CHARS)}…`;

/** 이번 시도 앞의 마지막 미충족 시도(구현 · 검사, 재기동 중단 제외)의 사유 문장. */
export const previousImplementationFeedback = (
  steps: readonly Step[],
  current: Step,
): string | null => {
  const last = lastUnmetAttempt(steps, current);
  if (last === undefined) return null;
  const text = describeImplementationUnmet(last.exitDetail);
  if (text === null) return null;
  return clipFeedback(text);
};

/** 단계 시도 결과에 실린 이의 기록 순번 (미충족은 `exitDetail.objectionSeq`, 실패는 `exitDetail.detail.objectionSeq`). */
const objectionSeqOf = (exitDetail: unknown): number | null => {
  if (!isRecord(exitDetail)) return null;
  if (typeof exitDetail.objectionSeq === 'number') return exitDetail.objectionSeq;
  const inner = exitDetail.detail;
  return isRecord(inner) && typeof inner.objectionSeq === 'number' ? inner.objectionSeq : null;
};

/**
 * 다음 구현 세션의 앞 시도 사유: 앞 시도가 이의 유지(`objection_upheld`)였으면 저장소의 판단 근거(규칙 작성 역할이 쓴 글, 판단 없음
 * 표시 포함), 아니면 {@link previousImplementationFeedback}. 작업 지시는 이 글을 줄마다 들여 쓴 표시 값으로 싣는다(ADR-108).
 */
const implementationFeedback = (context: StepContext): string | null => {
  const last = lastUnmetAttempt(context.steps, context.step);
  const seq = last === undefined ? null : objectionSeqOf(last.exitDetail);
  if (
    last !== undefined &&
    seq !== null &&
    isRecord(last.exitDetail) &&
    last.exitDetail.reason === 'objection_upheld'
  ) {
    const text = context.read((store) => objectionFeedback(store, seq));
    if (text !== null) return clipFeedback(text);
  }
  const previous = previousImplementationFeedback(context.steps, context.step);
  // 검사의 대상 밖 규칙 실패가 모순 아님으로 판단됐으면 그 근거를 덧붙인다 (M7-12, ADR-118)
  const judgedRuleIds = last === undefined ? [] : existingRuleJudgmentOf(last.exitDetail);
  if (judgedRuleIds.length > 0) {
    const grounds = context.read((store) =>
      checkFailureFeedback(store, context.run.id, judgedRuleIds),
    );
    if (grounds !== null) {
      return clipFeedback(previous === null ? grounds : `${previous}\n${grounds}`);
    }
  }
  return previous;
};

/** 검사 · 병합 시도 결과에 실린 검사 실패 판단의 대상 규칙 ID (`exitDetail.existingRuleJudgment.ruleIds`). */
const existingRuleJudgmentOf = (exitDetail: unknown): string[] => {
  if (!isRecord(exitDetail)) return [];
  const judged = exitDetail.existingRuleJudgment;
  if (!isRecord(judged) || !Array.isArray(judged.ruleIds)) return [];
  return judged.ruleIds.filter((id): id is string => typeof id === 'string');
};

/**
 * 이의를 마무리하고 단계 결과를 정한다 (ADR-115). `judged`가 `null`이면 재기동으로 끊긴 이의다(판단 세션을 다시 열지 않는다).
 */
const finishObjection = async (
  context: StepContext,
  objection: NormChangeEntry,
  sessionId: string | null,
  resumed: boolean,
): Promise<StepOutcome> => {
  const rules = objection.detail.objection?.rules ?? [];
  const judged = resumed
    ? null
    : await context.judgeNorms({
        cause: { kind: 'objection', seq: objection.seq, text: objection.reason ?? '' },
        ruleIds: rules.map((rule) => rule.id),
      });
  context.signal.throwIfAborted();
  const endReason =
    judged === null
      ? OBJECTION_INTERRUPTED
      : judged.status === 'ended'
        ? judged.endReason
        : judged.reason;
  const decisions = context.read((store) =>
    settleObjection(store, { objectionSeq: objection.seq, endReason }, { now: Date.now }),
  );
  const base = {
    sessionId,
    objectionSeq: objection.seq,
    judgmentSession:
      judged === null
        ? { interrupted: true }
        : judged.status === 'ended'
          ? { sessionId: judged.sessionId, endReason: judged.endReason }
          : { notOpened: judged.reason, message: judged.detail },
    decisions: decisions.map((decision) => ({
      ruleId: decision.rule.displayId,
      verdict: decision.verdict,
      judgmentSeq: decision.seq,
      undecided: decision.undecided,
    })),
  };
  if (decisions.some((decision) => decision.verdict !== 'upheld')) {
    return halt(OBJECTION_APPLIED_REASON, {
      ...base,
      message: '이의에 규칙을 맡는 역할이 폐기 · 대체로 판단해 이 실행은 병합 없이 끝납니다',
    });
  }
  if (judged?.status === 'not_opened') {
    if (judged.reason === 'project_daily_budget_exceeded' || judged.reason === 'budget_exhausted') {
      return {
        status: 'halt',
        runStatus: 'budget_exceeded',
        reason: judged.reason,
        exitDetail: base,
      };
    }
    if (judged.reason === 'settings_incomplete') {
      return halt('settings_missing', { ...base, role: 'rule-writer' });
    }
  }
  return { status: 'unmet', exitDetail: { ...base, reason: 'objection_upheld' } };
};

/**
 * 구현 뒤 판정 결과 → 구현 단계 결과. 대상 규칙마다 케이스가 1개 이상이고 모든 케이스가 `passed`여야 통과다
 * (건너뜀 · todo도 통과가 아니다, ADR-051).
 */
export const evaluateGreen = (
  result: JudgeRunResult,
  ruleIds: readonly string[],
): { status: 'passed' | 'unmet'; exitDetail: Record<string, unknown> } => {
  const base = judgeSummary(result);
  if (result.status === 'runner_error') {
    return { status: 'unmet', exitDetail: { ...base, reason: 'judge_runner_error' } };
  }
  if (result.status === 'collect_error') {
    return { status: 'unmet', exitDetail: { ...base, reason: 'collect_error' } };
  }
  const withoutCases = ruleIds.filter((id) => casesOf(result, id).length === 0);
  if (withoutCases.length > 0) {
    return {
      status: 'unmet',
      exitDetail: {
        ...base,
        reason: 'collect_error',
        problems: withoutCases.map((id) => ({
          file: `bive-acceptance/${id}`,
          message: '케이스 0개',
        })),
      },
    };
  }
  const failing = result.cases.filter((item: JudgmentCase) => item.status !== 'passed');
  if (failing.length > 0) {
    return {
      status: 'unmet',
      exitDetail: {
        ...base,
        reason: 'not_green',
        failingCases: failing.slice(0, MAX_LISTED).map(caseSummary),
      },
    };
  }
  return { status: 'passed', exitDetail: { ...base, cases: result.cases.length } };
};

const halt = (reason: string, exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason,
  exitDetail,
});

/** 구현 단계 실행기를 만든다 (기본 실행기 목록에 등록된다). */
export const createImplementationExecutor =
  (options: ImplementationOptions = {}): StepExecutor =>
  async (context: StepContext): Promise<StepOutcome> => {
    const rules = context.read((store) => {
      const found: Rule[] = [];
      for (const id of context.run.targetRuleIds) {
        const rule = store.rules.get(id);
        if (rule === null || rule.deletedAt !== null) return null;
        found.push(rule);
      }
      return found;
    });
    if (rules === null || rules.length === 0) {
      return halt('target_rule_unavailable', { ruleIds: context.run.targetRuleIds });
    }
    const ruleIds = rules.map((rule) => rule.displayId);
    const expectedHashes = redAcceptanceHashes(context.steps);
    if (expectedHashes === null) {
      return halt('state_inconsistent', {
        message: 'Red 확인 통과 기록(인수 테스트 해시)이 없습니다',
      });
    }
    // 재기동으로 마무리가 끊긴 이의가 있으면 판단 없이 유지로 마무리한다 (판단 세션은 이의마다 한 번, ADR-115)
    const settledSeqs = context.steps.flatMap((step) => {
      const seq = objectionSeqOf(step.exitDetail);
      return seq === null ? [] : [seq];
    });
    const unsettled = context.read((store) =>
      unsettledObjection(store, context.run.id, settledSeqs),
    );
    if (unsettled !== null) return finishObjection(context, unsettled, null, true);
    // 쓰기 장부 감시 시작 (메모리에만 둔다). 단계 사이에 생긴 보고되지 않은 변경도 대상이다
    const norms = createNormGuard(context);
    const worktree = context.git.worktreePath;

    // 1. 실행 워크트리 의존성 (run_tests · prisma 도구가 쓴다). 무시된 파일이라 커밋 · 판정에는 들어가지 않는다
    const worktreeLog = installLogFile(context);
    try {
      await (options.installDependencies ?? installDependencies)(worktree, {
        logFile: worktreeLog,
        timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        signal: context.signal,
      });
    } catch (error) {
      if (!(error instanceof JudgeCheckoutError)) throw error;
      return halt(DEPENDENCY_INSTALL_FAILED_REASON, {
        stage: 'worktree_install',
        message: error.message,
        logFile: worktreeLog,
      });
    }
    context.signal.throwIfAborted();
    const beforeSession = norms.verify();
    if (beforeSession.length > 0) return normHalt('before_session', beforeSession);

    // 2. implementer 세션
    const acceptanceFiles = Object.keys(expectedHashes).filter((file) =>
      ruleIds.some((id) => file.startsWith(`bive-acceptance/${id}/`)),
    );
    const installAllowlist = context.read((store) => store.settings.get().installAllowlist);
    // 효력 있는 규범은 작업 지시로만 준다 (도구 목록은 그대로, ADR-100 K1 · A14). 케이스 이름은 최근 판정 커밋의 인수 테스트
    // 파일에 적힌 것만 싣는다 (M3-37, ADR-121)
    const isKnownCase = await latestJudgedCaseFilter(context.read, context.git.repoPath);
    const normInput = context.read((store) =>
      collectNormInput(
        store,
        { requirementIds: [], ruleIds: context.run.targetRuleIds },
        { isKnownCase },
      ),
    );
    // 이의 제기 도구의 콜백: 이의 기록 1건만 남긴다 (규칙 · 인수 테스트 · 규범 저장소의 다른 표는 쓰지 않는다, ADR-115)
    const raised: { entry: NormChangeEntry | null } = { entry: null };
    let session;
    try {
      session = await context.runSession({
        workDir: worktree,
        systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
        prompt: implementerTaskPrompt({
          runDisplayId: context.run.displayId,
          rules,
          acceptanceFiles,
          norms: normInput,
          feedback: implementationFeedback(context),
        }),
        normInput: normInputRecord(normInput),
        vars: {
          ruleId: ruleIds[0] ?? '',
          ruleIds: ruleIds.join(','),
          runId: context.run.displayId,
        },
        commands: { toolchainRoot: worktree, installAllowlist },
        hooks: {
          raiseObjection: (input, call) => {
            if (call.sessionId === null)
              return failed('tool_failed', '세션 기록이 없어 이의를 남길 수 없음');
            const sessionId = call.sessionId;
            try {
              const entry = context.read((store) =>
                recordObjection(
                  store,
                  {
                    ruleIds: input.ruleIds,
                    reason: input.reason,
                    sessionId,
                    runId: context.run.id,
                    stepId: context.step.id,
                  },
                  { now: Date.now },
                ),
              );
              raised.entry = entry;
              const targets = entry.detail.objection?.rules.map((rule) => rule.displayId) ?? [];
              return ok(
                `이의 기록 (${targets.join(', ')}, 규범 변경 기록 ${String(entry.seq)}). 이 세션은 여기서 끝난다. 규칙을 맡는 역할이 폐기 · 대체 · 유지를 판단한다`,
              );
            } catch (error) {
              if (error instanceof ObjectionInputError) {
                return denied(
                  error.code,
                  `raise_objection 인자 오류: ${error.message} (작업 지시의 효력 있는 규칙 표시 ID를 쓴다)`,
                );
              }
              throw error;
            }
          },
        },
      });
    } catch (error) {
      // 가드 위반 · 예산 초과로 세션이 실행을 끝내도(StepHaltError) 에이전트 코드가 돌았을 수 있으므로 먼저 대조한다
      if (context.signal.aborted) throw error;
      const afterHalt = norms.verify();
      if (afterHalt.length > 0) {
        return normHalt('after_session', afterHalt, {
          sessionError: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

    // 3. 세션 뒤 규범 저장소 확인 (세션 결과와 무관하게: 에이전트 코드가 돌았을 수 있다)
    const afterSession = norms.verify();
    if (afterSession.length > 0) {
      return normHalt('after_session', afterSession, { sessionId: session.sessionId });
    }
    // 이의를 제기했으면 판정하지 않고 규칙을 맡는 역할의 판단으로 넘긴다 (세션의 코드 변경은 커밋하지 않는다)
    if (raised.entry !== null) {
      return finishObjection(context, raised.entry, session.sessionId, false);
    }
    if (session.endReason !== 'success') {
      return {
        status: 'unmet',
        exitDetail: {
          reason: 'session_error',
          sessionId: session.sessionId,
          endReason: session.endReason,
          detail: session.detail,
        },
      };
    }

    // 4. 커밋 → 그 커밋의 깨끗한 체크아웃에서 판정
    const { commit } = await context.worktrees.commit(
      context.git,
      stepCommitMessage(context.run, context.step),
    );
    const judged = await judgeCommit(
      context,
      {
        commit,
        selectRules: () => ruleIds,
        expectedAcceptanceHashes: expectedHashes,
        norms,
        signal: context.signal,
      },
      options,
    );
    const base = { sessionId: session.sessionId, commit };
    switch (judged.kind) {
      case 'checkout_error':
        return halt(JUDGE_RUNNER_ERROR_REASON, {
          ...base,
          stage: 'checkout',
          message: judged.message,
        });
      case 'acceptance_changed':
        return halt('guard_violation', {
          ...base,
          stage: judged.stage,
          ...(judged.moment === undefined ? {} : { moment: judged.moment }),
          message:
            judged.stage === 'acceptance_hash'
              ? 'Red 확인 뒤 인수 테스트가 바뀌었습니다'
              : '판정 중 인수 테스트 · 테스트 실행기 · 판정 설정이 바뀌었습니다',
          changed: judged.changed.slice(0, MAX_LISTED),
        });
      case 'norm_mismatch':
        return normHalt(judged.moment, judged.mismatches, base);
      case 'structure_halt':
        // 구현 단계는 구조 검사 계획을 넘기지 않는다 (구조 검사는 검사 단계 · 병합 재검사, M3-03)
        return halt('state_inconsistent', {
          ...base,
          message: '구현 판정에 구조 검사 결과가 있습니다',
        });
      case 'no_rules':
      case 'install_error':
        return {
          status: 'unmet',
          exitDetail:
            judged.kind === 'install_error'
              ? {
                  ...base,
                  reason: 'install_error',
                  message: judged.message,
                  logFile: judged.logFile,
                }
              : {
                  ...base,
                  reason: 'collect_error',
                  problems: [{ file: null, message: '인수 테스트 없음' }],
                },
        };
      case 'judged': {
        const recorded = recordJudgments(
          context,
          judgmentsFrom(judged.result, rules, {
            runId: context.run.id,
            stepId: context.step.id,
            commit,
          }),
        );
        const evaluated = evaluateGreen(judged.result, ruleIds);
        const exitDetail = {
          ...base,
          ...evaluated.exitDetail,
          judgments: judgmentDigest(recorded, rules),
        };
        return evaluated.status === 'passed'
          ? { status: 'passed', exitDetail }
          : { status: 'unmet', exitDetail };
      }
    }
  };
