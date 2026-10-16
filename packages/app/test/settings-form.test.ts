// 설정 예산 · 모델 입력 값 ↔ 설정 변환 (이슈 #18, SCR-21, ADR-057).
// renderer는 shared를 import type으로만 쓰므로 역할 행 · 경로를 다시 적는다. 여기서 shared 원본과 대조한다.
import {
  defaultSettings,
  findMissingSettings,
  RUN_REQUIRED_ROLES,
  SettingsPatch,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  FIELD_KEYS,
  type FormValues,
  SETTINGS_ROLE_ROWS,
  toFormValues,
  toPatch,
  visibleMissing,
} from '../src/renderer/src/screens/settings-modal/form.js';

const PROJECT = '01JA0000000000000000000001';

describe('역할 행 · 입력 칸', () => {
  it('보이는 역할 행이 shared의 실행 필수 역할과 같다', () => {
    expect(SETTINGS_ROLE_ROWS).toEqual(RUN_REQUIRED_ROLES);
  });

  it('입력 칸 키가 실행 전 검사의 빈 항목 경로와 같다 (모두 비면 전부 표시)', () => {
    const missing = findMissingSettings(defaultSettings(PROJECT));
    expect([...FIELD_KEYS]).toEqual(missing);
    expect([...visibleMissing(missing)]).toEqual(missing);
    // 보이지 않는 역할의 빈 항목은 표시 대상이 아니다
    expect([...visibleMissing(['roles.chat.model', 'run.maxTurns'])]).toEqual(['run.maxTurns']);
  });
});

describe('변환', () => {
  it('미설정은 빈 칸, 값은 문자열', () => {
    const values = toFormValues(defaultSettings(PROJECT));
    expect(Object.values(values).every((value) => value === '')).toBe(true);
    const filled = toFormValues({
      run: { maxBudgetUsd: 0.5, maxTurns: 200 },
      roles: {
        ...defaultSettings(PROJECT).roles,
        implementer: { model: 'model-a', maxBudgetUsd: 2, maxTurns: 30 },
      },
    });
    expect(filled['run.maxBudgetUsd']).toBe('0.5');
    expect(filled['roles.implementer.model']).toBe('model-a');
    expect(filled['roles.implementer.maxTurns']).toBe('30');
    expect(filled['roles.test-writer.model']).toBe('');
  });

  it('빈 칸은 null, 모델은 앞뒤 공백 제거, 패치는 shared 스키마를 통과한다', () => {
    const values = {
      ...toFormValues(defaultSettings(PROJECT)),
      'run.maxBudgetUsd': ' 5 ',
      'run.maxTurns': '200',
      'roles.rule-writer.model': '  test-model ',
      'roles.rule-writer.maxBudgetUsd': '0.01',
      'roles.rule-writer.maxTurns': '20',
    } satisfies FormValues;
    const result = toPatch(values);
    expect(result).toEqual({
      ok: true,
      patch: {
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: {
          'rule-writer': { model: 'test-model', maxBudgetUsd: 0.01, maxTurns: 20 },
          'test-writer': { model: null, maxBudgetUsd: null, maxTurns: null },
          implementer: { model: null, maxBudgetUsd: null, maxTurns: null },
        },
      },
    });
    if (result.ok) expect(SettingsPatch.safeParse(result.patch).success).toBe(true);
  });

  it.each([
    ['0 USD', 'run.maxBudgetUsd', '0'],
    ['음수 USD', 'roles.implementer.maxBudgetUsd', '-1'],
    ['글자 USD', 'run.maxBudgetUsd', 'abc'],
    ['소수 턴', 'run.maxTurns', '2.5'],
    ['0 턴', 'roles.test-writer.maxTurns', '0'],
    ['지수 표기 턴', 'roles.test-writer.maxTurns', '1e3'],
    ['너무 긴 모델', 'roles.rule-writer.model', 'm'.repeat(201)],
  ] as const)('%s는 입력 오류', (_, key, raw) => {
    const values = { ...toFormValues(defaultSettings(PROJECT)), [key]: raw };
    expect(toPatch(values)).toEqual({ ok: false, invalid: [key] });
  });
});
