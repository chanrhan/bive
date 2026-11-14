// 시험 전용 네트워크 감시 (M1-22, NFR-04 · ADR-075). 감시를 건 프로세스 안의 연결 시도를 `net` · `dns` 호출 지점에서 기록한다.
// - `net`: `net.Socket.prototype.connect` (net.connect · tls.connect · http · fetch(undici)가 모두 이것을 거친다)
// - `dns`: `dns` · `dns.promises` 모듈의 `lookup` · `lookupService` · `resolve*` · `reverse`와 두 `Resolver` 원형의 같은 메서드
// 기록은 호출 시점(실제 연결 · 질의 전)에 남긴다. 감시는 그 프로세스에만 걸리고 하위 프로세스(git · pnpm · next)에는 없다.
// 허용(외부 아님): 로컬 소켓(경로 연결: Unix 소켓 · Windows named pipe)과 127.0.0.1. 그 밖은 모두 외부 연결 시도다.
import dns from 'node:dns';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

/** 연결 시도 1건. */
export type NetAttempt =
  | { kind: 'net'; pid: number; at: string; path: string }
  | { kind: 'net'; pid: number; at: string; host: string; port: number | null }
  | { kind: 'dns'; pid: number; at: string; api: string; hostname: string };

/** 기록 파일 한 줄: 감시 설치 표시 또는 연결 시도. */
export type NetWatchRecord = { kind: 'installed'; pid: number; at: string } | NetAttempt;

/** 감시가 막아야 하는 시도에서 던지는 오류 (자체 점검용, 실제 연결 · 질의 전에 끝낸다). */
export class NetWatchBlocked extends Error {
  override readonly name = 'NetWatchBlocked';
}

export interface NetWatchOptions {
  onRecord: (record: NetWatchRecord) => void;
  /** 참이면 기록 뒤 원래 호출 대신 `NetWatchBlocked`를 던진다 (자체 점검에서 실제 네트워크를 쓰지 않게) */
  block?: (attempt: NetAttempt) => boolean;
}

/** 허용 대상 IP (수용 기준의 문장 그대로 127.0.0.1만). */
export const ALLOWED_HOST = '127.0.0.1';

/** 외부 연결 시도인지: 로컬 소켓 경로와 127.0.0.1이 아니면 모두 외부다. */
export const isExternalAttempt = (attempt: NetAttempt): boolean => {
  if (attempt.kind === 'dns') return attempt.hostname !== ALLOWED_HOST;
  if ('path' in attempt) return false;
  return attempt.host !== ALLOWED_HOST;
};

/** 기록 파일(JSON 한 줄씩)을 읽는다. 없으면 빈 목록. */
export const readNetWatchLog = (file: string): NetWatchRecord[] => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NetWatchRecord);
};

/** 기록 파일에 한 줄씩 붙이는 기록기 (동기 쓰기: 프로세스가 곧바로 끝나도 남는다). */
export const appendNetWatchLog =
  (file: string) =>
  (record: NetWatchRecord): void => {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  };

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toPort = (value: unknown): number | null => {
  const port = typeof value === 'string' ? Number(value) : value;
  return typeof port === 'number' && Number.isInteger(port) ? port : null;
};

/**
 * `Socket.prototype.connect` 인자 → 연결 대상. 모양: `(options[, cb])` · `(path[, cb])` · `(port[, host][, cb])`,
 * `net.connect`가 넘기는 정규화된 배열 `[options, cb]`. 호스트를 주지 않은 TCP 연결은 Node 기본값 `localhost`다.
 */
const connectTarget = (
  args: readonly unknown[],
): { path: string } | { host: string; port: number | null } => {
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (isRecord(first)) {
    if (typeof first.path === 'string' && first.path.length > 0) return { path: first.path };
    const host = typeof first.host === 'string' && first.host.length > 0 ? first.host : 'localhost';
    return { host, port: toPort(first.port) };
  }
  if (typeof first === 'string' && toPort(first) === null) return { path: first };
  const host = typeof args[1] === 'string' && args[1].length > 0 ? args[1] : 'localhost';
  return { host, port: toPort(first) };
};

const DNS_METHOD = /^(lookup|lookupService|resolve[A-Za-z0-9]*|reverse)$/;

/**
 * 이 프로세스에 감시를 건다. 돌려준 함수를 부르면 원래 함수로 되돌린다.
 * ESM 명명 가져오기(`import { lookup } from 'node:dns'`)에도 보이도록 `syncBuiltinESMExports`를 부른다.
 */
export const installNetWatch = (options: NetWatchOptions): (() => void) => {
  const restores: (() => void)[] = [];
  const now = () => new Date().toISOString();
  const report = (attempt: NetAttempt): void => {
    options.onRecord(attempt);
    if (options.block?.(attempt) === true) {
      throw new NetWatchBlocked(`감시가 막은 연결 시도: ${JSON.stringify(attempt)}`);
    }
  };
  const patch = (
    target: Record<string, unknown>,
    name: string,
    record: (args: unknown[]) => NetAttempt | null,
  ): void => {
    const original = target[name];
    if (typeof original !== 'function') return;
    const own = Object.hasOwn(target, name);
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const attempt = record(args);
      if (attempt !== null) report(attempt);
      return (original as AnyFn).apply(this, args);
    };
    // `util.promisify.custom` 같은 함수 속성(예: dns.lookup)을 그대로 옮긴다
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue;
      const descriptor = Object.getOwnPropertyDescriptor(original, key);
      if (descriptor !== undefined) Object.defineProperty(wrapped, key, descriptor);
    }
    target[name] = wrapped;
    restores.push(() => {
      if (own) target[name] = original;
      else delete target[name];
    });
  };

  patch(net.Socket.prototype as unknown as Record<string, unknown>, 'connect', (args) => ({
    kind: 'net',
    pid: process.pid,
    at: now(),
    ...connectTarget(args),
  }));

  const dnsTargets: [Record<string, unknown>, string][] = [
    [dns as unknown as Record<string, unknown>, 'dns'],
    [dns.promises as unknown as Record<string, unknown>, 'dns.promises'],
    [dns.Resolver.prototype as unknown as Record<string, unknown>, 'dns.Resolver'],
    [
      dns.promises.Resolver.prototype as unknown as Record<string, unknown>,
      'dns.promises.Resolver',
    ],
  ];
  for (const [target, label] of dnsTargets) {
    const names = new Set<string>();
    for (let proto: object | null = target; proto !== null && proto !== Object.prototype;) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (DNS_METHOD.test(name)) names.add(name);
      }
      // 모듈 객체는 자기 속성만, Resolver 원형은 상위 원형(공통 resolve 메서드)까지 본다
      proto = target === dns || target === dns.promises ? null : Object.getPrototypeOf(proto);
    }
    for (const name of names) {
      patch(target, name, (args) => ({
        kind: 'dns',
        pid: process.pid,
        at: now(),
        api: `${label}.${name}`,
        hostname: typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]),
      }));
    }
  }
  syncBuiltinESMExports();
  options.onRecord({ kind: 'installed', pid: process.pid, at: now() });
  return () => {
    for (const restore of restores.splice(0).reverse()) restore();
    syncBuiltinESMExports();
  };
};
