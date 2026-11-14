// 판정용 깨끗한 체크아웃 (JDG-01 · RUN-03 · RUN-08, ADR-058 · ADR-066 · ADR-068).
// 판정은 실행 워크트리가 아니라 판정할 커밋의 깨끗한 체크아웃에서 돈다. 실행 워크트리의 되돌리기(`clean -ffd`, `-x` 없음)는
// 무시된 파일(`node_modules` · 빌드 산출물)과 에이전트가 심은 `.gitignore`로 숨긴 소스(예: `src/planted/.gitignore`에
// `*` + `evil.ts`)를 남기므로, 그 위에서 판정하면 커밋에 없는 코드가 결과를 바꿀 수 있다(무시된 파일은 커밋 · 병합에
// 들어가지 않는다). 그래서:
// - 커밋에서 분리된 임시 워크트리를 만든다 (`$BIVE_HOME/work/<projectId>/judge/<EXE-ID>/<ID>`, 추적 파일만)
// - 만든 직후 HEAD가 그 커밋이고 미추적 · 무시된 파일이 하나도 없는지 확인한다
// - 의존성은 실행 워크트리와 공유하지 않고 체크아웃 안에 lockfile 기준으로 새로 설치한다(ADR-024: 설치는 오케스트레이터)
// - 판정이 끝나면 임시 워크트리를 지운다 (판정 결과 원본은 판정 폴더 `projects/<id>/judge/…`에 남는다)
// - `worktree add` · `remove`는 워크트리 관리자와 같은 짧은 저장소 잠금(ADR-065 `worktree:<저장소>`) 안에서 돈다.
//   `worktree add`가 공용 관리 폴더 `.git/worktrees/<이름>/`을 만든 뒤 `commondir`을 쓰기 전에 관리자의
//   `worktree list` · `add` · `lock`이 돌면 그 폴더를 읽지 못해 실패하기 때문이다(분리된 HEAD라도 관리 폴더는 공용이다)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CommitSha, createUlidGenerator } from '@bive/shared';
import { isScalar, parseAllDocuments, visit } from 'yaml';

import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import { withGitWorktreeLock } from '../git/worktree-manager.js';
import { ACCEPTANCE_DIR } from './config.js';
import { baseChildEnv, describeExit, runCommand } from './process.js';

/** 의존성 설치 제한 시간 (기본). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** 판정용 체크아웃 준비 실패. 단계 실행기가 실행 실패 사유로 옮긴다. */
export class JudgeCheckoutError extends Error {
  override readonly name = 'JudgeCheckoutError';
  constructor(
    /** 실패한 단계 */
    readonly stage: 'checkout' | 'install',
    message: string,
  ) {
    super(message);
  }
}

/** 판정용 체크아웃 경로의 부모 `$BIVE_HOME/work/<projectId>/judge/<EXE-ID>`. */
export const judgeCheckoutRoot = (
  biveHome: string,
  projectId: string,
  runDisplayId: string,
): string => path.join(path.resolve(biveHome), 'work', projectId, 'judge', runDisplayId);

export interface JudgeCheckout {
  /** 체크아웃 폴더 (실경로) */
  readonly dir: string;
  readonly commit: string;
  /** 임시 워크트리 등록 · 폴더를 지운다. 여러 번 불러도 된다 */
  dispose(): Promise<void>;
}

export interface CreateJudgeCheckoutInput {
  /** 프로젝트 폴더 (저장소 최상위, ADR-058) */
  repoPath: string;
  biveHome: string;
  projectId: string;
  runDisplayId: string;
  /** 판정할 커밋 */
  commit: string;
  git?: GitRunner;
}

const newId = createUlidGenerator();

/**
 * 커밋의 깨끗한 체크아웃을 만든다 (`git worktree add --detach`). 만든 뒤 HEAD · 깨끗함을 확인하고, 아니면 지우고 던진다.
 * @throws {JudgeCheckoutError} (`checkout`)
 */
export const createJudgeCheckout = async (
  input: CreateJudgeCheckoutInput,
): Promise<JudgeCheckout> => {
  const git = input.git ?? createGitRunner();
  if (!CommitSha.safeParse(input.commit).success) {
    throw new JudgeCheckoutError('checkout', `판정할 커밋이 커밋 해시가 아닙니다: ${input.commit}`);
  }
  const parent = judgeCheckoutRoot(input.biveHome, input.projectId, input.runDisplayId);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = path.join(fs.realpathSync.native(parent), newId());
  let registered = false;
  const dispose = async (): Promise<void> => {
    if (registered) {
      registered = false;
      try {
        await withGitWorktreeLock(
          input.repoPath,
          () => git(['worktree', 'remove', '--force', '--force', target], { cwd: input.repoPath }),
          { git },
        );
      } catch {
        // 등록이 이미 없으면 폴더만 지운다 (사용자의 다른 워크트리 정보를 지우는 prune은 쓰지 않는다)
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
  };
  try {
    registered = true;
    await withGitWorktreeLock(
      input.repoPath,
      () =>
        git(['worktree', 'add', '--detach', '--quiet', target, input.commit], {
          cwd: input.repoPath,
        }),
      { git },
    );
    const head = (
      await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: target })
    ).stdout.trim();
    if (head !== input.commit) {
      throw new Error(`체크아웃 HEAD가 판정할 커밋과 다릅니다: ${head}`);
    }
    // 추적 파일만 있어야 한다: 미추적 · 무시된 파일 · 변경이 하나라도 있으면 거부
    const status = await git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
      { cwd: target },
    );
    if (status.stdout !== '') {
      throw new Error(
        `체크아웃이 깨끗하지 않습니다: ${status.stdout.split('\0').join(' ').trim()}`,
      );
    }
  } catch (error) {
    await dispose();
    throw new JudgeCheckoutError(
      'checkout',
      `판정용 체크아웃을 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { dir: target, commit: input.commit, dispose };
};

/** 의존성 설치 함수 (`dir`에 설치, 출력은 `logFile`). 시험에서 바꿔 끼운다. */
export type InstallDependencies = (
  dir: string,
  options: {
    logFile: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    /** 중단 신호 (설치 프로세스 그룹을 끝낸다) */
    signal?: AbortSignal;
  },
) => Promise<void>;

/**
 * 판정 설치가 읽는 YAML(`pnpm-lock.yaml` · `pnpm-workspace.yaml`)을 엄격하게 읽는다 (#146 검토 2회차).
 * `yaml` 패키지 기본값(YAML 1.2)은 병합 키 `<<`를 병합하지 않는데 pnpm 10.28은 병합해 읽는다(실측: snapshot 의존성을
 * `<<` 아래에 두면 검사는 못 보고 pnpm은 그 `file:` 의존성을 설치했다). 검사와 pnpm이 같은 내용을 보도록, pnpm이 쓰지 않는
 * 모양은 모두 거부한다: 문서가 하나가 아님 · 파싱 오류 · 경고, 앵커 · 별칭, 병합 키 `<<`, 명시 태그(`!!map` 등), 중복 키
 * (`uniqueKeys`).
 * @throws {JudgeCheckoutError} (`install`)
 */
export const parseStrictYaml = (text: string, what: string): unknown => {
  const fail = (reason: string): never => {
    throw new JudgeCheckoutError('install', `${what}의 YAML을 받아들일 수 없습니다: ${reason}`);
  };
  const docs = parseAllDocuments(text, { uniqueKeys: true, merge: false, prettyErrors: false });
  if (!Array.isArray(docs) || docs.length !== 1) return fail('문서가 하나가 아님');
  const doc = docs[0];
  if (doc === undefined) return fail('문서가 하나가 아님');
  const problem = [...doc.errors, ...doc.warnings][0];
  if (problem !== undefined) return fail(`${problem.code} ${problem.message.split('\n')[0] ?? ''}`);
  visit(doc, {
    Alias: () => fail('앵커 · 별칭'),
    Node: (_key, node) => {
      if (node.anchor !== undefined) fail('앵커 · 별칭');
      if (node.tag !== undefined) fail(`명시 태그 ${node.tag}`);
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === '<<') fail('병합 키 <<');
    },
  });
  return doc.toJS({ maxAliasCount: 0 }) as unknown;
};

/** npm 패키지 이름 (범위 포함). 빌드 허용 목록에서 이 모양이 아닌 값은 거부한다. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

/**
 * 의존성 빌드 스크립트를 허용할 패키지 (pnpm 10 `onlyBuiltDependencies`: `pnpm-workspace.yaml` · `package.json`의
 * `pnpm.onlyBuiltDependencies`). 프로젝트 코드가 아니라 lockfile로 고정된 의존성의 스크립트만 돌리려고 쓴다.
 * @throws {JudgeCheckoutError} (`install`) 형식이 틀린 이름
 */
export const builtDependencyNames = (dir: string): string[] => {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const name of value) {
      if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
        throw new JudgeCheckoutError(
          'install',
          `빌드 허용 목록의 패키지 이름 형식 오류: ${String(name)}`,
        );
      }
      names.add(name);
    }
  };
  const workspace = path.join(dir, 'pnpm-workspace.yaml');
  if (fs.existsSync(workspace)) {
    const parsed = parseStrictYaml(fs.readFileSync(workspace, 'utf8'), 'pnpm-workspace.yaml');
    if (typeof parsed === 'object' && parsed !== null) {
      add((parsed as { onlyBuiltDependencies?: unknown }).onlyBuiltDependencies);
    }
  }
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const pnpm = (parsed as { pnpm?: unknown }).pnpm;
      if (typeof pnpm === 'object' && pnpm !== null) {
        add((pnpm as { onlyBuiltDependencies?: unknown }).onlyBuiltDependencies);
      }
    }
  }
  return [...names].sort();
};

/** lockfile 버전 9 계열(pnpm 9 · 10이 쓰는 `9.0`)만 해석한다. */
const LOCKFILE_VERSION_PREFIX = '9.';

/**
 * 레지스트리 패키지의 버전 (lockfile `packages:` 키 `<이름>@<버전>`의 버전, importers · snapshots 의존성 값에서 피어 접미
 * `(…)`를 뗀 값). `file:` · `link:` · tarball URL · git · 별칭(`<다른 이름>@<버전>`)은 이 모양이 아니다.
 */
const REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
/** snapshots 항목에서 닫힘으로 따라가는 의존성 칸 (해석된 피어 의존성도 이 두 칸에 나온다, 실측) */
const SNAPSHOT_DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies'] as const;

/** 판정 러너가 실행하는 테스트 실행기 패키지 (루트 importer가 선언한 것). 판정 설정 · 도우미는 다른 패키지를 불러오지 않는다 */
const TEST_RUNNER_PACKAGE = 'vitest';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readManifest = (file: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const stripPeers = (version: string): string => version.replace(/\(.*$/u, '');

/** lockfile 키 · 의존성 참조 `<이름>@<버전>`의 이름 (범위 이름 `@scope/x@1.0.0` 포함). 모양이 아니면 `null`. */
export const lockfileKeyName = (key: string): string | null => {
  const at = key.indexOf('@', key.startsWith('@') ? 1 : 0);
  if (at <= 0) return null;
  const name = key.slice(0, at);
  return PACKAGE_NAME.test(name) ? name : null;
};

/**
 * lockfile `overrides` 키에서 바뀌는 패키지 이름들을 뽑는다. 실측(pnpm 10.28): 키는 쓴 그대로 `name` · `name@<범위>` ·
 * `@scope/name@<범위>` · `parent>name`(부모에도 범위 가능)으로 남는다. 범위에도 `>`(`>=1` · `>7`)가 들어가 구분자와 글자만으로
 * 가를 수 없으므로, 키 전체와 각 `>` 뒤 부분을 모두 후보로 보고 이름으로 읽히는 것을 전부 돌려준다(넓게 잡아 실패 쪽으로
 * 닫음: `is-number@>7`은 `is-number`와 `7`). 하나도 읽히지 않으면 빈 목록.
 */
export const overrideTargetNames = (key: string): string[] => {
  const candidates = [key];
  for (let i = key.indexOf('>'); i !== -1; i = key.indexOf('>', i + 1)) {
    candidates.push(key.slice(i + 1));
  }
  const names = new Set<string>();
  for (const candidate of candidates) {
    const name = PACKAGE_NAME.test(candidate) ? candidate : lockfileKeyName(candidate);
    if (name !== null) names.add(name);
  }
  return [...names].sort();
};

/** 의존성 닫힘을 걸은 결과. */
export interface DependencyClosure {
  /** 닫힘 안 snapshots 키 (정렬) */
  readonly keys: string[];
  /** 레지스트리가 아닌 의존성 참조 · snapshots에 없는 키 */
  readonly problems: string[];
}

/**
 * lockfile `snapshots:`에서 시작 키들의 `dependencies` · `optionalDependencies` 닫힘을 걷는다(순환 · 여러 버전 · 피어 접미
 * 포함). 의존성 값이 피어 접미를 뗀 semver가 아니면(`file:` · `link:` · 별칭) 문제로 남기고 따라가지 않는다.
 */
export const dependencyClosure = (
  snapshots: Readonly<Record<string, unknown>>,
  start: readonly string[],
): DependencyClosure => {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [...start];
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    if (!Object.hasOwn(snapshots, key)) {
      problems.push(`${key}: snapshots에 없음`);
      continue;
    }
    const entry = snapshots[key];
    if (!isRecord(entry)) continue;
    for (const field of SNAPSHOT_DEPENDENCY_FIELDS) {
      const deps = entry[field];
      if (!isRecord(deps)) continue;
      for (const [name, value] of Object.entries(deps)) {
        if (typeof value !== 'string' || !REGISTRY_VERSION.test(stripPeers(value))) {
          problems.push(`${key} → ${name}: ${String(value)}`);
          continue;
        }
        queue.push(`${name}@${value}`);
      }
    }
  }
  return { keys: [...seen].sort(), problems };
};

interface ParsedLockfile {
  readonly packages: Record<string, unknown>;
  readonly snapshots: Record<string, unknown>;
  readonly importers: Record<string, unknown>;
  /** 패치가 걸린 패키지 이름 */
  readonly patched: Set<string>;
  /** `overrides`로 바뀌는 패키지 이름 */
  readonly overridden: Set<string>;
}

const reject = (message: string): never => {
  throw new JudgeCheckoutError('install', message);
};

/** lockfile을 읽는다. 9 계열이 아니거나 읽을 수 없거나 패치 · override 키에서 이름을 뽑을 수 없으면 거부한다. */
const readLockfile = (dir: string): ParsedLockfile => {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8');
  } catch (error) {
    return reject(
      `lockfile을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lock = parseStrictYaml(text, 'lockfile(pnpm-lock.yaml)');
  if (
    !isRecord(lock) ||
    typeof lock.lockfileVersion !== 'string' ||
    !lock.lockfileVersion.startsWith(LOCKFILE_VERSION_PREFIX)
  ) {
    return reject(
      `지원하지 않는 lockfile 형식입니다 (lockfileVersion ${isRecord(lock) ? String(lock.lockfileVersion) : '없음'})`,
    );
  }
  // `excludeLinksFromLockfile`이 켜지면 `link:` 의존성이 importers에서 빠져 lockfile만 보는 검사가 놓친다 (#146 검토 2회차)
  const settings = lock.settings;
  if (!isRecord(settings) || settings.excludeLinksFromLockfile !== false) {
    return reject(
      `lockfile settings.excludeLinksFromLockfile이 false가 아닙니다 (${isRecord(settings) ? String(settings.excludeLinksFromLockfile) : 'settings 없음'})`,
    );
  }
  const names = (value: unknown, pick: (key: string) => string[], what: string) => {
    const result = new Set<string>();
    for (const key of isRecord(value) ? Object.keys(value) : []) {
      const picked = pick(key);
      if (picked.length === 0) {
        reject(`lockfile ${what} 키에서 패키지 이름을 알 수 없습니다: ${key}`);
      }
      for (const name of picked) result.add(name);
    }
    return result;
  };
  return {
    packages: isRecord(lock.packages) ? lock.packages : {},
    snapshots: isRecord(lock.snapshots) ? lock.snapshots : {},
    importers: isRecord(lock.importers) ? lock.importers : {},
    patched: names(
      lock.patchedDependencies,
      (key) => {
        const name = PACKAGE_NAME.test(key) ? key : lockfileKeyName(key);
        return name === null ? [] : [name];
      },
      'patchedDependencies',
    ),
    overridden: names(lock.overrides, overrideTargetNames, 'overrides'),
  };
};

/** snapshots 키 하나(패키지 한 벌)의 문제: 레지스트리 해상도 아님 · 패치 · override. */
const packageProblems = (lock: ParsedLockfile, key: string): string[] => {
  const name = lockfileKeyName(key);
  if (name === null) return [`${key}: 이름을 알 수 없음`];
  const problems: string[] = [];
  const version = key.slice(name.length + 1);
  const packageKey = `${name}@${stripPeers(version)}`;
  const resolution = isRecord(lock.packages[packageKey])
    ? lock.packages[packageKey].resolution
    : undefined;
  if (!(
    REGISTRY_VERSION.test(stripPeers(version)) &&
    isRecord(resolution) &&
    Object.keys(resolution).length === 1 &&
    typeof resolution.integrity === 'string'
  )) {
    problems.push(`${packageKey}: 레지스트리 해상도(integrity만)가 아님`);
  }
  if (lock.patched.has(name) || version.includes('patch_hash=')) {
    problems.push(`${name}: 패치(patchedDependencies) 적용`);
  }
  if (lock.overridden.has(name)) problems.push(`${name}: overrides 적용`);
  return problems;
};

/** 시작 키들의 닫힘 전체 문제 (닫힘 걷기 문제 + 닫힘 안 패키지마다의 문제). */
const closureProblems = (lock: ParsedLockfile, start: readonly string[]): string[] => {
  const closure = dependencyClosure(lock.snapshots, start);
  return [
    ...closure.problems,
    ...closure.keys
      .filter((key) => Object.hasOwn(lock.snapshots, key))
      .flatMap((key) => packageProblems(lock, key)),
  ];
};

const summarize = (problems: readonly string[]): string =>
  [...new Set(problems)].slice(0, 20).join(', ');

/**
 * 빌드 허용 목록의 이름이 lockfile에서 레지스트리 패키지로만 해석되고, 그 빌드 스크립트가 부를 수 있는 의존성 닫힘에도
 * 프로젝트 코드가 없는지 확인한다 (#146, ADR-069). 허용 목록은 판정할 커밋의 파일(에이전트가 고칠 수 있음)에서 읽으므로,
 * 이름 형식만 보면 `"evil": "file:./evil"`이나 허용 패키지 의존성의 `overrides: { prebuild-install: file:./evil }`로
 * 프로젝트 안 코드를 판정 입력 지문의 기준값보다 먼저 돌리게 할 수 있다(실측: 이름을 지정한 `pnpm rebuild`가 디렉터리 ·
 * 로컬 tarball 의존성의 `postinstall`을 실행하고, better-sqlite3의 `prebuild-install || node-gyp …`가 override된 bin을
 * 실행한다). 이름마다 다음을 모두 요구한다:
 * - lockfile(`lockfileVersion` 9 계열)의 snapshots에 `<이름>@…` 항목이 하나 이상 있다(없으면 거부)
 * - 그 모든 버전에서 시작한 의존성 닫힘(`dependencyClosure`) 안 패키지마다: `packages:` 해상도가 `{integrity}` 하나뿐
 *   (디렉터리 · tarball · git 거부), 의존성 값이 semver(`link:` · `file:` · 별칭 거부), 패치 · `overrides` 대상이 아님
 * - 어느 importer도 그 이름을 semver가 아닌 버전으로 가리키지 않고, 작업 공간 프로젝트(루트 포함) 자신의 이름이 아니다
 * - 빌드 스크립트의 PATH는 패키지 자신의 `.bin` 다음에 루트 `node_modules/.bin`을 pnpm의 node-gyp보다 먼저 본다(실측).
 *   그래서 허용 목록이 비어 있지 않으면 루트 importer의 직접 의존성 중 레지스트리가 아닌 것은 bin이 없는 폴더(`file:` ·
 *   `link:` 디렉터리의 `package.json`에 `bin` · `directories.bin`이 없음)만 허용한다(tarball 등 확인할 수 없으면 거부)
 * frozen 설치라 lockfile은 `package.json`과 맞아야 하므로 lockfile만 본다.
 * @throws {JudgeCheckoutError} (`install`) 하나라도 어긋나면 (fail closed)
 */
export const assertRegistryBuiltDependencies = (dir: string, names: readonly string[]): void => {
  if (names.length === 0) return;
  const lock = readLockfile(dir);
  const projectNames = new Set<string>();
  for (const importer of new Set(['.', ...Object.keys(lock.importers)])) {
    const name = readManifest(path.join(dir, importer, 'package.json'))?.name;
    if (typeof name === 'string') projectNames.add(name);
  }
  for (const name of names) {
    const problems: string[] = [];
    if (projectNames.has(name)) problems.push('작업 공간 프로젝트 이름');
    const start = Object.keys(lock.snapshots).filter((key) => lockfileKeyName(key) === name);
    // packages에만 있고 snapshots에 없는 같은 이름 항목(다른 해상도)도 본다
    for (const key of Object.keys(lock.packages)) {
      if (lockfileKeyName(key) === name && !start.some((s) => stripPeers(s) === key)) {
        problems.push(`${key}: snapshots에 없음`);
      }
    }
    for (const [importer, value] of Object.entries(lock.importers)) {
      if (!isRecord(value)) continue;
      for (const field of DEPENDENCY_FIELDS) {
        const deps = value[field];
        if (!isRecord(deps) || !Object.hasOwn(deps, name)) continue;
        const dep = deps[name];
        const version = isRecord(dep) ? dep.version : dep;
        if (typeof version !== 'string' || !REGISTRY_VERSION.test(stripPeers(version))) {
          problems.push(`${importer} ${field} ${String(version)}`);
        }
      }
    }
    problems.push(...closureProblems(lock, start));
    if (problems.length > 0) {
      reject(
        `빌드 허용 목록의 패키지 ${name}의 lockfile 해상도가 레지스트리가 아닙니다 (${summarize(problems)})`,
      );
    }
    if (start.length === 0) reject(`빌드 허용 목록의 패키지 ${name}: lockfile에 없습니다`);
  }
  // 빌드 스크립트 PATH에 먼저 오는 루트 node_modules/.bin: 레지스트리가 아닌 직접 의존성이 bin을 내면 거부
  const root = lock.importers['.'];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = isRecord(root) ? root[field] : undefined;
    if (!isRecord(deps)) continue;
    for (const [dep, value] of Object.entries(deps)) {
      const version = isRecord(value) ? value.version : value;
      if (typeof version === 'string' && REGISTRY_VERSION.test(stripPeers(version))) continue;
      const folder =
        typeof version === 'string' && /^(link|file):/u.test(version)
          ? path.resolve(dir, version.slice(5))
          : null;
      const manifest = folder === null ? null : readManifest(path.join(folder, 'package.json'));
      const directories = manifest?.directories;
      const hasBin =
        manifest === null ||
        manifest.bin !== undefined ||
        (isRecord(directories) && directories.bin !== undefined);
      if (hasBin) {
        reject(
          `빌드 허용 목록이 있을 때 루트의 레지스트리가 아닌 직접 의존성은 실행 파일(bin)을 낼 수 없습니다: ${dep} (${String(version)})`,
        );
      }
    }
  }
};

/**
 * 판정 러너가 실행하는 테스트 실행기(루트 importer가 선언한 `vitest`)와 그 의존성 닫힘이 모두 레지스트리 패키지인지 확인한다
 * (#146, ADR-069). 지문은 기준값 뒤의 변경만 보므로, 커밋이 `"vitest": "file:./x"` · `patchedDependencies: vitest@…` ·
 * 의존성 `overrides`로 실행기를 프로젝트 코드로 바꾸면 판정이 그 코드로 돈다. 빌드 허용 목록과 같은 닫힘 검사를 한다.
 * 판정 생성 설정 · globalSetup · HTTP 도우미는 다른 패키지를 불러오지 않으므로 시작점은 `vitest` 하나다.
 * @throws {JudgeCheckoutError} (`install`) 선언 없음 · 레지스트리가 아닌 해상도 · 패치 · override
 */
export const assertRegistryTestRunner = (dir: string): void => {
  const lock = readLockfile(dir);
  const root = lock.importers['.'];
  let version: unknown;
  for (const field of DEPENDENCY_FIELDS) {
    const deps = isRecord(root) ? root[field] : undefined;
    if (isRecord(deps) && Object.hasOwn(deps, TEST_RUNNER_PACKAGE)) {
      const dep = deps[TEST_RUNNER_PACKAGE];
      version = isRecord(dep) ? dep.version : dep;
    }
  }
  if (version === undefined) {
    reject(`판정 실행기 ${TEST_RUNNER_PACKAGE}가 프로젝트(루트) 의존성에 없습니다`);
  }
  if (typeof version !== 'string' || !REGISTRY_VERSION.test(stripPeers(version))) {
    return reject(
      `판정 실행기 ${TEST_RUNNER_PACKAGE}의 lockfile 해상도가 레지스트리가 아닙니다 (루트 ${String(version)})`,
    );
  }
  const problems = closureProblems(lock, [`${TEST_RUNNER_PACKAGE}@${version}`]);
  if (problems.length > 0) {
    reject(
      `판정 실행기 ${TEST_RUNNER_PACKAGE}의 의존성 닫힘에 레지스트리가 아닌 패키지가 있습니다 (${summarize(problems)})`,
    );
  }
};

/** 판정 설치의 hoist 설정 고정: 프로젝트 `.npmrc` · `pnpm-workspace.yaml`의 hoist 설정이 bin을 루트로 올리지 못하게 한다. */
const LAYOUT_FLAGS = [
  '--config.node-linker=isolated',
  '--config.shamefully-hoist=false',
  '--config.public-hoist-pattern=',
] as const;

/**
 * 빌드 스크립트 PATH에 드는 공용 bin 폴더(실측 순서: 패키지 자신 · `.pnpm/<id>/node_modules/.bin`(닫힘 검사 대상) → 루트
 * `node_modules/.bin` → pnpm `node-gyp-bin` → `.pnpm/node_modules/.bin`(내부 hoist))의 각 항목이 레지스트리 패키지 폴더 안을
 * 가리키는지 확인한다 (#146 검토 2회차). 항목은 pnpm 셸 shim(대상 `"$basedir/<경로>"`) 또는 링크다. 대상 실경로가
 * `node_modules/.pnpm/<디렉터리>/node_modules/<이름>/` 안이고, `<디렉터리>`가 lockfile `packages:`의 `<이름>@<semver>`
 * (범위 이름의 `/`는 `+`, 피어 접미는 `_…`)이며 그 패키지가 닫힘 검사의 패키지 규칙(레지스트리 해상도 · 패치 · override 없음)을
 * 통과해야 한다. 대상을 읽을 수 없는 항목, 프로젝트 폴더 · `file:` · `link:` 패키지를 가리키는 항목은 거부한다.
 * Windows의 `.cmd` · `.ps1`은 같은 이름의 셸 shim이 확인됐을 때만 받아들인다(Windows 실기기 미확인).
 * @throws {JudgeCheckoutError} (`install`)
 */
export const assertBuildPathBins = (dir: string): void => {
  const lock = readLockfile(dir);
  const store = path.join(dir, 'node_modules', '.pnpm');
  let storeReal: string;
  try {
    storeReal = fs.realpathSync(store);
  } catch {
    return; // 설치된 의존성이 없다
  }
  const allowedTarget = (file: string): boolean => {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return false;
    }
    const rel = path.relative(storeReal, real).split(path.sep);
    const [dirName, nodeModules, first, second] = rel;
    if (
      dirName === undefined ||
      dirName === '..' ||
      path.isAbsolute(path.relative(storeReal, real))
    ) {
      return false;
    }
    if (nodeModules !== 'node_modules' || first === undefined) return false;
    const name = first.startsWith('@') && second !== undefined ? `${first}/${second}` : first;
    const encoded = name.replace('/', '+');
    if (!dirName.startsWith(`${encoded}@`)) return false;
    const rest = dirName.slice(encoded.length + 1);
    const version = rest.split('_')[0] ?? '';
    if (!REGISTRY_VERSION.test(version) || rest.includes('patch_hash')) return false;
    return packageProblems(lock, `${name}@${version}`).length === 0;
  };
  for (const binDir of [
    path.join(dir, 'node_modules', '.bin'),
    path.join(store, 'node_modules', '.bin'),
  ]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(binDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      const full = path.join(binDir, entry.name);
      const where = `${path.relative(dir, binDir)}/${entry.name}`;
      const windowsShim = /\.(cmd|ps1)$/iu.exec(entry.name);
      if (windowsShim !== null && names.has(entry.name.slice(0, windowsShim.index))) continue;
      let targets: string[];
      if (entry.isSymbolicLink()) {
        targets = [full];
      } else if (entry.isFile()) {
        const body = fs.readFileSync(full, 'utf8');
        targets = [...body.matchAll(/"\$basedir\/([^"$]+)"/gu)]
          .map((match) => match[1] ?? '')
          .filter((target) => target !== 'node' && target !== '')
          .map((target) => path.resolve(binDir, target));
      } else {
        targets = [];
      }
      if (targets.length === 0 || !targets.every(allowedTarget)) {
        reject(
          `빌드 스크립트 PATH의 실행 파일 ${where}가 레지스트리 패키지 폴더를 가리키지 않습니다 (판정 설치 거부)`,
        );
      }
    }
  }
};

/**
 * lockfile 기준 의존성 설치. M1은 pnpm(`pnpm-lock.yaml`)만 지원한다.
 * 1. `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --ignore-pnpmfile --package-import-method=copy`
 *    - 프로젝트의 설치 수명 주기 스크립트(`preinstall` · `postinstall` · `prepare` 등)와 `.pnpmfile.cjs`는 에이전트가
 *      고칠 수 있는 코드라 돌리지 않는다(검토 1 · 2회차, ADR-069). lockfile에 `pnpmfileChecksum`이 있으면 frozen 설치가
 *      설정 불일치로 실패한다(실측) → 설치 실패로 닫힌다
 *    - 전역 pnpm 저장소와 하드 링크하지 않고 복사한다: 판정 중 코드가 의존성 파일을 고쳐도 저장소 · 다른 프로젝트로
 *      번지지 않게 (픽스처 기준 약 5초 · 855MB)
 * 2. `pnpm rebuild --config.ignore-pnpmfile=true <허용 목록>`: 빌드 허용 목록(`onlyBuiltDependencies`)에 있는 의존성의
 *    빌드 스크립트만 돌린다(네이티브 모듈 · 엔진 내려받기). 이름을 지정한 rebuild는 프로젝트 스크립트를 돌리지 않고,
 *    `rebuild`는 `--ignore-pnpmfile` 옵션을 모르며 설정 값으로 줘야 pnpmfile을 건너뛴다(실측). 허용 목록의 이름은 설치 전에
 *    lockfile에서 의존성 닫힘까지 레지스트리 패키지로만 해석되는지, 판정 실행기 vitest와 그 닫힘도 그런지 확인한다
 *    (`assertRegistryBuiltDependencies` · `assertRegistryTestRunner`, #146)
 *    설치 · rebuild 모두 `node-linker=isolated` · `shamefully-hoist=false` · `public-hoist-pattern=`(빈 값)으로 고정하고,
 *    rebuild 전에 빌드 스크립트 PATH의 공용 bin 폴더를 `assertBuildPathBins`로 확인한다(#146 검토 2회차). 빌드 허용 목록이
 *    비어 있으면 rebuild가 없고, 판정 러너는 vitest를 shim 없이 직접 실행하므로 지문 기준값 전에 `.bin`을 거치는 실행이 없다
 * 프로젝트가 설치 때 하던 생성 단계(`prisma generate`)는 스택 프로필이 따로 한다.
 * 셸 없이 PATH의 `pnpm`을 실행하고 환경 변수는 판정 러너와 같은 허용 목록 + `CI=1`만 넘긴다.
 * @throws {JudgeCheckoutError} (`install`) lockfile 없음 · 레지스트리가 아닌 빌드 허용 목록 · 실행기 닫힘 · 설치 실패 · 시간 초과 · 중단
 */
export const installDependencies: InstallDependencies = async (dir, options) => {
  if (!fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) {
    throw new JudgeCheckoutError(
      'install',
      '지원하는 lockfile이 없습니다 (M1은 pnpm-lock.yaml만 지원)',
    );
  }
  // 허용 목록은 설치 전에 확인한다: 어긋나면 아무것도 설치 · 실행하지 않고 닫는다
  const built = builtDependencyNames(dir);
  assertRegistryBuiltDependencies(dir, built);
  assertRegistryTestRunner(dir);
  const started = Date.now();
  const run = async (args: string[], what: string): Promise<void> => {
    const result = await runCommand('pnpm', args, {
      cwd: dir,
      env: { ...baseChildEnv(options.env), CI: '1', NO_COLOR: '1' },
      stdoutFile: options.logFile,
      timeoutMs: Math.max(0, options.timeoutMs - (Date.now() - started)),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (result.aborted) throw new JudgeCheckoutError('install', `${what} 중단`);
    if (result.timedOut) throw new JudgeCheckoutError('install', `${what} 시간 초과`);
    if (result.code !== 0 || result.error !== null) {
      throw new JudgeCheckoutError(
        'install',
        `${what} 실패 (${describeExit(result)}, ${options.logFile})`,
      );
    }
  };
  await run(
    [
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
      '--ignore-scripts',
      '--ignore-pnpmfile',
      '--package-import-method=copy',
      ...LAYOUT_FLAGS,
      '--reporter=append-only',
    ],
    '의존성 설치',
  );
  if (built.length > 0) {
    // 빌드 스크립트가 PATH에서 찾을 수 있는 bin이 모두 레지스트리 패키지의 것인지 rebuild 전에 확인한다(최종 관문)
    assertBuildPathBins(dir);
    await run(
      [
        'rebuild',
        '--config.ignore-pnpmfile=true',
        ...LAYOUT_FLAGS,
        '--reporter=append-only',
        ...built,
      ],
      '의존성 빌드',
    );
  }
};

/**
 * `bive-acceptance/` 아래 일반 파일 · 링크(대상 문자열)의 SHA-256 (상대 경로 `/` 구분 → 16진수, `node_modules` 포함).
 * Red 확인 통과 때 기록하고, 검사 단계(#29)가 판정 직전 같은 값인지 대조한다(architecture.md 4장 인수 테스트 보호).
 */
export const hashAcceptanceFiles = (dir: string): Record<string, string> => {
  const root = path.join(dir, ACCEPTANCE_DIR);
  const hashes: Record<string, string> = {};
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        // `node_modules`도 걷는다: 인수 테스트의 맨 이름 import(`vitest`)는 그 자리를 먼저 찾는다 (검토 2회차)
        walk(full);
      } else if (entry.isSymbolicLink()) {
        hashes[rel] = createHash('sha256')
          .update(`link:${fs.readlinkSync(full)}`)
          .digest('hex');
      } else if (entry.isFile()) {
        hashes[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(root);
  return hashes;
};
