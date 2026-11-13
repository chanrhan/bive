// 검사 단계 실행기 (RUN-02 · JDG-01 · JDG-02 · NFR-01, architecture.md 4장 5단계, ADR-026 · ADR-051 · ADR-069).
// 마지막 구현 커밋(`Run.headCommit`)의 깨끗한 체크아웃에서 승인된 규칙 전체의 인수 테스트를 판정 러너로 돌린다(M1 검사 =
// 인수 테스트만). 판정 전 인수 테스트 해시를 Red 확인 기록과 대조하고(다르면 `failed`(`guard_violation`)), 판정 직전 ·
// 판정 뒤 규범 저장소를 단계 시작 때 스냅숏과 대조한다.
// - 판정 대상 = 승인 상태이고 삭제되지 않은 규칙 중 체크아웃에 규칙 폴더(`bive-acceptance/<RULE-ID>/*.acc.ts`)가 있는 것.
//   승인되지 않았거나 삭제된 규칙의 폴더는 판정하지 않는다(규칙 폴더 목록은 해시 대조로 Red 확인 뒤 바뀌지 않았다)
// - 판정 러너가 `completed`면 규칙별 판정 기록(상태 · 커밋 · 시각 · 종료 코드 · 원본 JSON · 케이스 `file:line`)을 저장한다.
//   모두 `pass`면 `passed`, 하나라도 `fail`이면 `unmet` → 엔진이 구현으로 회귀(`regressionCount`, 상한 2회)
// - `collect_error`(훅 실패 등 파일 수준 오류)는 구현이 만든 문제일 수 있어 `unmet`. 판정 기록은 남기지 않는다
// - `runner_error` · 체크아웃 · 설치 실패는 `failed`(`judge_runner_error`): 같은 커밋이 구현 단계 판정에서 이미 빌드 ·
//   설치를 통과했으므로 환경 문제로 보고 구현을 다시 하지 않는다 (Red 확인과 같은 분류, ADR-068)
import type { Rule } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { JUDGE_RUNNER_ERROR_REASON } from './red-check.js';
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

/** 판정 대상이 되는 규칙: 승인 상태 · 삭제 안 됨 (잠정 승인은 M1에서 생기지 않고 판정 가능 분모에서도 뺀다, JDG-03). */
export const approvedRules = (context: StepContext): Rule[] =>
  context.read((store) =>
    store.rules.list().filter((rule) => rule.normState === 'approved' && rule.deletedAt === null),
  );

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
    const norms = createNormGuard(context);
    const rules = approvedRules(context);
    const targets = context.read((store) =>
      context.run.targetRuleIds.map((id) => store.rules.get(id)?.displayId ?? id),
    );
    let unjudgedDirs: string[] = [];
    const judged = await judgeCommit(
      context,
      {
        commit,
        selectRules: (dirs) => {
          unjudgedDirs = dirs.filter((dir) => !rules.some((rule) => rule.displayId === dir));
          return rules
            .filter((rule) => dirs.includes(rule.displayId))
            .map((rule) => rule.displayId);
        },
        expectedAcceptanceHashes: expectedHashes,
        norms,
        signal: context.signal,
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
    };
    if (result.status === 'runner_error') {
      return halt(JUDGE_RUNNER_ERROR_REASON, { ...detail, stage: 'judge' });
    }
    if (result.status === 'collect_error') {
      return { status: 'unmet', exitDetail: { ...detail, reason: 'collect_error' } };
    }
    const judgedRules = rules.filter((rule) => ruleIds.includes(rule.displayId));
    const recorded = recordJudgments(
      context,
      judgmentsFrom(result, judgedRules, {
        runId: context.run.id,
        stepId: context.step.id,
        commit,
      }),
    );
    const judgments = judgmentDigest(recorded, judgedRules);
    if (recorded.some((judgment) => judgment.status !== 'pass')) {
      return { status: 'unmet', exitDetail: { ...detail, reason: 'check_failed', judgments } };
    }
    return { status: 'passed', exitDetail: { ...detail, judgments } };
  };
