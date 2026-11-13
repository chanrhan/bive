// 구현 단계 실행기 (RUN-02 · RUN-04 · JDG-01 · NFR-01 · NFR-02, architecture.md 4장 4단계, ADR-024 · ADR-026 · ADR-052 · ADR-069).
// 1. 실행 워크트리에 의존성을 lockfile 기준으로 설치한다(오케스트레이터 몫, ADR-024 · C-14). 실패는 환경 문제라 `failed`
// 2. implementer 세션을 연다: 세션 루트 = 실행 워크트리. 경로 가드가 `bive-acceptance/**` · `node_modules/**` · `.git` ·
//    `.bive.json` 쓰기를 거부한다(ADR-052). 세션의 보고 내용은 어디에도 쓰지 않는다(JDG-01: 판정 근거는 실행기 결과뿐)
// 3. 세션 뒤 규범 저장소를 세션 전 스냅숏과 대조한다(에이전트 코드가 `run_tests`로 돌았던 구간, #117 기본 조치)
// 4. 변경을 커밋하고(판정한 코드 = 병합될 코드) 그 커밋의 깨끗한 체크아웃에서: Red 확인 때의 인수 테스트 해시와 대조
//    (다르면 `failed`(`guard_violation`)) → 의존성 새로 설치 → 판정 직전 규범 확인 → 대상 규칙만 판정 → 판정 뒤 규범 확인
// 5. 대상 규칙의 케이스가 전부 통과하면 `passed`(엔진의 커밋은 바뀐 것이 없어 같은 커밋), 아니면 `unmet` → 엔진이 구현을
//    다시 한다(회귀 1회로 셈, ADR-026). 빌드 실패 등 러너 오류 · 체크아웃 설치 실패도 구현이 만든 문제로 보고 `unmet`이다
//    (같은 환경에서 Red 확인이 이미 빌드 · 설치를 통과했다)
import type { JudgmentCase, Rule, Step } from '@bive/shared';

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

/** 구현 단계 미충족 사유 (`exitDetail.reason`). */
export type ImplementationUnmetReason =
  'session_error' | 'not_green' | 'collect_error' | 'judge_runner_error' | 'install_error';

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
    default:
      return null;
  }
};

/** 이번 시도 앞의 마지막 미충족 시도(구현 · 검사, 재기동 중단 제외)의 사유 문장. */
export const previousImplementationFeedback = (
  steps: readonly Step[],
  current: Step,
): string | null => {
  const last = steps
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
  if (last === undefined) return null;
  const text = describeImplementationUnmet(last.exitDetail);
  if (text === null) return null;
  return text.length <= MAX_FEEDBACK_CHARS ? text : `${text.slice(0, MAX_FEEDBACK_CHARS)}…`;
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
    let session;
    try {
      session = await context.runSession({
        workDir: worktree,
        systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
        prompt: implementerTaskPrompt({
          runDisplayId: context.run.displayId,
          rules,
          acceptanceFiles,
          feedback: previousImplementationFeedback(context.steps, context.step),
        }),
        vars: {
          ruleId: ruleIds[0] ?? '',
          ruleIds: ruleIds.join(','),
          runId: context.run.displayId,
        },
        commands: { toolchainRoot: worktree, installAllowlist },
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
