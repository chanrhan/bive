// 프로젝트 하루 예산 한도 (이슈 #216 M7-04 수용 기준 1, COST-01 · NFR-07, ADR-100 D8 · B⑤ · A12, ADR-067, ADR-104).
// - 규칙 작성 세션과 실행 세션의 비용을 프로젝트 단위로 기기의 로컬 날짜 하루 동안 합산한다(원천은 저장된 세션 기록)
// - 값을 모르는 세션은 ADR-067 규칙(init 전 0 · 아는 최댓값 · 없으면 세션 한도 전부)으로 센다
// - 한도에 이르면 새 에이전트 세션이 열리지 않는다: 규칙 작성은 시도 기록의 생략 사유 '프로젝트 하루 예산 초과',
//   실행은 `budget_exceeded`(`project_daily_budget_exceeded`)
// - 날짜가 바뀌면 합계가 새로 시작한다(시계 주입). 0은 모든 새 세션을 막고, 비움은 막지 않는다
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소 · 실제 git 픽스처 · ScriptedAdapter.
import fs from 'node:fs';

import {
  type Author,
  createUlidGenerator,
  RULE_WRITER_SKIP_REASON_LABELS,
  type Session,
  type SettingsPatch,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionSpec } from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { PipeServer } from '../src/ipc/server.js';
import { RuleWriterService } from '../src/rule-writer/rule-writer-service.js';
import { createRun } from '../src/runs/run-service.js';
import { dailySpend, localDayOf, projectDailyBudget } from '../src/settings/project-budget.js';
import type { TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  newId as engineId,
  seedProject,
  testExecutors,
  withProject,
} from './helpers/engine-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';
import { iso, type ProjectHarness, startProjectHarness, T0 } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const ulid = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
const services: RuleWriterService[] = [];
const engines: PipelineEngine[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const engine of engines.splice(0)) await engine.stop();
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SKIP_TEXT = '프로젝트 하루 예산 초과';
/** 시나리오 happy-path의 규칙 작성 세션 비용 */
const RULE_WRITER_COST = 0.0312;

/** 기기의 로컬 시각 (월은 1부터). 시험이 어느 시간대에서 돌아도 로컬 날짜 경계를 정확히 짚는다. */
const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number =>
  new Date(y, m - 1, d, h, min, s, ms).getTime();

// ── 순수 함수 ──────────────────────────────────────────────

/** 합산 입력용 세션 (값이 `null`이면 init 뒤 결과 없이 끝난 세션). */
const session = (totalCostUsd: number | null, extra: Partial<Session> = {}): Session => ({
  id: ulid(),
  runId: null,
  stepId: null,
  requirementId: null,
  role: 'rule-writer',
  model: 'test-model',
  sdkSessionId: 'sdk-session',
  workDir: '/work/session',
  endReason: totalCostUsd === null ? 'aborted' : 'success',
  error: null,
  totalCostUsd,
  numTurns: totalCostUsd === null ? null : 3,
  modelUsage: {},
  firstTurnCacheWrite: null,
  budget: { maxBudgetUsd: 0.5, maxTurns: 20 },
  tools: [],
  mcpServers: [],
  startedAt: '2026-11-21T09:00:00.000Z',
  endedAt: '2026-11-21T09:00:01.000Z',
  ...extra,
});

/**
 * 시험 동안 기기 시간대를 바꾼다(UTC가 아닌 곳에서 로컬 날짜 경계를 단언해, 경계를 UTC 날짜로 바꾸면 빨강이 되게).
 * vitest 워커에서 `process.env.TZ`를 바꾸면 `Date`의 로컬 계산에 바로 반영된다(아래 `offsetAtEpoch`로 확인).
 */
const useTimeZone = (zone: string): void => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TZ;
    process.env.TZ = zone;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
};

/** 시간대별: 1970-01-01의 UTC와의 차(분, `getTimezoneOffset`) · 그 시간대의 하루 경계 사례(UTC 시각). */
const ZONES = [
  {
    zone: 'Asia/Seoul',
    offsetAtEpoch: -540,
    // 2026-11-22 00:30 KST = 2026-11-21T15:30Z → 그날은 2026-11-21T15:00Z ~ 2026-11-22T15:00Z
    probe: '2026-11-21T15:30:00.000Z',
    day: { start: '2026-11-21T15:00:00.000Z', end: '2026-11-22T15:00:00.000Z' },
  },
  {
    zone: 'America/Los_Angeles',
    offsetAtEpoch: 480,
    // 일광 절약 시간이 끝나는 날(2026-11-01, 25시간): 01:30 PST 두 번째 = 09:30Z
    probe: '2026-11-01T09:30:00.000Z',
    day: { start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z' },
  },
] as const;

describe.each(ZONES)('하루의 경계: 기기의 로컬 날짜 (ADR-100 A12, 시간대 $zone)', (zone) => {
  useTimeZone(zone.zone);

  it('하루는 로컬 자정부터 다음 로컬 자정 직전까지다 (UTC 날짜가 아니다)', () => {
    expect(new Date(0).getTimezoneOffset()).toBe(zone.offsetAtEpoch);
    const day = localDayOf(Date.parse(zone.probe));
    expect({ start: iso(day.start), end: iso(day.end) }).toEqual(zone.day);
    // 자정 직전 · 자정은 서로 다른 날
    expect(localDayOf(day.end - 1)).toEqual(day);
    expect(localDayOf(day.end).start).toBe(day.end);
    expect(localDayOf(local(2026, 11, 21, 15, 30))).toEqual({
      start: local(2026, 11, 21),
      end: local(2026, 11, 22),
    });
  });
});

describe('하루 합산: 값을 모르는 세션은 ADR-067 규칙', () => {
  it('보고된 값은 그대로 더하고(나노 달러 정수), 값을 모르는 세션은 0으로 세지 않는다', () => {
    expect(dailySpend([], 1)).toEqual({
      spent: 0,
      known: 0,
      estimated: 0,
      unknownSessions: 0,
      sessionCount: 0,
    });
    expect(dailySpend([session(0.1), session(0.2)], 1).spent).toBe(0.3);
    // init 보고 없이 끝난 세션 = 0 (모델 호출 전)
    const beforeInit = session(null, { sdkSessionId: null, endReason: 'error_during_execution' });
    expect(dailySpend([session(0.1), beforeInit], 1)).toMatchObject({
      spent: 0.1,
      estimated: 0,
      unknownSessions: 1,
    });
    // 진행 중 = 그 세션에 넘긴 한도 전부 (예약, 그날 아는 값과 무관), init 전이어도 같다
    const running = session(null, { endReason: null, endedAt: null });
    expect(dailySpend([session(0.04), session(0.1), running], 1)).toMatchObject({
      spent: 0.64,
      known: 0.14,
      estimated: 0.5,
      unknownSessions: 1,
    });
    const startingRun = session(null, { sdkSessionId: null, endReason: null, endedAt: null });
    expect(dailySpend([session(0.001), startingRun], 1).estimated).toBe(0.5);
    // 진행 중인데 한도 기록이 없으면(이 변경 전 세션) 하루 한도 전부
    expect(dailySpend([session(0.001), { ...running, budget: null }], 0.3).estimated).toBe(0.3);
    // init 뒤 결과 없이 끝남 = 그날 아는 최댓값 (그 세션 한도로 자름)
    expect(dailySpend([session(0.04), session(0.1), session(null)], 1)).toMatchObject({
      spent: 0.24,
      estimated: 0.1,
    });
    const capped = session(null, { budget: { maxBudgetUsd: 0.07, maxTurns: 5 } });
    expect(dailySpend([session(0.1), capped], 1).estimated).toBe(0.07);
    // 아는 세션이 없으면 그 세션 한도 전부, 한도 기록이 없으면(이 변경 전 규칙 작성 세션) 하루 한도 전부
    expect(dailySpend([session(null)], 1).spent).toBe(0.5);
    expect(dailySpend([session(null, { budget: null })], 2).spent).toBe(2);
  });
});

// ── 저장된 기록 · 시계 ─────────────────────────────────────

const seedRequirement = (store: ProjectStore, at: number): string =>
  store.requirements.create({
    id: ulid(),
    text: '하루 예산 시험 요구사항',
    author: human,
    normState: 'approved',
    createdAt: iso(at),
  }).id;

/** 끝난 실행 밖 규칙 작성 세션 한 개를 저장한다. */
const seedSession = (
  store: ProjectStore,
  requirementId: string,
  startedAt: number,
  totalCostUsd: number | null,
): void => {
  const id = ulid();
  store.sessions.start({
    id,
    runId: null,
    stepId: null,
    requirementId,
    role: 'rule-writer',
    model: 'test-model',
    workDir: '/work/session',
    budget: { maxBudgetUsd: 0.5, maxTurns: 20 },
    startedAt: iso(startedAt),
  });
  if (totalCostUsd === null) {
    store.sessions.recordInit(id, { sdkSessionId: 'sdk', tools: [], mcpServers: [] });
  }
  store.sessions.end(id, {
    endReason: totalCostUsd === null ? 'aborted' : 'success',
    totalCostUsd,
    numTurns: totalCostUsd === null ? null : 2,
    endedAt: iso(startedAt + 1000),
  });
};

describe.each(ZONES)(
  '저장된 세션 기록에서 합산 · 날짜가 바뀌면 새로 시작 (시간대 $zone)',
  (zone) => {
    useTimeZone(zone.zone);

    it('오늘 시작한 세션만 더하고, 자정이 지나면 합계가 0부터 다시 시작하며 다시 읽어도 같다', async () => {
      expect(new Date(0).getTimezoneOffset()).toBe(zone.offsetAtEpoch);
      const h = await startProjectHarness({ servers, clients });
      const today = local(2026, 11, 21, 12);
      h.read((store) => {
        const requirementId = seedRequirement(store, local(2026, 11, 20, 8));
        seedSession(store, requirementId, local(2026, 11, 20, 23, 59, 59, 999), 0.3); // 어제
        seedSession(store, requirementId, local(2026, 11, 21, 0, 0, 0, 0), 0.1); // 오늘 자정
        seedSession(store, requirementId, local(2026, 11, 21, 23, 59, 59, 999), 0.05); // 오늘 끝
        seedSession(store, requirementId, local(2026, 11, 22, 0, 0, 0, 0), 0.2); // 내일
      });
      const at = (now: number) =>
        h.read((store) => projectDailyBudget(store, { dailyBudgetUsd: 1 }, now));
      expect(at(today)).toMatchObject({
        day: { start: iso(local(2026, 11, 21)), end: iso(local(2026, 11, 22)) },
        limit: 1,
        remaining: 0.85,
        spend: { spent: 0.15, sessionCount: 2 },
      });
      // 날짜가 바뀌면 합계가 새로 시작한다 (어제 · 오늘 세션은 빠진다)
      expect(at(local(2026, 11, 22, 0, 0, 0, 0))).toMatchObject({
        remaining: 0.8,
        spend: { spent: 0.2, sessionCount: 1 },
      });
      expect(at(local(2026, 11, 23, 9))).toMatchObject({
        remaining: 1,
        spend: { spent: 0, sessionCount: 0 },
      });
      // 같은 저장소를 다시 열어 읽어도 같은 합계 (메모리 카운터가 아니다)
      expect(at(today)?.spend.spent).toBe(0.15);
      // 비움은 한도 없음
      expect(
        h.read((store) => projectDailyBudget(store, { dailyBudgetUsd: null }, today)),
      ).toBeNull();
      // 0은 지출이 0이어도 이미 한도에 이른 것
      expect(
        h.read((store) => projectDailyBudget(store, { dailyBudgetUsd: 0 }, local(2026, 11, 23))),
      ).toMatchObject({ remaining: 0, spend: { spent: 0 } });
    });
  },
);

// ── 규칙 작성 세션 ─────────────────────────────────────────

interface RuleWriterHarness extends ProjectHarness {
  service: RuleWriterService;
  specs: SessionSpec[];
}

/** `gate`를 주면 첫 세션이 그 약속이 풀릴 때까지 기다린다 (대기열 시험). */
const startRuleWriter = async (gate?: Promise<void>): Promise<RuleWriterHarness> => {
  const specs: SessionSpec[] = [];
  let home = '';
  let inner: ScriptedAdapter | null = null;
  let service: RuleWriterService | null = null;
  const adapter: AgentAdapter = {
    kind: 'scripted',
    startSession: (spec) => {
      specs.push(spec);
      const scripted = (inner ??= new ScriptedAdapter({
        scenario: loadScenario('happy-path'),
        biveHome: home,
        pollIntervalMs: 10,
      }));
      if (gate === undefined || specs.length > 1) return scripted.startSession(spec);
      return (async function* () {
        await gate;
        yield* scripted.startSession(spec);
      })();
    },
  };
  const h = await startProjectHarness(
    { servers, clients },
    {
      ruleWriter: ({ biveHome, now }) => {
        home = biveHome;
        service = new RuleWriterService({ biveHome, adapter, now });
        services.push(service);
        return service;
      },
    },
  );
  if (service === null) throw new Error('서비스가 만들어지지 않음');
  return { ...h, service, specs };
};

const RULE_WRITER_PATCH = (dailyBudgetUsd: number | null, roleUsd = 1): SettingsPatch => ({
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: { 'rule-writer': { model: 'test-model', maxBudgetUsd: roleUsd, maxTurns: 20 } },
  dailyBudgetUsd,
});

const saveSettings = (h: ProjectHarness, patch: SettingsPatch) =>
  h.client.call('settings.update', { projectId: h.project.id, patch, author: human });

const status = async (h: ProjectHarness, requirementId: string) =>
  (await h.client.call('ruleWriter.status', { projectId: h.project.id, requirementId })).entries[0];

const waitUntil = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('기다리는 조건이 채워지지 않음');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** 요구사항을 저장하고(규칙 작성 시도) 그 시도가 끝날 때까지 기다린 뒤 가장 최근 시도를 돌려준다. */
const writeRequirement = async (h: RuleWriterHarness, text: string) => {
  const { requirement } = await h.client.call('requirement.create', {
    projectId: h.project.id,
    text,
    author: human,
  });
  await h.service.whenSettled(h.project.id, requirement.id);
  await h.service.idle();
  return status(h, requirement.id);
};

describe('규칙 작성 세션 (수용 기준 1)', () => {
  it('세션 USD 한도는 하루 잔여로 묶이고, 하루 지출이 한도에 이르면 세션을 열지 않고 생략 사유가 남으며, 날짜가 바뀌면 다시 연다', async () => {
    const h = await startRuleWriter();
    await saveSettings(h, RULE_WRITER_PATCH(0.04));

    // 1) 첫 세션: min(역할 1, 하루 잔여 0.04) = 0.04, 비용 0.0312
    expect(await writeRequirement(h, '첫 요구사항')).toMatchObject({
      state: 'ended',
      endReason: 'success',
    });
    // 2) 둘째 세션: 하루 잔여 0.04 - 0.0312 = 0.0088이 한도 → 시나리오 비용이 넘어 예산 한도 초과로 끝난다
    expect(await writeRequirement(h, '둘째 요구사항')).toMatchObject({
      state: 'ended',
      endReason: 'error_max_budget_usd',
    });
    expect(h.specs.map((spec) => spec.budget)).toEqual([
      { maxBudgetUsd: 0.04, maxTurns: 20 },
      { maxBudgetUsd: 0.0088, maxTurns: 20 },
    ]);
    // 세션 행에 넘긴 한도가 남는다 (값을 모르는 세션을 ADR-067 ③으로 셀 수 있게)
    const sessions = h.read((store) => store.sessions.listStartedBetween(T0 - 60_000, T0 + 60_000));
    expect(sessions.map((s) => [s.budget?.maxBudgetUsd, s.totalCostUsd])).toEqual([
      [0.04, RULE_WRITER_COST],
      [0.0088, RULE_WRITER_COST],
    ]);

    // 3) 하루 지출 0.0624 ≥ 0.04: 세션을 열지 않고 생략 사유가 남는다
    const skipped = await writeRequirement(h, '셋째 요구사항');
    expect(skipped).toMatchObject({
      state: 'skipped',
      skipReason: 'project_daily_budget_exceeded',
      error: SKIP_TEXT,
      endReason: null,
    });
    expect(RULE_WRITER_SKIP_REASON_LABELS.project_daily_budget_exceeded).toBe(SKIP_TEXT);
    expect(h.specs).toHaveLength(2);

    // 4) 다음 날(시계 +24시간): 합계가 새로 시작해 하루 한도 전부로 다시 연다
    h.clock.now = T0 + 24 * 60 * 60 * 1000;
    expect(await writeRequirement(h, '다음 날 요구사항')).toMatchObject({
      state: 'ended',
      endReason: 'success',
    });
    expect(h.specs.at(-1)?.budget).toEqual({ maxBudgetUsd: 0.04, maxTurns: 20 });
  }, 60_000);

  it('대기열에서 기다리는 사이 하루 지출이 한도에 이르면 시작 직전에 다시 읽어 생략으로 끝난다', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await startRuleWriter(gate);
    // 역할 한도 0.1, 하루 한도 0.5
    await saveSettings(h, RULE_WRITER_PATCH(0.5, 0.1));
    const first = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '첫 요구사항',
      author: human,
    });
    await waitUntil(() => h.specs.length === 1);
    // 첫 세션이 진행 중(값 모름 → 아는 값이 없어 그 세션 한도 0.1로 셈)이어도 잔여 0.4 > 0이라 둘째는 대기열에 들어간다
    const second = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '둘째 요구사항',
      author: human,
    });
    expect(await status(h, second.requirement.id)).toMatchObject({ state: 'queued' });
    // 기다리는 사이 다른 세션(실행 세션 등)이 오늘 0.47을 쓴 것으로 기록된다: 0.0312 + 0.47 ≥ 0.5
    h.read((store) => seedSession(store, first.requirement.id, T0, 0.47));
    release();
    await h.service.idle();
    expect(await status(h, first.requirement.id)).toMatchObject({
      state: 'ended',
      endReason: 'success',
    });
    expect(await status(h, second.requirement.id)).toMatchObject({
      state: 'skipped',
      skipReason: 'project_daily_budget_exceeded',
      error: SKIP_TEXT,
    });
    expect(h.specs).toHaveLength(1);
  }, 60_000);

  it('하루 한도 0은 첫 세션부터 막고, 비움은 막지 않는다', async () => {
    const h = await startRuleWriter();
    await saveSettings(h, RULE_WRITER_PATCH(0));
    expect(await writeRequirement(h, '0 한도 요구사항')).toMatchObject({
      state: 'skipped',
      skipReason: 'project_daily_budget_exceeded',
    });
    expect(h.specs).toHaveLength(0);

    await saveSettings(h, RULE_WRITER_PATCH(null));
    expect(await writeRequirement(h, '비움 요구사항')).toMatchObject({
      state: 'ended',
      endReason: 'success',
    });
    // 비움이면 하루 잔여로 묶지 않는다 (역할 한도 그대로)
    expect(h.specs.map((spec) => spec.budget)).toEqual([{ maxBudgetUsd: 1, maxTurns: 20 }]);
  }, 60_000);

  it('값을 모르는 세션(결과 없이 끝남, 아는 값 없음)은 그 세션 한도 전부로 세어 하루 한도를 소진한다 (ADR-067)', async () => {
    const h = await startRuleWriter();
    await saveSettings(h, RULE_WRITER_PATCH(0.5));
    h.read((store) => {
      const requirementId = seedRequirement(store, T0 - 1000);
      seedSession(store, requirementId, T0 - 1000, null); // init 뒤 결과 없음, 한도 0.5
    });
    expect(await writeRequirement(h, '추정 소진 요구사항')).toMatchObject({
      state: 'skipped',
      skipReason: 'project_daily_budget_exceeded',
    });
    expect(h.specs).toHaveLength(0);
  }, 60_000);
});

// ── 실행 세션 ─────────────────────────────────────────────

describe('실행 세션 (수용 기준 1)', () => {
  it('실행 세션 비용도 하루 지출에 들어가 규칙 작성 세션을 막고, 한도에 이른 뒤의 실행은 세션 없이 budget_exceeded(project_daily_budget_exceeded)로 끝난다', async () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const seeded = seedProject(biveHome, repo, { ...COMPLETE_SETTINGS, dailyBudgetUsd: 0.06 });
    const budgets: number[] = [];
    const scripted = new ScriptedAdapter({
      scenario: loadScenario('happy-path'),
      biveHome,
      pollIntervalMs: 20,
    });
    const adapter: AgentAdapter = {
      kind: scripted.kind,
      startSession: (spec) => {
        budgets.push(spec.budget.maxBudgetUsd);
        return scripted.startSession(spec);
      },
    };
    const engine = new PipelineEngine({ biveHome, agent: adapter, executors: testExecutors() });
    engines.push(engine);
    const newRun = (): string =>
      withProject(biveHome, seeded.project.id, (store) =>
        createRun(
          store,
          { ruleIds: [seeded.rule.id], author: human },
          { clientId: null },
          { now: Date.now, newId: engineId },
        ),
      ).run.id;
    const finish = async (runId: string) => {
      expect(engine.evaluateApproval(seeded.project.id, runId)).toBe(true);
      await engine.settled();
      return withProject(biveHome, seeded.project.id, (store) => store.runs.getDetail(runId));
    };

    // 첫 실행: test-writer 한도 min(2, 5, 0.06) = 0.06 → 0.0421, implementer 한도 0.06 - 0.0421 = 0.0179에서 멈춤
    const first = await finish(newRun());
    expect(budgets).toEqual([0.06, 0.0179]);
    expect(first?.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'error_max_budget_usd',
    });

    // 오늘 지출(실행 세션 2개) ≥ 0.06: 규칙 작성 세션은 열리지 않는다
    const service = new RuleWriterService({ biveHome, adapter, now: Date.now });
    services.push(service);
    const started = withProject(biveHome, seeded.project.id, (store) => {
      const requirement = store.requirements.create({
        id: engineId(),
        text: '하루 예산 뒤 요구사항',
        author: human,
        normState: 'approved',
        createdAt: new Date().toISOString(),
      });
      return service.start(store, { projectId: seeded.project.id, requirement });
    });
    expect(started).toMatchObject({ status: 'skipped', reason: 'project_daily_budget_exceeded' });

    // 둘째 실행: 첫 세션을 열기 전에 멈춘다 (세션 0개, 기존 예산 초과 경로와 같은 보존 · 기록)
    const secondId = newRun();
    const second = await finish(secondId);
    expect(budgets).toHaveLength(2);
    expect(second?.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'project_daily_budget_exceeded',
      mergeCommit: null,
    });
    const halted = second?.steps.find((step) => step.status === 'failed');
    expect(halted?.exitDetail).toMatchObject({
      reason: 'project_daily_budget_exceeded',
      detail: { role: 'test-writer', limit: 0.06, spent: 0.1008, unknownSessions: 0 },
    });
    expect(
      withProject(biveHome, seeded.project.id, (store) => store.sessions.listByRun(secondId)),
    ).toEqual([]);
  }, 120_000);
});

// ── 겹쳐 도는 세션 (검토 1회차 B1) ───────────────────────────

/** 시작한 세션을 `release` 전까지 붙잡는 어댑터 (붙잡을 역할만). 받은 한도를 역할과 함께 남긴다. */
const holdingAdapter = (biveHome: string, holdRoles: readonly string[]) => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const budgets: { role: string; maxBudgetUsd: number }[] = [];
  const scripted = new ScriptedAdapter({
    scenario: loadScenario('happy-path'),
    biveHome,
    pollIntervalMs: 20,
  });
  const adapter: AgentAdapter = {
    kind: scripted.kind,
    startSession: (spec) => {
      budgets.push({ role: spec.role, maxBudgetUsd: spec.budget.maxBudgetUsd });
      if (!holdRoles.includes(spec.role)) return scripted.startSession(spec);
      return (async function* () {
        await gate;
        yield* scripted.startSession(spec);
      })();
    },
  };
  return { adapter, budgets, release: () => release() };
};

/** 오늘 진행 중 세션들에 넘긴 한도의 합 + 끝난 세션의 지출 (값을 아는 것만). */
const committedToday = (store: ProjectStore): number => {
  const day = localDayOf(Date.now());
  const nano = store.sessions
    .listStartedBetween(day.start, day.end)
    .reduce(
      (sum, s) =>
        sum +
        Math.round(
          (s.endReason === null ? (s.budget?.maxBudgetUsd ?? Infinity) : (s.totalCostUsd ?? 0)) *
            1e9,
        ),
      0,
    );
  return nano / 1e9;
};

const waitFor = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`기다리는 조건이 채워지지 않음: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('겹쳐 도는 세션: 진행 중 세션은 넘긴 한도 전부로 센다 (검토 1회차 B1, ADR-104)', () => {
  const seedEnded = (biveHome: string, projectId: string, cost: number): void => {
    withProject(biveHome, projectId, (store) => {
      const requirementId = seedRequirement(store, Date.now() - 2000);
      seedSession(store, requirementId, Date.now() - 1000, cost);
    });
  };

  it('실행 세션이 도는 동안 만든 다른 실행들은 실행 대기라 세션이 없어 하루 합산에 들어가지 않고, 앞 실행이 끝나면 차례로 깨어나 하루 한도에 이른 날에는 세션 없이 budget_exceeded(project_daily_budget_exceeded)로 끝난다 (실행 + 실행, ADR-105)', async () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const seeded = seedProject(biveHome, repo, {
      ...COMPLETE_SETTINGS,
      roles: {
        ...COMPLETE_SETTINGS.roles,
        'test-writer': { model: 'test-model', maxBudgetUsd: 0.05, maxTurns: 100 },
      },
      dailyBudgetUsd: 0.1,
    });
    seedEnded(biveHome, seeded.project.id, 0.001);
    const held = holdingAdapter(biveHome, ['test-writer']);
    const engine = new PipelineEngine({
      biveHome,
      agent: held.adapter,
      executors: testExecutors(),
    });
    engines.push(engine);
    const start = (): string => {
      const runId = withProject(biveHome, seeded.project.id, (store) =>
        createRun(
          store,
          { ruleIds: [seeded.rule.id], author: human },
          { clientId: null },
          { now: Date.now, newId: engineId },
        ),
      ).run.id;
      expect(engine.evaluateApproval(seeded.project.id, runId)).toBe(true);
      return runId;
    };
    const detail = (runId: string) =>
      withProject(biveHome, seeded.project.id, (store) => store.runs.getDetail(runId));

    // 첫 실행의 test-writer: min(0.05, 0.1 - 0.001) = 0.05, 붙잡힌 채 진행 중
    const first = start();
    await waitFor(() => held.budgets.length === 1, '첫 세션');
    // 둘째 · 셋째 실행: 프로젝트당 진행 중 1개라 실행 대기(ADR-105). 세션이 없어 하루 합산에 들어가지 않는다
    const second = start();
    const third = start();
    expect([detail(second)?.run.status, detail(third)?.run.status]).toEqual(['queued', 'queued']);
    expect(held.budgets).toEqual([{ role: 'test-writer', maxBudgetUsd: 0.05 }]);
    expect(withProject(biveHome, seeded.project.id, committedToday)).toBe(0.051);
    // 첫 실행이 끝나면 대기가 생성 순으로 깨어난다. 하루 지출이 한도에 이르렀으면 깨어난 실행도 세션 없이
    // budget_exceeded(project_daily_budget_exceeded)로 끝나고, 그 종료가 다음 대기를 깨운다
    held.release();
    await engine.settled();
    const ends = [first, second, third].map((id) => detail(id)?.run);
    expect(ends.map((run) => run?.status)).toEqual([
      'budget_exceeded',
      'budget_exceeded',
      'budget_exceeded',
    ]);
    expect(ends.slice(1).map((run) => run?.failureReason)).toEqual([
      'project_daily_budget_exceeded',
      'project_daily_budget_exceeded',
    ]);
    expect(Date.parse(String(ends[1]?.startedAt))).toBeGreaterThanOrEqual(
      Date.parse(String(ends[0]?.endedAt)),
    );
    expect(Date.parse(String(ends[2]?.startedAt))).toBeGreaterThanOrEqual(
      Date.parse(String(ends[1]?.endedAt)),
    );
    // 깨어난 두 실행은 세션을 열지 않았다
    expect(held.budgets.filter((b) => b.role === 'test-writer')).toHaveLength(1);
  }, 120_000);

  it('규칙 작성 세션이 도는 동안 시작한 실행 세션은 그 세션의 한도만큼 덜 받는다 (실행 + 규칙 작성)', async () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const seeded = seedProject(biveHome, repo, {
      ...COMPLETE_SETTINGS,
      roles: {
        ...COMPLETE_SETTINGS.roles,
        'rule-writer': { model: 'test-model', maxBudgetUsd: 0.04, maxTurns: 20 },
      },
      dailyBudgetUsd: 0.1,
    });
    seedEnded(biveHome, seeded.project.id, 0.001);
    const held = holdingAdapter(biveHome, ['rule-writer']);
    const service = new RuleWriterService({ biveHome, adapter: held.adapter, now: Date.now });
    services.push(service);
    const engine = new PipelineEngine({
      biveHome,
      agent: held.adapter,
      executors: testExecutors(),
    });
    engines.push(engine);

    withProject(biveHome, seeded.project.id, (store) => {
      const requirement = store.requirements.create({
        id: engineId(),
        text: '겹침 시험 요구사항',
        author: human,
        normState: 'approved',
        createdAt: new Date().toISOString(),
      });
      return service.start(store, { projectId: seeded.project.id, requirement });
    });
    await waitFor(() => held.budgets.length === 1, '규칙 작성 세션');
    const runId = withProject(biveHome, seeded.project.id, (store) =>
      createRun(
        store,
        { ruleIds: [seeded.rule.id], author: human },
        { clientId: null },
        { now: Date.now, newId: engineId },
      ),
    ).run.id;
    expect(engine.evaluateApproval(seeded.project.id, runId)).toBe(true);
    await engine.settled();
    // 규칙 작성 0.04(진행 중), test-writer min(2, 5, 0.1 - 0.001 - 0.04) = 0.059 → 0.0421,
    // implementer 0.1 - 0.001 - 0.04 - 0.0421 = 0.0169
    expect(held.budgets).toEqual([
      { role: 'rule-writer', maxBudgetUsd: 0.04 },
      { role: 'test-writer', maxBudgetUsd: 0.059 },
      { role: 'implementer', maxBudgetUsd: 0.0169 },
    ]);
    held.release();
    await service.idle();
  }, 120_000);

  it('진행 중 세션이 끝나 실제 값이 확정되면 덜 쓴 만큼이 다시 잔여가 된다', async () => {
    const h = await startProjectHarness({ servers, clients });
    const now = local(2026, 11, 21, 12);
    const id = ulid();
    const remaining = () =>
      h.read((store) => projectDailyBudget(store, { dailyBudgetUsd: 0.1 }, now)?.remaining);
    h.read((store) => {
      const requirementId = seedRequirement(store, now - 2000);
      seedSession(store, requirementId, now - 1000, 0.001);
      store.sessions.start({
        id,
        runId: null,
        stepId: null,
        requirementId,
        role: 'rule-writer',
        model: 'test-model',
        workDir: '/work/session',
        budget: { maxBudgetUsd: 0.05, maxTurns: 20 },
        startedAt: iso(now - 500),
      });
    });
    expect(remaining()).toBe(0.049);
    h.read((store) => {
      store.sessions.recordInit(id, { sdkSessionId: 'sdk', tools: [], mcpServers: [] });
      store.sessions.end(id, {
        endReason: 'success',
        totalCostUsd: 0.02,
        numTurns: 2,
        endedAt: iso(now),
      });
    });
    expect(remaining()).toBe(0.079);
  });

  it('규칙 작성 세션의 행을 저장하지 못하면 세션을 열지 않고 시작 실패로 남긴다 (하루 합산의 원천이 없으므로)', async () => {
    const h = await startRuleWriter();
    await saveSettings(h, RULE_WRITER_PATCH(1));
    h.read((store) =>
      store.db.exec(`CREATE TRIGGER test_block_sessions BEFORE INSERT ON sessions
        BEGIN SELECT RAISE(ABORT, '시험: 세션 행 저장 거부'); END;`),
    );
    expect(await writeRequirement(h, '행 저장 실패 요구사항')).toMatchObject({
      state: 'skipped',
      skipReason: 'start_failed',
      error: '세션 기록 저장 실패로 세션을 열지 않음',
    });
    expect(h.specs).toHaveLength(0);
  });
});
