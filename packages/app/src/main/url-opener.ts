// IDE URL을 여는 곳의 공통 동작 (MET-01, ADR-084 · ADR-087). Electron에 의존하지 않아 단위 테스트에서 부른다.
// - 열기 바로 앞에서 허용 스킴 · 고정 호스트를 다시 확인한다(`assertIdeUrl`). 아니면 열지도 적지도 않는다
// - `BIVE_OPEN_URL_LOG=<절대 경로>`이면 URL을 열지 않고 그 파일에 한 줄(URL + 줄바꿈)로 덧붙인다. 시험 · 검수용 이음매다
//   (화면 없는 VM의 로드맵 완료 기준 흐름이 연 URL을 확인한다). 값이 절대 경로가 아니거나 쓰기가 실패하면 예외이고
//   그때도 열지 않는다. 기록(`codeOpen.record`)은 이 함수를 부르기 전에 이미 남는다(code-opener.ts)
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

import { assertIdeUrl } from './ide-url.js';

/** 연 URL을 열지 않고 적을 파일의 환경 변수. */
export const OPEN_URL_LOG_ENV = 'BIVE_OPEN_URL_LOG';

export interface UrlOpenerDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** 실제로 연다 (Electron: `shell.openExternal`) */
  openExternal(url: string): Promise<void>;
  /** 파일 끝에 덧붙인다 (기본 `fs.appendFile`, 새 파일은 0600) */
  append?(file: string, data: string): Promise<void>;
}

const appendLine = (file: string, data: string): Promise<void> =>
  appendFile(file, data, { encoding: 'utf8', mode: 0o600, flag: 'a' });

/** URL 하나를 여는(또는 기록하는) 함수를 만든다. 환경 변수는 만들 때 한 번 읽는다. */
export const createUrlOpener = ({
  env,
  openExternal,
  append = appendLine,
}: UrlOpenerDeps): ((url: string) => Promise<void>) => {
  const logFile = env[OPEN_URL_LOG_ENV];
  return async (url) => {
    assertIdeUrl(url);
    if (logFile === undefined) {
      await openExternal(url);
      return;
    }
    if (!path.isAbsolute(logFile)) {
      throw new Error(`${OPEN_URL_LOG_ENV}가 절대 경로가 아닙니다`);
    }
    await append(logFile, `${url}\n`);
  };
};
