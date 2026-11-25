// 검사 단계 실행기 (RUN-02 · JDG-01 · JDG-02 · NFR-01, architecture.md 4장 5단계, ADR-026 · ADR-051 · ADR-069).
// 마지막 구현 커밋(`Run.headCommit`)의 깨끗한 체크아웃에서 승인된 규칙 전체의 인수 테스트를 판정 러너로 돌린다(M1 검사 =
// 인수 테스트만). 판정 전 인수 테스트 해시를 Red 확인 기록과 대조하고(다르면 `failed`(`guard_violation`)), 판정 직전 ·
// 판정 뒤 규범 저장소를 단계 시작 때 스냅숏과 대조한다.
// - 판정 대상 = 효력 있는 규칙(효력 상태 · 삭제 안 됨 · 폐기 안 됨) 중 체크아웃에 규칙 폴더(`bive-acceptance/<RULE-ID>/*.acc.ts`)가
//   있는 것. 효력이 없거나 삭제 · 폐기된 규칙의 폴더는 판정하지 않는다(규칙 폴더 목록은 해시 대조로 Red 확인 뒤 바뀌지 않았다.
//   폐기된 규칙의 폴더는 지우지 않고 남는다, ADR-112)
// - 판정 러너가 `completed`면 규칙별 판정 기록(상태 · 커밋 · 시각 · 종료 코드 · 원본 JSON · 케이스 `file:line`)을 저장한다.
//   모두 `pass`면 `passed`, 하나라도 `fail`이면 `unmet` → 엔진이 구현으로 회귀(`regressionCount`, 상한 2회)
// - `collect_error`(훅 실패 등 파일 수준 오류)는 구현이 만든 문제일 수 있어 `unmet`. 판정 기록은 남기지 않는다
// - `runner_error` · 체크아웃 · 설치 실패는 `failed`(`judge_runner_error`): 같은 커밋이 구현 단계 판정에서 이미 빌드 ·
//   설치를 통과했으므로 환경 문제로 보고 구현을 다시 하지 않는다 (Red 확인과 같은 분류, ADR-068)
// - 대상이 아닌 효력 있는 규칙만 실패하면(내장 구조 규칙 제외) 규칙을 맡는 역할이 모순인지 한 번 판단한다(M7-12 #224, ADR-100
//   B⑧ · A4 · A5, ADR-118, `steps/existing-rule.ts`): 모순이면 `failed`(`existing_rule_contradiction`, 병합 없음), 모순 없음이면
//   지금처럼 `unmet` → 구현 회귀(같은 회귀 상한)이고 다음 구현 세션은 판단 근거를 받는다. 대상 규칙이 함께 실패하면 판단 없이 회귀한다.
//   이 실행에 모순 판단이 이미 있으면(재기동 · 재개) 판정하지 않고 끝낸다
// - 구조 검사 (M3-03 #48, JDG-05, ADR-127, `steps/structure-check.ts`): 블록 선언이 있으면 같은 체크아웃에서 설치 전에 구조 검사를 하고
//   내장 구조 규칙 두 개의 판정 기록을 인수 테스트 판정 기록과 같은 트랜잭션에 남긴다. 내장 규칙은 인수 테스트로 판정하지 않는다.
//   내장 규칙이 실패하면 판단 세션 없이(폐기 · 대체할 수 없다, B⑨) 구현으로 회귀하고 다음 구현 세션은 위반(규칙 · 파일 쌍)을 앞 시도의
//   사유로 받는다. 겹침 · 실행기 오류는 판정하지 않고 끝낸다. 선언이 없으면 구조 검사를 하지 않는다(지금과 같다)
// - 계약 검사 (M3-47 #292, ADR-132 · ADR-130 ⑤, `steps/contract-check.ts`): 계약 검사 규칙이 있으면 같은 체크아웃 · 같은 판정에서 계약
//   종류의 실행기로 판정하고 판정 기록을 같은 트랜잭션에 남긴다. 계약 검사 규칙은 인수 테스트로 판정하지 않는다. 계약과 다른 응답은 구조
//   검사 실패와 같이 구현으로 회귀하고, 등록된 문서의 형식 오류는 기록만 하고 단계 통과를 막지 않는다. 실행기가 없는 종류 · 판정할 수 없는
//   계약은 판정 없음(기록 없음)이고 단계의 통과 · 회귀에 끼지 않는다. 도구를 끝까지 못 돌리면 판정하지 않고 끝낸다
import type { Rule } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { effectiveContracts, effectiveRules } from '../norms/effective.js';
import {
  CONTRACT_STAGE,
  contractJudgmentsFrom,
  contractRuleIds,
  contractSummary,
  missingContractVerdicts,
  nonBlockingContractRuleIds,
  contractPlanOf,
} from './contract-check.js';
import { contradictionHalt, judgeExistingRuleFailures } from './existing-rule.js';
import { JUDGE_RUNNER_ERROR_REASON } from './red-check.js';
import {
  BLOCK_DECLARATION_OVERLAP_REASON,
  missingStructureJudgments,
  readStructurePlan,
  STRUCTURE_STAGE,
  structureJudgmentsFrom,
  structureRuleIds,
} from './structure-check.js';
import {
  createNormGuard,
  judgeCommit,
  judgeSummary,
  judgmentDigest,
  judgmentsFrom,
  type JudgingOptions,
  lastPassed,
  MAX_LISTED,
  normHalt,
  recordJudgments,
  redAcceptanceHashes,
} from './judging.js';

export type CheckOptions = JudgingOptions;

/**
 * 판정 대상이 되는 규칙: 효력 있는 규칙(효력 상태 · 삭제 안 됨 · 폐기 안 됨, `norms/effective.ts`). 잠정 승인은 M1에서 생기지
 * 않고 판정 가능 분모에서도 뺀다(JDG-03). 폐기된 규칙은 인수 테스트 폴더가 남아 있어도 판정하지 않는다(M7-09, ADR-112).
 */
export const approvedRules = (context: StepContext): Rule[] =>
  context.read((store) => effectiveRules(store));

const halt = (reason: string, exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason,
  exitDetail,
});

/** 검사 단계 실행기를 만든다 (기본 실행기 목록에 등록된다). */
export const createCheckExecutor =
  (options: CheckOptions = {}): StepExecutor =>
  async (context: StepContext): Promise<StepOutcome> => {
    // 판정할 커밋 = 마지막 완료 단계(구현) 커밋
    const commit = context.run.headCommit;
    if (commit === null || lastPassed(context.steps, 'implementation')?.commit !== commit) {
      return halt('state_inconsistent', {
        message: '구현 커밋이 실행의 마지막 완료 단계 커밋이 아닙니다',
        commit,
      });
    }
    const expectedHashes = redAcceptanceHashes(context.steps);
    if (expectedHashes === null) {
      return halt('state_inconsistent', {
        message: 'Red 확인 통과 기록(인수 테스트 해시)이 없습니다',
      });
    }
    // 모순 판단으로 끝나야 할 실행은 다시 판정하지 않는다 (폐기된 규칙이 빠져 통과로 보이는 길을 막는다, ADR-100 A4)
    const contradicted = contradictionHalt(context);
    if (contradicted !== null) return contradicted;
    const norms = createNormGuard(context);
    const rules = approvedRules(context);
    // 구조 검사 계획: 단계를 열 때 읽은 선언의 판 · 내장 구조 규칙 (선언이 없으면 없음)
    const planned = readStructurePlan(context, rules);
    if (planned.kind === 'halt') return planned.outcome;
    const plan = planned.kind === 'plan' ? planned.plan : null;
    const structureIds = structureRuleIds(plan);
    // 계약 검사 계획: 단계를 열 때 읽은 계약 검사 규칙 · 계약 (없으면 없음)
    const contractPlanned = contractPlanOf(
      rules,
      context.read((store) => effectiveContracts(store)),
    );
    if (contractPlanned.kind === 'halt') return contractPlanned.outcome;
    const contractPlan = contractPlanned.kind === 'plan' ? contractPlanned.plan : null;
    const contractIds = contractRuleIds(contractPlan);
    // 인수 테스트로 판정하는 규칙 (내장 구조 규칙은 구조 검사가, 계약 검사 규칙은 계약 검사가 판정한다)
    const builtinIds = [...structureIds, ...contractIds];
    const testedRules = rules.filter((rule) => !builtinIds.includes(rule.id));
    const targets = context.read((store) =>
      context.run.targetRuleIds
        .filter((id) => !builtinIds.includes(id))
        .map((id) => store.rules.get(id)?.displayId ?? id),
    );
    let unjudgedDirs: string[] = [];
    const judged = await judgeCommit(
      context,
      {
        commit,
        selectRules: (dirs) => {
          unjudgedDirs = dirs.filter((dir) => !testedRules.some((rule) => rule.displayId === dir));
          return testedRules
            .filter((rule) => dirs.includes(rule.displayId))
            .map((rule) => rule.displayId);
        },
        expectedAcceptanceHashes: expectedHashes,
        norms,
        signal: context.signal,
        readAcceptanceTexts: true,
        ...(plan === null ? {} : { structure: plan }),
        ...(contractPlan === null ? {} : { contracts: contractPlan }),
      },
      options,
    );
    const base = { commit };
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
          message:
            judged.stage === 'acceptance_hash'
              ? 'Red 확인 뒤 인수 테스트가 바뀌었습니다'
              : '판정 중 인수 테스트 · 테스트 실행기 · 판정 설정이 바뀌었습니다',
          changed: judged.changed.slice(0, MAX_LISTED),
        });
      case 'norm_mismatch':
        return normHalt(judged.moment, judged.mismatches, base);
      case 'no_rules':
        return halt('state_inconsistent', {
          ...base,
          message: '판정할 승인된 규칙의 인수 테스트가 없습니다',
          ruleDirs: judged.ruleDirs,
        });
      case 'structure_halt': {
        // 구조 검사가 판정하지 못했다: 겹침(사람이 선언을 고칠 일) · 구현 역할이 고칠 수 없는 실행기 오류
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
        // 계약 검사 도구를 끝까지 못 돌렸다: 통과로 읽지 않고 판정하지 않는다
        return halt(JUDGE_RUNNER_ERROR_REASON, {
          ...base,
          stage: CONTRACT_STAGE,
          message: judged.contract.message,
          code: judged.contract.code,
          ruleId: judged.contract.ruleId,
        });
      case 'judged':
        break;
    }
    const { result, ruleIds } = judged;
    const missingTargets = targets.filter((id) => !ruleIds.includes(id));
    if (missingTargets.length > 0) {
      return halt('state_inconsistent', {
        ...base,
        message: '대상 규칙의 인수 테스트가 판정 대상에 없습니다',
        missingTargets,
      });
    }
    const detail = {
      ...base,
      ...judgeSummary(result),
      ruleIds,
      ...(unjudgedDirs.length > 0 ? { unjudgedDirs } : {}),
      ...(judged.structure === undefined ? {} : { structure: judged.structure.summary }),
      ...(judged.contracts === undefined
        ? {}
        : { contracts: contractSummary(judged.contracts.verdicts) }),
    };
    if (result.status === 'runner_error') {
      return halt(JUDGE_RUNNER_ERROR_REASON, { ...detail, stage: 'judge' });
    }
    if (result.status === 'collect_error') {
      return { status: 'unmet', exitDetail: { ...detail, reason: 'collect_error' } };
    }
    const testJudged = testedRules.filter((rule) => ruleIds.includes(rule.displayId));
    const judgedRules = [...testJudged, ...rules.filter((rule) => builtinIds.includes(rule.id))];
    // 인수 테스트 판정과 구조 검사 판정을 한 트랜잭션에 남긴다 (판정 1회)
    const meta = { runId: context.run.id, stepId: context.step.id, commit };
    const structureJudgments = structureJudgmentsFrom(judged.structure, {
      ...meta,
      judgedAt: result.endedAt,
    });
    // 선언이 있으면 두 내장 규칙의 판정이 모두 있어야 한다 (없으면 기록 없이 끝낸다: 통과로 가지 않는다)
    const uncovered = missingStructureJudgments(plan, structureJudgments);
    if (uncovered.length > 0) {
      return halt('state_inconsistent', {
        ...detail,
        stage: STRUCTURE_STAGE,
        message: '구조 검사 판정이 내장 구조 규칙을 모두 덮지 않습니다',
        missingRuleIds: uncovered,
      });
    }
    // 계약 검사 규칙마다 판정 · 판정 없음이 하나씩 있어야 한다 (없으면 기록 없이 끝낸다: 통과로 가지 않는다)
    const missingContracts = missingContractVerdicts(contractPlan, judged.contracts);
    if (missingContracts.length > 0) {
      return halt('state_inconsistent', {
        ...detail,
        stage: CONTRACT_STAGE,
        message: '계약 검사 판정이 계약 검사 규칙을 모두 덮지 않습니다',
        missingRuleIds: missingContracts,
      });
    }
    const recorded = recordJudgments(context, [
      ...judgmentsFrom(result, testJudged, meta),
      ...structureJudgments,
      ...contractJudgmentsFrom(judged.contracts, { ...meta, judgedAt: result.endedAt }),
    ]);
    const judgments = judgmentDigest(recorded, judgedRules);
    // 단계 통과를 막는 판정: 등록된 계약 문서의 형식 오류(구현이 고칠 수 없다)는 기록만 하고 빼고 본다
    const nonBlocking = nonBlockingContractRuleIds(judged.contracts);
    const blocking = recorded.filter((judgment) => !nonBlocking.has(judgment.ruleId));
    if (blocking.some((judgment) => judgment.status !== 'pass')) {
      // 대상 밖 규칙의 실패: 규칙을 맡는 역할의 판단 (판단 입력은 실패한 규칙 ID와 케이스 이름뿐, 실행기 출력은 넘기지 않는다)
      const existing = await judgeExistingRuleFailures(context, {
        stage: 'check',
        judgments: blocking,
        rules: judgedRules,
        acceptanceTexts: judged.acceptanceTexts ?? {},
      });
      if (existing.kind === 'halt') {
        const outcome = existing.outcome;
        return outcome.status === 'halt'
          ? {
              ...outcome,
              exitDetail: { ...detail, judgments, ...(outcome.exitDetail as object) },
            }
          : outcome;
      }
      return {
        status: 'unmet',
        exitDetail: {
          ...detail,
          reason: 'check_failed',
          judgments,
          ...(existing.kind === 'no_contradiction'
            ? { existingRuleJudgment: existing.detail }
            : {}),
        },
      };
    }
    return { status: 'passed', exitDetail: { ...detail, judgments } };
  };
