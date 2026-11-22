// 실행 자동 시작의 문: 하루 한도 · 설정 (ADR-100 B⑤ · A12, ADR-104 · ADR-107 · ADR-111).
// 자동 시작 실행을 만들 때(`runs/auto-start.ts`)와, 실행 대기에 선 자동 시작 실행이 시작할 차례가 될 때(`runs/run-service.ts`)
// 같은 기준을 쓴다. 원천은 지금 설정과 저장된 오늘의 세션 기록뿐이다(메모리 카운터 없음, ADR-104).
// 판단 순서: 하루 한도 비움 → 실행이 쓰는 역할의 설정 미비 → 오늘 지출이 하루 한도에 이름. 비움이 먼저인 것은 사람이 한도를
// 비운 것이 곧 자동 시작을 끈 것이기 때문이다 (ADR-107).
import type { AutoStartSkipReason, MissingSetting, Settings } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { dailyBudgetReached, projectDailyBudget } from './project-budget.js';
import { validateSettingsForAutoStart } from './settings-service.js';

/** 자동 시작을 막는 이유. `missing`은 설정 미비일 때만 채운다. */
export interface AutoStartBlock {
  readonly reason: AutoStartSkipReason;
  readonly missing: MissingSetting[];
}

/** 열린 저장소에서 지금(`now`) 자동 시작을 해도 되는지. 되면 `null`. 저장하지 않는다. */
export const autoStartBlock = (
  store: ProjectStore,
  settings: Settings,
  now: number,
): AutoStartBlock | null => {
  const check = validateSettingsForAutoStart(settings);
  if (!check.ok) {
    return check.dailyBudgetUnset
      ? { reason: 'project_daily_budget_unset', missing: [] }
      : { reason: 'settings_incomplete', missing: check.missing };
  }
  // 오늘 지출이 하루 한도에 이르렀으면 자동 시작하지 않는다(A12, ADR-104: 실행을 연 뒤 첫 세션에서 막는 것과 다르다)
  if (dailyBudgetReached(projectDailyBudget(store, settings, now))) {
    return { reason: 'project_daily_budget_exceeded', missing: [] };
  }
  return null;
};
