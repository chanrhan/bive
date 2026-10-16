// 화면 ID → 체크리스트. 화면 이슈가 `scr-XX-<slug>.ts`를 만들고 여기에 한 줄 추가한다.
import { shellChecklist } from './scr-00-shell.js';
import { projectStartChecklist } from './scr-01.js';
import type { ScreenChecklist, ScreenId } from './types.js';

export const CHECKLISTS: Partial<Record<ScreenId, ScreenChecklist>> = {
  'SCR-00': shellChecklist,
  'SCR-01': projectStartChecklist,
};
