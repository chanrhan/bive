// 대상 블록으로 관련 규범만 고르는 규범 입력 (M3-29 #231, NRM-09 · RUN-04 · NFR-02, ADR-100 K1 · A15, ADR-140).
// - 블록 선언이 있고 기준 규칙(작업 대상 규칙)이 모두 대상 블록을 가지면, 대상 블록과 이름이 겹치는 규칙 · 대상 블록이 없는 규칙 ·
//   작업 대상 규칙, 그 부모 요구사항 · 규칙이 없는 요구사항, 연결 계약만 싣는다. 블록 밖 규범은 싣지 않는다
// - 고른 범위가 상한을 넘으면 A15의 줄이기를 그 범위에 그대로 쓴다. 블록 밖으로 뺀 수와 상한으로 뺀 수가 세션 기록에 따로 남는다
// - 블록 선언이 없거나 기준을 정할 수 없으면(규칙 작성 세션, 대상 블록이 빈 대상 규칙) 지금처럼 효력 있는 규범 전체(상한 안)
// - 모든 역할 세션(규칙 작성 · 요구사항 재판단 · 테스트 작성 · 구현 · 이의 판단)에서 실제 세션 서비스가 가짜 에이전트에 넘긴 작업
//   지시와 저장된 세션 기록으로 확인한다. 검사 실패 판단 세션과 검사 단계(최종 방어선)는 `check-regression.test.ts`가 본다
// 실제 SQLite · 실제 git · ScriptedAdapter. 판정 · 의존성 설치만 주입한다(test/helpers/pipeline-harness.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type BlockDeclaration,
  type Contract,
  type Requirement,
  type RoleSettings,
  type Rule,
  type RunLimits,
  SessionNormInput,
} from '@bive/shared';
import { openProjectStore, type ProjectStore, registerProject } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import type { AgentAdapter, SessionSpec } from '../src/agent/adapter.js';
import { loadScenario, type Scenario, ScenarioSchema } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { retireAgentRule } from '../src/norms/agent-rule.js';
import { ensureBuiltinStructureRules } from '../src/norms/builtin-rules.js';
import { registerHumanContract } from '../src/norms/contract.js';
import {
  blockScopeOf,
  collectNormInput,
  NORM_INPUT_BEGIN,
  NORM_INPUT_END,
  NORM_INPUT_LIMITS,
  type NormInput,
  normInputRecord,
  normInputScopeLine,
  normInputSummaryText,
  renderNormInput,
} from '../src/norms/norm-input.js';
import { RuleWriterService } from '../src/rule-writer/rule-writer-service.js';
import { AutoStarter } from '../src/runs/auto-start.js';
import { initAcceptanceRepo } from './helpers/acceptance-commit.js';
import {
  human,
  newId,
  seedNormRequirement,
  seedNormRule,
  T0,
  withProject,
} from './helpers/engine-harness.js';
import { type PipelineHarness, runToEnd, setupPipeline } from './helpers/pipeline-harness.js';
import { cleanup, makeBiveHome, REPO_ROOT } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];
const services: RuleWriterService[] = [];
const stores: ProjectStore[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) store.close();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-norm-input-'));
  temps.push(dir);
  return dir;
};

/** 예제 블록 선언 (auth · health · lib). */
const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'blocks', 'sample-next-app.json'), 'utf8'),
) as BlockDeclaration;

/** 판정 케이스 이름을 싣지 않는 대조 (이 시험의 고르기와 무관). */
const NO_CASES = { isKnownCase: () => false };

const at = (offset: number): string => new Date(T0 + offset).toISOString();

/** 등록된 프로젝트의 쓰기 저장소 (프로젝트 폴더는 빈 git 저장소). */
const openStore = (): { store: ProjectStore; biveHome: string; projectId: string } => {
  const biveHome = makeBiveHome();
  const project = registerProject(
    {
      id: newId(),
      name: '샘플 앱',
      rootPath: initAcceptanceRepo(tempDir()),
      baseBranch: 'main',
      createdAt: at(0),
    },
    { home: biveHome },
  );
  const store = openProjectStore(project.id, { home: biveHome, create: false });
  stores.push(store);
  return { store, biveHome, projectId: project.id };
};

/** 선언 저장 + 내장 구조 규칙 (사람의 `blocks.set` 처리기와 같은 트랜잭션). 만든 내장 규칙을 돌려준다. */
const declare = (store: ProjectStore, offset = 50): Rule[] =>
  store.transaction(() => {
    const record = store.blockDeclarations.set(SAMPLE, { at: at(offset), by: human });
    ensureBuiltinStructureRules(store, { declaration: record, at: at(offset), newId });
    return store.rules.list().filter((rule) => rule.builtin);
  });

const rule = (
  store: ProjectStore,
  parent: Requirement | null,
  targetBlocks: readonly string[],
  offset: number,
  title: string,
  over: Partial<Parameters<typeof seedNormRule>[1]> = {},
): Rule =>
  seedNormRule(store, {
    title,
    statement: `WHEN 요청이 오면 THE SYSTEM SHALL ${title}을 지킨다`,
    parent,
    at: T0 + offset,
    targetBlocks,
    ...over,
  });

/** 고르기 시험의 규범 (선언이 있는 프로젝트). 이름은 무엇을 확인하는지 나타낸다. */
interface World {
  /** 작업 대상 규칙: 대상 블록 health */
  readonly target: Rule;
  readonly targetReq: Requirement;
  /** 블록 밖 (auth) 규칙과 그 부모 */
  readonly auth: Rule;
  readonly authReq: Requirement;
  /** health 규칙이 자식으로 있어 함께 들어오는 auth 요구사항의 health 자식 */
  readonly authReqHealthChild: Rule;
  /** 부분 겹침 없음 (auth · lib) */
  readonly authLib: Rule;
  readonly authLibReq: Requirement;
  /** 부분 겹침 (lib · health) */
  readonly libHealth: Rule;
  readonly libHealthReq: Requirement;
  /** 선언에 없는 이름 (billing) */
  readonly undeclared: Rule;
  readonly undeclaredReq: Requirement;
  /** 대상 블록이 빈 옛 규칙 */
  readonly legacy: Rule;
  readonly legacyReq: Requirement;
  /** 규칙이 없는 요구사항 */
  readonly lonelyReq: Requirement;
  /** 부모가 지워진 health · auth 규칙 */
  readonly detachedHealth: Rule;
  readonly detachedAuth: Rule;
  /** 효력 없음: 잠정 · 폐기 (health) */
  readonly provisional: Rule;
  readonly retired: Rule;
  /** 내장 구조 규칙 (대상 블록 빈 목록) */
  readonly builtins: readonly Rule[];
  /** 계약 검사 규칙 (부모 요구사항이 블록 밖 auth·lib 요구사항인 계약) */
  readonly contractRule: Rule;
}

const RETIRE_STATEMENT = 'WHEN 요청이 오면 THE SYSTEM SHALL 폐기될규칙만의고유조각문장을 담는다';
const RETIRE_GROUNDS = '진술 "폐기될규칙만의고유조각문장"은 더는 맞지 않아 효력을 가지면 안 된다';

const seedWorld = (store: ProjectStore, options: { declared: boolean }): World => {
  const builtins = options.declared ? declare(store) : [];
  const targetReq = seedNormRequirement(store, '헬스 체크 응답에 서버 시각 포함', T0 + 100);
  const target = rule(store, targetReq, ['health'], 110, '서버 시각');
  const authReq = seedNormRequirement(store, '로그인 세션 확인', T0 + 120);
  const auth = rule(store, authReq, ['auth'], 130, '세션 쿠키');
  const authReqHealthChild = rule(store, authReq, ['health'], 135, '세션 없는 헬스 체크');
  const authLibReq = seedNormRequirement(store, '로그인 저장소 읽기', T0 + 140);
  const authLib = rule(store, authLibReq, ['auth', 'lib'], 150, '세션 저장소');
  const libHealthReq = seedNormRequirement(store, '헬스 체크의 DB 확인', T0 + 160);
  const libHealth = rule(store, libHealthReq, ['lib', 'health'], 170, 'DB 연결 확인');
  const undeclaredReq = seedNormRequirement(store, '결제 영수증', T0 + 180);
  const undeclared = rule(store, undeclaredReq, ['billing'], 190, '영수증 번호');
  const legacyReq = seedNormRequirement(store, '옛 요구사항', T0 + 200);
  const legacy = rule(store, legacyReq, [], 210, '옛 규칙');
  const lonelyReq = seedNormRequirement(store, '아직 규칙이 없는 요구사항', T0 + 220);
  seedNormRequirement(store, '잠정 요구사항', T0 + 230, 'provisional');
  const goneReq = seedNormRequirement(store, '지워질 요구사항', T0 + 240);
  const detachedHealth = rule(store, goneReq, ['health'], 250, '부모 해제 헬스');
  const detachedAuth = rule(store, goneReq, ['auth'], 255, '부모 해제 인증');
  store.requirements.softDelete(goneReq.id, { by: human, at: at(260) });
  store.rules.detachFromParent(goneReq.id, at(260));
  const provisional = rule(store, targetReq, ['health'], 270, '잠정 헬스', {
    normState: 'provisional',
  });
  const retired = rule(store, targetReq, ['health'], 280, '폐기될 헬스', {
    statement: RETIRE_STATEMENT,
  });
  retireAgentRule(
    store,
    {
      ruleId: retired.id,
      grounds: RETIRE_GROUNDS,
      author: { kind: 'agent', role: 'rule-writer' },
      sessionId: newId(),
    },
    { now: () => T0 + 290 },
  );
  const registered = registerHumanContract(store, {
    file: 'openapi.yaml',
    kind: 'openapi',
    source: { commit: 'a'.repeat(40), contentHash: 'b'.repeat(64) },
    requirementId: authLibReq.id,
    at: at(300),
    newId,
    by: human,
    clientId: null,
  });
  return {
    target,
    targetReq,
    auth,
    authReq,
    authReqHealthChild,
    authLib,
    authLibReq,
    libHealth,
    libHealthReq,
    undeclared,
    undeclaredReq,
    legacy,
    legacyReq,
    lonelyReq,
    detachedHealth,
    detachedAuth,
    provisional,
    retired,
    builtins,
    contractRule: registered.rule,
  };
};

const ids = (items: readonly { displayId: string }[]): string[] =>
  items.map((item) => item.displayId);
const sortIds = (values: readonly string[]): string[] =>
  [...values].sort((a, b) => (a.length === b.length ? a.localeCompare(b) : a.length - b.length));

/** 자료 블록의 줄 (시작 · 끝 표시 줄 사이). */
const dataLines = (text: string): string[] => {
  const lines = text.split('\n');
  const begin = lines.indexOf(NORM_INPUT_BEGIN);
  const end = lines.indexOf(NORM_INPUT_END);
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return lines.slice(begin + 1, end);
};

/** 자료에 실린 항목 머리 줄의 표시 ID (`- RULE-001 (…)` → `RULE-001`). */
const listedIds = (text: string, prefix: 'REQ' | 'RULE' | 'CON'): string[] =>
  dataLines(text).flatMap((line) => {
    const match = new RegExp(`^- (${prefix}-\\d+)`, 'u').exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });

// ── 고르는 규칙 (수용 기준 1) ─────────────────────────────────

describe('고르는 규칙: 대상 블록과 겹치는 규칙 · 그 부모 요구사항 · 연결 계약만 싣는다 (수용 기준 1, ADR-100 K1)', () => {
  it('여러 블록 · 부분 겹침 · 선언 외 이름 · 대상 블록 없는 규칙 · 내장 규칙 · 부모 해제 · 잠정 · 폐기: 겹치는 것과 모르는 것만 남고 블록 밖 규칙과 그 부모가 빠진다', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    const input = collectNormInput(store, { requirementIds: [], ruleIds: [w.target.id] }, NO_CASES);

    const expectedRules = sortIds([
      ...ids(w.builtins),
      w.target.displayId,
      w.authReqHealthChild.displayId,
      w.libHealth.displayId,
      w.legacy.displayId,
      w.detachedHealth.displayId,
      w.contractRule.displayId,
    ]);
    expect(ids(input.rules)).toEqual(expectedRules);
    // 블록 밖: auth 하나 · auth와 lib(health 없음) · 선언에 없는 billing · 부모 해제된 auth
    for (const out of [w.auth, w.authLib, w.undeclared, w.detachedAuth]) {
      expect(ids(input.rules)).not.toContain(out.displayId);
    }
    // 요구사항: 대상의 부모, health 자식이 있는 auth 요구사항, 부분 겹침 · 옛 규칙의 부모, 규칙이 없는 요구사항
    expect(ids(input.requirements)).toEqual(
      ids([w.targetReq, w.authReq, w.libHealthReq, w.legacyReq, w.lonelyReq]),
    );
    // 블록 밖 규칙만 있는 요구사항은 빠진다
    expect(ids(input.requirements)).not.toContain(w.authLibReq.displayId);
    expect(ids(input.requirements)).not.toContain(w.undeclaredReq.displayId);
    // 연결 계약: 검사 규칙(대상 블록 없음)이 남으므로 부모 요구사항이 블록 밖이어도 계약이 남는다
    expect(ids(input.contracts ?? [])).toEqual(['CON-001']);

    // 수: 전체는 효력 있는 전부, 블록 밖과 상한은 따로 (상한 안이라 잘림 없음)
    expect(input.summary).toEqual({
      requirements: { total: 7, included: 5, omitted: 0, outOfBlock: 2 },
      rules: {
        total: expectedRules.length + 4,
        included: expectedRules.length,
        omitted: 0,
        outOfBlock: 4,
      },
      contracts: { total: 1, included: 1, omitted: 0, outOfBlock: 0 },
      truncated: false,
      blocks: ['health'],
    });

    // 작업 지시: 범위 문장 · 머리말이 고른 사실을 밝히고, 블록 밖 글이 없다
    const text = renderNormInput(input, '이번 작업 대상');
    const lines = dataLines(text);
    expect(lines[0]).toBe(normInputScopeLine(['health']));
    expect(lines[0]).toBe(
      '고른 범위: 대상 블록(health)과 겹치거나 대상 블록이 없는 규칙과 작업 대상 규칙, 그 부모 요구사항 · 규칙이 없는 요구사항 · 작업 대상 요구사항, 연결 계약만 실음. 블록 밖 규범은 싣지 않았고, 검사 단계는 효력 있는 규칙 전체를 판정한다',
    );
    expect(lines[1]).toBe('요구사항 (효력 7건 중 대상 블록 관련 5건, 블록 밖 2건 뺌)');
    expect(lines).toContain(
      `규칙 (효력 ${String(expectedRules.length + 4)}건 중 대상 블록 관련 ${String(expectedRules.length)}건, 블록 밖 4건 뺌)`,
    );
    expect(lines).toContain('계약 (효력 1건 중 대상 블록 관련 1건, 블록 밖 0건 뺌)');
    expect(listedIds(text, 'RULE')).toEqual(expectedRules);
    expect(listedIds(text, 'REQ')).toEqual(ids(input.requirements));
    for (const absent of [
      '세션 쿠키',
      '세션 저장소',
      '영수증 번호',
      '부모 해제 인증',
      '결제 영수증',
    ]) {
      expect(text).not.toContain(absent);
    }
    // 대상과 부모에는 초점 표시가 그대로 붙는다
    expect(lines).toContain(`- ${w.target.displayId} (이번 작업 대상)`);
    expect(lines).toContain(`- ${w.targetReq.displayId} (이번 작업 대상)`);
    // 블록 선언 절은 그대로 실린다 (끝 표시 줄 앞)
    expect(lines.some((line) => line.startsWith('블록 선언 (판 1, 블록 3개'))).toBe(true);

    // 세션 기록: 같은 수와 기준 블록, shared 스키마를 지난다
    const record = normInputRecord(input);
    expect(SessionNormInput.parse(record)).toEqual(record);
    expect(record).toEqual({
      summary: input.summary,
      requirementDisplayIds: ids(input.requirements),
      ruleDisplayIds: expectedRules,
      contractDisplayIds: ['CON-001'],
    });
    // 로그 한 줄도 블록 밖 수를 적는다
    expect(normInputSummaryText(input.summary)).toBe(
      `요구사항 7건 중 5건 (블록 밖 2건), 규칙 ${String(expectedRules.length + 4)}건 중 ${String(expectedRules.length)}건 (블록 밖 4건)`,
    );
  });

  it('기준 규칙의 대상 블록이 선언에 없는 이름이어도 이름 그대로 겹침을 본다 (billing 기준이면 billing 규칙만, health는 빠진다)', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    const input = collectNormInput(
      store,
      { requirementIds: [], ruleIds: [w.undeclared.id] },
      NO_CASES,
    );
    expect(ids(input.rules)).toEqual(
      sortIds([
        ...ids(w.builtins),
        w.undeclared.displayId,
        w.legacy.displayId,
        w.contractRule.displayId,
      ]),
    );
    expect(input.summary.blocks).toEqual(['billing']);
  });

  it('대상 규칙이 여럿이면 기준 블록은 합집합이고(처음 나온 순서) 대상 규칙 자신은 늘 들어간다', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    const input = collectNormInput(
      store,
      { requirementIds: [], ruleIds: [w.auth.id, w.target.id] },
      NO_CASES,
    );
    expect(input.summary.blocks).toEqual(['auth', 'health']);
    // auth · health 어느 쪽과 겹쳐도 들어오고, billing만 빠진다
    expect(ids(input.rules)).toContain(w.auth.displayId);
    expect(ids(input.rules)).toContain(w.authLib.displayId);
    expect(ids(input.rules)).toContain(w.detachedAuth.displayId);
    expect(ids(input.rules)).not.toContain(w.undeclared.displayId);
    expect(input.summary.rules.outOfBlock).toBe(1);
    expect(ids(input.requirements)).toContain(w.authLibReq.displayId);
    expect(ids(input.requirements)).not.toContain(w.undeclaredReq.displayId);
  });

  it('기준에 더한 규칙(이의 판단의 실행 대상)은 고르는 기준이 되고 늘 들어가지만 초점 표시는 받지 않는다', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    // 초점 = 블록 밖 auth 규칙, 기준에 더함 = health 대상 규칙
    const input = collectNormInput(
      store,
      { requirementIds: [], ruleIds: [w.auth.id] },
      { ...NO_CASES, blockBasisRuleIds: [w.target.id] },
    );
    expect(input.summary.blocks).toEqual(['auth', 'health']);
    const shown = new Map(input.rules.map((entry) => [entry.displayId, entry.focus]));
    expect(shown.get(w.auth.displayId)).toBe(true);
    expect(shown.get(w.target.displayId)).toBe(false);
    expect(shown.has(w.libHealth.displayId)).toBe(true);
    // 더하지 않으면 health 쪽 규칙과 대상 규칙이 빠진다 (대조)
    const without = collectNormInput(store, { requirementIds: [], ruleIds: [w.auth.id] }, NO_CASES);
    expect(ids(without.rules)).not.toContain(w.target.displayId);
    expect(ids(without.rules)).not.toContain(w.libHealth.displayId);
  });
});

// ── 상한과 줄이는 규칙 (수용 기준 2) ─────────────────────────────

describe('blockScopeOf: 연결 계약 · 요구사항의 범위 (검사 규칙에 대상 블록이 있는 경우까지, ADR-140)', () => {
  // 지금 계약 검사 규칙은 늘 대상 블록이 비어 함께 들어온다. 검사 규칙에 대상 블록이 생겨도 계약이 맞게 골라지는지 고르는 함수로 본다
  const req = (id: string) => ({ id }) as unknown as Requirement;
  const ruleOf = (
    id: string,
    targetBlockIds: string[],
    parentRequirementId: string | null,
    contractId: string | null = null,
  ) => ({ id, targetBlockIds, parentRequirementId, contractId }) as unknown as Rule;
  const contractOf = (id: string, parentRequirementId: string | null) =>
    ({ id, parentRequirementId }) as unknown as Contract;
  const rules = [
    ruleOf('target', ['health'], 'r-health'),
    ruleOf('auth', ['auth'], 'r-auth'),
    ruleOf('check-in', ['health'], null, 'c-check-in'),
    ruleOf('check-out', ['auth'], null, 'c-check-out'),
    ruleOf('check-out-2', ['auth'], null, 'c-parent-in'),
    ruleOf('check-out-3', ['auth'], null, 'c-parent-out'),
  ];
  const scope = blockScopeOf(
    true,
    ['target'],
    new Set(['r-health']),
    (id) => rules.find((item) => item.id === id) ?? null,
    [req('r-health'), req('r-auth'), req('r-none')],
    rules,
    [
      contractOf('c-check-in', null),
      contractOf('c-check-out', null),
      contractOf('c-parent-in', 'r-health'),
      contractOf('c-parent-out', 'r-auth'),
      contractOf('c-loose', null),
      contractOf('c-loose-parent-in', 'r-none'),
      contractOf('c-loose-parent-out', 'r-auth'),
    ],
  );

  it('계약: 검사 규칙이 고른 규칙이거나, 부모 요구사항이 고른 요구사항이거나, 검사 규칙도 부모도 없으면 넣고 나머지는 뺀다', () => {
    expect([...(scope?.contractIds ?? [])]).toEqual([
      'c-check-in',
      'c-parent-in',
      'c-loose',
      'c-loose-parent-in',
    ]);
  });

  it('요구사항: 초점 · 고른 규칙의 부모 · 효력 있는 자식 규칙이 없는 요구사항만 (블록 밖 규칙만 있는 요구사항은 뺀다)', () => {
    expect([...(scope?.requirementIds ?? [])]).toEqual(['r-health', 'r-none']);
    expect([...(scope?.ruleIds ?? [])]).toEqual(['target', 'check-in']);
  });
});

describe('고른 범위가 상한을 넘으면 A15의 줄이기를 그 범위에 쓰고 잘린 수 · 블록 밖 수를 따로 남긴다 (수용 기준 2, ADR-100 A15)', () => {
  it('health 규칙 55개 + 가장 최근의 auth 규칙 5개: 먼저 고르고(auth 5개 뺌) 그다음 최근 변경 순으로 50개를 남긴다', () => {
    const { store } = openStore();
    store.blockDeclarations.set(SAMPLE, { at: at(0), by: human });
    const targetReq = seedNormRequirement(store, '헬스 체크 응답에 서버 시각 포함', T0 + 1);
    const target = rule(store, targetReq, ['health'], 2, '대상 규칙');
    const healthReq = seedNormRequirement(store, '헬스 체크의 여러 규칙', T0 + 3);
    const health = Array.from({ length: 55 }, (_, i) =>
      rule(store, healthReq, ['health'], 10 + i, `헬스 규칙 ${String(i)}`),
    );
    const authReq = seedNormRequirement(store, '로그인', T0 + 4);
    const auth = Array.from({ length: 5 }, (_, i) =>
      rule(store, authReq, ['auth'], 1000 + i, `인증 규칙 ${String(i)}`),
    );
    const input = collectNormInput(store, { requirementIds: [], ruleIds: [target.id] }, NO_CASES);
    // 대상 규칙 + 최근 health 49개 (가장 오래된 health 6개가 상한으로 빠진다). auth는 최근이어도 블록 밖이라 없다
    expect(ids(input.rules)).toEqual([target.displayId, ...ids(health.slice(6))]);
    for (const out of auth) expect(ids(input.rules)).not.toContain(out.displayId);
    expect(input.summary.rules).toEqual({ total: 61, included: 50, omitted: 6, outOfBlock: 5 });
    expect(input.summary.requirements).toEqual({
      total: 3,
      included: 2,
      omitted: 0,
      outOfBlock: 1,
    });
    expect(input.summary.truncated).toBe(true);
    const text = renderNormInput(input, '이번 작업 대상');
    expect(dataLines(text)).toContain(
      `규칙 (효력 61건 중 대상 블록 관련 56건, 블록 밖 5건 뺌, 그중 50건만 실음, 6건 빠짐: 상한 ${String(NORM_INPUT_LIMITS.rules)}건, 대상과 같은 부모의 항목을 먼저 넣고 나머지는 최근 변경 순)`,
    );
    const record = normInputRecord(input);
    expect(SessionNormInput.parse(record).summary).toEqual({
      requirements: { total: 3, included: 2, omitted: 0, outOfBlock: 1 },
      rules: { total: 61, included: 50, omitted: 6, outOfBlock: 5 },
      truncated: true,
      blocks: ['health'],
    });
    expect(normInputSummaryText(input.summary)).toBe(
      '요구사항 3건 중 2건 (블록 밖 1건), 규칙 61건 중 50건 (6건 빠짐, 블록 밖 5건)',
    );
  });

  it('고른 범위가 상한 안이면 잘림이 아니다 (블록 밖으로 뺀 것은 잘림으로 세지 않는다)', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    const input = collectNormInput(store, { requirementIds: [], ruleIds: [w.target.id] }, NO_CASES);
    expect(input.summary.truncated).toBe(false);
    expect(renderNormInput(input, '대상')).not.toContain('빠짐');
  });

  it('세션 기록 스키마: 전체 = 실은 것 + 빠진 것 + 블록 밖, 블록 밖 수는 기준 블록이 있을 때만 (어긋난 기록은 받지 않는다)', () => {
    const base = {
      summary: {
        requirements: { total: 3, included: 1, omitted: 0, outOfBlock: 2 },
        rules: { total: 2, included: 1, omitted: 0, outOfBlock: 1 },
        truncated: false,
        blocks: ['health'],
      },
      requirementDisplayIds: ['REQ-001'],
      ruleDisplayIds: ['RULE-001'],
    };
    expect(SessionNormInput.safeParse(base).success).toBe(true);
    const broken = [
      // 블록 밖 수가 합에 맞지 않음
      {
        ...base,
        summary: { ...base.summary, rules: { total: 3, included: 1, omitted: 0, outOfBlock: 1 } },
      },
      // 기준 블록 없이 블록 밖 수
      { ...base, summary: { ...base.summary, blocks: undefined } },
      // 기준 블록이 있는데 블록 밖 수가 없음
      {
        ...base,
        summary: { ...base.summary, rules: { total: 1, included: 1, omitted: 0 } },
      },
      // 빈 기준 블록 · 블록 이름 형식 위반
      { ...base, summary: { ...base.summary, blocks: [] } },
      { ...base, summary: { ...base.summary, blocks: ['Health'] } },
      // 블록 밖은 잘림이 아니다
      { ...base, summary: { ...base.summary, truncated: true } },
    ];
    for (const value of broken) {
      expect(SessionNormInput.safeParse(JSON.parse(JSON.stringify(value))).success).toBe(false);
    }
  });
});

// ── 선언이 없을 때 · 기준을 정할 수 없을 때 (수용 기준 3) ─────────────────

describe('블록 선언이 없거나 기준 규칙에 대상 블록이 없으면 지금처럼 효력 있는 규범 전체 (수용 기준 3)', () => {
  /** 고르지 않은 입력: 효력 있는 전부, 블록 밖 수 · 기준 블록 · 범위 문장 없음. */
  const expectWhole = (store: ProjectStore, input: NormInput): void => {
    const effectiveRuleCount = store.rules
      .list()
      .filter(
        (item) =>
          item.deletedAt === null &&
          item.normState === 'approved' &&
          !store.ruleRetirements.retiredRuleIds().has(item.id),
      ).length;
    expect(input.summary.rules).toEqual({
      total: effectiveRuleCount,
      included: effectiveRuleCount,
      omitted: 0,
    });
    expect(input.summary.requirements).toEqual({ total: 7, included: 7, omitted: 0 });
    expect('blocks' in input.summary).toBe(false);
    const text = renderNormInput(input, '이번 작업 대상');
    expect(text).not.toContain('고른 범위');
    expect(text).not.toContain('대상 블록 관련');
    expect(dataLines(text)[0]).toBe('요구사항 (효력 7건 중 7건)');
    const record = normInputRecord(input);
    expect(Object.keys(record.summary)).toEqual([
      'requirements',
      'rules',
      'contracts',
      'truncated',
    ]);
    expect(Object.keys(record.summary.rules)).toEqual(['total', 'included', 'omitted']);
  };

  it('선언이 없으면 규칙에 대상 블록이 있어도 고르지 않는다', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: false });
    expectWhole(
      store,
      collectNormInput(store, { requirementIds: [], ruleIds: [w.target.id] }, NO_CASES),
    );
  });

  it('선언이 있어도 대상 규칙이 대상 블록 빈 목록이면, 또는 대상 규칙 가운데 하나라도 비었으면 전체', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    expectWhole(
      store,
      collectNormInput(store, { requirementIds: [], ruleIds: [w.legacy.id] }, NO_CASES),
    );
    expectWhole(
      store,
      collectNormInput(
        store,
        { requirementIds: [], ruleIds: [w.target.id, w.legacy.id] },
        NO_CASES,
      ),
    );
    // 기준에 더한 규칙이 비어도 전체
    expectWhole(
      store,
      collectNormInput(
        store,
        { requirementIds: [], ruleIds: [w.target.id] },
        { ...NO_CASES, blockBasisRuleIds: [w.legacy.id] },
      ),
    );
  });

  it('대상 규칙이 없으면(규칙 작성 세션: 요구사항만 초점) 선언이 있어도 전체', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    expectWhole(
      store,
      collectNormInput(store, { requirementIds: [w.targetReq.id], ruleIds: [] }, NO_CASES),
    );
  });

  it('없는 규칙 ID가 기준이면 전체 (모르는 기준으로 빼지 않는다)', () => {
    const { store } = openStore();
    const w = seedWorld(store, { declared: true });
    expectWhole(
      store,
      collectNormInput(store, { requirementIds: [], ruleIds: [w.target.id, newId()] }, NO_CASES),
    );
  });
});

// ── 모든 역할 세션 (수용 기준 1 · 3) ──────────────────────────────

const RULE_WRITER_SETTINGS: RoleSettings = { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 };
const RUN_LIMITS: RunLimits = { maxBudgetUsd: 5, maxTurns: 200 };
const SCENARIO_RESULT = {
  subtype: 'success',
  total_cost_usd: 0.01,
  num_turns: 1,
  modelUsage: {
    'model-a': {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.01,
    },
  },
} as const;

/** 규칙 작성 역할 세션 두 개(새 요구사항 · 재판단)가 메시지만 남기고 끝나는 시나리오. */
const quietRuleWriter = (): Scenario =>
  ScenarioSchema.parse({
    name: 'norm-input-quiet',
    description: '규범 입력 시험',
    roles: {
      'rule-writer': {
        sessions: [
          { turns: [{ message: '끝' }], result: SCENARIO_RESULT },
          { turns: [{ message: '끝' }], result: SCENARIO_RESULT },
        ],
      },
    },
  });

describe('규칙 작성 역할의 세션: 새 요구사항은 전체, 요구사항 재판단은 자식 규칙의 대상 블록으로 고른다 (실제 규칙 작성 서비스)', () => {
  const startService = (biveHome: string, specs: SessionSpec[]): RuleWriterService => {
    const scripted = new ScriptedAdapter({
      scenario: quietRuleWriter(),
      biveHome,
      pollIntervalMs: 10,
    });
    const adapter: AgentAdapter = {
      kind: 'scripted',
      startSession: (spec) => {
        specs.push(spec);
        return scripted.startSession(spec);
      },
    };
    const service = new RuleWriterService({ biveHome, adapter });
    services.push(service);
    return service;
  };

  it('새 요구사항의 규칙 작성 세션은 기준 규칙이 없어 선언이 있어도 효력 있는 규범 전체를 받고, 재판단 세션은 health 자식 규칙 기준으로 고른 범위를 받는다', async () => {
    const { store, biveHome, projectId } = openStore();
    store.settings.update(
      { run: RUN_LIMITS, roles: { 'rule-writer': RULE_WRITER_SETTINGS } },
      { by: human, at: at(0) },
    );
    const w = seedWorld(store, { declared: true });
    const specs: SessionSpec[] = [];
    const service = startService(biveHome, specs);

    // 1. 새 요구사항 (규칙 없음): 전체
    const fresh = seedNormRequirement(store, '새로 저장한 요구사항', T0 + 400);
    expect(service.start(store, { projectId, requirement: fresh }).status).toBe('queued');
    await service.whenSettled(projectId, fresh.id);
    const freshPrompt = specs[0]?.prompt ?? '';
    expect(freshPrompt).not.toContain('고른 범위');
    expect(listedIds(freshPrompt, 'RULE')).toContain(w.auth.displayId);
    expect(listedIds(freshPrompt, 'RULE')).toContain(w.undeclared.displayId);
    expect(listedIds(freshPrompt, 'REQ')).toContain(w.authLibReq.displayId);

    // 2. 대상 요구사항을 고침 → 자식 규칙(health 대상 규칙 · 폐기 · 잠정 제외)의 재판단: health로 고른다
    const updated = store.requirements.update(
      w.targetReq.id,
      { text: '헬스 체크 응답에 서버 시각과 지역 포함' },
      { by: human, at: at(500) },
    );
    expect(
      service.rejudge(store, {
        projectId,
        requirement: updated,
        change: 'updated',
        previousText: w.targetReq.text,
      })?.status,
    ).toBe('queued');
    await service.whenSettled(projectId, updated.id);
    const rejudgePrompt = specs[1]?.prompt ?? '';
    expect(dataLines(rejudgePrompt)[0]).toBe(normInputScopeLine(['health']));
    expect(listedIds(rejudgePrompt, 'RULE')).toContain(w.target.displayId);
    expect(listedIds(rejudgePrompt, 'RULE')).toContain(w.libHealth.displayId);
    for (const out of [w.auth, w.authLib, w.undeclared, w.detachedAuth]) {
      expect(listedIds(rejudgePrompt, 'RULE')).not.toContain(out.displayId);
    }
    expect(listedIds(rejudgePrompt, 'REQ')).not.toContain(w.authLibReq.displayId);

    // 세션 기록 (저장): 새 요구사항은 옛 모양, 재판단은 기준 블록 · 블록 밖 수
    const [freshSession] = store.sessions.listByRequirement(fresh.id);
    const [rejudgeSession] = store.sessions.listByRequirement(updated.id);
    expect(freshSession?.normInput?.summary).not.toHaveProperty('blocks');
    expect(freshSession?.normInput?.summary.rules).not.toHaveProperty('outOfBlock');
    expect(rejudgeSession?.normInput?.summary).toMatchObject({
      blocks: ['health'],
      rules: { outOfBlock: 4 },
      requirements: { outOfBlock: 2 },
      truncated: false,
    });
    expect(rejudgeSession?.normInput?.ruleDisplayIds).not.toContain(w.auth.displayId);
  }, 60_000);
});

// ── 실행 안 세션: 테스트 작성 · 구현 · 이의 판단 ──────────────────────

/** 실행 하네스의 선언 · 내장 규칙과 대상 밖 규범 (RULE-001 = health 대상). */
const seedRun = (h: PipelineHarness) =>
  withProject(h.biveHome, h.project.id, (store) => {
    const builtins = declare(store, 1000);
    const authReq = seedNormRequirement(store, '로그인 세션 확인', T0 + 1100);
    const auth = rule(store, authReq, ['auth'], 1110, '세션 쿠키');
    const libHealth = rule(store, authReq, ['lib', 'health'], 1120, 'DB 연결 확인');
    const billingReq = seedNormRequirement(store, '결제 영수증', T0 + 1130);
    const billing = rule(store, billingReq, ['billing'], 1140, '영수증 번호');
    const legacy = rule(store, billingReq, [], 1150, '옛 규칙');
    return { builtins, authReq, auth, libHealth, billingReq, billing, legacy };
  });

const storedSessions = (h: PipelineHarness, runId = h.runId) =>
  withProject(h.biveHome, h.project.id, (store) => store.sessions.listByRun(runId));

describe('테스트 작성 · 구현 세션: 실행의 대상 규칙(health)으로 고른 규범을 받는다 (실제 실행기 · 엔진)', () => {
  it('두 세션의 작업 지시에 범위 문장이 있고 블록 밖(auth · billing) 규칙과 그 부모가 없으며, 세션 기록에 기준 블록과 블록 밖 수가 남는다', async () => {
    const h = setupPipeline({ seedTexts: { targetBlocks: ['health'] }, temps, engines });
    const s = seedRun(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged' });
    const expectedRules = sortIds([
      'RULE-001',
      ...ids(s.builtins),
      s.libHealth.displayId,
      s.legacy.displayId,
    ]);
    for (const role of ['test-writer', 'implementer'] as const) {
      const specs = h.sessions.filter((spec) => spec.role === role);
      expect(specs, role).toHaveLength(1);
      const prompt = specs[0]?.prompt ?? '';
      expect(dataLines(prompt)[0], role).toBe(normInputScopeLine(['health']));
      expect(listedIds(prompt, 'RULE'), role).toEqual(expectedRules);
      // 부모: 대상의 부모와 health 자식이 있는 auth 요구사항, 옛 규칙의 부모 (billing 규칙도 있지만 옛 규칙이 들어와 부모가 남는다)
      expect(listedIds(prompt, 'REQ'), role).toEqual(['REQ-001', 'REQ-002', 'REQ-003']);
      expect(prompt, role).not.toContain('세션 쿠키');
      expect(prompt, role).not.toContain('영수증 번호');
      const [session] = storedSessions(h).filter((item) => item.role === role);
      expect(session?.normInput, role).toEqual({
        summary: {
          requirements: { total: 3, included: 3, omitted: 0, outOfBlock: 0 },
          rules: {
            total: expectedRules.length + 2,
            included: expectedRules.length,
            omitted: 0,
            outOfBlock: 2,
          },
          truncated: false,
          blocks: ['health'],
        },
        requirementDisplayIds: ['REQ-001', 'REQ-002', 'REQ-003'],
        ruleDisplayIds: expectedRules,
      });
    }
  }, 120_000);
});

describe('이의 판단 세션: 이의 대상(블록 밖 auth)과 실행의 대상 규칙(health)을 기준으로 고른다 (실제 규칙 작성 서비스의 판단)', () => {
  /** `objection` 시나리오에서 구현 시도 1의 이의 대상만 바꾼다. */
  const objectionOn = (displayId: string): { scenario: string; scenariosDir: string } => {
    const scenario = structuredClone(loadScenario('objection'));
    scenario.name = 'norm-input-objection';
    const turn = scenario.roles.implementer?.sessions[0]?.turns.find(
      (item) => 'tool' in item && item.tool === 'raise_objection',
    );
    if (turn === undefined || !('tool' in turn)) throw new Error('이의 호출 없음');
    turn.args = { ...turn.args, ruleIds: [displayId] };
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'norm-input-objection.yaml'), stringify(scenario));
    return { scenario: 'norm-input-objection', scenariosDir: dir };
  };

  it('판단 세션의 규범 자료에 이의 대상 auth 규칙(초점)과 대상 규칙 RULE-001 · health 쪽 규칙이 있고, billing 규칙은 없다', async () => {
    // 시드 순서가 정해져 있어 auth 규칙의 표시 ID를 미리 안다 (RULE-001 대상, 내장 둘, 그다음 auth)
    const h = setupPipeline({
      seedTexts: { targetBlocks: ['health'] },
      ...objectionOn('RULE-004'),
      temps,
      engines,
      judgeNorms: ({ biveHome, adapter, engine }) => {
        const autoStarter = new AutoStarter({
          biveHome,
          engine: { onRunCreated: (projectId, runId) => engine().onRunCreated(projectId, runId) },
        });
        const service = new RuleWriterService({
          biveHome,
          adapter,
          onSessionEnded: (projectId, sessionId, endReason) => {
            autoStarter.afterRuleWriterSession(projectId, sessionId, endReason);
          },
        });
        services.push(service);
        return (request) => service.judge(request);
      },
    });
    const s = seedRun(h);
    expect(s.auth.displayId).toBe('RULE-004');
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 1 });
    const judges = h.sessions.filter((spec) => spec.role === 'rule-writer');
    expect(judges).toHaveLength(1);
    const prompt = judges[0]?.prompt ?? '';
    expect(dataLines(prompt)[0]).toBe(normInputScopeLine(['auth', 'health']));
    expect(listedIds(prompt, 'RULE')).toEqual(
      sortIds([
        'RULE-001',
        ...ids(s.builtins),
        s.auth.displayId,
        s.libHealth.displayId,
        s.legacy.displayId,
      ]),
    );
    expect(dataLines(prompt)).toContain(`- ${s.auth.displayId} (이번 작업 대상)`);
    expect(dataLines(prompt)).toContain('- RULE-001');
    expect(prompt).not.toContain('영수증 번호');
    // 판단 세션 행(판단을 청한 구현 시도에 묶임)의 기록
    const [judgeSession] = storedSessions(h).filter((item) => item.role === 'rule-writer');
    expect(judgeSession?.normInput?.summary).toMatchObject({
      blocks: ['auth', 'health'],
      rules: { outOfBlock: 1 },
    });
    // 같은 실행의 구현 세션은 health 기준 (auth 규칙 없음)
    const implementer = h.sessions.filter((spec) => spec.role === 'implementer');
    expect(implementer).toHaveLength(2);
    for (const spec of implementer) {
      expect(listedIds(spec.prompt, 'RULE')).not.toContain(s.auth.displayId);
    }
  }, 180_000);
});
