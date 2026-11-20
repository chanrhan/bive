// 메인 창 크기 (ADR-093): 기본 1280 × 800은 그대로이고, 최소 크기는 안쪽 크기 820 × 600을 바깥 크기로 바꿔 건다.
// Electron은 대역으로 바꿔 창 옵션과 최소 크기 호출만 본다 (실제 창의 최소 크기는 스모크가 확인한다).
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  options: Record<string, unknown>;
  outer: [number, number];
  inner: [number, number];
  minimum: [number, number] | null;
  shown: boolean;
  handlers: Map<string, () => void>;
}

const created: FakeWindow[] = [];

vi.mock('electron', () => {
  class BrowserWindow {
    readonly state: FakeWindow;
    readonly webContents = {
      setWindowOpenHandler: (): void => undefined,
      on: (): void => undefined,
    };

    constructor(options: Record<string, unknown>) {
      this.state = {
        options,
        outer: [Number(options.width), Number(options.height)],
        // 테두리 2px씩 · 제목 줄 30px인 창 관리자 (시험 전용 값)
        inner: [Number(options.width) - 4, Number(options.height) - 34],
        minimum: null,
        shown: false,
        handlers: new Map(),
      };
      created.push(this.state);
    }

    once(event: string, handler: () => void): void {
      this.state.handlers.set(event, handler);
    }

    show(): void {
      this.state.shown = true;
    }

    getSize(): [number, number] {
      return this.state.outer;
    }

    getContentSize(): [number, number] {
      return this.state.inner;
    }

    setMinimumSize(width: number, height: number): void {
      this.state.minimum = [width, height];
    }

    loadFile(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { BrowserWindow };
});

const { applyMinContentSize, createMainWindow } = await import('../src/main/window.js');
const { DEFAULT_WINDOW_SIZE, MIN_CONTENT_SIZE } = await import('../src/main/window-size.js');

describe('메인 창 크기 (ADR-093)', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('최소 안쪽 크기는 820 × 600(설정 모달 크기, 채팅 띠 접힘 배치 784px 이상), 기본 크기는 1280 × 800 그대로', () => {
    expect(MIN_CONTENT_SIZE).toEqual({ width: 820, height: 600 });
    expect(MIN_CONTENT_SIZE.width).toBeGreaterThanOrEqual(232 + 220 + 288 + 44);
    expect(DEFAULT_WINDOW_SIZE).toEqual({ width: 1280, height: 800 });
  });

  it('창 옵션: 기본 1280 × 800, 최소 하한 820 × 600, 보이기 전 감춤', () => {
    createMainWindow('/app/out/main');
    const window = created[0];
    expect(window?.options).toMatchObject({
      width: 1280,
      height: 800,
      minWidth: 820,
      minHeight: 600,
      show: false,
    });
    expect(window?.options).not.toHaveProperty('useContentSize');
    expect(window?.shown).toBe(false);
  });

  it('보일 때 테두리 · 제목 줄만큼 더해 안쪽 크기 820 × 600을 최소로 건 뒤 보인다', () => {
    createMainWindow('/app/out/main');
    const window = created[0];
    expect(window?.minimum).toBeNull();
    window?.handlers.get('ready-to-show')?.();
    expect(window?.minimum).toEqual([824, 634]);
    expect(window?.shown).toBe(true);
  });

  it('바깥 크기와 안쪽 크기가 같으면(테두리 없음) 최소 크기는 820 × 600 그대로', () => {
    const calls: [number, number][] = [];
    applyMinContentSize({
      getSize: () => [1280, 800],
      getContentSize: () => [1280, 800],
      setMinimumSize: (width: number, height: number) => {
        calls.push([width, height]);
      },
    });
    expect(calls).toEqual([[820, 600]]);
  });
});
