// Green 확인 단계 실행기 (RUN-07, ADR-020 · architecture.md 4장 유형 표 · C-18, ADR-136). 판정은 구현 · 검사와 같은 `judgeCommit`이다
// (커밋의 깨끗한 체크아웃 → 설치 → 판정 직전 · 뒤 규범 대조 → 판정 러너). 판정 기록은 남기지 않는다(Red 확인과 같다: 이 단계는
// 다음 단계로 갈지만 정한다).
// - 유형 C(코드 유지 · 테스트만): 테스트 작성 커밋에서 대상 규칙의 새 테스트를 돌린다. 판정 전에 기준 커밋과 테스트 작성 커밋 사이의
//   변경이 대상 규칙 폴더 · BIVE 선언 파일뿐인지 git 객체로 본다(소스 파일 쓰기 거부: 밖의 변경이 있으면 `failed`(`guard_violation`),
//   판정 · 병합으로 가지 않는다). 대상 규칙마다 케이스가 1개 이상이고 전부 통과하면 `passed`(인수 테스트 해시를 기록, 검사 단계가
//   대조한다). 하나라도 통과하지 않음 · 케이스 0개 · 수집 오류는 `unmet` → 엔진이 테스트 작성으로 회귀(Red 확인과 같은 길 · 같은
//   상한). 러너 오류 · 체크아웃 · 설치 실패는 `failed`(`judge_runner_error`): 소스를 바꾸지 않는 실행이라 테스트를 다시 써도 고칠 수 없다
// - 유형 D(리팩터링 · 되돌리기)의 기준 검사: 구현 전 기준 커밋(`baseCommit`)에서 효력 있는 규칙 전부를 검사 단계와 같은 대상
//   (인수 테스트 · 구조 검사 · 계약 검사)으로 판정한다. 막는 판정(계약 문서의 형식 오류 제외)이 모두 `pass`이고 대상 규칙이 판정에
//   들었으면 `passed`(기준 커밋의 인수 테스트 해시를 기록, 구현 · 검사 단계가 대조한다). 하나라도 실패 · 수집 오류 · 대상 규칙의 인수
//   테스트 없음은 `unmet` → 유형 D에는 이 단계의 회귀가 없어 실행 `failed`(`step_unmet`, 시작 거부): 구현 세션을 띄우지 않고 커밋 ·
//   병합이 없다. 판정 없음(실행기 없는 계약 종류 · 계약 안 요청 0건 등)은 통과로 세지 않지만 막지도 않는다(검사 단계와 같다)
import type { JudgmentResult, Rule } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { createGitRunner } from '../git/git-exec.js';
import { approvedRules, readContractPlan } from './check.js';
import {
  CONTRACT_STAGE,
  contractJudgmentsFrom,
  contractRuleIds,
  contractSummary,
  missingContractVerdicts,
  nonBlockingContractRuleIds,
} from './contract-check.js';
import { evaluateGreen } from './implementation.js';
import {
  type CommitJudgeOutcome,
  createNormGuard,
  judgeCommit,
  judgeSummary,
  judgmentDigest,
  judgmentsFrom,
  type JudgingOptions,
  lastPassed,
  MAX_LISTED,
  normHalt,
} from './judging.js';
import { JUDGE_RUNNER_ERROR_REASON, NO_CASES_MESSAGE } from './red-check.js';
import { testOnlyViolations } from './run-type.js';
import {
  BLOCK_DECLARATION_OVERLAP_REASON,
  missingStructureJudgments,
  readStructurePlan,
  STRUCTURE_STAGE,
  structureJudgmentsFrom,
  structureRuleIds,
} from './structure-check.js';

export type GreenCheckOptions = JudgingOptions;

/** 유형 C Green 확인의 수집 오류 사유 (`exitDetail.reason`, 케이스 0개 포함). 새 테스트가 통과하지 않음은 `not_green`. */
export const GREEN_COLLECT_ERROR = 'green_collect_error';

/** 유형 C의 소스 파일 쓰기 거부 단계 값 (`exitDetail.stage`). */
export const TEST_ONLY_STAGE = 'test_only';

const halt = (reason: string, exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason,
  exitDetail,
});

/** 판정하지 못한 결과(체크아웃 · 설치 · 변조 · 규범 대조 · 구조 · 계약 실행기)를 단계 결과로. `judged`면 `null`. */
const unjudgedOutcome = (
  judged: CommitJudgeOutcome,
  base: Record<string, unknown>,
): StepOutcome | null => {
  switch (judged.kind) {
    case 'checkout_error':
      return halt(JUDGE_RUNNER_ERROR_REASON, {
        ...base,
        stage: 'checkout',
        message: judged.message,
      });
    case 'install_error':
      return halt(JUDGE_RUNNER_ERROR_REASON, {
        ...base,
        stage: 'install',
        message: judged.message,
        logFile: judged.logFile,
      });
    case 'acceptance_changed':
      return halt('guard_violation', {
        ...base,
        stage: judged.stage,
        ...(judged.moment === undefined ? {} : { moment: judged.moment }),
        message: '판정 중 인수 테스트 · 테스트 실행기 · 판정 설정이 바뀌었습니다',
        changed: judged.changed.slice(0, MAX_LISTED),
      });
    case 'norm_mismatch':
      return normHalt(judged.moment, judged.mismatches, base);
    case 'structure_halt': {
      const structure = {
        ...base,
        stage: STRUCTURE_STAGE,
        message: judged.structure.message,
        structure: judged.structure.summary,
      };
      return judged.structure.reason === BLOCK_DECLARATION_OVERLAP_REASON
        ? halt(BLOCK_DECLARATION_OVERLAP_REASON, structure)
        : halt(JUDGE_RUNNER_ERROR_REASON, structure);
    }
    case 'contract_halt':
      return halt(JUDGE_RUNNER_ERROR_REASON, {
        ...base,
        stage: CONTRACT_STAGE,
        message: judged.contract.message,
        code: judged.contract.code,
        ruleId: judged.contract.ruleId,
      });
    case 'no_rules':
    case 'judged':
      return null;
  }
};

/** 대상 규칙의 표시 ID. 없거나 삭제된 규칙이 있으면 `null`. */
const targetDisplayIds = (context: StepContext): string[] | null =>
  context.read((store) => {
    const ids: string[] = [];
    for (const id of context.run.targetRuleIds) {
      const rule = store.rules.get(id);
      if (rule === null || rule.deletedAt !== null) return null;
      ids.push(rule.displayId);
    }
    return ids;
  });

/** 유형 C: 테스트 작성 커밋의 새 테스트가 전부 통과하는지. */
const greenNewTests = async (
  context: StepContext,
  options: GreenCheckOptions,
): Promise<StepOutcome> => {
  const commit = context.run.headCommit;
  if (commit === null || lastPassed(context.steps, 'test_writing')?.commit !== commit) {
    return halt('state_inconsistent', {
      message: '테스트 작성 커밋이 실행의 마지막 완료 단계 커밋이 아닙니다',
      commit,
    });
  }
  const targets = targetDisplayIds(context);
  if (targets === null || targets.length === 0) {
    return halt('target_rule_unavailable', { ruleIds: context.run.targetRuleIds });
  }
  // 소스 파일 쓰기 거부: 기준 커밋과 테스트 작성 커밋 사이의 변경이 대상 규칙 폴더 · BIVE 선언 파일뿐이어야 한다
  const outside = await testOnlyViolations(
    options.git ?? createGitRunner(),
    context.git.repoPath,
    context.git.baseCommit,
    commit,
    targets,
  );
  if (outside.length > 0) {
    return halt('guard_violation', {
      commit,
      stage: TEST_ONLY_STAGE,
      message: '코드 유지 · 테스트만 실행에서 인수 테스트 폴더 밖의 파일이 바뀌었습니다',
      changed: outside.slice(0, MAX_LISTED),
    });
  }
  const norms = createNormGuard(context);
  const judged = await judgeCommit(
    context,
    {
      commit,
      selectRules: (dirs) => targets.filter((id) => dirs.includes(id)),
      norms,
      signal: context.signal,
    },
    options,
  );
  const base = { commit };
  const stopped = unjudgedOutcome(judged, base);
  if (stopped !== null) return stopped;
  if (judged.kind === 'no_rules') {
    return {
      status: 'unmet',
      exitDetail: {
        ...base,
        reason: GREEN_COLLECT_ERROR,
        problems: targets.map((id) => ({
          file: `bive-acceptance/${id}`,
          message: NO_CASES_MESSAGE,
        })),
      },
    };
  }
  if (judged.kind !== 'judged') return halt('state_inconsistent', base);
  // 러너 오류: 소스를 바꾸지 않는 실행이라 테스트를 다시 써도 고칠 수 없다 (Red 확인과 같은 분류)
  if (judged.result.status === 'runner_error') {
    return halt(JUDGE_RUNNER_ERROR_REASON, {
      ...base,
      ...judgeSummary(judged.result),
      stage: 'judge',
    });
  }
  const evaluated = evaluateGreen(judged.result, targets);
  // 수집 오류는 Red 확인의 수집 오류와 다른 사유로 남긴다 (테스트 작성 세션의 앞 시도 사유가 단계를 가려 싣는다)
  const reason =
    evaluated.exitDetail.reason === 'collect_error'
      ? GREEN_COLLECT_ERROR
      : evaluated.exitDetail.reason;
  const exitDetail = {
    ...base,
    ...evaluated.exitDetail,
    ...(reason === undefined ? {} : { reason }),
    ruleIds: judged.ruleIds,
  };
  if (evaluated.status === 'unmet') return { status: 'unmet', exitDetail };
  return {
    status: 'passed',
    exitDetail: { ...exitDetail, acceptanceHashes: judged.acceptanceHashes },
  };
};

/** 유형 D: 기준 커밋에서 효력 있는 규칙 전부가 통과하는지 (기준 검사). */
const greenBaseline = async (
  context: StepContext,
  options: GreenCheckOptions,
): Promise<StepOutcome> => {
  // 기준 검사는 구현 전에만 돈다 (판정 커밋 = 실행을 시작한 기준 커밋)
  if (context.run.headCommit !== null) {
    return halt('state_inconsistent', {
      message: '기준 검사 전에 실행의 완료 단계 커밋이 있습니다',
      headCommit: context.run.headCommit,
    });
  }
  const commit = context.git.baseCommit;
  const targets = targetDisplayIds(context);
  if (targets === null || targets.length === 0) {
    return halt('target_rule_unavailable', { ruleIds: context.run.targetRuleIds });
  }
  const norms = createNormGuard(context);
  const rules = approvedRules(context);
  const planned = readStructurePlan(context, rules);
  if (planned.kind === 'halt') return planned.outcome;
  const plan = planned.kind === 'plan' ? planned.plan : null;
  const contractPlanned = readContractPlan(context, rules);
  if (contractPlanned.kind === 'halt') return contractPlanned.outcome;
  const contractPlan = contractPlanned.kind === 'plan' ? contractPlanned.plan : null;
  const staticIds = [...structureRuleIds(plan), ...contractRuleIds(contractPlan)];
  const testedRules = rules.filter((rule) => !staticIds.includes(rule.id));
  const judged = await judgeCommit(
    context,
    {
      commit,
      selectRules: (dirs) =>
        testedRules.filter((rule) => dirs.includes(rule.displayId)).map((rule) => rule.displayId),
      norms,
      signal: context.signal,
      ...(plan === null ? {} : { structure: plan }),
      ...(contractPlan === null ? {} : { contracts: contractPlan }),
    },
    options,
  );
  const base = { commit, baseline: true };
  const stopped = unjudgedOutcome(judged, base);
  if (stopped !== null) return stopped;
  if (judged.kind === 'no_rules') {
    return {
      status: 'unmet',
      exitDetail: { ...base, reason: 'missing_targets', missingTargets: targets },
    };
  }
  if (judged.kind !== 'judged') return halt('state_inconsistent', base);
  const { result, ruleIds } = judged;
  const detail = {
    ...base,
    ...judgeSummary(result),
    ruleIds,
    ...(judged.structure === undefined ? {} : { structure: judged.structure.summary }),
    ...(judged.contracts === undefined
      ? {}
      : { contracts: contractSummary(judged.contracts.verdicts) }),
  };
  if (result.status === 'runner_error') {
    return halt(JUDGE_RUNNER_ERROR_REASON, { ...detail, stage: 'judge' });
  }
  // 대상 규칙의 기존 검사(인수 테스트)가 기준 커밋에 있어야 한다
  const missingTargets = targets.filter((id) => !ruleIds.includes(id));
  if (missingTargets.length > 0) {
    return {
      status: 'unmet',
      exitDetail: { ...detail, reason: 'missing_targets', missingTargets },
    };
  }
  if (result.status === 'collect_error') {
    return { status: 'unmet', exitDetail: { ...detail, reason: 'collect_error' } };
  }
  const meta = { runId: context.run.id, stepId: context.step.id, commit };
  const structureJudgments = structureJudgmentsFrom(judged.structure, {
    ...meta,
    judgedAt: result.endedAt,
  });
  const uncovered = missingStructureJudgments(plan, structureJudgments);
  if (uncovered.length > 0) {
    return halt('state_inconsistent', {
      ...detail,
      stage: STRUCTURE_STAGE,
      message: '구조 검사 판정이 내장 구조 규칙을 모두 덮지 않습니다',
      missingRuleIds: uncovered,
    });
  }
  const missingContracts = missingContractVerdicts(contractPlan, judged.contracts);
  if (missingContracts.length > 0) {
    return halt('state_inconsistent', {
      ...detail,
      stage: CONTRACT_STAGE,
      message: '계약 검사 판정이 계약 검사 규칙을 모두 덮지 않습니다',
      missingRuleIds: missingContracts,
    });
  }
  const testJudged = testedRules.filter((rule) => ruleIds.includes(rule.displayId));
  const judgedRules: Rule[] = [
    ...testJudged,
    ...rules.filter((rule) => staticIds.includes(rule.id)),
  ];
  // 기록하지 않는 판정 (기준 검사는 다음 단계로 갈지만 정한다)
  const verdicts: JudgmentResult[] = [
    ...judgmentsFrom(result, testJudged, meta),
    ...structureJudgments,
    ...contractJudgmentsFrom(judged.contracts, { ...meta, judgedAt: result.endedAt }),
  ];
  const judgments = judgmentDigest(verdicts, judgedRules);
  // 막는 판정: 등록된 계약 문서의 형식 오류(구현이 고칠 수 없다)는 빼고 본다. 판정 없음은 판정이 없어 여기에 들지 않는다
  const nonBlocking = nonBlockingContractRuleIds(judged.contracts);
  const blocking = verdicts.filter((verdict) => !nonBlocking.has(verdict.ruleId));
  if (blocking.some((verdict) => verdict.status !== 'pass')) {
    return { status: 'unmet', exitDetail: { ...detail, reason: 'not_green', judgments } };
  }
  return {
    status: 'passed',
    exitDetail: { ...detail, judgments, acceptanceHashes: judged.acceptanceHashes },
  };
};

/** Green 확인 단계 실행기를 만든다 (기본 실행기 목록에 등록된다). 유형 C · D만 이 단계가 있다. */
export const createGreenCheckExecutor =
  (options: GreenCheckOptions = {}): StepExecutor =>
  async (context: StepContext): Promise<StepOutcome> => {
    switch (context.run.type) {
      case 'C':
        return greenNewTests(context, options);
      case 'D':
        return greenBaseline(context, options);
      default:
        return halt('state_inconsistent', {
          message: `Green 확인이 없는 실행 유형입니다 (${context.run.type})`,
        });
    }
  };
