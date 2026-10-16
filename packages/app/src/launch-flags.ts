// Electron 실행 인자 (ADR-028): root 실행이거나 `BIVE_NO_SANDBOX=1`이면 `--no-sandbox`를 붙이고,
// `pnpm --filter @bive/app start -- <인자>`의 인자는 순서 그대로 Electron에 넘긴다.
export const NO_SANDBOX_FLAG = '--no-sandbox';

export interface LaunchContext {
  /** `process.getuid?.()`. Windows에는 없어 undefined */
  uid: number | undefined;
  env: NodeJS.ProcessEnv;
}

/** Chromium 샌드박스를 꺼야 하는지: root(uid 0) 또는 `BIVE_NO_SANDBOX=1` (개발 · 테스트 한정). */
export const needsNoSandbox = ({ uid, env }: LaunchContext): boolean =>
  uid === 0 || env.BIVE_NO_SANDBOX === '1';

export interface ElectronArgsInput extends LaunchContext {
  /** 앱 폴더 (package.json의 main이 빌드된 main을 가리키는 곳) */
  appDir: string;
  /** 사용자가 넘긴 인자 (`process.argv.slice(2)`) */
  userArgs: readonly string[];
}

/**
 * Electron에 넘길 인자 = [`--no-sandbox`?, 앱 폴더, ...사용자 인자].
 * 맨 앞의 `--` 구분자는 떼고, 사용자가 이미 `--no-sandbox`를 넘겼으면 중복으로 붙이지 않는다.
 */
export const electronArgs = ({ appDir, userArgs, uid, env }: ElectronArgsInput): string[] => {
  const passed = userArgs[0] === '--' ? userArgs.slice(1) : [...userArgs];
  const sandboxOff = needsNoSandbox({ uid, env }) && !passed.includes(NO_SANDBOX_FLAG);
  return [...(sandboxOff ? [NO_SANDBOX_FLAG] : []), appDir, ...passed];
};
