// 판정 러너 (JDG-01, ADR-026, ADR-051).
// BIVE 전용 vitest 설정으로 인수 테스트(`bive-acceptance/**/*.acc.ts`)를 직접 실행하고 결과만 돌려준다.
// Red · Green 확인 · 판정 저장은 여기서 하지 않는다 (M1-15 · M1-16).
//
// 순서: 판정 폴더 생성 → 설정 · globalSetup 생성 → 인수 테스트 파일 확인 → 수집 단계(서버 없이 파일 로드만)
//      → 스택 프로필로 서버 기동 → vitest 실행 → JSON 해석 → 서버 종료 · 임시 DB 삭제
// 수집 단계를 서버 빌드 앞에 두는 이유: 프로젝트 tsconfig가 인수 테스트를 포함하면 next build의 타입 검사가
// 문법 오류 파일에서 먼저 실패해 collect_error가 runner_error로 바뀌기 때문이다 (ADR-051).
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createUlidGenerator, type JudgmentCase, Ulid } from '@bive/shared';

import { resolveBiveHome } from '../run-paths.js';
import {
  ACCEPTANCE_DIR,
  ACCEPTANCE_SUFFIX,
  BASE_URL_ENV,
  COLLECT_PLACEHOLDER_BASE_URL,
  type JudgeConfigInput,
  JUDGE_FILES,
  renderGlobalSetup,
  renderJudgeConfig,
  RULE_DIR_PATTERN,
} from './config.js';
import { baseChildEnv, Deadline, describeExit, JudgeTimeoutError, runCommand } from './process.js';
import { nextPrismaSqliteProfile } from './profiles/next-prisma-sqlite.js';
import {
  type JudgeProfileName,
  ProfileError,
  type ProfileStep,
  type StackProfile,
  type StartedServer,
} from './profiles/types.js';
import {
  type JudgeProblem,
  type JudgeSummary,
  parseVitestReport,
  ReportFormatError,
  toRelativePath,
} from './report.js';

/**
 * 판정 실행 결과 상태.
 * - `completed`: 케이스 결과가 있음 (통과 · 실패가 섞여도). 해석은 호출자(Red · Green · 검사 단계)
 * - `collect_error`: 파일 로드 오류 · 테스트 0개 파일 · 수집 0개. 케이스 실패와 섞지 않는다 (ADR-026)
 * - `runner_error`: 시간 초과 · 서버 기동 실패 · 실행기 비정상 종료 · 결과 없음
 */
export type JudgeRunStatus = 'completed' | 'collect_error' | 'runner_error';

/** 소요 시간(ms)을 재는 구간. */
export type JudgeTimingStep = 'collect' | ProfileStep | 'vitest' | 'total';

export interface JudgeRunInput {
  /** 프로젝트 ID (ULID) */
  projectId: string;
  /** 실행 ID (ULID) */
  runId: string;
  /** 실행 워크트리 절대 경로 */
  worktreeDir: string;
  profile: JudgeProfileName;
  /** 지정하면 `bive-acceptance/<RULE-ID>/`만 실행. 생략하면 전체 */
  ruleIds?: readonly string[];
  /** 서버 기동부터 vitest 종료까지 전체 제한 시간 */
  timeoutMs: number;
}

export interface JudgeRunPaths {
  /** `$BIVE_HOME/projects/<projectId>/judge/<runId>/<judgeId>/` */
  dir: string;
  /** 실행용 설정 */
  config: string;
  /** 수집 단계 설정 (케이스 본문 · 훅 미실행) */
  collectConfig: string;
  globalSetup: string;
  /** vitest JSON reporter 원본 (실행기가 남긴 경우만 존재) */
  result: string;
  /** 수집 단계 JSON 원본 */
  collectResult: string;
  /** 수집 단계 출력 */
  collectLog: string;
  stdout: string;
  stderr: string;
  /** 마이그레이션 · 빌드 출력 */
  profileLog: string;
  /** 판정 서버 출력 */
  serverLog: string;
}

export interface JudgeRunServerInfo {
  baseUrl: string;
  pid: number | null;
  /** 임시 데이터베이스 경로 (판정 뒤 삭제됨) */
  databasePath: string;
}

export interface JudgeRunResult {
  status: JudgeRunStatus;
  runner: 'vitest';
  profile: JudgeProfileName;
  projectId: string;
  runId: string;
  /** 판정 실행 1회의 ID. 같은 실행의 여러 판정(Red · 구현 뒤 · 검사)이 서로 덮어쓰지 않게 폴더를 나눈다 */
  judgeId: string;
  ruleIds: string[] | null;
  /** vitest 종료 코드 (실행하지 않았거나 신호로 끝나면 `null`) */
  exitCode: number | null;
  cases: JudgmentCase[];
  summary: JudgeSummary;
  /** collect_error · runner_error 원인 (completed면 빈 배열) */
  problems: JudgeProblem[];
  /** 원인 요약 한 줄 (completed면 `null`) */
  message: string | null;
  /** 원본 JSON 경로. JudgmentResult.reporterPath에 쓴다. 결과 파일이 없으면 `null` */
  reporterPath: string | null;
  paths: JudgeRunPaths;
  /** 판정 서버 정보 (기동 전에 끝났으면 `null`) */
  server: JudgeRunServerInfo | null;
  timings: Partial<Record<JudgeTimingStep, number>>;
  startedAt: string;
  endedAt: string;
}

export interface JudgeRunnerOptions {
  /** 기본: `BIVE_HOME` 환경 변수 또는 `~/.bive` */
  biveHome?: string;
  /** 자식 프로세스 환경 변수의 원천 (허용 목록만 넘긴다). 기본 `process.env` */
  env?: NodeJS.ProcessEnv;
}

const PROFILES: Record<JudgeProfileName, StackProfile> = {
  'next-prisma-sqlite': nextPrismaSqliteProfile,
};

const emptySummary = (): JudgeSummary => ({
  files: 0,
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
});

/** 입력 검증. 경로 조작을 막으려고 ID 형식을 확인한다. 위반은 호출자 버그이므로 예외. */
const validateInput = (input: JudgeRunInput): void => {
  if (!Ulid.safeParse(input.projectId).success) {
    throw new TypeError(`projectId가 ULID가 아닙니다: ${input.projectId}`);
  }
  if (!Ulid.safeParse(input.runId).success) {
    throw new TypeError(`runId가 ULID가 아닙니다: ${input.runId}`);
  }
  if (!path.isAbsolute(input.worktreeDir)) {
    throw new TypeError(`worktreeDir는 절대 경로여야 합니다: ${input.worktreeDir}`);
  }
  if (!(input.profile in PROFILES)) {
    throw new TypeError(`지원하지 않는 스택 프로필: ${String(input.profile)}`);
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new TypeError(`timeoutMs는 양수여야 합니다: ${String(input.timeoutMs)}`);
  }
  if (input.ruleIds !== undefined) {
    if (input.ruleIds.length === 0) throw new TypeError('ruleIds가 비어 있습니다');
    for (const id of input.ruleIds) {
      if (!RULE_DIR_PATTERN.test(id)) throw new TypeError(`규칙 ID 형식 오류: ${id}`);
    }
  }
};

/** 디렉터리 아래의 `*.acc.ts` 일반 파일 (워크트리 기준 상대 경로). 없는 디렉터리는 빈 목록. */
const listAcceptanceFiles = async (worktreeDir: string, dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ACCEPTANCE_SUFFIX))
    .map((e) => toRelativePath(worktreeDir, path.join(e.parentPath, e.name)))
    .filter((file) => !file.split('/').includes('node_modules'))
    .sort();
};

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class JudgeRunner {
  readonly #biveHome: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #newId = createUlidGenerator();

  constructor(options: JudgeRunnerOptions = {}) {
    this.#biveHome = options.biveHome ?? resolveBiveHome();
    this.#env = options.env ?? process.env;
  }

  /** 판정 폴더 경로: `$BIVE_HOME/projects/<projectId>/judge/<runId>/<judgeId>/`. */
  judgeDir(projectId: string, runId: string, judgeId: string): string {
    return path.join(this.#biveHome, 'projects', projectId, 'judge', runId, judgeId);
  }

  async run(input: JudgeRunInput): Promise<JudgeRunResult> {
    validateInput(input);
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const deadline = new Deadline(input.timeoutMs, startedMs);
    const worktreeDir = path.resolve(input.worktreeDir);
    const ruleIds = input.ruleIds === undefined ? null : [...input.ruleIds];
    const judgeId = this.#newId();

    const dir = this.judgeDir(input.projectId, input.runId, judgeId);
    const paths: JudgeRunPaths = {
      dir,
      config: path.join(dir, JUDGE_FILES.config),
      collectConfig: path.join(dir, JUDGE_FILES.collectConfig),
      globalSetup: path.join(dir, JUDGE_FILES.globalSetup),
      result: path.join(dir, JUDGE_FILES.result),
      collectResult: path.join(dir, JUDGE_FILES.collectResult),
      collectLog: path.join(dir, JUDGE_FILES.collectLog),
      stdout: path.join(dir, JUDGE_FILES.stdout),
      stderr: path.join(dir, JUDGE_FILES.stderr),
      profileLog: path.join(dir, JUDGE_FILES.profileLog),
      serverLog: path.join(dir, JUDGE_FILES.serverLog),
    };
    // 에이전트 접근 불가 영역 (architecture.md 3장 저장소 배치)
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(paths.globalSetup, renderGlobalSetup(), { mode: 0o600 });
    const configBase: Omit<JudgeConfigInput, 'mode' | 'resultPath'> = {
      worktreeDir,
      judgeDir: dir,
      globalSetupPath: paths.globalSetup,
      cacheDir: path.join(dir, JUDGE_FILES.cacheDir),
      ruleIds,
    };
    await writeFile(
      paths.collectConfig,
      renderJudgeConfig({ ...configBase, mode: 'collect', resultPath: paths.collectResult }),
      { mode: 0o600 },
    );
    await writeFile(
      paths.config,
      renderJudgeConfig({ ...configBase, mode: 'run', resultPath: paths.result }),
      { mode: 0o600 },
    );

    const timings: Partial<Record<JudgeTimingStep, number>> = {};
    let server: StartedServer | undefined;
    let exitCode: number | null = null;

    const finish = async (
      partial: Pick<JudgeRunResult, 'status' | 'cases' | 'summary' | 'problems'>,
    ): Promise<JudgeRunResult> => {
      if (server !== undefined) await server.stop();
      const endedMs = Date.now();
      timings.total = endedMs - startedMs;
      return {
        ...partial,
        runner: 'vitest',
        profile: input.profile,
        projectId: input.projectId,
        runId: input.runId,
        judgeId,
        ruleIds,
        exitCode,
        message:
          partial.status === 'completed'
            ? null
            : partial.problems
                .map((p) => (p.file === null ? p.message : `${p.file}: ${p.message}`))
                .join('\n'),
        reporterPath: existsSync(paths.result) ? paths.result : null,
        paths,
        server:
          server === undefined
            ? null
            : { baseUrl: server.baseUrl, pid: server.pid, databasePath: server.databasePath },
        timings,
        startedAt,
        endedAt: new Date(endedMs).toISOString(),
      };
    };
    const runnerError = (message: string, cases: JudgmentCase[] = [], summary = emptySummary()) =>
      finish({ status: 'runner_error', cases, summary, problems: [{ file: null, message }] });
    const collectError = (problems: JudgeProblem[]) =>
      finish({ status: 'collect_error', cases: [], summary: emptySummary(), problems });

    try {
      const vitestBin = path.join(worktreeDir, 'node_modules', '.bin', 'vitest');
      if (!existsSync(vitestBin)) return await runnerError(`실행 파일 없음: ${vitestBin}`);

      // 인수 테스트 파일이 하나도 없으면 서버를 띄우지 않고 끝낸다 (0개 수집 = collect_error)
      const acceptanceRoot = path.join(worktreeDir, ACCEPTANCE_DIR);
      if (ruleIds === null) {
        const files = await listAcceptanceFiles(worktreeDir, acceptanceRoot);
        if (files.length === 0) {
          return await collectError([
            {
              file: null,
              message: `인수 테스트 파일 없음 (${ACCEPTANCE_DIR}/**/*${ACCEPTANCE_SUFFIX})`,
            },
          ]);
        }
      } else {
        const missing: JudgeProblem[] = [];
        for (const id of ruleIds) {
          const files = await listAcceptanceFiles(worktreeDir, path.join(acceptanceRoot, id));
          if (files.length === 0) {
            missing.push({ file: `${ACCEPTANCE_DIR}/${id}`, message: '인수 테스트 파일 없음' });
          }
        }
        if (missing.length > 0) return await collectError(missing);
      }

      const childEnv = baseChildEnv(this.#env);

      // 수집 단계: 서버 없이 파일을 불러와 로드 오류 · 테스트 0개 · `.only`를 먼저 가린다
      const collectExit = await runCommand(
        vitestBin,
        ['run', '--config', paths.collectConfig, '--root', worktreeDir],
        {
          cwd: worktreeDir,
          env: { ...childEnv, [BASE_URL_ENV]: COLLECT_PLACEHOLDER_BASE_URL, NO_COLOR: '1' },
          stdoutFile: paths.collectLog,
          timeoutMs: deadline.remaining(),
        },
      );
      timings.collect = collectExit.durationMs;
      if (collectExit.timedOut) return await runnerError(new JudgeTimeoutError('collect').message);
      if (collectExit.error !== null || collectExit.signal !== null) {
        return await runnerError(`vitest 수집 ${describeExit(collectExit)}`);
      }
      if (!existsSync(paths.collectResult)) {
        return await runnerError(`vitest 수집 ${describeExit(collectExit)}, 결과 파일 없음`);
      }
      const collected = parseVitestReport(await readFile(paths.collectResult, 'utf8'), worktreeDir);
      // 수집 단계에서는 어떤 케이스도 실행되지 않아야 한다. 실패로 표시된 케이스(`.only` 등)는 수집 문제다
      const collectProblems = [
        ...collected.collectProblems,
        ...collected.cases
          .filter((c) => c.status === 'failed')
          .map((c) => ({ file: c.file, message: `${c.name}: ${c.message ?? '수집 실패'}` })),
      ];
      if (collectProblems.length > 0) return await collectError(collectProblems);

      server = await PROFILES[input.profile].start({
        worktreeDir,
        env: childEnv,
        profileLog: paths.profileLog,
        serverLog: paths.serverLog,
        deadline,
        onStep: (step, ms) => (timings[step] = ms),
      });

      const exit = await runCommand(
        vitestBin,
        ['run', '--config', paths.config, '--root', worktreeDir],
        {
          cwd: worktreeDir,
          env: { ...childEnv, [BASE_URL_ENV]: server.baseUrl, NO_COLOR: '1' },
          stdoutFile: paths.stdout,
          stderrFile: paths.stderr,
          timeoutMs: deadline.remaining(),
        },
      );
      timings.vitest = exit.durationMs;
      exitCode = exit.code;
      if (exit.timedOut) return await runnerError(new JudgeTimeoutError('vitest').message);
      if (exit.error !== null || exit.signal !== null) {
        return await runnerError(`vitest ${describeExit(exit)}`);
      }
      if (!existsSync(paths.result)) {
        return await runnerError(`vitest ${describeExit(exit)}, 결과 파일 없음`);
      }

      const report = parseVitestReport(await readFile(paths.result, 'utf8'), worktreeDir);
      if (report.collectProblems.length > 0) {
        return await finish({
          status: 'collect_error',
          cases: report.cases,
          summary: report.summary,
          problems: report.collectProblems,
        });
      }
      // 종료 코드가 0이 아닌데 실패 케이스가 없으면(처리되지 않은 오류 등) 결과를 믿지 않는다
      if (exit.code !== 0 && report.summary.failed === 0) {
        return await runnerError(
          `vitest ${describeExit(exit)}, 실패 케이스 없음 (처리되지 않은 오류 가능)`,
          report.cases,
          report.summary,
        );
      }
      return await finish({
        status: 'completed',
        cases: report.cases,
        summary: report.summary,
        problems: [],
      });
    } catch (err) {
      if (
        err instanceof ProfileError ||
        err instanceof JudgeTimeoutError ||
        err instanceof ReportFormatError
      ) {
        return await runnerError(err.message);
      }
      if (server !== undefined) await server.stop();
      throw new Error(`판정 러너 내부 오류: ${describeError(err)}`, { cause: err });
    }
  }
}
