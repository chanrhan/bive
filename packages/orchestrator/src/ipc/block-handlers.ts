// `blocks.*` 처리기 (NRM-09 · JDG-05 · DSN-01, ADR-005, M3-01 #46, ADR-122).
// - `blocks.get`: 지금 블록 선언(가장 큰 판). 없으면 `current: null`
// - `blocks.set`: 사람 주체만(-32020은 저장소를 열기 전). 선언을 검사해 어긴 곳을 -32001(`BLOCKS_INVALID`)로 돌려주고, 통과하면
//   새 판으로 저장한다. 바꾼 기록은 판 목록 자체다(저장 주체 · 시각 · 본문, 추가 전용)
// - 블록 선언을 쓰는 곳은 이 처리기 하나다. 에이전트 도구 · 세션 · 엔진 · 단계는 이 처리기도 저장소의 선언 쓰기도 모른다
//   (구조 시험 `integrity.test.ts`, ADR-005)
import {
  type Author,
  BlockDeclaration,
  BLOCKS_INVALID_REASON,
  type BlocksInvalidData,
  ErrorCode,
} from '@bive/shared';

import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface BlockHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 저장 시각에 쓴다 */
  now: () => number;
}

type BlockMethods = Pick<MethodHandlers, 'blocks.get' | 'blocks.set'>;

const assertHuman: (author: Author) => asserts author is { kind: 'human' } = (author) => {
  if (author.kind !== 'human') {
    throw new RpcError(
      ErrorCode.Unauthorized,
      '블록 선언은 사람만 바꿀 수 있습니다 (에이전트가 선언을 고쳐 구조 검사를 우회하지 못하게)',
    );
  }
};

/** 선언을 검사한다. 어기면 어긴 곳을 실은 -32001. */
const parseDeclaration = (declaration: unknown): BlockDeclaration => {
  const parsed = BlockDeclaration.safeParse(declaration);
  if (parsed.success) return parsed.data;
  const data: BlocksInvalidData = {
    reason: BLOCKS_INVALID_REASON,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((key) => (typeof key === 'number' ? key : String(key))),
      message: issue.message,
    })),
  };
  const summary = data.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ');
  throw new RpcError(ErrorCode.ValidationFailed, `블록 선언 검증 실패: ${summary}`, data);
};

export const createBlockHandlers = ({ biveHome, now }: BlockHandlerDeps): BlockMethods => ({
  'blocks.get': ({ projectId }) =>
    withProjectStore(biveHome, projectId, (store) => ({
      current: store.blockDeclarations.current(),
    })),
  'blocks.set': ({ projectId, author, declaration }) => {
    assertHuman(author);
    const parsed = parseDeclaration(declaration);
    return withProjectStore(biveHome, projectId, (store) => ({
      current: store.blockDeclarations.set(parsed, {
        at: new Date(now()).toISOString(),
        by: author,
      }),
    }));
  },
});
