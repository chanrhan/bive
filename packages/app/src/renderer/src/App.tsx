// 앱 셸: 경로 상태 + 레이아웃 (사이드바 · 중앙 영역 · 채팅). 화면은 screens/registry.ts에 꽂는다 (ADR-044).
import { AppLayout } from './layout/AppLayout.js';
import { NavigationProvider } from './navigation/NavigationContext.js';

export const App = (): React.JSX.Element => (
  <NavigationProvider>
    <AppLayout />
  </NavigationProvider>
);
