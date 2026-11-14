// 앱이 외부 URL을 여는 유일한 곳 (MET-01 코드 열기, ADR-084). 고정 스킴(`IDE_URL_SCHEMES`)이 아니면 열지 않는다.
// 렌더러는 이 함수를 직접 부를 수 없고, main의 `app.openInIde`가 고정 틀로 만든 URL만 넘긴다.
import { shell } from 'electron';

import { assertIdeUrl } from './ide-url.js';

export const openExternalUrl = async (url: string): Promise<void> => {
  assertIdeUrl(url);
  await shell.openExternal(url);
};
