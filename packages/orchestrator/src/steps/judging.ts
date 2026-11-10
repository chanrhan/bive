// 구현 · 검사 · 병합 재검사가 함께 쓰는 판정 절차 (JDG-01 · JDG-02 · RUN-08 · NFR-01, ADR-051 · ADR-058 · ADR-068 · ADR-069).
// 판정은 실행 워크트리가 아니라 판정할 커밋의 깨끗한 체크아웃에서 돈다(`judge/checkout.ts`). 순서:
//   체크아웃(추적 파일만) → 인수 테스트 해시 대조(Red 확인 기록과, 지정한 경우) → 의존성 새로 설치(`node_modules` 비공유)
//   → 규범 저장소 확인(판정 직전) → 판정 러너 → 규범 저장소 확인(판정 뒤: 판정은 프로젝트 코드를 실행한다) → 체크아웃 삭제
// 판정 결과의 해석(통과 · 미충족)과 저장은 호출한 단계가 한다. 판정 기록은 판정 러너가 케이스 결과를 낸(`completed`)
// 판정에서만 만든다: 수집 오류 · 러너 오류는 규칙을 판정하지 못한 것이라 기록하지 않는다(단계 결과에만 남긴다).
import fs from 'node:fs';
import path from 'node:path';

import {
  createUlidGenerator,
  type JudgmentCase,
  type JudgmentResult,
  type Rule,
  type Step,
  type StepKind,
} from '@bive/shared';
import { captureNormSnapshot, compareNormSnapshots, type NormMismatch } from '@bive/store';

import type { StepContext, StepOutcome } from '../engine/types.js';
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
import { JUDGE_RUNNER_ERROR_REASON } from './red-check.js';

/** 구현 · 검사 판정 제한 시간 (기본): 서버 빌드 · 기동 · vitest 전체. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 10 * 60_000;

/** 규범 저장소 불일치로 실행을 끝낼 때 `exitDetail.stage` (실패 사유는 `judge_runner_error`, #117 기본 조치). */
export const NORM_INTEGRITY_STAGE = 'norm_integrity';

/** 판정 · 설치를 바꿔 끼우는 선택 (시험용 주입, 기본은 실제 설치 · 판정 러너). */
export interface JudgingOptions {
  /** 판정 실행 (기본 `new JudgeRunner({ biveHome }).run`) */
  judge?: (input: JudgeRunInput, context: StepContext) => Promise<JudgeRunResult>;
  /** 체크아웃 · 실행 워크트리 의존성 설치 (기본 `pnpm install --frozen-lockfile`) */
  installDependencies?: InstallDependencies;
  git?: GitRunner;
  profile?: JudgeProfileName;
  judgeTimeoutMs?: number;
  installTimeoutMs?: number;
}

const newId = createUlidGenerator();
/** 기록에 담는 항목 상한. */
export const MAX_LISTED = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 설치 기록 파일 (에이전트가 닿지 않는 판정 폴더 쪽, ADR-068과 같은 위치). */
export const installLogFile = (context: StepContext): string => {
  const dir = path.join(context.biveHome, 'projects', context.project.id, 'judge', context.run.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `install-${newId()}.log`);
};

/** 마지막으로 통과한 단계 시도 (없으면 `undefined`). */
export const lastPassed = (steps: readonly Step[], kind: StepKind): Step | undefined =>
  steps.filter((step) => step.kind === kind && step.status === 'passed').at(-1);

/** Red 확인 통과 때 기록한 인수 테스트 해시 (architecture.md 4장 인수 테스트 보호). 없거나 형식이 틀리면 `null`. */
export const redAcceptanceHashes = (steps: readonly Step[]): Record<string, string> | null => {
  const red = lastPassed(steps, 'red_check');
  const hashes = isRecord(red?.exitDetail) ? red.exitDetail.acceptanceHashes : undefined;
  if (!isRecord(hashes)) return null;
  const entries = Object.entries(hashes);
  if (entries.length === 0 || entries.some(([, value]) => typeof value !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
};

/** 두 해시 목록의 차이 (추가 · 삭제 · 변경된 경로, 정렬). */
export const changedAcceptanceFiles = (
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string[] =>
  [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .filter((file) => expected[file] !== actual[file])
    .sort();

/** 해시 목록에 나오는 규칙 폴더 이름 (`bive-acceptance/<이름>/…*.acc.ts`). */
const ruleDirsOf = (hashes: Readonly<Record<string, string>>): string[] =>
  [
    ...new Set(
      Object.keys(hashes)
        .map((file) => ruleIdOfAcceptanceFile(file))
        .filter((id): id is string => id !== null),
    ),
  ].sort();

// ── 규범 저장소 확인 ─────────────────────────────────────

/** 단계 실행기 안에서 쓰는 규범 저장소 확인: 만들 때 스냅숏을 메모리에 두고 `verify`마다 대조한다. */
export interface NormGuard {
  verify(): NormMismatch[];
}

export const createNormGuard = (context: StepContext): NormGuard => {
  const before = context.read((store) => captureNormSnapshot(store, context.run.id));
  return {
    verify: () => {
      try {
        return compareNormSnapshots(
          before,
          context.read((store) => captureNormSnapshot(store, context.run.id)),
        );
      } catch (error) {
        return [
          {
            kind: 'unreadable',
            detail: `규범 저장소를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
          },
        ];
      }
    },
  };
};

/** 규범 저장소 불일치: 판정을 믿을 수 없으므로 판정하지 않고 실행을 끝낸다 (재시도 없음). */
export const normHalt = (
  moment: 'after_session' | 'before_judge' | 'after_judge',
  mismatches: readonly NormMismatch[],
  extra: Record<string, unknown> = {},
): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason: JUDGE_RUNNER_ERROR_REASON,
  exitDetail: {
    ...extra,
    stage: NORM_INTEGRITY_STAGE,
    moment,
    message:
      '규범 저장소(승인 기록 · 규칙 · 실행 기록)가 판정 전후로 바뀌어 판정을 믿을 수 없습니다',
    mismatches: mismatches.slice(0, MAX_LISTED),
  },
});

// ── 커밋 판정 ─────────────────────────────────────────

export type CommitJudgeOutcome =
  | { readonly kind: 'checkout_error'; readonly message: string }
  | { readonly kind: 'install_error'; readonly message: string; readonly logFile: string }
  | { readonly kind: 'acceptance_changed'; readonly changed: string[] }
  | {
      readonly kind: 'norm_mismatch';
      readonly moment: 'before_judge' | 'after_judge';
      readonly mismatches: NormMismatch[];
    }
  | { readonly kind: 'no_rules'; readonly ruleDirs: string[] }
  | {
      readonly kind: 'judged';
      readonly result: JudgeRunResult;
      /** 판정한 규칙 폴더 (= 규칙 표시 ID) */
      readonly ruleIds: string[];
      /** 체크아웃의 인수 테스트 해시 */
      readonly acceptanceHashes: Record<string, string>;
    };

export interface CommitJudgeInput {
  readonly commit: string;
  /** 체크아웃에 있는 규칙 폴더 이름(정렬)을 받아 판정할 규칙 표시 ID를 고른다 */
  readonly selectRules: (ruleDirs: readonly string[]) => string[];
  /** 지정하면 체크아웃의 `bive-acceptance/` 해시가 같아야 한다 (Red 확인 기록) */
  readonly expectedAcceptanceHashes?: Readonly<Record<string, string>>;
  readonly norms: NormGuard;
  readonly signal: AbortSignal;
}

/** 커밋의 깨끗한 체크아웃에서 판정한다. 체크아웃은 어떤 경우에도 지운다. */
export const judgeCommit = async (
  context: StepContext,
  input: CommitJudgeInput,
  options: JudgingOptions = {},
): Promise<CommitJudgeOutcome> => {
  let checkout;
  try {
    checkout = await createJudgeCheckout({
      repoPath: context.git.repoPath,
      biveHome: context.biveHome,
      projectId: context.project.id,
      runDisplayId: context.run.displayId,
      commit: input.commit,
      ...(options.git === undefined ? {} : { git: options.git }),
    });
  } catch (error) {
    if (!(error instanceof JudgeCheckoutError)) throw error;
    return { kind: 'checkout_error', message: error.message };
  }
  try {
    // 인수 테스트 보호: 판정 전 커밋 그대로의 해시를 Red 확인 기록과 대조한다
    const acceptanceHashes = hashAcceptanceFiles(checkout.dir);
    if (input.expectedAcceptanceHashes !== undefined) {
      const changed = changedAcceptanceFiles(input.expectedAcceptanceHashes, acceptanceHashes);
      if (changed.length > 0) return { kind: 'acceptance_changed', changed };
    }
    const ruleIds = input.selectRules(ruleDirsOf(acceptanceHashes));
    if (ruleIds.length === 0) return { kind: 'no_rules', ruleDirs: ruleDirsOf(acceptanceHashes) };
    const logFile = installLogFile(context);
    try {
      await (options.installDependencies ?? installDependencies)(checkout.dir, {
        logFile,
        timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        signal: input.signal,
      });
    } catch (error) {
      if (!(error instanceof JudgeCheckoutError)) throw error;
      return { kind: 'install_error', message: error.message, logFile };
    }
    input.signal.throwIfAborted();
    // 판정 직전: 세션 · 설치(프로젝트 postinstall)가 규범 저장소를 고쳤으면 판정하지 않는다
    const before = input.norms.verify();
    if (before.length > 0)
      return { kind: 'norm_mismatch', moment: 'before_judge', mismatches: before };
    const judgeInput: JudgeRunInput = {
      projectId: context.project.id,
      runId: context.run.id,
      worktreeDir: checkout.dir,
      profile: options.profile ?? 'next-prisma-sqlite',
      ruleIds,
      timeoutMs: options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
      signal: input.signal,
    };
    const result = await (options.judge === undefined
      ? new JudgeRunner({ biveHome: context.biveHome }).run(judgeInput)
      : options.judge(judgeInput, context));
    input.signal.throwIfAborted();
    // 판정 뒤: 판정은 프로젝트 코드(빌드 · 서버)를 실행하므로 그 결과를 쓰기 전에 다시 본다
    const after = input.norms.verify();
    if (after.length > 0)
      return { kind: 'norm_mismatch', moment: 'after_judge', mismatches: after };
    return { kind: 'judged', result, ruleIds, acceptanceHashes };
  } finally {
    await checkout.dispose();
  }
};

// ── 판정 결과 해석 · 기록 ──────────────────────────────

/** 판정 러너 결과의 요약 (단계 `exitDetail`에 싣는다). */
export const judgeSummary = (result: JudgeRunResult): Record<string, unknown> => ({
  judgeId: result.judgeId,
  judgeStatus: result.status,
  summary: result.summary,
  exitCode: result.exitCode,
  reporterPath: result.reporterPath,
  ...(result.status === 'completed'
    ? {}
    : { message: result.message, problems: result.problems.slice(0, MAX_LISTED) }),
});

/** 케이스 요약 (실패 위치 `file:line` · 메시지). */
export const caseSummary = (item: JudgmentCase) => ({
  name: item.name,
  file: item.file,
  line: item.line,
  status: item.status,
  message: item.message,
});

/** 규칙의 케이스. */
export const casesOf = (result: JudgeRunResult, displayId: string): JudgmentCase[] =>
  result.cases.filter((item) => ruleIdOfAcceptanceFile(item.file) === displayId);

/**
 * `completed` 판정 결과 → 규칙별 판정 기록. 규칙의 케이스가 1개 이상이고 전부 `passed`면 `pass`, 아니면 `fail`
 * (건너뜀 · todo도 통과가 아니다, ADR-051). 그 밖의 결과(수집 · 러너 오류)는 기록하지 않는다(`[]`).
 */
export const judgmentsFrom = (
  result: JudgeRunResult,
  rules: readonly Pick<Rule, 'id' | 'displayId'>[],
  meta: { runId: string; stepId: string; commit: string },
): JudgmentResult[] => {
  if (result.status !== 'completed') return [];
  return rules.map((rule) => {
    const cases = casesOf(result, rule.displayId);
    const pass = cases.length > 0 && cases.every((item) => item.status === 'passed');
    return {
      id: newId(),
      ruleId: rule.id,
      runId: meta.runId,
      stepId: meta.stepId,
      commit: meta.commit,
      judgedAt: result.endedAt,
      status: pass ? 'pass' : 'fail',
      runner: result.runner,
      exitCode: result.exitCode,
      reporterPath: result.reporterPath,
      cases,
      quarantineReason: null,
    };
  });
};

/** 판정 기록을 저장한다 (판정 1회 = 트랜잭션 1회). */
export const recordJudgments = (
  context: StepContext,
  judgments: readonly JudgmentResult[],
): JudgmentResult[] =>
  judgments.length === 0 ? [] : context.read((store) => store.judgments.record(judgments));

/** 저장한 판정 기록의 요약 (규칙 표시 ID · 상태 · 실패 케이스 위치). */
export const judgmentDigest = (
  judgments: readonly JudgmentResult[],
  rules: readonly Pick<Rule, 'id' | 'displayId'>[],
): Record<string, unknown>[] =>
  judgments.map((judgment) => ({
    judgmentId: judgment.id,
    ruleId: rules.find((rule) => rule.id === judgment.ruleId)?.displayId ?? judgment.ruleId,
    status: judgment.status,
    failedCases: judgment.cases
      .filter((item) => item.status !== 'passed')
      .slice(0, MAX_LISTED)
      .map(caseSummary),
  }));
