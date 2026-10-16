// @ts-check
// BIVE ESLint 설정 (flat config).
// - 제품 코드(packages/*/src)에서 테스트 전용 모듈(e2e · fixtures · mock) import 금지 (NFR-03)
// - docs/architecture.md 2장 "패키지 경계와 의존 방향" 표의 패키지 간 금지 import를 오류로 막는다
// 규칙 검증: packages/shared/test/lint-rules.test.ts
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** @typedef {{ regex: string, message: string, caseSensitive?: boolean, allowTypeImports?: boolean }} RestrictedPattern */

const PACKAGES = /** @type {const} */ (['shared', 'store', 'parser', 'orchestrator', 'app']);

/**
 * architecture.md 2장 표의 "import 금지" 열 중 워크스페이스 패키지.
 * shared는 "다른 워크스페이스 패키지 전부"라서 @bive/* 전체를 막는다(아래 sharedPatterns).
 * @type {Record<Exclude<typeof PACKAGES[number], 'shared'>, string[]>}
 */
const FORBIDDEN_PACKAGES = {
  store: ['orchestrator', 'parser', 'app'],
  parser: ['store', 'orchestrator', 'app'],
  orchestrator: ['app'],
  app: ['store', 'orchestrator', 'parser'],
};

const escapeRegex = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Node 내장 모듈 (`node:` 접두와 접두 없는 이름 모두). */
const NODE_BUILTIN_REGEX = `^(node:|(${builtinModules
  .filter((m) => !m.startsWith('_') && !m.includes('/'))
  .map(escapeRegex)
  .join('|')})(/|$))`;

/** 제품 코드 공통: 테스트 전용 모듈 금지 (NFR-03). */
/** @type {RestrictedPattern[]} */
const testOnlyPatterns = [
  {
    regex: '(^|/)(e2e|fixtures)(/|$)',
    message: '제품 코드에서 e2e · fixtures 경로는 import할 수 없습니다 (NFR-03).',
  },
  {
    regex: 'mock',
    caseSensitive: false,
    message: '제품 코드에서 이름에 mock이 든 모듈은 import할 수 없습니다 (NFR-03).',
  },
];

/**
 * 다른 워크스페이스 패키지를 패키지 이름(@bive/x)이나 상대 경로(../../x/src)로 가져오는 것을 막는 패턴.
 * @param {string} from 가져오는 쪽 패키지
 * @param {string} target 금지 대상 패키지
 * @returns {RestrictedPattern[]}
 */
const packagePatterns = (from, target) => [
  {
    regex: `^@bive/${escapeRegex(target)}(/|$)`,
    message: `${from} 패키지는 ${target} 패키지를 import할 수 없습니다 (architecture.md 2장).`,
  },
  {
    regex: `^(\\.\\./)+(packages/)?${escapeRegex(target)}/(src|dist)(/|$)`,
    message: `${from} 패키지는 상대 경로로 ${target} 패키지를 import할 수 없습니다 (architecture.md 2장).`,
  },
];

/** shared: 다른 워크스페이스 패키지 전부 · Node 전용 모듈 금지. */
/** @type {RestrictedPattern[]} */
const sharedPatterns = [
  {
    regex: '^@bive/',
    message:
      'shared 패키지는 다른 워크스페이스 패키지를 import할 수 없습니다 (architecture.md 2장).',
  },
  ...PACKAGES.filter((p) => p !== 'shared').flatMap((p) => packagePatterns('shared', p).slice(1)),
  {
    regex: NODE_BUILTIN_REGEX,
    message: 'shared 패키지는 Node 전용 모듈을 import할 수 없습니다 (architecture.md 2장).',
  },
];

/** app renderer: electron · Node 모듈 금지, shared는 import type만. */
/** @type {RestrictedPattern[]} */
const rendererPatterns = [
  {
    regex: '^electron(/|$)',
    message:
      'renderer는 electron을 import할 수 없습니다. preload의 window.bive만 씁니다 (architecture.md 2장).',
  },
  {
    regex: NODE_BUILTIN_REGEX,
    message: 'renderer는 Node 모듈을 import할 수 없습니다 (architecture.md 2장).',
  },
  {
    regex: '^@bive/shared(/|$)',
    allowTypeImports: true,
    message: 'renderer는 shared를 import type으로만 가져올 수 있습니다 (architecture.md 2장).',
  },
  {
    regex: '^(\\.\\./)+(packages/)?shared/(src|dist)(/|$)',
    allowTypeImports: true,
    message: 'renderer는 shared를 import type으로만 가져올 수 있습니다 (architecture.md 2장).',
  },
];

/**
 * no-restricted-imports는 설정 객체끼리 병합되지 않고 뒤의 것이 덮어쓰므로,
 * 파일 묶음마다 필요한 패턴 전체를 한 번에 넣는다.
 * 정적 import · export from 은 no-restricted-imports, 동적 import()는 no-restricted-syntax로 막는다.
 * @param {RestrictedPattern[]} patterns
 * @returns {import('eslint').Linter.RulesRecord}
 */
const restrict = (patterns) => ({
  'no-restricted-imports': 'off',
  '@typescript-eslint/no-restricted-imports': ['error', { patterns }],
  'no-restricted-syntax': [
    'error',
    // 동적 import()는 항상 런타임 import라서 allowTypeImports 패턴도 그대로 막는다
    ...patterns.map((p) => ({
      // esquery 정규식 리터럴은 내부에 '/'를 허용하지 않으므로 \x2F로 바꾼다
      selector: `ImportExpression[source.value=/${p.regex.replace(/\//g, '\\x2F')}/${
        p.caseSensitive === false ? 'i' : ''
      }]`,
      message: p.message,
    })),
  ],
});

/** @type {Record<typeof PACKAGES[number], RestrictedPattern[]>} */
const productPatterns = {
  shared: [...testOnlyPatterns, ...sharedPatterns],
  store: [
    ...testOnlyPatterns,
    ...FORBIDDEN_PACKAGES.store.flatMap((t) => packagePatterns('store', t)),
  ],
  parser: [
    ...testOnlyPatterns,
    ...FORBIDDEN_PACKAGES.parser.flatMap((t) => packagePatterns('parser', t)),
  ],
  orchestrator: [
    ...testOnlyPatterns,
    ...FORBIDDEN_PACKAGES.orchestrator.flatMap((t) => packagePatterns('orchestrator', t)),
  ],
  app: [...testOnlyPatterns, ...FORBIDDEN_PACKAGES.app.flatMap((t) => packagePatterns('app', t))],
};

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.claude/**',
      // 테스트 산출물 (스크린샷 · Playwright 보고서)
      'artifacts/**',
      // 독립 프로젝트(워크스페이스 밖). 자체 의존성 · 설정만 쓴다 (architecture.md 2장)
      'fixtures/**',
      // 규칙 위반 예제. lint-rules.test.ts가 제품 경로로 가장해 직접 검사한다
      '**/test/lint-fixtures/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  // 패키지별 제품 코드 경계
  ...PACKAGES.map((pkg) => ({
    files: [`packages/${pkg}/src/**/*.{ts,tsx,js,mjs,cjs}`],
    rules: restrict(productPatterns[pkg]),
  })),
  // app renderer: app 패키지 규칙 + renderer 전용 규칙
  {
    files: ['packages/app/src/renderer/**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: restrict([...productPatterns.app, ...rendererPatterns]),
  },
  // app 화면 e2e: Node(Playwright 테스트)와 브라우저(page.evaluate · addInitScript 함수) 문맥이 섞인다
  {
    files: ['packages/app/e2e/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  prettier,
);
