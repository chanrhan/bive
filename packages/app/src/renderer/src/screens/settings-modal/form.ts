// 설정 예산 · 모델 섹션의 입력 값 ↔ 설정 변환 (SCR-21, COST-01 · NFR-07, ADR-057).
// 입력 칸은 문자열을 들고 있고, 저장할 때 `settings.update` 패치로 바꾼다. 빈 칸은 미설정(`null`)이다.
// renderer는 shared를 타입으로만 가져온다 (architecture.md 2장).
import type { AgentRole, MissingSetting, Settings, SettingsPatch } from '@bive/shared';

/**
 * M1에 보이는 역할 행 (shared `RUN_REQUIRED_ROLES`와 같음, test/settings-form.test.ts가 대조).
 * planner · 변이 주입 · 채팅 행은 그 역할을 여는 이슈가 더한다 (ADR-035 · ADR-057).
 */
export const SETTINGS_ROLE_ROWS = [
  'rule-writer',
  'test-writer',
  'implementer',
] as const satisfies readonly AgentRole[];
export type SettingsRoleRow = (typeof SETTINGS_ROLE_ROWS)[number];

/** 역할 행 이름: 화면 정의서의 역할 명칭 그대로 (ADR-009 · ADR-057). */
export const ROLE_ROW_LABELS = {
  'rule-writer': 'rule-writer',
  'test-writer': 'test-writer',
  implementer: 'implementer',
} as const satisfies Record<SettingsRoleRow, string>;

/** 입력 칸 하나의 키: `run.<필드>` 또는 `roles.<역할>.<필드>` (`MissingSetting`과 같은 경로). */
export type FieldKey =
  | 'run.maxBudgetUsd'
  | 'run.maxTurns'
  | `roles.${SettingsRoleRow}.${'model' | 'maxBudgetUsd' | 'maxTurns'}`;

export type FormValues = Record<FieldKey, string>;

export const FIELD_KEYS: readonly FieldKey[] = [
  'run.maxBudgetUsd',
  'run.maxTurns',
  ...SETTINGS_ROLE_ROWS.flatMap((role) => [
    `roles.${role}.model` as const,
    `roles.${role}.maxBudgetUsd` as const,
    `roles.${role}.maxTurns` as const,
  ]),
];

const text = (value: number | string | null): string => (value === null ? '' : String(value));

/** 저장된 설정 → 입력 값. 미설정은 빈 칸. */
export const toFormValues = (settings: Pick<Settings, 'run' | 'roles'>): FormValues => {
  const values: Partial<FormValues> = {
    'run.maxBudgetUsd': text(settings.run.maxBudgetUsd),
    'run.maxTurns': text(settings.run.maxTurns),
  };
  for (const role of SETTINGS_ROLE_ROWS) {
    const current = settings.roles[role];
    values[`roles.${role}.model`] = text(current.model);
    values[`roles.${role}.maxBudgetUsd`] = text(current.maxBudgetUsd);
    values[`roles.${role}.maxTurns`] = text(current.maxTurns);
  }
  return values as FormValues;
};

/** 빈 칸 = 미설정. 한도 USD는 0보다 큰 수, 턴은 1 이상 정수. 맞지 않으면 `undefined`(입력 오류). */
const parseUsd = (raw: string): number | null | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const parseTurns = (raw: string): number | null | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
};

/** 모델 ID: 앞뒤 공백을 떼고 빈 값은 미설정. 200자 넘으면 입력 오류 (shared `ModelId`). */
const parseModel = (raw: string): string | null | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.length <= 200 ? trimmed : undefined;
};

export type ParseResult = { ok: true; patch: SettingsPatch } | { ok: false; invalid: FieldKey[] };

/** 입력 값 → `settings.update` 패치 (보이는 칸 전부). 형식이 틀린 칸이 있으면 그 키 목록. */
export const toPatch = (values: FormValues): ParseResult => {
  const invalid: FieldKey[] = [];
  const read = <T>(key: FieldKey, parse: (raw: string) => T | null | undefined): T | null => {
    const parsed = parse(values[key]);
    if (parsed === undefined) {
      invalid.push(key);
      return null;
    }
    return parsed;
  };
  const patch = {
    run: {
      maxBudgetUsd: read('run.maxBudgetUsd', parseUsd),
      maxTurns: read('run.maxTurns', parseTurns),
    },
    roles: Object.fromEntries(
      SETTINGS_ROLE_ROWS.map((role) => [
        role,
        {
          model: read(`roles.${role}.model`, parseModel),
          maxBudgetUsd: read(`roles.${role}.maxBudgetUsd`, parseUsd),
          maxTurns: read(`roles.${role}.maxTurns`, parseTurns),
        },
      ]),
    ),
  } satisfies SettingsPatch;
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, patch };
};

/** 검사 결과의 빈 항목 중 이 화면에 보이는 칸만 고른다. */
export const visibleMissing = (missing: readonly MissingSetting[]): Set<FieldKey> => {
  const keys = new Set<string>(FIELD_KEYS);
  return new Set(missing.filter((path): path is FieldKey => keys.has(path)));
};
