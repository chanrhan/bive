// 규칙의 최신 판정 (JDG-02, 기획서 3.4, M1-11 · ADR-060).
// 판정 기록 저장소와 규칙 조회 RPC가 만나는 지점은 `storedLatestJudgments` 하나다.
// - 판정 기록(JudgmentResult) 테이블은 검사 단계 · 판정 저장 이슈(#29)가 만든다. 그 전에는 프로젝트 저장소에
//   판정 기록이 없으므로 모든 규칙의 최신 판정 기록은 `null`이고 상태는 미판정이다 (꾸며 낸 값 없음, NFR-03)
// - 판정 기록 테이블이 생기면 이 함수만 그 테이블에서 규칙별 가장 최근 기록(판정 시각 기준)을 읽도록 바꾼다.
//   테이블이 생기면 test/rule.test.ts의 가드 테스트가 실패해 이 함수를 고치도록 알린다
import type { JudgmentResult, RuleJudgment } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

/** 규칙 ID → 그 규칙의 가장 최근 판정 기록. 기록이 없으면 `null`. */
export type LatestJudgmentLookup = (ruleId: string) => JudgmentResult | null;

/** 열린 프로젝트 저장소에서 최신 판정 조회 함수를 만든다. 요청 하나 동안(저장소가 열려 있는 동안)만 쓴다. */
export type LatestJudgmentSource = (store: ProjectStore) => LatestJudgmentLookup;

const NO_RECORD: LatestJudgmentLookup = () => null;

/**
 * 프로젝트 저장소의 판정 기록에서 최신 판정을 찾는다. 지금 저장소에는 판정 기록 테이블이 없어(#29 전)
 * 어떤 규칙도 기록이 없다.
 */
export const storedLatestJudgments: LatestJudgmentSource = () => NO_RECORD;

/** 최신 판정 기록 → 규칙의 판정 (기록이 없으면 미판정, 있으면 기록의 상태). */
export const toRuleJudgment = (latest: JudgmentResult | null): RuleJudgment =>
  latest === null ? { status: 'unjudged', latest: null } : { status: latest.status, latest };
