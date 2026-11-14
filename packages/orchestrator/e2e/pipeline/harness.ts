// 파이프라인 e2e 도우미 (M1-21, architecture.md 8장 "파이프라인 e2e", ADR-071).
// 시험마다 새 픽스처 복사본(`scripts/reset-fixture.sh`: 추적 파일 복사 · 설치 · git 커밋)과 새 BIVE_HOME을 만들고,
// 제품 CLI(`src/cli.ts`)를 `BIVE_AGENT=scripted` · `BIVE_SCENARIO=<이름>`으로 띄운다. 단계 실행기 · 의존성 설치 ·
// 판정 러너(next build · next start · vitest) · git은 제품 기본값 그대로이고 주입하지 않는다. 시험은 앱과 같은 파이프
// 경로로만 조작한다: project.open → settings.update → requirement.create → rule-writer 제안 승인 → run.create → run.get.
// 단언용 읽기(판정 기록 · 세션 기록)만 실행이 끝난 뒤 저장소를 직접 연다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isTerminalRunStatus,
  type Proposal,
  type Requirement,
  type Rule,
  type Run,
  type RunGetResult,
  type StepKind,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { expect } from 'vitest';

import { runPaths } from '../../src/run-paths.js';
import { connectWhenReady, type TestClient } from '../../test/helpers/client.js';
import { COMPLETE_SETTINGS, human, withProject } from '../../test/helpers/engine-harness.js';
import {
  cleanup,
  leftoverProcesses,
  type LeftoverProcess,
  makeBiveHome,
  REPO_ROOT,
  sleep,
  type Spawned,
  spawnCli,
  spawnScript,
  terminate,
  trackedHomes,
  waitFor,
} from '../../test/helpers/process.js';

export { human };

/** 헬스 체크 라우트 (픽스처 기준 상대 경로) */
export const ROUTE = 'src/app/api/health/route.ts';
/** 첫 실행의 브랜치 (ADR-058) */
export const RUN_BRANCH = 'bive/run-EXE-001';

/** 오케스트레이터 기동 대기 */
const START_TIMEOUT_MS = 30_000;
/** rule-writer 제안 등록 대기 */
const PROPOSAL_TIMEOUT_MS = 30_000;
/** 정리: SIGTERM 뒤 오케스트레이터가 진행 중 실행(판정 포함)을 멈추고 끝나기를 기다리는 시간 */
const TERMINATE_TIMEOUT_MS = 30_000;
/** 정리: SIGKILL 뒤 남은 프로세스가 사라지기를 기다리는 시간 */
const LEFTOVER_TIMEOUT_MS = 10_000;

const fixtureDirs: string[] = [];
const clients: TestClient[] = [];

export interface PipelineE2e {
  scenario: string;
  biveHome: string;
  /** 픽스처 복사본 (프로젝트 폴더, 기준 브랜치 `main`) */
  repo: string;
  /** 지금 오케스트레이터 (재기동하면 바뀐다) */
  orchestrator: Spawned;
  client: TestClient;
  projectId: string;
  /** 오케스트레이터 기동 방법 (재기동에 같은 값을 쓴다) */
  launch: { entry: string | undefined; env: Record<string, string> };
}

/** 오케스트레이터 출력 (실패 메시지에 붙인다). */
export const orchestratorOutput = (e: Pick<PipelineE2e, 'orchestrator'>): string =>
  `오케스트레이터 출력:\n${e.orchestrator.stdout}\n오케스트레이터 오류 출력:\n${e.orchestrator.stderr}`;

/** 기다리다 시간이 다 되면 오케스트레이터 출력을 붙여 던진다. */
const waitWithOutput = async (
  e: Pick<PipelineE2e, 'orchestrator'>,
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  try {
    await waitFor(condition, timeoutMs, what);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${orchestratorOutput(e)}`, { cause: error });
  }
};

/** 오케스트레이터를 띄우고 기동 출력 · 파이프 접속까지 기다린다. */
const launchOrchestrator = async (
  scenario: string,
  launch: PipelineE2e['launch'],
): Promise<{ orchestrator: Spawned; client: TestClient }> => {
  const orchestrator =
    launch.entry === undefined ? spawnCli(launch.env) : spawnScript(launch.entry, launch.env);
  await waitWithOutput(
    { orchestrator },
    () => orchestrator.stdout.includes('오케스트레이터 기동'),
    START_TIMEOUT_MS,
    `오케스트레이터 기동 (${scenario})`,
  );
  expect(orchestrator.stdout).toContain(`에이전트 scripted · 시나리오 ${scenario}`);
  const paths = runPaths(String(launch.env.BIVE_HOME));
  const client = await connectWhenReady(paths.pipe, () => fs.readFileSync(paths.token, 'utf8'));
  clients.push(client);
  return { orchestrator, client };
};

/** 읽기 전용 git (사용자 설정 · 서명과 무관한 조회만 한다). */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const mainTip = (e: PipelineE2e): string => git(e.repo, 'rev-parse', 'refs/heads/main');
export const mergeCount = (e: PipelineE2e): number =>
  Number(git(e.repo, 'rev-list', '--merges', '--count', 'refs/heads/main'));
export const branchExists = (e: PipelineE2e, branch: string): boolean =>
  git(e.repo, 'branch', '--list', branch) !== '';
export const parentsOf = (e: PipelineE2e, commit: string): string[] =>
  git(e.repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);

/** `scripts/reset-fixture.sh`로 픽스처 복사본을 만든다 (roadmap M1 완료 기준 흐름의 준비와 같다). */
export const resetFixture = (): string => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-fx.'));
  fixtureDirs.push(base);
  const repo = path.join(base, 'fx');
  execFileSync(path.join(REPO_ROOT, 'scripts', 'reset-fixture.sh'), [repo], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return repo;
};

export interface StartPipelineOptions {
  /**
   * 제품 CLI 대신 띄울 시험 진입점 (패키지 기준 상대 경로). 무언가를 먼저 건 뒤 `src/cli.ts`를 그대로 불러야 한다
   * (예: 네트워크 감시 `test/helpers/net-watched-cli.ts`, ADR-075)
   */
  entry?: string;
  /** 오케스트레이터에 더 줄 환경 변수 */
  env?: Record<string, string>;
}

/**
 * 픽스처 복사본 + 제품 오케스트레이터(시나리오 지정)를 띄우고 프로젝트를 열어 예산 · 모델을 저장한다
 * (roadmap M1 흐름 1 · 2 · 6의 값).
 */
export const startPipeline = async (
  scenario: string,
  options: StartPipelineOptions = {},
): Promise<PipelineE2e> => {
  const repo = resetFixture();
  const biveHome = makeBiveHome();
  const env = {
    ...options.env,
    BIVE_HOME: biveHome,
    BIVE_IDLE_SHUTDOWN_MS: '600000',
    BIVE_AGENT: 'scripted',
    BIVE_SCENARIO: scenario,
  };
  const launch = { entry: options.entry, env };
  const { orchestrator, client } = await launchOrchestrator(scenario, launch);
  const { project } = await client.call('project.open', { path: repo });
  await client.call('settings.update', {
    projectId: project.id,
    patch: COMPLETE_SETTINGS,
    author: human,
  });
  return { scenario, biveHome, repo, orchestrator, client, projectId: project.id, launch };
};

/**
 * 오케스트레이터를 SIGKILL로 강제 종료한다(비정상 종료 재현). 대상은 이 시험이 띄운 자식 핸들뿐이다
 * (지어낸 pid · 프로세스 그룹에 신호를 보내지 않는다). 끝날 때까지 기다린다.
 */
export const killOrchestrator = async (e: PipelineE2e): Promise<void> => {
  const { child } = e.orchestrator;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const exit = await e.orchestrator.exited;
  expect(exit.signal).toBe('SIGKILL');
  e.client.destroy();
};

/** 같은 BIVE_HOME · 시나리오로 오케스트레이터를 다시 띄우고 새 연결로 바꾼다. */
export const restartOrchestrator = async (e: PipelineE2e): Promise<void> => {
  const { orchestrator, client } = await launchOrchestrator(e.scenario, e.launch);
  e.orchestrator = orchestrator;
  e.client = client;
};

/** 요구사항을 저장하고 rule-writer 세션이 제안을 `count`개 등록할 때까지 기다린다. */
export const saveRequirement = async (
  e: PipelineE2e,
  text: string,
  count: number,
): Promise<{ requirement: Requirement; proposals: Proposal[] }> => {
  const { requirement } = await e.client.call('requirement.create', {
    projectId: e.projectId,
    text,
    author: human,
  });
  let proposals: Proposal[] = [];
  await waitWithOutput(
    e,
    async () => {
      proposals = (
        await e.client.call('proposal.list', { projectId: e.projectId, state: 'pending' })
      ).proposals;
      return proposals.length >= count;
    },
    PROPOSAL_TIMEOUT_MS,
    `rule-writer 제안 ${String(count)}개`,
  );
  expect(proposals).toHaveLength(count);
  return { requirement, proposals };
};

/** 제안을 사람이 승인해 규칙을 만든다. */
export const approveRule = async (e: PipelineE2e, proposal: Proposal): Promise<Rule> => {
  const { applied } = await e.client.call('proposal.approve', {
    projectId: e.projectId,
    id: proposal.id,
    author: human,
  });
  if (applied.entity !== 'Rule') throw new Error(`규칙 제안이 아님: ${applied.entity}`);
  return applied.rule;
};

/** 실행을 만든다 (사람). */
export const createRun = async (e: PipelineE2e, ruleIds: string[]): Promise<Run> =>
  (await e.client.call('run.create', { projectId: e.projectId, ruleIds, author: human })).run;

/** 실행이 끝 상태(`merged` · `failed` · `budget_exceeded`)가 될 때까지 run.get을 폴링한다. */
export const waitForRunEnd = async (
  e: PipelineE2e,
  runId: string,
  timeoutMs: number,
): Promise<RunGetResult> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await e.client.call('run.get', { projectId: e.projectId, id: runId });
    if (isTerminalRunStatus(detail.run.status)) return detail;
    if (Date.now() > deadline) {
      throw new Error(
        `시간 초과: 실행 종료 (${e.scenario}, 상태 ${detail.run.status}, 단계 ${String(detail.run.currentStep)})\n` +
          orchestratorOutput(e),
      );
    }
    await sleep(500);
  }
};

/** 실행을 만들고(사람) 끝 상태가 될 때까지 기다린다. */
export const runToEnd = async (
  e: PipelineE2e,
  ruleIds: string[],
  timeoutMs: number,
): Promise<RunGetResult> => waitForRunEnd(e, (await createRun(e, ruleIds)).id, timeoutMs);

/** 파일이 생길 때까지 기다린다 (시나리오의 pause 대기 파일 등). */
export const waitForFile = (
  e: PipelineE2e,
  file: string,
  timeoutMs: number,
  what: string,
): Promise<void> => waitWithOutput(e, () => fs.existsSync(file), timeoutMs, what);

/** 시나리오 pause 대기 파일 (`{{biveHome}}/run/pause`) */
export const pauseFile = (e: PipelineE2e): string => path.join(e.biveHome, 'run', 'pause');

/** SHA-256 16진수 (`hashAcceptanceFiles`와 같은 계산). */
export const sha256 = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

/** git 객체 내용 그대로 (`<커밋>:<경로>`). */
export const gitBlob = (cwd: string, spec: string): Buffer =>
  execFileSync('git', ['cat-file', 'blob', spec], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * 사람이 프로젝트 폴더에서 커밋한다(기준 브랜치에 직접 올리는 커밋). 서명 · 훅 등 사용자 전역 설정과 무관하게
 * `scripts/reset-fixture.sh`와 같은 주체 · 설정으로 커밋한다.
 */
export const commitAsUser = (
  repo: string,
  file: string,
  content: string,
  message: string,
): string => {
  fs.writeFileSync(path.join(repo, file), content);
  const userGit = (...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=BIVE Fixture',
        '-c',
        'user.email=fixture@bive.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  userGit('add', '--', file);
  userGit('commit', '-q', '-m', message);
  return userGit('rev-parse', 'HEAD');
};

/** 단계 시도 목록 `종류#시도:상태` (종류를 주면 그 종류만). */
export const attempts = (detail: RunGetResult, ...kinds: StepKind[]): string[] =>
  detail.steps
    .filter((step) => kinds.length === 0 || kinds.includes(step.kind))
    .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

/** 실행이 끝난 뒤 저장소를 직접 읽는다 (단언 전용). */
export const readStore = <T>(e: PipelineE2e, fn: (store: ProjectStore) => T): T =>
  withProject(e.biveHome, e.projectId, fn);

const describeLeftovers = (leftovers: readonly LeftoverProcess[]): string =>
  leftovers.map((p) => `pid ${String(p.pid)} (${p.cwd}): ${p.command}`).join('\n');

/**
 * 연결 · 오케스트레이터 · BIVE_HOME · 픽스처 복사본을 정리한다.
 * 1. 오케스트레이터에 SIGTERM을 보내 진행 중 실행(판정 러너의 하위 프로세스 포함)을 멈추고 끝나기를 기다린다(최대 30초)
 * 2. 그래도 남은 것은 `cleanup`이 SIGKILL한다(자기가 띄운 자식 핸들과 `BIVE_HOME`이 이 시험의 것인 pid만)
 * 3. 이 시험의 BIVE_HOME 안을 작업 폴더로 쓰는 프로세스가 남았는지 확인한다. 남았으면 죽이지 않고 목록과 함께 실패한다
 *    (판정 하위 프로세스는 `BIVE_HOME` 환경 변수가 없어 소유를 확정할 수 없으므로 정리 대상이 아니라 결함 신호로 본다)
 */
export const cleanupPipeline = async (): Promise<void> => {
  for (const client of clients.splice(0)) client.destroy();
  const homes = trackedHomes();
  let leftovers: LeftoverProcess[];
  try {
    await terminate(TERMINATE_TIMEOUT_MS);
    await cleanup();
    const deadline = Date.now() + LEFTOVER_TIMEOUT_MS;
    for (;;) {
      leftovers = homes.flatMap(leftoverProcesses);
      if (leftovers.length === 0 || Date.now() > deadline) break;
      await sleep(250);
    }
  } finally {
    for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (leftovers.length > 0) {
    throw new Error(
      `정리 뒤 남은 프로세스 (시험의 BIVE_HOME 안):\n${describeLeftovers(leftovers)}`,
    );
  }
};
