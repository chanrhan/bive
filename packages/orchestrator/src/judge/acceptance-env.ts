// 인수 테스트 작성 환경 (JDG-01, ADR-051 · ADR-068).
// - 타입 선언: 프로젝트 tsconfig가 인수 테스트를 포함하면(`**/*.ts` 등) `next build`의 타입 검사가 인수 테스트도
//   검사한다. `inject('baseUrl')`은 vitest `ProvidedContext` 선언이 없으면 타입 오류이고, 그러면 빌드가 실패해 판정이
//   `runner_error`로 끝난다(ADR-051 남은 제약). 테스트 작성 단계가 `bive-acceptance/` 바로 아래에 선언 파일 2개를 두고
//   테스트 작성 커밋에 함께 넣는다. 판정할 커밋과 병합되는 커밋이 같으므로 병합 뒤 사용자 빌드도 같은 선언으로 통과한다.
//   `bive-acceptance/` 바로 아래 파일은 규칙에 매핑되지 않아 판정 · 집계 대상이 아니다(ADR-026 · ADR-051).
// - BIVE HTTP 도우미 `@bive/http`: 판정 러너가 판정 폴더에 모듈 파일을 만들고 생성 설정의 별칭으로 연결한다.
//   프로젝트에는 설치하지 않는다(판정 때만 있음). 기준 URL은 러너가 vitest에 넘기는 `BIVE_BASE_URL`에서 읽는다.
import { BIVE_HTTP_HELPER_MODULE } from './acceptance-lint.js';
import { ACCEPTANCE_DIR, BASE_URL_ENV } from './config.js';

/** `vitest` 모듈 보강 선언 파일 (모듈 파일이어야 보강이 된다). */
export const ACCEPTANCE_ENV_DECLARATION = `${ACCEPTANCE_DIR}/bive-env.d.ts`;
/** `@bive/http` 모듈 선언 파일 (스크립트 파일이어야 새 모듈 선언이 된다). */
export const ACCEPTANCE_HTTP_DECLARATION = `${ACCEPTANCE_DIR}/bive-http.d.ts`;

const MANAGED_HEADER =
  '// BIVE가 관리하는 파일 (ADR-068). 테스트 작성 단계가 다시 쓰므로 직접 고치지 않는다.';

/** 프로젝트에 두는 선언 파일 (상대 경로 → 내용). */
export const ACCEPTANCE_DECLARATION_FILES: Readonly<Record<string, string>> = {
  [ACCEPTANCE_ENV_DECLARATION]: [
    MANAGED_HEADER,
    "// 인수 테스트의 inject('baseUrl') 타입. 판정 러너의 globalSetup이 provide('baseUrl')로 넘긴다 (ADR-051).",
    'export {};',
    '',
    "declare module 'vitest' {",
    '  export interface ProvidedContext {',
    '    baseUrl: string;',
    '  }',
    '}',
    '',
  ].join('\n'),
  [ACCEPTANCE_HTTP_DECLARATION]: [
    MANAGED_HEADER,
    `// BIVE HTTP 도우미 ${BIVE_HTTP_HELPER_MODULE}의 타입. 모듈은 판정 때 판정 러너가 제공한다.`,
    `declare module '${BIVE_HTTP_HELPER_MODULE}' {`,
    '  /** 판정 서버 기준 URL에 경로를 붙인 절대 URL */',
    '  export function url(path: string): URL;',
    '  /** 판정 서버로 보내는 HTTP 요청. 리다이렉트는 따라가지 않는다 */',
    '  export function request(path: string, init?: RequestInit): Promise<Response>;',
    '}',
    '',
  ].join('\n'),
};

/** 판정 폴더에 두는 `@bive/http` 모듈 (`judge/<runId>/<judgeId>/bive-http.mjs`). */
export const renderHttpHelper = (): string =>
  [
    `// BIVE HTTP 도우미 (${BIVE_HTTP_HELPER_MODULE}, ADR-068). 판정 러너가 생성한다. 직접 고치지 않는다.`,
    'const baseUrl = () => {',
    `  const value = process.env.${BASE_URL_ENV};`,
    "  if (typeof value !== 'string' || value.length === 0) {",
    `    throw new Error('${BASE_URL_ENV} 없음: 판정 서버가 기동되지 않았습니다');`,
    '  }',
    '  return value;',
    '};',
    '',
    'export const url = (path) => new URL(path, baseUrl());',
    '',
    "export const request = (path, init = {}) => fetch(url(path), { redirect: 'manual', ...init });",
    '',
  ].join('\n');
