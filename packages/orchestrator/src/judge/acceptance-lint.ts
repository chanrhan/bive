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
// import는 문자열 리터럴만, `require` · `eval` · `Function` · `importActual` 류 · `getBuiltinModule` · `binding` ·
// `dlopen` · vitest 실행기 내부 이름(`__vite_ssr_dynamic_import__` 등) · `import.meta.glob`은 이름이 나오기만 해도
// 거부한다. 생성자를 꺼내는 `.constructor`(예: `(async () => {}).constructor('…')`, Function 생성자 우회)는
// `.constructor.name`만 허용한다.
import { builtinModules } from 'node:module';
import ts from 'typescript6';

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

/**
 * 이름이 나오기만 해도 거부하는 식별자: 다른 모듈 · 코드를 문자열로 불러오는 수단. 식별자 · 속성 이름 · 구조 분해
 * 이름은 물론, 같은 글자의 문자열 리터럴(`process['getBuiltinModule']` · `Reflect.get(process, 'binding')`)도 거부한다.
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
]);

/**
 * vitest · vite 실행기가 변환한 모듈에 넘기는 내부 함수 · 전역(`__vite_ssr_dynamic_import__('../src/x')`는 import
 * 없이 모듈을 불러온다. 실측).
 */
const RUNNER_INTERNAL_NAME = /^__vite(st)?_/u;
const RUNNER_INTERNAL_MESSAGE =
  'vitest · vite 실행기 내부 이름(__vite_ssr_… · __vitest_…)을 쓸 수 없습니다';

const CONSTRUCTOR_MESSAGE =
  'constructor로 생성자를 꺼낼 수 없습니다 (Function 생성자 우회, .constructor.name만 허용)';

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

const FILE_NAME = '/bive-acceptance/lint.acc.ts';

const parseSource = (
  source: string,
): { sourceFile: ts.SourceFile; diagnostics: readonly ts.Diagnostic[] } => {
  const sourceFile = ts.createSourceFile(
    FILE_NAME,
    source,
    { languageVersion: ts.ScriptTarget.Latest, impliedNodeFormat: ts.ModuleKind.ESNext },
    true,
    ts.ScriptKind.TS,
  );
  // 문법 오류는 공개 API(`getSyntacticDiagnostics`)로 얻는다. 파일 하나만 있는 프로그램이라 다른 파일 · 라이브러리를
  // 읽지 않는다
  const host: ts.CompilerHost = {
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
const accessedName = (node: ts.Node | undefined): string | undefined => {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return accessedName(node.expression);
  return undefined;
};

/** 식별자가 속성 읽기 자리(`x.name` · 구조 분해 `{ name }` · `{ name: y }`)에 있는지. */
const isReadPropertyName = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)) {
    return (
      parent.propertyName === node || (parent.propertyName === undefined && parent.name === node)
    );
  }
  return false;
};

/** `x.constructor.name` 꼴인지 (생성자 이름 읽기만 허용). */
const isConstructorNameRead = (node: ts.Identifier): boolean => {
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node) return false;
  const outer = access.parent;
  return (
    ts.isPropertyAccessExpression(outer) &&
    outer.expression === access &&
    outer.name.text === 'name'
  );
};

/**
 * 인수 테스트 소스의 import 문제를 찾는다. 빈 배열이면 통과.
 * 정적 import · `export … from` · 부작용 import · 동적 import(문자열 리터럴만) · 타입 import(`import('x')` 타입)의
 * 모듈 이름을 허용 목록과 대조하고, 모듈 이름을 숨길 수 있는 수단(`require` · `eval` · `Function` · `importActual` 류 ·
 * 실행기 내부 이름 · `.constructor` · `import.meta.glob` · `with`)을 거부한다. 문법 오류가 있으면 그것만 알린다.
 */
export const lintAcceptanceSource = (source: string): AcceptanceLintProblem[] => {
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
  const report = (node: ts.Node, message: string): void => {
    problems.push({ line: lineOf(node.getStart(sourceFile)), message });
  };
  const checkSpecifier = (node: ts.Node, specifier: string): void => {
    if (!isAllowedAcceptanceImport(specifier)) report(node, describeSpecifier(specifier));
  };

  const visit = (node: ts.Node): void => {
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
    } else if (ts.isWithStatement(node)) {
      report(node, 'with 문을 쓸 수 없습니다');
    } else if (ts.isIdentifier(node)) {
      // 이스케이프(`eval`)는 파서가 풀어 `text`에 원래 이름이 들어 있다
      const name = node.text;
      const denied = DENIED_NAMES.get(name);
      if (denied !== undefined) report(node, denied);
      else if (RUNNER_INTERNAL_NAME.test(name)) report(node, RUNNER_INTERNAL_MESSAGE);
      else if (name === 'constructor' && isReadPropertyName(node) && !isConstructorNameRead(node)) {
        // 클래스 생성자 정의 · 객체 키 `constructor`는 속성 읽기가 아니라 허용
        report(node, CONSTRUCTOR_MESSAGE);
      }
    } else if (ts.isStringLiteralLike(node)) {
      // 속성 이름을 문자열로 쓰는 우회: `x['constructor']` · `process['getBuiltinModule']` · `Reflect.get(f, 'constructor')`
      const name = node.text;
      const denied = DENIED_NAMES.get(name);
      if (denied !== undefined) report(node, denied);
      else if (RUNNER_INTERNAL_NAME.test(name)) report(node, RUNNER_INTERNAL_MESSAGE);
      else if (name === 'constructor') report(node, CONSTRUCTOR_MESSAGE);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return problems;
};
