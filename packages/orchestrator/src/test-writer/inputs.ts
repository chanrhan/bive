// test-writer 세션 작업 디렉터리 (NFR-02 · RUN-04, ADR-024 · ADR-052 · ADR-068).
// 허용 목록 방식: 세션 디렉터리에는 아래 입력 사본만 둔다. 소스 코드 · 설정 · `node_modules` · `.git`은 없다.
// - `rules/<RULE-ID>.md`: 대상 규칙 진술 (저장소의 규칙 값)
// - `routes.md`: 라우트 목록 (Next.js App Router의 `route.*` · `page.*` 위치에서 만든 경로 · 메서드, 코드 아님)
// - `prisma/schema.prisma`: Prisma 스키마 사본 (있을 때)
// - `bive-acceptance/<규칙 폴더>/**/*.acc.ts`: 다른 규칙의 기존 인수 테스트 사본
// 세션이 쓴 결과는 대상 규칙 폴더의 `*.acc.ts`만 오케스트레이터가 실행 워크트리로 옮긴다(그 폴더의 `*.acc.ts`를 통째로 교체).
import fs from 'node:fs';
import path from 'node:path';

import type { Rule } from '@bive/shared';

import { ACCEPTANCE_DECLARATION_FILES } from '../judge/acceptance-env.js';
import { ACCEPTANCE_DIR, ACCEPTANCE_SUFFIX } from '../judge/config.js';

/** 세션 디렉터리 안 입력 위치. */
export const TEST_WRITER_INPUTS = {
  rulesDir: 'rules',
  routes: 'routes.md',
  prismaSchema: 'prisma/schema.prisma',
  acceptanceDir: ACCEPTANCE_DIR,
} as const;

/** 프롬프트 · 입력에 쓰는 규칙 값. */
export type TestWriterRule = Pick<
  Rule,
  'displayId' | 'title' | 'statement' | 'kind' | 'checkKinds'
>;

const ROUTE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx|mjs)$/u;
const PAGE_FILE = /^page\.(?:ts|tsx|js|jsx|mdx)$/u;

/** 링크를 따라가지 않는 파일 종류. 없으면 `null`. */
const lstatKind = (target: string): 'file' | 'dir' | 'other' | null => {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'dir';
  return 'other';
};

/** 정렬된 디렉터리 항목 (링크는 따라가지 않는다). 없거나 폴더가 아니면 빈 목록. */
const entriesOf = (dir: string): fs.Dirent[] => {
  if (lstatKind(dir) !== 'dir') return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** route handler 파일에서 내보낸 HTTP 메서드 (찾지 못하면 빈 목록). */
export const exportedMethods = (source: string): string[] => {
  const found = new Set<string>();
  const names = ROUTE_METHODS.join('|');
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+(${names})\\b`, 'gu'),
    new RegExp(`export\\s+(?:const|let|var)\\s+(${names})\\b`, 'gu'),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1] !== undefined) found.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/gu)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/u)
        .at(-1)
        ?.trim();
      if (name !== undefined && (ROUTE_METHODS as readonly string[]).includes(name))
        found.add(name);
    }
  }
  return ROUTE_METHODS.filter((method) => found.has(method));
};

export interface RouteEntry {
  /** URL 경로 (동적 세그먼트는 `[id]` 그대로) */
  path: string;
  kind: 'route' | 'page';
  /** route handler가 내보낸 메서드 (페이지는 빈 목록) */
  methods: string[];
  /** 워크트리 기준 파일 위치 */
  file: string;
}

/**
 * Next.js App Router 라우트 목록. 앱 폴더는 루트 `app/`이 있으면 그것, 없으면 `src/app/`(Next.js와 같은 순서).
 * 경로 그룹 `(이름)`은 경로에서 빼고, 비공개 폴더 `_이름` · 병렬 경로 `@슬롯` · 가로채기 경로 `(.)…`는 건너뛴다.
 * 링크 · `node_modules`는 따라가지 않는다. Pages Router(`pages/`)는 M1 범위 밖이다(ADR-068).
 */
export const listAppRoutes = (worktree: string): RouteEntry[] => {
  const candidates = ['app', path.join('src', 'app')];
  const appRel = candidates.find((rel) => lstatKind(path.join(worktree, rel)) === 'dir');
  if (appRel === undefined) return [];
  const routes: RouteEntry[] = [];
  const walk = (dirRel: string, segments: string[]): void => {
    for (const entry of entriesOf(path.join(worktree, dirRel))) {
      const rel = path.join(dirRel, entry.name);
      if (entry.isDirectory()) {
        const name = entry.name;
        if (name === 'node_modules' || name.startsWith('_') || name.startsWith('@')) continue;
        if (name.startsWith('(.')) continue;
        const group = name.startsWith('(') && name.endsWith(')');
        walk(rel, group ? segments : [...segments, name]);
        continue;
      }
      if (!entry.isFile()) continue;
      const urlPath = `/${segments.join('/')}`;
      const file = rel.split(path.sep).join('/');
      if (ROUTE_FILE.test(entry.name)) {
        const source = fs.readFileSync(path.join(worktree, rel), 'utf8');
        routes.push({ path: urlPath, kind: 'route', methods: exportedMethods(source), file });
      } else if (PAGE_FILE.test(entry.name)) {
        routes.push({ path: urlPath, kind: 'page', methods: [], file });
      }
    }
  };
  walk(appRel, []);
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
};

/** `routes.md` 본문. */
export const renderRoutes = (routes: readonly RouteEntry[]): string => {
  const lines = [
    '# 라우트 목록',
    '',
    'BIVE가 프로젝트의 Next.js App Router 파일 위치에서 만든 목록이다. 판정 서버에는 이 경로로 HTTP 요청만 보낸다.',
    '',
  ];
  if (routes.length === 0) lines.push('(라우트 없음)');
  for (const route of routes) {
    if (route.kind === 'page') lines.push(`- 페이지 GET ${route.path}`);
    else {
      const methods = route.methods.length > 0 ? route.methods.join(' · ') : '(메서드 확인 불가)';
      lines.push(`- API ${methods} ${route.path}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

/** `rules/<RULE-ID>.md` 본문. */
export const renderRule = (rule: TestWriterRule): string =>
  [
    `# ${rule.displayId} ${rule.title}`,
    '',
    `- 인수 테스트 폴더: ${ACCEPTANCE_DIR}/${rule.displayId}/`,
    `- 종류: ${rule.kind}`,
    `- 검사 종류: ${rule.checkKinds.join(' · ')}`,
    '',
    '## 진술',
    '',
    rule.statement,
    '',
  ].join('\n');

const writeNew = (target: string, content: string | Buffer): void => {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
};

/** 기존 인수 테스트: `bive-acceptance/<규칙 폴더>/` 아래 `*.acc.ts` 일반 파일 (링크 · `node_modules` 제외). */
export const listAcceptanceTests = (worktree: string): string[] => {
  const found: string[] = [];
  const walk = (dirRel: string, depth: number): void => {
    for (const entry of entriesOf(path.join(worktree, dirRel))) {
      const rel = path.join(dirRel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(rel, depth + 1);
      } else if (entry.isFile() && depth >= 1 && entry.name.endsWith(ACCEPTANCE_SUFFIX)) {
        found.push(rel.split(path.sep).join('/'));
      }
    }
  };
  walk(ACCEPTANCE_DIR, 0);
  return found.sort();
};

export interface PreparedInputs {
  /** 세션 디렉터리 기준 입력 파일 (정렬) */
  files: string[];
  routes: RouteEntry[];
}

/**
 * 빈 세션 디렉터리에 허용 입력 사본을 만든다. 워크트리의 파일은 링크를 따라가지 않고 일반 파일만 복사한다.
 * @throws 세션 디렉터리가 비어 있지 않을 때
 */
export const prepareTestWriterInputs = (input: {
  worktree: string;
  sessionDir: string;
  rules: readonly TestWriterRule[];
}): PreparedInputs => {
  const { worktree, sessionDir } = input;
  if (fs.readdirSync(sessionDir).length > 0) {
    throw new Error(`세션 디렉터리가 비어 있지 않습니다: ${sessionDir}`);
  }
  const files: string[] = [];
  const put = (rel: string, content: string | Buffer): void => {
    writeNew(path.join(sessionDir, rel), content);
    files.push(rel);
  };
  for (const rule of input.rules) {
    put(`${TEST_WRITER_INPUTS.rulesDir}/${rule.displayId}.md`, renderRule(rule));
  }
  const routes = listAppRoutes(worktree);
  put(TEST_WRITER_INPUTS.routes, renderRoutes(routes));
  const schema = path.join(worktree, TEST_WRITER_INPUTS.prismaSchema);
  if (lstatKind(schema) === 'file') put(TEST_WRITER_INPUTS.prismaSchema, fs.readFileSync(schema));
  // 대상 규칙 폴더의 기존 테스트는 넣지 않는다: 대상 규칙 폴더는 이번 시도의 결과로 통째로 정해진다
  // (Red 미충족 뒤 되돌린 워크트리에는 앞 시도의 테스트가 남아 있고, 세션에는 지우기 도구가 없다)
  const targets = new Set(input.rules.map((rule) => rule.displayId));
  for (const rel of listAcceptanceTests(worktree)) {
    if (targets.has(rel.split('/')[1] ?? '')) continue;
    put(rel, fs.readFileSync(path.join(worktree, rel)));
  }
  return { files: files.sort(), routes };
};

export interface CollectedOutputs {
  /** 규칙 표시 ID → 그 규칙 폴더의 `*.acc.ts` (세션 디렉터리 기준, 정렬) */
  byRule: Record<string, string[]>;
  /** 대상 규칙 폴더 안의 `*.acc.ts`가 아닌 파일 (옮기지 않는다) */
  ignored: string[];
}

/** 세션이 끝난 뒤 대상 규칙 폴더의 결과를 모은다. 링크 · 일반 파일이 아닌 항목은 무시 목록에 넣는다. */
export const collectTestWriterOutputs = (
  sessionDir: string,
  ruleIds: readonly string[],
): CollectedOutputs => {
  const byRule: Record<string, string[]> = {};
  const ignored: string[] = [];
  for (const ruleId of ruleIds) {
    const files: string[] = [];
    const walk = (dirRel: string): void => {
      for (const entry of entriesOf(path.join(sessionDir, dirRel))) {
        const rel = path.join(dirRel, entry.name);
        const relPosix = rel.split(path.sep).join('/');
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile() && entry.name.endsWith(ACCEPTANCE_SUFFIX)) files.push(relPosix);
        else ignored.push(relPosix);
      }
    };
    walk(path.join(ACCEPTANCE_DIR, ruleId));
    byRule[ruleId] = files.sort();
  }
  return { byRule, ignored: ignored.sort() };
};

/** 워크트리 안 경로의 각 상위 폴더가 링크가 아닌 실제 폴더인지 확인하며 만든다. */
const ensureRealDirs = (worktree: string, relDir: string): void => {
  let current = worktree;
  for (const segment of relDir.split('/').filter((s) => s !== '')) {
    current = path.join(current, segment);
    const kind = lstatKind(current);
    if (kind === null) fs.mkdirSync(current, { mode: 0o755 });
    else if (kind !== 'dir') {
      throw new Error(
        `인수 테스트 경로가 폴더가 아닙니다 (링크 등): ${path.relative(worktree, current)}`,
      );
    }
  }
};

/** 워크트리에 파일을 쓴다. 대상이 링크 · 일반 파일이 아닌 항목이면 거부한다. */
const writeIntoWorktree = (worktree: string, rel: string, content: string | Buffer): void => {
  ensureRealDirs(worktree, path.posix.dirname(rel));
  const target = path.join(worktree, rel);
  const kind = lstatKind(target);
  if (kind !== null && kind !== 'file') {
    throw new Error(`인수 테스트 파일 자리가 일반 파일이 아닙니다: ${rel}`);
  }
  if (kind === 'file') fs.rmSync(target);
  fs.writeFileSync(target, content, { flag: 'wx', mode: 0o644 });
};

/** 워크트리 대상 규칙 폴더 안의 `*.acc.ts` 항목(일반 파일 · 링크, 링크는 따라가지 않음). */
const existingTargetTests = (worktree: string, ruleIds: readonly string[]): string[] => {
  const found: string[] = [];
  const walk = (dirRel: string): void => {
    for (const entry of entriesOf(path.join(worktree, dirRel))) {
      const rel = path.join(dirRel, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(ACCEPTANCE_SUFFIX)) found.push(rel.split(path.sep).join('/'));
    }
  };
  for (const ruleId of ruleIds) {
    const dir = path.join(ACCEPTANCE_DIR, ruleId);
    const kind = lstatKind(path.join(worktree, dir));
    if (kind === 'dir') walk(dir);
    else if (kind !== null) {
      throw new Error(
        `인수 테스트 경로가 폴더가 아닙니다 (링크 등): ${dir.split(path.sep).join('/')}`,
      );
    }
  }
  return found.sort();
};

export interface AppliedOutputs {
  /** 워크트리에 쓴 파일 (워크트리 기준) */
  written: string[];
  /** 이번 결과에 없어 지운 대상 규칙 폴더의 기존 `*.acc.ts` */
  removed: string[];
}

/**
 * 세션 결과와 BIVE 선언 파일을 실행 워크트리에 옮긴다. 대상 규칙 폴더의 `*.acc.ts`는 이번 결과로 통째로 바꾼다
 * (결과에 없는 기존 파일은 지운다). 커밋은 엔진이 한다.
 */
export const applyTestWriterOutputs = (input: {
  worktree: string;
  sessionDir: string;
  ruleIds: readonly string[];
  files: readonly string[];
}): AppliedOutputs => {
  const keep = new Set(input.files);
  const removed = existingTargetTests(input.worktree, input.ruleIds).filter(
    (rel) => !keep.has(rel),
  );
  for (const rel of removed) fs.rmSync(path.join(input.worktree, rel));
  const written: string[] = [];
  for (const rel of input.files) {
    writeIntoWorktree(input.worktree, rel, fs.readFileSync(path.join(input.sessionDir, rel)));
    written.push(rel);
  }
  for (const [rel, content] of Object.entries(ACCEPTANCE_DECLARATION_FILES)) {
    writeIntoWorktree(input.worktree, rel, content);
    written.push(rel);
  }
  return { written, removed };
};
