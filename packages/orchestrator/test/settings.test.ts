// 설정 RPC · 실행 전 설정 검사 (M1-05 수용 기준, COST-01 · NFR-07 · ADR-024 · ADR-057).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import {
  type Author,
  createUlidGenerator,
  defaultSettings,
  ErrorCode,
  type RoleSettings,
  type SettingsPatch,
} from '@bive/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import {
  requireRunnableSettings,
  validateSettingsForRun,
} from '../src/settings/settings-service.js';
import { RpcCallError, type TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const implementerAgent = { kind: 'agent', role: 'implementer' } as const satisfies Author;

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

let h: ProjectHarness;
beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
});

const FULL_ROLE: RoleSettings = { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 };

/** M1 필수 역할 3개와 실행 전체 한도를 모두 채운 패치 (roadmap M1 흐름 2 · 6의 값). */
const COMPLETE: SettingsPatch = {
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: {
    'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 },
    'test-writer': FULL_ROLE,
    implementer: FULL_ROLE,
  },
};

const update = (patch: SettingsPatch, author: Author = human) =>
  h.client.call('settings.update', { projectId: h.project.id, patch, author });

const validate = (roles?: Parameters<typeof validateSettingsForRun>[1]) =>
  h.client.call(
    'settings.validateForRun',
    roles === undefined
      ? { projectId: h.project.id }
      : { projectId: h.project.id, roles: [...roles] },
  );

const rpcError = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcCallError);
  return error as RpcCallError;
};

describe('settings.get · settings.update 저장 왕복', () => {
  it('저장한 적이 없으면 기본값(예산 · 모델 미설정, 승인 대기 상한 40, 변경 주체 · 시각 없음)', async () => {
    const { settings } = await h.client.call('settings.get', { projectId: h.project.id });
    expect(settings).toEqual(defaultSettings(h.project.id));
    expect(settings.approvalQueueLimit).toBe(40);
    expect(settings.updatedAt).toBeNull();
    expect(settings.updatedBy).toBeNull();
  });

  it('update가 돌려준 값과 get이 같고, 변경 주체 · 시각이 요청 주체 · 오케스트레이터 시각이다', async () => {
    h.clock.now = T0 + 60_000;
    const saved = (await update(COMPLETE)).settings;
    expect(saved.run).toEqual({ maxBudgetUsd: 5, maxTurns: 200 });
    expect(saved.roles['rule-writer']).toEqual({
      model: 'test-model',
      maxBudgetUsd: 1,
      maxTurns: 20,
    });
    expect(saved.roles['test-writer']).toEqual(FULL_ROLE);
    expect(saved.roles.implementer).toEqual(FULL_ROLE);
    expect(saved.roles.planner).toEqual({ model: null, maxBudgetUsd: null, maxTurns: null });
    expect(saved.updatedAt).toBe(iso(T0 + 60_000));
    expect(saved.updatedBy).toEqual(human);

    expect((await h.client.call('settings.get', { projectId: h.project.id })).settings).toEqual(
      saved,
    );
    // 저장소에도 같은 값 (오케스트레이터를 거치지 않고 읽어도 같다)
    expect(h.read((store) => store.settings.get())).toEqual(saved);
  });

  it('부분 패치는 준 키만 바꾸고 null은 미설정으로 되돌린다', async () => {
    await update(COMPLETE);
    h.clock.now = T0 + 120_000;
    const { settings } = await update({
      run: { maxBudgetUsd: 0.01 },
      roles: { implementer: { model: null } },
    });
    expect(settings.run).toEqual({ maxBudgetUsd: 0.01, maxTurns: 200 });
    expect(settings.roles.implementer).toEqual({ ...FULL_ROLE, model: null });
    expect(settings.roles['test-writer']).toEqual(FULL_ROLE);
    expect(settings.updatedAt).toBe(iso(T0 + 120_000));
  });

  it('planner · chat 역할 값도 저장할 수 있다 (M1 검사 대상은 아님, ADR-057)', async () => {
    const { settings } = await update({ roles: { chat: { model: 'model-a', maxTurns: 5 } } });
    expect(settings.roles.chat).toEqual({ model: 'model-a', maxBudgetUsd: null, maxTurns: 5 });
  });

  it('에이전트 주체의 변경은 -32020이고 아무것도 바뀌지 않는다 (NFR-07)', async () => {
    const error = await rpcError(update(COMPLETE, implementerAgent));
    expect(error.code).toBe(ErrorCode.Unauthorized);
    expect((await h.client.call('settings.get', { projectId: h.project.id })).settings).toEqual(
      defaultSettings(h.project.id),
    );
  });

  it.each([
    ['0 USD 한도', { run: { maxBudgetUsd: 0 } }],
    ['음수 한도', { roles: { implementer: { maxBudgetUsd: -1 } } }],
    ['소수 턴', { run: { maxTurns: 1.5 } }],
    ['공백 모델', { roles: { 'test-writer': { model: '   ' } } }],
    ['모르는 키', { autoMode: true }],
  ])('스키마 위반(%s)은 -32602이고 저장하지 않는다', async (_, patch) => {
    const response = (await h.client.requestRaw({
      jsonrpc: '2.0',
      id: 'bad',
      method: 'settings.update',
      params: { projectId: h.project.id, patch, author: human },
    })) as { error?: { code: number } };
    expect(response.error?.code).toBe(ErrorCode.InvalidParams);
    expect(h.read((store) => store.settings.get())).toEqual(defaultSettings(h.project.id));
  });

  it('등록되지 않은 프로젝트는 -32004', async () => {
    const other = createUlidGenerator()();
    expect((await rpcError(h.client.call('settings.get', { projectId: other }))).code).toBe(
      ErrorCode.NotFound,
    );
    expect(
      (
        await rpcError(
          h.client.call('settings.update', { projectId: other, patch: COMPLETE, author: human }),
        )
      ).code,
    ).toBe(ErrorCode.NotFound);
    expect(
      (await rpcError(h.client.call('settings.validateForRun', { projectId: other }))).code,
    ).toBe(ErrorCode.NotFound);
  });
});

describe('settings.validateForRun (NFR-07)', () => {
  it('모두 채우면 통과', async () => {
    await update(COMPLETE);
    expect(await validate()).toEqual({ ok: true });
  });

  it('아무것도 저장하지 않으면 SETTINGS_INCOMPLETE(-32010)와 빈 항목 전부', async () => {
    const result = await validate();
    expect(result).toEqual({
      ok: false,
      code: -32010,
      reason: 'SETTINGS_INCOMPLETE',
      message: '예산 · 모델 미설정',
      missing: [
        'run.maxBudgetUsd',
        'run.maxTurns',
        'roles.rule-writer.model',
        'roles.rule-writer.maxBudgetUsd',
        'roles.rule-writer.maxTurns',
        'roles.test-writer.model',
        'roles.test-writer.maxBudgetUsd',
        'roles.test-writer.maxTurns',
        'roles.implementer.model',
        'roles.implementer.maxBudgetUsd',
        'roles.implementer.maxTurns',
      ],
    });
  });

  // 역할(rule-writer, test-writer, implementer) 모델이나 실행 전체 한도, 역할별 한도(USD, 턴) 중 하나라도 비면 거부
  const holes: [string, SettingsPatch, string][] = [
    ['실행 전체 USD', { run: { maxBudgetUsd: null } }, 'run.maxBudgetUsd'],
    ['실행 전체 턴', { run: { maxTurns: null } }, 'run.maxTurns'],
    ...(['rule-writer', 'test-writer', 'implementer'] as const).flatMap(
      (role): [string, SettingsPatch, string][] => [
        [`${role} 모델`, { roles: { [role]: { model: null } } }, `roles.${role}.model`],
        [
          `${role} USD`,
          { roles: { [role]: { maxBudgetUsd: null } } },
          `roles.${role}.maxBudgetUsd`,
        ],
        [`${role} 턴`, { roles: { [role]: { maxTurns: null } } }, `roles.${role}.maxTurns`],
      ],
    ),
  ];
  it.each(holes)('%s가 비면 SETTINGS_INCOMPLETE(-32010)', async (_, hole, path) => {
    await update(COMPLETE);
    await update(hole);
    const result = await validate();
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.SettingsIncomplete,
      reason: 'SETTINGS_INCOMPLETE',
      message: '예산 · 모델 미설정',
      missing: [path],
    });
    // 실행 생성 등이 쓰는 내부 검사는 같은 내용을 -32010 오류로 던진다
    const thrown = (() => {
      try {
        h.read((store) => requireRunnableSettings(store));
        return null;
      } catch (error) {
        return error as { code: number; message: string; data: unknown };
      }
    })();
    expect(thrown).toMatchObject({
      code: -32010,
      message: '예산 · 모델 미설정',
      data: { reason: 'SETTINGS_INCOMPLETE', missing: [path] },
    });
  });

  it('roadmap M1 흐름 2 · 5: rule-writer와 실행 전체 한도만 저장하면 rule-writer 검사는 통과, 실행 검사는 거부', async () => {
    await update({
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: { 'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 } },
    });
    expect(await validate(['rule-writer'])).toEqual({ ok: true });
    const result = await validate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual([
        'roles.test-writer.model',
        'roles.test-writer.maxBudgetUsd',
        'roles.test-writer.maxTurns',
        'roles.implementer.model',
        'roles.implementer.maxBudgetUsd',
        'roles.implementer.maxTurns',
      ]);
    }
    expect(() => h.read((store) => requireRunnableSettings(store))).toThrow('예산 · 모델 미설정');
    expect(h.read((store) => requireRunnableSettings(store, ['rule-writer'])).run).toEqual({
      maxBudgetUsd: 5,
      maxTurns: 200,
    });
  });

  it('roles로 다른 역할(planner · chat)을 넘기면 그 역할만 검사하고 실행 전체 한도는 항상 검사한다', async () => {
    await update(COMPLETE);
    const result = await validate(['chat']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual([
        'roles.chat.model',
        'roles.chat.maxBudgetUsd',
        'roles.chat.maxTurns',
      ]);
    }
    await update({ run: { maxTurns: null } });
    const onlyRun = await validate(['rule-writer']);
    expect(onlyRun.ok === false && onlyRun.missing).toEqual(['run.maxTurns']);
  });
});
