// 실행 알림을 받아 다시 조회할 때의 합치기 규칙 (M1-19, ADR-076). DOM · React에 의존하지 않는다
// (test/refresh-coalescer.test.ts).
// - 조회 중이 아니면 바로 조회한다(첫 알림은 기다리지 않는다)
// - 조회 중에 온 요청은 버리지 않고 하나로 합쳐, 지금 조회가 끝난 뒤 1번 더 조회한다. 단계 전이가 짧은 간격으로
//   여러 번 와도 동시에 도는 조회는 1개, 뒤따르는 조회는 최대 1개다
// - 그 뒤따르는 조회는 마지막 요청보다 늦게 시작하므로 마지막 알림 뒤의 상태가 반드시 화면에 남는다
// - 조회 실패도 끝난 것으로 본다(다음 요청을 막지 않는다)

/** 렌더러가 다시 조회하는 실행 알림 이름 (shared `RUN_EVENT_NAMES`와 같음, 시험이 대조한다). */
export const RUN_EVENT_NAMES = ['event.run.updated', 'event.step.updated'] as const;

/** 알림 값이 이 프로젝트의 것인지 (`projectId`). 다른 프로젝트 실행의 알림으로는 조회하지 않는다. */
export const isProjectEvent = (params: unknown, projectId: string): boolean =>
  typeof params === 'object' &&
  params !== null &&
  (params as { projectId?: unknown }).projectId === projectId;

export interface RefreshCoalescer {
  /** 다시 조회를 요청한다. */
  request(): void;
  /** 이후 요청 · 뒤따르는 조회를 하지 않는다 (지금 도는 조회는 그대로 끝난다). */
  dispose(): void;
}

export const createRefreshCoalescer = (refresh: () => Promise<unknown>): RefreshCoalescer => {
  let running = false;
  let again = false;
  let disposed = false;

  const run = (): void => {
    running = true;
    again = false;
    let pending: Promise<unknown>;
    try {
      pending = refresh();
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .catch(() => undefined)
      .then(() => {
        running = false;
        if (again && !disposed) run();
      });
  };

  return {
    request: () => {
      if (disposed) return;
      if (running) {
        again = true;
        return;
      }
      run();
    },
    dispose: () => {
      disposed = true;
      again = false;
    },
  };
};
