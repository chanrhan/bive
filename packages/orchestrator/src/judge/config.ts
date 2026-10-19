// BIVE 전용 vitest 설정 생성 (JDG-01, ADR-026).
// 프로젝트의 vitest.config.* · vitest.workspace · package.json 설정은 읽지 않는다:
// 생성한 설정을 `--config`로 명시하고 `--root`를 워크트리로 준다. 설정 파일은 외부 모듈을 import하지 않는
// 순수 객체라 워크트리 밖(`$BIVE_HOME/projects/<id>/judge/...`)에 있어도 해석할 것이 없다.

/** 인수 테스트 위치 (ADR-026). 규칙 매핑 = `bive-acceptance/<RULE-ID>/` 디렉터리. */
export const ACCEPTANCE_DIR = 'bive-acceptance';
export const ACCEPTANCE_SUFFIX = '.acc.ts';

/** 인수 테스트 케이스 1건의 제한 시간. */
export const ACCEPTANCE_TEST_TIMEOUT_MS = 15_000;

/** 판정 폴더 안 파일 이름. */
export const JUDGE_FILES = {
  config: 'vitest.config.mjs',
  collectConfig: 'collect.config.mjs',
  globalSetup: 'global-setup.mjs',
  result: 'result.json',
  collectResult: 'collect.json',
  collectLog: 'collect.log',
  stdout: 'stdout.log',
  stderr: 'stderr.log',
  profileLog: 'profile.log',
  serverLog: 'server.log',
  cacheDir: 'vite-cache',
} as const;

/** 규칙 디렉터리 이름으로 쓸 수 있는 ID (glob · 경로 문자 차단). */
export const RULE_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 기준 URL을 vitest에 넘기는 환경 변수 (오케스트레이터 → globalSetup 전달 전용, ADR-051). */
export const BASE_URL_ENV = 'BIVE_BASE_URL';

/**
 * 수집 단계에서 쓰는 자리 표시 기준 URL. 수집 단계는 케이스 본문 · 훅을 실행하지 않지만 최상위 코드가
 * `inject('baseUrl')`을 읽어도 실제 실행과 같은 모양의 값을 받게 한다 (포트 9 = discard, 아무도 듣지 않음).
 */
export const COLLECT_PLACEHOLDER_BASE_URL = 'http://127.0.0.1:9';

/** 어떤 케이스 이름과도 맞지 않는 패턴. 수집 단계에서 모든 케이스를 건너뛰게 한다(훅도 실행되지 않음). */
const MATCH_NOTHING = '(?!)';

/**
 * `include` 패턴. 규칙을 지정하면 그 규칙 디렉터리만. 지정하지 않아도 규칙 폴더 안 파일만 줍는다
 * (`bive-acceptance/` 바로 아래 파일은 규칙에 매핑되지 않으므로 실행하지 않는다, ADR-026).
 */
export const includePatterns = (ruleIds: readonly string[] | null): string[] =>
  ruleIds === null
    ? [`${ACCEPTANCE_DIR}/*/**/*${ACCEPTANCE_SUFFIX}`]
    : ruleIds.map((id) => `${ACCEPTANCE_DIR}/${id}/**/*${ACCEPTANCE_SUFFIX}`);

export interface JudgeConfigInput {
  /**
   * `collect`: 파일을 불러와 케이스를 수집만 한다(본문 · 훅 미실행). 서버 기동 전에 파일 로드 오류를 가린다
   * `run`: 판정 서버를 대상으로 실제 실행한다
   */
  mode: 'collect' | 'run';
  worktreeDir: string;
  judgeDir: string;
  globalSetupPath: string;
  resultPath: string;
  cacheDir: string;
  ruleIds: readonly string[] | null;
}

/** 생성 설정 객체 (테스트 · 기록용으로도 돌려준다). */
export const buildJudgeConfig = (input: JudgeConfigInput) => ({
  root: input.worktreeDir,
  // 프로젝트의 .env 파일을 읽지 않는다
  envDir: input.judgeDir,
  cacheDir: input.cacheDir,
  test: {
    include: includePatterns(input.ruleIds),
    exclude: ['**/node_modules/**'],
    globalSetup: [input.globalSetupPath],
    setupFiles: [],
    reporters: input.mode === 'run' ? ['default', 'json'] : ['json'],
    outputFile: { json: input.resultPath },
    ...(input.mode === 'collect' ? { testNamePattern: MATCH_NOTHING } : {}),
    includeTaskLocation: true,
    // 0개 수집도 JSON을 남기게 하고 collect_error는 러너가 판단한다
    passWithNoTests: true,
    // `.only`가 다른 케이스를 건너뛰게 하지 못한다 (`.only` 케이스는 실패로 표시돼 수집 단계에서 걸린다)
    allowOnly: false,
    // 판정은 1회 실행, 재시도로 통과시키지 않는다 (ADR-026)
    retry: 0,
    bail: 0,
    watch: false,
    testTimeout: ACCEPTANCE_TEST_TIMEOUT_MS,
    hookTimeout: ACCEPTANCE_TEST_TIMEOUT_MS,
    typecheck: { enabled: false },
    coverage: { enabled: false },
  },
});

/** `vitest.config.mjs` 본문. */
export const renderJudgeConfig = (input: JudgeConfigInput): string =>
  [
    '// BIVE 판정 러너가 생성한 설정 (JDG-01). 프로젝트 테스트 설정을 쓰지 않는다. 직접 고치지 않는다.',
    `export default ${JSON.stringify(buildJudgeConfig(input), null, 2)};`,
    '',
  ].join('\n');

/**
 * `global-setup.mjs` 본문. 서버는 오케스트레이터가 프로필로 이미 띄웠고, 여기서는 기준 URL을
 * `provide('baseUrl')`로 테스트에 넘긴다. 인수 테스트는 `inject('baseUrl')`로 받는다 (ADR-051).
 */
export const renderGlobalSetup = (): string =>
  [
    "// BIVE 판정 러너가 생성한 globalSetup (ADR-051). 인수 테스트는 inject('baseUrl')로 기준 URL을 받는다.",
    'export default function setup(project) {',
    `  const baseUrl = process.env.${BASE_URL_ENV};`,
    "  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {",
    `    throw new Error('${BASE_URL_ENV} 없음: 판정 서버가 기동되지 않았습니다');`,
    '  }',
    "  project.provide('baseUrl', baseUrl);",
    '}',
    '',
  ].join('\n');
