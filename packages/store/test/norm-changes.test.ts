// 규범 변경 기록 리포지토리 · 해시 체인 (M7-02 #214 수용 기준 2, NRM-07 · NFR-01 · ADR-100 C2 · A2, ADR-103).
// 실제 SQLite 임시 저장소.
import { createHash } from 'node:crypto';

import { APPROVAL_LOG_GENESIS_HASH, NORM_CHANGE_GENESIS_HASH } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LOG_HASH_PREFIX,
  canonicalJson,
  computeApprovalLogHash,
} from '../src/approval-chain.js';
import {
  computeNormChangeHash,
  NORM_CHANGE_HASH_PREFIX,
  verifyNormChangeChain,
} from '../src/norm-change-chain.js';
import { beginNormWatch, verifyNormWatch } from '../src/norm-snapshot.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import type { NormChangeAppendInput } from '../src/repositories/norm-change-repository.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-11-21T00:00:00.000Z';
const T1 = '2026-11-21T01:00:00.000Z';
const ruleWriter = { kind: 'agent', role: 'rule-writer' } as const;

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const created = (overrides: Partial<NormChangeAppendInput> = {}): NormChangeAppendInput => ({
  at: T0,
  kind: 'created',
  actor: ruleWriter,
  targetRef: { entity: 'Rule', id: newId() },
  sessionId: newId(),
  runId: null,
  reason: "요구사항의 '서버 시각 포함'",
  detail: { after: { displayId: 'RULE-001', title: '헬스 체크 응답의 서버 시각' } },
  ...overrides,
});

/** 체인을 일부러 깨기 위해 추가 전용 트리거를 잠시 지운다 (같은 사용자 권한의 다른 프로세스 흉내). */
const tamper = (store: ProjectStore, sql: string, ...args: unknown[]): void => {
  store.db.exec('DROP TRIGGER norm_changes_no_update; DROP TRIGGER norm_changes_no_delete;');
  store.db.prepare(sql).run(...args);
};

const rawInsert = (store: ProjectStore, row: Record<string, unknown>) =>
  store.db
    .prepare(
      `INSERT INTO norm_changes (seq, at, kind, actor, target_ref, session_id, run_id, reason, detail, prev_hash, hash)
       VALUES (@seq, @at, @kind, @actor, @target_ref, @session_id, @run_id, @reason, @detail, @prev_hash, @hash)`,
    )
    .run({
      seq: 1,
      at: T0,
      kind: 'created',
      actor: JSON.stringify(ruleWriter),
      target_ref: JSON.stringify({ entity: 'Rule', id: newId() }),
      session_id: newId(),
      run_id: null,
      reason: '사유',
      detail: '{"after":{}}',
      prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
      ...row,
    });

describe('해시: 승인 기록과 다른 접두 (도메인 구분)', () => {
  it('해시 = SHA-256("bive-norm-change-v1\\n" + 정규 JSON(hash 뺀 필드)), 접두는 승인 기록과 다르다', () => {
    expect(NORM_CHANGE_HASH_PREFIX).toBe('bive-norm-change-v1\n');
    expect(NORM_CHANGE_HASH_PREFIX).not.toBe(APPROVAL_LOG_HASH_PREFIX);
    expect(NORM_CHANGE_GENESIS_HASH).toBe(APPROVAL_LOG_GENESIS_HASH);
    const input = {
      seq: 1,
      at: T0,
      kind: 'created',
      actor: ruleWriter,
      targetRef: { entity: 'Rule', id: newId() },
      sessionId: newId(),
      runId: null,
      reason: '사유',
      detail: { after: { title: '제목' } },
      prevHash: NORM_CHANGE_GENESIS_HASH,
    } as const;
    const expected = createHash('sha256')
      .update(NORM_CHANGE_HASH_PREFIX + canonicalJson(input))
      .digest('hex');
    expect(computeNormChangeHash(input)).toBe(expected);
    // 같은 필드를 승인 기록 접두로 해시하면 다른 값이다
    expect(
      createHash('sha256')
        .update(APPROVAL_LOG_HASH_PREFIX + canonicalJson(input))
        .digest('hex'),
    ).not.toBe(expected);
  });

  it('승인 기록 체인의 해시를 그대로 옮겨 붙인 항목은 규범 변경 기록 체인에서 hash_mismatch다 (바꿔 끼우기 불가)', () => {
    withStore((store) => {
      const entry = store.normChanges.append(created());
      // 같은 내용을 승인 기록 접두로 계산한 해시를 가진 항목 = 다른 체인에서 가져온 항목
      const foreignHash = computeApprovalLogHash(entry as never);
      expect(foreignHash).not.toBe(entry.hash);
      expect(verifyNormChangeChain([{ ...entry, hash: foreignHash }])).toEqual({
        valid: false,
        brokenAtSeq: 1,
        reason: 'hash_mismatch',
      });
      // 저장소의 행을 그렇게 바꿔치기해도 verify가 잡는다
      tamper(store, 'UPDATE norm_changes SET hash = ? WHERE seq = 1', foreignHash);
      expect(store.normChanges.verify()).toEqual({
        valid: false,
        brokenAtSeq: 1,
        reason: 'hash_mismatch',
      });
    });
  });

  it('규범 변경 기록 항목을 승인 기록에 옮겨 넣으면 승인 기록 체인 검증이 잡는다', () => {
    withStore((store) => {
      const entry = store.normChanges.append(created());
      store.db
        .prepare(
          `INSERT INTO approval_log (seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash)
           VALUES (1, ?, 'approve', ?, ?, NULL, '{}', ?, ?)`,
        )
        .run(
          entry.at,
          JSON.stringify(entry.actor),
          JSON.stringify(entry.targetRef),
          entry.prevHash,
          entry.hash,
        );
      expect(store.approvalLog.verify()).toEqual({
        valid: false,
        brokenAtSeq: 1,
        reason: 'hash_mismatch',
      });
      expect(store.approvalLog.list()).toEqual([]);
    });
  });
});

describe('norm_changes 리포지토리', () => {
  it('추가: 순번 1부터, 첫 prevHash는 0 64자, 이후 prevHash = 앞 기록의 hash, 대상으로 거른다', () => {
    withStore((store) => {
      const first = store.normChanges.append(created());
      expect(first).toMatchObject({ seq: 1, prevHash: NORM_CHANGE_GENESIS_HASH });
      expect(first.hash).toBe(computeNormChangeHash(first));
      const second = store.normChanges.append(created({ at: T1 }));
      expect(second).toMatchObject({ seq: 2, prevHash: first.hash });
      // 오케스트레이터 주체는 세션 · 사유 없이도 받는다 (자동 시작 · 확인 풀림 등 뒤 이슈의 행동)
      const third = store.normChanges.append(
        created({
          kind: 'auto_start',
          actor: { kind: 'orchestrator' },
          targetRef: { entity: 'Run', id: newId() },
          sessionId: null,
          reason: null,
          detail: {},
        }),
      );
      expect(third).toMatchObject({ seq: 3, prevHash: second.hash });
      expect(store.normChanges.list()).toEqual([first, second, third]);
      expect(store.normChanges.list(second.targetRef)).toEqual([second]);
      expect(store.normChanges.list({ entity: 'Rule', id: newId() })).toEqual([]);
      expect(store.normChanges.verify()).toEqual({ valid: true, brokenAtSeq: null, reason: null });
    });
  });

  it('형식 위반은 추가하지 않는다: 사람 주체 · 세션 없는 에이전트 · 사유 없는 에이전트 · 내용 없는 신규', () => {
    withStore((store) => {
      const human = { kind: 'human' } as unknown as typeof ruleWriter;
      expect(() => store.normChanges.append(created({ actor: human }))).toThrow();
      expect(() => store.normChanges.append(created({ sessionId: null }))).toThrow(/세션 ID/);
      expect(() => store.normChanges.append(created({ reason: null }))).toThrow(/사유/);
      expect(() => store.normChanges.append(created({ reason: '  ' }))).toThrow();
      expect(() => store.normChanges.append(created({ detail: {} }))).toThrow(/after/);
      expect(() =>
        store.normChanges.append(created({ detail: { before: {}, after: {} } })),
      ).toThrow(/before/);
      expect(store.normChanges.list()).toEqual([]);
    });
  });

  it('DB CHECK: 사람 주체 행, 세션 · 사유 없는 에이전트 행은 DB가 거부한다 (스키마를 거치지 않는 삽입)', () => {
    withStore((store) => {
      expect(() => rawInsert(store, { actor: '{"kind":"human"}' })).toThrow(/CHECK/);
      expect(() => rawInsert(store, { session_id: null })).toThrow(/CHECK/);
      expect(() => rawInsert(store, { reason: null })).toThrow(/CHECK/);
      expect(() => rawInsert(store, { kind: 'approve' })).toThrow(/CHECK/);
      expect(store.db.prepare('SELECT count(*) AS n FROM norm_changes').get()).toEqual({ n: 0 });
    });
  });

  it.each([
    ['actor', '{}'],
    ['actor', '{"kind":null}'],
    ['actor', '{"Kind":"human"}'],
    ['actor', '"human"'],
    ['actor', '[{"kind":"agent"}]'],
    ['actor', '{"kind":"agent"}'],
    ['actor', '{"kind":"agent","role":null}'],
    ['actor', '{"kind":"agent","role":""}'],
    ['actor', '{"kind":1}'],
    ['target_ref', '{}'],
    ['target_ref', '"Rule"'],
    ['target_ref', '[]'],
    ['target_ref', '{"entity":null,"id":"x"}'],
    ['target_ref', '{"entity":"Rule"}'],
    ['target_ref', '{"entity":"Rule","id":""}'],
    ['target_ref', '{"entity":"Rule","id":1}'],
    ['detail', '"after"'],
    ['detail', '[]'],
    ['detail', 'null'],
  ])(
    'DB CHECK: JSON 칸의 NULL · 모양 구멍이 없다 (%s = %s, 스키마를 거치지 않는 삽입)',
    (column, value) => {
      withStore((store) => {
        // 대조군: 기본 행은 들어간다
        rawInsert(store, {});
        expect(() => rawInsert(store, { seq: 2, hash: 'b'.repeat(64), [column]: value })).toThrow(
          /CHECK/,
        );
        expect(store.db.prepare('SELECT count(*) AS n FROM norm_changes').get()).toEqual({ n: 1 });
      });
    },
  );

  it('DB CHECK: kind가 null인 주체는 세션 ID · 사유 없이도 에이전트 조건을 건너뛰지 못한다', () => {
    withStore((store) => {
      expect(() =>
        rawInsert(store, {
          actor: '{"kind":null,"role":"implementer"}',
          session_id: null,
          reason: null,
        }),
      ).toThrow(/CHECK/);
      // 오케스트레이터 주체는 세션 · 사유 없이 들어간다 (대조군)
      rawInsert(store, {
        kind: 'auto_start',
        actor: '{"kind":"orchestrator"}',
        session_id: null,
        reason: null,
        detail: '{}',
      });
      expect(store.db.prepare('SELECT count(*) AS n FROM norm_changes').get()).toEqual({ n: 1 });
    });
  });

  it('추가 전용: UPDATE · DELETE는 DB 트리거가 막는다', () => {
    withStore((store) => {
      const entry = store.normChanges.append(created());
      expect(() =>
        store.db.prepare('UPDATE norm_changes SET reason = ? WHERE seq = 1').run('바꾼 사유'),
      ).toThrow(/추가만/);
      expect(() => store.db.prepare('DELETE FROM norm_changes').run()).toThrow(/추가만/);
      expect(store.normChanges.list()).toEqual([entry]);
    });
  });

  it.each([
    ['recursive_triggers ON (기본 연결)', true],
    ['recursive_triggers OFF', false],
  ])('트리거를 지우지 않은 REPLACE로 기록을 덮어쓸 수 없다: %s', (_, recursive) => {
    withStore((store) => {
      const first = store.normChanges.append(created());
      const second = store.normChanges.append(created());
      store.db.pragma(`recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
      const overwrite = (verb: string, seq: number, hash: string) =>
        store.db
          .prepare(
            `${verb} norm_changes (seq, at, kind, actor, target_ref, session_id, run_id, reason, detail, prev_hash, hash)
             SELECT ?, at, kind, actor, target_ref, session_id, run_id, '바꾼 사유', detail, prev_hash, ?
             FROM norm_changes WHERE seq = 2`,
          )
          .run(seq, hash);
      for (const verb of ['REPLACE INTO', 'INSERT OR REPLACE INTO']) {
        expect(() => overwrite(verb, 2, 'b'.repeat(64))).toThrow(/덮어쓰기 금지/);
        expect(() => overwrite(verb, 3, second.hash)).toThrow(/덮어쓰기 금지/);
      }
      expect(store.normChanges.list()).toEqual([first, second]);
      expect(store.normChanges.verify()).toMatchObject({ valid: true });
    });
  });

  it('체인 검증: 내용 변조 · 중간 삭제 · prevHash 바꿔치기 · 형식이 깨진 행을 처음 어긋난 순번으로 잡는다', () => {
    const appendThree = (store: ProjectStore) => {
      store.normChanges.append(created());
      store.normChanges.append(created());
      store.normChanges.append(created());
    };
    withStore((store) => {
      appendThree(store);
      tamper(store, "UPDATE norm_changes SET reason = '약하게 바꾼 사유' WHERE seq = 2");
      expect(store.normChanges.verify()).toEqual({
        valid: false,
        brokenAtSeq: 2,
        reason: 'hash_mismatch',
      });
    });
    withStore((store) => {
      appendThree(store);
      tamper(store, 'DELETE FROM norm_changes WHERE seq = 2');
      expect(store.normChanges.verify()).toEqual({
        valid: false,
        brokenAtSeq: 3,
        reason: 'seq_gap',
      });
    });
    withStore((store) => {
      appendThree(store);
      tamper(store, `UPDATE norm_changes SET prev_hash = '${'c'.repeat(64)}' WHERE seq = 3`);
      expect(store.normChanges.verify()).toEqual({
        valid: false,
        brokenAtSeq: 3,
        reason: 'prev_hash_mismatch',
      });
    });
    withStore((store) => {
      // 해시까지 다시 계산했지만 형식이 깨진 행: list는 빼고 verify는 malformed. DB CHECK는 사람 주체를 막으므로
      // CHECK가 보지 않는 칸(세션 ID의 ULID 형식)을 깨뜨린다
      const first = store.normChanges.append(created());
      const broken = { ...first, sessionId: 'x'.repeat(26) };
      tamper(
        store,
        'UPDATE norm_changes SET session_id = ?, hash = ? WHERE seq = 1',
        broken.sessionId,
        computeNormChangeHash(broken),
      );
      expect(store.normChanges.list()).toEqual([]);
      expect(store.normChanges.verify()).toEqual({
        valid: false,
        brokenAtSeq: 1,
        reason: 'malformed',
      });
    });
  });
});

describe('에이전트 · 오케스트레이터 주체는 승인 기록에 생기지 않는다 (ADR-100 C2)', () => {
  it('승인 기록 추가는 에이전트 · 오케스트레이터 주체를 거부하고, 규범 변경 기록 추가는 승인 기록을 늘리지 않는다', () => {
    withStore((store) => {
      const base = {
        at: T0,
        action: 'confirm',
        targetRef: { entity: 'Rule', id: newId() },
        clientId: null,
        detail: {},
      } as const;
      for (const actor of [
        ruleWriter,
        { kind: 'agent', role: 'implementer' },
        { kind: 'orchestrator' },
      ]) {
        expect(() =>
          store.approvalLog.append({ ...base, actor: actor as unknown as { kind: 'human' } }),
        ).toThrow();
      }
      store.normChanges.append(created());
      store.normChanges.append(
        created({
          kind: 'auto_start',
          actor: { kind: 'orchestrator' },
          targetRef: { entity: 'Run', id: newId() },
          sessionId: null,
          reason: null,
          detail: {},
        }),
      );
      expect(store.normChanges.list()).toHaveLength(2);
      expect(store.approvalLog.list()).toEqual([]);
      expect(store.db.prepare('SELECT count(*) AS n FROM approval_log').get()).toEqual({ n: 0 });
    });
  });
});

describe('단계 실행기의 감시가 깨진 규범 변경 기록 체인을 불일치로 돌려준다', () => {
  it('트리거를 지우고 고친 기록은 norm_change_chain_broken', () => {
    withStore((store) => {
      store.normChanges.append(created());
      const watch = beginNormWatch(store);
      // 같은 연결의 쓰기는 닫을 때 믿는 상태가 되므로 여기서는 체인 불일치만 본다
      expect(verifyNormWatch(store, watch).map((mismatch) => mismatch.kind)).not.toContain(
        'norm_change_chain_broken',
      );
      tamper(store, "UPDATE norm_changes SET reason = '바꾼 사유' WHERE seq = 1");
      expect(verifyNormWatch(store, watch).map((mismatch) => mismatch.kind)).toContain(
        'norm_change_chain_broken',
      );
    });
  });
});
