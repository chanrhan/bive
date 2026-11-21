// `requirement.*` 처리기 (NRM-01, M1-02, ADR-047).
// - 사람의 직접 편집은 제안 없이 바로 반영하고 수정 시각 · 주체를 기록한다 (NRM-01: 직접 편집은 승인 불필요)
// - 에이전트 주체의 생성 · 수정 · 삭제는 파이프로 받지 않는다(-32020). 에이전트 경로는 제안 승인뿐이다 (NRM-04)
// - 삭제는 소프트 삭제다 (NRM-07). 자식 규칙은 지우지 않고 부모만 해제한다(같은 트랜잭션, ADR-050).
//   부모 없는 규칙의 추적성 결함 표시는 M3-11
// - 생성 뒤 같은 저장소 열림에서 rule-writer 세션 시작을 맡긴다 (NRM-02, M1-08, ADR-062). 세션은 비동기로 돌고
//   응답을 붙잡지 않으며, 설정이 비어 세션을 띄우지 못해도 요구사항 저장은 성공한다
// - 사람의 직접 편집 저장 뒤에는 가장 최근 규칙 작성 시도가 생략 · 실패였을 때만 다시 시도를 맡긴다 (M3-26, ADR-099)
// - 사람의 작성 · 편집은 그 저장과 같은 트랜잭션에서 확인됨이 된다. 근거는 요구사항 자체의 작성 · 수정 기록이고 승인 기록에는
//   항목을 만들지 않는다 (ADR-100 B① · A1, M7-01). 삭제는 확인 상태를 바꾸지 않는다
import { type Author, createUlidGenerator, ErrorCode } from '@bive/shared';

import { confirmHumanRequirementWrite } from '../confirmations/confirmation-service.js';
import type { RuleWriterLauncher } from '../rule-writer/rule-writer-service.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface RequirementHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 생성 · 수정 · 삭제 시각과 ULID에 쓴다 */
  now: () => number;
  /**
   * 요구사항 생성 뒤 규칙 자동 생성 세션을 띄우는 창구. 오케스트레이터는 항상 넘긴다.
   * 생략하면 세션을 띄우지 않는다(처리기만 시험할 때).
   */
  ruleWriter?: RuleWriterLauncher;
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
  ruleWriter,
}: RequirementHandlerDeps): RequirementMethods => {
  const newId = createUlidGenerator(now);
  const timestamp = (): string => new Date(now()).toISOString();

  return {
    'requirement.create': ({ projectId, text, author }) => {
      assertHuman(author);
      return withProjectStore(biveHome, projectId, (store) => {
        // 사람이 쓴 요구사항은 저장이 곧 확인됨이다: 저장과 같은 트랜잭션 (ADR-100 B①, 승인 기록에는 쓰지 않음)
        const requirement = store.transaction(() =>
          confirmHumanRequirementWrite(
            store,
            store.requirements.create({
              id: newId(),
              text,
              author,
              // 사람이 직접 쓴 요구사항은 승인 없이 규범이 된다 (NRM-01)
              normState: 'approved',
              createdAt: timestamp(),
            }),
          ),
        );
        // 세션은 대기열에서 비동기로 돈다. start는 던지지 않고 결과(생략 사유 포함)는 서비스가 기록한다
        ruleWriter?.start(store, { projectId, requirement });
        return { requirement };
      });
    },
    'requirement.update': ({ projectId, id, text, author }) => {
      assertHuman(author);
      return withProjectStore(biveHome, projectId, (store) => {
        // 사람이 고친 요구사항도 저장이 곧 확인됨이다: 수정과 같은 트랜잭션 (ADR-100 B① · A1)
        const requirement = store.transaction(() =>
          confirmHumanRequirementWrite(
            store,
            store.requirements.update(id, { text }, { by: author, at: timestamp() }),
          ),
        );
        // 사람의 직접 편집 저장이 다시 시도의 계기다: 가장 최근 시도가 생략 · 실패일 때만 새 시도 (ADR-099)
        ruleWriter?.retry(store, { projectId, requirement });
        return { requirement };
      });
    },
    'requirement.delete': ({ projectId, id, author }) => {
      assertHuman(author);
      return withProjectStore(biveHome, projectId, (store) =>
        store.transaction(() => {
          const at = timestamp();
          const requirement = store.requirements.softDelete(id, { by: author, at });
          store.rules.detachFromParent(id, at);
          return { requirement };
        }),
      );
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
