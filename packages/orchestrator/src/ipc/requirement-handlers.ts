// `requirement.*` 처리기 (NRM-01, M1-02, ADR-047).
// - 사람의 직접 편집은 제안 없이 바로 반영하고 수정 시각 · 주체를 기록한다 (NRM-01: 직접 편집은 승인 불필요)
// - 에이전트 주체의 생성 · 수정 · 삭제는 파이프로 받지 않는다(-32020). 에이전트 경로는 제안 승인뿐이다 (NRM-04)
// - 삭제는 소프트 삭제다 (NRM-07)
import { type Author, createUlidGenerator, ErrorCode } from '@bive/shared';

import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface RequirementHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 생성 · 수정 · 삭제 시각과 ULID에 쓴다 */
  now: () => number;
}

type RequirementMethods = Pick<
  MethodHandlers,
  | 'requirement.create'
  | 'requirement.update'
  | 'requirement.delete'
  | 'requirement.get'
  | 'requirement.list'
>;

/** 파이프로 규범을 직접 바꿀 수 있는 주체는 사람뿐이다. */
const assertHuman = (author: Author): void => {
  if (author.kind !== 'human') {
    throw new RpcError(
      ErrorCode.Unauthorized,
      '에이전트는 요구사항을 직접 바꿀 수 없습니다. 제안 승인을 거칩니다 (NRM-04)',
    );
  }
};

export const createRequirementHandlers = ({
  biveHome,
  now,
}: RequirementHandlerDeps): RequirementMethods => {
  const newId = createUlidGenerator(now);
  const timestamp = (): string => new Date(now()).toISOString();

  return {
    'requirement.create': ({ projectId, text, author }) => {
      assertHuman(author);
      return withProjectStore(biveHome, projectId, (store) => ({
        requirement: store.requirements.create({
          id: newId(),
          text,
          author,
          // 사람이 직접 쓴 요구사항은 승인 없이 규범이 된다 (NRM-01)
          normState: 'approved',
          createdAt: timestamp(),
        }),
      }));
    },
    'requirement.update': ({ projectId, id, text, author }) => {
      assertHuman(author);
      return withProjectStore(biveHome, projectId, (store) => ({
        requirement: store.requirements.update(id, { text }, { by: author, at: timestamp() }),
      }));
    },
    'requirement.delete': ({ projectId, id, author }) => {
      assertHuman(author);
      return withProjectStore(biveHome, projectId, (store) => ({
        requirement: store.requirements.softDelete(id, { by: author, at: timestamp() }),
      }));
    },
    'requirement.get': ({ projectId, id }) =>
      withProjectStore(biveHome, projectId, (store) => {
        const requirement = store.requirements.get(id);
        if (requirement === null) {
          throw new RpcError(ErrorCode.NotFound, `요구사항을 찾을 수 없습니다: ${id}`);
        }
        return { requirement };
      }),
    'requirement.list': ({ projectId }) =>
      withProjectStore(biveHome, projectId, (store) => ({
        requirements: store.requirements.list(),
      })),
  };
};
