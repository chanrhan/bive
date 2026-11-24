// 프로젝트 전환 때 목록별 필터 상태를 비운다 (ADR-034 "앱 재시작 · 프로젝트 전환 때 초기화", ADR-053).
// 열려 있던 프로젝트에서 다른 프로젝트(또는 없음)로 바뀔 때만 비운다. 처음 열릴 때는 다른 화면이 지정해 둔
// 필터를 지우지 않는다. 늘 그려지는 중앙 영역(MainArea)이 부른다.
import { useEffect, useRef } from 'react';

import { resetAllListFilters } from '../components/ListView/filterStore.js';
import { useProject } from './ProjectContext.js';

export const useResetFiltersOnProjectChange = (): void => {
  const { project } = useProject();
  const id = project?.id ?? null;
  const previousId = useRef<string | null>(null);
  useEffect(() => {
    if (previousId.current !== null && previousId.current !== id) resetAllListFilters();
    previousId.current = id;
  }, [id]);
};
