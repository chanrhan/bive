// 인수 테스트 import 검사 (JDG-01 · RUN-03, ADR-026 · ADR-068).
// 인수 테스트는 HTTP 등 공개 인터페이스로만 검사하고 내부 코드를 직접 부르지 않는다. 테스트 작성 단계는 대상 규칙의
// 모든 `*.acc.ts`가 이 검사를 통과해야 끝난다. 허용하는 모듈은 다음뿐이다.
// - `vitest` (기준 URL은 `inject('baseUrl')`, ADR-051)
// - BIVE HTTP 도우미 `@bive/http` (판정 러너가 판정 때만 제공, ADR-068)
// - Node 내장 모듈 (`node:` 접두 필수). 단 코드 로드 · 실행 · 프로세스 생성과 파일 · DB 직접 접근 수단은 HTTP 밖
//   경로라 뺀다(`ACCEPTANCE_DENIED_BUILTINS`)
// 정적 검사라 모든 우회를 막지는 못한다(문자열을 조립해 전역 객체에서 꺼내는 등). 판정 근거는 여전히 판정 러너의
// 실행 결과뿐이다(JDG-01). 그래서 해석이 애매하면 통과시키지 않는다: 동적 import는 문자열 리터럴만, `require` ·
// `eval` · `Function` · `importActual` 류 · `import.meta.glob`은 이름이 나오기만 해도 거부한다.
import { builtinModules } from 'node:module';

/** 판정 러너가 판정 때 제공하는 BIVE HTTP 도우미 모듈 이름 (`judge/acceptance-env.ts`). */
export const BIVE_HTTP_HELPER_MODULE = '@bive/http';

/**
 * Node 내장 중 인수 테스트에 쓸 수 없는 모듈: 다른 코드를 불러오거나 실행하는 수단(`module` · `vm` · 프로세스 · 스레드 ·
 * 디버거 · WASI), 프로젝트 파일 · DB를 HTTP 없이 직접 읽고 쓰는 수단(`fs` · `sqlite`), 다른 시험 실행기(`test`)다.
 */
export const ACCEPTANCE_DENIED_BUILTINS: readonly string[] = [
  'module',
  'vm',
  'child_process',
  'worker_threads',
  'cluster',
  'repl',
  'inspector',
  'inspector/promises',
  'wasi',
  'v8',
  'fs',
  'fs/promises',
  'sqlite',
  'test',
  'test/reporters',
  'sea',
];

/** 허용하는 Node 내장 모듈 이름 (접두 없이). */
const allowedBuiltins = (): Set<string> => {
  const names = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
  for (const denied of ACCEPTANCE_DENIED_BUILTINS) names.delete(denied);
  // 밑줄로 시작하는 내부 모듈(`_http_agent` 등)은 공개 API가 아니다
  for (const name of [...names]) if (name.startsWith('_')) names.delete(name);
  return names;
};

/** 인수 테스트 import 허용 목록. */
export const ACCEPTANCE_IMPORT_ALLOWLIST = {
  /** 시험 실행기 */
  vitest: ['vitest'],
  /** BIVE HTTP 도우미 */
  helpers: [BIVE_HTTP_HELPER_MODULE],
  /** Node 내장 (`node:` 접두로만 쓴다) */
  nodeBuiltins: [...allowedBuiltins()].sort().map((name) => `node:${name}`),
} as const;

const ALLOWED_SPECIFIERS: ReadonlySet<string> = new Set([
  ...ACCEPTANCE_IMPORT_ALLOWLIST.vitest,
  ...ACCEPTANCE_IMPORT_ALLOWLIST.helpers,
  ...ACCEPTANCE_IMPORT_ALLOWLIST.nodeBuiltins,
]);

/** 모듈 이름이 허용 목록에 있는지. */
export const isAllowedAcceptanceImport = (specifier: string): boolean =>
  ALLOWED_SPECIFIERS.has(specifier);

export interface AcceptanceLintProblem {
  /** 1부터 */
  line: number;
  message: string;
}

// ── 토큰 ─────────────────────────────────────────────

type Token =
  | { kind: 'ident'; value: string; line: number }
  | { kind: 'string'; value: string; line: number }
  | { kind: 'template'; line: number }
  | { kind: 'punct'; value: string; line: number }
  | { kind: 'other'; line: number };

class LexError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

const IDENT_START = /[A-Za-z_$\u0080-￿]/u;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/u;
/** 이 키워드 뒤의 `/`는 나눗셈이 아니라 정규식 시작이다. */
const REGEX_AFTER_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * TypeScript 소스를 거칠게 토큰으로 나눈다. 주석을 버리고 문자열 · 템플릿 · 정규식 안의 글자를 코드로 보지 않는 것이
 * 목적이다. 템플릿의 `${…}` 안은 코드로 다시 토큰화한다. 닫히지 않은 문자열 · 주석 · 템플릿은 LexError.
 */
const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  /** 템플릿 `${` 안의 중괄호 깊이 스택 (템플릿마다 하나) */
  const templateDepth: number[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  const prevSignificant = (): Token | undefined => tokens.at(-1);
  const regexAllowed = (): boolean => {
    const prev = prevSignificant();
    if (prev === undefined) return true;
    if (prev.kind === 'ident') return REGEX_AFTER_KEYWORDS.has(prev.value);
    if (prev.kind === 'string' || prev.kind === 'template' || prev.kind === 'other') return false;
    return ![')', ']', '}'].includes(prev.value);
  };

  /** 템플릿 본문을 `` ` `` 또는 `${`까지 읽는다. `${`면 true. */
  const readTemplateChunk = (startLine: number): boolean => {
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '\n') line += 1;
      if (ch === '`') {
        i += 1;
        return false;
      }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        return true;
      }
      i += 1;
    }
    throw new LexError(startLine, '닫히지 않은 템플릿 문자열');
  };

  while (i < n) {
    const ch = source[i] ?? '';
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/u.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new LexError(startLine, '닫히지 않은 주석');
      for (let k = i; k < end; k += 1) if (source[k] === '\n') line += 1;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      let value = '';
      i += 1;
      for (;;) {
        if (i >= n || source[i] === '\n') throw new LexError(startLine, '닫히지 않은 문자열');
        const c = source[i] ?? '';
        if (c === '\\') {
          // 이스케이프는 그대로 둔다: 모듈 이름에 이스케이프가 있으면 허용 목록과 맞지 않아 거부된다
          value += source.slice(i, i + 2);
          if (source[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        i += 1;
        if (c === ch) break;
        value += c;
      }
      tokens.push({ kind: 'string', value, line: startLine });
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      i += 1;
      tokens.push({ kind: 'template', line: startLine });
      if (readTemplateChunk(startLine)) templateDepth.push(0);
      continue;
    }
    if (ch === '}' && templateDepth.length > 0 && templateDepth.at(-1) === 0) {
      // `${…}` 끝: 템플릿 본문으로 돌아간다
      templateDepth.pop();
      i += 1;
      if (readTemplateChunk(line)) templateDepth.push(0);
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      const startLine = line;
      i += 1;
      let inClass = false;
      for (;;) {
        if (i >= n || source[i] === '\n') throw new LexError(startLine, '닫히지 않은 정규식');
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        i += 1;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      while (i < n && IDENT_PART.test(source[i] ?? '')) i += 1;
      tokens.push({ kind: 'other', line: startLine });
      continue;
    }
    if (IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < n && IDENT_PART.test(source[end] ?? '')) end += 1;
      tokens.push({ kind: 'ident', value: source.slice(i, end), line });
      i = end;
      continue;
    }
    if (/[0-9]/u.test(ch)) {
      let end = i + 1;
      while (end < n && /[0-9A-Za-z_.]/u.test(source[end] ?? '')) end += 1;
      tokens.push({ kind: 'other', line });
      i = end;
      continue;
    }
    if (templateDepth.length > 0) {
      const top = templateDepth.length - 1;
      if (ch === '{') templateDepth[top] = (templateDepth[top] ?? 0) + 1;
      if (ch === '}') templateDepth[top] = (templateDepth[top] ?? 0) - 1;
    }
    tokens.push({ kind: 'punct', value: ch, line });
    i += 1;
  }
  if (templateDepth.length > 0) throw new LexError(line, '닫히지 않은 템플릿 식');
  return tokens;
};

// ── 검사 ─────────────────────────────────────────────

/** 이름이 나오기만 해도 거부하는 식별자: 다른 모듈 · 코드를 문자열로 불러오는 수단. */
const DENIED_IDENTIFIERS: Readonly<Record<string, string>> = {
  require: 'require로 모듈을 불러올 수 없습니다',
  eval: 'eval을 쓸 수 없습니다',
  importActual: 'importActual로 모듈을 불러올 수 없습니다',
  importMock: 'importMock으로 모듈을 불러올 수 없습니다',
  requireActual: 'requireActual로 모듈을 불러올 수 없습니다',
  requireMock: 'requireMock으로 모듈을 불러올 수 없습니다',
  createRequire: 'createRequire를 쓸 수 없습니다',
};

const isPunct = (token: Token | undefined, value: string): boolean =>
  token?.kind === 'punct' && token.value === value;

const isIdent = (token: Token | undefined, value?: string): boolean =>
  token?.kind === 'ident' && (value === undefined || token.value === value);

const describeSpecifier = (specifier: string): string => {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return `상대 · 절대 경로 import는 쓸 수 없습니다 (내부 코드 직접 호출 금지): ${specifier}`;
  }
  const bare = specifier.replace(/^node:/u, '');
  if (ACCEPTANCE_DENIED_BUILTINS.includes(bare)) {
    return `HTTP 밖 경로가 되는 Node 내장 모듈은 쓸 수 없습니다: ${specifier}`;
  }
  if (!specifier.startsWith('node:') && builtinModules.includes(bare)) {
    return `Node 내장 모듈은 node: 접두로 불러옵니다: ${specifier}`;
  }
  return `허용 목록 밖 모듈입니다 (vitest · ${BIVE_HTTP_HELPER_MODULE} · node: 내장만): ${specifier}`;
};

/**
 * 인수 테스트 소스의 import 문제를 찾는다. 빈 배열이면 통과.
 * 정적 import · `export … from` · 부작용 import · 동적 import(문자열 리터럴만)의 모듈 이름을 허용 목록과 대조하고,
 * 모듈 이름을 숨길 수 있는 수단(`require` · `eval` · `Function` · `importActual` 류 · `import.meta.glob`)을 거부한다.
 */
export const lintAcceptanceSource = (source: string): AcceptanceLintProblem[] => {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (error) {
    if (error instanceof LexError) {
      return [{ line: error.line, message: `소스를 해석할 수 없습니다: ${error.message}` }];
    }
    throw error;
  }
  const problems: AcceptanceLintProblem[] = [];
  const checkSpecifier = (token: Token & { kind: 'string' }): void => {
    if (!isAllowedAcceptanceImport(token.value)) {
      problems.push({ line: token.line, message: describeSpecifier(token.value) });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'ident') continue;
    const prev = tokens[index - 1];
    const next = tokens[index + 1];
    const afterDot = isPunct(prev, '.') || isPunct(prev, '?');

    const denied = DENIED_IDENTIFIERS[token.value];
    if (denied !== undefined) {
      problems.push({ line: token.line, message: denied });
      continue;
    }
    if (token.value === 'Function' && !afterDot && isPunct(next, '(')) {
      problems.push({ line: token.line, message: 'Function 생성자를 쓸 수 없습니다' });
      continue;
    }
    if (token.value === 'from' && next?.kind === 'string') {
      checkSpecifier(next);
      continue;
    }
    if (token.value !== 'import' || afterDot) continue;

    // import.meta…: glob은 파일을 모아 불러오므로 거부
    if (isPunct(next, '.')) {
      const meta = tokens[index + 2];
      const member = tokens[index + 4];
      if (isIdent(meta, 'meta') && isIdent(member) && member?.kind === 'ident') {
        if (member.value === 'glob' || member.value === 'globEager') {
          problems.push({ line: token.line, message: 'import.meta.glob을 쓸 수 없습니다' });
        }
      }
      continue;
    }
    // 동적 import: 문자열 리터럴 하나만
    if (isPunct(next, '(')) {
      const argument = tokens[index + 2];
      const close = tokens[index + 3];
      if (argument?.kind === 'string' && (isPunct(close, ')') || isPunct(close, ','))) {
        checkSpecifier(argument);
      } else {
        problems.push({
          line: token.line,
          message: '동적 import는 문자열 리터럴 모듈 이름만 쓸 수 있습니다',
        });
      }
      continue;
    }
    // 부작용 import: import 'x'
    if (next?.kind === 'string') checkSpecifier(next);
    // 그 밖(import x from 'y' · import type …)은 뒤따르는 `from`에서 검사한다
  }
  return problems;
};
