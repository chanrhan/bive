// 요구사항 목록 불러오기 · 새 요구사항 저장 · 직접 편집 · 삭제
// (RPC `requirement.list` · `requirement.create` · `requirement.update` · `requirement.delete`, ADR-047 · ADR-078).
// - 프로젝트가 바뀌면 다시 불러오고, 그동안은 로딩이다(이전 프로젝트 목록을 보이지 않음)
// - 저장 뒤 다시 불러오는 동안은 지금 목록을 그대로 둔다(깜박임 없음)
// - 편집 · 삭제가 성공하면 응답의 요구사항을 목록에 바로 반영하고(편집 = 교체, 삭제 = 빠짐) 목록을 다시 불러온다
// - 바꾸는 요청의 주체는 늘 사람이다(직접 편집, NRM-01 · NFR-01)
// - 늦게 온 이전 요청의 결과는 버린다
import type { Requirement } from '@bive/shared';
import { useCallback, useEffect, useState } from 'react';

import { visibleRequirements } from './requirementsView.js';

export type RequirementsLoad =
  { state: 'loading' } | { state: 'ready'; items: Requirement[] } | { state: 'error' };

const LOADING: RequirementsLoad = { state: 'loading' };

export interface UseRequirements {
  load: RequirementsLoad;
  /** 사람이 쓴 새 요구사항을 저장하고 목록을 다시 불러온다. 실패하면 거부된다. */
  create(text: string): Promise<void>;
  /** 사람의 직접 편집: 본문을 바꾸고 목록을 다시 불러온다. 실패하면 거부된다. */
  update(id: string, text: string): Promise<void>;
  /** 사람의 삭제(소프트 삭제): 목록에서 빼고 다시 불러온다. 실패하면 거부된다. */
  remove(id: string): Promise<void>;
}

export const useRequirements = (projectId: string): UseRequirements => {
  // 어느 프로젝트의 결과인지 함께 둬서 프로젝트가 바뀐 직후 이전 목록을 보이지 않게 한다
  const [loaded, setLoaded] = useState<{ projectId: string; load: RequirementsLoad } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    window.bive.invoke('requirement.list', { projectId }).then(
      ({ requirements }) => {
        if (active) {
          setLoaded({
            projectId,
            load: { state: 'ready', items: visibleRequirements(requirements) },
          });
        }
      },
      () => {
        if (active) setLoaded({ projectId, load: { state: 'error' } });
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, version]);

  const create = useCallback(
    async (text: string): Promise<void> => {
      await window.bive.invoke('requirement.create', {
        projectId,
        text,
        author: { kind: 'human' },
      });
      setVersion((v) => v + 1);
    },
    [projectId],
  );

  /** 응답으로 받은 요구사항을 지금 목록에 반영한다(삭제된 것은 빠짐). 다시 불러오기 전 깜박임을 막는다 */
  const applyResult = useCallback(
    (requirement: Requirement): void => {
      setLoaded((current) => {
        if (current === null || current.projectId !== projectId) return current;
        if (current.load.state !== 'ready') return current;
        const items = current.load.items.map((item) =>
          item.id === requirement.id ? requirement : item,
        );
        return { projectId, load: { state: 'ready', items: visibleRequirements(items) } };
      });
      setVersion((v) => v + 1);
    },
    [projectId],
  );

  const update = useCallback(
    async (id: string, text: string): Promise<void> => {
      const { requirement } = await window.bive.invoke('requirement.update', {
        projectId,
        id,
        text,
        author: { kind: 'human' },
      });
      applyResult(requirement);
    },
    [projectId, applyResult],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const { requirement } = await window.bive.invoke('requirement.delete', {
        projectId,
        id,
        author: { kind: 'human' },
      });
      applyResult(requirement);
    },
    [projectId, applyResult],
  );

  const load = loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
  return { load, create, update, remove };
};
