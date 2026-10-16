// 파이프 접속 토큰 (ADR-027): `$BIVE_HOME/run/token`, 0600, 기동마다 새로 만든다.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';

/** 새 토큰(32바이트 난수, base64url)을 만들어 원자적으로 파일에 쓴다. */
export const writeTokenFile = (tokenPath: string): string => {
  const token = randomBytes(32).toString('base64url');
  const temp = `${tokenPath}.${process.pid}.tmp`;
  writeFileSync(temp, token, { mode: 0o600 });
  // umask와 무관하게 0600으로 맞춘다
  chmodSync(temp, 0o600);
  renameSync(temp, tokenPath);
  return token;
};

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** 길이와 무관하게 상수 시간으로 비교한다. */
export const tokensEqual = (expected: string, received: string): boolean =>
  timingSafeEqual(digest(expected), digest(received));
