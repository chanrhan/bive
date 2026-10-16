// 승인 기록 리포지토리 · 해시 체인 (M1-09, NFR-01 · ADR-027 · ADR-050). 실제 SQLite 임시 저장소.
import { createHash } from 'node:crypto';

import { APPROVAL_LOG_GENESIS_HASH, type Author } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LOG_HASH_PREFIX,
  canonicalJson,
  computeApprovalLogHash,
  verifyApprovalLogChain,
} from '../src/approval-chain.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import type { ApprovalLogAppendInput } from '../src/repositories/approval-log-repository.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const human = { kind: 'human' } as const satisfies Author;

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const approve = (overrides: Partial<ApprovalLogAppendInput> = {}): ApprovalLogAppendInput => ({
  at: T0,
  action: 'approve',
  actor: human,
  targetRef: { entity: 'Proposal', id: newId() },
  clientId: 'pipe-1',
  detail: { appliedRef: { entity: 'Requirement', id: newId() } },
  ...overrides,
});

/** 체인을 일부러 깨기 위해 추가 전용 트리거를 잠시 지운다 (같은 사용자 권한의 다른 프로세스 흉내). */
const tamper = (store: ProjectStore, sql: string, ...args: unknown[]): void => {
  store.db.exec('DROP TRIGGER approval_log_no_update; DROP TRIGGER approval_log_no_delete;');
  store.db.prepare(sql).run(...args);
};

describe('정규 JSON · 해시', () => {
  it('키 순서와 무관하게 같은 문자열, undefined 키는 뺀다', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it('해시 = SHA-256(접두 + 정규 JSON(hash 뺀 필드))', () => {
    const input = {
      seq: 1,
      at: T0,
      action: 'reject',
      actor: human,
      targetRef: { entity: 'Proposal', id: newId() },
      clientId: null,
      detail: { reason: '범위 밖' },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
    } as const;
    const expected = createHash('sha256')
      .update(APPROVAL_LOG_HASH_PREFIX + canonicalJson(input))
      .digest('hex');
    expect(computeApprovalLogHash(input)).toBe(expected);
    expect(computeApprovalLogHash({ ...input, detail: { reason: '범위 밖.' } })).not.toBe(expected);
  });
});

describe('approval_log 리포지토리', () => {
  it('추가: 순번 1부터, 첫 prevHash는 0 64자, 이후 prevHash = 앞 기록의 hash', () => {
    withStore((store) => {
      const first = store.approvalLog.append(approve());
      expect(first).toMatchObject({ seq: 1, prevHash: APPROVAL_LOG_GENESIS_HASH });
      expect(first.hash).toBe(computeApprovalLogHash(first));

      const diff = { before: { text: '가' }, after: { text: '나' } };
      const second = store.approvalLog.append(
        approve({ at: T1, action: 'approve_edited', detail: { diff } }),
      );
      expect(second).toMatchObject({ seq: 2, prevHash: first.hash, detail: { diff } });
      const third = store.approvalLog.append(
        approve({ action: 'reject', detail: { reason: '중복' } }),
      );
      expect(third.prevHash).toBe(second.hash);

      expect(store.approvalLog.list()).toEqual([first, second, third]);
      expect(store.approvalLog.list(second.targetRef)).toEqual([second]);
      expect(store.approvalLog.verify()).toEqual({ valid: true, brokenAtSeq: null, reason: null });
    });
  });

  it('형식 위반은 추가하지 않는다: 에이전트 주체 · 수정 diff 없는 수정 후 승인 · 사유 없는 거절', () => {
    withStore((store) => {
      const agent = { kind: 'agent', role: 'rule-writer' } as unknown as typeof human;
      expect(() => store.approvalLog.append(approve({ actor: agent }))).toThrow();
      expect(() =>
        store.approvalLog.append(approve({ action: 'approve_edited', detail: {} })),
      ).toThrow();
      expect(() => store.approvalLog.append(approve({ action: 'reject', detail: {} }))).toThrow();
      expect(store.approvalLog.list()).toEqual([]);
    });
  });

  it('추가 전용: UPDATE · DELETE는 DB 트리거가 막는다', () => {
    withStore((store) => {
      const entry = store.approvalLog.append(approve());
      expect(() =>
        store.db.prepare('UPDATE approval_log SET at = ? WHERE seq = 1').run(T1),
      ).toThrow(/추가만/);
      expect(() => store.db.prepare('DELETE FROM approval_log').run()).toThrow(/추가만/);
      expect(store.approvalLog.list()).toEqual([entry]);
    });
  });

  it.each([
    ['recursive_triggers ON (기본 연결)', true],
    ['recursive_triggers OFF', false],
  ])('트리거를 지우지 않은 REPLACE로 기록을 덮어쓸 수 없다: %s', (_, recursive) => {
    withStore((store) => {
      const first = store.approvalLog.append(approve());
      const second = store.approvalLog.append(
        approve({ action: 'reject', detail: { reason: '중복' } }),
      );
      store.db.pragma(`recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
      const overwrite = (verb: string, seq: number, hash: string) =>
        store.db
          .prepare(
            `${verb} approval_log (seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash)
             SELECT ?, at, 'approve', actor, target_ref, client_id, '{}', prev_hash, ?
             FROM approval_log WHERE seq = 2`,
          )
          .run(seq, hash);
      for (const verb of ['REPLACE INTO', 'INSERT OR REPLACE INTO']) {
        // 같은 순번으로 덮어쓰기 · 같은 해시를 가진 새 순번으로 넣기 (유일 제약 충돌로 원래 행 삭제)
        expect(() => overwrite(verb, 2, 'b'.repeat(64))).toThrow(/덮어쓰기 금지/);
        expect(() => overwrite(verb, 3, second.hash)).toThrow(/덮어쓰기 금지/);
      }
      expect(store.approvalLog.list()).toEqual([first, second]);
      expect(store.approvalLog.verify()).toMatchObject({ valid: true });
    });
  });

  it('형식이 깨진 행: list는 빼고 돌려주며 verify가 잡는다', () => {
    withStore((store) => {
      const first = store.approvalLog.append(approve());
      store.approvalLog.append(approve());
      tamper(
        store,
        `UPDATE approval_log SET actor = '{"kind":"agent","role":"chat"}' WHERE seq = 2`,
      );
      expect(store.approvalLog.list()).toEqual([first]);
      expect(store.approvalLog.verify()).toMatchObject({ valid: false, brokenAtSeq: 2 });
    });
  });

  it('처리된 제안에 맞는 승인 기록이 없으면 decision_without_log (끝 기록 잘라내기 일부 검출)', () => {
    withStore((store) => {
      const proposal = store.proposals.create({
        id: newId(),
        kind: 'requirement_new',
        targetRef: null,
        payload: { text: '본문' },
        diff: { before: null, after: { text: '본문' } },
        rationale: '근거',
        author: { kind: 'agent', role: 'chat' },
        source: 'chat',
        risk: null,
        adrId: null,
        runId: null,
        createdAt: T0,
      });
      const targetRef = { entity: 'Proposal', id: proposal.id } as const;
      store.proposals.decide(proposal.id, {
        state: 'rejected',
        decision: { at: T1, by: human, rejectReason: '중복' },
      });
      // 기록 없이 처리된 상태 = 끝 기록이 잘려 나간 것과 같다
      expect(store.approvalLog.verify()).toEqual({
        valid: false,
        brokenAtSeq: null,
        reason: 'decision_without_log',
        proposalId: proposal.id,
      });
      // 상태와 맞지 않는 행동(승인)의 기록으로는 채워지지 않는다
      store.approvalLog.append(approve({ targetRef }));
      expect(store.approvalLog.verify()).toMatchObject({ reason: 'decision_without_log' });
      store.approvalLog.append(
        approve({ targetRef, action: 'reject', detail: { reason: '중복' } }),
      );
      expect(store.approvalLog.verify()).toEqual({ valid: true, brokenAtSeq: null, reason: null });
    });
  });

  it('체인 검증: 내용 변조 · 중간 삭제 · prevHash 바꿔치기를 처음 어긋난 순번으로 잡는다', () => {
    withStore((store) => {
      for (let i = 0; i < 3; i += 1) store.approvalLog.append(approve());
      tamper(store, 'UPDATE approval_log SET at = ? WHERE seq = 2', T1);
      expect(store.approvalLog.verify()).toEqual({
        valid: false,
        brokenAtSeq: 2,
        reason: 'hash_mismatch',
      });
    });
    withStore((store) => {
      for (let i = 0; i < 3; i += 1) store.approvalLog.append(approve());
      tamper(store, 'DELETE FROM approval_log WHERE seq = 2');
      expect(store.approvalLog.verify()).toMatchObject({ valid: false, brokenAtSeq: 3 });
    });
    withStore((store) => {
      for (let i = 0; i < 2; i += 1) store.approvalLog.append(approve());
      tamper(store, 'UPDATE approval_log SET prev_hash = ? WHERE seq = 2', 'a'.repeat(64));
      expect(store.approvalLog.verify()).toEqual({
        valid: false,
        brokenAtSeq: 2,
        reason: 'prev_hash_mismatch',
      });
    });
  });

  it('체인 검증 함수: 순번이 비면 seq_gap, 빈 기록은 유효', () => {
    expect(verifyApprovalLogChain([])).toEqual({ valid: true, brokenAtSeq: null, reason: null });
    withStore((store) => {
      store.approvalLog.append(approve());
      const second = store.approvalLog.append(approve());
      expect(verifyApprovalLogChain([second])).toEqual({
        valid: false,
        brokenAtSeq: 2,
        reason: 'seq_gap',
      });
    });
  });
});
