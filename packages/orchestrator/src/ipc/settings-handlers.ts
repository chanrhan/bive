// `settings.*` 처리기 (COST-01, NFR-07, SCR-21, M1-05, ADR-057).
// - 설정 변경은 사람 주체만 받는다(에이전트 주체 -32020). 에이전트는 자기 예산 · 모델을 바꿀 수 없다 (NFR-07)
// - 저장은 미설정을 허용하고, 실행 전 검사는 `settings.validateForRun`이 값으로 돌려준다
import { type Author, ErrorCode } from '@bive/shared';

import { validateSettingsForRun } from '../settings/settings-service.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface SettingsHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 변경 시각에 쓴다 */
  now: () => number;
}

type SettingsMethods = Pick<
  MethodHandlers,
  'settings.get' | 'settings.update' | 'settings.validateForRun'
>;

const assertHuman: (author: Author) => asserts author is { kind: 'human' } = (author) => {
  if (author.kind !== 'human') {
    throw new RpcError(ErrorCode.Unauthorized, '에이전트는 설정을 바꿀 수 없습니다 (NFR-07)');
  }
};

export const createSettingsHandlers = ({
  biveHome,
  now,
}: SettingsHandlerDeps): SettingsMethods => ({
  'settings.get': ({ projectId }) =>
    withProjectStore(biveHome, projectId, (store) => ({ settings: store.settings.get() })),
  'settings.update': ({ projectId, patch, author }) => {
    assertHuman(author);
    return withProjectStore(biveHome, projectId, (store) => ({
      settings: store.settings.update(patch, {
        by: author,
        at: new Date(now()).toISOString(),
      }),
    }));
  },
  'settings.validateForRun': ({ projectId, roles }) =>
    withProjectStore(biveHome, projectId, (store) =>
      validateSettingsForRun(store.settings.get(), roles),
    ),
});
