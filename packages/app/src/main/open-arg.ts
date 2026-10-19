// 기동 인자 `--open <path>` (M1-01): 폴더 선택 대화상자 없이 그 폴더로 `project.open`을 부른다.
// `pnpm --filter @bive/app start -- --open $FX --remote-debugging-port=9222`처럼 다른 인자와 섞여 온다.
// 상대 경로는 명령을 실행한 폴더 기준이다. pnpm은 스크립트를 패키지 폴더에서 돌리므로 `INIT_CWD`(원래 위치)를 쓴다.
import path from 'node:path';

export const OPEN_FLAG = '--open';

export type OpenArg =
  /** 인자 없음 */
  | { kind: 'none' }
  /** 열 폴더 (절대 경로) */
  | { kind: 'path'; path: string }
  /** `--open` 뒤에 값이 없음 */
  | { kind: 'missing' };

/**
 * argv에서 `--open <path>` 또는 `--open=<path>`를 찾는다. 여러 번이면 처음 것을 쓴다.
 * 값 자리가 비었거나 다른 스위치(`--…`)면 값 없음으로 본다.
 * @param argv `process.argv` 전체 (실행 파일 · 앱 폴더 포함)
 * @param cwd 상대 경로의 기준 폴더
 */
export const parseOpenArg = (argv: readonly string[], cwd: string): OpenArg => {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let value: string | undefined;
    if (arg === OPEN_FLAG) {
      const next = argv[i + 1];
      value = next === undefined || next.startsWith('--') ? '' : next;
    } else if (arg.startsWith(`${OPEN_FLAG}=`)) {
      value = arg.slice(OPEN_FLAG.length + 1);
    } else {
      continue;
    }
    if (value.trim() === '') return { kind: 'missing' };
    return { kind: 'path', path: path.resolve(cwd, value) };
  }
  return { kind: 'none' };
};

/** 상대 경로의 기준 폴더: pnpm · npm이 남긴 `INIT_CWD`, 없으면 현재 폴더. */
export const launchCwd = (env: NodeJS.ProcessEnv, cwd: () => string = process.cwd): string => {
  const init = env.INIT_CWD;
  return init !== undefined && init.trim() !== '' ? init : cwd();
};
