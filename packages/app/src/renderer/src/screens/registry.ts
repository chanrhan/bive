// 중앙 영역에 꽂는 화면 등록부 (ADR-044).
// 화면 이슈는 화면 컴포넌트를 만들고 여기에 `경로: 컴포넌트` 한 줄을 더한다. 예:
//   import { RequirementsScreen } from './requirements/RequirementsScreen.js';
//   export const SCREENS = { requirements: RequirementsScreen };
// 등록되지 않은 경로는 중앙에 "<화면 이름> 준비 중" 빈 상태가 보인다 (ADR-035 · ADR-044).
import type { ComponentType } from 'react';

import type { RouteId } from '../navigation/routes.js';
import { TodoScreen } from './todo/TodoScreen.js';

export const SCREENS: Partial<Record<RouteId, ComponentType>> = {
  todo: TodoScreen,
};
