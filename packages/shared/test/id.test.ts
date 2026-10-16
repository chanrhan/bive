// 식별자 검증: 표시 ID 접두 · 프로젝트별 3자리 순번 (ADR-025), ULID 시간순 정렬 (architecture.md 3장).
import { describe, expect, it } from 'vitest';

import {
  compareDisplayIds,
  createDisplayIdGenerator,
  createUlidGenerator,
  DISPLAY_ID_PREFIX_BY_ENTITY,
  DisplayId,
  DisplayIdPrefix,
  displayIdSchema,
  formatDisplayId,
  type NextSeq,
  parseDisplayId,
  Ulid,
} from '../src/index.js';

/** 테스트용 메모리 순번: 프로젝트 · 접두마다 1부터 증가. */
const memorySeq = (): NextSeq => {
  const counters = new Map<string, number>();
  return (projectId, prefix) => {
    const key = `${projectId}/${prefix}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  };
};

describe('표시 ID 접두 (ADR-025)', () => {
  it('접두 6종: REQ · RULE · CON · EXE · PRP · ADR', () => {
    expect(DisplayIdPrefix.options).toEqual(['REQ', 'RULE', 'CON', 'EXE', 'PRP', 'ADR']);
  });

  it('엔터티별 접두. 실행은 PRD RUN-xx와 구분해 EXE', () => {
    expect(DISPLAY_ID_PREFIX_BY_ENTITY).toEqual({
      Requirement: 'REQ',
      Rule: 'RULE',
      Contract: 'CON',
      Run: 'EXE',
      Proposal: 'PRP',
      Adr: 'ADR',
    });
  });

  it.each([
    ['REQ', 'REQ-001'],
    ['RULE', 'RULE-001'],
    ['CON', 'CON-001'],
    ['EXE', 'EXE-001'],
    ['PRP', 'PRP-001'],
    ['ADR', 'ADR-001'],
  ] as const)('%s 접두의 첫 ID는 %s', (prefix, expected) => {
    const generate = createDisplayIdGenerator(memorySeq());
    expect(generate('p1', prefix)).toBe(expected);
  });
});

describe('프로젝트별 순번', () => {
  it('3자리로 0을 채운다', () => {
    expect(formatDisplayId('REQ', 1)).toBe('REQ-001');
    expect(formatDisplayId('REQ', 42)).toBe('REQ-042');
    expect(formatDisplayId('REQ', 999)).toBe('REQ-999');
    expect(formatDisplayId('REQ', 1000)).toBe('REQ-1000');
  });

  it('프로젝트 · 접두마다 따로 센다', () => {
    const generate = createDisplayIdGenerator(memorySeq());
    expect(generate('p1', 'REQ')).toBe('REQ-001');
    expect(generate('p1', 'REQ')).toBe('REQ-002');
    expect(generate('p1', 'RULE')).toBe('RULE-001');
    expect(generate('p2', 'REQ')).toBe('REQ-001');
    expect(generate('p1', 'REQ')).toBe('REQ-003');
  });

  it('주입한 next-seq 함수에 프로젝트 · 접두를 넘긴다', () => {
    const calls: [string, string][] = [];
    const generate = createDisplayIdGenerator((projectId, prefix) => {
      calls.push([projectId, prefix]);
      return 7;
    });
    expect(generate('proj-a', 'PRP')).toBe('PRP-007');
    expect(calls).toEqual([['proj-a', 'PRP']]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('잘못된 순번 %s는 예외', (seq) => {
    const generate = createDisplayIdGenerator(() => seq);
    expect(() => generate('p1', 'REQ')).toThrow(RangeError);
  });

  it('정의되지 않은 접두는 예외', () => {
    const generate = createDisplayIdGenerator(() => 1);
    expect(() => generate('p1', 'RUN' as DisplayIdPrefix)).toThrow();
  });
});

describe('표시 ID 해석 · 스키마', () => {
  it('정규 형식만 해석한다', () => {
    expect(parseDisplayId('REQ-001')).toEqual({ prefix: 'REQ', seq: 1 });
    expect(parseDisplayId('RULE-1000')).toEqual({ prefix: 'RULE', seq: 1000 });
    for (const bad of ['REQ-1', 'REQ-01', 'REQ-0001', 'REQ-000', 'RUN-001', 'req-001', 'REQ001']) {
      expect(parseDisplayId(bad), bad).toBeNull();
    }
  });

  it('스키마는 접두를 제한할 수 있다', () => {
    expect(DisplayId.safeParse('EXE-003').success).toBe(true);
    expect(DisplayId.safeParse('EXE-3').success).toBe(false);
    expect(displayIdSchema('REQ').safeParse('REQ-010').success).toBe(true);
    expect(displayIdSchema('REQ').safeParse('RULE-010').success).toBe(false);
  });
});

describe('시간순 정렬', () => {
  it('생성 순서대로 정렬된다 (999 → 1000 경계 포함)', () => {
    const generate = createDisplayIdGenerator(memorySeq());
    const generated = Array.from({ length: 1005 }, () => generate('p1', 'EXE'));
    const shuffled = [...generated].reverse();
    expect(shuffled.sort(compareDisplayIds)).toEqual(generated);
    expect(compareDisplayIds('EXE-999', 'EXE-1000')).toBeLessThan(0);
  });

  it('접두가 다르면 접두로 묶고, 형식이 아닌 값은 뒤로 보낸다', () => {
    expect(['REQ-002', 'not-an-id', 'ADR-001', 'REQ-001'].sort(compareDisplayIds)).toEqual([
      'ADR-001',
      'REQ-001',
      'REQ-002',
      'not-an-id',
    ]);
  });

  it('ULID는 생성 순서 = 사전식 정렬 순서 (같은 밀리초 포함)', () => {
    let clock = 1_760_000_000_000;
    const ticks = [0, 0, 0, 1, 1, 5, 5, 5, 1000];
    let i = 0;
    const newId = createUlidGenerator(() => clock + (ticks[i++] ?? 0));
    const ids = ticks.map(() => newId());
    for (const id of ids) expect(Ulid.parse(id)).toBe(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    // 시계가 뒤로 가도 단조 증가를 유지한다
    clock -= 10_000;
    const later = newId();
    expect(later > (ids.at(-1) ?? '')).toBe(true);
  });

  it('ULID 스키마는 형식이 아닌 값을 거부한다', () => {
    expect(Ulid.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true);
    expect(Ulid.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FA').success).toBe(false);
    expect(Ulid.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAI').success).toBe(false);
    expect(Ulid.safeParse('01arz3ndektsv4rrffq69g5fav').success).toBe(false);
  });
});
