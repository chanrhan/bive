// 사람의 규칙 진술 편집 뒤 인수 테스트를 다시 쓰는 실행의 자동 시작 (M7-03 #215 수용 기준 2, ADR-100 A8 · A2 · C2 · B⑤ · B⑥,
// ADR-107 · ADR-110, ADR-109).
// - 진술이 바뀐 사람 편집(승인 기록 `rule_edit`) 1건 → 그 규칙 1개의 실행 1개 + 규범 변경 기록 `auto_start` 1건(원인 =
//   `ruleEditSeqs`). 제목만 바뀌면 실행이 없다. 같은 편집으로 두 번 시작하지 않는다
// - 그 규칙이 대상인 시작 전 실행(승인 대기 · 실행 대기)이 있으면 만들지 않는다. 진행 중 실행이 있으면 새 실행이 실행 대기로 선다
// - 하루 한도 비움 · 설정 미비 · 오늘 지출이 한도에 이름이면 만들지 않는다(기록 없음, 응답으로만)
// - 엔진의 시작 근거 대조는 원인이 그 규칙의 진술을 바꾼 사람 편집인지 본다. 신규 기록 순번과 승인 기록 순번이 같은 수여도
//   서로를 원인으로 쓰지 않는다
// - 실행은 사람의 [실행]과 같은 단계를 지난다: Red 확인이 넘지 못하면(새 진술로 쓴 테스트가 이미 통과) 실행은 실패로 끝난다
// 제품 오케스트레이터(`startOrchestrator`) · 파이프 RPC는 마지막 묶음에서, 나머지는 열린 저장소에서 직접 부른다.
import fs from 'node:fs';
import path from 'node:path';

import {
  type ApprovalLogEntry,
  type Author,
  type NormChangeEntry,
  type Run,
  type SettingsPatch,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import { checkRunStartBasis } from '../src/engine/start-basis.js';
import type { StepExecutor } from '../src/engine/types.js';
import { createAgentRule, retireAgentRule } from '../src/norms/agent-rule.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import { autoStartRun } from '../src/runs/auto-start.js';
import {
  autoStartRuleEditRun,
  RULE_EDIT_START_REASON,
  RuleEditAutoStarter,
} from '../src/runs/rule-edit-start.js';
import { saveNewRun, startNextQueuedRun } from '../src/runs/run-service.js';
import { connect, type TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  mergeStep,
  newId,
  scripted,
  seedProject,
  testExecutors,
  withProject,
} from './helpers/engine-harness.js';
import { makeBiveHome, waitFor } from './helpers/process.js';

const temps: string[] = [];
const running: { orchestrator: Orchestrator; client: TestClient }[] = [];

afterEach(async () => {
  for (const { orchestrator, client } of running.splice(0)) {
    client.destroy();
    await orchestrator.stop();
  }
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DAILY: SettingsPatch = { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 };
const NEW_STATEMENT =
  'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 time 필드에 ISO 8601 서버 시각을 담는다';
const clock = { now: Date.now, newId };

interface StoreHarness {
  biveHome: string;
  repo: string;
  projectId: string;
  ruleId: string;
  requirementId: string;
  read<T>(fn: (store: ProjectStore) => T): T;
}

const storeHarness = (settings: SettingsPatch = DAILY): StoreHarness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, settings);
  return {
    biveHome,
    repo,
    projectId: seeded.project.id,
    ruleId: seeded.rule.id,
    requirementId: seeded.rule.parentRequirementId ?? '',
    read: (fn) => withProject(biveHome, seeded.project.id, fn),
  };
};

/** 사람의 규칙 편집과 같은 승인 기록 (`rule.update` 처리기가 남기는 모양). 규칙도 그 값으로 고친다. */
const humanEdit = (
  h: StoreHarness,
  change: { title?: string; statement?: string },
  ruleId = h.ruleId,
): ApprovalLogEntry =>
  h.read((store) =>
    store.transaction(() => {
      const before = store.rules.get(ruleId);
      if (before === null) throw new Error('규칙 없음');
      const after = store.rules.update(ruleId, change, new Date().toISOString());
      return store.approvalLog.append({
        at: after.updatedAt,
        action: 'rule_edit',
        actor: human,
        targetRef: { entity: 'Rule', id: ruleId },
        clientId: 'pipe-1',
        detail: {
          diff: {
            before: { title: before.title, statement: before.statement },
            after: { title: after.title, statement: after.statement },
          },
        },
      });
    }),
  );

const counts = (store: ProjectStore) => ({
  runs: store.runs.list().length,
  autoStarts: store.normChanges.list().filter((entry) => entry.kind === 'auto_start').length,
  exe: store.sequences.last('EXE'),
});

const startEdit = (h: StoreHarness, approvalSeq: number) =>
  h.read((store) => autoStartRuleEditRun(store, { approvalSeq }, clock));

describe('autoStartRuleEditRun: 진술이 바뀐 사람 편집 1건 → 그 규칙의 실행 1개 (ADR-109)', () => {
  it('실행(대상 규칙 1개 · 시작 주체 오케스트레이터 · 원인 = 승인 기록 순번)과 자동 시작 항목(ruleEditSeqs)을 남기고 승인 기록에는 쓰지 않는다. 다시 불러도 1개다', () => {
    const h = storeHarness();
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    const outcome = startEdit(h, edit.seq);
    if (outcome.status !== 'started') throw new Error(`시작 안 됨: ${outcome.status}`);
    expect(outcome.detail.run).toMatchObject({
      displayId: 'EXE-001',
      type: 'A',
      status: 'waiting_approval',
      currentStep: 'approval',
      targetRuleIds: [h.ruleId],
      startedBy: { kind: 'orchestrator', causeSeqs: [edit.seq], causeLog: 'approval_log' },
    });
    // 사람의 [실행]과 같은 단계 (테스트 작성 → Red 확인 → 구현 → 검사 → … → 병합)
    expect(outcome.detail.steps.map((step) => step.kind)).toEqual([
      'approval',
      'test_writing',
      'red_check',
      'implementation',
      'check',
      'mutation',
      'merge',
      'screen_update',
    ]);
    expect(outcome.normChange).toMatchObject({
      kind: 'auto_start',
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Run', id: outcome.detail.run.id },
      sessionId: null,
      runId: outcome.detail.run.id,
      reason: RULE_EDIT_START_REASON,
    });
    expect(outcome.normChange.detail).toEqual({ ruleEditSeqs: [edit.seq], ruleIds: [h.ruleId] });
    // 승인 기록(사람 행동만)에는 편집 1건뿐이다: run_start를 만들어 내지 않는다
    expect(h.read((store) => store.approvalLog.list().map((item) => item.action))).toEqual([
      'rule_edit',
    ]);
    expect(startEdit(h, edit.seq)).toEqual({
      status: 'duplicate',
      runId: outcome.detail.run.id,
    });
    expect(h.read(counts)).toEqual({ runs: 1, autoStarts: 1, exe: 1 });
    expect(h.read((store) => checkRunStartBasis(store, outcome.detail.run)).mismatch).toBeNull();
  });

  it('원인이 아니면 아무것도 남기지 않는다: 제목만 바뀐 편집 · 확인 기록 · 없는 순번 · 뒤 편집이 진술을 또 바꾼 앞 편집 · 그 뒤 효력을 잃은 규칙', () => {
    const h = storeHarness();
    const titleOnly = humanEdit(h, { title: '헬스 체크 서버 시각 (ISO)' });
    expect(startEdit(h, titleOnly.seq)).toEqual({ status: 'not_applicable' });
    const confirm = h.read((store) =>
      store.approvalLog.append({
        at: new Date().toISOString(),
        action: 'confirm',
        actor: human,
        targetRef: { entity: 'Rule', id: h.ruleId },
        clientId: 'pipe-1',
        detail: {},
      }),
    );
    expect(startEdit(h, confirm.seq)).toEqual({ status: 'not_applicable' });
    expect(startEdit(h, 999)).toEqual({ status: 'not_applicable' });
    const first = humanEdit(h, { statement: NEW_STATEMENT });
    const second = humanEdit(h, {
      statement:
        'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답에 버전을 담는다',
    });
    // 앞 편집의 진술은 이미 바뀌었다: 원인은 뒤 편집이다
    expect(startEdit(h, first.seq)).toEqual({ status: 'not_applicable' });
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, exe: 0 });
    // 규칙이 효력을 잃음 (삭제)
    h.read((store) =>
      store.db
        .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), h.ruleId),
    );
    expect(startEdit(h, second.seq)).toEqual({ status: 'not_applicable' });
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, exe: 0 });
  });

  it('편집 뒤 규칙이 폐기됐으면 그 진술 편집으로 실행이 생기지 않는다 (M7-09 #221, ADR-112)', () => {
    const h = storeHarness();
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    h.read((store) =>
      retireAgentRule(
        store,
        {
          ruleId: h.ruleId,
          grounds: '진술 "ISO 8601 서버 시각을 담는다"는 새 요구사항과 모순',
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: newId(),
        },
        clock,
      ),
    );
    expect(startEdit(h, edit.seq)).toEqual({ status: 'not_applicable' });
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, exe: 0 });
  });

  it('그 규칙이 대상인 시작 전 실행(승인 대기 · 실행 대기)이 있으면 만들지 않고 그 실행을 알린다. 진행 중 실행만 있으면 새 실행을 만든다', () => {
    const h = storeHarness();
    // 사람의 [실행]으로 만든 승인 대기 실행 (엔진 판정 전)
    const waiting = h.read((store) =>
      saveNewRun(
        store,
        store.settings.get(),
        { runId: newId(), ruleIds: [h.ruleId], startedBy: { kind: 'human' } },
        new Date().toISOString(),
        newId,
      ),
    );
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    expect(startEdit(h, edit.seq)).toEqual({
      status: 'pending',
      runId: waiting.run.id,
      runDisplayId: 'EXE-001',
    });
    // 실행 대기도 같다
    h.read((store) =>
      store.db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").run(waiting.run.id),
    );
    expect(startEdit(h, edit.seq).status).toBe('pending');
    expect(h.read(counts)).toEqual({ runs: 1, autoStarts: 0, exe: 1 });
    // 진행 중(이미 테스트를 쓰고 있을 수 있음)이면 새 진술로 다시 쓰는 실행을 만든다 (자리가 나면 시작, ADR-105)
    h.read((store) =>
      store.db
        .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
        .run(new Date().toISOString(), waiting.run.id),
    );
    const outcome = startEdit(h, edit.seq);
    expect(outcome.status).toBe('started');
    expect(h.read(counts)).toEqual({ runs: 2, autoStarts: 1, exe: 2 });
  });

  it('하루 한도 비움 · 설정 미비 · 오늘 지출이 하루 한도에 이름이면 만들지 않고 기록도 남기지 않는다 (규칙 작성 뒤 자동 시작과 같은 문)', () => {
    const cases: [SettingsPatch, (h: StoreHarness) => void, unknown][] = [
      [
        COMPLETE_SETTINGS,
        () => undefined,
        { status: 'skipped', reason: 'project_daily_budget_unset', missing: [] },
      ],
      [
        {
          ...DAILY,
          roles: {
            ...COMPLETE_SETTINGS.roles,
            implementer: { model: null, maxBudgetUsd: 2, maxTurns: 100 },
          },
        },
        () => undefined,
        { status: 'skipped', reason: 'settings_incomplete', missing: ['roles.implementer.model'] },
      ],
      [
        { ...DAILY, dailyBudgetUsd: 0 },
        () => undefined,
        { status: 'skipped', reason: 'project_daily_budget_exceeded', missing: [] },
      ],
    ];
    for (const [settings, prepare, expected] of cases) {
      const h = storeHarness(settings);
      prepare(h);
      const edit = humanEdit(h, { statement: NEW_STATEMENT });
      expect(startEdit(h, edit.seq)).toEqual(expected);
      expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, exe: 0 });
      expect(
        h.read((store) => store.db.prepare('SELECT count(*) AS n FROM auto_start_skips').get()),
      ).toEqual({ n: 0 });
    }
  });

  it('원자성: 실행을 저장한 뒤 자동 시작 항목 쓰기만 실패하면 실행 · 표시 ID 순번이 남지 않는다', () => {
    const h = storeHarness();
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    h.read((store) =>
      store.db.exec(`CREATE TRIGGER test_block BEFORE INSERT ON norm_changes
        BEGIN SELECT RAISE(ABORT, '강제 실패'); END`),
    );
    expect(() => startEdit(h, edit.seq)).toThrow(/강제 실패/);
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, exe: 0 });
    h.read((store) => store.db.exec('DROP TRIGGER test_block'));
    expect(startEdit(h, edit.seq).status).toBe('started');
  });

  it('신규 기록 순번과 승인 기록 순번이 같은 수여도 서로를 원인으로 쓰지 않는다: 규칙 작성 뒤 자동 시작과 편집 뒤 자동 시작이 둘 다 생기고 둘 다 대조를 통과한다', () => {
    const h = storeHarness();
    const session = newId();
    // 규범 변경 기록 1번 = 규칙 작성 역할의 신규 기록
    const created = h.read(
      (store) =>
        createAgentRule(
          store,
          {
            payload: {
              title: '버전',
              statement:
                'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답에 버전을 담는다',
              kind: 'business',
              checkKinds: ['test'],
              targetBlocks: ['health'],
              risk: 'medium',
              parentRequirementId: h.requirementId,
            },
            rationale: '시험 근거',
            author: { kind: 'agent', role: 'rule-writer' },
            sessionId: session,
            contradiction: { verdict: 'none' },
            normInput: {
              requirements: { total: 1, included: 1, omitted: 0 },
              rules: { total: 0, included: 0, omitted: 0 },
              truncated: false,
            },
          },
          clock,
        ).normChange,
    );
    // 승인 기록 1번 = 사람의 다른 규칙 편집
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    expect([created.seq, edit.seq]).toEqual([1, 1]);
    const byEdit = startEdit(h, edit.seq);
    const bySession = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (byEdit.status !== 'started' || bySession.status !== 'started') {
      throw new Error('둘 다 시작해야 한다');
    }
    const [sessionRun] = bySession.runs;
    if (sessionRun === undefined) throw new Error('실행 없음');
    expect(sessionRun.detail.run.targetRuleIds).toEqual([created.targetRef.id]);
    expect(byEdit.detail.run.targetRuleIds).toEqual([h.ruleId]);
    h.read((store) => {
      expect(checkRunStartBasis(store, byEdit.detail.run).mismatch).toBeNull();
      expect(checkRunStartBasis(store, sessionRun.detail.run).mismatch).toBeNull();
    });
  });
});

describe('엔진 시작 근거 대조: 규칙 편집이 원인인 실행 (ADR-107 대조 표에 더함, ADR-109)', () => {
  /** 실행 1개를 원하는 시작 주체로 저장하고 자동 시작 항목을 원하는 상세로 붙인다 (위조 흉내, 테스트 전용). */
  const forge = (
    h: StoreHarness,
    startedBy: Run['startedBy'],
    detail: NormChangeEntry['detail'] | null,
  ): Run =>
    h.read((store) =>
      store.transaction(() => {
        const runId = newId();
        const saved = saveNewRun(
          store,
          store.settings.get(),
          { runId, ruleIds: [h.ruleId], startedBy },
          new Date().toISOString(),
          newId,
        );
        if (detail !== null) {
          store.normChanges.append({
            at: new Date().toISOString(),
            kind: 'auto_start',
            actor: { kind: 'orchestrator' },
            targetRef: { entity: 'Run', id: runId },
            sessionId: null,
            runId,
            reason: '위조',
            detail,
          });
        }
        return saved.run;
      }),
    );
  const mismatchOf = (h: StoreHarness, run: Run) =>
    h.read((store) => checkRunStartBasis(store, run).mismatch);
  const byEdit = (seq: number): Run['startedBy'] => ({
    kind: 'orchestrator',
    causeSeqs: [seq],
    causeLog: 'approval_log',
  });

  it('원인이 진술을 바꾼 그 규칙의 사람 편집이 아니면 cause_mismatch: 제목만 바꾼 편집 · 확인 기록 · 다른 규칙의 편집 · 없는 순번 · 항목이 신규 기록 칸(causeSeqs)을 씀 · 주체에 승인 기록 표시가 없음', () => {
    const h = storeHarness();
    const titleOnly = humanEdit(h, { title: '제목만' });
    expect(
      mismatchOf(
        h,
        forge(h, byEdit(titleOnly.seq), { ruleEditSeqs: [titleOnly.seq], ruleIds: [h.ruleId] }),
      ),
    ).toBe('cause_mismatch');
    const statement = humanEdit(h, { statement: NEW_STATEMENT });
    // 다른 규칙의 진술 편집을 원인으로 씀
    const other = h.read((store) =>
      store.rules.create({
        id: newId(),
        title: '다른 규칙',
        statement: 'WHEN 클라이언트가 GET /api/version을 요청하면 THE SYSTEM SHALL 버전을 돌려준다',
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: h.requirementId,
        builtin: false,
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: human as Author,
        normState: 'approved',
        createdAt: new Date().toISOString(),
      }),
    );
    const otherEdit = humanEdit(
      h,
      {
        statement:
          'WHEN 클라이언트가 GET /api/version을 요청하면 THE SYSTEM SHALL 버전과 커밋을 돌려준다',
      },
      other.id,
    );
    expect(
      mismatchOf(
        h,
        forge(h, byEdit(otherEdit.seq), { ruleEditSeqs: [otherEdit.seq], ruleIds: [h.ruleId] }),
      ),
    ).toBe('cause_mismatch');
    expect(mismatchOf(h, forge(h, byEdit(999), { ruleEditSeqs: [999], ruleIds: [h.ruleId] }))).toBe(
      'cause_mismatch',
    );
    // 항목이 원인을 신규 기록 칸에 씀 (편집 원인 실행과 맞지 않음)
    expect(
      mismatchOf(
        h,
        forge(h, byEdit(statement.seq), { causeSeqs: [statement.seq], ruleIds: [h.ruleId] }),
      ),
    ).toBe('cause_mismatch');
    // 주체가 신규 기록 원인(causeLog 없음)인데 항목은 편집 원인
    expect(
      mismatchOf(
        h,
        forge(
          h,
          { kind: 'orchestrator', causeSeqs: [statement.seq] },
          {
            ruleEditSeqs: [statement.seq],
            ruleIds: [h.ruleId],
          },
        ),
      ),
    ).toBe('cause_mismatch');
  });

  it('항목의 대상 규칙이 실행과 다르면 rules_mismatch', () => {
    const h = storeHarness();
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    expect(
      mismatchOf(h, forge(h, byEdit(edit.seq), { ruleEditSeqs: [edit.seq], ruleIds: [newId()] })),
    ).toBe('rules_mismatch');
  });

  it('같은 편집을 다른 자동 시작 항목도 쓰면 cause_reused, 항목이 없으면 no_entry, 사람 주체면 starter_mismatch', () => {
    const h = storeHarness();
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    const legit = startEdit(h, edit.seq);
    if (legit.status !== 'started') throw new Error('시작 안 됨');
    expect(mismatchOf(h, legit.detail.run)).toBeNull();
    const copy = forge(h, byEdit(edit.seq), { ruleEditSeqs: [edit.seq], ruleIds: [h.ruleId] });
    expect(mismatchOf(h, copy)).toBe('cause_reused');
    // 처음 실행도 이제 같은 원인을 다른 항목이 쓰므로 거부된다
    expect(mismatchOf(h, legit.detail.run)).toBe('cause_reused');
    expect(mismatchOf(h, forge(h, byEdit(edit.seq), null))).toBe('no_entry');
    expect(
      mismatchOf(h, forge(h, { kind: 'human' }, { ruleEditSeqs: [edit.seq], ruleIds: [h.ruleId] })),
    ).toBe('starter_mismatch');
  });
});

describe('RuleEditAutoStarter: 편집 뒤 → 자동 시작 → 엔진 (ADR-109)', () => {
  it('시작하면 엔진의 생성 뒤 처리를 한 번 부르고 응답 값을 돌려준다. 대기 실행 · 생략 · 같은 편집 다시는 엔진을 부르지 않는다. 저장소를 열 수 없으면 로그만', () => {
    const h = storeHarness();
    const created: string[] = [];
    const logs: string[] = [];
    const starter = new RuleEditAutoStarter({
      biveHome: h.biveHome,
      engine: { onRunCreated: (projectId, runId) => created.push(`${projectId}:${runId}`) },
      log: (line) => logs.push(line),
    });
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    const result = starter.afterRuleEdit(h.projectId, edit.seq);
    const run = h.read((store) => store.runs.list()[0]);
    if (run === undefined) throw new Error('실행 없음');
    expect(result).toEqual({ state: 'started', runId: run.id, runDisplayId: 'EXE-001' });
    expect(created).toEqual([`${h.projectId}:${run.id}`]);
    // 같은 편집 다시: 기록 · 엔진 호출 없음 (승인 대기 실행이 그 규칙을 대상으로 있으므로 pending이 아니라 duplicate가 먼저)
    expect(starter.afterRuleEdit(h.projectId, edit.seq)).toBeNull();
    // 새 편집: 그 규칙의 승인 대기 실행이 있어 만들지 않음
    const again = humanEdit(h, {
      statement:
        'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답에 UTC 시각을 담는다',
    });
    expect(starter.afterRuleEdit(h.projectId, again.seq)).toEqual({
      state: 'pending',
      runId: run.id,
      runDisplayId: 'EXE-001',
    });
    expect(created).toHaveLength(1);
    expect(starter.afterRuleEdit('01JZZZZZZZZZZZZZZZZZZZZZZZ', 1)).toBeNull();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe(
      `규칙 편집 뒤 실행 자동 시작 (EXE-001, 승인 기록 ${String(edit.seq)}, 규범 변경 기록 1)`,
    );
    expect(logs[1]).toMatch(/^규칙 편집 뒤 실행 자동 시작 실패 \(승인 기록 1\)/);
  });
});

describe('RuleEditAutoStarter: 생략은 기록 없이 응답 · 로그로만, 결과 → 응답 값', () => {
  it('하루 한도가 비어 있으면 엔진을 부르지 않고 생략을 돌려주며 로그 한 줄을 남긴다. 원인 아님 · 같은 편집은 null', () => {
    const h = storeHarness(COMPLETE_SETTINGS);
    const created: string[] = [];
    const logs: string[] = [];
    const starter = new RuleEditAutoStarter({
      biveHome: h.biveHome,
      engine: { onRunCreated: (_p, runId) => created.push(runId) },
      log: (line) => logs.push(line),
    });
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    expect(starter.afterRuleEdit(h.projectId, edit.seq)).toEqual({
      state: 'skipped',
      reason: 'project_daily_budget_unset',
      missing: [],
    });
    const titleOnly = humanEdit(h, { title: '제목만' });
    expect(starter.afterRuleEdit(h.projectId, titleOnly.seq)).toBeNull();
    expect(created).toEqual([]);
    expect(logs).toEqual([
      `규칙 편집 뒤 실행 자동 시작 생략 (승인 기록 ${String(edit.seq)}, project_daily_budget_unset)`,
    ]);
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, exe: 0 });
  });
});

describe('오케스트레이터 · 파이프: 사람의 진술 편집 → 실행 자동 시작 (수용 기준 2, ADR-109)', () => {
  const testWriting: StepExecutor = (context) => {
    // 대상 규칙 폴더를 새 진술로 다시 쓴 것과 같은 자리 (테스트 작성 단계의 대역)
    fs.writeFileSync(path.join(context.git.worktreePath, `edit-${context.run.displayId}.txt`), 'x');
    return Promise.resolve({ status: 'passed' });
  };
  const pass: StepExecutor = () => Promise.resolve({ status: 'passed' });

  const start = async (redCheck: StepExecutor) => {
    const h = storeHarness();
    const result = await startOrchestrator({
      biveHome: h.biveHome,
      idleShutdownMs: 60_000,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome, pollIntervalMs: 10 }),
      executors: testExecutors({
        test_writing: testWriting,
        red_check: redCheck,
        implementation: pass,
        check: pass,
        merge: mergeStep,
      }),
    });
    if (result.status !== 'started') throw new Error('기동 실패');
    const client = await connect(result.orchestrator.paths.pipe, result.orchestrator.token);
    running.push({ orchestrator: result.orchestrator, client });
    return { h, client };
  };

  it('진술을 고치면 응답에 자동 시작한 실행이 실리고 그 실행이 사람 조작 없이 병합된다. 승인 기록은 편집 1건, 규범 변경 기록은 자동 시작 1건. 제목만 고치면 실행이 없다', async () => {
    const { h, client } = await start(scripted(['passed']));
    const titled = await client.call('rule.update', {
      projectId: h.projectId,
      id: h.ruleId,
      author: human,
      title: '헬스 체크 서버 시각 (ISO)',
    });
    expect(titled.autoStart).toBeNull();
    const edited = await client.call('rule.update', {
      projectId: h.projectId,
      id: h.ruleId,
      author: human,
      statement: NEW_STATEMENT,
    });
    const { runs } = await client.call('run.list', { projectId: h.projectId });
    expect(runs).toHaveLength(1);
    const [run] = runs;
    if (run === undefined) throw new Error('실행 없음');
    expect(edited.autoStart).toEqual({ state: 'started', runId: run.id, runDisplayId: 'EXE-001' });
    expect(run).toMatchObject({
      targetRuleIds: [h.ruleId],
      startedBy: {
        kind: 'orchestrator',
        causeSeqs: [edited.approvalLog.seq],
        causeLog: 'approval_log',
      },
    });
    await waitFor(
      async () =>
        (await client.call('run.get', { projectId: h.projectId, id: run.id })).run.status ===
        'merged',
      30_000,
      '편집 뒤 실행 병합',
    );
    const approvals = await client.call('approvalLog.list', { projectId: h.projectId });
    expect(approvals.entries.map((entry) => entry.action)).toEqual(['rule_edit', 'rule_edit']);
    const changes = await client.call('normChange.list', { projectId: h.projectId });
    expect(changes.chain.valid).toBe(true);
    expect(changes.entries.map((entry) => [entry.kind, entry.detail])).toEqual([
      ['auto_start', { ruleEditSeqs: [edited.approvalLog.seq], ruleIds: [h.ruleId] }],
    ]);
    // 규칙은 새 진술 · 확인됨(근거 = 진술 편집) 그대로
    expect(
      (await client.call('rule.get', { projectId: h.projectId, id: h.ruleId })).rule,
    ).toMatchObject({
      statement: NEW_STATEMENT,
      confirmation: {
        state: 'confirmed',
        basis: { kind: 'approval_log', seq: edited.approvalLog.seq },
      },
    });
  }, 60_000);

  it('Red 확인을 넘지 못하면(새 진술로 다시 쓴 테스트가 이미 통과: 문구만 다듬은 편집) 테스트 작성 재시도 상한 뒤 실행이 실패로 끝난다. 편집 · 확인됨은 그대로다', async () => {
    const { h, client } = await start(scripted(['unmet']));
    const edited = await client.call('rule.update', {
      projectId: h.projectId,
      id: h.ruleId,
      author: human,
      statement: NEW_STATEMENT,
    });
    if (edited.autoStart?.state !== 'started') throw new Error('시작 안 됨');
    const runId = edited.autoStart.runId;
    await waitFor(
      async () =>
        (await client.call('run.get', { projectId: h.projectId, id: runId })).run.status ===
        'failed',
      30_000,
      '편집 뒤 실행 실패',
    );
    const detail = await client.call('run.get', { projectId: h.projectId, id: runId });
    // Red 확인 미충족 3번(처음 + 재시도 2회) 뒤 실패. Red 확인을 대상에서 빼고 넘어가는 길은 없다 (ADR-110)
    expect(detail.run.failureReason).toBe('test_retry_limit');
    expect(
      detail.steps.filter((step) => step.kind === 'red_check').map((step) => step.status),
    ).toEqual(['failed', 'failed', 'failed']);
    expect(
      (await client.call('rule.get', { projectId: h.projectId, id: h.ruleId })).rule,
    ).toMatchObject({
      statement: NEW_STATEMENT,
      confirmation: { state: 'confirmed' },
    });
  }, 60_000);
});

describe('실행 대기에서 시작할 차례의 하루 한도 문: 편집 원인 실행에도 (ADR-111 · ADR-109)', () => {
  /** 승인 단계를 통과해 실행 대기에 선 모양으로 둔다 (엔진의 승인 단계 판정 대역, 테스트 전용). */
  const toQueued = (h: StoreHarness, runId: string): void =>
    h.read((store) => {
      const at = new Date().toISOString();
      store.db
        .prepare(
          "UPDATE steps SET status = 'passed', ended_at = ? WHERE run_id = ? AND kind = 'approval'",
        )
        .run(at, runId);
      store.db
        .prepare(
          "UPDATE runs SET status = 'queued', current_step = 'test_writing', last_completed_step = 'approval' WHERE id = ?",
        )
        .run(runId);
    });

  it('대기 중인 편집 원인 실행이 차례에 하루 한도에 이르렀으면 작업 폴더 · 브랜치 없이 budget_exceeded(project_daily_budget_exceeded)로 끝나고 다음 대기(사람 실행)가 시작한다', () => {
    const h = storeHarness();
    const edit = humanEdit(h, { statement: NEW_STATEMENT });
    const byEdit = startEdit(h, edit.seq);
    if (byEdit.status !== 'started') throw new Error('시작 안 됨');
    const human = h.read((store) =>
      saveNewRun(
        store,
        store.settings.get(),
        { runId: newId(), ruleIds: [h.ruleId], startedBy: { kind: 'human' } },
        new Date().toISOString(),
        newId,
      ),
    );
    toQueued(h, byEdit.detail.run.id);
    toQueued(h, human.run.id);
    // 대기하는 사이 오늘 지출이 한도에 이름 (한도 0)
    h.read((store) =>
      store.settings.update(
        { dailyBudgetUsd: 0 },
        { by: { kind: 'human' }, at: new Date().toISOString() },
      ),
    );
    const advance = h.read((store) => startNextQueuedRun(store, { now: Date.now }));
    expect(advance.failed.map((detail) => detail.run)).toEqual([
      expect.objectContaining({
        id: byEdit.detail.run.id,
        status: 'budget_exceeded',
        failureReason: 'project_daily_budget_exceeded',
        branch: null,
        worktreePath: null,
        startedAt: null,
      }),
    ]);
    expect(advance.started?.run).toMatchObject({ id: human.run.id, status: 'running' });
  });
});
