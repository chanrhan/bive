// 판정 서버 앞의 기록 프록시 (M3-47 #292, ADR-132 ④). 판정 러너의 프록시 자리(`JudgeServerProxy`)에 끼운다.
// 인수 테스트(vitest)의 요청을 판정 서버로 그대로 넘기고 응답을 그대로 돌려주면서, 요청 · 응답을 메모리에 기록한다. 계약 검사는 판정이
// 끝난 뒤 이 기록을 `@stoplight/prism-cli proxy --errors`로 검증한다(`prism.ts`).
// 왜 prism을 판정 서버 앞에 바로 두지 않는가(실측, prism 5.14.2): prism은 계약에 없는 경로 · 메서드를 판정 서버로 넘기지 않고
// 404 · 405를 돌려주며, `--errors`면 계약과 다른 응답을 500으로 바꾼다. 바로 두면 계약 밖 경로를 쓰는 다른 규칙의 인수 테스트 결과가
// 바뀐다. 기록 프록시는 요청 · 응답 바이트를 바꾸지 않는다(판정 서버가 보는 요청 · 테스트가 받는 응답이 그대로다).
// - 127.0.0.1의 임의 빈 포트, 판정이 끝나면 닫는다(열린 연결도 끊는다)
// - 기록 상한: 교환 수 · 본문 크기. 넘은 교환은 그대로 넘기되 "기록 불완전"으로 남는다(그 교환은 검증하지 못한 것이다)
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** 기록하는 교환 수 상한. */
export const MAX_RECORDED_EXCHANGES = 2_000;

/** 교환 하나의 요청 · 응답 본문 기록 상한 (바이트). */
export const MAX_RECORDED_BODY_BYTES = 4 * 1024 * 1024;

/** 기록된 요청 · 응답 한 쌍. */
export interface RecordedExchange {
  readonly index: number;
  readonly method: string;
  /** 요청 대상 (경로 + 질의, 받은 글자 그대로) */
  readonly target: string;
  /** 요청 머리 (원래 순서의 이름 · 값 쌍) */
  readonly requestHeaders: readonly (readonly [string, string])[];
  readonly requestBody: Buffer;
  /** 응답 상태 (판정 서버에 닿지 못했으면 `null`) */
  readonly status: number | null;
  readonly responseHeaders: readonly (readonly [string, string])[];
  readonly responseBody: Buffer;
  /** 요청 · 응답을 끝까지 기록했는지 (본문 상한 초과 · 연결 끊김 · 판정 서버 오류면 거짓) */
  readonly complete: boolean;
}

export interface StartedRecorder {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

const pairs = (raw: readonly string[]): [string, string][] => {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
};

/** 판정 서버 앞의 기록 프록시. 한 판정에 하나. */
export class ExchangeRecorder {
  readonly #exchanges: RecordedExchange[] = [];
  readonly #maxExchanges: number;
  readonly #maxBodyBytes: number;
  #overflow = 0;
  #started = false;

  /** 상한은 시험용 주입 (기본 {@link MAX_RECORDED_EXCHANGES} · {@link MAX_RECORDED_BODY_BYTES}). */
  constructor(limits: { readonly maxExchanges?: number; readonly maxBodyBytes?: number } = {}) {
    this.#maxExchanges = limits.maxExchanges ?? MAX_RECORDED_EXCHANGES;
    this.#maxBodyBytes = limits.maxBodyBytes ?? MAX_RECORDED_BODY_BYTES;
  }

  /** 기록된 교환 (도착 순). */
  exchanges(): readonly RecordedExchange[] {
    return this.#exchanges;
  }

  /** 교환 수 상한을 넘어 기록하지 못한 교환 수. */
  overflow(): number {
    return this.#overflow;
  }

  /** 판정 서버(`upstreamBaseUrl`) 앞에서 듣기 시작한다. 한 번만 부를 수 있다. */
  async start(input: { readonly upstreamBaseUrl: string }): Promise<StartedRecorder> {
    if (this.#started) throw new Error('기록 프록시는 한 번만 띄웁니다');
    this.#started = true;
    const upstream = new URL(input.upstreamBaseUrl);
    if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1') {
      throw new Error('판정 서버 주소가 127.0.0.1의 http가 아닙니다');
    }
    const server = http.createServer((req, res) => {
      const index = this.#exchanges.length + this.#overflow;
      const record = this.#exchanges.length < this.#maxExchanges;
      if (!record) this.#overflow += 1;
      const requestChunks: Buffer[] = [];
      const responseChunks: Buffer[] = [];
      let requestBytes = 0;
      let responseBytes = 0;
      let complete = true;
      let status: number | null = null;
      let responseHeaders: [string, string][] = [];
      const requestHeaders = pairs(req.rawHeaders);
      let saved = false;
      const save = (): void => {
        if (!record || saved) return;
        saved = true;
        this.#exchanges.push({
          index,
          method: req.method ?? 'GET',
          target: req.url ?? '/',
          requestHeaders,
          requestBody: Buffer.concat(requestChunks),
          status,
          responseHeaders,
          responseBody: Buffer.concat(responseChunks),
          complete,
        });
      };
      const forward = http.request({
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: req.rawHeaders as unknown as http.OutgoingHttpHeaders,
      });
      forward.on('response', (upRes) => {
        status = upRes.statusCode ?? null;
        responseHeaders = pairs(upRes.rawHeaders);
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, upRes.rawHeaders);
        upRes.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > this.#maxBodyBytes) complete = false;
          else responseChunks.push(chunk);
          res.write(chunk);
        });
        upRes.on('end', () => {
          save();
          res.end();
        });
        upRes.on('error', () => {
          complete = false;
          save();
          res.destroy();
        });
      });
      forward.on('error', () => {
        complete = false;
        status = null;
        save();
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('판정 서버에 닿지 못함');
        } else {
          res.destroy();
        }
      });
      req.on('data', (chunk: Buffer) => {
        requestBytes += chunk.length;
        if (requestBytes > this.#maxBodyBytes) complete = false;
        else requestChunks.push(chunk);
        forward.write(chunk);
      });
      req.on('end', () => forward.end());
      req.on('error', () => {
        complete = false;
        forward.destroy();
      });
      res.on('close', () => {
        if (!res.writableFinished) {
          complete = false;
          forward.destroy();
          save();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${String(port)}`,
      stop: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }
}
