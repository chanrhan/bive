// 검토 대기열 (SCR-18, M3-09 #54, ADR-157)의 카드 · 필터 · 배지 합계 · 툴팁 · 액션 입력의 꺼짐 조건 · 거부 문구 표와 표시명 대조.
// 화면에 실제로 보이는지 · 순서 · 호출은 e2e/scr-18.spec.ts · todo-entry.spec.ts · todo-badge.spec.ts.
// e2e 가짜 응답(e2e/checklists/scr-18.ts)이 shared 스키마와 맞는지도 여기서 파싱해 본다.
import {
  DomainErrorReason,
  ErrorCode,
  REVIEW_ACTION_LABELS,
  REVIEW_ACTIONS_BY_KIND,
  REVIEW_ITEM_KIND_LABELS,
  REVIEW_ITEM_STATE_LABELS,
  REVIEW_QUEUE_EVENT_NAMES as SHARED_REVIEW_QUEUE_EVENT_NAMES,
  ReviewConflictReason,
  ReviewQueueListResult,
  ReviewQueueQuarantineResult,
  RunGetResult,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { FIXTURE_LIST } from '../e2e/checklists/scr-17.js';
import {
  ENTRY_BUDGET,
  ENTRY_MUTANT,
  ENTRY_QUARANTINED,
  ENTRY_RAISED,
  QUARANTINE_RESULT,
  REVIEW_EMPTY,
  REVIEW_LIST,
  RULE_EXPORT,
  RULE_LOCK_SHOWN,
  RUN_GET_BUDGET,
} from '../e2e/checklists/scr-18.js';
import {
  countOptions,
  EMPTY_FILTER,
  type ListEntry,
} from '../src/renderer/src/components/ListView/filter.js';
import { REVIEW_QUEUE_EVENT_NAMES } from '../src/renderer/src/runs/refreshCoalescer.js';
import {
  todoBadgeTotal,
  todoBreakdown,
} from '../src/renderer/src/screens/todo/confirmationView.js';
import {
  budgetFields,
  budgetFormValues,
  budgetFromForm,
  excludeLines,
  initialSplitRule,
  isAlreadyResolved,
  openReviewCount,
  quarantineReady,
  REVIEW_ACTION_TEXT,
  REVIEW_ACTIONS_BY_KIND_ORDER,
  REVIEW_CONFLICT_TEXT,
  REVIEW_CRITERIA,
  REVIEW_ERROR_CODE_TEXT,
  REVIEW_ITEM_KIND_TEXT,
  REVIEW_ITEM_STATE_TEXT,
  REVIEW_VALIDATION_TEXT,
  reviewCard,
  reviewErrorText,
  reviewResult,
  reviewTitle,
} from '../src/renderer/src/screens/todo/reviewQueueView.js';

const snapshot = RUN_GET_BUDGET.run.budgetSnapshot;

describe('가짜 응답과 표시명 (shared 대조)', () => {
  it('e2e 가짜 응답이 shared 스키마를 지난다', () => {
    expect(ReviewQueueListResult.parse(REVIEW_LIST)).toEqual(REVIEW_LIST);
    expect(ReviewQueueListResult.parse(REVIEW_EMPTY)).toEqual(REVIEW_EMPTY);
    expect(RunGetResult.parse(RUN_GET_BUDGET)).toEqual(RUN_GET_BUDGET);
    expect(ReviewQueueQuarantineResult.parse(QUARANTINE_RESULT)).toEqual(QUARANTINE_RESULT);
  });

  it('종류 · 처리 상태 · 액션 표시명과 종류별 액션 순서가 shared와 같다', () => {
    expect(REVIEW_ITEM_KIND_TEXT).toEqual(REVIEW_ITEM_KIND_LABELS);
    expect(REVIEW_ITEM_STATE_TEXT).toEqual(REVIEW_ITEM_STATE_LABELS);
    expect(REVIEW_ACTION_TEXT).toEqual(REVIEW_ACTION_LABELS);
    expect(REVIEW_ACTIONS_BY_KIND_ORDER).toEqual(REVIEW_ACTIONS_BY_KIND);
    expect(REVIEW_QUEUE_EVENT_NAMES).toEqual(SHARED_REVIEW_QUEUE_EVENT_NAMES);
  });

  it('거부 사유 표가 shared 값을 빠짐없이 덮는다 (-32009 사유 전부, -32001은 검토 대기열 액션의 값)', () => {
    expect(Object.keys(REVIEW_CONFLICT_TEXT).sort()).toEqual(
      [...ReviewConflictReason.options].sort(),
    );
    const shared: readonly string[] = Object.values(DomainErrorReason);
    for (const reason of Object.keys(REVIEW_VALIDATION_TEXT)) expect(shared).toContain(reason);
    expect(Object.keys(REVIEW_VALIDATION_TEXT).sort()).toEqual(
      [
        DomainErrorReason.QuarantineReasonRequired,
        DomainErrorReason.QuarantineReasonInvalid,
        DomainErrorReason.BudgetShapeMismatch,
        DomainErrorReason.BudgetLowered,
        DomainErrorReason.BudgetNotAboveSpent,
        DomainErrorReason.SplitRuleNotTarget,
        DomainErrorReason.WriteScopeExcludeRequired,
        DomainErrorReason.WriteScopeExcludeInvalid,
        DomainErrorReason.WriteScopeAllowEmpty,
      ].sort(),
    );
    expect(Object.keys(REVIEW_ERROR_CODE_TEXT).map(Number).sort()).toEqual(
      [
        ErrorCode.InvalidParams,
        ErrorCode.NotFound,
        ErrorCode.SettingsIncomplete,
        ErrorCode.Unauthorized,
      ].sort(),
    );
  });
});

describe('카드 (화면 정의서 1.4 · SCR-18)', () => {
  it('1줄 = 대상 규칙 제목(여럿이면 "첫 제목 외 n", 없으면 알 수 없음, 숨은 글자 표기), 2줄 = 원인 실행 ID · 종류 · 등록 시각', () => {
    expect(reviewCard(ENTRY_BUDGET)).toEqual({
      title: `${RULE_EXPORT.title} 외 1`,
      id: 'EXE-012',
      exceptions: [{ key: 'budget_exceeded', label: '예산 초과', tone: 'warning' }],
      dateTime: ENTRY_BUDGET.item.createdAt,
    });
    expect(reviewCard(ENTRY_MUTANT)).toMatchObject({
      title: RULE_LOCK_SHOWN,
      exceptions: [{ label: '변이 생존', tone: 'danger' }],
    });
    expect(reviewTitle({ ...ENTRY_BUDGET, rules: [] })).toBe('알 수 없음');
  });

  it('처리된 항목: 예외 없음, 보조 문구 = 종류 · 처리한 액션', () => {
    const card = reviewCard(ENTRY_RAISED);
    expect(card.exceptions).toBeUndefined();
    expect(card.note).toBe('예산 초과 · 한도 상향 재개');
    expect(reviewCard(ENTRY_QUARANTINED).note).toBe('변이 생존 · 판정 격리');
  });

  it('필터 칩 2종: 종류 · 처리 상태의 값별 개수', () => {
    expect(REVIEW_CRITERIA.map((c) => [c.id, c.label])).toEqual([
      ['kind', '종류'],
      ['state', '처리 상태'],
    ]);
    const entries: ListEntry<(typeof REVIEW_LIST.entries)[number]>[] = REVIEW_LIST.entries.map(
      (item, index) => ({
        item,
        key: String(index),
        searchText: '',
        problem: false,
        time: null,
        index,
      }),
    );
    expect(countOptions(entries, REVIEW_CRITERIA, EMPTY_FILTER)).toEqual({
      kind: { budget_exceeded: 2, mutant_survived: 2 },
      state: { open: 2, resolved: 2 },
    });
    // 처리됨만 고르면 종류 개수는 처리된 항목에서만
    expect(
      countOptions(entries, REVIEW_CRITERIA, { ...EMPTY_FILTER, selected: { state: ['resolved'] } })
        .kind,
    ).toEqual({ budget_exceeded: 1, mutant_survived: 1 });
  });
});

describe('배지 합계 · 툴팁 (ADR-100 "할 일 공통" · D8, ADR-157)', () => {
  it('배지 = 확인할 것 total + 검토 대기열 열린 항목 수 (처리됨은 세지 않음)', () => {
    expect(openReviewCount(REVIEW_LIST)).toBe(2);
    expect(openReviewCount(null)).toBeNull();
    expect(todoBadgeTotal(FIXTURE_LIST, REVIEW_LIST)).toBe(9);
    expect(todoBadgeTotal(FIXTURE_LIST, { entries: [ENTRY_RAISED] })).toBe(7);
  });

  it('한쪽이라도 모르면 배지 · 툴팁 없음', () => {
    expect(todoBadgeTotal(null, REVIEW_LIST)).toBeNull();
    expect(todoBadgeTotal(FIXTURE_LIST, null)).toBeNull();
    expect(todoBreakdown(FIXTURE_LIST, null)).toBe('');
    expect(todoBreakdown(null, REVIEW_LIST)).toBe('');
  });

  it('툴팁: 검토 대기열 종류를 같은 규칙(0건 빼고 건수 많은 순, 같으면 확인할 것 종류 → 검토 대기열 종류)으로 더한다', () => {
    expect(todoBreakdown(FIXTURE_LIST, REVIEW_LIST)).toBe(
      '미확인 3 · 테스트 변경 2 · 폐기 1 · 대체 1 · 예산 초과 1 · 변이 생존 1',
    );
    const many = {
      entries: [
        ENTRY_BUDGET,
        { ...ENTRY_BUDGET, item: { ...ENTRY_BUDGET.item, seq: 9 } },
        ENTRY_BUDGET,
        ENTRY_BUDGET,
      ],
    };
    expect(todoBreakdown(FIXTURE_LIST, many)).toBe(
      '예산 초과 4 · 미확인 3 · 테스트 변경 2 · 폐기 1 · 대체 1',
    );
    expect(todoBreakdown({ items: [], total: 0, truncated: false }, REVIEW_EMPTY)).toBe('');
  });
});

describe('액션 입력의 꺼짐 조건 (서버가 기준, 화면은 빈 값만)', () => {
  it('판정 격리: 공백뿐이면 꺼짐', () => {
    expect(quarantineReady('')).toBe(false);
    expect(quarantineReady(' \n\t ')).toBe(false);
    expect(quarantineReady(' 사유 ')).toBe(true);
  });

  it('새 한도: 원 실행의 예산 값과 같은 칸(실행 전체 → 역할), 처음 값 = 지금 한도, 빈 칸 · 수가 아닌 칸이면 null', () => {
    expect(budgetFields(snapshot).map((f) => f.key)).toEqual([
      'run.maxBudgetUsd',
      'run.maxTurns',
      'roles.test-writer.maxBudgetUsd',
      'roles.test-writer.maxTurns',
      'roles.implementer.maxBudgetUsd',
      'roles.implementer.maxTurns',
    ]);
    const values = budgetFormValues(snapshot);
    expect(budgetFromForm(snapshot, values)).toEqual(snapshot);
    expect(budgetFromForm(snapshot, { ...values, 'run.maxBudgetUsd': ' ' })).toBeNull();
    expect(budgetFromForm(snapshot, { ...values, 'roles.implementer.maxTurns': '' })).toBeNull();
    expect(budgetFromForm(snapshot, { ...values, 'run.maxTurns': '1.5' })).toBeNull();
    // 내림 · 쓴 양 비교는 화면에서 하지 않는다 (서버 거부로 보인다)
    expect(budgetFromForm(snapshot, { ...values, 'run.maxBudgetUsd': '0.5' })).toEqual({
      ...snapshot,
      run: { ...snapshot.run, maxBudgetUsd: 0.5 },
    });
  });

  it('제외 경로: 줄마다 다듬고 빈 줄은 뺀다 (문법은 서버가 본다)', () => {
    expect(excludeLines('')).toEqual([]);
    expect(excludeLines(' \n\n')).toEqual([]);
    expect(excludeLines(' src/a/** \n\nsrc/b\n')).toEqual(['src/a/**', 'src/b']);
    expect(excludeLines('src/x y')).toEqual(['src/x y']);
  });

  it('규칙 분할: 대상 규칙이 하나면 처음부터 골라져 있고, 여럿이면 고르기 전까지 없음', () => {
    expect(initialSplitRule({ ...ENTRY_BUDGET, rules: [RULE_EXPORT] })).toBe(RULE_EXPORT.id);
    expect(initialSplitRule(ENTRY_BUDGET)).toBeNull();
  });
});

describe('거부 문구 표', () => {
  const fields = budgetFields(snapshot);
  const err = (code: number, data?: unknown) => ({ code, message: '서버 글', data });

  it('-32001 고정 사유 · 칸 이름, -32009 사유, 코드, 모르는 값은 일반 문구 (서버 글은 그리지 않는다)', () => {
    expect(reviewErrorText(err(-32001, { reason: 'QUARANTINE_REASON_REQUIRED' }))).toBe(
      '처리 실패 · 사유 없음',
    );
    expect(
      reviewErrorText(
        err(-32001, {
          reason: 'BUDGET_NOT_ABOVE_SPENT',
          fields: ['roles.test-writer.maxBudgetUsd'],
        }),
        fields,
      ),
    ).toBe('처리 실패 · 사용량을 넘지 않는 값 · 테스트 작성 USD');
    expect(
      reviewErrorText(
        err(-32001, { reason: 'WRITE_SCOPE_EXCLUDE_INVALID', fields: ['exclude.0', 'exclude'] }),
      ),
    ).toBe('처리 실패 · 제외 경로 형식 오류 · 1번째 경로');
    expect(reviewErrorText(err(-32001, { reason: 'WRITE_SCOPE_ALLOW_EMPTY' }))).toBe(
      '처리 실패 · 대상 블록 포함 경로 없음',
    );
    expect(reviewErrorText(err(-32009, { reason: 'builtin_rule' }))).toBe('처리 실패 · 내장 규칙');
    expect(reviewErrorText(err(-32010))).toBe('처리 실패 · 예산 · 모델 미설정');
    expect(reviewErrorText(err(-32020))).toBe('처리 실패 · 처리 권한 없음');
    expect(reviewErrorText(err(-32004))).toBe('처리 실패 · 항목 없음');
    expect(reviewErrorText(err(-32602))).toBe('처리 실패 · 입력 형식 오류');
    // 모르는 사유 · 코드
    expect(reviewErrorText(err(-32001, { reason: 'NEW_REASON' }))).toBe('처리 실패');
    expect(reviewErrorText(err(-32009, { reason: 'constructor' }))).toBe('처리 실패');
    expect(reviewErrorText(err(-32001, { reason: 'toString' }))).toBe('처리 실패');
    expect(reviewErrorText(err(-32603))).toBe('처리 실패');
    expect(reviewErrorText(new Error('x'))).toBe('처리 실패');
  });

  it('이미 처리됨만 다시 읽기 대상', () => {
    expect(isAlreadyResolved(err(-32009, { reason: 'already_resolved' }))).toBe(true);
    expect(isAlreadyResolved(err(-32009, { reason: 'split_in_progress' }))).toBe(false);
    expect(isAlreadyResolved(err(-32001, { reason: 'already_resolved' }))).toBe(false);
  });
});

describe('처리 결과', () => {
  it('액션 · 시각 · 만든 실행 ID / 격리 사유 / 나눈 규칙', () => {
    expect(reviewResult(ENTRY_MUTANT)).toBeNull();
    expect(reviewResult(ENTRY_RAISED)).toEqual({
      action: '한도 상향 재개',
      at: ENTRY_RAISED.item.resolution?.at,
      runId: '01JBVE00000000000000000E21',
      rule: null,
      reason: null,
    });
    expect(reviewResult(ENTRY_QUARANTINED)?.reason).toBe('외부 시계 의존 · 다음 분기에 다시 봄');
    const split = {
      ...ENTRY_BUDGET,
      item: {
        ...ENTRY_BUDGET.item,
        resolution: {
          action: 'split_rule' as const,
          by: { kind: 'human' as const },
          at: '2026-11-27T12:00:00.000Z',
          reason: null,
          ruleId: RULE_EXPORT.id,
        },
      },
    };
    expect(reviewResult(split)?.rule).toEqual({ displayId: 'RULE-012', title: RULE_EXPORT.title });
  });
});
