// 실행 시작 확인 · 실행 알림 재조회 (이슈 #32 수용 기준 1 · 2 · 3의 렌더러 쪽, screens.md SCR-03 · SCR-05 · 1.1,
// RUN-01 · RUN-02 · NFR-07, ADR-076).
// 1) SCR-03 [실행]은 확인 대화를 열고, 확인하면 run.create 1회, 취소(취소 · Esc · ×)하면 0회
// 2) run.create가 -32010(SETTINGS_INCOMPLETE)이면 대화에 설정 미비 오류 문구(checklists/scr-03.ts RUN_START)가 보이고
//    실행이 생기지 않는다(대화가 닫히지 않고 다른 실행 요청이 없다)
// 3) 렌더러가 event.run.updated · event.step.updated를 받으면 SCR-03(rule.list) · SCR-05(verification.summary)를 다시
//    조회한다. 연속 알림은 합쳐 조회가 폭주하지 않고, 조회 중에 온 알림 뒤의 상태가 화면에 남는다.
//    오케스트레이터가 단계 전이마다 두 알림을 보내는 것은 orchestrator/test/events.test.ts가 단언한다
// 데이터는 가짜 브리지의 응답 · 알림으로만 만든다.
import { expect, type Page, test } from '@playwright/test';

import type {
  JudgmentResult,
  RuleJudgmentEntry,
  RunCreateResult,
  RuleWithJudgment,
  RunUpdatedEvent,
  StepUpdatedEvent,
} from '@bive/shared';

import { RUN_START } from './checklists/scr-03.js';
import { run as summaryRun, stages, SUMMARY } from './checklists/scr-05.js';
import {
  FAILING_HISTORY,
  FAILING_RULE,
  HISTORY,
  PARENT,
  PROJECT,
  RULES,
} from './checklists/scr-06.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const OTHER_PROJECT_ID = '01JCCCCCCCCCCCCCCCCCCCCCCC';
const RUN_ID = '01JE0000000000000000000003';

/** run.create 가짜 성공 응답에 쓸 값은 화면이 읽지 않으므로 형식만 맞춘다 (테스트 전용 데이터). */
const CREATED = {
  run: summaryRun({ status: 'waiting_approval', currentStep: 'approval' }),
  steps: [],
  approvalLog: {
    seq: 1,
    at: '2026-10-16T05:00:00.000Z',
    actor: { kind: 'human' },
    action: 'run_start',
    target: { entity: 'Run', id: RUN_ID },
    detail: { ruleIds: [FAILING_RULE.id] },
    prevHash: null,
    hash: 'a'.repeat(64),
  },
} as unknown as RunCreateResult;

const SETTINGS_INCOMPLETE = {
  code: -32010,
  message: '예산 · 모델 미설정',
  data: { reason: 'SETTINGS_INCOMPLETE', missing: ['budget.run.maxBudgetUsd'] },
};

const runUpdated = (patch: Partial<RunUpdatedEvent> = {}): RunUpdatedEvent => ({
  projectId: PROJECT.id,
  runId: RUN_ID,
  displayId: 'EXE-003',
  status: 'running',
  currentStep: 'check',
  regressionCount: 0,
  costUsd: null,
  ...patch,
});

const stepUpdated = (patch: Partial<StepUpdatedEvent> = {}): StepUpdatedEvent => ({
  projectId: PROJECT.id,
  runId: RUN_ID,
  stepId: '01JF0000000000000000000005',
  kind: 'check',
  attempt: 1,
  status: 'passed',
  ...patch,
});

const openRules = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'rule.list': { result: { rules: RULES } },
      'judgment.list': { result: { judgments: HISTORY[FAILING_RULE.id] ?? [] } },
      'requirement.get': { result: { requirement: PARENT } },
      'run.create': { result: CREATED },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '규칙', exact: true }).click();
  await expect(page.getByTestId('card')).toHaveCount(RULES.length);
  return bive;
};

const selectFailingRule = async (page: Page): Promise<void> => {
  await page.getByTestId('card').filter({ hasText: FAILING_RULE.displayId }).click();
  await expect(page.getByTestId('rule-detail')).toHaveAttribute(
    'data-selected-id',
    FAILING_RULE.id,
  );
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const runCalls = async (bive: BiveMock): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method.startsWith('run.'));

const dialog = (page: Page) => page.getByRole('dialog', { name: RUN_START.title });

const openDialog = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: RUN_START.run, exact: true }).click();
  await expect(dialog(page)).toBeVisible();
};

test.describe('[실행] · 실행 시작 확인 (수용 기준 1)', () => {
  test('[실행]은 확인 대화만 열고, [시작]을 누르면 run.create를 1회 부르고 대화를 닫는다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    // 고른 항목이 없으면 [실행]이 없다
    await expect(page.getByRole('button', { name: RUN_START.run, exact: true })).toHaveCount(0);
    await selectFailingRule(page);
    await openDialog(page);

    // 대화: 제목 · 대상 규칙 · [취소] · [시작]. 열기만 해서는 부르지 않는다
    const box = dialog(page);
    await expect(box.getByRole('heading', { name: RUN_START.title })).toBeVisible();
    await expect(box.getByText(RUN_START.targets, { exact: true })).toBeVisible();
    await expect(box.getByTestId('run-start-target')).toHaveText(
      `${FAILING_RULE.displayId} · ${FAILING_RULE.title}`,
    );
    await expect(box.getByRole('button', { name: RUN_START.cancel })).toBeVisible();
    await expect(box.getByRole('button', { name: RUN_START.confirm })).toBeVisible();
    expect(await runCalls(bive)).toEqual([]);

    await box.getByRole('button', { name: RUN_START.confirm }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await runCalls(bive)).toEqual([
      {
        method: 'run.create',
        params: { projectId: PROJECT.id, ruleIds: [FAILING_RULE.id], author: { kind: 'human' } },
      },
    ]);
  });

  test('부르는 동안 [시작]을 다시 눌러도 run.create는 1회', async ({ page }) => {
    const bive = await openRules(page, { 'run.create': { result: CREATED, delayMs: 800 } });
    await selectFailingRule(page);
    await openDialog(page);
    const confirm = dialog(page).getByRole('button', { name: RUN_START.confirm });
    await confirm.dblclick();
    await expect(confirm).toBeDisabled();
    await expect(dialog(page)).toHaveCount(0);
    expect(await callsOf(bive, 'run.create')).toHaveLength(1);
  });

  for (const [how, cancel] of [
    [
      '[취소]',
      (page: Page) => dialog(page).getByRole('button', { name: RUN_START.cancel }).click(),
    ],
    ['Esc', (page: Page) => page.keyboard.press('Escape')],
    ['닫기(×)', (page: Page) => dialog(page).getByRole('button', { name: '닫기' }).click()],
  ] as const) {
    test(`${how}로 닫으면 run.create를 부르지 않는다 (0회)`, async ({ page }) => {
      const bive = await openRules(page);
      await selectFailingRule(page);
      await openDialog(page);
      await cancel(page);
      await expect(dialog(page)).toHaveCount(0);
      // 다시 열어도 이전 대화의 결과 · 오류는 남지 않는다
      await openDialog(page);
      await expect(dialog(page).getByTestId('run-start-error')).toHaveCount(0);
      expect(await runCalls(bive)).toEqual([]);
    });
  }
});

test.describe('설정 미비 (수용 기준 2)', () => {
  test('run.create가 SETTINGS_INCOMPLETE면 대화에 "예산 · 모델 미설정"이 보이고 실행이 생기지 않는다', async ({
    page,
  }) => {
    const bive = await openRules(page, { 'run.create': { error: SETTINGS_INCOMPLETE } });
    await selectFailingRule(page);
    await openDialog(page);
    await dialog(page).getByRole('button', { name: RUN_START.confirm }).click();

    // 대화는 닫히지 않고 설정 미비 오류 문구를 보인다
    const error = dialog(page).getByRole('alert');
    await expect(error).toHaveText(RUN_START.settingsIncomplete);
    await expect(dialog(page)).toBeVisible();
    // 실행이 생기지 않음: 실행 요청은 거부된 run.create 1건뿐이고, 화면은 실행을 다시 읽지 않는다
    expect(await runCalls(bive)).toEqual([
      {
        method: 'run.create',
        params: { projectId: PROJECT.id, ruleIds: [FAILING_RULE.id], author: { kind: 'human' } },
      },
    ]);
    await dialog(page).getByRole('button', { name: RUN_START.cancel }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await callsOf(bive, 'run.create')).toHaveLength(1);
  });

  test('그 밖의 거부는 "실행 시작 실패"', async ({ page }) => {
    await openRules(page, {
      'run.create': { error: { code: -32009, message: '삭제된 규칙' } },
    });
    await selectFailingRule(page);
    await openDialog(page);
    await dialog(page).getByRole('button', { name: RUN_START.confirm }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText(RUN_START.failed);
  });
});

/** RULE-002의 새 최신 판정(통과, EXE-003). 실행이 끝나 규칙 목록 · 이력이 바뀐 뒤의 값 (테스트 전용 데이터). */
const NEW_LATEST: JudgmentResult = {
  ...(FAILING_HISTORY[0] as RuleJudgmentEntry).judgment,
  id: '01JD0000000000000000000023',
  status: 'pass',
  judgedAt: '2026-10-16T06:00:00.000Z',
  commit: 'd4e5f6a'.padEnd(40, '0'),
  runId: RUN_ID,
  cases: [],
};
const RULES_AFTER: RuleWithJudgment[] = RULES.map((item) =>
  item.rule.id === FAILING_RULE.id
    ? { rule: item.rule, judgment: { status: 'pass', latest: NEW_LATEST } }
    : item,
);
const HISTORY_AFTER: RuleJudgmentEntry[] = [
  { judgment: NEW_LATEST, runDisplayId: 'EXE-003' },
  ...FAILING_HISTORY,
];

test.describe('실행 알림 → 다시 조회 (수용 기준 3, 렌더러 쪽)', () => {
  test('SCR-03: 이 프로젝트의 event.run.updated · event.step.updated를 받으면 rule.list를 다시 부르고, 다른 프로젝트 알림은 무시한다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    // 처음 불러오기 (개발 모드의 StrictMode는 마운트 효과를 두 번 돌리므로 횟수는 기준값으로 센다)
    const base = (await callsOf(bive, 'rule.list')).length;

    await bive.emit('event.run.updated', runUpdated({ projectId: OTHER_PROJECT_ID }));
    await bive.emit('event.step.updated', stepUpdated({ projectId: OTHER_PROJECT_ID }));
    await page.waitForTimeout(300);
    expect(await callsOf(bive, 'rule.list')).toHaveLength(base);

    await bive.emit('event.run.updated', runUpdated());
    await expect.poll(async () => (await callsOf(bive, 'rule.list')).length).toBe(base + 1);
    await bive.emit('event.step.updated', stepUpdated());
    await expect.poll(async () => (await callsOf(bive, 'rule.list')).length).toBe(base + 2);
    for (const call of await callsOf(bive, 'rule.list')) {
      expect(call.params).toEqual({ projectId: PROJECT.id });
    }
  });

  test('SCR-03: 조회 중에 온 연속 알림은 1번으로 합치고, 마지막 알림 뒤의 상태(새 판정 · 이력 · 실행 ID)가 남는다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectFailingRule(page);
    await expect(page.getByTestId('rule-field-result-run')).toHaveText('실행EXE-002');
    const base = (await callsOf(bive, 'rule.list')).length;
    const historyCalls = (await callsOf(bive, 'judgment.list')).length;

    // 첫 알림의 조회는 늦게 끝나고, 시작할 때의 값(그대로)을 돌려준다
    await bive.setResponse('rule.list', { result: { rules: RULES }, delayMs: 1500 });
    await bive.emit('event.run.updated', runUpdated({ currentStep: 'merge' }));
    await expect.poll(async () => (await callsOf(bive, 'rule.list')).length).toBe(base + 1);
    // 그 조회 중에 실행이 끝나 판정이 바뀌고 알림이 이어진다
    await bive.setResponse('rule.list', { result: { rules: RULES_AFTER } });
    await bive.setResponse('judgment.list', { result: { judgments: HISTORY_AFTER } });
    await bive.emit('event.step.updated', stepUpdated({ kind: 'merge' }));
    await bive.emit(
      'event.step.updated',
      stepUpdated({ kind: 'screen_update', status: 'running' }),
    );
    await bive.emit('event.run.updated', runUpdated({ currentStep: 'screen_update' }));
    await bive.emit('event.run.updated', runUpdated({ status: 'merged', currentStep: null }));
    // 조회 중이었으므로 아직 더 부르지 않는다 (폭주 없음)
    expect(await callsOf(bive, 'rule.list')).toHaveLength(base + 1);

    // 첫 조회가 끝난 뒤 1번만 더 부르고, 그 결과(마지막 상태)가 화면에 남는다
    await expect.poll(async () => (await callsOf(bive, 'rule.list')).length).toBe(base + 2);
    await expect(
      page
        .getByTestId('card')
        .filter({ hasText: FAILING_RULE.displayId })
        .getByTestId('card-exception'),
    ).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await callsOf(bive, 'rule.list')).toHaveLength(base + 2);

    // 고른 규칙의 최신 판정이 바뀌었으므로 실행 이력도 다시 읽어 결과의 실행 ID가 새 실행이다
    // 통과는 글자 없이 흐린 점 (1.4 상태 배지)
    await expect(
      page.getByTestId('rule-field-result-status').getByRole('img', { name: '통과' }),
    ).toBeVisible();
    await expect(page.getByTestId('rule-field-result-run')).toHaveText('실행EXE-003');
    await expect(page.getByTestId('history-row')).toHaveCount(HISTORY_AFTER.length);
    expect((await callsOf(bive, 'judgment.list')).length).toBe(historyCalls + 1);
  });

  test('SCR-05: 알림을 받으면 verification.summary를 다시 부르고 새 파이프라인을 보인다', async ({
    page,
  }) => {
    const bive = await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: PROJECT } },
        'verification.summary': { result: SUMMARY },
        'rule.list': { result: { rules: RULES } },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await expect(page.getByTestId('pipeline-current')).toHaveText('구현');
    const base = (await callsOf(bive, 'verification.summary')).length;

    const next = {
      ...SUMMARY,
      pipeline: {
        run: summaryRun({ currentStep: 'check' }),
        stages: stages('check', 'running'),
      },
    };
    await bive.setResponse('verification.summary', { result: next });
    await bive.emit('event.step.updated', stepUpdated({ kind: 'implementation' }));
    await expect(page.getByTestId('pipeline-current')).toHaveText('검사');
    expect(await callsOf(bive, 'verification.summary')).toHaveLength(base + 1);
    // 다른 프로젝트 알림은 무시
    await bive.emit('event.run.updated', runUpdated({ projectId: OTHER_PROJECT_ID }));
    await page.waitForTimeout(300);
    expect(await callsOf(bive, 'verification.summary')).toHaveLength(base + 1);
  });

  test('화면을 떠나면 알림 구독을 끊는다', async ({ page }) => {
    const bive = await openRules(page);
    await expect
      .poll(async () => {
        const counts = await bive.listenerCounts();
        return [counts['event.run.updated'], counts['event.step.updated']];
      })
      .toEqual([1, 1]);
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await expect
      .poll(async () => {
        const counts = await bive.listenerCounts();
        return [counts['event.run.updated'] ?? 0, counts['event.step.updated'] ?? 0];
      })
      .toEqual([0, 0]);
  });
});
