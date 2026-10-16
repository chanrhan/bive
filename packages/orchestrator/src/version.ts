// 오케스트레이터 버전: 패키지 package.json의 version. src · dist 어디서 실행해도 한 단계 위에 있다.
import { readFileSync } from 'node:fs';

const readVersion = (): string => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const version =
    typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json에 version 없음');
  }
  return version;
};

export const ORCHESTRATOR_VERSION: string = readVersion();
