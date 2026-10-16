// 현재 경로 상태 (ADR-044: 라우터 라이브러리 없이 React 상태 하나).
// 화면 이슈는 useNavigation().navigate(id)로 다른 화면으로 이동한다.
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

import type { RouteId } from './routes.js';

export interface Navigation {
  /** 현재 경로. 아무것도 고르지 않았으면 null */
  route: RouteId | null;
  navigate(route: RouteId | null): void;
}

const NavigationContext = createContext<Navigation | null>(null);

export const NavigationProvider = ({
  initialRoute = null,
  children,
}: {
  initialRoute?: RouteId | null;
  children: ReactNode;
}): React.JSX.Element => {
  const [route, setRoute] = useState<RouteId | null>(initialRoute);
  const value = useMemo<Navigation>(() => ({ route, navigate: setRoute }), [route]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
};

export const useNavigation = (): Navigation => {
  const value = useContext(NavigationContext);
  if (value === null) throw new Error('NavigationProvider 밖에서 useNavigation 호출');
  return value;
};
