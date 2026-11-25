// 구현 응답의 계약 일치: `@stoplight/prism-cli proxy --errors` (ADR-033, M3-47 #292 · ADR-132 ④).
// 판정이 끝난 뒤 기록 프록시(`recorder.ts`)가 남긴 교환을 prism에 다시 보낸다. prism의 상류는 BIVE의 재생 서버로, 기록된 응답을 그대로
// 돌려준다(판정 서버는 이미 멈췄다: 구현 코드가 다시 돌지 않는다). prism은 그 응답을 계약과 대조한다.
// - prism: 작업 폴더 = 빈 도구 폴더, 문서 = 계약 사본, `-h 127.0.0.1 -p 0`(임의 빈 포트, 기동 줄에서 읽는다), `--errors`,
//   `--validate-request=false`(인수 테스트가 일부러 틀린 요청을 보낼 수 있다: 요청은 판정하지 않는다), `--cors=false`, `--multiprocess=false`.
//   환경 변수는 고정 값만(`tool.ts`), 끝나면(실패 · 중단 포함) 프로세스 그룹과 재생 서버를 반드시 정리한다
// - 교환 하나의 판정: 재생 서버가 그 교환을 받았는지(prism이 상류로 넘겼는지)를 재생 서버 쪽에서 센다(구현 응답이 prism 오류 모양을
//   흉내 내도 속지 않는다)
//   - 넘겼고 응답 쪽 위반(심각도 오류 · 경고: 경고는 계약에 없는 상태 코드라 본문을 대조하지 않은 것)이 있으면 위반
//   - 넘겼고 위반이 없고 prism이 돌려준 상태가 기록된 상태와 같으면 통과
//   - 넘기지 않았고 prism 응답이 "계약에 없는 경로 · 메서드"(404 `NO_PATH_MATCHED_ERROR` · 405 `NO_METHOD_MATCHED_ERROR`)면 계약 밖
//   - 그 밖(넘겼는데 상태가 다름, 보안 요구 401, 본문 있는 GET 등 prism 오류, 기록 불완전)은 검증하지 못함. 검증하지 못한 교환은
//     계약 판정에서 실패다(`steps/contract-check.ts`: 판정받는 구현이 응답 모양으로 만들 수 있는 사유라 닫힌 쪽)
import { type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { stopProcess } from '../judge/process.js';
import type { RecordedExchange } from './recorder.js';
import { ContractToolError, PRISM_ENTRY, spawnTool, toolEnv } from './tool.js';

/** prism 기동 제한 시간. 실측: 약 1.3초. */
export const PRISM_START_TIMEOUT_MS = 30_000;

/** 검증 전체 제한 시간 (기본). */
export const DEFAULT_PRISM_TIMEOUT_MS = 120_000;

/** 기동 줄을 찾으려고 모으는 출력 상한. 찾은 뒤의 출력은 버린다. */
const MAX_START_OUTPUT_BYTES = 64 * 1024;

/** prism 응답 하나에서 읽는 본문 상한. */
const MAX_PRISM_RESPONSE_BYTES = 1024 * 1024;

/** 재생 서버가 교환을 가리는 요청 머리 (BIVE가 붙인다: 테스트가 보낸 같은 이름은 지운다). */
export const EXCHANGE_HEADER = 'x-bive-exchange';

const LISTENING = /Prism is listening on (http:\/\/127\.0\.0\.1:(\d+))(?=\s|$)/u;

/** 다시 보내지 않는 요청 머리 (연결 · 길이는 다시 정한다). */
const REQUEST_DROP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'expect',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  EXCHANGE_HEADER,
]);

/** 재생 서버가 돌려주지 않는 응답 머리 (prism이 붙이는 위반 머리는 기록된 응답에서 지운다: 구현이 흉내 내지 못하게). */
const RESPONSE_DROP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'sl-violations',
]);

/** prism의 "계약에 없는 경로 · 메서드" 오류 종류. */
const OUTSIDE_TYPES = [
  'https://stoplight.io/prism/errors#NO_PATH_MATCHED_ERROR',
  'https://stoplight.io/prism/errors#NO_METHOD_MATCHED_ERROR',
];
const VIOLATIONS_TYPE = 'https://stoplight.io/prism/errors#VIOLATIONS';

/** 응답 쪽 위반 한 건. */
export interface PrismViolation {
  /** `response.body.ok` 같은 위치 */
  readonly location: string;
  readonly severity: string;
  readonly message: string;
}

export interface ExchangeVerdict {
  readonly index: number;
  readonly method: string;
  readonly target: string;
  readonly outcome: 'ok' | 'violation' | 'outside' | 'unverified';
  /** 위반 (outcome `violation`일 때) */
  readonly violations: readonly PrismViolation[];
  /** prism이 위반 머리를 잘랐다 (`Too many violations!`) */
  readonly truncated: boolean;
  /**
   * 검증하지 못한 까닭 (outcome `unverified`일 때): `status_differs` prism이 넘겼는데 돌려준 상태가 기록과 다름(prism이 응답을 다루지
   * 못함), `not_forwarded` prism이 넘기지 않았고 계약 밖 오류도 아님, `incomplete` 기록이 불완전해 보내지 않음
   */
  readonly unverified?: 'status_differs' | 'not_forwarded' | 'incomplete';
}

export interface PrismResult {
  readonly exchanges: readonly ExchangeVerdict[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `sl-violations` 머리 · 오류 본문의 위반 목록 → 응답 쪽 위반 (심각도 오류 · 경고). 읽지 못하면 `null`. */
export const responseViolations = (value: unknown): PrismViolation[] | null => {
  if (!Array.isArray(value)) return null;
  const out: PrismViolation[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.location)) return null;
    const location = item.location.map(String);
    if (location[0] !== 'response') continue;
    const severity = String(item.severity);
    if (severity !== 'Error' && severity !== 'Warning') continue;
    out.push({ location: location.join('.'), severity, message: String(item.message ?? '') });
  }
  return out;
};

interface PrismResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** 기록된 교환 하나와 prism 응답 → 교환 판정. `served`는 재생 서버가 그 교환을 받았는지. */
export const classifyExchange = (
  exchange: RecordedExchange,
  served: boolean,
  response: PrismResponse,
): ExchangeVerdict => {
  const base = { index: exchange.index, method: exchange.method, target: exchange.target };
  const header = response.headers['sl-violations'];
  const headerText = Array.isArray(header) ? header.join(',') : header;
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = null;
  }
  if (served) {
    let violations: PrismViolation[] | null = [];
    let truncated = false;
    if (headerText !== undefined) {
      if (headerText.startsWith('Too many violations!')) {
        truncated = true;
        violations = [
          { location: 'response', severity: 'Error', message: '위반이 많아 prism이 목록을 잘랐다' },
        ];
      } else {
        try {
          violations = responseViolations(JSON.parse(headerText));
        } catch {
          violations = null;
        }
      }
    }
    // `--errors`의 오류 응답인데 머리에서 위반을 얻지 못했으면 본문의 위반 목록을 본다 (읽지 못하면 닫힌 쪽)
    if (
      isRecord(body) &&
      body.type === VIOLATIONS_TYPE &&
      violations !== null &&
      violations.length === 0
    ) {
      violations = responseViolations(body.validation);
    }
    // 위반 목록을 읽지 못하면 위반으로 본다 (닫힌 쪽)
    if (violations === null) {
      return {
        ...base,
        outcome: 'violation',
        violations: [{ location: 'response', severity: 'Error', message: '위반 목록을 읽지 못함' }],
        truncated,
      };
    }
    if (violations.length > 0) return { ...base, outcome: 'violation', violations, truncated };
    if (response.status === exchange.status) {
      return { ...base, outcome: 'ok', violations: [], truncated: false };
    }
    return {
      ...base,
      outcome: 'unverified',
      violations: [],
      truncated: false,
      unverified: 'status_differs',
    };
  }
  const problem = String(response.headers['content-type'] ?? '').startsWith(
    'application/problem+json',
  );
  if (problem && isRecord(body) && OUTSIDE_TYPES.includes(String(body.type))) {
    return { ...base, outcome: 'outside', violations: [], truncated: false };
  }
  return {
    ...base,
    outcome: 'unverified',
    violations: [],
    truncated: false,
    unverified: 'not_forwarded',
  };
};

/** 재생 서버: 기록된 응답을 그대로 돌려주고, 받은 교환 번호를 센다. */
const startReplayServer = async (
  exchanges: ReadonlyMap<number, RecordedExchange>,
  served: Set<number>,
): Promise<{ readonly url: string; close(): Promise<void> }> => {
  const server = http.createServer((req, res) => {
    // 요청 본문은 읽어 버린다 (prism이 보낸 사본, 판정에 쓰지 않는다)
    req.resume();
    const raw = req.headers[EXCHANGE_HEADER];
    const index = typeof raw === 'string' && /^\d{1,9}$/u.test(raw) ? Number(raw) : -1;
    const exchange = exchanges.get(index);
    if (exchange !== undefined) served.add(index);
    if (exchange === undefined || !exchange.complete || exchange.status === null) {
      // 기록이 불완전한 교환은 응답을 대조하지 않는다 (prism이 넘겼는지 = 계약 안인지만 센다)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('기록 없음');
      return;
    }
    const headers: [string, string][] = exchange.responseHeaders.filter(
      ([name]) => !RESPONSE_DROP.has(name.toLowerCase()),
    ) as [string, string][];
    res.writeHead(exchange.status, [
      ...headers.flat(),
      'content-length',
      String(exchange.responseBody.length),
    ]);
    res.end(exchange.responseBody);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

/** prism이 기동 줄을 낼 때까지 기다린다. 기동 전에 끝나거나 제한 시간을 넘으면 {@link ContractToolError}. */
const waitListening = (
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = '';
    let done = false;
    const finish = (error: Error | null, url?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.off('exit', onExit);
      if (error === null) resolve(url!);
      else reject(error);
    };
    const onData = (chunk: Buffer): void => {
      if (done) return;
      output += chunk.toString('utf8');
      const match = LISTENING.exec(output);
      if (match !== null) finish(null, match[1]);
      else if (output.length > MAX_START_OUTPUT_BYTES) {
        finish(new ContractToolError('start_failed', 'prism 기동 줄을 찾지 못했습니다'));
      }
    };
    const onExit = (): void =>
      finish(new ContractToolError('start_failed', 'prism이 기동 전에 끝났습니다'));
    const onAbort = (): void =>
      finish(signal.reason instanceof Error ? signal.reason : new Error('중단'));
    const timer = setTimeout(
      () => finish(new ContractToolError('timeout', 'prism이 제한 시간 안에 뜨지 않았습니다')),
      timeoutMs,
    );
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', () =>
      finish(new ContractToolError('spawn_failed', 'prism을 띄우지 못했습니다')),
    );
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** 교환 하나를 prism에 보낸다. */
const sendToPrism = (
  prismUrl: string,
  exchange: RecordedExchange,
  signal: AbortSignal,
): Promise<PrismResponse> =>
  new Promise((resolve, reject) => {
    const url = new URL(prismUrl);
    // 머리 배열을 주면 http가 Host를 붙이지 않는다: 직접 붙인다
    const headers: string[] = ['host', url.host];
    for (const [name, value] of exchange.requestHeaders) {
      if (!REQUEST_DROP.has(name.toLowerCase())) headers.push(name, value);
    }
    headers.push(EXCHANGE_HEADER, String(exchange.index));
    if (exchange.requestBody.length > 0) {
      headers.push('content-length', String(exchange.requestBody.length));
    }
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method: exchange.method,
      path: exchange.target,
      headers: headers as unknown as http.OutgoingHttpHeaders,
      signal,
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_PRISM_RESPONSE_BYTES) chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(exchange.requestBody.length > 0 ? exchange.requestBody : undefined);
  });

export interface PrismOptions {
  /** 빈 도구 폴더 (계약 사본이 있다) */
  readonly toolDir: string;
  readonly documentFile: string;
  readonly exchanges: readonly RecordedExchange[];
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  /** 도구 진입 파일 (시험용 주입, 기본 {@link PRISM_ENTRY}) */
  readonly entry?: string;
}

/** prism 인자: 프록시 · 127.0.0.1 임의 포트 · `--errors` · 요청 검증 끔 · CORS 머리 끔 · 한 프로세스. */
export const prismArgs = (documentFile: string, upstream: string): string[] => [
  'proxy',
  documentFile,
  upstream,
  '-h',
  '127.0.0.1',
  '-p',
  '0',
  '--errors',
  '--validate-request=false',
  '--cors=false',
  '--multiprocess=false',
];

/**
 * 기록된 교환을 prism으로 검증한다. 기록이 불완전한 교환은 요청만 보내 계약 밖인지 가리고, 계약 밖이 아니면 검증하지 못한 것으로 둔다. prism을 띄우지 못하거나 제한 시간을
 * 넘거나 교환을 보내지 못하면 {@link ContractToolError}, 중단이면 신호의 사유로 던진다. prism과 재생 서버는 어떤 경우에도 정리한다.
 */
export const validateWithPrism = async (options: PrismOptions): Promise<PrismResult> => {
  options.signal.throwIfAborted();
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PRISM_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline]);
  const complete = new Map(
    options.exchanges
      .filter((item) => item.complete && item.status !== null)
      .map((item) => [item.index, item]),
  );
  const all = new Map(options.exchanges.map((item) => [item.index, item]));
  const served = new Set<number>();
  const replay = await startReplayServer(all, served);
  let child: ChildProcess | undefined;
  try {
    child = spawnTool(options.entry ?? PRISM_ENTRY, prismArgs(options.documentFile, replay.url), {
      cwd: options.toolDir,
      env: toolEnv(options.toolDir),
    });
    child.stderr?.resume();
    let prismUrl: string;
    try {
      prismUrl = await waitListening(child, PRISM_START_TIMEOUT_MS, signal);
    } catch (error) {
      options.signal.throwIfAborted();
      if (deadline.aborted)
        throw new ContractToolError('timeout', 'prism 검증이 제한 시간을 넘었습니다');
      throw error;
    }
    // 기동 줄을 찾은 뒤의 출력은 읽어 버린다 (요청마다 기록이 나온다)
    child.stdout?.removeAllListeners('data');
    child.stdout?.resume();
    const verdicts: ExchangeVerdict[] = [];
    for (const exchange of options.exchanges) {
      let response: PrismResponse;
      try {
        // 기록이 불완전한 교환도 요청은 보낸다: prism이 계약 밖 경로 · 메서드로 돌려주면 계약 밖이고, 넘기면 검증하지 못한 것이다
        response = await sendToPrism(prismUrl, exchange, signal);
      } catch {
        options.signal.throwIfAborted();
        if (deadline.aborted)
          throw new ContractToolError('timeout', 'prism 검증이 제한 시간을 넘었습니다');
        throw new ContractToolError('replay_failed', 'prism에 교환을 보내지 못했습니다');
      }
      const verdict = classifyExchange(exchange, served.has(exchange.index), response);
      verdicts.push(
        complete.has(exchange.index) || verdict.outcome === 'outside'
          ? verdict
          : {
              ...verdict,
              outcome: 'unverified',
              violations: [],
              truncated: false,
              unverified: 'incomplete',
            },
      );
    }
    return { exchanges: verdicts };
  } finally {
    if (child !== undefined) await stopProcess(child, 1_000);
    await replay.close();
  }
};
