// 요구사항 상세의 규칙 작성 상태 (이슈 #206 M3-26 수용 기준 1 · 4, screens.md SCR-02 상세 · 1.1, NRM-02 · NFR-03, ADR-099).
// 1) 가장 최근 시도가 실패면 자식 규칙 위에 "규칙 작성 실패 · <종료 사유>"와 오류 문장 표시 값, 생략이면
//    "규칙 작성 생략 · <생략 사유>", 대기 · 진행 중이면 흐린 "규칙 작성 대기" · "규칙 작성 중"으로 구분해 보이고, 정상 종료면 없다
// 2) 이 프로젝트의 event.ruleWriter.changed를 받으면 화면 이동 없이 ruleWriter.status를 다시 읽어 바뀐 상태가 보인다.
//    다른 프로젝트의 알림으로는 다시 읽지 않는다
// 3) 직접 편집 저장(다시 시도의 계기) 뒤 상태를 다시 읽는다
// 화면 값은 가짜 브리지의 ruleWriter.status 응답에서만 만든다. 오케스트레이터가 시도 기록을 저장하고 알림을 보내며 실패 · 생략을
// 다시 시도하는 것은 orchestrator/test/rule-writer.test.ts · events.test.ts(가짜 어댑터 · 설정 미비 재현)가 단언한다.
import type { Requirement, RuleWriterStatusEntry } from '@bive/shared';
import { expect, type Page, test } from '@playwright/test';

import { PROJECT, REQUIREMENTS } from './checklists/scr-02.js';
import { collectVisibleText, findForbiddenText } from './support/expectScreen.js';
import { type BiveMock, mockBive } from './support/bive-mock.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const OTHER_PROJECT_ID = '01JCCCCCCCCCCCCCCCCCCCCCCC';
const TARGET = REQUIREMENTS[0] as Requirement;
const GUARD_ERROR =
  '세션 가드: 허용되지 않은 플러그인 cc-plugin-agents-md, cc-plugin-plugin-authoring';

const entry = (overrides: Partial<RuleWriterStatusEntry>): RuleWriterStatusEntry => ({
  requirementId: TARGET.id,
  attemptId: '01JD0000000000000000000001',
  state: 'ended',
  skipReason: null,
  missing: [],
  endReason: 'success',
  error: null,
  errorTruncated: false,
  requestedAt: '2026-11-21T00:00:00.000Z',
  endedAt: '2026-11-21T00:00:01.000Z',
  ...overrides,
});

const FAILED = entry({ endReason: 'guard_violation', error: GUARD_ERROR });

const open = async (page: Page, first: RuleWriterStatusEntry | null): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: REQUIREMENTS } },
      'rule.list': { result: { rules: [] } },
      'ruleWriter.status': { result: { entries: first === null ? [] : [first] } },
      'requirement.update': {
        result: {
          requirement: {
            ...TARGET,
            text: `${TARGET.text} 수정`,
            updatedAt: '2026-11-21T01:00:00.000Z',
          },
        },
      },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '요구사항', exact: true }).click();
  await page.getByTestId('card').filter({ hasText: TARGET.displayId }).click();
  await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
    'data-selected-id',
    TARGET.id,
  );
  return bive;
};

const statusLine = (page: Page) => page.getByTestId('requirement-rule-writer');

const statusCalls = async (bive: BiveMock) =>
  (await bive.calls()).filter((call) => call.method === 'ruleWriter.status');

const changed = (projectId = PROJECT.id) => ({ projectId, requirementId: TARGET.id });

test.describe('규칙 작성 상태 (M3-26)', () => {
  test('실패: 자식 규칙 위에 "규칙 작성 실패 · 가드 위반"과 오류 문장, 위험 색, 코드 · 이모지 표기 없음', async ({
    page,
  }) => {
    const bive = await open(page, FAILED);
    const line = statusLine(page);
    await expect(line).toHaveAttribute('data-state', 'failed');
    await expect(line).toHaveAttribute('data-tone', 'danger');
    await expect(line.getByTestId('requirement-rule-writer-label')).toHaveText(
      '규칙 작성 실패 · 가드 위반',
    );
    await expect(line.getByTestId('requirement-rule-writer-detail')).toHaveText(GUARD_ERROR);
    // 자식 규칙 영역 안, "없음" 위에 있다 (새 화면 · 탭 없음)
    const section = page.getByTestId('requirement-rules');
    await expect(section.getByTestId('requirement-rule-writer')).toHaveCount(1);
    await expect(section.getByTestId('requirement-rules-empty')).toHaveText('없음');
    // 조회는 이 요구사항만
    for (const call of await statusCalls(bive)) {
      expect(call.params).toEqual({ projectId: PROJECT.id, requirementId: TARGET.id });
    }
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
  });

  test('알림을 받으면 다시 읽어 대기 · 진행 중(흐림) · 생략(경고) · 정상 종료(없음)를 구분해 보인다', async ({
    page,
  }) => {
    const bive = await open(page, entry({ state: 'queued', endReason: null, endedAt: null }));
    const line = statusLine(page);
    await expect(line).toHaveAttribute('data-state', 'queued');
    await expect(line).toHaveAttribute('data-tone', 'muted');
    await expect(line).toHaveText('규칙 작성 대기');

    await bive.setResponse('ruleWriter.status', {
      result: { entries: [entry({ state: 'running', endReason: null, endedAt: null })] },
    });
    await bive.emit('event.ruleWriter.changed', changed());
    await expect(line).toHaveAttribute('data-state', 'running');
    await expect(line).toHaveText('규칙 작성 중');
    await expect(line.getByTestId('requirement-rule-writer-detail')).toHaveCount(0);

    await bive.setResponse('ruleWriter.status', { result: { entries: [FAILED] } });
    await bive.emit('event.ruleWriter.changed', changed());
    await expect(line).toHaveAttribute('data-state', 'failed');

    await bive.setResponse('ruleWriter.status', {
      result: {
        entries: [
          entry({
            state: 'skipped',
            endReason: null,
            skipReason: 'settings_incomplete',
            missing: ['roles.rule-writer.model'],
            error: '예산 · 모델 미설정',
          }),
        ],
      },
    });
    await bive.emit('event.ruleWriter.changed', changed());
    await expect(line).toHaveAttribute('data-state', 'skipped');
    await expect(line).toHaveAttribute('data-tone', 'warning');
    await expect(line.getByTestId('requirement-rule-writer-label')).toHaveText(
      '규칙 작성 생략 · 예산 · 모델 미설정',
    );
    // 설명이 사유와 같으면 한 번만
    await expect(line.getByTestId('requirement-rule-writer-detail')).toHaveCount(0);

    await bive.setResponse('ruleWriter.status', { result: { entries: [entry({})] } });
    await bive.emit('event.ruleWriter.changed', changed());
    await expect(line).toHaveCount(0);
    // 화면은 그대로다
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
  });

  test('다른 프로젝트의 알림으로는 다시 읽지 않고, 기록 없음이면 상태 줄이 없다', async ({
    page,
  }) => {
    const bive = await open(page, null);
    await expect.poll(async () => (await statusCalls(bive)).length).toBeGreaterThan(0);
    await expect(statusLine(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    const base = (await statusCalls(bive)).length;
    await bive.setResponse('ruleWriter.status', { result: { entries: [FAILED] } });
    await bive.emit('event.ruleWriter.changed', changed(OTHER_PROJECT_ID));
    await page.waitForTimeout(500);
    expect((await statusCalls(bive)).length).toBe(base);
    await expect(statusLine(page)).toHaveCount(0);
  });

  test('직접 편집 저장(다시 시도의 계기) 뒤 상태를 다시 읽는다', async ({ page }) => {
    const bive = await open(page, FAILED);
    await expect(statusLine(page)).toHaveAttribute('data-state', 'failed');
    const base = (await statusCalls(bive)).length;
    await bive.setResponse('ruleWriter.status', {
      result: {
        entries: [
          entry({
            attemptId: '01JD0000000000000000000002',
            state: 'queued',
            endReason: null,
            endedAt: null,
          }),
        ],
      },
    });
    await page.getByTestId('requirement-edit').click();
    await page.getByTestId('requirement-edit-input').fill(`${TARGET.text} 수정`);
    await page.getByTestId('requirement-save').click();
    await expect(statusLine(page)).toHaveAttribute('data-state', 'queued');
    expect((await statusCalls(bive)).length).toBeGreaterThan(base);
  });
});
