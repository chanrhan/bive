// 구조 시험의 구문 트리 · 타입 분석 (M3-31 #259, ADR-142).
// 제품 소스(`packages/orchestrator/src`)를 TypeScript 컴파일러 API(`typescript6`, 제품의 인수 테스트 검사가 이미 쓰는 의존성)로
// 한 번 읽고, 글자 대조가 놓치는 형태를 잡는다.
// - 모듈 참조: 정적 import(작은 · 큰따옴표, 타입 전용 포함) · `export … from` · 동적 `import()` · `require` · 타입 자리의
//   `import('x')`. 상대 경로를 src 기준 파일로 풀어서 같은 폴더의 `./x.js`도 같은 모듈로 본다
// - 선언 참조: 저장소 속성(`store.normChanges`) · 저장소 메서드(`normChanges.append`) · 서비스 메서드(`ruleWriter.judge`)를
//   이름 글자가 아니라 타입 검사기가 푼 선언으로 찾는다. 별칭 변수 · 구조 분해 · 대괄호 접근 · `?.` 유무 · 함수 인자로 넘긴
//   저장소(타입이 있는 매개변수)가 모두 같은 선언으로 풀린다. 이름과 같은 문자열 리터럴(`Reflect.get(store, 'normChanges')`)도
//   보수적으로 참조로 센다
// - 날 SQL: 문자열 · 템플릿 리터럴(자리 표시 `${}`는 `?`로)과 리터럴끼리의 `+` 이음을 펴서 쓰기 문장을 찾는다
// - 실행 종료 상태: 실행 패치(`run:` 값)의 `status`가 가질 수 있는 리터럴을 삼항 · 변수 · 스프레드 · 타입까지 따라간다
// 프로그램은 파일마다 한 번만 만든다(`productSource`는 모듈 안에서 한 번, 표본 프로그램은 그것을 옛 프로그램으로 재사용).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type TS from 'typescript6';

const ts = createRequire(import.meta.url)('typescript6') as typeof TS;

export const ORCHESTRATOR_SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const ORCHESTRATOR_DIR = path.resolve(ORCHESTRATOR_SRC, '..');

export interface SourceSet {
  readonly ts: typeof TS;
  readonly program: TS.Program;
  readonly checker: TS.TypeChecker;
  /** src 기준 경로(`/` 구분, 정렬). 표본 프로그램이면 표본 파일도 든다 */
  readonly files: readonly string[];
  readonly sourceOf: (rel: string) => TS.SourceFile;
}

const toRel = (file: string): string =>
  path.relative(ORCHESTRATOR_SRC, file).split(path.sep).join('/');

const productFiles = (): string[] =>
  ts.sys
    .readDirectory(ORCHESTRATOR_SRC, ['.ts'], undefined, undefined)
    .filter((file) => !file.endsWith('.d.ts'))
    .map((file) => path.resolve(file));

const compilerOptions = (): TS.CompilerOptions => {
  const configPath = path.join(ORCHESTRATOR_DIR, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) throw new Error('tsconfig.json을 읽지 못함');
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ORCHESTRATOR_DIR);
  return { ...parsed.options, noEmit: true };
};

const makeSet = (program: TS.Program, rootFiles: readonly string[]): SourceSet => {
  const byRel = new Map<string, TS.SourceFile>();
  for (const file of rootFiles) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) throw new Error(`소스 파일 없음: ${file}`);
    byRel.set(toRel(file), sourceFile);
  }
  return {
    ts,
    program,
    checker: program.getTypeChecker(),
    files: [...byRel.keys()].sort(),
    sourceOf: (rel) => {
      const sourceFile = byRel.get(rel);
      if (sourceFile === undefined) throw new Error(`소스 파일 없음: ${rel}`);
      return sourceFile;
    },
  };
};

let product: SourceSet | undefined;

/** 제품 소스 전체 (한 번만 만든다). */
export const productSource = (): SourceSet => {
  if (product !== undefined) return product;
  const files = productFiles();
  product = makeSet(ts.createProgram(files, compilerOptions()), files);
  return product;
};

/**
 * 제품 소스에 표본 파일을 더하거나(새 경로) 바꿔 끼운(기존 경로) 프로그램. 키는 src 기준 경로, 값은 소스 글.
 * 제품 프로그램을 옛 프로그램으로 넘겨 바뀌지 않은 파일의 구문 트리를 재사용한다.
 */
export const sampleSource = (samples: Readonly<Record<string, string>>): SourceSet => {
  const base = productSource();
  const options = base.program.getCompilerOptions();
  const host = ts.createCompilerHost(options, true);
  const overrides = new Map(
    Object.entries(samples).map(([rel, text]) => [path.join(ORCHESTRATOR_SRC, rel), text]),
  );
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = overrides.get(path.resolve(fileName));
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => overrides.has(path.resolve(fileName)) || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => overrides.get(path.resolve(fileName)) ?? readFile(fileName);
  const files = [...new Set([...productFiles(), ...overrides.keys()])];
  return makeSet(ts.createProgram(files, options, host, base.program), files);
};

// ── 모듈 참조 ─────────────────────────────────────────────

export type ModuleRefKind = 'import' | 'export' | 'dynamic' | 'require' | 'type';

export interface ModuleRef {
  readonly kind: ModuleRefKind;
  /** 모듈 이름 글. 리터럴이 아닌 식이면 `null` */
  readonly specifier: string | null;
  /** 상대 경로면 src 기준 `.ts` 파일, 아니면 모듈 이름 그대로, 알 수 없으면 `null` */
  readonly target: string | null;
  /** 가져오는 이름 (`*` = 네임스페이스 · 다시 내보내기 전부 · 동적 · require, `default`, 부작용 import는 빈 목록) */
  readonly names: readonly string[];
}

const literalText = (node: TS.Node | undefined): string | null =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;

const resolveTarget = (rel: string, specifier: string | null): string | null => {
  if (specifier === null) return null;
  if (!specifier.startsWith('.')) return specifier;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
  if (/\.[cm]?js$/.test(joined)) return joined.replace(/\.([cm]?)js$/, '.$1ts');
  return /\.[cm]?ts$/.test(joined) ? joined : `${joined}.ts`;
};

/** 파일 하나의 모든 모듈 참조 (나온 순서). */
const moduleRefCache = new WeakMap<SourceSet, Map<string, ModuleRef[]>>();

export const moduleRefs = (set: SourceSet, rel: string): ModuleRef[] => {
  const cache = moduleRefCache.get(set) ?? new Map<string, ModuleRef[]>();
  moduleRefCache.set(set, cache);
  const cached = cache.get(rel);
  if (cached !== undefined) return cached;
  const refs: ModuleRef[] = [];
  cache.set(rel, refs);
  const push = (kind: ModuleRefKind, specifier: string | null, names: readonly string[]) =>
    refs.push({ kind, specifier, target: resolveTarget(rel, specifier), names });
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name !== undefined) names.push('default');
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) names.push('*');
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
      }
      push('import', literalText(node.moduleSpecifier), names);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      const names =
        clause !== undefined && ts.isNamedExports(clause)
          ? clause.elements.map((element) => (element.propertyName ?? element.name).text)
          : ['*'];
      push('export', literalText(node.moduleSpecifier), names);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      push('require', literalText(node.moduleReference.expression), ['*']);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push('dynamic', literalText(node.arguments[0]), ['*']);
    } else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        // `createRequire(…)('x')`
        (ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'createRequire'))
    ) {
      push('require', literalText(node.arguments[0]), ['*']);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      push('type', ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null, ['*']);
    }
    ts.forEachChild(node, visit);
  };
  visit(set.sourceOf(rel));
  return refs;
};

/** `target`(src 기준 `.ts` 경로)을 어떤 형태로든 참조하는 파일 (정렬). */
export const importersOf = (set: SourceSet, target: string): string[] =>
  set.files.filter((rel) => moduleRefs(set, rel).some((ref) => ref.target === target));

/** 파일마다 `target`에서 가져오는 이름 (정렬, 참조가 없는 파일은 빠진다). */
export const importedNamesOf = (set: SourceSet, target: string): Record<string, string[]> =>
  Object.fromEntries(
    set.files
      .map(
        (rel) =>
          [
            rel,
            [
              ...new Set(
                moduleRefs(set, rel)
                  .filter((ref) => ref.target === target)
                  .flatMap((ref) => (ref.names.length === 0 ? ['(부작용)'] : ref.names)),
              ),
            ].sort(),
          ] as const,
      )
      .filter(([, names]) => names.length > 0),
  );

/** 모듈 이름이 리터럴이 아닌 참조 (어느 모듈인지 알 수 없다). */
export const computedModuleRefs = (set: SourceSet): string[] =>
  set.files.filter((rel) => moduleRefs(set, rel).some((ref) => ref.specifier === null));

// ── 선언 참조 ─────────────────────────────────────────────

/**
 * 프로그램 안에서 `owner`(클래스 · 인터페이스 이름)의 멤버 `member` 선언. 같은 이름의 클래스 · 인터페이스가 여럿이면
 * `fileSuffix`(선언 파일 경로의 끝)로 고른다.
 */
export const memberDeclarations = (
  set: SourceSet,
  owner: string,
  member: string,
  fileSuffix: string,
): TS.Declaration[] => {
  const found: TS.Declaration[] = [];
  for (const sourceFile of set.program.getSourceFiles()) {
    if (!sourceFile.fileName.endsWith(fileSuffix)) continue;
    const visit = (node: TS.Node): void => {
      if (
        (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        node.name?.text === owner
      ) {
        for (const item of node.members) {
          const name = item.name;
          if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
            if (name.text === member) found.push(item);
          }
          // 생성자 매개변수 속성 (`constructor(readonly db: …)`)
          if (ts.isConstructorDeclaration(item)) {
            for (const parameter of item.parameters) {
              if (
                (ts.getModifiers(parameter)?.length ?? 0) > 0 &&
                ts.isIdentifier(parameter.name) &&
                parameter.name.text === member
              ) {
                found.push(parameter);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  if (found.length === 0) throw new Error(`선언 없음: ${owner}.${member} (${fileSuffix})`);
  return found;
};

/** 최상위 선언(클래스 · 함수 · 변수) */
export const topLevelDeclaration = (
  set: SourceSet,
  name: string,
  fileSuffix: string,
): TS.Declaration[] => {
  const found: TS.Declaration[] = [];
  for (const sourceFile of set.program.getSourceFiles()) {
    if (!sourceFile.fileName.endsWith(fileSuffix)) continue;
    for (const statement of sourceFile.statements) {
      if (
        (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
        statement.name?.text === name
      ) {
        found.push(statement);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            found.push(declaration);
          }
        }
      }
    }
  }
  if (found.length === 0) throw new Error(`선언 없음: ${name} (${fileSuffix})`);
  return found;
};

export type ReferenceForm = 'symbol' | 'binding' | 'string';

export interface DeclarationRef {
  readonly rel: string;
  readonly line: number;
  readonly form: ReferenceForm;
}

const declarationsOf = (checker: TS.TypeChecker, symbol: TS.Symbol): TS.Declaration[] => {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return [resolved, ...checker.getRootSymbols(resolved)].flatMap((item) => item.declarations ?? []);
};

/**
 * 이름과 같은 글자의 문자열 리터럴을 참조로 셀 범위.
 * - `any`: 어디에 있든 센다 (흔치 않은 이름: `normChanges` · `ruleRetirements` · `confirmations`)
 * - `access`: 속성을 고르는 자리만 센다: 타입 검사기가 풀지 못한 대괄호 접근(`(store as any)['rules']`)과
 *   `Reflect` · `Object`의 함수 인자(`Reflect.get(store, 'rules')`). 흔한 이름(`rules` · `create` · `judge`)은 다른 뜻의
 *   글(`rulesDir: 'rules'`, `stage: 'judge'`)이 많아 이 범위로 좁힌다
 * - `none`: 세지 않는다
 */
export type StringRefMode = 'any' | 'access' | 'none';

/**
 * `declarations` 가운데 하나를 가리키는 자리 (선언 자신의 이름은 빼고). 이름 글자가 같은 식별자 · 문자열만 본다.
 * - `symbol`: 타입 검사기가 그 선언으로 푼 식별자 · 대괄호 접근의 문자열 (별칭 변수 · `?.` 유무 · 매개변수로 넘긴 값 포함)
 * - `binding`: 구조 분해(`const { normChanges } = store`)의 속성 이름
 * - `string`: 그 밖의 같은 글자 문자열 리터럴 (`strings` 범위만, 보수적으로 센다)
 */
export const referencesTo = (
  set: SourceSet,
  declarations: readonly TS.Declaration[],
  strings: StringRefMode = 'access',
): DeclarationRef[] => {
  const targets = new Set<TS.Node>(declarations);
  const names = new Set(
    declarations.flatMap((declaration) => {
      const name = ts.getNameOfDeclaration(declaration);
      return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
        ? [name.text]
        : [];
    }),
  );
  const declarationNames = new Set(
    declarations.flatMap((declaration) => {
      const name = ts.getNameOfDeclaration(declaration);
      return name === undefined ? [] : [name];
    }),
  );
  const { checker } = set;
  const selectsProperty = (node: TS.Node): boolean => {
    const parent = node.parent;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
    return (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(node as TS.Expression) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      ts.isIdentifier(parent.expression.expression) &&
      ['Reflect', 'Object'].includes(parent.expression.expression.text)
    );
  };
  const hits = (symbol: TS.Symbol | undefined): boolean =>
    symbol !== undefined && declarationsOf(checker, symbol).some((item) => targets.has(item));
  const refs: DeclarationRef[] = [];
  const index = nameIndex(set);
  for (const name of names) {
    for (const { rel, node } of index.get(name) ?? []) {
      if (declarationNames.has(node)) continue;
      const sourceFile = set.sourceOf(rel);
      const push = (form: ReferenceForm) =>
        refs.push({
          rel,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          form,
        });
      const isString = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
      const parent = node.parent;
      if (
        ts.isBindingElement(parent) &&
        (parent.propertyName === node ||
          (parent.propertyName === undefined && parent.name === node)) &&
        ts.isObjectBindingPattern(parent.parent)
      ) {
        // 구조 분해: 속성 이름의 선언은 분해하는 값의 타입에서 찾는다
        const type = checker.getTypeAtLocation(parent.parent);
        if (hits(checker.getPropertyOfType(type, name))) push('binding');
      } else if (hits(checker.getSymbolAtLocation(node))) {
        push('symbol');
      } else if (
        isString &&
        !ts.isImportDeclaration(parent) &&
        !ts.isExportDeclaration(parent) &&
        (strings === 'any' || (strings === 'access' && selectsProperty(node)))
      ) {
        push('string');
      }
    }
  }
  return refs.sort((a, b) => (a.rel === b.rel ? a.line - b.line : a.rel < b.rel ? -1 : 1));
};

type NamedNode =
  TS.Identifier | TS.PrivateIdentifier | TS.StringLiteral | TS.NoSubstitutionTemplateLiteral;
const nameIndexes = new WeakMap<SourceSet, Map<string, { rel: string; node: NamedNode }[]>>();

/** 이름 · 문자열 글자 → 그 글자의 식별자 · 문자열 리터럴 자리 (파일마다 한 번 걷는다) */
const nameIndex = (set: SourceSet): Map<string, { rel: string; node: NamedNode }[]> => {
  const cached = nameIndexes.get(set);
  if (cached !== undefined) return cached;
  const index = new Map<string, { rel: string; node: NamedNode }[]>();
  for (const rel of set.files) {
    const visit = (node: TS.Node): void => {
      if (
        ts.isIdentifier(node) ||
        ts.isPrivateIdentifier(node) ||
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        const list = index.get(node.text) ?? [];
        list.push({ rel, node });
        index.set(node.text, list);
      }
      ts.forEachChild(node, visit);
    };
    visit(set.sourceOf(rel));
  }
  nameIndexes.set(set, index);
  return index;
};

/** 선언을 참조하는 파일 (정렬). */
export const filesReferencing = (
  set: SourceSet,
  declarations: readonly TS.Declaration[],
  strings: StringRefMode = 'access',
): string[] => [...new Set(referencesTo(set, declarations, strings).map((ref) => ref.rel))].sort();

/** 흔치 않은 저장소 속성 이름 (같은 글자의 문자열을 어디서든 참조로 센다) */
const DISTINCT_STORE_MEMBERS = new Set(['normChanges', 'ruleRetirements', 'confirmations']);

/** 저장소 속성(`ProjectStore.<member>`)의 선언 */
export const storeMember = (set: SourceSet, member: string): TS.Declaration[] =>
  memberDeclarations(set, 'ProjectStore', member, 'store/src/project-store.ts');

/** 저장소 속성(`ProjectStore.<member>`)을 참조하는 파일 */
export const storeMemberUsers = (set: SourceSet, member: string): string[] =>
  filesReferencing(
    set,
    storeMember(set, member),
    DISTINCT_STORE_MEMBERS.has(member) ? 'any' : 'access',
  );

/** 저장소 클래스의 메서드 선언 (`NormChangeRepository.append` 등, `store/src/repositories/<file>`) */
export const repositoryMethod = (
  set: SourceSet,
  repository: string,
  method: string,
  file: string,
): TS.Declaration[] =>
  memberDeclarations(set, repository, method, `store/src/repositories/${file}`);

/** 저장소 클래스의 메서드를 참조하는 파일 */
export const repositoryMethodUsers = (
  set: SourceSet,
  repository: string,
  method: string,
  file: string,
): string[] => filesReferencing(set, repositoryMethod(set, repository, method, file));

/** 파일 하나에서 저장소 클래스의 메서드 가운데 참조된 이름 (정렬) */
export const repositoryMethodsUsedIn = (
  set: SourceSet,
  rel: string,
  repository: string,
  methods: readonly string[],
  file: string,
): string[] =>
  methods
    .filter((method) =>
      referencesTo(set, repositoryMethod(set, repository, method, file)).some(
        (ref) => ref.rel === rel,
      ),
    )
    .sort();

// ── 날 SQL ───────────────────────────────────────────────

/** 문자열로 쓰인 글: 리터럴 · 템플릿(`${}` 자리는 `?`) · 리터럴끼리의 `+` 이음 (가장 바깥 것만) */
const stringTexts = (sourceFile: TS.SourceFile): { text: string; line: number }[] => {
  const out: { text: string; line: number }[] = [];
  const fold = (node: TS.Expression): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((span) => `?${span.literal.text}`).join('');
    }
    if (ts.isParenthesizedExpression(node)) return fold(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = fold(node.left);
      const right = fold(node.right);
      if (left === null && right === null) return null;
      return `${left ?? '?'}${right ?? '?'}`;
    }
    return null;
  };
  const visit = (node: TS.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const text = fold(node.template);
      if (text !== null) {
        out.push({
          text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
      return;
    }
    if (ts.isExpression(node)) {
      const text = fold(node);
      if (text !== null) {
        out.push({
          text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
};

const quotedName = (name: string) => `(?:"${name}"|\`${name}\`|\\[${name}\\]|${name})`;
const qualifiedName = (name: string) =>
  `(?:${quotedName('\\w+')}\\s*\\.\\s*)?${quotedName(name)}(?![\\w"\`\\]])`;

/**
 * `tables` 가운데 하나에 쓰는 SQL 문장 (INSERT · REPLACE · UPDATE · DELETE, 대소문자 · 줄 나눔 무관, 표 이름의 따옴표 ·
 * 스키마 접두 포함)의 정규식.
 */
export const sqlWritePattern = (tables: readonly string[]): RegExp => {
  const table = qualifiedName(`(?:${tables.join('|')})`);
  // 표 이름 뒤는 그 문장의 다음 낱말까지 본다 (`update rules 화면` 같은 글을 SQL로 보지 않는다)
  const alias = '(?:\\s+(?:AS\\s+)?\\w+)?';
  return new RegExp(
    [
      `\\b(?:INSERT|REPLACE)(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+${table}${alias}\\s*(?:\\(|VALUES\\b|SELECT\\b|DEFAULT\\b|WITH\\b)`,
      `\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${table}${alias}\\s+SET\\b`,
      `\\bDELETE\\s+FROM\\s+${table}${alias}\\s*(?:$|;|WHERE\\b|RETURNING\\b|ORDER\\b|LIMIT\\b)`,
    ].join('|'),
    'i',
  );
};

export interface SqlWrite {
  readonly rel: string;
  readonly line: number;
  readonly text: string;
}

/** 파일들의 문자열 글 가운데 `tables`에 쓰는 SQL 문장 */
export const sqlWrites = (set: SourceSet, tables: readonly string[]): SqlWrite[] => {
  const pattern = sqlWritePattern(tables);
  return set.files.flatMap((rel) =>
    stringTexts(set.sourceOf(rel))
      .filter(({ text }) => pattern.test(text))
      .map(({ text, line }) => ({ rel, line, text: text.replace(/\s+/g, ' ').trim() })),
  );
};

/** 프로그램 밖 파일(다른 패키지의 src)의 같은 검사. 타입 정보 없이 구문 트리만 만든다 */
export const sqlWritesInFiles = (
  files: readonly string[],
  tables: readonly string[],
): SqlWrite[] => {
  const pattern = sqlWritePattern(tables);
  return files.flatMap((file) => {
    const sourceFile = ts.createSourceFile(
      file,
      ts.sys.readFile(file) ?? '',
      ts.ScriptTarget.ES2023,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    return stringTexts(sourceFile)
      .filter(({ text }) => pattern.test(text))
      .map(({ text, line }) => ({ rel: file, line, text: text.replace(/\s+/g, ' ').trim() }));
  });
};

// ── 실행 종료 상태 ────────────────────────────────────────

export interface TerminalWrite {
  readonly rel: string;
  /** 실행 패치(`run:`)가 있는 줄 */
  readonly line: number;
  /** 상태 리터럴(또는 그 타입을 가진 식)이 있는 줄 */
  readonly literalLine: number;
  readonly status: string;
  /** 리터럴을 찾은 길 (`literal` 직접 · 삼항 · 변수 · 스프레드 · 타입) */
  readonly via: string;
}

/**
 * 실행 패치(`run:` 속성의 값, 객체 리터럴로 풀리는 것)의 `status`가 `statuses` 가운데 하나일 수 있는 자리.
 * 따라가는 길: 괄호 · `as` · `satisfies` · `!`, 삼항의 두 갈래, `??` · `||` · `&&`의 두 쪽, 초기값이 있는 `const`의 초기값,
 * 스프레드(`...x`)의 객체, 단축 속성(`{ status }`). 그 밖의 식은 타입 검사기가 준 타입의 문자열 리터럴 갈래로 본다(`HaltStatus`
 * 같은 타입도 잡힌다). 다만 `carryOver`(실행 상태 전부)를 모두 담는 타입은 저장된 실행의 상태를 그대로 옮기는 값이라 뺀다.
 * `allowedCall`(종료 상태를 정하는 함수)의 결과에서 온 값은 그 함수가 정한 것이라 뺀다.
 */
export const terminalStatusWrites = (
  set: SourceSet,
  rels: readonly string[],
  statuses: readonly string[],
  allowedCall: readonly TS.Declaration[],
  carryOver: readonly string[],
): TerminalWrite[] => {
  const { checker } = set;
  const allowed = new Set<TS.Node>(allowedCall);
  const wanted = new Set(statuses);
  const out: TerminalWrite[] = [];
  for (const rel of rels) {
    const sourceFile = set.sourceOf(rel);
    const lineOf = (node: TS.Node) =>
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    let patchLine = 0;
    const report = (node: TS.Node, status: string, via: string) => {
      if (wanted.has(status)) {
        out.push({ rel, line: patchLine, literalLine: lineOf(node), status, via });
      }
    };
    const unwrap = (node: TS.Expression): TS.Expression => {
      let current = node;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
        current = current.expression;
      }
      return current;
    };
    const constInitializer = (node: TS.Identifier): TS.Expression | undefined => {
      // 단축 속성(`{ status }`)의 이름은 속성 기호로 풀리므로 값 쪽 기호를 따로 묻는다
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined
      ) {
        return declaration.initializer;
      }
      return undefined;
    };
    /** 종료 상태를 정하는 함수의 결과(또는 그 속성)인지 */
    const fromAllowedCall = (node: TS.Expression, seen: Set<TS.Node>): boolean => {
      const current = unwrap(node);
      if (seen.has(current)) return false;
      seen.add(current);
      if (ts.isCallExpression(current)) {
        const symbol = checker.getSymbolAtLocation(current.expression);
        if (symbol === undefined) return false;
        const declarations = declarationsOf(checker, symbol);
        if (declarations.some((d) => allowed.has(d))) return true;
        // 그 함수를 그대로 돌려주는 함수 (`const blockedEnding = (…) => runEnding(…)`): 돌려주는 식이 모두 그 결과다
        return declarations.some((declaration) => {
          const fn =
            ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
              ? unwrap(declaration.initializer)
              : declaration;
          if (!ts.isArrowFunction(fn) && !ts.isFunctionDeclaration(fn)) return false;
          const body = fn.body;
          if (body === undefined) return false;
          if (!ts.isBlock(body)) return fromAllowedCall(body, seen);
          const returned: TS.Expression[] = [];
          const collect = (node: TS.Node): void => {
            if (ts.isReturnStatement(node) && node.expression !== undefined) {
              returned.push(node.expression);
            }
            if (!ts.isFunctionLike(node)) ts.forEachChild(node, collect);
          };
          ts.forEachChild(body, collect);
          return returned.length > 0 && returned.every((item) => fromAllowedCall(item, seen));
        });
      }
      if (ts.isPropertyAccessExpression(current)) return fromAllowedCall(current.expression, seen);
      if (ts.isIdentifier(current)) {
        const initializer = constInitializer(current);
        return initializer !== undefined && fromAllowedCall(initializer, seen);
      }
      return false;
    };
    const typeLiterals = (node: TS.Node, type: TS.Type, via: string) => {
      const literals = (type.isUnion() ? type.types : [type]).flatMap((part) =>
        part.isStringLiteral() ? [part.value] : [],
      );
      // 모든 상태를 담는 타입(저장된 실행을 그대로 옮기는 값)은 새로 정한 상태가 아니다
      if (carryOver.length > 0 && carryOver.every((status) => literals.includes(status))) return;
      for (const literal of literals) report(node, literal, via);
    };
    const statusOf = (node: TS.Expression, via: string, seen: Set<TS.Node>): void => {
      const current = unwrap(node);
      if (seen.has(current)) return;
      seen.add(current);
      if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
        report(current, current.text, via);
      } else if (ts.isConditionalExpression(current)) {
        statusOf(current.whenTrue, `${via}>삼항`, seen);
        statusOf(current.whenFalse, `${via}>삼항`, seen);
      } else if (
        ts.isBinaryExpression(current) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(current.operatorToken.kind)
      ) {
        statusOf(current.left, `${via}>논리`, seen);
        statusOf(current.right, `${via}>논리`, seen);
      } else if (fromAllowedCall(current, new Set())) {
        // 종료 상태를 정하는 함수가 정한 값
      } else if (ts.isIdentifier(current) && constInitializer(current) !== undefined) {
        statusOf(constInitializer(current) as TS.Expression, `${via}>변수`, seen);
      } else {
        typeLiterals(current, checker.getTypeAtLocation(current), `${via}>타입`);
      }
    };
    const objectOf = (node: TS.Expression, via: string, seen: Set<TS.Node>): void => {
      const current = unwrap(node);
      if (seen.has(current)) return;
      seen.add(current);
      if (ts.isObjectLiteralExpression(current)) {
        for (const property of current.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'status') {
            statusOf(property.initializer, via, seen);
          } else if (
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.name) &&
            property.name.text === 'status'
          ) {
            statusOf(property.initializer, via, seen);
          } else if (
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === 'status'
          ) {
            statusOf(property.name, `${via}>단축`, seen);
          } else if (ts.isSpreadAssignment(property)) {
            objectOf(property.expression, `${via}>스프레드`, seen);
          }
        }
      } else if (ts.isConditionalExpression(current)) {
        objectOf(current.whenTrue, `${via}>삼항`, seen);
        objectOf(current.whenFalse, `${via}>삼항`, seen);
      } else if (
        ts.isBinaryExpression(current) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(current.operatorToken.kind)
      ) {
        objectOf(current.left, `${via}>논리`, seen);
        objectOf(current.right, `${via}>논리`, seen);
      } else if (fromAllowedCall(current, new Set())) {
        // 종료 상태를 정하는 함수가 정한 패치
      } else if (ts.isIdentifier(current) && constInitializer(current) !== undefined) {
        objectOf(constInitializer(current) as TS.Expression, `${via}>변수`, seen);
      } else {
        const status = checker.getTypeAtLocation(current).getProperty('status');
        if (status !== undefined) {
          typeLiterals(current, checker.getTypeOfSymbolAtLocation(status, current), `${via}>타입`);
        }
      }
    };
    const visit = (node: TS.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === 'run') {
        patchLine = lineOf(node);
        objectOf(node.initializer, 'run', new Set());
      } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'run') {
        patchLine = lineOf(node);
        objectOf(node.name, 'run>단축', new Set());
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return out;
};
