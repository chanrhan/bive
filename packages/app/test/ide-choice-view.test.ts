// 코드 열기 IDE 선택의 값 변환 · 내장 틀 (이슈 #45, ADR-018 · ADR-087).
// renderer는 shared를 import type으로만 쓰므로 내장 틀을 다시 적는다. 여기서 shared 원본과 대조한다.
import { IDE_URL_TEMPLATES, IdeSetting } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_IDE_TEMPLATES,
  DEFAULT_IDE_KIND,
  IDE_KIND_LABELS,
  IDE_KINDS,
  toIdeChoice,
  toIdeSetting,
} from '../src/renderer/src/components/IdeChoice/ideChoiceView.js';

describe('IDE 선택 (ADR-018)', () => {
  it('내장 틀이 shared와 같고, 선택지 순서는 VS Code · Cursor · 사용자 지정, 기본은 VS Code', () => {
    expect(BUILTIN_IDE_TEMPLATES).toEqual(IDE_URL_TEMPLATES);
    expect(IDE_KINDS).toEqual(['vscode', 'cursor', 'custom']);
    expect(IDE_KINDS.map((kind) => IDE_KIND_LABELS[kind])).toEqual([
      'VS Code',
      'Cursor',
      '사용자 지정',
    ]);
    expect(DEFAULT_IDE_KIND).toBe('vscode');
  });

  it('미설정이면 VS Code를 미리 고르고, 저장된 선택은 그대로 입력 상태가 된다', () => {
    expect(toIdeChoice(null)).toEqual({ kind: 'vscode', template: '' });
    expect(toIdeChoice({ kind: 'cursor' })).toEqual({ kind: 'cursor', template: '' });
    expect(
      toIdeChoice({ kind: 'custom', template: 'idea://open?file=/{path}&line={line}' }),
    ).toEqual({ kind: 'custom', template: 'idea://open?file=/{path}&line={line}' });
  });

  it('입력 상태 → 저장 값: 내장은 종류만, 사용자 지정은 앞뒤 공백을 뗀 틀, 빈 틀은 null(입력 오류)', () => {
    expect(toIdeSetting({ kind: 'vscode', template: 'x' })).toEqual({ kind: 'vscode' });
    expect(toIdeSetting({ kind: 'cursor', template: '' })).toEqual({ kind: 'cursor' });
    const custom = toIdeSetting({
      kind: 'custom',
      template: '  vscode-insiders://file/{path}:{line} ',
    });
    expect(custom).toEqual({ kind: 'custom', template: 'vscode-insiders://file/{path}:{line}' });
    expect(IdeSetting.safeParse(custom).success).toBe(true);
    expect(toIdeSetting({ kind: 'custom', template: '   ' })).toBeNull();
  });
});
