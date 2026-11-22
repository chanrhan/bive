// 사람의 규칙 직접 편집 (M7-03 #215 수용 기준 1 · 2, NRM-04 · NRM-07 · NFR-01, ADR-100 B② · A2 · A8 · C2, ADR-109).
// - `rule.update {projectId, id, author, title?, statement?}`는 사람 주체만 받고(에이전트 -32020) 진술을 EARS 검사로 거른다
// - 편집 · 확인됨(근거 = 승인 기록 순번) · 승인 기록 `rule_edit`(before · after diff)은 트랜잭션 1개다: 둘째 · 셋째 쓰기만
//   실패시켜도 아무것도 남지 않는다
// - 바뀐 것 없음 · 형식 · 없는 규칙 · 삭제 · 효력 없음 · 내장 구조 규칙 · 낡은 화면의 덮어쓰기는 저장하지 않는다
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import {
  APPROVAL_LOG_GENESIS_HASH,
  type Author,
  createUlidGenerator,
  ErrorCode,
  type Requirement,
  type Rule,
  type RuleEditAutoStart,
} from '@bive/shared';
import { computeApprovalLogHash, type ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { confirmHumanRuleEdit } from '../src/confirmations/confirmation-service.js';
import type { PipeServer } from '../src/ipc/server.js';
import { earsStatementProblem } from '../src/tools/ears.js';
import type { TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import {
  iso,
  type ProjectHarnessOptions,
  startProjectHarness,
  T0,
  type ProjectHarness,
} from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const AGENTS = [
  { kind: 'agent', role: 'rule-writer' },
  { kind: 'agent', role: 'test-writer' },
  { kind: 'agent', role: 'implementer' },
  { kind: 'agent', role: 'planner' },
  { kind: 'agent', role: 'chat' },
] as const satisfies readonly Author[];

const TITLE = '중복 이메일 가입 거부';
const STATEMENT = 'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다';
const NEW_TITLE = '중복 이메일 가입 거부 (409)';
const NEW_STATEMENT =
  'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 409 상태 코드로 가입을 거부한다';

const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
let h: ProjectHarness;

const start = async (options: ProjectHarnessOptions = {}): Promise<void> => {
  h = await startProjectHarness({ servers, clients }, options);
};

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

const createRequirement = async (): Promise<Requirement> =>
  (
    await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '사용자는 이메일로 가입할 수 있다',
      author: human,
    })
  ).requirement;

/** 규칙 작성 역할이 바로 반영한 규칙 (미확인, 저장소에 바로 둔다). */
const seedRule = (
  parentRequirementId: string | null,
  overrides: Partial<Pick<Rule, 'builtin' | 'normState' | 'statement'>> = {},
): Rule =>
  h.read((store: ProjectStore) =>
    store.rules.create({
      id: newId(),
      title: TITLE,
      statement: overrides.statement ?? STATEMENT,
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId,
      builtin: overrides.builtin ?? false,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: { kind: 'agent', role: 'rule-writer' },
      normState: overrides.normState ?? 'approved',
      createdAt: iso(T0),
    }),
  );

const update = (params: {
  id: string;
  author?: Author;
  title?: string;
  statement?: string;
  expectedUpdatedAt?: string;
  projectId?: string;
}) =>
  h.client.call('rule.update', {
    projectId: params.projectId ?? h.project.id,
    author: params.author ?? human,
    id: params.id,
    ...(params.title === undefined ? {} : { title: params.title }),
    ...(params.statement === undefined ? {} : { statement: params.statement }),
    ...(params.expectedUpdatedAt === undefined
      ? {}
      : { expectedUpdatedAt: params.expectedUpdatedAt }),
  });

const ruleOf = (id: string): Rule | null => h.read((store) => store.rules.get(id));
const logOf = () => h.read((store) => store.approvalLog.list());
const confirmationRows = () =>
  h.read((store) => store.db.prepare("SELECT * FROM confirmations WHERE entity = 'Rule'").all());

/** 저장된 것이 하나도 바뀌지 않았는지 (규칙 · 승인 기록 · 규칙 확인 행). */
const expectUntouched = (rule: Rule, log: unknown[] = [], rows: unknown[] = []): void => {
  expect(ruleOf(rule.id)).toEqual(rule);
  expect(logOf()).toEqual(log);
  expect(confirmationRows()).toEqual(rows);
};

describe('rule.update: 편집 · 확인됨 · 승인 기록 (수용 기준 1, ADR-100 B② · A2 · A8)', () => {
  it('사람의 제목 · 진술 편집은 규칙을 고치고 확인됨(근거 = rule_edit 순번)으로 두며 승인 기록에 before · after diff를 남긴다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    expect(rule.confirmation).toEqual({ state: 'unconfirmed' });
    h.clock.now = T0 + 60_000;
    const result = await update({ id: rule.id, title: NEW_TITLE, statement: NEW_STATEMENT });

    const at = iso(T0 + 60_000);
    const edited: Rule = {
      ...rule,
      title: NEW_TITLE,
      statement: NEW_STATEMENT,
      updatedAt: at,
      confirmation: { state: 'confirmed', at, by: human, basis: { kind: 'approval_log', seq: 1 } },
    };
    expect(result).toEqual({
      rule: edited,
      judgment: { status: 'unjudged', latest: null },
      approvalLog: result.approvalLog,
      // 처리기만 붙인 서버(자동 시작 창구 없음)는 실행을 만들지 않는다
      autoStart: null,
    });
    // 승인 기록 1건: 사람 · 대상 규칙 · 연결 번호 · before · after diff · 첫 이전 해시 · 해시
    const { hash, ...unhashed } = result.approvalLog;
    expect(unhashed).toEqual({
      seq: 1,
      at,
      action: 'rule_edit',
      actor: human,
      targetRef: { entity: 'Rule', id: rule.id },
      clientId: expect.stringMatching(/^pipe-\d+$/) as unknown as string,
      detail: {
        diff: {
          before: { title: TITLE, statement: STATEMENT },
          after: { title: NEW_TITLE, statement: NEW_STATEMENT },
        },
      },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
    });
    expect(hash).toBe(computeApprovalLogHash(unhashed));
    expect(logOf()).toEqual([result.approvalLog]);
    // 조회 · 저장소가 같은 값을 돌려준다 (규칙의 생성 주체 · 생성 시각 · 부모는 그대로)
    await expect(
      h.client.call('rule.get', { projectId: h.project.id, id: rule.id }),
    ).resolves.toEqual({ rule: edited, judgment: { status: 'unjudged', latest: null } });
    const listed = await h.client.call('rule.list', { projectId: h.project.id });
    expect(listed.rules.map((item) => item.rule)).toEqual([edited]);
    expect(ruleOf(rule.id)).toEqual(edited);
    expect(edited).toMatchObject({
      author: { kind: 'agent', role: 'rule-writer' },
      createdAt: iso(T0),
      parentRequirementId: requirement.id,
    });
    // 체인이 그대로 검증된다
    await expect(
      h.client.call('approvalLog.list', {
        projectId: h.project.id,
        targetRef: { entity: 'Rule', id: rule.id },
      }),
    ).resolves.toEqual({
      entries: [result.approvalLog],
      chain: { valid: true, brokenAtSeq: null, reason: null },
    });
  });

  it('제목만 바꾸면 진술은 그대로이고 diff에 두 칸이 모두 실린다. 확인됨 규칙을 다시 고치면 근거가 새 편집 순번으로 바뀐다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    // 사람이 먼저 확인한 규칙 (승인 기록 1 = confirm)
    await h.client.call('confirmation.set', {
      projectId: h.project.id,
      target: { entity: 'Rule', id: rule.id },
      author: human,
    });
    h.clock.now = T0 + 120_000;
    const result = await update({ id: rule.id, title: NEW_TITLE });
    expect(result.rule).toMatchObject({ title: NEW_TITLE, statement: STATEMENT });
    expect(result.approvalLog).toMatchObject({
      seq: 2,
      action: 'rule_edit',
      detail: {
        diff: {
          before: { title: TITLE, statement: STATEMENT },
          after: { title: NEW_TITLE, statement: STATEMENT },
        },
      },
    });
    const confirmed = {
      state: 'confirmed',
      at: iso(T0 + 120_000),
      by: human,
      basis: { kind: 'approval_log', seq: 2 },
    };
    expect(result.rule.confirmation).toEqual(confirmed);
    expect(ruleOf(rule.id)?.confirmation).toEqual(confirmed);
    expect(logOf().map((entry) => entry.action)).toEqual(['confirm', 'rule_edit']);
    // 규칙 확인 행은 1개 그대로이고 근거만 바뀌었다
    expect(confirmationRows()).toHaveLength(1);
  });

  it('바뀌지 않은 칸은 다시 검사하지 않는다: 지금 형식에 맞지 않는 옛 진술을 그대로 둔 채 제목만 고칠 수 있다', async () => {
    await start();
    const requirement = await createRequirement();
    // EARS 검사가 생기기 전 형식의 진술 (소문자 키워드)
    const legacy = 'when 가입을 요청하면 the system shall 확인 메일을 보낸다';
    expect(earsStatementProblem(legacy)).not.toBeNull();
    const rule = seedRule(requirement.id, { statement: legacy });
    const result = await update({ id: rule.id, title: NEW_TITLE, statement: legacy });
    expect(result.rule).toMatchObject({ title: NEW_TITLE, statement: legacy });
    expect(result.approvalLog.detail.diff?.after).toEqual({ title: NEW_TITLE, statement: legacy });
  });

  it('숨은 글자(방향 제어 · 폭 없는 문자)가 든 제목은 원문 그대로 저장 · 응답한다 (표시 값 변환은 화면 · 작업 지시가 한다)', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    const hidden = '가입\u202e거부\u200b';
    const result = await update({ id: rule.id, title: hidden });
    expect(result.rule.title).toBe(hidden);
    expect(ruleOf(rule.id)?.title).toBe(hidden);
    expect(result.approvalLog.detail.diff?.after).toEqual({ title: hidden, statement: STATEMENT });
  });

  it('화면이 본 수정 시각(expectedUpdatedAt)이 저장된 값과 같으면 고치고, 다르면 -32009(rule_changed)로 아무것도 남기지 않는다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    h.clock.now = T0 + 1_000;
    const first = await update({
      id: rule.id,
      title: NEW_TITLE,
      expectedUpdatedAt: rule.updatedAt,
    });
    expect(first.rule.updatedAt).toBe(iso(T0 + 1_000));
    // 다른 창이 첫 편집 전의 시각으로 저장하려 함 → 덮어쓰지 않는다
    const before = ruleOf(rule.id);
    await expect(
      update({ id: rule.id, statement: NEW_STATEMENT, expectedUpdatedAt: rule.updatedAt }),
    ).rejects.toMatchObject({ code: ErrorCode.StateConflict, data: { reason: 'rule_changed' } });
    expect(ruleOf(rule.id)).toEqual(before);
    expect(logOf()).toEqual([first.approvalLog]);
  });
});

describe('rule.update: 사람 주체만 (NFR-01, ADR-100 I1 · C2)', () => {
  it('에이전트 주체는 -32020이고 규칙 · 승인 기록 · 확인 상태가 그대로다. 프로젝트가 없어도 주체부터 거부한다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    for (const author of AGENTS) {
      await expect(
        update({ id: rule.id, author, title: NEW_TITLE, statement: NEW_STATEMENT }),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    }
    await expect(
      update({
        id: rule.id,
        projectId: newId(),
        author: { kind: 'agent', role: 'implementer' },
        title: NEW_TITLE,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    expectUntouched(rule);
  });
});

describe('rule.update: 형식 검사 (EARS · 한 줄 · 길이 · 바뀐 것 없음)', () => {
  it('EARS가 아닌 진술은 -32001(RULE_EDIT_INVALID)이고 사유는 EARS 검사의 문장이다. 아무것도 남지 않는다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    const bad = [
      '가입을 거부한다',
      'WHEN 가입하면 the system shall 거부한다',
      `WHEN 가입하면 THE SYSTEM SHALL 거부한다\nWHEN 다시 THE SYSTEM SHALL 또 거부한다`,
      'WHEN 가입을 shall 요청하면 THE SYSTEM SHALL 거부한다',
      ' WHEN 가입하면 THE SYSTEM SHALL 거부한다',
    ];
    for (const statement of bad) {
      const problem = earsStatementProblem(statement);
      expect(problem, statement).not.toBeNull();
      await expect(update({ id: rule.id, statement })).rejects.toMatchObject({
        code: ErrorCode.ValidationFailed,
        data: { reason: 'RULE_EDIT_INVALID', issues: [{ path: 'statement', message: problem }] },
      });
    }
    // 제목과 함께 보내도 진술이 틀리면 제목도 저장하지 않는다
    await expect(
      update({ id: rule.id, title: NEW_TITLE, statement: bad[0] ?? '' }),
    ).rejects.toMatchObject({ code: ErrorCode.ValidationFailed });
    expectUntouched(rule);
  });

  it('제목: 공백만 · 줄바꿈 · 제어 문자 · 200자 초과는 -32001, 진술 4000자 초과도 -32001이다. 200 · 4000자는 받는다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    for (const title of [
      '   ',
      ' 앞 공백',
      '뒤 공백 ',
      '두 줄\n제목',
      '탭\t제목',
      `구분${String.fromCodePoint(0x2028)}제목`,
      'ㄱ'.repeat(201),
    ]) {
      await expect(update({ id: rule.id, title })).rejects.toMatchObject({
        code: ErrorCode.ValidationFailed,
        data: { reason: 'RULE_EDIT_INVALID', issues: [{ path: 'title' }] },
      });
    }
    const head = 'WHEN 가입하면 THE SYSTEM SHALL ';
    const tooLong = head + 'ㄱ'.repeat(4001 - head.length);
    expect(tooLong).toHaveLength(4001);
    await expect(update({ id: rule.id, statement: tooLong })).rejects.toMatchObject({
      code: ErrorCode.ValidationFailed,
      data: { reason: 'RULE_EDIT_INVALID', issues: [{ path: 'statement' }] },
    });
    expectUntouched(rule);
    const longest = await update({
      id: rule.id,
      title: 'ㄱ'.repeat(200),
      statement: head + 'ㄱ'.repeat(4000 - head.length),
    });
    expect(longest.rule.title).toHaveLength(200);
    expect(longest.rule.statement).toHaveLength(4000);
  });

  it('바뀐 것이 없으면 -32001(RULE_EDIT_NO_CHANGE)이고 확인됨 · 승인 기록이 생기지 않는다. 제목 · 진술이 둘 다 없으면 -32602', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    for (const change of [
      { title: TITLE },
      { statement: STATEMENT },
      { title: TITLE, statement: STATEMENT },
    ]) {
      await expect(update({ id: rule.id, ...change })).rejects.toMatchObject({
        code: ErrorCode.ValidationFailed,
        data: { reason: 'RULE_EDIT_NO_CHANGE' },
      });
    }
    const response = await h.client.requestRaw({
      jsonrpc: '2.0',
      id: 'empty',
      method: 'rule.update',
      params: { projectId: h.project.id, id: rule.id, author: human },
    });
    expect(response).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
    expectUntouched(rule);
  });
});

describe('rule.update: 편집할 수 없는 규칙', () => {
  it('없는 규칙 · 등록되지 않은 프로젝트는 -32004, 삭제된 규칙은 -32009(rule_deleted), 효력 없는 규칙은 -32009(rule_not_effective)', async () => {
    await start();
    const requirement = await createRequirement();
    await expect(update({ id: newId(), title: NEW_TITLE })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    const rule = seedRule(requirement.id);
    await expect(
      update({ id: rule.id, projectId: newId(), title: NEW_TITLE }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
    const provisional = seedRule(requirement.id, { normState: 'provisional' });
    await expect(update({ id: provisional.id, title: NEW_TITLE })).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
      data: { reason: 'rule_not_effective' },
    });
    // 소프트 삭제된 규칙 (규칙 삭제 경로는 아직 없어 저장소에서 지운다)
    h.read((store) =>
      store.db.prepare('UPDATE rules SET deleted_at = ? WHERE id = ?').run(iso(T0 + 1), rule.id),
    );
    const deleted = ruleOf(rule.id);
    if (deleted === null) throw new Error('규칙 없음');
    await expect(update({ id: rule.id, title: NEW_TITLE })).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
      data: { reason: 'rule_deleted' },
    });
    expect(ruleOf(rule.id)).toEqual(deleted);
    expect(ruleOf(provisional.id)).toEqual(provisional);
    expect(logOf()).toEqual([]);
    expect(confirmationRows()).toEqual([]);
  });

  it('내장 구조 규칙(부모 없는 내장)은 제목 · 진술 어느 쪽도 고칠 수 없다: -32009(builtin_rule), 아무것도 남지 않는다 (ADR-109)', async () => {
    await start();
    const builtin = seedRule(null, {
      builtin: true,
      statement: 'WHEN 모듈이 다른 블록을 가져오면 THE SYSTEM SHALL 공개 API만 쓰게 한다',
    });
    for (const change of [{ title: NEW_TITLE }, { statement: NEW_STATEMENT }]) {
      await expect(update({ id: builtin.id, ...change })).rejects.toMatchObject({
        code: ErrorCode.StateConflict,
        data: { reason: 'builtin_rule' },
      });
    }
    expectUntouched(builtin);
  });
});

describe('rule.update: 트랜잭션 1개 (편집 → 승인 기록 → 확인됨, 둘째 · 셋째 쓰기만 실패)', () => {
  /** 테스트 전용 트리거를 걸고 편집이 실패한 뒤 아무것도 남지 않음을 본다. */
  const failsWith = async (trigger: string, rule: Rule, rows: unknown[] = []): Promise<void> => {
    const log = logOf();
    h.read((store) => store.db.exec(trigger));
    await expect(
      update({ id: rule.id, title: NEW_TITLE, statement: NEW_STATEMENT }),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    // 첫 쓰기(규칙 편집)는 이미 실행됐지만 되돌려졌다
    expectUntouched(rule, log, rows);
    h.read((store) => store.db.exec('DROP TRIGGER test_fail'));
  };

  it('승인 기록 추가(둘째 쓰기)만 실패하면 규칙 편집도 되돌려진다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    await failsWith(
      `CREATE TRIGGER test_fail BEFORE INSERT ON approval_log
       BEGIN SELECT RAISE(ABORT, '강제 실패'); END`,
      rule,
    );
    // 원인을 없애면 같은 편집이 승인 기록 1번으로 저장된다
    const result = await update({ id: rule.id, title: NEW_TITLE, statement: NEW_STATEMENT });
    expect(result.approvalLog.seq).toBe(1);
  });

  it('확인됨 저장(셋째 쓰기)만 실패하면 규칙 편집 · 승인 기록이 되돌려진다: 미확인 규칙(행 추가) · 확인됨 규칙(행 갱신) 둘 다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    // 규칙 편집과 승인 기록 추가는 지나가고, 규칙 확인 행 추가에서만 실패
    await failsWith(
      `CREATE TRIGGER test_fail BEFORE INSERT ON confirmations WHEN NEW.entity = 'Rule'
       BEGIN SELECT RAISE(ABORT, '강제 실패'); END`,
      rule,
    );
    // 이미 확인됨인 규칙: 확인 행 갱신에서만 실패
    await h.client.call('confirmation.set', {
      projectId: h.project.id,
      target: { entity: 'Rule', id: rule.id },
      author: human,
    });
    const confirmed = ruleOf(rule.id);
    if (confirmed === null) throw new Error('규칙 없음');
    const rows = confirmationRows();
    expect(rows).toHaveLength(1);
    await failsWith(
      `CREATE TRIGGER test_fail BEFORE UPDATE ON confirmations WHEN NEW.entity = 'Rule'
       BEGIN SELECT RAISE(ABORT, '강제 실패'); END`,
      confirmed,
      rows,
    );
    expect(logOf().map((entry) => entry.action)).toEqual(['confirm']);
  });
});

describe('rule.update: 실행 자동 시작 창구는 진술이 바뀐 편집에만 (ADR-109)', () => {
  it('진술이 바뀐 편집이 커밋된 뒤 그 승인 기록 순번으로 1번 부르고 결과를 autoStart로 돌려준다. 제목만 바뀌면 부르지 않는다', async () => {
    const calls: { projectId: string; approvalSeq: number; committed: string | null }[] = [];
    const outcome: RuleEditAutoStart = {
      state: 'skipped',
      reason: 'project_daily_budget_unset',
      missing: [],
    };
    await start({
      ruleEditStarter: () => ({
        afterRuleEdit: (projectId, approvalSeq) => {
          // 부를 때는 편집이 이미 커밋돼 있다 (다른 연결에서 읽힌다)
          calls.push({ projectId, approvalSeq, committed: ruleOf(ruleId)?.statement ?? null });
          return outcome;
        },
      }),
    });
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    const ruleId = rule.id;
    const titleOnly = await update({ id: rule.id, title: NEW_TITLE });
    expect(titleOnly.autoStart).toBeNull();
    expect(calls).toEqual([]);
    const result = await update({ id: rule.id, statement: NEW_STATEMENT });
    expect(result.autoStart).toEqual(outcome);
    expect(calls).toEqual([
      { projectId: h.project.id, approvalSeq: result.approvalLog.seq, committed: NEW_STATEMENT },
    ]);
    // 거부된 편집은 부르지 않는다
    await expect(update({ id: rule.id, statement: '형식 아님' })).rejects.toMatchObject({
      code: ErrorCode.ValidationFailed,
    });
    await expect(
      update({ id: rule.id, author: { kind: 'agent', role: 'chat' }, statement: STATEMENT }),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    expect(calls).toHaveLength(1);
  });
});

describe('confirmHumanRuleEdit: 규칙 편집 기록만 근거가 된다 (방어)', () => {
  it('규칙 편집이 아닌 승인 기록(확인)을 넘기면 -32009이고 확인 상태가 바뀌지 않는다', async () => {
    await start();
    const requirement = await createRequirement();
    const rule = seedRule(requirement.id);
    const { approvalLog } = await h.client.call('confirmation.set', {
      projectId: h.project.id,
      target: { entity: 'Rule', id: rule.id },
      author: human,
    });
    const rows = confirmationRows();
    h.read((store) => {
      expect(() => confirmHumanRuleEdit(store, approvalLog)).toThrow(
        expect.objectContaining({ code: ErrorCode.StateConflict }) as Error,
      );
    });
    expect(confirmationRows()).toEqual(rows);
  });
});
