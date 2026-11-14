// 코드 열람 기록 RPC (M2-01 수용 기준 2, MET-01 · ADR-084).
// - `codeOpen.record`가 시각(오케스트레이터 시계) · 출발 화면 · 항목 · 사유 · 파일 · 줄을 저장하고 `codeOpen.list`가 돌려준다
// - 사람 주체만 받는다(에이전트 -32020). 파일은 프로젝트 루트 기준 상대 경로만(절대 경로 · `..` · 제어 문자 등 -32602)
// - 목록은 최신부터, 상한을 넘으면 `truncated`
// - `codeOpen.summary`는 전체 기록을 사유별로 센다(고정 순서, 0건 포함, 목록 상한과 무관) (M2-02 수용 기준 3, ADR-088)
// 에이전트 경로(역할 세션 도구 · 인증 전 연결)의 쓰기 불가는 proposal-guard.test.ts가 단언한다.
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import {
  type Author,
  CODE_OPEN_LIST_LIMIT,
  type CodeOpenRecordParams,
  createUlidGenerator,
  ErrorCode,
} from '@bive/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { RpcCallError, type TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

let h: ProjectHarness;
beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
});

const RULE_ID = createUlidGenerator()();

/** 규칙 상세(SCR-03)의 실패 케이스 링크에서 "디버깅"으로 연 요청 (로드맵 2.2 흐름 1). */
const debugging = (): CodeOpenRecordParams => ({
  projectId: h.project.id,
  author: human,
  reason: 'debugging',
  sourceScreen: 'SCR-03',
  itemRef: { entity: 'Rule', id: RULE_ID },
  file: 'bive-acceptance/RULE-001/health-time.acc.ts',
  line: 18,
});

const rpcError = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcCallError);
  return error as RpcCallError;
};

const storedCount = (): number => h.read((store) => store.codeOpens.listLatest(1_000).length);

describe('codeOpen.record · codeOpen.list (수용 기준 2)', () => {
  it('record가 시각 · 출발 화면 · 항목 · 사유 · 파일 · 줄을 저장하고 list가 그대로 돌려준다', async () => {
    h.clock.now = T0 + 1234;
    const { record } = await h.client.call('codeOpen.record', debugging());
    expect(record).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as unknown,
      at: iso(T0 + 1234),
      reason: 'debugging',
      sourceScreen: 'SCR-03',
      itemRef: { entity: 'Rule', id: RULE_ID },
      file: 'bive-acceptance/RULE-001/health-time.acc.ts',
      line: 18,
    });
    // 저장소에 그대로 남았다 (응답만이 아니라)
    expect(h.read((store) => store.codeOpens.listLatest(10))).toEqual([record]);

    const listed = await h.client.call('codeOpen.list', { projectId: h.project.id });
    expect(listed).toEqual({ records: [record], truncated: false });
  });

  it('기록이 없으면 빈 목록', async () => {
    await expect(h.client.call('codeOpen.list', { projectId: h.project.id })).resolves.toEqual({
      records: [],
      truncated: false,
    });
  });

  it('list는 최신부터: 시각이 늦은 것이 먼저, 같은 시각이면 나중에 남긴 것이 먼저', async () => {
    h.clock.now = T0;
    const first = await h.client.call('codeOpen.record', debugging());
    h.clock.now = T0 + 60_000;
    const second = await h.client.call('codeOpen.record', {
      ...debugging(),
      reason: 'screen_error',
      sourceScreen: 'SCR-02',
      line: 3,
    });
    const third = await h.client.call('codeOpen.record', {
      ...debugging(),
      reason: 'info_lacking',
    });
    const { records } = await h.client.call('codeOpen.list', { projectId: h.project.id });
    expect(records.map((r) => r.id)).toEqual([third.record.id, second.record.id, first.record.id]);
    expect(records.map((r) => r.reason)).toEqual(['info_lacking', 'screen_error', 'debugging']);
  });

  it(`상한(${String(CODE_OPEN_LIST_LIMIT)}건)을 넘으면 최신부터 상한만큼과 truncated: true`, async () => {
    const newId = createUlidGenerator();
    h.read((store) => {
      for (let i = 0; i <= CODE_OPEN_LIST_LIMIT; i += 1) {
        store.codeOpens.record({
          id: newId(),
          at: iso(T0 + i),
          reason: 'debugging',
          sourceScreen: 'SCR-03',
          itemRef: { entity: 'Rule', id: RULE_ID },
          file: 'src/app.ts',
          line: i + 1,
        });
      }
    });
    const { records, truncated } = await h.client.call('codeOpen.list', {
      projectId: h.project.id,
    });
    expect(truncated).toBe(true);
    expect(records).toHaveLength(CODE_OPEN_LIST_LIMIT);
    // 가장 오래된 1건(줄 1)이 빠지고 가장 최근 것(줄 501)이 맨 앞
    expect(records[0]?.line).toBe(CODE_OPEN_LIST_LIMIT + 1);
    expect(records.at(-1)?.line).toBe(2);
  });

  it('에이전트 주체의 record는 -32020이고 아무것도 남지 않는다', async () => {
    for (const role of ['implementer', 'chat'] as const) {
      const error = await rpcError(
        h.client.call('codeOpen.record', { ...debugging(), author: { kind: 'agent', role } }),
      );
      expect(error.code, role).toBe(ErrorCode.Unauthorized);
    }
    expect(storedCount()).toBe(0);
  });

  it('등록되지 않은 프로젝트는 record · list 모두 -32004', async () => {
    const other = createUlidGenerator()();
    expect(
      (await rpcError(h.client.call('codeOpen.record', { ...debugging(), projectId: other }))).code,
    ).toBe(ErrorCode.NotFound);
    expect((await rpcError(h.client.call('codeOpen.list', { projectId: other }))).code).toBe(
      ErrorCode.NotFound,
    );
  });
});

describe('파일 경로 · 줄 · 화면 · 사유 검증: 프로젝트 루트 밖이나 형식이 틀린 값은 기록하지 않는다 (ADR-084)', () => {
  const rawRecord = (patch: Record<string, unknown>) =>
    h.client.requestRaw({
      jsonrpc: '2.0',
      id: 'bad',
      method: 'codeOpen.record',
      params: { ...debugging(), ...patch },
    });

  it.each([
    ['절대 경로', { file: '/etc/passwd' }],
    ['Windows 절대 경로', { file: 'C:\\Users\\me\\a.ts' }],
    ['드라이브 상대 경로', { file: 'C:a.ts' }],
    ['UNC 경로', { file: '\\\\server\\share\\a.ts' }],
    ['상위 폴더', { file: '../outside.ts' }],
    ['중간 상위 폴더', { file: 'src/../../outside.ts' }],
    ['현재 폴더 조각', { file: './src/a.ts' }],
    ['빈 조각', { file: 'src//a.ts' }],
    ['끝 슬래시', { file: 'src/' }],
    ['역슬래시', { file: 'src\\a.ts' }],
    ['콜론', { file: 'src/a.ts:18' }],
    ['NUL', { file: 'src/a\u0000.ts' }],
    ['줄바꿈', { file: 'src/a\n.ts' }],
    ['DEL', { file: 'src/a\u007f.ts' }],
    ['C1 제어 문자', { file: 'src/a\u0085.ts' }],
    ['빈 경로', { file: '' }],
    ['너무 긴 경로', { file: `${'a/'.repeat(600)}b.ts` }],
    ['줄 0', { line: 0 }],
    ['음수 줄', { line: -1 }],
    ['소수 줄', { line: 1.5 }],
    ['문자열 줄', { line: '18' }],
    ['화면 ID 아님', { sourceScreen: 'rules' }],
    ['없는 화면 번호', { sourceScreen: 'SCR-22' }],
    ['모르는 사유', { reason: 'curiosity' }],
    ['URL을 직접 넘김', { url: 'https://example.com' }],
    ['시각을 직접 넘김', { at: '2020-01-01T00:00:00.000Z' }],
  ])('%s → -32602, 기록 없음', async (_label, patch) => {
    const response = await rawRecord(patch);
    expect(response).toMatchObject({ id: 'bad', error: { code: ErrorCode.InvalidParams } });
    expect(storedCount()).toBe(0);
  });

  it('대조군: 한글 · 공백 · 점이 든 상대 경로는 받는다', async () => {
    const { record } = await h.client.call('codeOpen.record', {
      ...debugging(),
      file: 'src/화면 목록/.config/a.b.ts',
    });
    expect(record.file).toBe('src/화면 목록/.config/a.b.ts');
    expect(storedCount()).toBe(1);
  });
});

describe('codeOpen.summary: 사유별 건수 (M2-02 수용 기준 3, ADR-088)', () => {
  const summary = () => h.client.call('codeOpen.summary', { projectId: h.project.id });

  it('기록이 없으면 사유 3종 모두 0이고 합계 0', async () => {
    await expect(summary()).resolves.toEqual({
      reasons: [
        { reason: 'screen_error', count: 0 },
        { reason: 'info_lacking', count: 0 },
        { reason: 'debugging', count: 0 },
      ],
      total: 0,
    });
  });

  it('"디버깅"으로 1번 열면 디버깅 1 · 나머지 0 (로드맵 2.2 흐름 2)', async () => {
    await h.client.call('codeOpen.record', debugging());
    await expect(summary()).resolves.toEqual({
      reasons: [
        { reason: 'screen_error', count: 0 },
        { reason: 'info_lacking', count: 0 },
        { reason: 'debugging', count: 1 },
      ],
      total: 1,
    });
  });

  it('record로 남긴 기록을 사유별로 센다: 순서는 기록 순서와 무관하게 화면 오류 · 정보 부족 · 디버깅', async () => {
    for (const reason of [
      'debugging',
      'info_lacking',
      'debugging',
      'screen_error',
      'debugging',
      'info_lacking',
    ] as const) {
      await h.client.call('codeOpen.record', { ...debugging(), reason });
    }
    await expect(summary()).resolves.toEqual({
      reasons: [
        { reason: 'screen_error', count: 1 },
        { reason: 'info_lacking', count: 2 },
        { reason: 'debugging', count: 3 },
      ],
      total: 6,
    });
  });

  it(`목록 상한(${String(CODE_OPEN_LIST_LIMIT)}건)을 넘어도 전체를 센다`, async () => {
    const newId = createUlidGenerator();
    const reasons = ['screen_error', 'info_lacking', 'debugging'] as const;
    const n = CODE_OPEN_LIST_LIMIT + 10;
    h.read((store) => {
      for (let i = 0; i < n; i += 1) {
        store.codeOpens.record({
          id: newId(),
          at: iso(T0 + i),
          reason: reasons[i % 3] ?? 'debugging',
          sourceScreen: 'SCR-03',
          itemRef: { entity: 'Rule', id: RULE_ID },
          file: 'src/app.ts',
          line: i + 1,
        });
      }
    });
    const { reasons: counts, total } = await summary();
    expect(total).toBe(n);
    // 510 = 170 × 3
    expect(counts).toEqual([
      { reason: 'screen_error', count: n / 3 },
      { reason: 'info_lacking', count: n / 3 },
      { reason: 'debugging', count: n / 3 },
    ]);
    // 목록은 상한에서 잘린다
    expect((await h.client.call('codeOpen.list', { projectId: h.project.id })).truncated).toBe(
      true,
    );
  });

  it('프로젝트마다 따로 센다: 다른 프로젝트 기록은 들어가지 않고, 등록되지 않은 프로젝트는 -32004', async () => {
    await h.client.call('codeOpen.record', debugging());
    expect(
      (await rpcError(h.client.call('codeOpen.summary', { projectId: createUlidGenerator()() })))
        .code,
    ).toBe(ErrorCode.NotFound);
    expect((await summary()).total).toBe(1);
  });

  it('조회 전용: 부른 뒤에도 기록 수가 그대로다', async () => {
    await h.client.call('codeOpen.record', debugging());
    await summary();
    await summary();
    expect(storedCount()).toBe(1);
  });

  it('파라미터는 엄격 객체: projectId가 없거나 다른 키가 있으면 -32602', async () => {
    for (const params of [{}, { projectId: h.project.id, reason: 'debugging' }]) {
      const response = await h.client.requestRaw({
        jsonrpc: '2.0',
        id: 'sum',
        method: 'codeOpen.summary',
        params,
      });
      expect(response).toMatchObject({ id: 'sum', error: { code: ErrorCode.InvalidParams } });
    }
  });
});
