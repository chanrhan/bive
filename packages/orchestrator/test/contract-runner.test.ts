// OpenAPI 계약 검사 실행기 · 검사 단계의 계약 판정 (M3-47 #292 수용 기준 1 · 2 · 3, NRM-03 · JDG-01 · RUN-02, ADR-033 · ADR-130 ⑤,
// ADR-132).
// - 문서 사전 검사 · `@redocly/cli lint` · 기록 프록시 · `@stoplight/prism-cli proxy --errors` 재생 검증 (실제 도구)
// - 두 도구가 대상 프로젝트의 설정 · 플러그인 코드를 실행하지 않고 네트워크로 나가지 않는다: 대조군(방어 없이 도구를 직접 부름)은
//   실행 · 요청이 생기고, 실행기를 거치면 생기지 않는다(`parser/test/isolation.test.ts` 방식)
// - 검사 단계: 계약 검사 규칙을 종류별 실행기로 판정해 기록을 남기고, 실행기가 없는 종류(DB 스키마 · AsyncAPI)는 판정 없음으로
//   남아 통과로 세지 않으며 다른 규칙을 막지 않는다 (픽스처 git 복사본 · 실제 SQLite · 실제 git · 실제 도구, 판정 러너만 주입)
// - 실제 판정 서버(픽스처 next build): 원본에서 `pass`, `contract-mismatch` 변형(응답 필드 타입 위반)에서 `fail`
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { type Contract, createUlidGenerator, type JudgmentResult, type Rule } from '@bive/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  disposePrepared,
  prepareOpenApiContract,
  verifyOpenApiTraffic,
} from '../src/contract-check/openapi.js';
import { isPlainSchemaName, readOpenApiDocument } from '../src/contract-check/openapi-document.js';
import {
  classifyExchange,
  EXCHANGE_HEADER,
  type ExchangeVerdict,
  prismArgs,
  validateWithPrism,
} from '../src/contract-check/prism.js';
import { ExchangeRecorder, type RecordedExchange } from '../src/contract-check/recorder.js';
import { lintArgs, lintOpenApi, REDOCLY_CONFIG } from '../src/contract-check/redocly.js';
import {
  ContractToolError,
  PRISM_ENTRY,
  REDOCLY_ENTRY,
  toolEnv,
} from '../src/contract-check/tool.js';
import type { JudgingOptions } from '../src/steps/judging.js';
import { JudgeRunner } from '../src/judge/runner.js';
import { readContractSource, registerHumanContract } from '../src/norms/contract.js';
import { createCheckExecutor } from '../src/steps/check.js';
import { createMergeExecutor } from '../src/steps/merge.js';
import {
  disposeContracts,
  finishContracts,
  missingContractVerdicts,
  prepareContracts,
  trafficVerdict,
} from '../src/steps/contract-check.js';
import { verificationSummary } from '../src/verification/summary.js';
import { human, userGit, withProject } from './helpers/engine-harness.js';
import {
  exitOf,
  fakeInstall,
  injectedJudge,
  type JudgeCall,
  type PipelineHarness,
  runToEnd,
  setupPipeline,
} from './helpers/pipeline-harness.js';
import { cleanup, REPO_ROOT } from './helpers/process.js';

const newId = createUlidGenerator();
const ORCHESTRATOR_SRC = path.join(REPO_ROOT, 'packages', 'orchestrator', 'src');
const FIXTURE_OPENAPI = fs.readFileSync(
  path.join(REPO_ROOT, 'fixtures', 'sample-next-app', 'openapi.yaml'),
  'utf8',
);

const temps: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix = 'bive-cr-'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

/** 127.0.0.1의 시험 서버 (받은 요청 경로를 센다). */
const listen = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; hits: string[] }> => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, hits };
};

/** 픽스처 API를 흉내 내는 판정 서버. `mismatch`면 `/api/health`의 `ok`가 글이다(`contract-mismatch` 변형과 같은 위반). */
/** 헬스 체크 응답을 바꿔 넣는 구현 (판정받는 구현이 고르는 응답 모양). */
type HealthResponder = (res: http.ServerResponse) => void;

const fakeApi = (mismatch: boolean | HealthResponder = false) =>
  listen((req, res) => {
    if (req.url === '/api/health' && typeof mismatch === 'function') {
      mismatch(res);
    } else if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: mismatch ? 'yes' : true }));
    } else if (req.url === '/api/auth/session') {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ authenticated: false }));
    } else {
      res.setHeader('content-type', 'text/plain');
      res.end('계약 밖');
    }
  });

/** 프로세스 명령줄 · 작업 폴더에 `dir`이 든 프로세스 (Linux /proc). */
const processesIn = (dir: string): string[] => {
  if (process.platform !== 'linux') return [];
  const found: string[] = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      let cwd = '';
      try {
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // 권한 없음 · 이미 끝남
      }
      if (cmdline.includes(dir) || cwd === dir) found.push(pid);
    } catch {
      // 이미 끝남
    }
  }
  return found;
};

const waitGone = async (dir: string): Promise<string[]> => {
  const deadline = Date.now() + 3_000;
  while (processesIn(dir).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return processesIn(dir);
};

const never = new AbortController().signal;

/** 도구 폴더에 문서 사본을 두고 lint한다. */
const lintText = async (text: string, options: { entry?: string; timeoutMs?: number } = {}) => {
  const toolDir = tempDir();
  fs.writeFileSync(path.join(toolDir, 'contract.yaml'), text);
  return lintOpenApi({ toolDir, documentFile: 'contract.yaml', signal: never, ...options });
};

/** 시험용 가짜 도구 (진입 파일). */
const fakeTool = (source: string): string => {
  const file = path.join(tempDir('bive-cr-tool-'), 'tool.mjs');
  fs.writeFileSync(file, source);
  return file;
};

/** 기록된 교환 하나 (단위 시험용). */
const exchange = (overrides: Partial<RecordedExchange> = {}): RecordedExchange => ({
  index: 0,
  method: 'GET',
  target: '/api/health',
  requestHeaders: [['accept', 'application/json']],
  requestBody: Buffer.alloc(0),
  status: 200,
  responseHeaders: [['content-type', 'application/json']],
  responseBody: Buffer.from('{"ok":true}'),
  complete: true,
  ...overrides,
});

// ── 문서 사전 검사 (바깥 참조) ─────────────────────────────

describe('계약 문서의 바깥 참조는 도구를 부르기 전에 데이터로 막는다 (ADR-132 ③)', () => {
  it('원격 · 파일 $ref, $dynamicRef · $recursiveRef · operationRef의 바깥 값, externalValue, 글이 아닌 $ref는 바깥 참조이고 문서 안 참조(#)는 받는다', () => {
    const doc = (body: string) => `openapi: 3.1.0\ninfo:\n  title: t\n  version: '1'\n${body}`;
    expect(readOpenApiDocument(FIXTURE_OPENAPI)).toEqual({ kind: 'ok', hasPaths: true });
    expect(
      readOpenApiDocument(
        doc(
          "paths: {}\ncomponents:\n  schemas:\n    A:\n      type: object\n    B:\n      $ref: '#/components/schemas/A'\n",
        ),
      ),
    ).toEqual({ kind: 'ok', hasPaths: false });
    const cases: [string, string][] = [
      ["components:\n  schemas:\n    A:\n      $ref: 'http://127.0.0.1:9/a.yaml'\n", '$ref'],
      ["components:\n  schemas:\n    A:\n      $ref: './parts.yaml#/A'\n", '$ref'],
      ["components:\n  schemas:\n    A:\n      $ref: '../../etc/x.yaml'\n", '$ref'],
      ['components:\n  schemas:\n    A:\n      $ref:\n        nested: 1\n', '$ref'],
      ["components:\n  schemas:\n    A:\n      $dynamicRef: 'https://x/a'\n", '$dynamicRef'],
      ["components:\n  schemas:\n    A:\n      $recursiveRef: 'x.yaml'\n", '$recursiveRef'],
      [
        "components:\n  links:\n    L:\n      operationRef: 'https://x/openapi.yaml#/paths'\n",
        'operationRef',
      ],
      [
        "components:\n  examples:\n    E:\n      externalValue: 'http://127.0.0.1:9/e.json'\n",
        'externalValue',
      ],
    ];
    for (const [body, key] of cases) {
      const read = readOpenApiDocument(doc(body));
      expect(read, body).toMatchObject({ kind: 'external', total: 1 });
      expect(read.kind === 'external' ? read.references[0]?.key : null, body).toBe(key);
    }
  });

  it('읽지 못하는 문서(문법 · 중복 키 · 별칭 · 여러 문서 · 객체가 아닌 최상위)는 문서 형식 오류다', () => {
    for (const text of [
      'openapi: [3.1.0\n',
      'openapi: 3.1.0\nopenapi: 3.0.0\n',
      'a: &x {k: 1}\nb: *x\n',
      'openapi: 3.1.0\n---\nopenapi: 3.0.0\n',
      '- 1\n- 2\n',
      '',
    ]) {
      expect(readOpenApiDocument(text).kind, text).toBe('unreadable');
    }
  });
});

// ── 도구 실행 ─────────────────────────────────────────

describe('@redocly/cli lint (문서 유효성, ADR-033)', () => {
  it('BIVE 설정 명시 · JSON 출력으로 부르고, 픽스처 문서는 오류 0건, 형식이 틀린 문서는 오류 문제를 돌려준다', async () => {
    expect(lintArgs('contract.yaml', '/c.yaml')).toEqual([
      'lint',
      'contract.yaml',
      '--config',
      '/c.yaml',
      '--lint-config',
      'off',
      '--format',
      'json',
      '--max-problems',
      '100',
    ]);
    expect(REDOCLY_CONFIG).toBe('extends:\n  - spec\ntelemetry: off\n');
    expect(await lintText(FIXTURE_OPENAPI)).toEqual({ errors: 0, warnings: 0, problems: [] });
    const bad = await lintText('openapi: 3.1.0\npaths:\n  /a:\n    get: {}\n');
    expect(bad.errors).toBeGreaterThan(0);
    expect(bad.problems[0]).toMatchObject({ ruleId: 'struct' });
  }, 60_000);

  it('도구의 오류는 통과로 읽히지 않는다: 예상 밖 종료 코드 · JSON 아님 · 다른 모양 · 오류 수와 종료 코드 불일치(종료 코드만 믿지 않음) · 출력 상한 · 시간 초과', async () => {
    const out = (totals: object, code: number) =>
      fakeTool(
        `process.stdout.write(JSON.stringify({ totals: ${JSON.stringify(totals)}, problems: [] }));\nprocess.exit(${String(code)});\n`,
      );
    const reject = async (entry: string, code: ContractToolError['code'], timeoutMs?: number) => {
      const error = await lintText(FIXTURE_OPENAPI, {
        entry,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }).catch((e: unknown) => e);
      expect(error, entry).toBeInstanceOf(ContractToolError);
      expect((error as ContractToolError).code).toBe(code);
    };
    await reject(fakeTool('process.exit(2);\n'), 'unexpected_exit');
    await reject(fakeTool("process.stdout.write('{');\n"), 'output_invalid');
    await reject(fakeTool('process.stdout.write(\'{"problems":[]}\');\n'), 'output_invalid');
    // 오류가 있는데 종료 코드 0 · 오류가 없는데 종료 코드 1 · 오류 수가 있는데 오류 문제가 없음
    await reject(out({ errors: 2, warnings: 0, ignored: 0 }, 0), 'output_invalid');
    await reject(out({ errors: 0, warnings: 0, ignored: 0 }, 1), 'output_invalid');
    await reject(out({ errors: 1, warnings: 0, ignored: 0 }, 1), 'output_invalid');
    await reject(
      fakeTool("process.stdout.write('x'.repeat(9 * 1024 * 1024));\n"),
      'output_too_large',
    );
    await reject(fakeTool('setInterval(() => {}, 1000);\n'), 'timeout', 500);
    // 대조: 같은 꼴의 정상 출력은 받는다
    expect(
      await lintText(FIXTURE_OPENAPI, { entry: out({ errors: 0, warnings: 3, ignored: 0 }, 0) }),
    ).toEqual({ errors: 0, warnings: 3, problems: [] });
  }, 60_000);

  it('중단 신호가 오면 도구 프로세스를 끝내고 신호의 사유로 거부한다', async () => {
    const toolDir = tempDir();
    fs.writeFileSync(path.join(toolDir, 'contract.yaml'), FIXTURE_OPENAPI);
    const entry = fakeTool('setInterval(() => {}, 1000);\n');
    const controller = new AbortController();
    const running = lintOpenApi({
      toolDir,
      documentFile: 'contract.yaml',
      signal: controller.signal,
      entry,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processesIn(entry)).toHaveLength(1);
    controller.abort(new Error('중단 사유'));
    await expect(running).rejects.toThrow('중단 사유');
    expect(await waitGone(entry)).toEqual([]);
  }, 30_000);
});

describe('도구 자식 프로세스 (ADR-132 ②)', () => {
  it('진입 파일은 오케스트레이터 패키지의 의존성이고, 환경 변수는 부모 값을 넘기지 않는 고정 값뿐이다 (프록시 · NODE_OPTIONS 없음)', () => {
    const orchestratorModules = path.join(REPO_ROOT, 'packages', 'orchestrator', 'node_modules');
    expect(fs.realpathSync(REDOCLY_ENTRY)).toBe(
      fs.realpathSync(path.join(orchestratorModules, '@redocly', 'cli', 'bin', 'cli.js')),
    );
    expect(fs.realpathSync(PRISM_ENTRY)).toBe(
      fs.realpathSync(
        path.join(orchestratorModules, '@stoplight', 'prism-cli', 'dist', 'index.js'),
      ),
    );
    const fixed = {
      HOME: '/도구',
      REDOCLY_TELEMETRY: 'off',
      REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true',
      DO_NOT_TRACK: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
    expect(toolEnv('/도구', { node: '22' } as NodeJS.ProcessVersions)).toEqual(fixed);
    expect(
      toolEnv('/도구', { node: '22', electron: '40' } as unknown as NodeJS.ProcessVersions),
    ).toEqual({ ...fixed, ELECTRON_RUN_AS_NODE: '1' });
  });
});

// ── 격리: 대상 프로젝트의 코드를 실행하지 않는다 · 네트워크로 나가지 않는다 ─────────

/** 실행되면 표식 파일을 남기는 redocly 설정 · 플러그인을 심은 프로젝트(git 저장소)와 그 커밋. */
const plantedProject = () => {
  const markers = tempDir('bive-cr-markers-');
  const root = tempDir('bive-cr-project-');
  const plugin = (name: string) =>
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(markers, name))}, 'ran');\nmodule.exports = { id: ${JSON.stringify(name)} };\n`;
  const files: Record<string, string> = {
    'openapi.yaml': FIXTURE_OPENAPI,
    'redocly.yaml': 'plugins:\n  - ./evil-plugin.cjs\nextends:\n  - recommended\n',
    'evil-plugin.cjs': plugin('redocly-yaml'),
    '.redocly.yaml': 'plugins:\n  - ./evil-dot.cjs\n',
    'evil-dot.cjs': plugin('dot-redocly-yaml'),
    'redocly.yml': 'plugins:\n  - ./evil-yml.cjs\n',
    'evil-yml.cjs': plugin('redocly-yml'),
  };
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('add', '--all');
  git('commit', '-q', '-m', 'init');
  return { root, markers, commit: git('rev-parse', 'HEAD') };
};

const markersIn = (dir: string): string[] => fs.readdirSync(dir).sort();

/** 도구를 방어 없이 직접 부른다 (대조군). */
const runDirect = (
  entry: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; killAfterMs?: number },
): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'ignore',
    });
    const timer =
      options.killAfterMs === undefined
        ? undefined
        : setTimeout(() => child.kill('SIGKILL'), options.killAfterMs);
    child.on('exit', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(code);
    });
  });

describe('두 도구는 대상 프로젝트의 설정 · 플러그인 코드를 실행하지 않는다 (수용 기준 3, 대조군)', () => {
  it('대조군: 작업 폴더가 프로젝트면 redocly가 redocly.yaml의 플러그인 JS를 실행한다', async () => {
    const { root, markers } = plantedProject();
    await runDirect(REDOCLY_ENTRY, ['lint', 'openapi.yaml', '--format', 'json'], {
      cwd: root,
      env: { REDOCLY_TELEMETRY: 'off' },
    });
    expect(markersIn(markers)).toEqual(['redocly-yaml']);
  }, 60_000);

  it('실행기(등록 커밋의 git 객체 → 빈 도구 폴더의 사본 · BIVE 설정)로 lint와 prism 검증을 해도 아무것도 실행되지 않는다', async () => {
    const { root, markers, commit } = plantedProject();
    const source = await readContractSource(root, 'main', 'openapi.yaml');
    if (!source.ok) throw new Error(source.code);
    expect(source.commit).toBe(commit);
    // 검사 단계와 같은 입구: 등록 커밋의 git 객체에서 읽고(저장소 = 심은 프로젝트) 도구를 부른다
    const item = {
      rule: { id: newId(), displayId: 'RULE-002' } as Rule,
      contract: {
        id: newId(),
        displayId: 'CON-001',
        kind: 'openapi',
        sourceFile: 'openapi.yaml',
        contentHash: source.contentHash,
        sourceCommit: commit,
      } as Contract,
      runner: 'openapi' as const,
    };
    const prepared = await prepareContracts(root, commit, { items: [item] }, { signal: never });
    if (prepared.kind !== 'prepared') throw new Error(prepared.code);
    try {
      // lint 뒤: 심은 설정 · 플러그인이 실행되지 않았다
      expect(markersIn(markers)).toEqual([]);
      const [entry] = prepared.prepared.items;
      expect(entry).toMatchObject({ kind: 'openapi', sourceAtCommit: 'same' });
      const doc = entry?.kind === 'openapi' ? entry.prepared : null;
      if (doc?.kind !== 'ready') throw new Error('준비되지 않음');
      // 도구 폴더는 프로젝트 밖의 빈 폴더이고 사본 · BIVE 설정만 있다
      expect(doc.toolDir.startsWith(root)).toBe(false);
      expect(fs.readdirSync(doc.toolDir).sort()).toEqual(['bive-redocly.yaml', 'contract.yaml']);
      const run = await finishContracts(
        prepared.prepared,
        { exchanges: [exchange()], overflow: 0 },
        { signal: never },
      );
      expect(run).toMatchObject({ kind: 'judged', verdicts: [{ kind: 'judged', status: 'pass' }] });
    } finally {
      disposeContracts(prepared.prepared);
    }
    expect(markersIn(markers)).toEqual([]);
  }, 60_000);

  it('부모의 NODE_OPTIONS · 프록시 환경 변수는 도구에 넘어가지 않는다 (대조군: 넘기면 --require가 실행됨)', async () => {
    const markers = tempDir('bive-cr-markers-');
    const preload = path.join(tempDir(), 'preload.cjs');
    fs.writeFileSync(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(markers, 'node-options'))}, 'ran');\n`,
    );
    const saved = { ...process.env };
    const planted = {
      NODE_OPTIONS: `--require ${preload}`,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
    };
    Object.assign(process.env, planted);
    try {
      // 대조군: 부모 환경을 그대로 넘기면 실행된다
      const toolDir = tempDir();
      fs.writeFileSync(path.join(toolDir, 'contract.yaml'), FIXTURE_OPENAPI);
      await runDirect(REDOCLY_ENTRY, ['lint', 'contract.yaml', '--format', 'json'], {
        cwd: toolDir,
        env: process.env,
      });
      expect(markersIn(markers)).toEqual(['node-options']);
      fs.rmSync(path.join(markers, 'node-options'));
      // 실행기: lint · prism 모두 실행되지 않는다
      expect((await lintText(FIXTURE_OPENAPI)).errors).toBe(0);
      const prepared = await prepareOpenApiContract(FIXTURE_OPENAPI, {
        sourceFile: 'openapi.yaml',
        signal: never,
      });
      try {
        if (prepared.kind !== 'ready') throw new Error(prepared.kind);
        await verifyOpenApiTraffic(prepared, [exchange()], { signal: never });
      } finally {
        disposePrepared(prepared);
      }
      expect(markersIn(markers)).toEqual([]);
    } finally {
      for (const key of Object.keys(planted)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }, 60_000);
});

describe('두 도구는 네트워크로 나가지 않는다: 문서의 원격 $ref를 받아 오지 않는다 (수용 기준 3, 대조군)', () => {
  const remoteDoc = (url: string) =>
    FIXTURE_OPENAPI.replace(
      '              schema:\n                type: object\n                required: [ok]',
      `              schema:\n                $ref: '${url}/health.yaml'`,
    );

  it('대조군: 방어 없이 부르면 redocly lint와 prism proxy 모두 127.0.0.1 시험 서버에서 원격 $ref를 받아 온다', async () => {
    const remote = await listen((_req, res) => {
      res.setHeader('content-type', 'application/yaml');
      res.end('type: object\n');
    });
    const toolDir = tempDir();
    fs.writeFileSync(path.join(toolDir, 'contract.yaml'), remoteDoc(remote.url));
    fs.writeFileSync(path.join(toolDir, 'c.yaml'), REDOCLY_CONFIG);
    await runDirect(REDOCLY_ENTRY, lintArgs('contract.yaml', path.join(toolDir, 'c.yaml')), {
      cwd: toolDir,
      env: toolEnv(toolDir),
    });
    expect(remote.hits).toEqual(['/health.yaml']);
    remote.hits.length = 0;
    await runDirect(PRISM_ENTRY, prismArgs('contract.yaml', 'http://127.0.0.1:9'), {
      cwd: toolDir,
      env: toolEnv(toolDir),
      killAfterMs: 8_000,
    });
    expect(remote.hits.length).toBeGreaterThan(0);
  }, 60_000);

  it('실행기는 원격 · 파일 $ref가 있으면 도구를 부르지 않고 판정 없음(바깥 참조)으로 끝낸다: 시험 서버는 요청을 받지 않는다', async () => {
    const remote = await listen((_req, res) => res.end('type: object\n'));
    const prepared = await prepareOpenApiContract(remoteDoc(remote.url), {
      sourceFile: 'openapi.yaml',
      signal: never,
    });
    expect(prepared).toMatchObject({ kind: 'external', total: 1 });
    const file = await prepareOpenApiContract(remoteDoc('./parts'), {
      sourceFile: 'openapi.yaml',
      signal: never,
    });
    expect(file).toMatchObject({ kind: 'external', total: 1 });
    expect(remote.hits).toEqual([]);
  }, 30_000);
});

// ── 기록 프록시 · prism 재생 검증 ───────────────────────────

describe('판정 서버 앞 기록 프록시 (판정 러너의 프록시 자리)', () => {
  it('요청 · 응답을 바꾸지 않고 넘기며(상태 · 머리 · 본문 · 계약 밖 경로) 교환을 도착 순으로 기록하고, 멈추면 포트를 닫는다', async () => {
    const api = await fakeApi();
    const recorder = new ExchangeRecorder();
    const proxy = await recorder.start({ upstreamBaseUrl: api.url });
    expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const direct = await fetch(`${api.url}/api/auth/session`);
    const viaProxy = await fetch(`${proxy.baseUrl}/api/auth/session`);
    expect(viaProxy.status).toBe(direct.status);
    expect(viaProxy.headers.get('content-type')).toBe(direct.headers.get('content-type'));
    expect(await viaProxy.text()).toBe(await direct.text());
    const posted = await fetch(`${proxy.baseUrl}/api/other?q=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(await posted.text()).toBe('계약 밖');
    await proxy.stop();
    expect(
      recorder.exchanges().map((item) => [item.index, item.method, item.target, item.status]),
    ).toEqual([
      [0, 'GET', '/api/auth/session', 401],
      [1, 'POST', '/api/other?q=1', 200],
    ]);
    expect(recorder.exchanges()[1]?.requestBody.toString()).toBe('{"a":1}');
    expect(recorder.exchanges().every((item) => item.complete)).toBe(true);
    await expect(fetch(`${proxy.baseUrl}/api/health`)).rejects.toThrow();
  });

  it('상한을 넘은 교환은 그대로 넘기되 기록 불완전 · 넘침으로 남는다', async () => {
    const api = await fakeApi();
    const recorder = new ExchangeRecorder({ maxExchanges: 1, maxBodyBytes: 4 });
    const proxy = await recorder.start({ upstreamBaseUrl: api.url });
    expect(await (await fetch(`${proxy.baseUrl}/api/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${proxy.baseUrl}/api/health`)).json()).toEqual({ ok: true });
    await proxy.stop();
    expect(recorder.exchanges().map((item) => item.complete)).toEqual([false]);
    expect(recorder.overflow()).toBe(1);
  });
});

describe('@stoplight/prism-cli proxy --errors 재생 검증 (ADR-033 · ADR-132 ④)', () => {
  it('prism을 proxy · --errors · 127.0.0.1 임의 포트로 부른다', () => {
    expect(prismArgs('contract.yaml', 'http://127.0.0.1:1')).toEqual([
      'proxy',
      'contract.yaml',
      'http://127.0.0.1:1',
      '-h',
      '127.0.0.1',
      '-p',
      '0',
      '--errors',
      '--validate-request=false',
      '--cors=false',
      '--multiprocess=false',
    ]);
  });

  it('교환 판정: 넘긴 교환의 위반(오류 · 경고) · 통과 · 상태가 다름, 넘기지 않은 교환의 계약 밖(404 · 405) · 그 밖 오류, 읽지 못한 위반 목록은 위반', () => {
    const problem = (type: string, status: number) => ({
      status,
      headers: { 'content-type': 'application/problem+json' },
      body: JSON.stringify({ type: `https://stoplight.io/prism/errors#${type}`, status }),
    });
    const ok = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
    const violation = JSON.stringify([
      { location: ['response', 'body', 'ok'], severity: 'Error', message: 'must be boolean' },
      { location: ['request', 'query'], severity: 'Error', message: '요청은 보지 않음' },
    ]);
    const warning = JSON.stringify([
      { location: ['response'], severity: 'Warning', message: 'Unable to match status code' },
    ]);
    const x = exchange();
    expect(classifyExchange(x, true, ok).outcome).toBe('ok');
    expect(
      classifyExchange(x, true, {
        ...problem('VIOLATIONS', 500),
        headers: { 'sl-violations': violation },
      }),
    ).toMatchObject({
      outcome: 'violation',
      violations: [{ location: 'response.body.ok', severity: 'Error', message: 'must be boolean' }],
    });
    expect(
      classifyExchange(x, true, { ...ok, headers: { 'sl-violations': warning } }).outcome,
    ).toBe('violation');
    expect(
      classifyExchange(x, true, { ...ok, headers: { 'sl-violations': 'Too many violations! [' } }),
    ).toMatchObject({ outcome: 'violation', truncated: true });
    expect(
      classifyExchange(x, true, { ...ok, headers: { 'sl-violations': '{깨짐' } }).outcome,
    ).toBe('violation');
    expect(classifyExchange(x, true, { ...ok, status: 500 }).outcome).toBe('unverified');
    expect(classifyExchange(x, false, problem('NO_PATH_MATCHED_ERROR', 404)).outcome).toBe(
      'outside',
    );
    expect(classifyExchange(x, false, problem('NO_METHOD_MATCHED_ERROR', 405)).outcome).toBe(
      'outside',
    );
    expect(classifyExchange(x, false, problem('UNAUTHORIZED', 401)).outcome).toBe('unverified');
    // 넘겨졌으면 구현 응답이 prism의 "계약 밖" 모양을 흉내 내도 계약 밖이 아니다 (재생 서버 쪽에서 센다)
    expect(
      classifyExchange(exchange({ status: 404 }), true, problem('NO_PATH_MATCHED_ERROR', 404))
        .outcome,
    ).toBe('ok');
    expect(classifyExchange(x, false, ok).outcome).toBe('unverified');
  });

  it('실제 prism: 맞는 응답은 통과, 응답 필드 타입 위반 · 계약에 없는 상태 코드는 위반, 계약 밖 경로 · 메서드는 계약 밖, 기록 불완전은 검증하지 못함. 끝나면 prism과 재생 서버를 정리한다', async () => {
    const toolDir = tempDir();
    fs.writeFileSync(path.join(toolDir, 'contract.yaml'), FIXTURE_OPENAPI);
    const result = await validateWithPrism({
      toolDir,
      documentFile: 'contract.yaml',
      signal: never,
      exchanges: [
        exchange({ index: 0 }),
        exchange({ index: 1, responseBody: Buffer.from('{"ok":"yes"}') }),
        exchange({ index: 2, status: 299 }),
        exchange({ index: 3, target: '/api/other' }),
        exchange({ index: 4, method: 'POST', target: '/api/health' }),
        exchange({
          index: 5,
          target: '/api/auth/session',
          status: 401,
          responseBody: Buffer.from('{"authenticated":false}'),
        }),
        exchange({ index: 6, complete: false }),
        // 테스트가 보낸 교환 번호 머리는 지우고 BIVE가 다시 붙인다
        exchange({ index: 7, requestHeaders: [[EXCHANGE_HEADER, '1']] }),
      ],
    });
    expect(result.exchanges.map((item) => [item.index, item.outcome])).toEqual([
      [0, 'ok'],
      [1, 'violation'],
      [2, 'violation'],
      [3, 'outside'],
      [4, 'outside'],
      [5, 'ok'],
      [6, 'unverified'],
      [7, 'ok'],
    ]);
    expect(result.exchanges[1]?.violations).toEqual([
      expect.objectContaining({ location: 'response.body.ok', severity: 'Error' }),
    ]);
    expect(await waitGone(toolDir)).toEqual([]);
  }, 60_000);

  it('prism을 띄우지 못하거나(기동 전 종료) 제한 시간을 넘으면 도구 오류, 중단이면 신호의 사유로 거부하고 어느 경우든 프로세스를 남기지 않는다', async () => {
    const toolDir = tempDir();
    fs.writeFileSync(path.join(toolDir, 'contract.yaml'), FIXTURE_OPENAPI);
    const run = (entry: string, signal: AbortSignal = never, timeoutMs?: number) =>
      validateWithPrism({
        toolDir,
        documentFile: 'contract.yaml',
        signal,
        exchanges: [exchange()],
        entry,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    const exits = fakeTool('process.exit(0);\n');
    await expect(run(exits)).rejects.toMatchObject({ code: 'start_failed' });
    const hangs = fakeTool('setInterval(() => {}, 1000);\n');
    await expect(run(hangs, never, 500)).rejects.toMatchObject({ code: 'timeout' });
    expect(await waitGone(hangs)).toEqual([]);
    const controller = new AbortController();
    const running = run(hangs, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort(new Error('중단 사유'));
    await expect(running).rejects.toThrow('중단 사유');
    expect(await waitGone(hangs)).toEqual([]);
  }, 30_000);
});

// ── 검사 단계 연결 ──────────────────────────────────────

const temps2: string[] = [];
const engines: Parameters<typeof setupPipeline>[0]['engines'] = [];
afterAll(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps2.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

/** 판정 러너 주입: 프록시 자리가 있으면 가짜 판정 서버 앞에 끼우고 `traffic`을 보낸다(실제 판정 러너가 하는 것과 같은 순서). */
const trafficJudge = (
  calls: JudgeCall[],
  options: {
    readonly mismatch?: boolean | HealthResponder;
    /** 이 단계(검사 · 병합)에서만 `mismatch`를 쓴다 (기본 모든 단계) */
    readonly mismatchIn?: 'check' | 'merge';
    readonly traffic?: (baseUrl: string) => Promise<void>;
    readonly proxied?: boolean[];
  } = {},
): NonNullable<JudgingOptions['judge']> => {
  const base = injectedJudge(calls);
  return async (input, context) => {
    options.proxied?.push(Object.hasOwn(input, 'serverProxy'));
    if (input.serverProxy !== undefined) {
      const applies = options.mismatchIn === undefined || options.mismatchIn === context.step.kind;
      const api = await fakeApi(applies ? (options.mismatch ?? false) : false);
      const proxy = await input.serverProxy.start({ upstreamBaseUrl: api.url });
      try {
        await (
          options.traffic ??
          (async (url) => {
            await fetch(`${url}/api/health`).then((res) => res.text());
            await fetch(`${url}/api/auth/session`).then((res) => res.text());
            await fetch(`${url}/api/other`).then((res) => res.text());
          })
        )(proxy.baseUrl);
      } finally {
        await proxy.stop();
      }
    }
    return base(input, context);
  };
};

/** 계약 파일을 커밋한 픽스처 파이프라인 + 사람이 등록한 계약. */
const contractPipeline = async (
  contracts: readonly { file: string; kind: 'openapi' | 'db-schema' | 'asyncapi'; text?: string }[],
  judge: (calls: JudgeCall[]) => NonNullable<JudgingOptions['judge']>,
  extra: JudgingOptions = {},
  /** 병합 단계도 같은 판정 주입으로 바꾸고, 병합 전에 기준 브랜치를 바꿔 재검사가 돌게 한다 */
  mergeRecheck = false,
): Promise<{ h: PipelineHarness; rules: Rule[]; checkCalls: JudgeCall[] }> => {
  const checkCalls: JudgeCall[] = [];
  const mergeCalls: JudgeCall[] = [];
  const h = setupPipeline({
    temps: temps2,
    engines,
    ...(contracts.some((item) => item.text !== undefined)
      ? {
          prepareRepo: (repo: string) => {
            for (const item of contracts) {
              if (item.text !== undefined) fs.writeFileSync(path.join(repo, item.file), item.text);
            }
          },
        }
      : {}),
    executors: (defaults) => ({
      ...defaults,
      check: createCheckExecutor({
        judge: judge(checkCalls),
        installDependencies: fakeInstall,
        ...extra,
      }),
      ...(mergeRecheck
        ? {
            merge: async (context) => {
              fs.writeFileSync(path.join(context.git.repoPath, 'USER-NOTE.md'), '사용자\n');
              userGit(context.git.repoPath, 'add', 'USER-NOTE.md');
              userGit(context.git.repoPath, 'commit', '-q', '-m', '사용자 커밋');
              return createMergeExecutor({
                judge: judge(mergeCalls),
                installDependencies: fakeInstall,
                checkTimeoutMs: 90_000,
                ...extra,
              })(context);
            },
          }
        : {}),
    }),
  });
  const rules: Rule[] = [];
  for (const item of contracts) {
    const source = await readContractSource(h.repo, 'main', item.file);
    if (!source.ok) throw new Error(source.code);
    rules.push(
      withProject(h.biveHome, h.project.id, (store) =>
        registerHumanContract(store, {
          file: item.file,
          kind: item.kind,
          source,
          requirementId: null,
          at: new Date().toISOString(),
          newId,
          by: human,
          clientId: null,
        }),
      ).rule,
    );
  }
  return { h, rules, checkCalls };
};

const judgmentsOfRule = (h: PipelineHarness, ruleId: string): JudgmentResult[] =>
  withProject(h.biveHome, h.project.id, (store) =>
    store.judgments.listByRun(h.runId).filter((judgment) => judgment.ruleId === ruleId),
  );

const ASYNCAPI = `asyncapi: 3.0.0
info:
  title: sample
  version: 1.0.0
channels: {}
`;

describe('검사 단계가 계약 검사 규칙을 종류별 실행기로 판정한다 (수용 기준 1 · 2)', () => {
  it('실행기가 없는 종류(DB 스키마 · AsyncAPI)의 규칙은 판정 없음으로 남아 통과로 세지 않고 다른 규칙을 막지 않는다: 실행은 병합되고, 기록 프록시도 끼우지 않는다 (ADR-130 ⑤)', async () => {
    const proxied: boolean[] = [];
    const { h, rules, checkCalls } = await contractPipeline(
      [
        { file: 'prisma/schema.prisma', kind: 'db-schema' },
        { file: 'asyncapi.yaml', kind: 'asyncapi', text: ASYNCAPI },
      ],
      (calls) => trafficJudge(calls, { proxied }),
    );
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    const check = exitOf(detail, 'check');
    expect(check).toMatchObject({
      ruleIds: ['RULE-001'],
      contracts: [
        {
          ruleId: rules[0]!.displayId,
          contractId: 'CON-001',
          kind: 'db-schema',
          outcome: 'unjudged',
          reason: 'no_runner',
        },
        {
          ruleId: rules[1]!.displayId,
          contractId: 'CON-002',
          kind: 'asyncapi',
          outcome: 'unjudged',
          reason: 'no_runner',
        },
      ],
    });
    // 계약 검사 규칙은 인수 테스트 대상이 아니고 판정 기록도 없다
    expect(checkCalls.map((call) => call.input.ruleIds)).toEqual([['RULE-001']]);
    for (const rule of rules) expect(judgmentsOfRule(h, rule.id)).toEqual([]);
    // 기본: 트래픽 검증이 필요 없으면 프록시 자리를 쓰지 않는다 (판정 입력에 칸이 없다)
    expect(proxied).toEqual([false]);
    // 준수 지표: 판정 가능 분모에 들고 통과로 세지 않는다
    const summary = withProject(h.biveHome, h.project.id, (store) => verificationSummary(store));
    expect(summary.denominator).toEqual(expect.arrayContaining(rules.map((rule) => rule.id)));
    for (const rule of rules) {
      expect(summary.rules.find((row) => row.rule.id === rule.id)?.judgment.status).not.toBe(
        'pass',
      );
    }
    expect(summary.compliance).toEqual({ passed: 1, judgeable: 3 });
  }, 120_000);

  it('OpenAPI 계약: 맞는 응답이면 pass(실행기 redocly-prism · 검증한 요청 수), 실행은 병합된다. 실행기 없는 종류가 섞여도 같다', async () => {
    const proxied: boolean[] = [];
    const { h, rules } = await contractPipeline(
      [
        { file: 'openapi.yaml', kind: 'openapi' },
        { file: 'prisma/schema.prisma', kind: 'db-schema' },
      ],
      (calls) => trafficJudge(calls, { proxied }),
    );
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    expect(proxied).toEqual([true]);
    const [openapi] = judgmentsOfRule(h, rules[0]!.id);
    expect(openapi).toMatchObject({
      status: 'pass',
      runner: 'redocly-prism',
      exitCode: null,
      reporterPath: null,
      cases: [
        {
          name: '계약 검사 · CON-001 (OpenAPI)',
          file: 'openapi.yaml',
          line: null,
          status: 'passed',
          message:
            '계약과 다른 응답 0건 · 검증한 요청 2건 · 계약 밖 요청 1건 · 판정 커밋의 원본 파일은 등록 때와 같음',
        },
      ],
    });
    expect(judgmentsOfRule(h, rules[1]!.id)).toEqual([]);
    expect(exitOf(detail, 'check')).toMatchObject({
      contracts: [
        { ruleId: rules[0]!.displayId, outcome: 'pass', reason: 'verified' },
        { ruleId: rules[1]!.displayId, outcome: 'unjudged', reason: 'no_runner' },
      ],
    });
  }, 120_000);

  it('OpenAPI 계약: 응답 필드 타입 위반이면 fail이고 구조 검사 실패처럼 판단 세션 없이 구현으로 회귀해 상한 뒤 실패한다(위반 케이스가 앞 시도의 사유로)', async () => {
    const { h, rules } = await contractPipeline(
      [{ file: 'openapi.yaml', kind: 'openapi' }],
      (calls) => trafficJudge(calls, { mismatch: true }),
    );
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'regression_limit' });
    const failed = judgmentsOfRule(h, rules[0]!.id);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((judgment) => judgment.status === 'fail')).toBe(true);
    expect(failed[0]?.cases).toEqual([
      expect.objectContaining({
        status: 'failed',
        message: expect.stringContaining('계약과 다른 응답 1건'),
      }),
      {
        name: '계약과 다른 응답 · GET /api/health',
        file: 'openapi.yaml',
        line: null,
        status: 'failed',
        message: 'response.body.ok: Response body property ok must be boolean',
      },
    ]);
    expect(exitOf(detail, 'check')).toMatchObject({
      reason: 'check_failed',
      contracts: [{ outcome: 'fail', reason: 'response_mismatch', blocking: true }],
    });
    // 계약 검사 규칙은 내장 규칙이라 판단 세션을 열지 않는다
    expect(h.sessions.filter((spec) => spec.role === 'rule-writer')).toEqual([]);
  }, 180_000);

  it('등록된 문서의 형식 오류는 fail로 기록하되 구현이 고칠 수 없어 회귀하지 않는다(실행은 병합), 바깥 참조 문서는 판정 없음이다', async () => {
    const invalid = 'openapi: 3.1.0\ninfo:\n  title: t\npaths:\n  /a:\n    get: {}\n';
    const external = FIXTURE_OPENAPI.replace(
      '                type: object\n                required: [ok]',
      "                $ref: 'https://example.invalid/health.yaml'",
    );
    const { h, rules } = await contractPipeline(
      [
        { file: 'invalid.yaml', kind: 'openapi', text: invalid },
        { file: 'external.yaml', kind: 'openapi', text: external },
      ],
      (calls) => trafficJudge(calls),
    );
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    const [doc] = judgmentsOfRule(h, rules[0]!.id);
    expect(doc).toMatchObject({ status: 'fail', runner: 'redocly-prism' });
    expect(doc?.cases[0]?.message).toContain('등록된 문서의 문제라 구현 회귀 없음');
    expect(doc?.cases.slice(1).every((item) => item.name.startsWith('문서 형식 오류 · '))).toBe(
      true,
    );
    expect(judgmentsOfRule(h, rules[1]!.id)).toEqual([]);
    expect(exitOf(detail, 'check')).toMatchObject({
      contracts: [
        { outcome: 'fail', reason: 'document_invalid', blocking: false },
        { outcome: 'unjudged', reason: 'external_reference' },
      ],
    });
  }, 120_000);

  it('판정 커밋의 원본 파일이 등록 뒤 바뀌어도 등록 때 커밋의 내용으로 판정한다 (바뀐 파일로 판정하면 위반)', async () => {
    const { h, rules } = await contractPipeline(
      [{ file: 'openapi.yaml', kind: 'openapi' }],
      (calls) => trafficJudge(calls),
    );
    // 등록 뒤 기준 브랜치의 계약 파일이 바뀐다 (ok가 글): 맞는 응답 { ok: true }가 바뀐 문서로는 위반이다
    fs.writeFileSync(
      path.join(h.repo, 'openapi.yaml'),
      FIXTURE_OPENAPI.replace(
        '                    type: boolean\n  /api/auth',
        '                    type: string\n  /api/auth',
      ),
    );
    userGit(h.repo, 'commit', '-q', '-am', '계약 파일 고침');
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    const [judgment] = judgmentsOfRule(h, rules[0]!.id);
    expect(judgment).toMatchObject({ status: 'pass' });
    expect(judgment?.cases[0]?.message).toContain(
      '판정 커밋의 원본 파일은 등록 때와 다름 (등록 내용으로 판정)',
    );
  }, 120_000);

  it('계약 안 요청이 없으면 판정 없음이다 (기록 없음, 실행은 병합)', async () => {
    const { h, rules } = await contractPipeline(
      [{ file: 'openapi.yaml', kind: 'openapi' }],
      (calls) =>
        trafficJudge(calls, {
          traffic: async (url) => {
            await fetch(`${url}/api/other`).then((res) => res.text());
          },
        }),
    );
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    expect(judgmentsOfRule(h, rules[0]!.id)).toEqual([]);
    expect(exitOf(detail, 'check')).toMatchObject({
      contracts: [{ outcome: 'unjudged', reason: 'no_traffic' }],
    });
  }, 120_000);

  it('도구를 끝까지 못 돌리면(lint 시간 초과) 판정하지 않고 judge_runner_error(단계 contract)로 끝나며 판정 기록이 없다', async () => {
    const { h, rules } = await contractPipeline(
      [{ file: 'openapi.yaml', kind: 'openapi' }],
      (calls) => trafficJudge(calls),
      { contractLintTimeoutMs: 1 },
    );
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
    expect(exitOf(detail, 'check').detail).toMatchObject({
      stage: 'contract',
      code: 'timeout',
      ruleId: rules[0]!.displayId,
    });
    expect(judgmentsOfRule(h, rules[0]!.id)).toEqual([]);
  }, 120_000);
});

// ── 검토 1회차: 검증하지 못한 요청은 닫힌 쪽 · 판별자 대응 값 · 남은 변이 · 남는 프로세스 ─────────────────

/** 시험용 계약 판정 줄 (`trafficVerdict` · `prepareContracts` 단위 시험). */
const planItem = (overrides: Partial<Contract> = {}) => ({
  rule: { id: newId(), displayId: 'RULE-002' } as Rule,
  contract: {
    id: newId(),
    displayId: 'CON-001',
    kind: 'openapi',
    sourceFile: 'openapi.yaml',
    contentHash: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    ...overrides,
  } as Contract,
  runner: 'openapi' as const,
});

const verdictOf = (
  outcome: ExchangeVerdict['outcome'],
  unverified?: ExchangeVerdict['unverified'],
): ExchangeVerdict => ({
  index: 0,
  method: 'GET',
  target: '/api/health',
  outcome,
  violations:
    outcome === 'violation'
      ? [{ location: 'response.body.ok', severity: 'Error', message: 'must be boolean' }]
      : [],
  truncated: false,
  ...(unverified === undefined ? {} : { unverified }),
});

/** 판정받는 구현이 고를 수 있는 응답 모양 (검토 1회차 사례). 모두 계약과 다르거나 검증할 수 없는 응답이다. */
const EVASIONS: readonly [string, HealthResponder][] = [
  [
    '501',
    (res) => {
      res.statusCode = 501;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":"yes"}');
    },
  ],
  [
    '304',
    (res) => {
      res.statusCode = 304;
      res.end();
    },
  ],
  [
    '302 뒤 다른 경로',
    (res) => {
      res.statusCode = 302;
      res.setHeader('location', '/api/other');
      res.end();
    },
  ],
  [
    '깨진 JSON',
    (res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":');
    },
  ],
  [
    '가짜 content-encoding',
    (res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-encoding', 'gzip');
      res.end('{"ok":"yes"}');
    },
  ],
  [
    '기록 상한을 넘는 본문',
    (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(`{"ok":true,"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`);
    },
  ],
  [
    '위반 JSON 뒤 공백 채움',
    (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(`{"ok":"yes"}${' '.repeat(5 * 1024 * 1024)}`);
    },
  ],
];

describe('검증하지 못한 요청은 닫힌 쪽이다: 실패(구현 회귀)이고 판정 없음이 아니다 (검토 1회차 B1)', () => {
  it('trafficVerdict: 검증하지 못한 교환(prism이 다루지 못함 · 넘기지 않음 · 기록 불완전)과 기록 건수 상한 초과는 막는 fail, 계약 밖뿐이면 판정 없음', () => {
    const item = planItem();
    const extra = { overflow: 0, warnings: 0 };
    const verdict = (exchanges: ExchangeVerdict[], overflow = 0) =>
      trafficVerdict(item, { exchanges }, 'same', { ...extra, overflow });
    for (const reason of ['status_differs', 'not_forwarded', 'incomplete'] as const) {
      const judged = verdict([verdictOf('ok'), verdictOf('unverified', reason)]);
      expect(judged, reason).toMatchObject({
        kind: 'judged',
        status: 'fail',
        reason: 'response_unverified',
        blocking: true,
      });
      expect(judged.kind === 'judged' ? judged.cases[1]?.name : null).toBe(
        '검증하지 못한 응답 · GET /api/health',
      );
    }
    // 기록 건수 상한을 넘은 요청: 계약 안인지 가릴 수 없다
    expect(verdict([verdictOf('ok')], 1)).toMatchObject({
      kind: 'judged',
      status: 'fail',
      reason: 'response_unverified',
      blocking: true,
    });
    expect(verdict([verdictOf('outside')], 1)).toMatchObject({ status: 'fail' });
    // 위반이 함께면 사유는 계약과 다른 응답
    expect(verdict([verdictOf('violation'), verdictOf('unverified', 'incomplete')])).toMatchObject({
      status: 'fail',
      reason: 'response_mismatch',
      blocking: true,
    });
    // 구현이 통제할 수 없는 사유만 판정 없음: 계약 안 요청 0건
    expect(verdict([verdictOf('outside')])).toEqual({
      kind: 'unjudged',
      item,
      reason: 'no_traffic',
    });
    expect(verdict([])).toMatchObject({ kind: 'unjudged', reason: 'no_traffic' });
    expect(verdict([verdictOf('ok'), verdictOf('outside')])).toMatchObject({ status: 'pass' });
  });

  it('실제 기록 프록시 · prism: 501 · 304 · 302 뒤 다른 경로 · 깨진 JSON · 가짜 인코딩 · 상한 초과 본문 · 위반 JSON 뒤 공백 채움은 통과 · 계약 밖이 아니라 위반 또는 검증하지 못함이다', async () => {
    const toolDir = tempDir();
    fs.writeFileSync(path.join(toolDir, 'contract.yaml'), FIXTURE_OPENAPI);
    for (const [label, respond] of EVASIONS) {
      const api = await fakeApi(respond);
      const recorder = new ExchangeRecorder();
      const proxy = await recorder.start({ upstreamBaseUrl: api.url });
      await fetch(`${proxy.baseUrl}/api/health`, { redirect: 'manual' })
        .then((res) => res.arrayBuffer())
        .catch(() => undefined);
      await proxy.stop();
      const result = await validateWithPrism({
        toolDir,
        documentFile: 'contract.yaml',
        signal: never,
        exchanges: recorder.exchanges(),
      });
      expect(
        result.exchanges.map((item) => item.outcome),
        label,
      ).toHaveLength(1);
      expect(['violation', 'unverified'], label).toContain(result.exchanges[0]?.outcome);
      expect(
        trafficVerdict(planItem(), result, 'same', { overflow: 0, warnings: 0 }),
        label,
      ).toMatchObject({ kind: 'judged', status: 'fail', blocking: true });
    }
  }, 120_000);

  it('계약에 적힌 204 · 304는 통과하고, 계약에 적힌 302(Location)는 prism이 리다이렉트를 따라가 검증하지 못해 닫힌 쪽이다 (한계), 기록이 불완전해도 계약 밖 경로면 계약 밖이다', async () => {
    const doc = `${FIXTURE_OPENAPI}  /r:
    get:
      responses:
        '302':
          description: 이동
  /n:
    delete:
      responses:
        '204':
          description: 없음
  /c:
    get:
      responses:
        '304':
          description: 바뀌지 않음
`;
    const toolDir = tempDir();
    fs.writeFileSync(path.join(toolDir, 'contract.yaml'), doc);
    const empty = { responseHeaders: [] as [string, string][], responseBody: Buffer.alloc(0) };
    const result = await validateWithPrism({
      toolDir,
      documentFile: 'contract.yaml',
      signal: never,
      exchanges: [
        exchange({ index: 0, method: 'DELETE', target: '/n', status: 204, ...empty }),
        exchange({ index: 1, target: '/c', status: 304, ...empty }),
        exchange({
          index: 2,
          target: '/r',
          status: 302,
          responseHeaders: [['location', '/elsewhere']],
          responseBody: Buffer.alloc(0),
        }),
        exchange({ index: 3, target: '/api/other', complete: false }),
        exchange({ index: 4, complete: false }),
      ],
    });
    expect(result.exchanges.map((item) => [item.index, item.outcome, item.unverified])).toEqual([
      [0, 'ok', undefined],
      [1, 'ok', undefined],
      [2, 'unverified', 'status_differs'],
      [3, 'outside', undefined],
      [4, 'unverified', 'incomplete'],
    ]);
  }, 60_000);

  it('검사 단계: 구현이 그런 응답을 돌려주면 계약 판정은 fail로 기록되고 구현 회귀 뒤 상한으로 끝나 병합되지 않는다', async () => {
    for (const [label, respond] of EVASIONS) {
      const { h, rules } = await contractPipeline(
        [{ file: 'openapi.yaml', kind: 'openapi' }],
        (calls) =>
          trafficJudge(calls, {
            mismatch: respond,
            traffic: async (url) => {
              await fetch(`${url}/api/health`, { redirect: 'manual' })
                .then((res) => res.arrayBuffer())
                .catch(() => undefined);
            },
          }),
      );
      const detail = await runToEnd(h);
      expect(detail.run, label).toMatchObject({
        status: 'failed',
        failureReason: 'regression_limit',
      });
      expect(Number(userGit(h.repo, 'rev-list', '--merges', '--count', 'main')), label).toBe(0);
      const judgments = judgmentsOfRule(h, rules[0]!.id);
      expect(judgments.length, label).toBeGreaterThan(0);
      expect(
        judgments.every((judgment) => judgment.status === 'fail'),
        label,
      ).toBe(true);
      expect(exitOf(detail, 'check'), label).toMatchObject({
        reason: 'check_failed',
        contracts: [{ outcome: 'fail', blocking: true }],
      });
    }
  }, 900_000);
});

describe('판별자 대응 값도 바깥 참조다 (검토 1회차 B2, 대조군)', () => {
  const PET = (discriminator: string, version = '3.1.0') => `openapi: ${version}
info:
  title: t
  version: '1'
paths:
  /pets:
    get:
      responses:
        '200':
          description: ok
components:
  schemas:
    Pet:
      type: object
      properties:
        kind:
          type: string
      discriminator:
        propertyName: kind
${discriminator}
`;

  it('사전 검사: mapping 값과 defaultMapping이 문서 안 참조(#)도 스키마 이름도 아니면 바깥 참조이고, 판별자가 아닌 자리의 mapping 속성은 보지 않는다', () => {
    expect(
      readOpenApiDocument(PET("        mapping:\n          dog: '#/components/schemas/Pet'")),
    ).toMatchObject({ kind: 'ok' });
    expect(readOpenApiDocument(PET('        mapping:\n          dog: Pet'))).toMatchObject({
      kind: 'ok',
    });
    for (const value of ["'http://127.0.0.1:9/dog.yaml'", "'./dog.yaml'", 'Dog', "'dog.json'"]) {
      expect(
        readOpenApiDocument(PET(`        mapping:\n          dog: ${value}`)),
        value,
      ).toMatchObject({
        kind: 'external',
        references: [
          { pointer: '/components/schemas/Pet/discriminator/mapping/dog', key: 'mapping' },
        ],
      });
    }
    expect(readOpenApiDocument(PET('        mapping: x'))).toMatchObject({ kind: 'external' });
    expect(
      readOpenApiDocument(PET("        defaultMapping: 'https://x/def.yaml'", '3.2.0')),
    ).toMatchObject({ kind: 'external', references: [{ key: 'defaultMapping' }] });
    // 스키마의 속성 이름이 mapping이어도 판별자가 아니면 그대로다
    expect(
      readOpenApiDocument(
        PET('        mapping:\n          dog: Pet').replace(
          '        kind:\n          type: string',
          '        kind:\n          type: string\n        mapping:\n          type: object',
        ),
      ),
    ).toMatchObject({ kind: 'ok' });
  });

  it('대조군: 방어 없이 lint하면 redocly가 mapping 값 · defaultMapping(3.2)의 원격 주소에 요청한다. 실행기는 도구를 부르지 않고 요청 0건이다', async () => {
    const remote = await listen((_req, res) => {
      res.setHeader('content-type', 'application/yaml');
      res.end('type: object\n');
    });
    const docs = [
      PET(`        mapping:\n          dog: '${remote.url}/dog.yaml'`),
      PET(`        defaultMapping: '${remote.url}/def.yaml'`, '3.2.0'),
    ];
    for (const doc of docs) {
      const toolDir = tempDir();
      fs.writeFileSync(path.join(toolDir, 'contract.yaml'), doc);
      fs.writeFileSync(path.join(toolDir, 'c.yaml'), REDOCLY_CONFIG);
      await runDirect(REDOCLY_ENTRY, lintArgs('contract.yaml', path.join(toolDir, 'c.yaml')), {
        cwd: toolDir,
        env: toolEnv(toolDir),
      });
    }
    expect(remote.hits).toEqual(['/dog.yaml', '/def.yaml']);
    remote.hits.length = 0;
    for (const doc of docs) {
      expect(
        await prepareOpenApiContract(doc, { sourceFile: 'openapi.yaml', signal: never }),
      ).toMatchObject({ kind: 'external' });
    }
    expect(remote.hits).toEqual([]);
  }, 60_000);
});

describe('남은 변이를 닫는 시험 (검토 1회차 B3)', () => {
  it('missingContractVerdicts: 계약 검사 규칙마다 판정 · 판정 없음이 정확히 하나여야 하고, 빠지거나 겹치면 빠진 규칙, 계획이 없으면 늘 빈 목록', () => {
    const a = planItem();
    const b = {
      ...planItem({ displayId: 'CON-002' }),
      rule: { id: newId(), displayId: 'RULE-003' } as Rule,
    };
    const plan = { items: [a, b] };
    const unjudged = (item: typeof a) => ({
      kind: 'unjudged' as const,
      item,
      reason: 'no_runner' as const,
    });
    expect(missingContractVerdicts(null, undefined)).toEqual([]);
    expect(
      missingContractVerdicts(plan, { kind: 'judged', verdicts: [unjudged(a), unjudged(b)] }),
    ).toEqual([]);
    expect(missingContractVerdicts(plan, { kind: 'judged', verdicts: [unjudged(a)] })).toEqual([
      'RULE-003',
    ]);
    expect(
      missingContractVerdicts(plan, {
        kind: 'judged',
        verdicts: [unjudged(a), unjudged(a), unjudged(b)],
      }),
    ).toEqual(['RULE-002']);
    expect(missingContractVerdicts(plan, undefined)).toEqual(['RULE-002', 'RULE-003']);
    expect(
      missingContractVerdicts(plan, {
        kind: 'halt',
        reason: 'judge_runner_error',
        message: 'x',
        code: 'timeout',
        ruleId: 'RULE-002',
      }),
    ).toEqual(['RULE-002', 'RULE-003']);
  });

  it('등록 해시와 다른 바이트(같은 경로 · 같은 커밋이라도)는 판정하지 않는다: 도구를 부르지 않고 판정 없음(등록 원본을 읽지 못함)', async () => {
    const { root, commit } = plantedProject();
    const source = await readContractSource(root, 'main', 'openapi.yaml');
    if (!source.ok) throw new Error(source.code);
    const run = async (contentHash: string) => {
      const prepared = await prepareContracts(
        root,
        commit,
        { items: [planItem({ sourceCommit: commit, contentHash })] },
        { signal: never },
      );
      if (prepared.kind !== 'prepared') throw new Error(prepared.code);
      try {
        return prepared.prepared.items[0];
      } finally {
        disposeContracts(prepared.prepared);
      }
    };
    expect(await run(source.contentHash)).toMatchObject({ kind: 'openapi' });
    expect(await run('c'.repeat(64))).toMatchObject({
      kind: 'unjudged',
      reason: 'source_unreadable',
    });
  }, 60_000);

  it('기록 프록시는 요청 · 응답의 상태 · 머리(location · set-cookie 여러 개 · cache-control · x-*) · 본문을 바이트 그대로 넘긴다 (리다이렉트 포함)', async () => {
    const seen: { headers: string[]; body: string }[] = [];
    const api = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ headers: req.rawHeaders, body });
        res.writeHead(
          302,
          'Found',
          [
            'Location',
            '/다른/경로?x=1',
            'Set-Cookie',
            'a=1; Path=/',
            'Set-Cookie',
            'b=2; HttpOnly',
            'Cache-Control',
            'no-store',
            'X-Bive-Test',
            '값',
            'Content-Type',
            'application/octet-stream',
          ].map((v) => Buffer.from(v).toString('latin1')),
        );
        res.end(Buffer.from([0, 1, 2, 255]));
      });
    });
    const recorder = new ExchangeRecorder();
    const proxy = await recorder.start({ upstreamBaseUrl: api.url });
    const response = await new Promise<http.IncomingMessage & { body: Buffer }>(
      (resolve, reject) => {
        const req = http.request(`${proxy.baseUrl}/a?b=1`, {
          method: 'PUT',
          headers: { 'X-Custom': 'y', Cookie: 'c=3', 'Content-Type': 'text/plain' },
        });
        req.on('response', (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Object.assign(res, { body: Buffer.concat(chunks) })));
        });
        req.on('error', reject);
        req.end('요청 본문');
      },
    );
    await proxy.stop();
    expect(response.statusCode).toBe(302);
    expect(response.statusMessage).toBe('Found');
    const raw = response.rawHeaders;
    const pairs = (list: string[]) =>
      list.flatMap((value, i) => (i % 2 === 0 ? [[value.toLowerCase(), list[i + 1]]] : []));
    const forwarded = pairs(raw).filter(
      ([name]) => !['date', 'connection', 'keep-alive', 'transfer-encoding'].includes(name!),
    );
    expect(forwarded).toEqual([
      ['location', Buffer.from('/다른/경로?x=1').toString('latin1')],
      ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; HttpOnly'],
      ['cache-control', 'no-store'],
      ['x-bive-test', Buffer.from('값').toString('latin1')],
      ['content-type', 'application/octet-stream'],
    ]);
    expect([...response.body]).toEqual([0, 1, 2, 255]);
    expect(seen[0]?.body).toBe('요청 본문');
    expect(
      pairs(seen[0]!.headers).filter(([name]) =>
        ['x-custom', 'cookie', 'content-type'].includes(name!),
      ),
    ).toEqual([
      ['x-custom', 'y'],
      ['cookie', 'c=3'],
      ['content-type', 'text/plain'],
    ]);
    expect(recorder.exchanges()[0]).toMatchObject({
      method: 'PUT',
      target: '/a?b=1',
      status: 302,
      complete: true,
    });
  });

  it('계약 검사 규칙의 표시 ID와 같은 인수 테스트 폴더가 있어도 인수 테스트로 판정하지 않는다', async () => {
    // 계약 검사 규칙은 RULE-002가 된다 (시드 규칙 RULE-001 다음)
    const { h, rules, checkCalls } = await contractPipeline(
      [{ file: 'prisma/schema.prisma', kind: 'db-schema' }],
      (calls) => trafficJudge(calls),
    );
    expect(rules[0]?.displayId).toBe('RULE-002');
    fs.mkdirSync(path.join(h.repo, 'bive-acceptance', 'RULE-002'), { recursive: true });
    fs.writeFileSync(
      path.join(h.repo, 'bive-acceptance', 'RULE-002', 'x.acc.ts'),
      "import { it } from 'vitest';\nit('통과', () => undefined);\n",
    );
    userGit(h.repo, 'add', '--all');
    userGit(h.repo, 'commit', '-q', '-m', '계약 규칙 이름의 폴더');
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    expect(checkCalls.map((call) => call.input.ruleIds)).toEqual([['RULE-001']]);
    expect(exitOf(detail, 'check')).toMatchObject({
      ruleIds: ['RULE-001'],
      unjudgedDirs: ['RULE-002'],
    });
    expect(judgmentsOfRule(h, rules[0]!.id)).toEqual([]);
  }, 120_000);

  it('병합 재검사도 계약을 판정한다: 검사 단계는 통과했지만 병합 커밋의 판정에서 계약과 다른 응답이면 병합하지 않고 병합 단계의 판정 기록을 남긴다', async () => {
    const { h, rules } = await contractPipeline(
      [{ file: 'openapi.yaml', kind: 'openapi' }],
      (calls) => trafficJudge(calls, { mismatch: true, mismatchIn: 'merge' }),
      {},
      true,
    );
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'check_failed' });
    expect(Number(userGit(h.repo, 'rev-list', '--merges', '--count', 'main'))).toBe(0);
    const mergeStep = detail.steps.find((step) => step.kind === 'merge')?.id;
    const checkStep = detail.steps.find((step) => step.kind === 'check')?.id;
    const judgments = judgmentsOfRule(h, rules[0]!.id);
    expect(judgments.map((judgment) => [judgment.stepId, judgment.status])).toEqual([
      [checkStep, 'pass'],
      [mergeStep, 'fail'],
    ]);
    expect(exitOf(detail, 'merge').detail).toMatchObject({
      recheck: { contracts: [{ outcome: 'fail', reason: 'response_mismatch', blocking: true }] },
    });
  }, 180_000);
});

describe('부모가 사라지면 도구 프로세스도 끝난다 (검토 1회차 B4)', () => {
  /** 도구를 띄운 뒤 그 PID를 찍고 기다리는 부모 프로세스 (오케스트레이터 대신). */
  const parentWith = (entry: string, args: string[], cwd: string) =>
    spawn(
      process.execPath,
      [
        '--conditions=@bive/source',
        '--import',
        'tsx',
        '-e',
        `const { spawnTool, toolEnv } = await import(${JSON.stringify(path.join(ORCHESTRATOR_SRC, 'contract-check', 'tool.ts'))});
const child = spawnTool(${JSON.stringify(entry)}, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(cwd)}, env: toolEnv(${JSON.stringify(cwd)}) });
child.stdout.resume(); child.stderr.resume();
console.log(child.pid);
setInterval(() => {}, 1000);`,
      ],
      { cwd: path.join(ORCHESTRATOR_SRC, '..'), stdio: ['ignore', 'pipe', 'inherit'] },
    );

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('부모를 SIGKILL하면 스스로 끝나지 않는 도구(가짜 서버 · 실제 prism 프록시)도 정해진 시간 안에 사라진다', async () => {
    const toolDir = tempDir();
    fs.writeFileSync(path.join(toolDir, 'contract.yaml'), FIXTURE_OPENAPI);
    const hangs = fakeTool('setInterval(() => {}, 1000);\n');
    for (const [entry, args] of [
      [hangs, []],
      [PRISM_ENTRY, prismArgs('contract.yaml', 'http://127.0.0.1:9')],
    ] as const) {
      const parent = parentWith(entry, [...args], toolDir);
      const pid = await new Promise<number>((resolve) =>
        parent.stdout.once('data', (data: Buffer) => resolve(Number(String(data).trim()))),
      );
      // 도구가 떠 있다 (prism은 기동을 기다린다)
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(alive(pid), entry).toBe(true);
      parent.kill('SIGKILL');
      const deadline = Date.now() + 5_000;
      while (alive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (alive(pid)) process.kill(pid, 'SIGKILL');
      expect(alive(pid), entry).toBe(false);
    }
    expect(await waitGone(toolDir)).toEqual([]);
  }, 60_000);
});

// ── 검토 2회차: 동시 요청의 교환 번호 · 스키마 이름 모양 ─────────────────────────

/** 헬스 체크 계약에 맞는 본문 · 어긋난 본문. */
const OK_BODY = '{"ok":true}';
const BAD_BODY = '{"ok":"yes"}';

/**
 * 요청을 `count`건 받을 때까지 응답을 쥐고 있다가, `order`의 도착 순번 차례로 하나씩 응답을 끝내는 판정 서버(시간 맞추기 없이 순서를
 * 고정한다). `respond(도착 순번, 경로)`가 상태 · 본문을 정한다.
 */
const heldApi = async (
  count: number,
  order: readonly number[],
  respond: (arrival: number, url: string) => { status: number; body: string },
) => {
  const held: { url: string; res: http.ServerResponse }[] = [];
  const api = await listen((req, res) => {
    req.resume();
    held.push({ url: req.url ?? '', res });
    if (held.length !== count) return;
    void (async () => {
      for (const arrival of order) {
        const item = held[arrival]!;
        const { status, body } = respond(arrival, item.url);
        await new Promise<void>((resolve) => {
          item.res.on('finish', () => resolve());
          item.res.writeHead(status, { 'content-type': 'application/json' });
          item.res.end(body);
        });
      }
    })();
  });
  return api;
};

/** 기록 프록시 앞에서 `paths`를 한꺼번에 보내고 교환을 prism · 판정까지 돌린다. */
const concurrentVerdict = async (
  paths: readonly string[],
  order: readonly number[],
  respond: (arrival: number, url: string) => { status: number; body: string },
  recorder = new ExchangeRecorder(),
) => {
  const api = await heldApi(paths.length, order, respond);
  const proxy = await recorder.start({ upstreamBaseUrl: api.url });
  await Promise.all(paths.map((p) => fetch(`${proxy.baseUrl}${p}`).then((res) => res.text())));
  await proxy.stop();
  const toolDir = tempDir();
  fs.writeFileSync(path.join(toolDir, 'contract.yaml'), FIXTURE_OPENAPI);
  const result = await validateWithPrism({
    toolDir,
    documentFile: 'contract.yaml',
    signal: never,
    exchanges: recorder.exchanges(),
  });
  return {
    recorder,
    result,
    verdict: trafficVerdict(planItem(), result, 'same', {
      overflow: recorder.overflow(),
      warnings: 0,
    }),
  };
};

describe('동시 요청도 교환마다 다른 번호로 기록 · 재생한다 (검토 2회차 N-B1)', () => {
  it('(가) 같은 작업에 동시 요청 두 건: 위반 응답이 먼저 끝나든 나중에 끝나든 fail이고 두 교환의 번호가 다르다', async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      // 먼저 도착한 요청이 위반 본문, 다음 요청이 맞는 본문 (끝나는 순서는 order)
      const { recorder, result, verdict } = await concurrentVerdict(
        ['/api/health', '/api/health'],
        order,
        (arrival) => ({ status: 200, body: arrival === 0 ? BAD_BODY : OK_BODY }),
      );
      expect(
        recorder.exchanges().map((item) => item.index),
        String(order),
      ).toEqual([0, 1]);
      expect(
        recorder.exchanges().map((item) => item.responseBody.toString()),
        String(order),
      ).toEqual([BAD_BODY, OK_BODY]);
      expect(
        result.exchanges.map((item) => item.outcome),
        String(order),
      ).toEqual(['violation', 'ok']);
      expect(verdict, String(order)).toMatchObject({
        kind: 'judged',
        status: 'fail',
        reason: 'response_mismatch',
      });
    }
  }, 60_000);

  it('(나) 정상 구현에 서로 다른 작업 두 개를 동시에 요청해도 각자 제 응답으로 재생되어 pass다', async () => {
    const { result, verdict } = await concurrentVerdict(
      ['/api/health', '/api/auth/session'],
      [1, 0],
      (_arrival, url) =>
        url === '/api/health'
          ? { status: 200, body: OK_BODY }
          : { status: 401, body: '{"authenticated":false}' },
    );
    expect(result.exchanges.map((item) => item.outcome)).toEqual(['ok', 'ok']);
    expect(verdict).toMatchObject({ kind: 'judged', status: 'pass' });
  }, 60_000);

  it('(다) 같은 작업 여섯 건을 동시에 보내 한 건만 위반이어도(그 건이 먼저 끝남) fail이다', async () => {
    const { recorder, result, verdict } = await concurrentVerdict(
      Array.from({ length: 6 }, () => '/api/health'),
      [3, 0, 1, 2, 4, 5],
      (arrival) => ({ status: 200, body: arrival === 3 ? BAD_BODY : OK_BODY }),
    );
    expect(recorder.exchanges().map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.exchanges.filter((item) => item.outcome === 'violation')).toHaveLength(1);
    expect(verdict).toMatchObject({ kind: 'judged', status: 'fail' });
  }, 60_000);

  it('(라) 동시 요청이 건수 상한을 넘으면 상한까지만 기록하고 나머지는 넘친 수로 세며, 판정은 fail이다', async () => {
    const recorder = new ExchangeRecorder({ maxExchanges: 2 });
    const { verdict } = await concurrentVerdict(
      Array.from({ length: 5 }, () => '/api/health'),
      [4, 3, 2, 1, 0],
      () => ({ status: 200, body: OK_BODY }),
      recorder,
    );
    expect(recorder.exchanges().map((item) => item.index)).toEqual([0, 1]);
    expect(recorder.overflow()).toBe(3);
    expect(verdict).toMatchObject({
      kind: 'judged',
      status: 'fail',
      reason: 'response_unverified',
    });
  }, 60_000);

  it('닫을 때 끝나지 않은 교환은 번호를 가진 기록 불완전으로 남는다', async () => {
    const api = await listen(() => undefined);
    const recorder = new ExchangeRecorder();
    const proxy = await recorder.start({ upstreamBaseUrl: api.url });
    const pending = fetch(`${proxy.baseUrl}/api/health`).catch(() => undefined);
    // 판정 서버에 닿을 때까지 (요청이 들어온 순간 번호가 정해진다)
    while (api.hits.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await proxy.stop();
    await pending;
    expect(recorder.exchanges().map((item) => [item.index, item.complete])).toEqual([[0, false]]);
  });
});

describe('주소 · 파일 모양의 스키마 이름은 판별자 대응 값으로 받지 않는다 (검토 2회차 N-B2, 대조군)', () => {
  /** 스키마 이름이 `name`이고 판별자가 그 이름을 가리키는 문서. */
  const NAMED = (
    name: string,
    discriminator: 'mapping' | 'defaultMapping',
  ) => `openapi: ${discriminator === 'defaultMapping' ? '3.2.0' : '3.1.0'}
info:
  title: t
  version: '1'
paths:
  /pets:
    get:
      responses:
        '200':
          description: ok
components:
  schemas:
    Pet:
      type: object
      properties:
        kind:
          type: string
      discriminator:
        propertyName: kind
${discriminator === 'mapping' ? `        mapping:\n          dog: '${name}'` : `        defaultMapping: '${name}'`}
    '${name}':
      type: object
`;

  it('사전 검사: 컴포넌트 이름 글자만이고 .yaml · .yml · .json으로 끝나지 않는 스키마 이름만 받는다', () => {
    for (const name of ['Dog', 'pet-v2', 'a.b', 'A_1']) {
      expect(isPlainSchemaName(name), name).toBe(true);
      expect(readOpenApiDocument(NAMED(name, 'mapping')), name).toMatchObject({ kind: 'ok' });
    }
    for (const name of [
      'http://127.0.0.1:9/named.yaml',
      'https://x/y',
      'file:///etc/x',
      'data:text/plain,x',
      './dog',
      'a/b',
      'dog.yaml',
      'dog.YML',
      'Dog.Json',
    ]) {
      expect(isPlainSchemaName(name), name).toBe(false);
      for (const key of ['mapping', 'defaultMapping'] as const) {
        expect(readOpenApiDocument(NAMED(name, key)), `${key} ${name}`).toMatchObject({
          kind: 'external',
          references: [{ key }],
        });
      }
    }
  });

  it('대조군: 주소 모양 스키마 이름을 mapping 값 · defaultMapping으로 쓰면 방어 없는 lint는 시험 서버에 요청한다. 실행기는 바깥 참조로 끝내고 요청 0건이다', async () => {
    const remote = await listen((_req, res) => {
      res.setHeader('content-type', 'application/yaml');
      res.end('type: object\n');
    });
    const docs = [
      NAMED(`${remote.url}/named.yaml`, 'mapping'),
      NAMED(`${remote.url}/default.yaml`, 'defaultMapping'),
    ];
    for (const doc of docs) {
      const toolDir = tempDir();
      fs.writeFileSync(path.join(toolDir, 'contract.yaml'), doc);
      fs.writeFileSync(path.join(toolDir, 'c.yaml'), REDOCLY_CONFIG);
      await runDirect(REDOCLY_ENTRY, lintArgs('contract.yaml', path.join(toolDir, 'c.yaml')), {
        cwd: toolDir,
        env: toolEnv(toolDir),
      });
    }
    expect([...new Set(remote.hits)].sort()).toEqual(['/default.yaml', '/named.yaml']);
    remote.hits.length = 0;
    for (const doc of docs) {
      expect(
        await prepareOpenApiContract(doc, { sourceFile: 'openapi.yaml', signal: never }),
      ).toMatchObject({ kind: 'external' });
    }
    expect(remote.hits).toEqual([]);
  }, 60_000);
});

// ── 실제 판정 서버: 원본 pass · contract-mismatch 변형 fail ──────────────────

const RESET_FIXTURE = path.join(REPO_ROOT, 'scripts', 'reset-fixture.sh');
const MAKE_VARIANT = path.join(REPO_ROOT, 'scripts', 'make-variant.sh');

const CONTRACT_ACC = `import { describe, expect, inject, it } from 'vitest';

describe('계약 경로', () => {
  it('헬스 체크', async () => {
    const res = await fetch(new URL('/api/health', inject('baseUrl')));
    expect(res.status).toBe(200);
  });

  it('로그인 상태', async () => {
    const res = await fetch(new URL('/api/auth/session', inject('baseUrl')));
    expect(res.status).toBe(401);
  });
});
`;

describe('실제 판정 서버 앞에서: 픽스처 원본은 pass, contract-mismatch 변형은 fail (수용 기준 1)', () => {
  it('판정 러너의 프록시 자리에 기록 프록시를 끼워 인수 테스트 트래픽을 prism으로 검증한다', async () => {
    const fixture = tempDir('bive-cr-fx-');
    const biveHome = tempDir('bive-cr-home-');
    execFileSync('bash', [RESET_FIXTURE, fixture], { stdio: 'pipe' });
    fs.mkdirSync(path.join(fixture, 'bive-acceptance', 'RULE-001'), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, 'bive-acceptance', 'RULE-001', 'contract.acc.ts'),
      CONTRACT_ACC,
    );
    userGit(fixture, 'add', '--all');
    userGit(fixture, 'commit', '-q', '-m', 'acceptance');
    const runner = new JudgeRunner({ biveHome, tempDir: tempDir('bive-cr-tmp-') });
    const judgeOnce = async () => {
      const prepared = await prepareOpenApiContract(
        fs.readFileSync(path.join(fixture, 'openapi.yaml'), 'utf8'),
        { sourceFile: 'openapi.yaml', signal: never },
      );
      try {
        if (prepared.kind !== 'ready') throw new Error(prepared.kind);
        const recorder = new ExchangeRecorder();
        const result = await runner.run({
          projectId: newId(),
          runId: newId(),
          worktreeDir: fixture,
          profile: 'next-prisma-sqlite',
          ruleIds: ['RULE-001'],
          timeoutMs: 240_000,
          serverProxy: recorder,
        });
        expect(result.problems).toEqual([]);
        const verified = await verifyOpenApiTraffic(prepared, recorder.exchanges(), {
          signal: never,
        });
        return { result, verified };
      } finally {
        disposePrepared(prepared);
      }
    };

    const original = await judgeOnce();
    expect(original.result.cases.map((item) => item.status)).toEqual(['passed', 'passed']);
    expect(original.verified.exchanges.map((item) => [item.target, item.outcome])).toEqual([
      ['/api/health', 'ok'],
      ['/api/auth/session', 'ok'],
    ]);

    execFileSync('bash', [MAKE_VARIANT, fixture, 'contract-mismatch'], { stdio: 'pipe' });
    const variant = await judgeOnce();
    // 인수 테스트 결과는 기록 프록시가 바꾸지 않는다 (상태 코드만 보는 테스트는 그대로 통과)
    expect(variant.result.cases.map((item) => item.status)).toEqual(['passed', 'passed']);
    expect(variant.verified.exchanges.map((item) => [item.target, item.outcome])).toEqual([
      ['/api/health', 'violation'],
      ['/api/auth/session', 'ok'],
    ]);
  }, 600_000);
});
