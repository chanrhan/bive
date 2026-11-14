// 실행 알림(`event.run.updated` · `event.step.updated`)을 받거나 오케스트레이터에 다시 붙으면 화면 값을 다시 조회한다
// (M1-19 · M1-36, ADR-076). 규칙(SCR-03) · 검증(SCR-05) 화면이 쓴다. 알림 값으로 화면을 그리지 않고 조회 결과만
// 쓴다(NFR-03). 이 프로젝트의 알림만 받고, 연속 요청은 refreshCoalescer 규칙으로 합친다(useEventRefresh).
import { RUN_EVENT_NAMES } from './refreshCoalescer.js';
import { useEventRefresh } from './useEventRefresh.js';

export const useRunEventRefresh = (projectId: string, refresh: () => Promise<unknown>): void => {
  useEventRefresh(projectId, RUN_EVENT_NAMES, refresh);
};
