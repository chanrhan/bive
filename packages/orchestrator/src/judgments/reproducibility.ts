// 재현성 확인: 같은 커밋을 여러 번 판정해 결과가 흔들리는 규칙을 '격리'(재판정 불일치)로 기록한다 (NFR-05 · JDG-02, M3-14 #59,
// ADR-156).
// - 요청이 있을 때만 돈다(이 함수를 부를 때만). 파이프라인의 검사 · Red · Green 확인 · 병합 재검사의 판정 횟수는 그대로 1회다
//   (모든 판정을 세 번 돌리면 실행 시간 · 비용이 세 배다). 감시자도 이 함수를 부르지 않는다(자동 재판정 없음)
// - 판정 1회의 규칙별 결과는 판정 단계와 같은 규칙으로 정한다(`judgmentsFrom`: 완료된 판정에서 그 규칙의 케이스가 1개 이상이고 모두
//   통과면 통과, 아니면 실패). 수집 · 러너 오류로 끝난 회차는 판정이 없다(그 회차는 비교에 들지 않는다)
// - 흔들림 = 판정이 있는 회차가 둘 이상이고 그 결과가 서로 다름. 판정이 있는 회차가 하나뿐이면 확인하지 못한 것이지 흔들린 것이 아니다
//   (러너 오류를 흔들림으로 세면 실패하던 규칙이 격리로 분모에서 빠질 수 있다)
// - 흔들린 규칙은 `recordRejudgeMismatch`로 격리 1건씩(트랜잭션 1개). 판정 기록 자체(통과 · 실패)는 남기지 않는다: 회차 결과는
//   보고로만 돌려준다(판정 기준 · 규칙 화면의 판정은 실행이 남긴 기록 그대로이고, 격리가 그 위에 보인다)
import type { JudgeRunner as JudgeRunnerName, Rule } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import type { JudgeRunInput, JudgeRunner, JudgeRunResult } from '../judge/runner.js';
import { casesOf } from '../steps/judging.js';
import { type MarkClock, recordRejudgeMismatch } from './judgment-marks.js';

/** 재현성 확인의 기본 판정 횟수 (NFR-05 "같은 커밋 3회 판정 비교"). */
export const REPRODUCIBILITY_ROUNDS = 3;

/** 판정 1회의 규칙별 결과 (규칙 ID → 통과 · 실패, 판정하지 못했으면 `null`). */
export type RoundVerdicts = ReadonlyMap<string, 'pass' | 'fail' | null>;

/** 판정 러너 결과 1회 → 규칙별 결과 (판정 단계의 `judgmentsFrom`과 같은 규칙). */
export const verdictsOf = (
  result: JudgeRunResult,
  rules: readonly Pick<Rule, 'id' | 'displayId'>[],
): Map<string, 'pass' | 'fail' | null> =>
  new Map(
    rules.map((rule) => {
      if (result.status !== 'completed') return [rule.id, null];
      const cases = casesOf(result, rule.displayId);
      return [
        rule.id,
        cases.length > 0 && cases.every((item) => item.status === 'passed') ? 'pass' : 'fail',
      ];
    }),
  );

/** 흔들린 규칙: 판정이 있는 회차가 둘 이상이고 결과가 서로 다르다 (받은 규칙 순서). */
export const unstableRuleIds = (
  ruleIds: readonly string[],
  rounds: readonly RoundVerdicts[],
): string[] =>
  ruleIds.filter((ruleId) => {
    const judged = rounds
      .map((round) => round.get(ruleId) ?? null)
      .filter((verdict) => verdict !== null);
    return judged.length >= 2 && new Set(judged).size > 1;
  });

export interface ReproducibilityReport {
  /** 회차별 규칙 결과 (판정 순서) */
  readonly rounds: RoundVerdicts[];
  /** 흔들린 규칙 ID (격리로 기록한 규칙) */
  readonly unstable: string[];
}

export interface ReproducibilityInput {
  /** 판정 대상 규칙 (표시 ID로 인수 테스트 폴더를 찾는다) */
  readonly rules: readonly Pick<Rule, 'id' | 'displayId'>[];
  /** 판정한 커밋 (격리 기록의 커밋) */
  readonly commit: string;
  /** 판정 1회 (회차 번호 0부터). 판정 러너를 부른다 */
  readonly judgeOnce: (round: number) => Promise<JudgeRunResult>;
  /** 판정 횟수 (기본 {@link REPRODUCIBILITY_ROUNDS}) */
  readonly rounds?: number;
}

/**
 * 같은 커밋을 차례로 `rounds`번 판정하고, 흔들린 규칙을 재판정 불일치 격리로 기록한다. 기록은 판정이 모두 끝난 뒤 `write`로 연
 * 저장소에 트랜잭션 1개다(판정 도중 저장소를 열어 두지 않는다).
 */
export const checkReproducibility = async (
  input: ReproducibilityInput,
  write: <T>(fn: (store: ProjectStore) => T) => T,
  clock: () => MarkClock,
): Promise<ReproducibilityReport> => {
  const times = input.rounds ?? REPRODUCIBILITY_ROUNDS;
  const rounds: RoundVerdicts[] = [];
  const runners = new Set<JudgeRunnerName>();
  for (let round = 0; round < times; round += 1) {
    const result = await input.judgeOnce(round);
    runners.add(result.runner);
    rounds.push(verdictsOf(result, input.rules));
  }
  const unstable = unstableRuleIds(
    input.rules.map((rule) => rule.id),
    rounds,
  );
  const runner = [...runners][0] ?? 'vitest';
  write((store) =>
    recordRejudgeMismatch(
      store,
      unstable.map((ruleId) => ({ ruleId, commit: input.commit, runner })),
      clock(),
    ),
  );
  return { rounds, unstable };
};

/** 판정 러너로 판정 1회를 부르는 함수 (회차마다 새 판정 ID 폴더: 실행 ID 자리에 회차마다 새 ULID). */
export const runnerRounds =
  (
    runner: JudgeRunner,
    input: Omit<JudgeRunInput, 'runId' | 'ruleIds'> & {
      readonly rules: readonly Pick<Rule, 'displayId'>[];
    },
    newId: () => string,
  ): ((round: number) => Promise<JudgeRunResult>) =>
  () =>
    runner.run({
      projectId: input.projectId,
      runId: newId(),
      worktreeDir: input.worktreeDir,
      profile: input.profile,
      ruleIds: input.rules.map((rule) => rule.displayId),
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
