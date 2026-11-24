// 병합 단계 실행기 (RUN-08 · JDG-01 · NFR-01, architecture.md 4장 7단계, ADR-017 · ADR-058 · ADR-065 · ADR-066 · ADR-069).
// 검사를 통과한 커밋(`Run.headCommit`)을 워크트리 관리자의 `merge`로 기준 브랜치에 병합한다.
// - 실행 브랜치 끝이 검사한 커밋과 같아야 한다(판정한 코드 = 병합되는 코드). 다르면 `failed`(`state_inconsistent`)
// - 기준 브랜치가 실행 시작 뒤 바뀌었으면 관리자가 병합 커밋으로 검사 함수를 부른다(ADR-017): 병합 커밋의 깨끗한
//   체크아웃에 의존성을 새로 설치하고 승인된 규칙 전체 인수 테스트를 판정한다(검사 단계와 같은 판정 대상, 인수 테스트 해시
//   대조는 하지 않는다: 기준 브랜치가 다른 규칙의 테스트를 더했을 수 있다). 판정 직전 · 판정 뒤 규범 저장소를 대조한다
// - 관리자에 검사 제한 시간(`checkTimeoutMs` = 설치 + 판정 제한 + 여유)과 엔진의 중단 신호를 넘긴다(ADR-065: 관리자 기본값 없음).
//   검사 함수는 관리자의 검사 신호로 설치 · 판정 프로세스를 멈춘다
// - 병합 성공 → `passed`(`run.mergeCommit`), 실패 → `failed`(사유는 ADR-058 값 그대로), 브랜치 · 워크트리는 엔진이 보존
// - 병합 직전 대상 규칙 재확인 (ADR-100 A3 · A4, M7-09, ADR-112): 단계를 열기 전에는 엔진이 대상 규칙의 폐기를 보고, 이 실행기는
//   병합을 부르기 직전(`stage: before_merge`)과 병합 재검사의 판정 뒤(`stage: merge_recheck`)에 다시 본다. 폐기됐으면 병합하지 않고
//   `failed`(`target_rule_retired`, 폐기된 대상 규칙의 표시 ID). 관리자가 기준 브랜치를 갱신하기 바로 전(기다림 없이 갱신으로
//   이어지는 자리, `beforeUpdate`)에 한 번 더 보고 폐기됐으면 갱신하지 않는다(`stage: before_update`, M3-36 #264 · ADR-120:
//   ADR-112의 "관리자의 병합 안 폐기" 틈을 닫는다. 그 뒤의 폐기는 병합 뒤의 폐기다). 검사 · 재검사의 판정 대상은 효력 있는 규칙이다(폐기된 규칙의 인수 테스트 폴더는 남아 있어도 판정하지 않는다)
// - 병합 순서 값(ADR-096): 기준 브랜치 갱신을 확인한 뒤(정상 병합 · 재개 복구 모두) 이 실행의 병합 커밋의 전체 조상 수를
//   한 번 읽어 단계 결과 `mergeOrder`에 남긴다(판정 기준 순서, `verification/summary.ts`). 짧은 제한 시간 안에 못 읽거나
//   실패하면 `null`(+ `mergeOrderError`)이고 병합 결과 · 단계 상태는 바뀌지 않는다
// - 재개(ADR-066 한계): 병합 단계 도중 비정상 종료로 기준 브랜치가 이미 갱신된 뒤 다시 병합하면 `no_changes`가 된다.
//   직전 병합 시도가 재기동 중단(`interrupted`)일 때만, 기준 브랜치에 이 실행의 BIVE 병합 커밋(트레일러 `Bive-Run` ·
//   `Bive-Project`, 둘째 부모 = 검사한 커밋)이 있고 그 트리가 첫 부모와 검사한 커밋의 병합 결과(`git merge-tree`)와 같으면
//   그 커밋으로 `passed`(`recovered: true`)로 마무리한다. 첫 시도 · 트리가 다르면(검사하지 않은 파일) 복구하지 않는다(검토 1회차)
// - 병합 재검사의 기존 규칙 실패 (M7-12 #224, ADR-100 B⑧ · A4 · A5, ADR-118): 재검사에서 대상이 아닌 효력 있는 규칙만 실패하면(병합은
//   일어나지 않았다) 관리자가 돌아온 뒤 검사 단계와 같은 판단을 한다(`steps/existing-rule.ts`, 판단 세션은 관리자의 잠금 밖에서
//   연다). 모순이면 `failed`(`existing_rule_contradiction`), 모순 없음이면 지금처럼 재검사 실패로 끝난다(병합 단계에는 구현 회귀가
//   없다). 병합 커밋이 기록된 뒤의 실패는 이 판단과 무관하게 `merged`로 끝난다(ADR-091 · ADR-094). 이 실행에 모순 판단이 이미
//   있으면(재기동 · 재개) 병합하지 않고 끝낸다
import type { JudgmentResult, Rule } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import type { MergeCheck } from '../git/worktree-manager.js';
import { DEFAULT_INSTALL_TIMEOUT_MS } from '../judge/checkout.js';
import { retiredTargetDisplayIds, TARGET_RULE_RETIRED } from '../norms/effective.js';
import { approvedRules } from './check.js';
import { contradictionHalt, judgeExistingRuleFailures } from './existing-rule.js';
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
  /** 병합 순서 값 읽기 제한 시간 (기본 `MERGE_ORDER_TIMEOUT_MS`) */
  mergeOrderTimeoutMs?: number;
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
): Promise<{ hash: string; firstParent: string } | null> => {
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
    const [firstParent, secondParent, ...rest] = parents.split(' ');
    if (
      firstParent !== undefined &&
      rest.length === 0 &&
      secondParent === headCommit &&
      lines.includes(`Bive-Run: ${context.run.displayId}`) &&
      lines.includes(`Bive-Project: ${context.project.id}`)
    ) {
      return { hash, firstParent };
    }
  }
  return null;
};

/**
 * 병합 커밋의 트리가 첫 부모와 검사한 커밋을 병합한 결과(`git merge-tree --write-tree`, 관리자의 `merge --no-ff`와 같은
 * 병합 방식)와 같은지. 같지 않으면(병합에 검사하지 않은 변경이 섞임) 사유를 돌려준다.
 */
export const verifyRecordedMergeTree = async (
  git: GitRunner,
  repoPath: string,
  merge: { hash: string; firstParent: string },
  headCommit: string,
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason: 'tree_mismatch' | 'conflict';
      expectedTree: string | null;
      actualTree: string;
    }
> => {
  const actual = (
    await git(['rev-parse', '--verify', `${merge.hash}^{tree}`], { cwd: repoPath })
  ).stdout.trim();
  const expected = await git(['merge-tree', '--write-tree', merge.firstParent, headCommit], {
    cwd: repoPath,
    okCodes: [0, 1],
  });
  if (expected.code !== 0) {
    return { ok: false, reason: 'conflict', expectedTree: null, actualTree: actual };
  }
  const expectedTree = expected.stdout.split('\n')[0]?.trim() ?? '';
  return expectedTree === actual
    ? { ok: true }
    : { ok: false, reason: 'tree_mismatch', expectedTree, actualTree: actual };
};

/**
 * 병합 순서 값 읽기 제한 시간 (ADR-096). git 기본 제한(5분)을 쓰지 않는다: 기준 브랜치를 이미 갱신한 뒤의 부가 기록이라
 * 오래 걸리면 기다리지 않고 값 없음으로 남긴다. 이 VM에서 커밋 100만 개 선형 저장소의 `rev-list --count`가 commit-graph
 * 없이 약 5초, 있으면 약 1.4초였다.
 */
export const MERGE_ORDER_TIMEOUT_MS = 10_000;

/** 병합 순서 값 읽기 결과. 값이 없으면 사유(`timeout` · `aborted` · git 오류 문장 등, 200자 이하)를 함께 남긴다. */
export type MergeOrderRead = { mergeOrder: number } | { mergeOrder: null; mergeOrderError: string };

const ORDER_ERROR_MAX = 200;

/**
 * 병합 커밋의 병합 순서 값: 그 커밋의 전체 조상 수(자신 포함, `git rev-list --count`, ADR-096). 커밋 자체의 성질이라
 * 언제 읽어도 같고(얕은 저장소 · 이력 재작성 제외), 같은 저장소에서 나중 병합은 앞 병합의 자손이라 값이 엄격히 크다.
 * `--first-parent`는 쓰지 않는다(사람이 기준 브랜치를 빨리 감기하면 줄어든다). replace 참조는 따르지 않는다.
 * 어떤 실패도 던지지 않는다: 예외 · git 오류 · 제한 시간 · 중단 신호는 `null`과 사유로 돌려준다.
 */
export const readMergeOrder = async (
  git: GitRunner,
  repoPath: string,
  mergeCommit: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<MergeOrderRead> => {
  const timeoutMs = options.timeoutMs ?? MERGE_ORDER_TIMEOUT_MS;
  const missing = (reason: string): MergeOrderRead => ({
    mergeOrder: null,
    mergeOrderError: reason.slice(0, ORDER_ERROR_MAX),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // git 실행기가 제한 시간을 지키지 않아도(주입된 실행기 등) 이 함수는 제한 시간 뒤에 돌아온다
  const deadline = new Promise<MergeOrderRead>((resolve) => {
    timer = setTimeout(() => resolve(missing('timeout')), timeoutMs);
    onAbort = () => resolve(missing('aborted'));
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  const read = (async (): Promise<MergeOrderRead> => {
    try {
      const result = await git(['--no-replace-objects', 'rev-list', '--count', mergeCommit, '--'], {
        cwd: repoPath,
        okCodes: [0, 128],
        timeoutMs,
      });
      if (result.code !== 0)
        return missing(result.stderr.trim() || `git 종료 코드 ${String(result.code)}`);
      const count = Number(result.stdout.trim());
      return Number.isSafeInteger(count) && count > 0
        ? { mergeOrder: count }
        : missing(`읽은 값이 조상 수가 아님: ${result.stdout.trim()}`);
    } catch (error) {
      return missing(error instanceof Error ? error.message : String(error));
    }
  })();
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort);
  }
};

/** 이 병합 단계의 앞 시도가 재기동 중단으로 끝났는지 (재개 뒤의 새 시도). */
const resumedAfterInterruption = (context: StepContext): boolean =>
  context.steps.some(
    (step) =>
      step.kind === 'merge' &&
      step.id !== context.step.id &&
      typeof step.exitDetail === 'object' &&
      step.exitDetail !== null &&
      (step.exitDetail as { interrupted?: unknown }).interrupted === true,
  );

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

    // 병합 직전 대상 규칙 재확인 (ADR-100 A3 · A4, ADR-112): 단계를 열기 전은 엔진이 보고(`#prepare`), 여기서는 병합 재검사가
    // 도는 동안 폐기됐는지 본다. 폐기됐으면 병합하지 않고 사유를 남긴다
    const retiredTargets = (): string[] =>
      context.read((store) => retiredTargetDisplayIds(store, context.run.targetRuleIds));
    const retiredHalt = (retiredRuleIds: string[], extra: Record<string, unknown> = {}) =>
      halt(TARGET_RULE_RETIRED, {
        ...extra,
        message: '병합 직전에 대상 규칙이 폐기되어 병합하지 않았습니다',
        retiredRuleIds,
        headCommit,
      });

    // 모순 판단으로 끝나야 할 실행은 병합하지 않는다 (재기동 · 재개로 종료 처리가 끊긴 경우, ADR-100 A4)
    const contradicted = contradictionHalt(context);
    if (contradicted !== null) return contradicted;
    const norms = createNormGuard(context);
    const rules: Rule[] = approvedRules(context);
    let retiredDuringCheck: string[] = [];
    /** 재검사 판정이 끝났고 통과하지 못한 규칙이 있을 때의 판정 기록 · 인수 테스트 내용 (기존 규칙 판단용) */
    let failedRecheck: {
      judgments: JudgmentResult[];
      rules: Rule[];
      acceptanceTexts: Readonly<Record<string, string>>;
    } | null = null;
    let integrity: { moment: 'before_judge' | 'after_judge'; mismatches: NormMismatch[] } | null =
      null;
    let recheck: Record<string, unknown> | null = null;
    let tamperedInputs: { changed: string[]; moment: string | null } | null = null;

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
          readAcceptanceTexts: true,
        },
        options,
      );
      switch (judged.kind) {
        case 'checkout_error':
        case 'install_error':
          recheck = { stage: judged.kind, message: judged.message };
          return { passed: false, detail: `${judged.kind}: ${judged.message}` };
        case 'acceptance_changed':
          // 판정 러너가 판정 중 입력 변조를 잡았다 (해시를 지정하지 않으므로 판정 전 대조로는 생기지 않는다)
          tamperedInputs = { changed: judged.changed, moment: judged.moment ?? null };
          return {
            passed: false,
            detail: `judge_inputs: ${judged.changed.slice(0, 5).join(', ')}`,
          };
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
      // 재검사가 도는 동안 대상 규칙이 폐기됐으면 통과여도 병합하지 않는다 (병합 직전, ADR-112)
      retiredDuringCheck = retiredTargets();
      const passed =
        retiredDuringCheck.length === 0 &&
        judged.result.status === 'completed' &&
        recorded.every((item) => item.status === 'pass');
      if (
        retiredDuringCheck.length === 0 &&
        judged.result.status === 'completed' &&
        recorded.some((item) => item.status !== 'pass')
      ) {
        failedRecheck = {
          judgments: recorded,
          rules: judgedRules,
          acceptanceTexts: judged.acceptanceTexts ?? {},
        };
      }
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
                retiredDuringCheck.length > 0
                  ? `대상 규칙 폐기: ${retiredDuringCheck.join(', ')}`
                  : judged.result.status === 'completed'
                    ? `실패한 규칙: ${recorded
                        .filter((item) => item.status !== 'pass')
                        .map(
                          (item) => judgedRules.find((rule) => rule.id === item.ruleId)?.displayId,
                        )
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
    // 병합을 부르기 직전 (실행 브랜치 끝 확인 등 앞의 비동기 동안 폐기됐을 수 있다)
    const retiredBeforeMerge = retiredTargets();
    if (retiredBeforeMerge.length > 0)
      return retiredHalt(retiredBeforeMerge, { stage: 'before_merge' });
    let retiredAtUpdate: string[] = [];
    const result = await context.worktrees.merge(context.git, {
      check,
      checkTimeoutMs,
      signal: context.signal,
      // 기준 브랜치 갱신 바로 전 (재검사 판정 뒤 · 관리자의 마지막 확인 동안 폐기됐을 수 있다)
      beforeUpdate: () => {
        retiredAtUpdate = retiredTargets();
        return retiredAtUpdate.length > 0 ? `대상 규칙 폐기: ${retiredAtUpdate.join(', ')}` : null;
      },
    });
    context.signal.throwIfAborted();
    if (result.status === 'failed' && result.reason === 'vetoed') {
      return retiredHalt(retiredAtUpdate, {
        stage: 'before_update',
        ...(recheck === null ? {} : { recheck: recheck as Record<string, unknown> }),
      });
    }
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
    const retiredInCheck = retiredDuringCheck as string[];
    if (retiredInCheck.length > 0 && result.status !== 'merged') {
      return retiredHalt(retiredInCheck, {
        stage: 'merge_recheck',
        mergeStatus: result.status,
        ...(checked === null ? {} : { recheck: checked }),
      });
    }
    const inputs = tamperedInputs as { changed: string[]; moment: string | null } | null;
    if (inputs !== null) {
      // 판정 입력 변조: 검사 실패가 아니라 가드 위반으로 끝낸다 (병합은 검사가 통과하지 않아 일어나지 않았다)
      return halt('guard_violation', {
        stage: 'judge_inputs',
        moment: inputs.moment,
        message: '병합 재검사 중 인수 테스트 · 테스트 실행기 · 판정 설정이 바뀌었습니다',
        changed: inputs.changed.slice(0, 50),
        mergeStatus: result.status,
      });
    }
    // 병합 커밋이 기준 브랜치에 들어간 뒤의 부가 기록: 실패해도 병합 결과는 바뀌지 않는다 (ADR-096)
    const orderOf = (mergeCommit: string): Promise<MergeOrderRead> =>
      readMergeOrder(git, context.git.repoPath, mergeCommit, {
        timeoutMs: options.mergeOrderTimeoutMs ?? MERGE_ORDER_TIMEOUT_MS,
        signal: context.signal,
      });
    if (result.status === 'merged') {
      const order = await orderOf(result.mergeCommit);
      return {
        status: 'passed',
        exitDetail: {
          mergeCommit: result.mergeCommit,
          ...order,
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
    // 재검사에서 대상 밖 규칙만 실패했으면 규칙을 맡는 역할의 판단 (병합은 일어나지 않았다, 판단 세션은 관리자의 잠금 밖)
    const recheckFailure = failedRecheck as {
      judgments: JudgmentResult[];
      rules: Rule[];
      acceptanceTexts: Readonly<Record<string, string>>;
    } | null;
    let existingRuleJudgment: Record<string, unknown> | null = null;
    if (recheckFailure !== null) {
      const existing = await judgeExistingRuleFailures(context, {
        stage: 'merge_recheck',
        ...recheckFailure,
      });
      if (existing.kind === 'halt') {
        const outcome = existing.outcome;
        return outcome.status === 'halt'
          ? {
              ...outcome,
              exitDetail: {
                ...(outcome.exitDetail as object),
                mergeStatus: result.status,
                mergeReason: result.reason,
                ...(checked === null ? {} : { recheck: checked }),
              },
            }
          : outcome;
      }
      if (existing.kind === 'no_contradiction') {
        existingRuleJudgment = { ...existing.detail };
      }
    }
    let recovery: Record<string, unknown> | null = null;
    if (result.reason === 'no_changes' && resumedAfterInterruption(context)) {
      const recorded = await findRecordedMerge(git, context, headCommit);
      if (recorded === null) {
        recovery = { reason: 'not_found' };
      } else {
        const tree = await verifyRecordedMergeTree(git, context.git.repoPath, recorded, headCommit);
        if (tree.ok) {
          // 순서 값은 기준 브랜치 끝이 아니라 찾은 이 실행의 병합 커밋에서 읽는다 (그 뒤 다른 병합이 쌓였을 수 있다)
          const order = await orderOf(recorded.hash);
          return {
            status: 'passed',
            exitDetail: { mergeCommit: recorded.hash, ...order, headCommit, recovered: true },
            run: { mergeCommit: recorded.hash },
          };
        }
        recovery = {
          mergeCommit: recorded.hash,
          reason: tree.reason,
          expectedTree: tree.expectedTree,
          actualTree: tree.actualTree,
        };
      }
    }
    return halt(result.reason, {
      ...(recovery === null ? {} : { recovery }),
      message: result.message,
      branch: result.branch,
      headCommit: result.headCommit,
      checkTimeoutMs,
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.checkDetail === undefined ? {} : { checkDetail: result.checkDetail }),
      ...(result.movedRef === undefined ? {} : { movedRef: result.movedRef }),
      ...(checked === null ? {} : { recheck: checked }),
      ...(existingRuleJudgment === null ? {} : { existingRuleJudgment }),
    });
  };
