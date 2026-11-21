// `confirmation.set` 처리기 (NFR-01, ADR-100 D2 · I1 · C1 · C2, M7-01 #213, ADR-101).
// - 이 처리기는 토큰 인증된 파이프 연결에서만 불린다. 사람 주체만 받는다(에이전트 주체 -32020)
// - 확인은 승인 기록 `confirm`과 확인됨 저장을 트랜잭션 1개로 남긴다(`confirmations/confirmation-service.ts`)
// - 확인을 푸는 RPC는 없다 (확인 풀림은 M7-13). 역할 세션의 도구 목록에도 확인 도구가 없다
import { confirmByHuman, requireHuman } from '../confirmations/confirmation-service.js';
import { withProjectStore } from './project-store-access.js';
import type { MethodHandlers, RequestContext } from './server.js';

export interface ConfirmationHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 확인 시각에 쓴다 */
  now: () => number;
}

type ConfirmationMethods = Pick<MethodHandlers, 'confirmation.set'>;

/** 승인 기록의 `clientId`: 요청이 들어온 파이프 연결 번호 (기동마다 1부터, 증거용). */
const clientIdOf = (context: RequestContext): string => `pipe-${String(context.connectionId)}`;

export const createConfirmationHandlers = ({
  biveHome,
  now,
}: ConfirmationHandlerDeps): ConfirmationMethods => ({
  'confirmation.set': ({ projectId, target, author }, context) => {
    // 저장소를 열기 전에 주체를 본다: 에이전트 주체는 프로젝트 · 대상 유무와 상관없이 -32020
    const human = requireHuman(
      author,
      '에이전트는 확인 상태를 바꿀 수 없습니다. 확인은 사람만 합니다 (NFR-01)',
    );
    return withProjectStore(biveHome, projectId, (store) =>
      confirmByHuman(
        store,
        { target, author: human },
        { clientId: clientIdOf(context) },
        new Date(now()).toISOString(),
      ),
    );
  },
});
