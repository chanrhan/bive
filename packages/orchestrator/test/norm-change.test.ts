// 규범 변경 기록 조회 `normChange.list`의 표시 값 (M7-02 #214, NRM-07 · ADR-089 · ADR-103).
// 사유 · 상세는 에이전트가 쓴 글이라 응답에서는 숨은 글자 표기 · 길이 상한을 거친 표시 값이고, 저장은 원문 그대로다.
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소. 숨은 글자는 이 파일에 실제 글자로 두지 않고 코드 포인트로 만든다.
import {
  createUlidGenerator,
  NORM_CHANGE_TEXT_DISPLAY_MAX,
  type NormChangeEntry,
} from '@bive/shared';
import { computeNormChangeHash } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import type { TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
let h: ProjectHarness;

beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

const BEL = String.fromCodePoint(0x07);
const CR = String.fromCodePoint(0x0d);
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
/** 상한(4000)을 넘는 문자열 */
const LONG = 'a'.repeat(NORM_CHANGE_TEXT_DISPLAY_MAX + 1000);

const REASON = `근거${BEL}숨은${CR}줄${RLO}뒤집기${LRI}격리`;
const DEEP = `깊은 곳${RLO}의 글`;

const appendForged = (): NormChangeEntry =>
  h.read((store) =>
    store.normChanges.append({
      at: iso(T0),
      kind: 'created',
      actor: { kind: 'agent', role: 'rule-writer' },
      targetRef: { entity: 'Rule', id: newId() },
      sessionId: newId(),
      runId: null,
      reason: REASON,
      detail: {
        after: {
          title: `제목${CR}가짜 줄`,
          statement: LONG,
          nested: { deep: [{ x: '그대로' }, { x: DEEP }] },
          count: 2,
        },
      },
    }),
  );

describe('normChange.list 표시 값 (ADR-089)', () => {
  it('사유 · 중첩 상세의 숨은 글자는 표기로, 상한을 넘는 문자열은 잘려 나오고 textTruncated가 켜지며, 저장 원문 · 해시는 그대로다', async () => {
    const stored = appendForged();
    const { entries, chain } = await h.client.call('normChange.list', {
      projectId: h.project.id,
    });
    expect(chain).toEqual({ valid: true, brokenAtSeq: null, reason: null });
    expect(entries).toHaveLength(1);
    const [view] = entries;
    if (view === undefined) throw new Error('항목 없음');

    // ⓐ 숨은 글자는 표기로, 원래 글자는 응답 어디에도 없다
    expect(view.reason).toBe('근거\\u0007숨은\\r줄\\u202e뒤집기\\u2066격리');
    const after = view.detail.after as {
      title: string;
      statement: string;
      nested: { deep: { x: string }[] };
      count: number;
    };
    expect(after.title).toBe('제목\\r가짜 줄');
    expect(after.nested.deep[0]?.x).toBe('그대로');
    expect(after.nested.deep[1]?.x).toBe('깊은 곳\\u202e의 글');
    expect(after.count).toBe(2);
    const body = JSON.stringify(view);
    for (const hidden of [BEL, CR, RLO, LRI]) expect(body.includes(hidden)).toBe(false);
    // 상한: 4000자에서 잘리고 끝에 말줄임, 잘렸다는 표시
    expect(after.statement).toHaveLength(NORM_CHANGE_TEXT_DISPLAY_MAX);
    expect(after.statement.endsWith('…')).toBe(true);
    expect(view.textTruncated).toBe(true);

    // ⓑ 저장은 원문 그대로
    const [raw] = h.read((store) => store.normChanges.list());
    expect(raw).toEqual(stored);
    expect(raw?.reason).toBe(REASON);
    expect((raw?.detail.after as { statement: string }).statement).toBe(LONG);

    // ⓒ 응답의 해시는 저장 원문 기준 해시와 같다 (표시 값으로 다시 계산한 해시가 아니다)
    expect(view.hash).toBe(stored.hash);
    expect(view.hash).toBe(computeNormChangeHash(stored));
    expect(view.prevHash).toBe(stored.prevHash);
  });

  it('숨은 글자 · 상한 초과가 없는 항목은 그대로 나오고 textTruncated는 꺼져 있다 (대조군)', async () => {
    const stored = h.read((store) =>
      store.normChanges.append({
        at: iso(T0),
        kind: 'created',
        actor: { kind: 'agent', role: 'rule-writer' },
        targetRef: { entity: 'Rule', id: newId() },
        sessionId: newId(),
        runId: null,
        reason: "요구사항의 '서버 시각 포함'",
        detail: { after: { title: '헬스 체크 응답의 서버 시각' } },
      }),
    );
    const { entries } = await h.client.call('normChange.list', {
      projectId: h.project.id,
      targetRef: stored.targetRef,
    });
    expect(entries).toEqual([
      {
        seq: stored.seq,
        at: stored.at,
        kind: 'created',
        actor: stored.actor,
        targetRef: stored.targetRef,
        sessionId: stored.sessionId,
        runId: null,
        reason: stored.reason,
        detail: stored.detail,
        textTruncated: false,
        prevHash: stored.prevHash,
        hash: stored.hash,
      },
    ]);
  });

  it('ⓓ 없는 프로젝트는 -32004', async () => {
    await expect(h.client.call('normChange.list', { projectId: newId() })).rejects.toMatchObject({
      code: -32004,
    });
  });
});

describe('판단 기록 (종류 judgment, M7-07 #219, ADR-106)', () => {
  const judgmentDetail = (overrides: Record<string, unknown> = {}) => ({
    judgment: {
      subject: 'new_rule',
      verdict: 'contradiction',
      contradicts: [{ id: newId(), displayId: 'RULE-001' }],
      createdSeq: 1,
      input: { requirements: { total: 2, included: 2 }, rules: { total: 1, included: 1 } },
      ...overrides,
    },
  });
  const appendJudgment = (detail: unknown, reason = `근거${RLO}뒤집기`) =>
    h.read((store) =>
      store.normChanges.append({
        at: iso(T0),
        kind: 'judgment',
        actor: { kind: 'agent', role: 'rule-writer' },
        targetRef: { entity: 'Rule', id: newId() },
        sessionId: newId(),
        runId: null,
        reason,
        detail: detail as NormChangeEntry['detail'],
      }),
    );

  it('판단 상세는 결과 · 대상 규칙 · 신규 기록 순번 · 받은 입력 수를 담고, 근거(사유)는 응답에서 표시 값이다', async () => {
    const stored = appendJudgment(judgmentDetail());
    const { entries, chain } = await h.client.call('normChange.list', {
      projectId: h.project.id,
    });
    expect(chain.valid).toBe(true);
    expect(entries[0]?.detail).toEqual(stored.detail);
    expect(entries[0]?.reason).toBe('근거\\u202e뒤집기');
    expect(entries[0]?.textTruncated).toBe(false);
  });

  it('어긋난 판단 상세(모순인데 대상 없음 · 모순 없음인데 대상 · 대상 중복 · 신규 순번 없음 · 입력 수 모순 · 이전 내용 섞임 · 상세 없음)는 저장되지 않는다', () => {
    const dup = { id: newId(), displayId: 'RULE-001' };
    for (const detail of [
      judgmentDetail({ contradicts: [] }),
      judgmentDetail({ verdict: 'no_contradiction' }),
      judgmentDetail({ contradicts: [dup, dup] }),
      judgmentDetail({ createdSeq: undefined }),
      judgmentDetail({
        input: { requirements: { total: 1, included: 2 }, rules: { total: 0, included: 0 } },
      }),
      { ...judgmentDetail(), before: { title: '옛 제목' } },
      {},
    ]) {
      expect(() => appendJudgment(detail), JSON.stringify(detail)).toThrow();
    }
    // 판단 상세는 판단 기록에만 둔다
    expect(() =>
      h.read((store) =>
        store.normChanges.append({
          at: iso(T0),
          kind: 'created',
          actor: { kind: 'agent', role: 'rule-writer' },
          targetRef: { entity: 'Rule', id: newId() },
          sessionId: newId(),
          runId: null,
          reason: '근거',
          detail: { after: { title: '제목' }, ...judgmentDetail() } as NormChangeEntry['detail'],
        }),
      ),
    ).toThrow();
    expect(h.read((store) => store.normChanges.list())).toEqual([]);
  });
});
