// 파이프라인 e2e 도우미 (M1-21, architecture.md 8장 "파이프라인 e2e", ADR-071).
// 시험마다 새 픽스처 복사본(`scripts/reset-fixture.sh`: 추적 파일 복사 · 설치 · git 커밋)과 새 BIVE_HOME을 만들고,
// 제품 CLI(`src/cli.ts`)를 `BIVE_AGENT=scripted` · `BIVE_SCENARIO=<이름>`으로 띄운다. 단계 실행기 · 의존성 설치 ·
// 판정 러너(next build · next start · vitest) · git은 제품 기본값 그대로이고 주입하지 않는다. 시험은 앱과 같은 파이프
// 경로로만 조작한다: project.open → settings.update → requirement.create → rule-writer 제안 승인 → run.create → run.get.
// 단언용 읽기(판정 기록 · 세션 기록)만 실행이 끝난 뒤 저장소를 직접 연다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isTerminalRunStatus,
  type Proposal,
  type Requirement,
  type Rule,
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
  makeBiveHome,
  REPO_ROOT,
  type Spawned,
  spawnCli,
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

const fixtureDirs: string[] = [];
const clients: TestClient[] = [];

export interface PipelineE2e {
  scenario: string;
  biveHome: string;
  /** 픽스처 복사본 (프로젝트 폴더, 기준 브랜치 `main`) */
  repo: string;
  orchestrator: Spawned;
  client: TestClient;
  projectId: string;
}

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

/**
 * 픽스처 복사본 + 제품 오케스트레이터(시나리오 지정)를 띄우고 프로젝트를 열어 예산 · 모델을 저장한다
 * (roadmap M1 흐름 1 · 2 · 6의 값).
 */
export const startPipeline = async (scenario: string): Promise<PipelineE2e> => {
  const repo = resetFixture();
  const biveHome = makeBiveHome();
  const orchestrator = spawnCli({
    BIVE_HOME: biveHome,
    BIVE_IDLE_SHUTDOWN_MS: '600000',
    BIVE_AGENT: 'scripted',
    BIVE_SCENARIO: scenario,
  });
  await waitFor(
    () => orchestrator.stdout.includes('오케스트레이터 기동'),
    START_TIMEOUT_MS,
    `오케스트레이터 기동 (${scenario})`,
  );
  expect(orchestrator.stdout).toContain(`에이전트 scripted · 시나리오 ${scenario}`);
  const paths = runPaths(biveHome);
  const client = await connectWhenReady(paths.pipe, () => fs.readFileSync(paths.token, 'utf8'));
  clients.push(client);
  const { project } = await client.call('project.open', { path: repo });
  await client.call('settings.update', {
    projectId: project.id,
    patch: COMPLETE_SETTINGS,
    author: human,
  });
  return { scenario, biveHome, repo, orchestrator, client, projectId: project.id };
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
  await waitFor(
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

/** 실행을 만들고(사람) 끝 상태(`merged` · `failed` · `budget_exceeded`)가 될 때까지 run.get을 폴링한다. */
export const runToEnd = async (
  e: PipelineE2e,
  ruleIds: string[],
  timeoutMs: number,
): Promise<RunGetResult> => {
  const created = await e.client.call('run.create', {
    projectId: e.projectId,
    ruleIds,
    author: human,
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await e.client.call('run.get', { projectId: e.projectId, id: created.run.id });
    if (isTerminalRunStatus(detail.run.status)) return detail;
    if (Date.now() > deadline) {
      throw new Error(
        `시간 초과: 실행 종료 (${e.scenario}, 상태 ${detail.run.status}, 단계 ${String(detail.run.currentStep)})\n` +
          `오케스트레이터 출력:\n${e.orchestrator.stdout}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

/** 단계 시도 목록 `종류#시도:상태` (종류를 주면 그 종류만). */
export const attempts = (detail: RunGetResult, ...kinds: StepKind[]): string[] =>
  detail.steps
    .filter((step) => kinds.length === 0 || kinds.includes(step.kind))
    .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

/** 실행이 끝난 뒤 저장소를 직접 읽는다 (단언 전용). */
export const readStore = <T>(e: PipelineE2e, fn: (store: ProjectStore) => T): T =>
  withProject(e.biveHome, e.projectId, fn);

/** 연결 · 오케스트레이터 · BIVE_HOME · 픽스처 복사본을 정리한다. */
export const cleanupPipeline = async (): Promise<void> => {
  for (const client of clients.splice(0)) client.destroy();
  await cleanup();
  for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
};
