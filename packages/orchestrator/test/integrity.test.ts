// 무결성 시험 (M1-22 수용 기준 1 · 2 · 3, NFR-01 · NFR-02 · NFR-04 · ADR-024 · ADR-027 · ADR-052 · ADR-059 · ADR-075).
// - 도구 목록: 역할 목록의 원본(`AgentRole`)을 돌며 고정 도구 목록 · 실행기 · MCP `tools/list` · SDK `query()` 옵션과
//   실제 세션의 init 기록에 승인 · 잠정 승인 · 규범 쓰기 · 셸 도구가 없음을 단언한다
// - 승인 호출: `agent-approve` 시나리오의 모든 역할 세션이 `proposal.approve`를 부르고 `denied`(`unknown_tool`)로 거부된다.
//   제안은 `pending` 그대로, 그 제안 대상 승인 기록 0건
// - 작업 디렉터리: 세션이 도는 동안(결과 직전) 작업 디렉터리 실경로가 `$BIVE_HOME/projects` · `$BIVE_HOME/run` 밖이고
//   그 안에 그쪽을 가리키는 심볼릭 링크가 없다
// - 네트워크 감시 도구의 자체 점검 (실제 happy-path 실행 동안의 단언은 `e2e/pipeline/network.test.ts`, ADR-075)
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite · 실제 git · ScriptedAdapter(실제 고정 도구 · 경로 가드 · 세션 가드).
// 판정 · 의존성 설치만 주입한다(test/helpers/pipeline-harness.ts). 제한: 엔진 · git을 띄우는 테스트는 60초(ADR-064).
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { AgentRole, type EntityRef, METHOD_NAMES, type RoleSettings } from '@bive/shared';
import { bivePaths } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionSpec } from '../src/agent/adapter.js';
import { biveMcpToolList, buildQueryOptions } from '../src/agent/claude-sdk-adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { PipeServer } from '../src/ipc/server.js';
import { RuleWriterService } from '../src/rule-writer/rule-writer-service.js';
import {
  BIVE_MCP_SERVER,
  COMMAND_TOOL_NAMES,
  FILE_TOOL_NAMES,
  PROPOSAL_TOOL_NAMES,
  roleToolNames,
} from '../src/tools/definitions.js';
import { FixedToolExecutor } from '../src/tools/executor.js';
import { normalizeToolName, REQUIRED_PERMISSION_MODE } from '../src/tools/session-guard.js';
import type { TestClient } from './helpers/client.js';
import { human, withProject } from './helpers/engine-harness.js';
import {
  describeAttempt,
  installNetWatch,
  isExternalAttempt,
  type NetAttempt,
  NetWatchBlocked,
  type NetWatchRecord,
} from './helpers/net-watch.js';
import {
  hookAdapter,
  type PipelineHarness,
  runToEnd,
  setupPipeline,
  toolCallsOf,
} from './helpers/pipeline-harness.js';
import { cleanup } from './helpers/process.js';
import { type ProjectHarness, startProjectHarness } from './helpers/project-harness.js';

const SCENARIO = 'agent-approve';
const APPROVE_METHOD = 'proposal.approve';
/** 역할 목록의 원본. 역할이 늘면 시험이 따라간다 */
const ROLES = AgentRole.options;

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
}, 60_000);

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-integrity-'));
  temps.push(dir);
  return dir;
};

// ── 금지 도구 판별 ─────────────────────────────────────────

/**
 * 역할별 허용 도구 (리터럴 고정, ADR-075). 제품의 역할 도구 목록은 이것과 정확히 같아야 한다.
 * 도구가 늘거나 역할에 더해지면 이 표를 같이 고쳐야 하므로 검토를 거친다. 역할 목록 자체는 원본(`AgentRole`)에서
 * 가져오고, 이 표에 없는 역할이 생기면 시험이 실패한다.
 */
const EXPECTED_ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'rule-writer': ['propose_rule'],
  planner: [],
  'test-writer': ['read_file', 'write_file', 'list_files', 'search_files', 'run_tests'],
  implementer: [
    'read_file',
    'write_file',
    'list_files',
    'search_files',
    'run_tests',
    'prisma_generate',
    'prisma_migrate',
    'install_package',
  ],
  chat: [],
};

/** 고정 도구 전체 (리터럴 고정). 제품의 파일 · 명령 · 제안 도구 정의를 합친 목록과 정확히 같아야 한다 */
const FIXED_TOOLS: readonly string[] = [
  'read_file',
  'write_file',
  'list_files',
  'search_files',
  'run_tests',
  'prisma_generate',
  'prisma_migrate',
  'install_package',
  'propose_rule',
];

/** 규범 엔터티 낱말 (순서와 상관없이 쓰기 동사와 함께 나오면 규범 쓰기) */
const NORM_ENTITY =
  '(rule|requirement|contract|norm|block|adr|approval|proposal|judg|verdict|baseline)';
/** 쓰기 동사 */
const WRITE_VERB =
  '(create|update|delete|remove|write|set|edit|save|put|upsert|patch|insert|commit|apply|amend|merge|accept|confirm|finalize|publish|resolve|override)';

/**
 * 승인 · 잠정 승인 · 규범 쓰기 · 셸 도구로 볼 이름 (보조 검사, 주 검사는 위 리터럴 허용 목록).
 * - 승인 · 잠정 승인 낱말: approv · accept · confirm · grant · ratify · provisional
 * - 셸 · 실행 낱말: bash · shell · exec · spawn · terminal · command
 * - 규범 쓰기: 규범 엔터티 낱말과 쓰기 동사가 순서와 상관없이 함께 있음 (`update_rule` · `rule_update` 모두)
 * 규칙 제안(`propose_rule`)은 제안만 만든다(상태 `pending`)이라 걸리지 않아야 한다.
 */
const FORBIDDEN_TOOL = new RegExp(
  [
    'approv|accept|confirm|grant|ratify|provisional',
    'bash|shell|exec|spawn|terminal|command',
    `^(?=.*${NORM_ENTITY})(?=.*${WRITE_VERB})`,
  ].join('|'),
  'i',
);

/** SDK 내장 도구 중 셸 · 파일 쓰기 · 서브 에이전트 (`tools: []`로 모두 꺼져야 한다, ADR-059) */
const SDK_BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Task',
  'Agent',
];

/** 이름이 금지 도구인지: 패턴 · 파이프 RPC 이름 · SDK 내장 도구. */
const isForbiddenTool = (name: string): boolean =>
  FORBIDDEN_TOOL.test(name) ||
  (METHOD_NAMES as readonly string[]).includes(name) ||
  SDK_BUILTIN_TOOLS.includes(name);

/** 주 검사: 리터럴 허용 목록과 정확히 같음. 보조 검사: 금지 판별에 걸리는 이름 없음. */
const expectSafeTools = (role: AgentRole, names: readonly string[]): void => {
  expect([...names], role).toEqual(EXPECTED_ROLE_TOOLS[role]);
  expect(names.filter(isForbiddenTool), role).toEqual([]);
};

const SESSION_SETTINGS = {
  model: 'test-model',
  maxBudgetUsd: 1,
  maxTurns: 20,
} as const satisfies RoleSettings;

const specFor = (role: AgentRole, executor: FixedToolExecutor, workDir: string): SessionSpec => ({
  role,
  systemPrompt: '무결성 시험',
  prompt: '무결성 시험',
  workDir,
  tools: executor,
  budget: { maxBudgetUsd: SESSION_SETTINGS.maxBudgetUsd, maxTurns: SESSION_SETTINGS.maxTurns },
  model: SESSION_SETTINGS.model,
});

describe('모든 역할 세션의 도구 목록에 승인 · 잠정 승인 · 규범 쓰기 · 셸 도구 없음 (수용 기준 1, NFR-01 · NFR-02)', () => {
  it('판별 기준 자체: 승인 RPC · 셸 · 규범 쓰기 이름은 걸리고 고정 도구는 걸리지 않는다', () => {
    for (const name of [
      APPROVE_METHOD,
      'proposal.amend',
      'approve_proposal',
      'provisional_approve',
      'Bash',
      'run_shell',
      'exec_command',
      'rule_update',
      'contract.write',
      // 동사가 앞에 오는 이름 (이 저장소 도구 이름 형식)
      'update_rule',
      'create_rule',
      'create_requirement',
      'delete_contract',
      'save_rule',
      'upsert_requirement',
      'accept_proposal',
      'confirm_proposal',
      'grant_approval',
      'ratify_rule',
      'commit_norm',
      'Write',
      'Task',
    ]) {
      expect(isForbiddenTool(name), name).toBe(true);
    }
    // 보조 검사가 허용된 고정 도구를 막지 않는다
    expect(FIXED_TOOLS.filter(isForbiddenTool)).toEqual([]);
  });

  it('리터럴 허용 목록: 고정 도구 전체와 역할 표가 제품 정의와 정확히 같고, 표에 없는 역할이 없다', () => {
    expect([...FILE_TOOL_NAMES, ...COMMAND_TOOL_NAMES, ...PROPOSAL_TOOL_NAMES]).toEqual(
      FIXED_TOOLS,
    );
    // 원본 역할 목록과 표의 역할이 같다 (역할이 늘면 표를 고쳐야 통과)
    expect([...ROLES].sort()).toEqual(Object.keys(EXPECTED_ROLE_TOOLS).sort());
    for (const role of ROLES) {
      expect([...roleToolNames(role)], role).toEqual(EXPECTED_ROLE_TOOLS[role]);
      expect(
        (EXPECTED_ROLE_TOOLS[role] ?? []).filter((name) => !FIXED_TOOLS.includes(name)),
        role,
      ).toEqual([]);
    }
    // 파이프의 승인 · 처리 RPC가 판별에 들어 있다 (이름을 시험에 복사하지 않고 레지스트리에서 확인)
    expect(METHOD_NAMES.filter((name) => /approve|amend|reject/.test(name))).not.toEqual([]);
  });

  it.each(ROLES)(
    '%s: 고정 도구 목록 · 실행기 · MCP tools/list · SDK 옵션이 같은 안전한 도구만 노출한다',
    async (role) => {
      const listed = [...roleToolNames(role)];
      expectSafeTools(role, listed);

      const root = tempDir();
      const executor = new FixedToolExecutor({ role, sessionRoot: root, biveHome: tempDir() });
      expect([...executor.toolNames]).toEqual(listed);
      expect(biveMcpToolList(role).map((tool) => tool.name)).toEqual(listed);

      // 실제 SDK 어댑터의 query() 옵션 (SDK를 부르지 않는 순수 조립, ADR-059)
      const options = buildQueryOptions(specFor(role, executor, root), {
        env: {},
        configDir: path.join(root, 'agent'),
        abortController: new AbortController(),
      });
      expect(options.tools).toEqual([]);
      expect(Object.keys(options.mcpServers ?? {})).toEqual([BIVE_MCP_SERVER]);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.permissionMode).toBe(REQUIRED_PERMISSION_MODE);
      expect(options).not.toHaveProperty('agents');
      const allowed = options.allowedTools ?? [];
      expect(allowed.map(normalizeToolName)).toEqual(listed);
      expect(allowed.every((name) => name.startsWith(`mcp__${BIVE_MCP_SERVER}__`))).toBe(true);
      const canUseTool = options.canUseTool;
      if (canUseTool === undefined) throw new Error('canUseTool 없음');
      for (const name of [
        ...SDK_BUILTIN_TOOLS,
        APPROVE_METHOD,
        `mcp__${BIVE_MCP_SERVER}__${APPROVE_METHOD}`,
      ]) {
        await expect(
          canUseTool(name, {}, { signal: new AbortController().signal } as Parameters<
            typeof canUseTool
          >[2]),
          name,
        ).resolves.toMatchObject({ behavior: 'deny' });
      }

      // 승인 · 처리 RPC 이름과 셸 도구 호출은 실행기가 이름만 보고 거부한다 (인자 검사 전)
      for (const name of [
        ...METHOD_NAMES.filter((method) => method.startsWith('proposal.')),
        'Bash',
      ]) {
        await expect(executor.execute(name, { command: 'true' }), name).resolves.toMatchObject({
          status: 'denied',
          reason: 'unknown_tool',
        });
      }
    },
  );
});

// ── 작업 디렉터리 검사 ─────────────────────────────────────

interface WorkDirReport {
  role: AgentRole;
  workDir: string;
  realPath: string;
  /** 실경로가 금지 영역 안이면 그 영역 */
  inside: string | null;
  /** 금지 영역을 가리키는 심볼릭 링크 (작업 디렉터리 기준 상대 경로 → 대상 실경로) */
  links: [string, string][];
  /** 살펴본 항목 수 (검사가 빈 폴더만 본 것이 아님을 확인) */
  entries: number;
}

const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** 링크 대상의 실경로. 대상이 없으면 링크 폴더 기준으로 푼 경로. */
const linkTarget = (link: string): string => {
  try {
    return fs.realpathSync(link);
  } catch {
    return path.resolve(fs.realpathSync(path.dirname(link)), fs.readlinkSync(link));
  }
};

/** 세션 작업 디렉터리가 규범 저장소(`projects`) · 런타임(`run`) 밖이고 그쪽 링크가 없는지 본다 (링크는 따라가지 않는다). */
const inspectWorkDir = (role: AgentRole, workDir: string, biveHome: string): WorkDirReport => {
  const paths = bivePaths(fs.realpathSync(biveHome));
  const forbidden = [paths.projectsRoot, paths.runDir];
  const realPath = fs.realpathSync(workDir);
  const report: WorkDirReport = {
    role,
    workDir,
    realPath,
    inside: forbidden.find((root) => within(realPath, root)) ?? null,
    links: [],
    entries: 0,
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      report.entries += 1;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = linkTarget(full);
        if (forbidden.some((root) => within(target, root) || within(root, target))) {
          report.links.push([path.relative(workDir, full), target]);
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(workDir);
  return report;
};

const expectIsolated = (report: WorkDirReport): void => {
  expect(report.inside, `${report.role} ${report.realPath}`).toBeNull();
  expect(report.links, `${report.role} ${report.realPath}`).toEqual([]);
};

/** 세션의 결과 이벤트 직전(도구 호출이 모두 끝난 뒤)에 작업 디렉터리를 검사하는 어댑터. */
const inspectingAdapter = (
  inner: AgentAdapter,
  biveHome: () => string,
  reports: WorkDirReport[],
): AgentAdapter =>
  hookAdapter(inner, {
    beforeResult: (spec) => reports.push(inspectWorkDir(spec.role, spec.workDir, biveHome())),
  });

describe('작업 디렉터리 검사 자체 (수용 기준 3의 대조군)', () => {
  it('금지 영역 안의 실경로와 금지 영역을 가리키는 링크(깨진 링크 포함)를 찾아낸다', () => {
    const home = tempDir();
    const paths = bivePaths(home);
    fs.mkdirSync(path.join(paths.projectsRoot, 'p'), { recursive: true });
    fs.mkdirSync(paths.runDir, { recursive: true });
    const work = path.join(home, 'work', 's');
    fs.mkdirSync(path.join(work, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(work, 'a.txt'), '');
    fs.symlinkSync(paths.projectsRoot, path.join(work, 'deep', 'store'));
    fs.symlinkSync(path.join(paths.runDir, 'token'), path.join(work, 'token'));
    fs.symlinkSync(home, path.join(work, 'home'));
    fs.symlinkSync(path.join(home, 'work'), path.join(work, 'ok'));
    const report = inspectWorkDir('implementer', work, home);
    expect(report.inside).toBeNull();
    expect(report.links.map(([rel]) => rel).sort()).toEqual(['deep/store', 'home', 'token']);

    const linked = path.join(home, 'work', 'linked');
    fs.symlinkSync(path.join(paths.projectsRoot, 'p'), linked);
    expect(inspectWorkDir('implementer', linked, home).inside).toBe(paths.projectsRoot);
  });
});

// ── agent-approve: rule-writer 세션 ────────────────────────

interface RuleWriterHarness extends ProjectHarness {
  service: RuleWriterService;
  reports: WorkDirReport[];
}

const startRuleWriter = async (): Promise<RuleWriterHarness> => {
  const reports: WorkDirReport[] = [];
  let home = '';
  let service: RuleWriterService | null = null;
  const h = await startProjectHarness(
    { servers, clients },
    {
      ruleWriter: ({ biveHome, now }) => {
        home = biveHome;
        const scripted = new ScriptedAdapter({
          scenario: loadScenario(SCENARIO),
          biveHome,
          pollIntervalMs: 10,
        });
        service = new RuleWriterService({
          biveHome,
          adapter: inspectingAdapter(scripted, () => home, reports),
          now,
        });
        services.push(service);
        return service;
      },
    },
  );
  if (service === null) throw new Error('서비스가 만들어지지 않음');
  return { ...h, service, reports };
};

const proposalRef = (id: string): EntityRef => ({ entity: 'Proposal', id });

describe('agent-approve: 세션의 승인 호출 거부 (수용 기준 2, NFR-01 · ADR-027)', () => {
  it('rule-writer 세션의 proposal.approve는 denied(unknown_tool)이고 제안은 pending, 그 제안의 승인 기록 0건', async () => {
    const h = await startRuleWriter();
    await h.client.call('settings.update', {
      projectId: h.project.id,
      patch: {
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: { 'rule-writer': SESSION_SETTINGS },
      },
      author: human,
    });
    const { requirement } = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
    });
    await h.service.whenSettled(h.project.id, requirement.id);

    const [record] = h.service.recordsFor(h.project.id, requirement.id);
    if (record === undefined) throw new Error('세션 기록 없음');
    expect(record).toMatchObject({ status: 'ended', endReason: 'success' });
    expect(record.toolCalls.map((call) => [call.name, call.status, call.reason ?? null])).toEqual([
      ['propose_rule', 'ok', null],
      ['propose_rule', 'ok', null],
      [APPROVE_METHOD, 'denied', 'unknown_tool'],
    ]);
    expect(record.proposalIds).toHaveLength(2);
    // 시나리오 인자는 제안 ID가 아니라 요구사항 ID라, 아래 "pending 유지 · 승인 기록 0건"만으로는 승인 경로가 막혔는지
    // 가릴 수 없다. 위의 `denied`(`unknown_tool`) 단언이 그 구멍을 막는다(이름만 보고 거부, 인자를 보기 전).

    h.read((store) => {
      // 제안은 승인 대기 그대로, 규칙은 생기지 않았다
      for (const id of record.proposalIds) {
        expect(store.proposals.get(id)?.state).toBe('pending');
        expect(store.approvalLog.list(proposalRef(id))).toEqual([]);
      }
      expect(store.proposals.list().map((proposal) => proposal.state)).toEqual([
        'pending',
        'pending',
      ]);
      expect(store.approvalLog.list()).toEqual([]);
      expect(store.rules.list()).toEqual([]);
      // 거부된 호출도 세션 도구 호출 기록으로 남는다 (NFR-02)
      expect(
        store.sessions
          .toolCallsBySession(record.id)
          .filter((call) => call.name === APPROVE_METHOD)
          .map((call) => [call.status, call.reason]),
      ).toEqual([['denied', 'unknown_tool']]);
      // 실제 세션의 init 도구 목록 (수용 기준 1)
      const session = store.sessions.get(record.id);
      expect(session?.tools).toEqual([...roleToolNames('rule-writer')]);
      expectSafeTools('rule-writer', session?.tools ?? []);
    });

    // 작업 디렉터리 (수용 기준 3): rule-writer는 파일 도구가 없어 빈 폴더다
    expect(h.reports.map((report) => report.role)).toEqual(['rule-writer']);
    for (const report of h.reports) expectIsolated(report);
  });

  it('실행 안의 test-writer · implementer 세션도 승인 호출이 거부되고 승인 기록이 늘지 않으며 실행은 완주한다', async () => {
    const reports: WorkDirReport[] = [];
    const h: PipelineHarness = setupPipeline({
      scenario: SCENARIO,
      temps,
      engines,
      wrapAdapter: (adapter, get) => inspectingAdapter(adapter, () => get().biveHome, reports),
    });
    const approvalsBefore = withProject(h.biveHome, h.project.id, (store) =>
      store.approvalLog.list(),
    );

    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null });

    const approveCalls = toolCallsOf(h)
      .filter((call) => call.name === APPROVE_METHOD)
      .map((call) => [call.role, call.status, call.reason]);
    expect(approveCalls).toEqual([
      ['test-writer', 'denied', 'unknown_tool'],
      ['implementer', 'denied', 'unknown_tool'],
    ]);
    withProject(h.biveHome, h.project.id, (store) => {
      expect(store.approvalLog.list()).toEqual(approvalsBefore);
      expect(store.rules.list().map((rule) => rule.id)).toEqual([h.rule.id]);
      // 실제 세션의 init 도구 목록 (수용 기준 1)
      const sessions = store.sessions.listByRun(h.runId);
      expect(sessions.map((session) => session.role)).toEqual(['test-writer', 'implementer']);
      for (const session of sessions) {
        expect(session.tools).toEqual([...roleToolNames(session.role)]);
        expectSafeTools(session.role, session.tools);
      }
    });

    // 작업 디렉터리 (수용 기준 3): test-writer 세션 디렉터리 · implementer 실행 워크트리
    expect(reports.map((report) => report.role)).toEqual(['test-writer', 'implementer']);
    for (const report of reports) {
      expectIsolated(report);
      expect(report.entries).toBeGreaterThan(0);
    }
    expect(reports.find((report) => report.role === 'implementer')?.workDir).toBe(
      done.run.worktreePath,
    );
  }, 60_000);
});

// ── 네트워크 감시 자체 점검 ─────────────────────────────────

describe('네트워크 감시 도구 자체 (수용 기준 4의 대조군, 실제 단언은 e2e/pipeline/network.test.ts)', () => {
  it('net(fetch · http · tls 포함) · dns · dgram 호출을 연결 전에 기록하고, 로컬 소켓과 127.0.0.1만 외부가 아니다', async () => {
    const records: NetWatchRecord[] = [];
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const sock = path.join(tempDir(), 'probe.sock');
    const local = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => local.listen(sock, resolve));

    // 외부 시도는 기록 뒤 막는다 (실제 네트워크를 쓰지 않음)
    const restore = installNetWatch({
      onRecord: (record) => records.push(record),
      block: isExternalAttempt,
    });
    const blocked: string[] = [];
    const attempt = async (label: string, fn: () => unknown): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (error instanceof NetWatchBlocked || cause instanceof NetWatchBlocked) {
          blocked.push(label);
        } else {
          throw error;
        }
      }
    };
    try {
      expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe('ok');
      await new Promise<void>((resolve, reject) =>
        net
          .connect(sock)
          .once('close', () => resolve())
          .once('error', reject),
      );
      await attempt('fetch', () => fetch('http://bive-probe.invalid/'));
      await attempt('net', () => net.connect(443, '192.0.2.1'));
      await attempt('localhost', () => net.connect(80));
      await attempt('lookup', () => dns.lookup('bive-probe.invalid', () => undefined));
      await attempt('promises', () => dns.promises.resolve4('bive-probe.invalid'));
      await attempt('resolver', () => new dns.promises.Resolver().resolveTxt('bive-probe.invalid'));
      // http.get: 막힌 연결은 동기 예외 또는 요청의 error 이벤트로 끝난다
      await attempt(
        'http',
        () =>
          new Promise<void>((resolve, reject) => {
            const req = http.get('http://192.0.2.1:80/');
            req.once('error', reject);
            req.once('response', () => resolve());
          }),
      );
      await attempt('tls', () => tls.connect(443, '192.0.2.1'));
      const udp = dgram.createSocket('udp4');
      try {
        await attempt('udp-send', () => udp.send(Buffer.from('x'), 9, '192.0.2.1'));
        await attempt('udp-connect', () => udp.connect(9, '192.0.2.1'));
      } finally {
        udp.close();
      }
    } finally {
      restore();
      server.close();
      local.close();
    }
    expect(blocked).toEqual([
      'fetch',
      'net',
      'localhost',
      'lookup',
      'promises',
      'resolver',
      'http',
      'tls',
      'udp-send',
      'udp-connect',
    ]);

    expect(records[0]).toMatchObject({ kind: 'installed', pid: process.pid });
    const attempts = records.filter((record): record is NetAttempt => record.kind !== 'installed');
    expect(attempts.filter(isExternalAttempt).map(describeAttempt)).toEqual([
      'net bive-probe.invalid:80',
      'net 192.0.2.1:443',
      'net localhost:80',
      'dns dns.lookup(bive-probe.invalid)',
      'dns dns.promises.resolve4(bive-probe.invalid)',
      'dns dns.promises.Resolver.resolveTxt(bive-probe.invalid)',
      'net 192.0.2.1:80',
      'net 192.0.2.1:443',
      'udp dgram.send 192.0.2.1:9',
      'udp dgram.connect 192.0.2.1:9',
    ]);
    // 허용: 127.0.0.1 HTTP · Unix 소켓
    expect(attempts.filter((a) => !isExternalAttempt(a))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'net', host: '127.0.0.1', port }),
        expect.objectContaining({ kind: 'net', path: sock }),
      ]),
    );
    // 되돌린 뒤에는 기록하지 않는다
    const count = records.length;
    dns.lookup('127.0.0.1', () => undefined);
    expect(records).toHaveLength(count);
  });
});
