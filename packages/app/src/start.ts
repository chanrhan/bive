// 앱 실행: `pnpm --filter @bive/app start -- <인자>` (빌드 후 Electron을 띄운다).
// 인자는 그대로 Electron에 넘기고(`--remote-debugging-port=…` 포함), 필요하면 `--no-sandbox`를 붙인다.
// Electron의 종료 코드를 그대로 돌려준다.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { electronArgs } from './launch-flags.js';

const appDir = fileURLToPath(new URL('..', import.meta.url));
// Node에서 `electron` 패키지는 실행 파일 경로를 내보낸다
const electronPath = createRequire(import.meta.url)('electron') as string;

const args = electronArgs({
  appDir,
  userArgs: process.argv.slice(2),
  uid: process.getuid?.(),
  env: process.env,
});

const child = spawn(electronPath, args, { stdio: 'inherit' });
const forward = (signal: NodeJS.Signals): void => {
  child.kill(signal);
};
process.on('SIGINT', forward);
process.on('SIGTERM', forward);
child.on('error', (error) => {
  console.error('Electron 실행 실패:', error.message);
  process.exit(1);
});
child.on('close', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});
