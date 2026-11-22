// 프로젝트 하루 예산 한도 (COST-01 · NFR-07, ADR-100 D8 · B⑤ · A12, M7-04 #216, ADR-104).
// - 합산 단위: 프로젝트(저장소 하나)의 세션 전부(실행 세션 + 실행 밖 규칙 작성 세션). 원천은 저장된 세션 기록(비용 ·
//   시작 시각)뿐이고 메모리 카운터를 쓰지 않는다(오케스트레이터를 다시 띄워도 같은 합계)
// - 하루의 경계: 기기의 로컬 날짜(A12). 세션은 시작 시각이 속한 날의 지출이다. 날짜가 바뀌면 합계가 0부터 다시 시작한다
// - 진행 중 세션(종료 사유 없음)은 그 세션에 넘긴 한도 전부로 센다(한도 기록이 없으면 하루 한도 전부). 잔여 읽기와 세션 행
//   만들기 사이에 기다림이 없으므로 이것이 사실상 예약이 되어, 겹쳐 도는 세션들의 한도 합 + 끝난 세션의 지출이 하루 한도를
//   넘지 않는다. 세션이 끝나 실제 값이 확정되면 덜 쓴 만큼이 다시 잔여가 된다
// - 값을 모르는 끝난 세션(ADR-067과 같은 규칙, 묶음 단위만 실행 대신 그날의 프로젝트): ① init 보고 없이 끝난 세션은 0
//   ② 그 밖(init 뒤 결과 없음 · 비정상 종료)은 그날 값을 아는 세션 중 가장 큰 USD(그 세션에 넘긴 한도를 넘지 않게 자름)
//   ③ 그날 아는 세션이 없으면 그 세션에 넘긴 한도 전부. 한도 기록이 없는 세션(이 변경 전의 규칙 작성 세션)은 넘긴 한도를
//   모르므로 ③에서 하루 한도 전부를 쓴 것으로 본다(적게 세지 않는 쪽). ②는 상한이 아니다(ADR-067과 같은 성질)
// - 이의 제기로 끝났는데(`objection_raised`) 값을 모르는 세션은 ②가 아니라 그 세션에 넘긴 한도 전부다(에이전트가 고를 수 있는
//   경로라 덜 세지 않는다, M7-11 · ADR-115 검토 1회차)
// - 하루 한도 `null`(비움)은 한도 없음이다: 새 세션을 막지 않고 자동 시작(M7-05)만 하지 않는다. `0`은 모든 새 세션을 막는다
// 하루 한도는 USD만이다(턴 한도 없음).
import { remainingUsd, type Session, type Settings, sumUsd } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

/** 기기의 로컬 날짜 하루: `[start, end)` 밀리초 시각. */
export interface LocalDay {
  readonly start: number;
  readonly end: number;
}

/** `now`(밀리초)가 속한 기기의 로컬 날짜. 일광 절약 시간으로 하루가 23 · 25시간이어도 자정에서 자정까지다. */
export const localDayOf = (now: number): LocalDay => {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  return {
    start: new Date(year, month, day).getTime(),
    end: new Date(year, month, day + 1).getTime(),
  };
};

/** 그날의 지출. `spent` = `known`(보고된 값의 합) + `estimated`(값을 모르는 세션 `unknownSessions`개의 추정분). */
export interface DailySpend {
  readonly spent: number;
  readonly known: number;
  readonly estimated: number;
  readonly unknownSessions: number;
  readonly sessionCount: number;
}

/**
 * 같은 날 세션들의 지출 (규칙은 파일 머리 주석). `limit`은 한도 기록이 없는 세션의 ③에 쓰는 하루 한도다.
 * 세션 목록은 이미 그날로 거른 것이어야 한다.
 */
export const dailySpend = (sessions: readonly Session[], limit: number): DailySpend => {
  const knownUsd = sessions.flatMap((s) => (s.totalCostUsd === null ? [] : [s.totalCostUsd]));
  const maxKnown = knownUsd.length === 0 ? null : Math.max(...knownUsd);
  const estimates: number[] = [];
  for (const session of sessions) {
    if (session.totalCostUsd !== null) continue;
    const allotment = session.budget?.maxBudgetUsd ?? limit;
    // 진행 중: 넘긴 한도 전부 (예약)
    if (session.endReason === null) {
      estimates.push(allotment);
      continue;
    }
    // 끝났는데 init 보고가 없음: 모델 호출 전 (0)
    if (session.sdkSessionId === null) {
      estimates.push(0);
      continue;
    }
    // 이의 제기로 끝났는데 값을 모름 (닫힌 뒤 계속 불러 중단됨): 넘긴 한도 전부
    if (session.endReason === 'objection_raised') {
      estimates.push(allotment);
      continue;
    }
    estimates.push(Math.min(maxKnown ?? allotment, allotment));
  }
  const known = sumUsd(knownUsd) ?? 0;
  const estimated = sumUsd(estimates) ?? 0;
  return {
    spent: sumUsd([known, estimated]) ?? 0,
    known,
    estimated,
    unknownSessions: estimates.length,
    sessionCount: sessions.length,
  };
};

/** 하루 한도의 남은 USD와 근거. 한도가 비어 있으면(`null`) 계산하지 않는다. */
export interface DailyBudgetState {
  /** 기기의 로컬 날짜 (ISO 시각 `[start, end)`) */
  readonly day: { readonly start: string; readonly end: string };
  readonly limit: number;
  readonly remaining: number;
  readonly spend: DailySpend;
}

/**
 * 열린 저장소에서 오늘(`now`가 속한 기기의 로컬 날짜)의 하루 한도 상태. 하루 한도가 비어 있으면 `null`(한도 없음).
 * `remaining`이 0 이하면 새 에이전트 세션을 열지 않는다 (같으면 이른 것).
 */
export const projectDailyBudget = (
  store: ProjectStore,
  settings: Pick<Settings, 'dailyBudgetUsd'>,
  now: number,
): DailyBudgetState | null => {
  const limit = settings.dailyBudgetUsd;
  if (limit === null) return null;
  const day = localDayOf(now);
  const spend = dailySpend(store.sessions.listStartedBetween(day.start, day.end), limit);
  return {
    day: { start: new Date(day.start).toISOString(), end: new Date(day.end).toISOString() },
    limit,
    remaining: remainingUsd(limit, spend.spent),
    spend,
  };
};

/** 하루 한도에 이르렀는지 (남은 USD가 0 이하). 한도가 없으면 `false`. */
export const dailyBudgetReached = (state: DailyBudgetState | null): boolean =>
  state !== null && !(state.remaining > 0);

/** 생략 사유 · 종료 사유의 사람이 읽는 문장 (화면의 사유 표시명과 같다). */
export const PROJECT_DAILY_BUDGET_EXCEEDED_TEXT = '프로젝트 하루 예산 초과';
