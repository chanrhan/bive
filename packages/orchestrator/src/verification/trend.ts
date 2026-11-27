// 준수 추이 (JDG-06, SCR-05 그래프, M3-15 #60, ADR-146). 저장소를 읽기만 하고 새 표를 쓰지 않는다.
// - 점 = 병합 커밋이 기록된 실행(판정 기준 후보). 순서 = 판정 기준을 고르는 순서(`orderedBasisCandidates`)의 오름차순이라 마지막
//   점이 지금의 판정 기준이다. 병합되지 않은 실행은 점이 아니다
// - 점 i의 값 = 그 실행이 판정 기준이던 동안의 마지막 순간에 검증 요약이 보였을 값. 그 순간 = 다음 점의 병합 시각 바로 앞(병합
//   단계 통과 시각, 없으면 실행 생성 시각), 마지막 점은 지금(규칙은 지금 효력 있는 것 그대로). 그래서 마지막 점은 검증 요약의
//   `compliance` · `mutation`과 같은 값이다
//   - 통과율: 그 순간 효력 있던 규칙(`isEffectiveRuleBefore`: 생성 · 삭제 · 폐기 시각) 가운데 점의 실행이 병합 커밋에서 낸 판정이
//     격리가 아닌 것이 분모, 그중 통과가 분자 (검증 요약의 준수와 같은 정의, 판정은 `judgmentsAtCommit`)
//   - 변이 검증됨: 점 i까지(순서상 앞의 모든 후보 포함)의 실행이 남긴 변이 기록 가운데 규칙별 가장 나중 기록을 보고, 그 순간 효력
//     있던 규칙 중 기록이 있는 수가 분모, 그 기록이 '변이 검증됨'인 수가 분자
// - 점은 최근 `VERIFICATION_TREND_LIMIT`개까지(넘으면 `truncated`). 변이 기록은 잘린 앞쪽 점의 것도 센다
// - 조회 수는 실행 수와 무관하다: 실행 목록 · 병합된 실행의 단계 시도 · 규칙(삭제 포함) · 폐기 시각 · 변이 기록 · 보일 점들의 판정
//   기록을 각각 한 번에 읽는다
import {
  type JudgmentResult,
  type MutationResult,
  type Rule,
  type Ulid,
  VERIFICATION_TREND_LIMIT,
  type VerificationTrendPoint,
  type VerificationTrendResult,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { toRuleJudgment } from '../judgments/latest-judgment.js';
import { isEffectiveRuleBefore, retirementTimesOf } from '../norms/effective.js';
import {
  type BasisCandidate,
  candidateJudgments,
  foldLatestMutations,
  mergeRecordOf,
  mutationTally,
  orderedBasisCandidates,
} from './summary.js';

/** 점의 시각(다음 점의 값이 끝나는 순간): 병합 단계 통과 시각, 없거나 읽을 수 없으면 실행 생성 시각. */
const pointTime = ({ run, merge }: BasisCandidate): number => {
  const at = merge?.at === null || merge?.at === undefined ? NaN : Date.parse(merge.at);
  return Number.isNaN(at) ? Date.parse(run.createdAt) : at;
};

/** 열린 프로젝트 저장소에서 준수 추이를 만든다. */
export const verificationTrend = (
  store: ProjectStore,
  now: number = Date.now(),
  limit: number = VERIFICATION_TREND_LIMIT,
): VerificationTrendResult => {
  const stepsByRun = store.runs.stepsOfMergedRuns();
  const candidates = orderedBasisCandidates(store.runs.list(), {
    mergeOf: (run) => mergeRecordOf(run, stepsByRun.get(run.id) ?? []),
    branch: store.getProject()?.baseBranch ?? null,
  });
  if (candidates.length === 0) return { points: [], truncated: false };

  // 삭제되지 않은 규칙 (지금 제품에는 규칙을 지우는 길이 없다. 삭제된 규칙은 모든 점에서 빠진다: ADR-146 한계)
  const rules = store.rules.list();
  const retiredAt = retirementTimesOf(store);
  const mutationsByRun = new Map<Ulid, MutationResult[]>();
  for (const record of store.mutations.list()) {
    const list = mutationsByRun.get(record.runId);
    if (list === undefined) mutationsByRun.set(record.runId, [record]);
    else list.push(record);
  }

  const first = Math.max(0, candidates.length - limit);
  const shown = candidates.slice(first);
  const judged = candidateJudgments(store, shown, stepsByRun, now);

  const latestMutation = new Map<Ulid, MutationResult>();
  const points: VerificationTrendPoint[] = [];
  candidates.forEach((candidate, index) => {
    foldLatestMutations(latestMutation, mutationsByRun.get(candidate.run.id) ?? [], now);
    if (index < first) return;
    const next = candidates[index + 1];
    const end = next === undefined ? Infinity : pointTime(next);
    const effective = (rule: Rule): boolean => isEffectiveRuleBefore(rule, retiredAt, end);
    const judgments = judged.get(candidate.run.id) ?? new Map<Ulid, JudgmentResult>();
    let judgeable = 0;
    let passed = 0;
    for (const rule of rules) {
      if (!effective(rule)) continue;
      const { status } = toRuleJudgment(judgments.get(rule.id) ?? null);
      if (status === 'quarantined') continue;
      judgeable += 1;
      if (status === 'pass') passed += 1;
    }
    points.push({
      runId: candidate.run.id,
      runDisplayId: candidate.run.displayId,
      branch: candidate.run.baseBranch,
      commit: candidate.run.mergeCommit,
      mergedAt: candidate.merge?.at ?? null,
      compliance: { passed, judgeable },
      mutation: mutationTally(rules, latestMutation, effective),
    });
  });
  return { points, truncated: first > 0 };
};
