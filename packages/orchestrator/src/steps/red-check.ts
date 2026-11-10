// Red 확인 단계 실행기 (RUN-03 · JDG-01, architecture.md 4장 3단계, ADR-026 · ADR-051 · ADR-058 · ADR-066 · ADR-068).
// 테스트 작성 커밋(`Run.headCommit`)의 깨끗한 체크아웃을 만들고 의존성을 새로 설치한 뒤 판정 러너로 대상 규칙의
// 인수 테스트를 돌린다. 실행 워크트리에서는 판정하지 않는다(무시된 파일 · `node_modules`가 결과를 바꿀 수 있음).
// - `completed`이고 대상 케이스가 1개 이상이며 전부 `failed` → `passed` (인수 테스트 해시를 기록, 검사 단계가 대조)
// - 통과 · 건너뜀 · todo 케이스가 하나라도 있음(`not_red`) · `collect_error`(파일 로드 오류 · 훅 실패 · 0개 수집) →
//   `unmet` → 엔진이 테스트 작성으로 회귀 (테스트 재시도 수, 상한 2회 뒤 `failed`)
// - `runner_error`(서버 기동 · 빌드 실패 · 시간 초과 등) · 체크아웃 · 설치 실패 → `failed`(`judge_runner_error`).
//   테스트 작성을 다시 해도 고칠 수 없는 환경 문제로 보고 예산을 쓰지 않는다
import fs from 'node:fs';
import path from 'node:path';

import { createUlidGenerator, type JudgmentCase } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import type { GitRunner } from '../git/git-exec.js';
import {
  createJudgeCheckout,
  DEFAULT_INSTALL_TIMEOUT_MS,
  hashAcceptanceFiles,
  type InstallDependencies,
  installDependencies,
  JudgeCheckoutError,
} from '../judge/checkout.js';
import type { JudgeProfileName } from '../judge/profiles/types.js';
import { ruleIdOfAcceptanceFile } from '../judge/report.js';
import { type JudgeRunInput, JudgeRunner, type JudgeRunResult } from '../judge/runner.js';

/** Red 확인 판정 제한 시간 (기본): 서버 빌드 · 기동 · vitest 전체. */
export const DEFAULT_RED_JUDGE_TIMEOUT_MS = 10 * 60_000;

/** 판정 실패로 실행을 끝낼 때의 사유 (`Run.failureReason`). */
export const JUDGE_RUNNER_ERROR_REASON = 'judge_runner_error';

/** Red 확인 미충족 사유 (`exitDetail.reason`). */
export type RedUnmetReason = 'not_red' | 'collect_error';

export interface RedCheckOptions {
  /** 판정 실행 (기본 `new JudgeRunner({ biveHome }).run`) */
  judge?: (input: JudgeRunInput, context: StepContext) => Promise<JudgeRunResult>;
  /** 체크아웃 안 의존성 설치 (기본 `pnpm install --frozen-lockfile`) */
  installDependencies?: InstallDependencies;
  git?: GitRunner;
  profile?: JudgeProfileName;
  judgeTimeoutMs?: number;
  installTimeoutMs?: number;
}

const newId = createUlidGenerator();
const MAX_LISTED = 50;

const caseSummary = (item: JudgmentCase) => ({
  name: item.name,
  file: item.file,
  line: item.line,
  status: item.status,
});

/**
 * 판정 결과를 Red 확인 결과로 옮긴다. 판정 러너는 대상 규칙 폴더만 돌렸으므로 모든 케이스가 새 테스트다.
 * 대상 규칙마다 케이스가 1개 이상이어야 하고(규칙 폴더에 케이스가 없으면 수집 문제), 전부 `failed`여야 Red다.
 */
export const evaluateRed = (
  result: JudgeRunResult,
  ruleIds: readonly string[],
): { status: 'passed' | 'unmet' | 'runner_error'; exitDetail: Record<string, unknown> } => {
  const base = {
    judgeId: result.judgeId,
    judgeStatus: result.status,
    summary: result.summary,
    reporterPath: result.reporterPath,
  };
  if (result.status === 'runner_error') {
    return {
      status: 'runner_error',
      exitDetail: { ...base, stage: 'judge', message: result.message, problems: result.problems },
    };
  }
  if (result.status === 'collect_error') {
    return {
      status: 'unmet',
      exitDetail: {
        ...base,
        reason: 'collect_error',
        problems: result.problems.slice(0, MAX_LISTED),
      },
    };
  }
  const withoutCases = ruleIds.filter(
    (id) => !result.cases.some((item) => ruleIdOfAcceptanceFile(item.file) === id),
  );
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
  const notFailed = result.cases.filter((item) => item.status !== 'failed');
  if (notFailed.length > 0) {
    return {
      status: 'unmet',
      exitDetail: {
        ...base,
        reason: 'not_red',
        notFailedCases: notFailed.slice(0, MAX_LISTED).map(caseSummary),
      },
    };
  }
  return { status: 'passed', exitDetail: { ...base, cases: result.cases.length } };
};

const halt = (exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason: JUDGE_RUNNER_ERROR_REASON,
  exitDetail,
});

/** Red 확인 단계 실행기를 만든다 (기본 실행기 목록에 등록된다). */
export const createRedCheckExecutor =
  (options: RedCheckOptions = {}): StepExecutor =>
  async (context): Promise<StepOutcome> => {
    // 판정할 커밋 = 마지막 완료 단계(테스트 작성) 커밋
    const commit = context.run.headCommit;
    const lastWriting = context.steps
      .filter((step) => step.kind === 'test_writing' && step.status === 'passed')
      .at(-1);
    if (commit === null || lastWriting?.commit !== commit) {
      return {
        status: 'halt',
        runStatus: 'failed',
        reason: 'state_inconsistent',
        exitDetail: {
          message: '테스트 작성 커밋이 실행의 마지막 완료 단계 커밋이 아닙니다',
          commit,
        },
      };
    }
    const ruleIds = context.read((store) =>
      context.run.targetRuleIds.map((id) => store.rules.get(id)?.displayId ?? null),
    );
    if (ruleIds.some((id) => id === null)) {
      return {
        status: 'halt',
        runStatus: 'failed',
        reason: 'target_rule_unavailable',
        exitDetail: { ruleIds: context.run.targetRuleIds },
      };
    }
    const targets = ruleIds as string[];

    let checkout;
    try {
      checkout = await createJudgeCheckout({
        repoPath: context.git.repoPath,
        biveHome: context.biveHome,
        projectId: context.project.id,
        runDisplayId: context.run.displayId,
        commit,
        ...(options.git === undefined ? {} : { git: options.git }),
      });
    } catch (error) {
      if (!(error instanceof JudgeCheckoutError)) throw error;
      return halt({ stage: error.stage, commit, message: error.message });
    }
    try {
      // 인수 테스트 보호(architecture.md 4장): 판정 전 커밋 그대로의 해시. 통과하면 기록하고 검사 단계가 대조한다
      const acceptanceHashes = hashAcceptanceFiles(checkout.dir);
      // 설치 기록은 에이전트가 닿지 않는 판정 폴더 쪽에 남긴다
      const logDir = path.join(
        context.biveHome,
        'projects',
        context.project.id,
        'judge',
        context.run.id,
      );
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const logFile = path.join(logDir, `install-${newId()}.log`);
      try {
        await (options.installDependencies ?? installDependencies)(checkout.dir, {
          logFile,
          timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
          // 오케스트레이터 종료 · 실행 중단 때 설치 · 판정 프로세스도 멈춘다 (ADR-068 한계 → ADR-069)
          signal: context.signal,
        });
      } catch (error) {
        if (!(error instanceof JudgeCheckoutError)) throw error;
        return halt({ stage: error.stage, commit, message: error.message, logFile });
      }
      context.signal.throwIfAborted();
      const input: JudgeRunInput = {
        projectId: context.project.id,
        runId: context.run.id,
        worktreeDir: checkout.dir,
        profile: options.profile ?? 'next-prisma-sqlite',
        ruleIds: targets,
        timeoutMs: options.judgeTimeoutMs ?? DEFAULT_RED_JUDGE_TIMEOUT_MS,
        signal: context.signal,
      };
      const result = await (options.judge === undefined
        ? new JudgeRunner({ biveHome: context.biveHome }).run(input)
        : options.judge(input, context));
      context.signal.throwIfAborted();
      const evaluated = evaluateRed(result, targets);
      const exitDetail = { ...evaluated.exitDetail, commit };
      if (evaluated.status === 'runner_error') return halt(exitDetail);
      if (evaluated.status === 'unmet') return { status: 'unmet', exitDetail };
      return { status: 'passed', exitDetail: { ...exitDetail, acceptanceHashes } };
    } finally {
      await checkout.dispose();
    }
  };
