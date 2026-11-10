// 인수 테스트 import 검사 (JDG-01 · RUN-03, ADR-026 · ADR-068).
// 인수 테스트는 HTTP 등 공개 인터페이스로만 검사하고 내부 코드를 직접 부르지 않는다. 테스트 작성 단계는 대상 규칙의
// 모든 `*.acc.ts`가 이 검사를 통과해야 끝난다. 허용하는 모듈은 다음뿐이다.
// - `vitest` (기준 URL은 `inject('baseUrl')`, ADR-051)
// - BIVE HTTP 도우미 `@bive/http` (판정 러너가 판정 때만 제공, ADR-068)
// - Node 내장 모듈 (`node:` 접두 필수). 단 코드 로드 · 실행 · 프로세스 생성과 파일 · DB 직접 접근 수단은 HTTP 밖
//   경로라 뺀다(`ACCEPTANCE_DENIED_BUILTINS`)
// 검사는 TypeScript 파서로 만든 구문 트리 위에서 한다. 문자열 · 템플릿 · 정규식 · 주석의 경계를 손으로 가르면
// 나눗셈과 정규식을 잘못 읽는 자리에서 따옴표가 문자열 경계로 바뀌어 실제 코드가 숨기 때문이다. 문법 오류가 있는
// 소스는 거부한다(실패 쪽으로 닫기). 정적 검사라 모든 우회를 막지는 못한다(속성 이름을 문자열 조립으로 만드는 등,
// #117). 판정 근거는 여전히 판정 러너의 실행 결과뿐이다(JDG-01). 그래서 해석이 애매하면 통과시키지 않는다: 동적
// import는 문자열 리터럴만, `import.<이름>`은 `import.meta`만(`import.meta.glob` 제외), `require` · `eval` ·
// `Function` · `importActual` 류 · `getBuiltinModule` · `binding` · `dlopen` · `process` 전역의 탈출 수단(`execve` ·
// `loadEnvFile` · `process.report`) · vitest 실행기 내부 이름(`__vite_ssr_dynamic_import__` 등)은 코드 자리에 나오면
// 거부한다. 생성자를 꺼내는 `.constructor`(예: `(async () => {}).constructor('…')`, Function 생성자 우회)는
// `.constructor.name`만 허용한다. 코드가 아닌 자리(객체 리터럴 키 · 타입 자리 · `expect(…)` 기본 매처의 문자열 인자
// 하나)의 같은 이름은 값을 읽거나 부르지 않으므로 허용한다(`isNonCodeName`).
// 파서(`typescript6`, 약 365ms · RSS 115MB)는 오케스트레이터 기동 때가 아니라 첫 검사 때 불러온다(`loadParser`).
import { builtinModules, createRequire } from 'node:module';

import type TS from 'typescript6';

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

// ── 거부 이름 ─────────────────────────────────────────────

const PROCESS_REPORT_MESSAGE = 'process.report로 진단 보고서 파일을 쓸 수 없습니다';

/**
 * 코드 자리에 나오면 거부하는 이름: 다른 모듈 · 코드를 문자열로 불러오는 수단과 `process` 전역의 탈출 수단. 식별자 ·
 * 속성 이름 · 구조 분해 이름은 물론, 같은 글자의 문자열 리터럴(`process['getBuiltinModule']` ·
 * `Reflect.get(process, 'binding')`)도 거부한다. 코드가 아닌 자리(`isNonCodeName`)는 허용한다.
 * `Map`으로 둔다: 일반 객체 조회는 `toString` · `constructor` · `hasOwnProperty` 같은 프로토타입 이름까지 걸고 사유
 * 자리에 함수가 들어간다.
 */
const DENIED_NAMES: ReadonlyMap<string, string> = new Map([
  ['require', 'require로 모듈을 불러올 수 없습니다'],
  ['eval', 'eval을 쓸 수 없습니다'],
  ['Function', 'Function 생성자를 쓸 수 없습니다'],
  ['importActual', 'importActual로 모듈을 불러올 수 없습니다'],
  ['importMock', 'importMock으로 모듈을 불러올 수 없습니다'],
  ['requireActual', 'requireActual로 모듈을 불러올 수 없습니다'],
  ['requireMock', 'requireMock으로 모듈을 불러올 수 없습니다'],
  ['createRequire', 'createRequire를 쓸 수 없습니다'],
  ['getBuiltinModule', 'getBuiltinModule로 Node 내장 모듈을 불러올 수 없습니다'],
  ['binding', 'process.binding으로 내부 모듈을 불러올 수 없습니다'],
  ['_linkedBinding', 'process._linkedBinding으로 내부 모듈을 불러올 수 없습니다'],
  ['dlopen', 'process.dlopen으로 네이티브 모듈을 불러올 수 없습니다'],
  // process 전역의 탈출 수단 (vitest 5.0.5 판정 설정에서 셸 실행 · 파일 읽기 · 파일 쓰기가 됨을 실측, #137)
  ['execve', 'process.execve로 다른 프로그램을 실행할 수 없습니다'],
  ['loadEnvFile', 'process.loadEnvFile로 파일을 읽을 수 없습니다'],
  ['writeReport', PROCESS_REPORT_MESSAGE],
  ['reportOnFatalError', PROCESS_REPORT_MESSAGE],
  ['reportOnSignal', PROCESS_REPORT_MESSAGE],
  ['reportOnUncaughtException', PROCESS_REPORT_MESSAGE],
]);

/**
 * `process`(또는 `globalThis.process`)에서 읽을 때만 거부하는 이름. `report`는 흔한 이름이라 다른 객체의 `report`는
 * 허용하고, `process`를 다른 이름에 담아 읽는 경우는 보고서를 쓰는 함수 · 설정 이름(`writeReport` 등)으로 막는다.
 */
const PROCESS_DENIED_MEMBERS: ReadonlyMap<string, string> = new Map([
  ['report', PROCESS_REPORT_MESSAGE],
]);

/**
 * vitest · vite 실행기가 변환한 모듈에 넘기는 내부 함수 · 전역(`__vite_ssr_dynamic_import__('../src/x')`는 import
 * 없이 모듈을 불러온다. 실측). 어느 자리에 나와도 거부한다.
 */
const RUNNER_INTERNAL_NAME = /^__vite(st)?_/u;
const RUNNER_INTERNAL_MESSAGE =
  'vitest · vite 실행기 내부 이름(__vite_ssr_… · __vitest_…)을 쓸 수 없습니다';

const CONSTRUCTOR_MESSAGE =
  'constructor로 생성자를 꺼낼 수 없습니다 (Function 생성자 우회, .constructor.name만 허용)';

/**
 * 거부 이름을 문자열 인자 하나로 받아도 되는 vitest 기본 매처. 받은 문자열과 비교 · 대조만 하고 그 이름의 속성 값을
 * 테스트 코드에 돌려주지 않는다(`toHaveProperty`는 값 비교 인자가 없을 때만: 값 비교는 사용자 `asymmetricMatch`에
 * 속성 값을 넘긴다. 그래서 인자가 정확히 하나일 때만 허용한다).
 */
const STRING_MATCHERS: ReadonlySet<string> = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toContain',
  'toHaveProperty',
  'toMatch',
  'toThrow',
  'toThrowError',
]);
/** `expect.stringContaining('…')` 꼴의 비대칭 매처. */
const STRING_ASYMMETRIC_MATCHERS: ReadonlySet<string> = new Set([
  'stringContaining',
  'stringMatching',
]);
/** `expect(x)`와 매처 사이에 올 수 있는 수식어. */
const MATCHER_MODIFIERS: ReadonlySet<string> = new Set(['not', 'resolves', 'rejects']);

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

// ── 구문 트리 ─────────────────────────────────────────────

/**
 * TypeScript 파서. 무거워서(약 365ms · RSS 115MB) 이 모듈을 불러오는 오케스트레이터 기동 때가 아니라 첫 검사 때
 * 불러온다(`loadParser`). 아래 함수들은 모두 `lintAcceptanceSource`가 `loadParser`를 부른 뒤에만 돈다.
 */
let ts: typeof TS;
let parserLoaded = false;
const loadParser = (): void => {
  if (parserLoaded) return;
  ts = createRequire(import.meta.url)('typescript6') as typeof TS;
  parserLoaded = true;
};

const FILE_NAME = '/bive-acceptance/lint.acc.ts';

const parseSource = (
  source: string,
): { sourceFile: TS.SourceFile; diagnostics: readonly TS.Diagnostic[] } => {
  const sourceFile = ts.createSourceFile(
    FILE_NAME,
    source,
    { languageVersion: ts.ScriptTarget.Latest, impliedNodeFormat: ts.ModuleKind.ESNext },
    true,
    ts.ScriptKind.TS,
  );
  // 문법 오류는 공개 API(`getSyntacticDiagnostics`)로 얻는다. 파일 하나만 있는 프로그램이라 다른 파일 · 라이브러리를
  // 읽지 않는다
  const host: TS.CompilerHost = {
    getSourceFile: (fileName) => (fileName === FILE_NAME ? sourceFile : undefined),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => fileName === FILE_NAME,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [FILE_NAME],
    options: { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest },
    host,
  });
  return { sourceFile, diagnostics: program.getSyntacticDiagnostics(sourceFile) };
};

/** 속성 이름 노드(식별자 · 문자열 · 계산된 문자열 이름)의 글자. 정적으로 알 수 없으면 undefined. */
const accessedName = (node: TS.Node | undefined): string | undefined => {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return accessedName(node.expression);
  return undefined;
};

/** 괄호 · 타입 단언(`(x)` · `x as T` · `x!`)인지. 벗겨도 값은 같다. */
const isOuterExpression = (
  node: TS.Node,
): node is
  | TS.ParenthesizedExpression
  | TS.AsExpression
  | TS.SatisfiesExpression
  | TS.NonNullExpression
  | TS.TypeAssertion =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isTypeAssertionExpression(node);

const skipOuterExpressions = (node: TS.Expression): TS.Expression => {
  let current = node;
  while (isOuterExpression(current)) current = current.expression;
  return current;
};

/**
 * 객체 리터럴이 구조 분해 대입의 대상(`({ binding: b } = process)` · `for ({ binding: b } of xs)`)인지. 대상이면 키가
 * 속성 읽기다.
 */
const isAssignmentPattern = (literal: TS.ObjectLiteralExpression): boolean => {
  let node: TS.Node = literal;
  for (;;) {
    const parent: TS.Node = node.parent;
    if (
      isOuterExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node)
    ) {
      node = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    }
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
      return parent.initializer === node;
    }
    return false;
  }
};

/**
 * 이름 노드가 객체 리터럴의 키면 그 멤버와 리터럴. 키는 `{ k: v }` · `{ 'k': v }` · `{ ['k']: v }`(계산된 키는 문자열
 * 리터럴만: `{ [eval]: 1 }`의 `eval`은 값 참조다) · 단축 속성 `{ k }` · 메서드 · 접근자의 이름이다.
 */
const objectLiteralKeyOf = (
  node: TS.Identifier | TS.StringLiteralLike,
): { member: TS.ObjectLiteralElementLike; literal: TS.ObjectLiteralExpression } | undefined => {
  const key: TS.Node =
    ts.isStringLiteralLike(node) && ts.isComputedPropertyName(node.parent) ? node.parent : node;
  const member = key.parent;
  if (
    !(
      ts.isPropertyAssignment(member) ||
      ts.isShorthandPropertyAssignment(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) ||
    member.name !== key ||
    !ts.isObjectLiteralExpression(member.parent)
  ) {
    return undefined;
  }
  return { member, literal: member.parent };
};

/** 구조 분해 대입 대상의 키(`({ constructor: F } = f)` · `({ report } = process)`)인지. 속성 읽기다. */
const isAssignmentPatternKey = (node: TS.Identifier | TS.StringLiteralLike): boolean => {
  const owner = objectLiteralKeyOf(node);
  return owner !== undefined && isAssignmentPattern(owner.literal);
};

/**
 * 객체 리터럴의 키(`{ eval: 1 }` · `{ 'binding': 1 }` · `{ ['require']: 1 }` · `{ eval() {} }`)인지. 값을 만드는
 * 자리라 허용한다. 단축 속성 `{ require }`은 같은 이름의 변수를 읽고, 구조 분해 대입 대상의 키는 속성을 읽으므로 뺀다.
 */
const isObjectLiteralKey = (node: TS.Identifier | TS.StringLiteralLike): boolean => {
  const owner = objectLiteralKeyOf(node);
  return (
    owner !== undefined &&
    !ts.isShorthandPropertyAssignment(owner.member) &&
    !isAssignmentPattern(owner.literal)
  );
};

/**
 * 식별자가 속성 읽기 자리(`x.name` · 구조 분해 `{ name }` · `{ name: y }` · 구조 분해 대입 `({ name: y } = x)`)에
 * 있는지.
 */
const isReadPropertyName = (node: TS.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)) {
    return (
      parent.propertyName === node || (parent.propertyName === undefined && parent.name === node)
    );
  }
  return isAssignmentPatternKey(node);
};

/** `x.constructor.name` 꼴인지 (생성자 이름 읽기만 허용). */
const isConstructorNameRead = (node: TS.Identifier): boolean => {
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node) return false;
  const outer = access.parent;
  return (
    ts.isPropertyAccessExpression(outer) &&
    outer.expression === access &&
    outer.name.text === 'name'
  );
};

/** `process` 또는 `globalThis.process`인지. */
const isProcessExpression = (node: TS.Expression): boolean => {
  const expression = skipOuterExpressions(node);
  if (ts.isIdentifier(expression)) return expression.text === 'process';
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'process') {
    return false;
  }
  const owner = skipOuterExpressions(expression.expression);
  return ts.isIdentifier(owner) && owner.text === 'globalThis';
};

/** 이름 노드가 `process`의 속성 읽기(`process.x` · `process['x']` · `const { x } = process`)인지. */
const isProcessMemberRead = (node: TS.Identifier | TS.StringLiteralLike): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return isProcessExpression(parent.expression);
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
    return isProcessExpression(parent.expression);
  }
  const key: TS.Node = ts.isComputedPropertyName(parent) ? parent : node;
  const element = key.parent;
  if (
    ts.isBindingElement(element) &&
    ts.isObjectBindingPattern(element.parent) &&
    (element.propertyName === key || (element.propertyName === undefined && element.name === key))
  ) {
    // `process`에서 바로 꺼내는 변수 선언만 본다. 매개변수 · 중첩 구조 분해(`({ report }) => …`)는 흔한 모양이라
    // 허용하고, 그렇게 꺼낸 보고서 객체로 파일을 쓰는 수단은 `writeReport` · `reportOn…` 이름으로 막는다
    const declaration = element.parent.parent;
    return (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isProcessExpression(declaration.initializer)
    );
  }
  // 구조 분해 대입은 오른쪽 값을 따라가지 않고 거부 쪽으로 본다
  return isAssignmentPatternKey(node);
};

/**
 * 타입 자리(실행 때 지워지는 자리: 타입 주석 · 타입 인자 · `interface` · `type`)인지. 클래스 `extends` · `implements`의
 * 식(`ExpressionWithTypeArguments`)은 값 참조일 수 있어 타입 자리로 보지 않는다(그 안의 타입 인자는 타입 자리).
 */
const isInTypePosition = (node: TS.Node): boolean => {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
    if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
  }
  return false;
};

/** `expect` · `expect.soft`인지. */
const isExpectCallee = (node: TS.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'expect') ||
  (ts.isPropertyAccessExpression(node) &&
    node.name.text === 'soft' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'expect');

/**
 * 문자열이 vitest 기본 매처의 유일한 인자(`expect(x).toContain('Function')` ·
 * `expect(x).not.toHaveProperty('binding')` · `expect.stringContaining('eval')`)인지.
 */
const isMatcherArgument = (node: TS.StringLiteralLike): boolean => {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments.length !== 1 || call.arguments[0] !== node) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const matcher = callee.name.text;
  if (STRING_ASYMMETRIC_MATCHERS.has(matcher)) {
    let owner = callee.expression;
    if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'not') owner = owner.expression;
    return ts.isIdentifier(owner) && owner.text === 'expect';
  }
  if (!STRING_MATCHERS.has(matcher)) return false;
  let target = callee.expression;
  while (ts.isPropertyAccessExpression(target) && MATCHER_MODIFIERS.has(target.name.text)) {
    target = target.expression;
  }
  return ts.isCallExpression(target) && isExpectCallee(target.expression);
};

/**
 * 거부 이름이 코드가 아닌 자리(객체 리터럴 키 · 타입 자리 · 매처의 문자열 인자)에 있는지. 이 자리의 이름은 값을 읽거나
 * 부르지 않는다. 속성 읽기 · 호출 · 식별자 참조 · 구조 분해 · 그 밖의 문자열(`Reflect.get(process, 'binding')`)은
 * 여기에 들지 않아 거부된다.
 */
const isNonCodeName = (node: TS.Identifier | TS.StringLiteralLike): boolean =>
  isObjectLiteralKey(node) ||
  isInTypePosition(node) ||
  (ts.isStringLiteralLike(node) && isMatcherArgument(node));

/** 이름 노드(식별자 · 문자열)의 거부 사유. 허용이면 undefined. */
const deniedNameMessage = (node: TS.Identifier | TS.StringLiteralLike): string | undefined => {
  // 이스케이프(`eval`)는 파서가 풀어 `text`에 원래 이름이 들어 있다
  const name = node.text;
  if (RUNNER_INTERNAL_NAME.test(name)) return RUNNER_INTERNAL_MESSAGE;
  let message = DENIED_NAMES.get(name);
  if (message === undefined && name === 'constructor') {
    // 식별자는 속성 읽기 자리만(클래스 생성자 정의는 허용), 문자열은 코드가 아닌 자리 밖 전부
    const read = ts.isIdentifier(node)
      ? isReadPropertyName(node) && !isConstructorNameRead(node)
      : true;
    if (read) message = CONSTRUCTOR_MESSAGE;
  }
  if (message === undefined && isProcessMemberRead(node)) {
    message = PROCESS_DENIED_MEMBERS.get(name);
  }
  if (message === undefined || isNonCodeName(node)) return undefined;
  return message;
};

/**
 * 인수 테스트 소스의 import 문제를 찾는다. 빈 배열이면 통과.
 * 정적 import · `export … from` · 부작용 import · 동적 import(문자열 리터럴만) · 타입 import(`import('x')` 타입)의
 * 모듈 이름을 허용 목록과 대조하고, 모듈 이름을 숨길 수 있는 수단(`require` · `eval` · `Function` · `importActual` 류 ·
 * 실행기 내부 이름 · `.constructor` · `import.<meta 밖 이름>` · `import.meta.glob` · `with`)과 `process` 전역의 탈출
 * 수단을 거부한다. 문법 오류가 있으면 그것만 알린다.
 */
export const lintAcceptanceSource = (source: string): AcceptanceLintProblem[] => {
  loadParser();
  const { sourceFile, diagnostics } = parseSource(source);
  const lineOf = (position: number): number =>
    sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  if (diagnostics.length > 0) {
    return diagnostics.map((diagnostic) => ({
      line: lineOf(diagnostic.start ?? 0),
      message: `소스를 해석할 수 없습니다: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    }));
  }

  const problems: AcceptanceLintProblem[] = [];
  const report = (node: TS.Node, message: string): void => {
    problems.push({ line: lineOf(node.getStart(sourceFile)), message });
  };
  const checkSpecifier = (node: TS.Node, specifier: string): void => {
    if (!isAllowedAcceptanceImport(specifier)) report(node, describeSpecifier(specifier));
  };

  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // `import … from 'x'` · `import 'x'` · `export … from 'x'` (타입 전용 포함)
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined) {
        if (ts.isStringLiteral(specifier)) checkSpecifier(specifier, specifier.text);
        else report(specifier, '모듈 이름은 문자열 리터럴만 쓸 수 있습니다');
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import x = require('y')`
      if (ts.isExternalModuleReference(node.moduleReference)) {
        report(node, DENIED_NAMES.get('require') ?? 'require');
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // 동적 import: 문자열 리터럴 하나만
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        checkSpecifier(argument, argument.text);
      } else {
        report(node, '동적 import는 문자열 리터럴 모듈 이름만 쓸 수 있습니다');
      }
    } else if (ts.isImportTypeNode(node)) {
      // 타입 자리의 `import('x')`
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        checkSpecifier(argument.literal, argument.literal.text);
      } else {
        report(node, '타입 import는 문자열 리터럴 모듈 이름만 쓸 수 있습니다');
      }
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      if (node.name.text !== 'meta') {
        // `import.defer('x')` · `import.source('x')`: 모듈을 불러오는 다른 형태다. 검사 파서와 vite 변환기의 해석이
        // 갈릴 수 있는 경계라 동적 import처럼 모듈 이름을 대조하지 않고 거부한다
        report(node, `import.${node.name.text}를 쓸 수 없습니다 (import.meta만 허용)`);
      } else {
        // import.meta.glob은 파일을 모아 불러온다. `import.meta[식]`은 이름을 알 수 없으니 거부
        const parent = node.parent;
        const member = ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : ts.isElementAccessExpression(parent)
            ? (accessedName(parent.argumentExpression) ?? 'glob')
            : undefined;
        if (member === 'glob' || member === 'globEager') {
          report(node, 'import.meta.glob을 쓸 수 없습니다');
        }
      }
    } else if (ts.isWithStatement(node)) {
      report(node, 'with 문을 쓸 수 없습니다');
    } else if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      // 속성 이름을 문자열로 쓰는 우회도 같은 이름으로 본다: `x['constructor']` · `process['getBuiltinModule']` ·
      // `Reflect.get(f, 'constructor')`
      const message = deniedNameMessage(node);
      if (message !== undefined) report(node, message);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return problems;
};
