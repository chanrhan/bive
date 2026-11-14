// `codeOpen.*` 처리기 (MET-01, M2-01 · ADR-084).
// - `codeOpen.record`: 사람이 `file:line` 링크에서 사유를 골라 연 1회를 남긴다. 주체는 사람만(에이전트 주체 -32020).
//   앱 main(`app.openInIde`)이 IDE를 열기 전에 부르고, 기록이 실패하면 main은 열지 않는다
// - `codeOpen.list`: 조회 전용. 최신부터 상한(`CODE_OPEN_LIST_LIMIT`)까지, 넘으면 `truncated`
// - 역할 세션의 도구(MCP)에는 없다. 파이프 서버가 토큰 인증된 연결에서만 처리한다 (ADR-041)
// - 시각은 오케스트레이터 시계로 정한다. 파일 경로 형식(프로젝트 루트 기준 상대 경로)은 파라미터 스키마가 이미 검증했고
//   리포지토리가 저장 전에 한 번 더 검증한다
// - 저장소 열림 구간은 동기다 (ADR-069)
import { type Author, CODE_OPEN_LIST_LIMIT, createUlidGenerator, ErrorCode } from '@bive/shared';

import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface CodeOpenHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 기록 시각에 쓴다 */
  now: () => number;
}

type CodeOpenMethods = Pick<MethodHandlers, 'codeOpen.record' | 'codeOpen.list'>;

const assertHuman: (author: Author) => asserts author is { kind: 'human' } = (author) => {
  if (author.kind !== 'human') {
    throw new RpcError(
      ErrorCode.Unauthorized,
      '에이전트는 코드 열람 기록을 남길 수 없습니다 (MET-01)',
    );
  }
};

export const createCodeOpenHandlers = ({ biveHome, now }: CodeOpenHandlerDeps): CodeOpenMethods => {
  const newId = createUlidGenerator(now);
  return {
    'codeOpen.record': ({ projectId, author, reason, sourceScreen, itemRef, file, line }) => {
      assertHuman(author);
      return withProjectStore(biveHome, projectId, (store) => ({
        record: store.codeOpens.record({
          id: newId(),
          at: new Date(now()).toISOString(),
          reason,
          sourceScreen,
          itemRef,
          file,
          line,
        }),
      }));
    },
    'codeOpen.list': ({ projectId }) =>
      withProjectStore(biveHome, projectId, (store) => {
        // 상한보다 1건 더 읽어 넘쳤는지 안다
        const rows = store.codeOpens.listLatest(CODE_OPEN_LIST_LIMIT + 1);
        return {
          records: rows.slice(0, CODE_OPEN_LIST_LIMIT),
          truncated: rows.length > CODE_OPEN_LIST_LIMIT,
        };
      }),
  };
};
