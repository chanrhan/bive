// 엔진 시험 도우미 (M1-14): 픽스처 git 복사본 · 등록된 프로젝트 · 설정 · 승인된 규칙 · 시험용 단계 실행기.
// 단계 실행기는 시험 전용이다(제품의 테스트 작성 · Red · 구현 · 검사 · 병합 실행기는 #28 · #29). 종료 조건은
// 파일 내용만 보는 단순한 대역이고 판정 러너는 돌리지 않는다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Author,
  createUlidGenerator,
  type Project,
  type Rule,
  type SettingsPatch,
} from '@bive/shared';
import { openProjectStore, registerProject, type ProjectStore } from '@bive/store';

import type { StepExecutor, StepExecutors, StepOutcome } from '../../src/engine/types.js';
import { REPO_ROOT } from './process.js';

export const human = { kind: 'human' } as const satisfies Author;
export const newId = createUlidGenerator();
export const T0 = Date.parse('2026-10-16T09:00:00.000Z');
export const TEST_SCENARIOS_DIR = fileURLToPath(new URL('../fixtures/scenarios/', import.meta.url));

const FIXTURE_REL = 'fixtures/sample-next-app';
export const ROUTE = 'src/app/api/health/route.ts';

/** 사람(사용자) 쪽 git. */
export const userGit = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=사용자',
      '-c',
      'user.email=user@example.com',
      '-c',
      `core.hooksPath=${os.devNull}`,
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

/** 픽스처 추적 파일만 복사하고 `main`에 첫 커밋을 만든다 (설치 없음). 지울 폴더를 `temps`에 더한다. */
export const copyFixture = (temps: string[]): string => {
  const base = fs.mkdtempSync(
    path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'fx.'),
  );
  temps.push(base);
  const repo = path.join(base, 'sample-next-app');
  const files = execFileSync('git', ['ls-files', '-z', '--', FIXTURE_REL], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '');
  for (const file of files) {
    const target = path.join(repo, path.relative(FIXTURE_REL, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), target);
  }
  userGit(repo, 'init', '-q', '-b', 'main');
  userGit(repo, 'add', '--all');
  userGit(repo, 'commit', '-q', '-m', 'fixture: initial');
  return repo;
};

/** roadmap M1 흐름 2 · 6의 값. */
export const COMPLETE_SETTINGS: SettingsPatch = {
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: {
    'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 },
    'test-writer': { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 },
    implementer: { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 },
  },
};

export const withProject = <T>(
  biveHome: string,
  projectId: string,
  fn: (store: ProjectStore) => T,
): T => {
  const store = openProjectStore(projectId, { home: biveHome, create: false });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

export interface SeededProject {
  project: Project;
  rule: Rule;
}

/** 프로젝트 등록 + 설정 + 승인된 규칙 1개(`RULE-001`). */
export const seedProject = (
  biveHome: string,
  repo: string,
  settings: SettingsPatch = COMPLETE_SETTINGS,
  normState: Rule['normState'] = 'approved',
): SeededProject => {
  const project = registerProject(
    {
      id: newId(),
      name: '샘플 앱',
      rootPath: repo,
      baseBranch: 'main',
      createdAt: new Date(T0).toISOString(),
    },
    { home: biveHome },
  );
  return withProject(biveHome, project.id, (store) => {
    store.settings.update(settings, { by: human, at: new Date(T0).toISOString() });
    const requirement = store.requirements.create({
      id: newId(),
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
      normState: 'approved',
      createdAt: new Date(T0).toISOString(),
    });
    const rule = store.rules.create({
      id: newId(),
      title: '헬스 체크 서버 시각',
      statement:
        'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 time 필드에 서버 시각을 담는다',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: requirement.id,
      builtin: false,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: { kind: 'agent', role: 'rule-writer' },
      normState,
      createdAt: new Date(T0).toISOString(),
    });
    return { project, rule };
  });
};

/** 역할 세션을 실행 워크트리에서 열고 성공이면 통과, 아니면 미충족. */
const sessionStep =
  (check: (worktree: string) => boolean = () => true): StepExecutor =>
  async (context) => {
    const ruleIds = context.read((store) =>
      context.run.targetRuleIds.map((id) => store.rules.get(id)?.displayId ?? id),
    );
    const session = await context.runSession({
      workDir: context.git.worktreePath,
      systemPrompt: '엔진 시험',
      prompt: '엔진 시험',
      vars: { ruleId: ruleIds[0] ?? '' },
    });
    if (session.endReason !== 'success' || !check(context.git.worktreePath)) {
      return {
        status: 'unmet',
        exitDetail: { endReason: session.endReason, detail: session.detail },
      };
    }
    return { status: 'passed', exitDetail: { sessionId: session.sessionId } };
  };

/** 실행 워크트리에 인수 테스트 파일이 있는지 (테스트 작성 종료 조건의 대역). */
export const hasAcceptanceTest = (worktree: string): boolean => {
  const dir = path.join(worktree, 'bive-acceptance');
  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
};

/** 헬스 체크 응답에 서버 시각이 있는지 (검사 종료 조건의 대역). */
export const routeHasTime = (worktree: string): boolean =>
  fs.readFileSync(path.join(worktree, ROUTE), 'utf8').includes('toISOString()');

/** 차례대로 결과를 내고, 다 쓰면 마지막을 반복하는 실행기. */
export const scripted = (outcomes: readonly StepOutcome['status'][]): StepExecutor => {
  let index = 0;
  return () => {
    const status = outcomes[Math.min(index, outcomes.length - 1)] ?? 'passed';
    index += 1;
    if (status === 'halt') {
      return Promise.resolve({ status, runStatus: 'failed', reason: 'scripted_halt' });
    }
    return Promise.resolve({ status, exitDetail: { scripted: index } });
  };
};

/** 실제 git 병합 (기준 브랜치가 바뀌었으면 다시 볼 검사는 통과로 둔다). */
export const mergeStep: StepExecutor = async (context) => {
  const result = await context.worktrees.merge(context.git, {
    check: () => Promise.resolve({ passed: true }),
  });
  if (result.status === 'merged') {
    return {
      status: 'passed',
      exitDetail: { mergeCommit: result.mergeCommit },
      run: { mergeCommit: result.mergeCommit },
    };
  }
  return {
    status: 'halt',
    runStatus: 'failed',
    reason: result.reason,
    exitDetail: { message: result.message },
  };
};

/** 시험용 단계 실행기 묶음. 변이 주입 · 화면 갱신은 엔진 기본값을 쓴다. */
export const testExecutors = (overrides: StepExecutors = {}): StepExecutors => ({
  test_writing: sessionStep(hasAcceptanceTest),
  red_check: scripted(['passed']),
  implementation: sessionStep(),
  check: async (context) => ({
    status: routeHasTime(context.git.worktreePath) ? 'passed' : 'unmet',
  }),
  merge: mergeStep,
  ...overrides,
});
