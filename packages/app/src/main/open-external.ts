// 앱이 외부 URL을 여는 유일한 곳 (MET-01 코드 열기, ADR-084 · ADR-087). 허용 스킴 · 고정 호스트가 아니면 열지 않는다.
// 렌더러는 이 함수를 직접 부를 수 없고, main의 `app.openInIde`가 설정의 IDE 선택으로 만든 URL만 넘긴다.
// `BIVE_OPEN_URL_LOG`가 있으면 열지 않고 그 파일에 적는다(url-opener.ts).
import { shell } from 'electron';

import { createUrlOpener } from './url-opener.js';

export const openExternalUrl = createUrlOpener({
  env: process.env,
  openExternal: (url) => shell.openExternal(url),
});
