// 병합 단계 실행기 (RUN-08 · JDG-01 · NFR-01, architecture.md 4장 7단계, ADR-017 · ADR-058 · ADR-065 · ADR-066 · ADR-069).
// 검사를 통과한 커밋(`Run.headCommit`)을 워크트리 관리자의 `merge`로 기준 브랜치에 병합한다.
// - 실행 브랜치 끝이 검사한 커밋과 같아야 한다(판정한 코드 = 병합되는 코드). 다르면 `failed`(`state_inconsistent`)
// - 기준 브랜치가 실행 시작 뒤 바뀌었으면 관리자가 병합 커밋으로 검사 함수를 부른다(ADR-017): 병합 커밋의 깨끗한
//   체크아웃에 의존성을 새로 설치하고 승인된 규칙 전체 인수 테스트를 판정한다(검사 단계와 같은 판정 대상, 인수 테스트 해시
//   대조는 하지 않는다: 기준 브랜치가 다른 규칙의 테스트를 더했을 수 있다). 판정 직전 · 판정 뒤 규범 저장소를 대조한다
// - 관리자에 검사 제한 시간(`checkTimeoutMs` = 설치 + 판정 제한 + 여유)과 엔진의 중단 신호를 넘긴다(ADR-065: 관리자 기본값 없음).
//   검사 함수는 관리자의 검사 신호로 설치 · 판정 프로세스를 멈춘다
// - 병합 성공 → `passed`(`run.mergeCommit`), 실패 → `failed`(사유는 ADR-058 값 그대로), 브랜치 · 워크트리는 엔진이 보존
// - 재개(ADR-066 한계): 병합 단계 도중 비정상 종료로 기준 브랜치가 이미 갱신된 뒤 다시 병합하면 `no_changes`가 된다.
//   그때 기준 브랜치에 이 실행의 BIVE 병합 커밋(트레일러 `Bive-Run` · `Bive-Project`, 둘째 부모 = 검사한 커밋)이 있으면
//   그 커밋으로 `passed`(`recovered: true`)로 마무리한다
import type { Rule } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import type { MergeCheck } from '../git/worktree-manager.js';
import { DEFAULT_INSTALL_TIMEOUT_MS } from '../judge/checkout.js';
import { approvedRules } from './check.js';
import {
  createNormGuard,
  DEFAULT_JUDGE_TIMEOUT_MS,
  judgeCommit,
  judgeSummary,
  judgmentDigest,
  judgmentsFrom,
  type JudgingOptions,
  lastPassed,
  normHalt,
  recordJudgments,
} from './judging.js';
import type { NormMismatch } from '@bive/store';

/** 체크아웃 · 정리에 더하는 검사 제한 시간 여유. */
export const MERGE_CHECK_MARGIN_MS = 60_000;

export interface MergeStepOptions extends JudgingOptions {
  /** 병합 검사 제한 시간 (기본: 설치 + 판정 제한 시간 + 여유 1분) */
  checkTimeoutMs?: number;
}

const halt = (reason: string, exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason,
  exitDetail,
});

/**
 * 기준 브랜치에 이미 있는 이 실행의 BIVE 병합 커밋 (재개 뒤 `no_changes` 처리). 트레일러 `Bive-Run: <EXE-ID>` ·
 * `Bive-Project: <projectId>`(ADR-058 병합 커밋 메시지)와 둘째 부모 = 검사한 커밋이 모두 맞는 병합 커밋만. 없으면 `null`.
 */
export const findRecordedMerge = async (
  git: GitRunner,
  context: Pick<StepContext, 'git' | 'run' | 'project'>,
  headCommit: string,
): Promise<string | null> => {
  const result = await git(
    [
      'log',
      '--merges',
      '-n',
      '200',
      '--format=%H%x00%P%x00%B%x1e',
      `refs/heads/${context.git.baseBranch}`,
      '--',
    ],
    { cwd: context.git.repoPath, okCodes: [0, 128] },
  );
  if (result.code !== 0) return null;
  for (const record of result.stdout.split('\x1e')) {
    const [hash, parents, body] = record.replace(/^\n/u, '').split('\0');
    if (hash === undefined || parents === undefined || body === undefined) continue;
    const lines = body.split('\n').map((line) => line.trim());
    if (
      parents.split(' ')[1] === headCommit &&
      lines.includes(`Bive-Run: ${context.run.displayId}`) &&
      lines.includes(`Bive-Project: ${context.project.id}`)
    ) {
      return hash;
    }
  }
  return null;
};

/** 병합 단계 실행기를 만든다 (기본 실행기 목록에 등록된다). */
export const createMergeExecutor =
  (options: MergeStepOptions = {}): StepExecutor =>
  async (context: StepContext): Promise<StepOutcome> => {
    const git = options.git ?? createGitRunner();
    const headCommit = context.run.headCommit;
    if (
      headCommit === null ||
      lastPassed(context.steps, 'check') === undefined ||
      lastPassed(context.steps, 'implementation')?.commit !== headCommit
    ) {
      return halt('state_inconsistent', {
        message: '검사를 통과한 구현 커밋이 실행의 마지막 완료 단계 커밋이 아닙니다',
        headCommit,
      });
    }
    const tip = await git(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${context.git.branch}^{commit}`],
      {
        cwd: context.git.repoPath,
        okCodes: [0, 1],
      },
    );
    if (tip.stdout.trim() !== headCommit) {
      return halt('state_inconsistent', {
        message: '실행 브랜치 끝이 검사한 커밋과 다릅니다',
        headCommit,
        branchCommit: tip.stdout.trim() || null,
      });
    }

    const norms = createNormGuard(context);
    const rules: Rule[] = approvedRules(context);
    let integrity: { moment: 'before_judge' | 'after_judge'; mismatches: NormMismatch[] } | null =
      null;
    let recheck: Record<string, unknown> | null = null;

    // 기준 브랜치가 바뀐 경우에만 관리자가 부른다 (병합 커밋의 깨끗한 체크아웃에서 승인된 규칙 전체 판정)
    const check: MergeCheck = async (merge) => {
      const judged = await judgeCommit(
        context,
        {
          commit: merge.mergeCommit,
          selectRules: (dirs) =>
            rules.filter((rule) => dirs.includes(rule.displayId)).map((rule) => rule.displayId),
          norms,
          signal: merge.signal,
        },
        options,
      );
      switch (judged.kind) {
        case 'checkout_error':
        case 'install_error':
          recheck = { stage: judged.kind, message: judged.message };
          return { passed: false, detail: `${judged.kind}: ${judged.message}` };
        case 'acceptance_changed':
          // 해시를 지정하지 않으므로 생기지 않는다
          return { passed: false, detail: 'acceptance_changed' };
        case 'norm_mismatch':
          integrity = { moment: judged.moment, mismatches: judged.mismatches };
          return { passed: false, detail: `norm_integrity: ${judged.moment}` };
        case 'no_rules':
          recheck = { stage: 'no_rules', ruleDirs: judged.ruleDirs };
          return { passed: false, detail: '판정할 승인된 규칙의 인수 테스트가 없습니다' };
        case 'judged':
          break;
      }
      const judgedRules = rules.filter((rule) => judged.ruleIds.includes(rule.displayId));
      const recorded = recordJudgments(
        context,
        judgmentsFrom(judged.result, judgedRules, {
          runId: context.run.id,
          stepId: context.step.id,
          commit: merge.mergeCommit,
        }),
      );
      const passed =
        judged.result.status === 'completed' && recorded.every((item) => item.status === 'pass');
      recheck = {
        mergeCommit: merge.mergeCommit,
        ruleIds: judged.ruleIds,
        ...judgeSummary(judged.result),
        judgments: judgmentDigest(recorded, judgedRules),
      };
      return {
        passed,
        ...(passed
          ? {}
          : {
              detail:
                judged.result.status === 'completed'
                  ? `실패한 규칙: ${recorded
                      .filter((item) => item.status !== 'pass')
                      .map((item) => judgedRules.find((rule) => rule.id === item.ruleId)?.displayId)
                      .join(', ')}`
                  : `${judged.result.status}: ${judged.result.message ?? ''}`,
            }),
      };
    };

    const checkTimeoutMs =
      options.checkTimeoutMs ??
      (options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS) +
        (options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS) +
        MERGE_CHECK_MARGIN_MS;
    const result = await context.worktrees.merge(context.git, {
      check,
      checkTimeoutMs,
      signal: context.signal,
    });
    context.signal.throwIfAborted();
    const checked = recheck as Record<string, unknown> | null;
    const tampered = integrity as {
      moment: 'before_judge' | 'after_judge';
      mismatches: NormMismatch[];
    } | null;
    if (tampered !== null) {
      // 검사가 실패로 돌아가 병합하지 않았다. 판정을 믿을 수 없으므로 검사 실패가 아니라 규범 불일치로 끝낸다
      return normHalt(tampered.moment, tampered.mismatches, {
        mergeStatus: result.status,
        ...(result.status === 'failed' ? { mergeReason: result.reason } : {}),
      });
    }
    if (result.status === 'merged') {
      return {
        status: 'passed',
        exitDetail: {
          mergeCommit: result.mergeCommit,
          previousBaseCommit: result.previousBaseCommit,
          headCommit: result.headCommit,
          rechecked: result.rechecked,
          baseUpdate: result.baseUpdate,
          checkTimeoutMs,
          ...(checked === null ? {} : { recheck: checked }),
        },
        run: { mergeCommit: result.mergeCommit },
      };
    }
    if (result.reason === 'no_changes') {
      const recovered = await findRecordedMerge(git, context, headCommit);
      if (recovered !== null) {
        return {
          status: 'passed',
          exitDetail: { mergeCommit: recovered, headCommit, recovered: true },
          run: { mergeCommit: recovered },
        };
      }
    }
    return halt(result.reason, {
      message: result.message,
      branch: result.branch,
      headCommit: result.headCommit,
      checkTimeoutMs,
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.checkDetail === undefined ? {} : { checkDetail: result.checkDetail }),
      ...(result.movedRef === undefined ? {} : { movedRef: result.movedRef }),
      ...(checked === null ? {} : { recheck: checked }),
    });
  };
