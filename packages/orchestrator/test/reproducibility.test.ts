// 재현성 확인 · 재판정 불일치 격리 (M3-14 #59 수용 기준 3, NFR-05 · JDG-02, ADR-156).
// scripts/reset-fixture.sh로 만든 픽스처 사본에 안정한 인수 테스트(RULE-002, 헬스 체크)를 커밋하고 scripts/make-variant.sh flaky
// (RULE-001: 같은 체크아웃의 두 번째 호출만 실패)를 더한 커밋 하나를 실제 판정 러너로 세 번 판정한다. 안정한 규칙은 세 번 같고,
// 흔들린 규칙만 판정 상태 '격리' · 사유 '재판정 불일치'가 된다. 판정 러너를 띄우므로 판정 묶음(vitest.config.ts)에서 돈다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Author, createUlidGenerator, type Rule } from '@bive/shared';
import { openProjectStore, registerProject, type ProjectStore } from '@bive/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JudgeRunner, type JudgeRunResult } from '../src/judge/index.js';
import { REJUDGE_MISMATCH_REASON } from '../src/judgments/judgment-marks.js';
import { toRuleJudgment } from '../src/judgments/latest-judgment.js';
import {
  checkReproducibility,
  REPRODUCIBILITY_ROUNDS,
  runnerRounds,
  unstableRuleIds,
  verdictsOf,
} from '../src/judgments/reproducibility.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESET_FIXTURE = path.join(REPO_ROOT, 'scripts', 'reset-fixture.sh');
const MAKE_VARIANT = path.join(REPO_ROOT, 'scripts', 'make-variant.sh');

/** 판정 1회 제한 시간 (마이그레이션 + next build + next start + vitest). */
const JUDGE_TIMEOUT_MS = 180_000;
/** 세 번 판정하는 시험의 제한 시간. */
const ROUNDS_TEST_TIMEOUT_MS = 3 * 240_000;
/** 픽스처 사본(node_modules 포함) 삭제 제한 시간 (#122). */
const CLEANUP_TIMEOUT_MS = 120_000;

const human = { kind: 'human' } as const satisfies Author;
const newId = createUlidGenerator();

const HEALTH_ACC = `import { describe, expect, inject, it } from 'vitest';

describe('헬스 체크', () => {
  it('ok는 true', async () => {
    const res = await fetch(new URL('/api/health', inject('baseUrl')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
`;

const git = (dir: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=BIVE 시험',
      '-c',
      'user.email=test@bive.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' },
  ).trim();

let fixtureDir = '';
let biveHome = '';
let judgeTempDir = '';

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'bive-repro-fx-'));
  biveHome = mkdtempSync(path.join(os.tmpdir(), 'bive-repro-home-'));
  judgeTempDir = mkdtempSync(path.join(os.tmpdir(), 'bive-repro-tmp-'));
  execFileSync('bash', [RESET_FIXTURE, fixtureDir], { stdio: 'pipe' });
  mkdirSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-002'), { recursive: true });
  writeFileSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-002', 'health.acc.ts'), HEALTH_ACC);
  git(fixtureDir, 'add', '-A');
  git(fixtureDir, 'commit', '-q', '-m', 'acceptance: RULE-002');
  execFileSync('bash', [MAKE_VARIANT, fixtureDir, 'flaky'], { stdio: 'pipe' });
}, 300_000);

afterAll(() => {
  for (const dir of [fixtureDir, biveHome, judgeTempDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}, CLEANUP_TIMEOUT_MS);

const insertRule = (store: ProjectStore, title: string): Rule => {
  const requirement = store.requirements.create({
    id: newId(),
    text: `${title} 요구사항`,
    author: human,
    normState: 'approved',
    createdAt: new Date().toISOString(),
  });
  return store.rules.create({
    id: newId(),
    title,
    statement: `WHEN ${title} THE SYSTEM SHALL 요청에 응답한다`,
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: requirement.id,
    builtin: false,
    targetBlockIds: [],
    risk: null,
    contractId: null,
    author: { kind: 'agent', role: 'rule-writer' },
    normState: 'approved',
    createdAt: new Date().toISOString(),
  });
};

describe('흔들림 판단 (순수 함수)', () => {
  it('판정이 있는 회차가 둘 이상이고 서로 다를 때만 흔들림이다: 러너 오류 회차는 비교에 들지 않는다', () => {
    const rounds = [
      new Map([
        ['same', 'pass'],
        ['flip', 'pass'],
        ['one', 'fail'],
        ['none', null],
      ] as const),
      new Map([
        ['same', 'pass'],
        ['flip', 'fail'],
        ['one', null],
        ['none', null],
      ] as const),
      new Map([
        ['same', 'pass'],
        ['flip', 'pass'],
        ['one', null],
        ['none', null],
      ] as const),
    ];
    expect(unstableRuleIds(['same', 'flip', 'one', 'none', 'missing'], rounds)).toEqual(['flip']);
  });
});

describe('재현성 확인: 같은 커밋 3회 판정 (수용 기준 3)', () => {
  it(
    '안정한 규칙은 세 번 판정이 같고 격리되지 않으며, flaky 변형의 규칙은 판정 상태 격리 · 사유 재판정 불일치다',
    async () => {
      const project = registerProject(
        {
          id: newId(),
          name: '재현성',
          rootPath: fixtureDir,
          baseBranch: 'main',
          createdAt: new Date().toISOString(),
        },
        { home: biveHome },
      );
      const write = <T>(fn: (store: ProjectStore) => T): T => {
        const store = openProjectStore(project.id, { home: biveHome, create: false });
        try {
          return fn(store);
        } finally {
          store.close();
        }
      };
      // 표시 ID 순서: 흔들리는 규칙이 RULE-001(변형의 인수 테스트 폴더), 안정한 규칙이 RULE-002
      const { flaky, stable } = write((store) => ({
        flaky: insertRule(store, '흔들리는 응답'),
        stable: insertRule(store, '헬스 체크'),
      }));
      expect([flaky.displayId, stable.displayId]).toEqual(['RULE-001', 'RULE-002']);
      const commit = git(fixtureDir, 'rev-parse', 'HEAD');
      const runner = new JudgeRunner({ biveHome, tempDir: judgeTempDir });
      const started = Date.now();
      const once = runnerRounds(
        runner,
        {
          projectId: project.id,
          worktreeDir: fixtureDir,
          profile: 'next-prisma-sqlite',
          timeoutMs: JUDGE_TIMEOUT_MS,
          rules: [flaky, stable],
        },
        newId,
      );
      const results: JudgeRunResult[] = [];
      const report = await checkReproducibility(
        {
          rules: [flaky, stable],
          commit,
          judgeOnce: async (round) => {
            const result = await once(round);
            results.push(result);
            return result;
          },
        },
        write,
        () => ({ now: Date.now(), newId }),
      );
      console.info(
        `[reproducibility] ${String(REPRODUCIBILITY_ROUNDS)}회 판정 ${String(Date.now() - started)}ms`,
      );
      expect(report.rounds).toHaveLength(3);
      // 같은 커밋 3회 판정: 안정한 규칙은 세 번 같다 (통과), 흔들리는 규칙은 두 번째만 실패다
      expect(report.rounds.map((round) => round.get(stable.id))).toEqual(['pass', 'pass', 'pass']);
      expect(report.rounds.map((round) => round.get(flaky.id))).toEqual(['pass', 'fail', 'pass']);
      expect(report.unstable).toEqual([flaky.id]);
      // 저장: 흔들린 규칙만 격리 1건 (실행 · 단계 · 케이스 없음, 고정 사유, 판정한 커밋), 안정한 규칙은 기록이 없다
      const stored = write((store) => ({
        flaky: store.judgments.listByRule(flaky.id),
        stable: store.judgments.listByRule(stable.id),
      }));
      expect(stored.stable).toEqual([]);
      expect(stored.flaky).toHaveLength(1);
      expect(stored.flaky[0]).toMatchObject({
        ruleId: flaky.id,
        runId: null,
        stepId: null,
        commit,
        status: 'quarantined',
        runner: 'vitest',
        exitCode: null,
        cases: [],
        quarantineReason: REJUDGE_MISMATCH_REASON,
      });
      expect(REJUDGE_MISMATCH_REASON).toBe('재판정 불일치');
      // 규칙의 판정 상태 (규칙 목록 · 상세가 쓰는 최신 판정)
      expect(toRuleJudgment(stored.flaky[0] ?? null).status).toBe('quarantined');
      // 회차마다 새 판정 폴더 · 판정 대상은 두 규칙 폴더만, 완료되지 않은 판정은 규칙마다 판정 없음
      expect(new Set(results.map((result) => result.judgeId)).size).toBe(3);
      expect(results.map((result) => [result.status, result.ruleIds])).toEqual(
        Array.from({ length: 3 }, () => ['completed', ['RULE-001', 'RULE-002']]),
      );
      const [first] = results;
      if (first === undefined) throw new Error('판정 없음');
      expect([
        ...verdictsOf({ ...first, status: 'runner_error' }, [flaky, stable]).values(),
      ]).toEqual([null, null]);
    },
    ROUNDS_TEST_TIMEOUT_MS,
  );
});
