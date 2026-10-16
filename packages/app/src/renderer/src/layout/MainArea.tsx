// 중앙 영역 (screens.md 1.2): 현재 경로의 화면을 꽂는다 (screens/registry.ts, ADR-044).
// 아무것도 고르지 않았으면 "선택 항목 없음", 화면이 아직 없는 경로는 "<화면 이름> 준비 중" (ADR-029 · ADR-035).
import { useNavigation } from '../navigation/NavigationContext.js';
import { ROUTE_LABELS } from '../navigation/routes.js';
import { SCREENS } from '../screens/registry.js';
import { EmptyState } from './EmptyState.js';

export const NO_SELECTION_TEXT = '선택 항목 없음';

export const MainArea = (): React.JSX.Element => {
  const { route } = useNavigation();
  const Screen = route === null ? undefined : SCREENS[route];
  return (
    <main className="main-area" data-testid="main-area" data-route={route ?? 'none'}>
      {Screen !== undefined ? (
        <Screen />
      ) : (
        <EmptyState text={route === null ? NO_SELECTION_TEXT : `${ROUTE_LABELS[route]} 준비 중`} />
      )}
    </main>
  );
};
