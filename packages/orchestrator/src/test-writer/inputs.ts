// test-writer 세션 작업 디렉터리 (NFR-02 · RUN-04, ADR-024 · ADR-052 · ADR-068).
// 허용 목록 방식: 세션 디렉터리에는 아래 입력 사본만 둔다. 소스 코드 · 설정 · `node_modules` · `.git`은 없다.
// - `rules/<RULE-ID>.md`: 대상 규칙 진술 (저장소의 규칙 값)
// - `routes.md`: 라우트 목록 (Next.js App Router의 `route.*` · `page.*` 위치에서 만든 경로 · 메서드, 코드 아님). 안전한 조각
//   패턴 밖 폴더 이름의 경로는 싣지 않고, 항목 수 · 글자 수 상한이 있다 (ADR-131)
// - `prisma/schema.prisma`: Prisma 스키마 사본 (있을 때. 크기 상한을 넘거나 `prisma/` · 파일이 링크면 사본 없음, ADR-131)
// - `bive-acceptance/<규칙 폴더>/**/*.acc.ts`: 다른 규칙의 기존 인수 테스트 사본
// - `blocks.json`: 블록 선언의 읽기 전용 사본 (지금 판의 선언 그대로, 선언이 없으면 없음. M3-01 #46, ADR-005 · ADR-122). 세션이 고쳐도
//   경로 가드가 쓰기를 거부하고(테스트 작성 역할은 대상 규칙 폴더 밖 쓰기 불가) 결과로 옮기지도 않는다. 원본은 프로젝트 폴더 밖
//   저장소에 있다. 세션 도중 사람이 선언을 바꿔도 이 사본은 세션 시작 때의 판이다(다음 세션이 새 판을 받는다)
// 세션이 쓴 결과는 대상 규칙 폴더의 `*.acc.ts`만 오케스트레이터가 실행 워크트리로 옮긴다(그 폴더의 `*.acc.ts`를 통째로 교체).
import fs from 'node:fs';
import path from 'node:path';

import type { BlockDeclaration, Rule } from '@bive/shared';

import { ACCEPTANCE_DECLARATION_FILES } from '../judge/acceptance-env.js';
import { ACCEPTANCE_DIR, ACCEPTANCE_SUFFIX } from '../judge/config.js';

/** 세션 디렉터리 안 입력 위치. */
export const TEST_WRITER_INPUTS = {
  rulesDir: 'rules',
  routes: 'routes.md',
  prismaSchema: 'prisma/schema.prisma',
  acceptanceDir: ACCEPTANCE_DIR,
  blocks: 'blocks.json',
} as const;

/** `blocks.json` 본문: 선언 그대로의 JSON (값은 모두 보이는 ASCII라 표시 값 변환이 바꾸는 글자가 없다, ADR-122). */
export const renderBlocks = (declaration: BlockDeclaration): string =>
  `${JSON.stringify(declaration, null, 2)}\n`;

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

/**
 * 워크트리 기준 폴더 경로의 모든 구간이 링크가 아닌 실제 폴더인지 (만들지 않고, 던지지 않는다). 마지막 구간만 `lstat`하면
 * 상위 구간의 링크를 따라가고, 상위 구간이 일반 파일이면 `ENOTDIR`로 던지므로 구간마다 본다.
 */
const isRealDirPath = (worktree: string, relDir: string): boolean => {
  let current = worktree;
  for (const segment of relDir.split(path.sep).filter((s) => s !== '')) {
    current = path.join(current, segment);
    if (lstatKind(current) !== 'dir') return false;
  }
  return true;
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
  /** 앱 폴더부터 파일까지 지난 폴더 이름 (경로 그룹 포함, 순서대로). `routes.md`는 이 이름을 모두 조각 패턴으로 본다 */
  folders: string[];
}

/**
 * `routes.md` 상한 (M3-50 #295, ADR-131). 길이는 UTF-16 코드 단위. 조각 · 경로 길이를 넘는 경로는 패턴 밖과 같이 싣지 않고,
 * 항목 수 · 글자 수는 경로 순으로 앞에서부터 채우다 넘으면 멈춘다.
 */
export const ROUTES_LIMITS = {
  /** 폴더 이름 하나 (패턴 확인 전에 본다) */
  segment: 100,
  /** 경로 하나 (`/`로 시작하는 URL 경로) */
  path: 200,
  /** 싣는 경로 항목 수 */
  entries: 50,
  /** 싣는 항목 줄의 글자 수 합 (줄마다 줄바꿈 1글자 포함) */
  chars: 4000,
} as const;

// 안전한 폴더 이름 조각 (ADR-131): 영숫자 · `-` · `_` · `.` · `%`로 된 이름, 동적 조각 `[이름]` · `[...이름]` · `[[...이름]]`,
// 경로 그룹 `(이름)`, 병렬 슬롯 `@이름`, 가로채기 `(.)이름` · `(..)이름` · `(..)(..)이름` · `(...)이름`. 줄 나눔 · 제어 글자 ·
// 공백 · 따옴표 · 백틱 · `#` · `*` · `<` · `>` · `|` · `!` · `~` · 비 ASCII는 어느 꼴에도 없다. 겹친 반복이 없는 꼴이라 선형
// 시간이고, 길이 상한을 먼저 본다.
const PLAIN = '[A-Za-z0-9._%-]+';
const PARAM = '[A-Za-z0-9_-]+';
const SAFE_SEGMENT = new RegExp(
  `^(?:${PLAIN}|\\[(?:\\.\\.\\.)?${PARAM}\\]|\\[\\[\\.\\.\\.${PARAM}\\]\\]|\\(${PLAIN}\\)|@${PLAIN}` +
    `|(?:\\(\\.\\)|\\(\\.\\.\\)(?:\\(\\.\\.\\))*|\\(\\.\\.\\.\\))${PLAIN})$`,
  'u',
);

/** 폴더 이름이 `routes.md`에 실을 수 있는 조각인지 (길이 상한 → 패턴 순). */
export const isSafeRouteSegment = (name: string): boolean =>
  name.length >= 1 && name.length <= ROUTES_LIMITS.segment && SAFE_SEGMENT.test(name);

/** 결정적 순서: 경로 → 종류, UTF-16 코드 단위 비교 (로캘 · 파일 시스템 나열 순서에 기대지 않는다). */
const compareRoutes = (a: RouteEntry, b: RouteEntry): number => {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
};

/**
 * Next.js App Router 라우트 목록. 앱 폴더는 루트 `app/`이 있으면 그것, 없으면 `src/app/`(Next.js와 같은 순서).
 * 경로 그룹 `(이름)`은 경로에서 빼고, 비공개 폴더 `_이름` · 병렬 경로 `@슬롯` · 가로채기 경로 `(.)…`는 건너뛴다.
 * 링크 · `node_modules`는 따라가지 않는다(`src/app`은 `src`도 링크가 아닌 폴더여야 한다). Pages Router(`pages/`)는
 * M1 범위 밖이다(ADR-068). 폴더 이름은 거르지 않고 담는다: 실을지는 {@link renderRoutes}가 정한다.
 */
export const listAppRoutes = (worktree: string): RouteEntry[] => {
  const candidates = ['app', path.join('src', 'app')];
  const appRel = candidates.find((rel) => isRealDirPath(worktree, rel));
  if (appRel === undefined) return [];
  const routes: RouteEntry[] = [];
  const walk = (dirRel: string, segments: string[], folders: string[]): void => {
    for (const entry of entriesOf(path.join(worktree, dirRel))) {
      const rel = path.join(dirRel, entry.name);
      if (entry.isDirectory()) {
        const name = entry.name;
        if (name === 'node_modules' || name.startsWith('_') || name.startsWith('@')) continue;
        if (name.startsWith('(.')) continue;
        const group = name.startsWith('(') && name.endsWith(')');
        walk(rel, group ? segments : [...segments, name], [...folders, name]);
        continue;
      }
      if (!entry.isFile()) continue;
      const urlPath = `/${segments.join('/')}`;
      const file = rel.split(path.sep).join('/');
      if (ROUTE_FILE.test(entry.name)) {
        const source = fs.readFileSync(path.join(worktree, rel), 'utf8');
        routes.push({
          path: urlPath,
          kind: 'route',
          methods: exportedMethods(source),
          file,
          folders,
        });
      } else if (PAGE_FILE.test(entry.name)) {
        routes.push({ path: urlPath, kind: 'page', methods: [], file, folders });
      }
    }
  };
  walk(appRel, [], []);
  return routes.sort(compareRoutes);
};

/** 사본을 두지 않은 데이터 스키마의 까닭 (`routes.md` 머리에 고정 문장으로 적는다). */
export type SchemaOmission = 'too_large' | 'not_regular';

/** `routes.md` 머리에 적는 고정 문장 (ADR-131). 원문(폴더 이름 · 스키마 내용)은 싣지 않는다. */
export const ROUTES_NOTICES = {
  unsafe: (count: number): string =>
    `(싣지 않은 경로 ${String(count)}건: 폴더 이름이 안전한 경로 글자 밖이거나 길이 상한(폴더 이름 ` +
    `${String(ROUTES_LIMITS.segment)}자 · 경로 ${String(ROUTES_LIMITS.path)}자)을 넘음)`,
  overflow: (count: number): string =>
    `(상한을 넘어 싣지 않은 경로 ${String(count)}건: 상한 ${String(ROUTES_LIMITS.entries)}건 · ` +
    `${String(ROUTES_LIMITS.chars)}자, 경로 순으로 앞에서부터 실음)`,
  schema: {
    too_large: (max: number): string =>
      `(데이터 스키마 사본 없음: prisma/schema.prisma가 크기 상한 ${String(max)}바이트를 넘음)`,
    not_regular:
      '(데이터 스키마 사본 없음: prisma 폴더 또는 prisma/schema.prisma가 링크이거나 일반 폴더 · 파일이 아님)',
  },
} as const;

const routeLine = (route: RouteEntry): string => {
  if (route.kind === 'page') return `- 페이지 GET ${route.path}`;
  const methods = route.methods.length > 0 ? route.methods.join(' · ') : '(메서드 확인 불가)';
  return `- API ${methods} ${route.path}`;
};

/** 경로를 실을 수 있는지: 지난 폴더 이름이 모두 안전한 조각이고 경로가 길이 상한 안. */
const isSafeRoute = (route: RouteEntry): boolean =>
  route.path.length <= ROUTES_LIMITS.path && route.folders.every(isSafeRouteSegment);

/**
 * `routes.md` 본문 (ADR-131). 안전하지 않은 경로는 통째로 빼고 수만 적는다. 나머지는 경로 순으로 정렬해 항목 수 ·
 * 글자 수 상한까지 앞에서부터 싣고, 넘친 수를 머리에 적는다. `schema`는 사본을 두지 않은 데이터 스키마의 까닭.
 */
export const renderRoutes = (
  routes: readonly RouteEntry[],
  options: { schema?: SchemaOmission | null } = {},
): string => {
  const lines = [
    '# 라우트 목록',
    '',
    'BIVE가 프로젝트의 Next.js App Router 파일 위치에서 만든 목록이다. 판정 서버에는 이 경로로 HTTP 요청만 보낸다.',
    '',
  ];
  const safe = routes.filter(isSafeRoute).sort(compareRoutes);
  const unsafe = routes.length - safe.length;
  const kept: string[] = [];
  let used = 0;
  for (const route of safe) {
    const line = routeLine(route);
    if (kept.length >= ROUTES_LIMITS.entries || used + line.length + 1 > ROUTES_LIMITS.chars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const overflow = safe.length - kept.length;
  const notices: string[] = [];
  if (options.schema === 'too_large') {
    notices.push(ROUTES_NOTICES.schema.too_large(PRISMA_SCHEMA_MAX_BYTES));
  } else if (options.schema === 'not_regular') notices.push(ROUTES_NOTICES.schema.not_regular);
  if (unsafe > 0) notices.push(ROUTES_NOTICES.unsafe(unsafe));
  if (overflow > 0) notices.push(ROUTES_NOTICES.overflow(overflow));
  if (notices.length > 0) lines.push(...notices, '');
  if (kept.length === 0) lines.push('(라우트 없음)');
  lines.push(...kept);
  return `${lines.join('\n')}\n`;
};

/**
 * `prisma/schema.prisma` 사본의 크기 상한 (바이트, ADR-131). 세션의 `read_file` 상한(1 MiB)과 같다: 넘는 파일은 세션이
 * 읽지 못한다. 넘으면 사본을 두지 않는다(잘린 스키마는 문법이 깨진 채 읽힌다).
 */
export const PRISMA_SCHEMA_MAX_BYTES = 1024 * 1024;

/** 스키마 사본으로 쓸 바이트 또는 사본을 두지 않는 까닭 (`absent`: 스키마 없음, 알리지 않는다). */
type SchemaRead = { kind: 'ok'; bytes: Buffer } | { kind: 'absent' } | { kind: SchemaOmission };

/**
 * 실행 워크트리의 `prisma/schema.prisma`를 읽는다. `prisma/`와 파일이 모두 링크가 아닌 실제 폴더 · 일반 파일이어야 하고,
 * 읽기 전에 `lstat` 크기를 보며(상한 넘는 파일을 메모리에 올리지 않는다), 연 뒤에는 링크를 따라가지 않는 핸들의 종류와
 * 읽은 바이트 수로 다시 막는다(확인과 읽기 사이에 바뀐 파일). 내용은 바이트 그대로다.
 */
const readPrismaSchema = (worktree: string): SchemaRead => {
  const maxBytes = PRISMA_SCHEMA_MAX_BYTES;
  const dirKind = lstatKind(path.join(worktree, 'prisma'));
  if (dirKind === null || dirKind === 'file') return { kind: 'absent' };
  if (dirKind !== 'dir') return { kind: 'not_regular' };
  const target = path.join(worktree, TEST_WRITER_INPUTS.prismaSchema);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined) return { kind: 'absent' };
  if (!stat.isFile()) return { kind: 'not_regular' };
  if (stat.size > maxBytes) return { kind: 'too_large' };
  let fd: number;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch {
    return { kind: 'not_regular' };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: 'not_regular' };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxBytes) return { kind: 'too_large' };
    return { kind: 'ok', bytes: buffer.subarray(0, length) };
  } finally {
    fs.closeSync(fd);
  }
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
  /** 지금 블록 선언 (없으면 `null` 또는 생략: 사본을 두지 않는다) */
  blocks?: BlockDeclaration | null;
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
  // 데이터 스키마: 구현 산출이라 내용은 바이트 그대로 싣고, 상한 · 링크면 사본 없이 그 사실만 `routes.md` 머리에 적는다 (ADR-131)
  const schema = readPrismaSchema(worktree);
  const omitted = schema.kind === 'too_large' || schema.kind === 'not_regular' ? schema.kind : null;
  put(TEST_WRITER_INPUTS.routes, renderRoutes(routes, { schema: omitted }));
  if (schema.kind === 'ok') put(TEST_WRITER_INPUTS.prismaSchema, schema.bytes);
  if (input.blocks !== undefined && input.blocks !== null) {
    put(TEST_WRITER_INPUTS.blocks, renderBlocks(input.blocks));
  }
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

/**
 * 워크트리 안 폴더 경로의 각 구간이 링크가 아닌 실제 폴더인지 본다(만들지 않는다). 모두 폴더면 true, 어느 구간이
 * 없으면 false.
 * @throws 어느 구간이 링크 · 폴더가 아닌 항목일 때
 */
const realDirChain = (worktree: string, relDir: string): boolean => {
  let current = worktree;
  for (const segment of relDir.split('/').filter((s) => s !== '')) {
    current = path.join(current, segment);
    const kind = lstatKind(current);
    if (kind === null) return false;
    if (kind !== 'dir') {
      throw new Error(
        `인수 테스트 경로가 폴더가 아닙니다 (링크 등): ${path.relative(worktree, current).split(path.sep).join('/')}`,
      );
    }
  }
  return true;
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
    // 구간마다 확인한다: `bive-acceptance` 자체가 링크면 그 아래 규칙 폴더의 lstat은 링크를 따라가 대상 폴더 밖
    // 파일을 지우게 된다
    if (realDirChain(worktree, `${ACCEPTANCE_DIR}/${ruleId}`))
      walk(path.join(ACCEPTANCE_DIR, ruleId));
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
