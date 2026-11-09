// `rule.*` 조회 처리기 (NRM-02, JDG-02, M1-11, ADR-060).
// - 규칙 테이블의 규범(승인 · 잠정 승인)만 돌려준다. 승인 전 제안은 `proposals`에만 있으므로 섞이지 않는다 (NRM-04)
// - 규칙마다 최신 판정을 붙인다. 판정 기록이 없으면 미판정 (judgments/latest-judgment.ts)
// - 규칙을 만들거나 바꾸는 RPC는 없다. 규칙은 제안 승인으로만 생긴다 (NRM-04, ADR-050)
import { ErrorCode, type Rule, type RuleWithJudgment } from '@bive/shared';

import {
  type LatestJudgmentLookup,
  type LatestJudgmentSource,
  storedLatestJudgments,
  toRuleJudgment,
} from '../judgments/latest-judgment.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface RuleHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 최신 판정 조회 (기본: 프로젝트 저장소의 판정 기록) */
  latestJudgments?: LatestJudgmentSource;
}

type RuleMethods = Pick<MethodHandlers, 'rule.list' | 'rule.get'>;

const withJudgment = (rule: Rule, lookup: LatestJudgmentLookup): RuleWithJudgment => ({
  rule,
  judgment: toRuleJudgment(lookup(rule.id)),
});

export const createRuleHandlers = ({
  biveHome,
  latestJudgments = storedLatestJudgments,
}: RuleHandlerDeps): RuleMethods => ({
  'rule.list': ({ projectId }) =>
    withProjectStore(biveHome, projectId, (store) => {
      const lookup = latestJudgments(store);
      return { rules: store.rules.list().map((rule) => withJudgment(rule, lookup)) };
    }),
  'rule.get': ({ projectId, id }) =>
    withProjectStore(biveHome, projectId, (store) => {
      const rule = store.rules.get(id);
      if (rule === null) {
        throw new RpcError(ErrorCode.NotFound, `규칙을 찾을 수 없습니다: ${id}`);
      }
      return withJudgment(rule, latestJudgments(store));
    }),
});
