// 변이 제안의 검증 · 적용 (JDG-04 · RUN-04 · NFR-01 · NFR-02, M3-07 #52, ADR-033 · ADR-139).
// 변이 주입 역할이 `propose_mutant`로 낸 변이(파일 하나 · 한 군데)를 판정할 커밋의 git 객체에서 검증한다. 작업 트리 · 실행 워크트리 ·
// 규범 저장소를 읽거나 바꾸지 않는다. 적용은 판정 체크아웃(격리, 판정 뒤 지움)에만 하고 커밋하지 않는다(`steps/judging.ts`).
// 검증: ① 경로 형식(프로젝트 루트 기준 `/` 경로, `.` · `..` · 빈 구간 · 역슬래시 없음) ② 금지 경로(숨김 구간 = `.git` · `.bive.json` ·
// `.npmrc` · `.env` 등, 인수 테스트, 의존성 폴더, Prisma 폴더, 패키지 · 잠금 · 설정 파일, 등록된 계약 원본) ③ 대상 규칙의 대상 블록
// `include`에 드는 파일 ④ 판정 커밋에 있는 일반 파일 · 크기 상한 · UTF-8 글 ⑤ 바꿀 글이 정확히 한 번 나옴(여러 군데 · 없음은 거부).
import { type Block, matchesBlockPattern, type MutantPatch } from '@bive/shared';

import type { ToolResult } from '../agent/adapter.js';
import type { GitRunner } from '../git/git-exec.js';
import { ACCEPTANCE_DIR, DEPENDENCY_DIR } from '../tools/path-guard.js';
import { denied, failed } from '../tools/result.js';

/** 변이를 낼 수 있는 파일의 크기 상한 (바이트, 파일 도구의 읽기 상한과 같다). */
export const MUTANT_FILE_MAX_BYTES = 1024 * 1024;

/** 이름만으로 막는 패키지 · 잠금 · 작업 공간 파일 (소문자 비교). */
const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
]);

/** 설정 파일 이름 (`*.config.*` · `tsconfig*.json`, 소문자 비교). 빌드 · 테스트 실행기를 바꾸는 파일이다. */
const isConfigName = (name: string): boolean =>
  /\.config\.[^/]+$/u.test(name) || /^tsconfig[^/]*\.json$/u.test(name);

/** 판정 커밋의 추적 파일 1개 (`git ls-tree -r -l`). */
export interface TreeFile {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  /** 바이트 (읽지 못하면 `NaN`) */
  readonly size: number;
}

/** 커밋 이름의 형식 (SHA-1 40자 · SHA-256 64자, 소문자 16진). */
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * 커밋의 모든 추적 항목 (하위 폴더 포함, 경로 순). git 객체에서 읽고 작업 트리를 보지 않는다.
 * @throws 커밋 이름이 형식이 아니거나 git이 실패하면
 */
export const listCommitFiles = async (
  git: GitRunner,
  repoPath: string,
  commit: string,
): Promise<TreeFile[]> => {
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`커밋 이름 형식 오류: ${commit}`);
  const { stdout } = await git(
    ['--no-replace-objects', 'ls-tree', '-r', '-z', '-l', '--full-tree', commit],
    { cwd: repoPath },
  );
  return stdout
    .split('\0')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) return [];
      const [mode = '', type = '', object = '', size = ''] = line.slice(0, tab).split(/ +/u);
      return [{ path: line.slice(tab + 1), mode, type, object, size: Number(size) }];
    });
};

/** 일반 파일(실행 비트 무관)인지. 링크 · 하위 모듈은 아니다. */
export const isRegularBlob = (file: TreeFile): boolean =>
  file.type === 'blob' && (file.mode === '100644' || file.mode === '100755');

/** U+FFFD: 디코드 손실과 구별할 수 없어 그런 파일은 글로 보지 않는다 (계약 원본 읽기와 같은 기준). */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * git 객체의 내용을 UTF-8 글로 읽는다. 글이 아니면(NUL · 대체 문자) `null`.
 * @throws git이 실패하면
 */
export const readBlobText = async (
  git: GitRunner,
  repoPath: string,
  object: string,
): Promise<string | null> => {
  const { stdout } = await git(['--no-replace-objects', 'cat-file', 'blob', object], {
    cwd: repoPath,
  });
  if (stdout.includes('\0') || stdout.includes(REPLACEMENT_CHARACTER)) return null;
  return stdout;
};

/**
 * 변이를 낼 수 없는 경로의 사유 (형식 · 금지 경로). 문제가 없으면 `null`. 금지 판정은 대소문자를 구분하지 않는다(`.GIT` · `Package.json`).
 * `contractFiles`는 등록된 계약 원본 파일 경로다.
 */
export const mutantPathProblem = (
  relPath: string,
  contractFiles: readonly string[] = [],
): string | null => {
  if (relPath.includes('\\') || relPath.startsWith('/') || relPath.includes('\0')) {
    return '경로 형식 오류 (프로젝트 루트 기준 / 경로)';
  }
  const segments = relPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return '경로 형식 오류 (빈 구간 · . · .. 불가)';
  }
  const folded = segments.map((segment) => segment.toLowerCase());
  const name = folded.at(-1) ?? '';
  if (folded.some((segment) => segment.startsWith('.'))) {
    return '숨김 경로(.git · .bive.json · 설정 계열)는 대상이 아님';
  }
  if (folded[0] === ACCEPTANCE_DIR) return '인수 테스트 파일은 대상이 아님';
  if (folded.includes(DEPENDENCY_DIR)) return '의존성 폴더는 대상이 아님';
  if (folded[0] === 'prisma') return 'DB 스키마 · 마이그레이션 파일은 대상이 아님';
  if (MANIFEST_NAMES.has(name)) return '패키지 · 잠금 파일은 대상이 아님';
  if (isConfigName(name)) return '설정 파일은 대상이 아님';
  if (contractFiles.some((file) => file.toLowerCase() === folded.join('/'))) {
    return '계약 원본 파일은 대상이 아님';
  }
  return null;
};

/** 파일이 블록 목록 가운데 하나의 `include`에 드는지 (대소문자 구분, 블록 선언의 매처 그대로). */
export const inBlocks = (relPath: string, blocks: readonly Block[]): boolean =>
  blocks.some((block) => block.include.some((pattern) => matchesBlockPattern(pattern, relPath)));

/** `text` 안에서 `search`가 나오는 횟수 (겹침 없이, 2에서 멈춘다). */
const occurrences = (text: string, search: string): number => {
  let count = 0;
  let from = 0;
  while (count < 2) {
    const at = text.indexOf(search, from);
    if (at < 0) break;
    count += 1;
    from = at + search.length;
  }
  return count;
};

/** 판정 커밋에서 검증한 변이: 적용하면 그 파일이 `mutated`가 된다. */
export interface CheckedMutant {
  readonly patch: MutantPatch;
  readonly mutated: string;
}

export interface MutantCheckContext {
  readonly git: GitRunner;
  readonly repoPath: string;
  /** 판정 커밋의 추적 파일 (경로 → 항목) */
  readonly files: ReadonlyMap<string, TreeFile>;
  /** 대상 규칙의 대상 블록 (지금 선언의 블록) */
  readonly blocks: readonly Block[];
  readonly contractFiles: readonly string[];
}

/**
 * 변이 하나를 판정 커밋에서 검증한다. 통과하면 바뀐 파일 내용을, 아니면 모델에게 돌려줄 도구 결과(`denied` · `error`)를 준다.
 * @throws git이 실패하면 (실행기가 `tool_failed`로 바꾼다)
 */
export const checkMutant = async (
  patch: MutantPatch,
  context: MutantCheckContext,
): Promise<{ ok: true; mutant: CheckedMutant } | { ok: false; result: ToolResult }> => {
  const problem = mutantPathProblem(patch.path, context.contractFiles);
  if (problem !== null) return { ok: false, result: denied('path_denied', problem) };
  if (!inBlocks(patch.path, context.blocks)) {
    return {
      ok: false,
      result: denied('path_denied', '대상 규칙의 대상 블록(include) 밖 파일은 대상이 아님'),
    };
  }
  const file = context.files.get(patch.path);
  if (file === undefined)
    return { ok: false, result: failed('not_found', '판정 커밋에 없는 파일') };
  if (!isRegularBlob(file)) return { ok: false, result: failed('not_a_file', '일반 파일이 아님') };
  if (!(file.size <= MUTANT_FILE_MAX_BYTES)) {
    return { ok: false, result: failed('too_large', '파일이 상한(1 MiB)을 넘음') };
  }
  const text = await readBlobText(context.git, context.repoPath, file.object);
  if (text === null) return { ok: false, result: failed('not_a_file', 'UTF-8 글 파일이 아님') };
  const count = occurrences(text, patch.search);
  if (count === 0) {
    return { ok: false, result: denied('invalid_args', '바꿀 글(search)이 파일에 없음') };
  }
  if (count > 1) {
    return {
      ok: false,
      result: denied(
        'invalid_args',
        '바꿀 글(search)이 파일에 여러 번 나옴: 한 군데만 바꾸도록 앞뒤 글을 더 넣는다',
      ),
    };
  }
  const at = text.indexOf(patch.search);
  const mutated = text.slice(0, at) + patch.replace + text.slice(at + patch.search.length);
  return { ok: true, mutant: { patch, mutated } };
};
