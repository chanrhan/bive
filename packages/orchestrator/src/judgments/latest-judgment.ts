// 규칙의 최신 판정 (JDG-02, 기획서 3.4, M1-11 · ADR-060).
// 판정 기록 저장소와 규칙 조회 RPC가 만나는 지점은 `storedLatestJudgments` 하나다.
// - 판정 기록은 프로젝트 저장소의 `judgments` 테이블(마이그레이션 `project/0008_judgments`, #29 · ADR-069)에 있다.
//   구현 · 검사 · 병합 재검사 단계가 판정 러너 결과(`completed`)마다 규칙별로 남긴다
// - 규칙의 최신 판정 = 그 규칙의 가장 최근 기록(판정 시각 기준, 같으면 나중에 만든 기록). 기록이 없으면 미판정
//   (꾸며 낸 값 없음, NFR-03). test/rule.test.ts의 가드 테스트가 이 함수가 그 테이블을 읽는지 단언한다
import type { JudgmentResult, RuleJudgment } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

/** 규칙 ID → 그 규칙의 가장 최근 판정 기록. 기록이 없으면 `null`. */
export type LatestJudgmentLookup = (ruleId: string) => JudgmentResult | null;

/** 열린 프로젝트 저장소에서 최신 판정 조회 함수를 만든다. 요청 하나 동안(저장소가 열려 있는 동안)만 쓴다. */
export type LatestJudgmentSource = (store: ProjectStore) => LatestJudgmentLookup;

/**
 * 프로젝트 저장소의 판정 기록에서 최신 판정을 찾는다. 요청 하나에서 규칙마다 다시 묻지 않도록 규칙별 최신 기록을 한 번에 읽는다.
 */
export const storedLatestJudgments: LatestJudgmentSource = (store) => {
  const latest = store.judgments.latestForRules();
  return (ruleId) => latest.get(ruleId) ?? null;
};

/** 최신 판정 기록 → 규칙의 판정 (기록이 없으면 미판정, 있으면 기록의 상태). */
export const toRuleJudgment = (latest: JudgmentResult | null): RuleJudgment =>
  latest === null ? { status: 'unjudged', latest: null } : { status: latest.status, latest };
