// 실행 알림 재조회의 합치기 규칙 (이슈 #32 수용 기준 3의 렌더러 쪽, ADR-076).
// 연속 알림으로 조회가 폭주하지 않으면서(동시 조회 1개 · 뒤따르는 조회 최대 1개), 조회 중에 온 알림을 버리지 않아
// 마지막 알림 뒤의 상태가 화면에 남는지 고정한다. 화면에서 실제로 다시 조회하는지는 e2e/run-start.spec.ts.
import { RUN_EVENT_NAMES as SHARED_RUN_EVENT_NAMES } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  createRefreshCoalescer,
  isProjectEvent,
  RUN_EVENT_NAMES,
} from '../src/renderer/src/runs/refreshCoalescer.js';

/** 서버 상태 · 조회 · 화면을 흉내 낸다. 조회는 시작할 때의 상태를 읽고, 시험이 끝낼 때 화면에 반영된다. */
const harness = () => {
  let state = 0;
  let shown: number | null = null;
  const inFlight: { value: number; finish: (ok?: boolean) => void }[] = [];
  let calls = 0;
  let maxConcurrent = 0;
  const refresh = (): Promise<void> => {
    calls += 1;
    const value = state;
    return new Promise<void>((resolve, reject) => {
      const entry = {
        value,
        finish: (ok = true) => {
          inFlight.splice(inFlight.indexOf(entry), 1);
          if (ok) {
            shown = value;
            resolve();
          } else {
            reject(new Error('조회 실패'));
          }
        },
      };
      inFlight.push(entry);
      maxConcurrent = Math.max(maxConcurrent, inFlight.length);
    });
  };
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    refresh,
    flush,
    setState: (value: number) => {
      state = value;
    },
    get shown() {
      return shown;
    },
    get calls() {
      return calls;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    inFlight,
  };
};

describe('createRefreshCoalescer', () => {
  it('조회 중이 아니면 첫 요청에서 바로 조회한다', async () => {
    const h = harness();
    const coalescer = createRefreshCoalescer(h.refresh);
    h.setState(1);
    coalescer.request();
    expect(h.calls).toBe(1);
    h.inFlight[0]?.finish();
    await h.flush();
    expect(h.shown).toBe(1);
    expect(h.calls).toBe(1);
  });

  it('조회 중에 온 연속 요청은 하나로 합쳐 끝난 뒤 1번만 더 조회하고, 마지막 요청 뒤의 상태가 남는다', async () => {
    const h = harness();
    const coalescer = createRefreshCoalescer(h.refresh);
    h.setState(1);
    coalescer.request();
    // 첫 조회가 도는 동안 단계 전이 알림 5개 (상태도 그만큼 바뀐다)
    for (let next = 2; next <= 6; next += 1) {
      h.setState(next);
      coalescer.request();
    }
    expect(h.calls).toBe(1);
    // 첫 조회는 시작 시점 상태(1)를 보인다. 이 결과만 남으면 낡은 화면이다
    h.inFlight[0]?.finish();
    await h.flush();
    expect(h.shown).toBe(1);
    // 뒤따르는 조회 1번: 마지막 알림 뒤의 상태(6)
    expect(h.calls).toBe(2);
    h.inFlight[0]?.finish();
    await h.flush();
    expect(h.shown).toBe(6);
    expect(h.calls).toBe(2);
    expect(h.maxConcurrent).toBe(1);
  });

  it('뒤따르는 조회 중에 온 요청도 버리지 않는다', async () => {
    const h = harness();
    const coalescer = createRefreshCoalescer(h.refresh);
    coalescer.request();
    h.setState(1);
    coalescer.request();
    h.inFlight[0]?.finish();
    await h.flush();
    expect(h.calls).toBe(2);
    h.setState(2);
    coalescer.request();
    h.inFlight[0]?.finish();
    await h.flush();
    expect(h.calls).toBe(3);
    h.inFlight[0]?.finish();
    await h.flush();
    expect(h.shown).toBe(2);
    expect(h.maxConcurrent).toBe(1);
  });

  it('조회가 실패해도 다음 요청 · 뒤따르는 조회를 막지 않는다 (동기 예외 포함)', async () => {
    const h = harness();
    const coalescer = createRefreshCoalescer(h.refresh);
    coalescer.request();
    h.setState(1);
    coalescer.request();
    h.inFlight[0]?.finish(false);
    await h.flush();
    expect(h.calls).toBe(2);
    h.inFlight[0]?.finish();
    await h.flush();
    expect(h.shown).toBe(1);

    let thrown = 0;
    const throwing = createRefreshCoalescer(() => {
      thrown += 1;
      throw new Error('동기 예외');
    });
    throwing.request();
    await h.flush();
    throwing.request();
    await h.flush();
    expect(thrown).toBe(2);
  });

  it('dispose 뒤에는 요청 · 뒤따르는 조회를 하지 않는다', async () => {
    const h = harness();
    const coalescer = createRefreshCoalescer(h.refresh);
    coalescer.request();
    coalescer.request();
    coalescer.dispose();
    h.inFlight[0]?.finish();
    await h.flush();
    coalescer.request();
    expect(h.calls).toBe(1);
  });
});

describe('실행 알림 이름 · 프로젝트 거르기', () => {
  it('알림 이름이 shared와 같다', () => {
    expect(RUN_EVENT_NAMES).toEqual(SHARED_RUN_EVENT_NAMES);
  });

  it('이 프로젝트의 알림만 받는다', () => {
    const id = '01JA0000000000000000000001';
    expect(isProjectEvent({ projectId: id, runId: 'x' }, id)).toBe(true);
    expect(isProjectEvent({ projectId: '01JA0000000000000000000002' }, id)).toBe(false);
    expect(isProjectEvent(null, id)).toBe(false);
    expect(isProjectEvent('x', id)).toBe(false);
    expect(isProjectEvent({}, id)).toBe(false);
  });
});
