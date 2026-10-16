// 상태 배지 · 생성 주체 표시명과 예외 규칙 (이슈 #16, screens.md 1.4, 기획서 3.4).
// renderer는 shared를 import type으로만 쓰므로 표시명을 다시 적는다. 여기서 shared 원본과 대조한다.
import {
  AUTHOR_KIND_LABELS,
  JUDGMENT_STATUS_LABELS,
  JudgmentStatus,
  MUTATION_STATUS_LABELS,
  MutationStatus,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { AUTHOR_LABELS } from '../src/renderer/src/components/AuthorMark/labels.js';
import { formatCardTime } from '../src/renderer/src/components/Card2Line/time.js';
import {
  JUDGMENT_LABELS,
  MUTATION_LABELS,
  statusExceptions,
  statusTone,
} from '../src/renderer/src/components/StatusBadge/status.js';

describe('표시명', () => {
  it('판정 · 변이 상태 표시명이 shared와 같다', () => {
    expect(JUDGMENT_LABELS).toEqual(JUDGMENT_STATUS_LABELS);
    expect(MUTATION_LABELS).toEqual(MUTATION_STATUS_LABELS);
  });

  it('생성 주체 표시명이 shared와 같다', () => {
    expect(AUTHOR_LABELS).toEqual(AUTHOR_KIND_LABELS);
  });
});

describe('정상 · 예외', () => {
  it('정상 상태(통과 · 변이 검증됨 · 변이 미검증)는 흐린 점, 나머지는 예외', () => {
    const normals = [
      ...JudgmentStatus.options.filter(
        (s) => statusTone({ kind: 'judgment', status: s }) === 'normal',
      ),
      ...MutationStatus.options.filter(
        (s) => statusTone({ kind: 'mutation', status: s }) === 'normal',
      ),
    ];
    expect(normals).toEqual(['pass', 'verified', 'unverified']);
  });

  it('예외 상태만 카드 2줄째 예외가 된다', () => {
    expect(statusExceptions({ kind: 'judgment', status: 'pass' })).toEqual([]);
    expect(statusExceptions({ kind: 'mutation', status: 'unverified' })).toEqual([]);
    expect(statusExceptions({ kind: 'judgment', status: 'fail' })).toEqual([
      { key: 'judgment:fail', label: '실패', tone: 'danger' },
    ]);
    expect(statusExceptions({ kind: 'mutation', status: 'survived' })).toEqual([
      { key: 'mutation:survived', label: '변이 생존', tone: 'danger' },
    ]);
    for (const status of ['unjudged', 'quarantined', 'needs_recheck'] as const) {
      expect(statusExceptions({ kind: 'judgment', status })).toHaveLength(1);
    }
  });
});

describe('카드 시각', () => {
  it('로컬 시각 YYYY-MM-DD HH:mm, 해석할 수 없으면 null', () => {
    const local = new Date(2026, 9, 5, 7, 3).toISOString();
    expect(formatCardTime(local)).toBe('2026-10-05 07:03');
    expect(formatCardTime('어제')).toBeNull();
  });
});
