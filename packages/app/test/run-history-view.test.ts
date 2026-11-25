// 규칙 상세 "실행 이력"의 줄과 실행 종료 사유 표시명 (M3-35 #263, screens.md SCR-03 상세 "실행 이력", ADR-123).
// - 표시명 표는 shared `RUN_FAILURE_REASON_LABELS`와 같고, 그 키 집합은 오케스트레이터 소스가 실행을 끝낼 때 남기는 사유 값의
//   집합과 같다(소스를 글로 읽어 모은다. 값이 늘면 표가 빠져 빨강)
// - 모르는 값은 영어 식별자 대신 "알 수 없는 사유"
// - 실행 하나가 한 줄(검사 · 병합 재검사 판정이 한 줄로), 판정 없이 끝난 실행도 줄이 있다
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AutoStartSkipReason,
  type JudgmentResult,
  RUN_FAILURE_REASON_LABELS,
  RUN_STATUS_LABELS,
  type Run,
  RunFailureReason,
  type RuleJudgmentEntry,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  RUN_FAILURE_REASON_TEXT,
  runFailureReasonText,
  runHistoryRows,
  runStatusText,
  UNKNOWN_FAILURE_REASON_TEXT,
} from '../src/renderer/src/screens/norm-detail/runHistoryView.js';
import { RUN_STATUS_TEXT } from '../src/renderer/src/screens/verification/verificationView.js';

const ORCHESTRATOR_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../orchestrator/src',
);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

/**
 * 오케스트레이터 소스가 `Run.failureReason`으로 남길 수 있는 값:
 * - 엔진 사유 목록 `ENGINE_FAILURE_REASONS`(세션 한도 subtype · 판단 세션을 열지 못한 사유처럼 변수로 넘기는 값도 여기 있다)
 * - 병합 실패 사유 형식 `MergeFailureReason`(병합 실행기가 `halt(result.reason, …)`로 넘긴다)
 * - 실행 대기 시작의 하루 한도 문 사유(`runEnding(run, …, block.reason)`, shared `AutoStartSkipReason`)
 * - 단계 실행기 · 엔진의 종료 호출(`halt(…)` · `#halt(…)` · `runEnding(…)` · `new StepHaltError(…)` · `status: 'halt'` 결과)에
 *   글자로 적힌 사유와 상수 이름(같은 소스의 `export const 이름 = '값'`으로 푼다)
 */
const orchestratorFailureReasons = (): Set<string> => {
  const files = sourceFiles(ORCHESTRATOR_SRC).map((file) => readFileSync(file, 'utf8'));
  const all = files.join('\n');
  const constants = new Map<string, string>();
  for (const match of all.matchAll(/export const ([A-Z][A-Z0-9_]*) = '([a-z_]+)';/g)) {
    constants.set(match[1] ?? '', match[2] ?? '');
  }
  const found = new Set<string>();
  const add = (literal: string | undefined, constant: string | undefined): void => {
    if (literal !== undefined) found.add(literal);
    if (constant !== undefined) {
      const value = constants.get(constant);
      if (value === undefined) throw new Error(`사유 상수를 풀 수 없음: ${constant}`);
      found.add(value);
    }
  };
  const engine = /ENGINE_FAILURE_REASONS = \[([\s\S]*?)\] as const/.exec(all)?.[1];
  const merge = /export type MergeFailureReason =([\s\S]*?)\n\n/.exec(all)?.[1];
  if (engine === undefined || merge === undefined) throw new Error('사유 목록을 찾지 못함');
  for (const m of engine.matchAll(/^\s*'([a-z_]+)',/gm)) add(m[1], undefined);
  for (const m of merge.matchAll(/\|\s*'([a-z_]+)'/g)) add(m[1], undefined);
  for (const value of AutoStartSkipReason.options) found.add(value);
  const reason = String.raw`(?:'([a-z_]+)'|([A-Z][A-Z0-9_]*)\b)`;
  const calls = [
    new RegExp(String.raw`[^#.\w]halt\(\s*${reason}`, 'g'),
    new RegExp(String.raw`#halt\([^;]*?'(?:failed|budget_exceeded)',\s*${reason}`, 'g'),
    new RegExp(String.raw`runEnding\([^,()]+,\s*'(?:failed|budget_exceeded)',\s*${reason}`, 'g'),
    new RegExp(String.raw`StepHaltError\(\s*'(?:failed|budget_exceeded)',\s*${reason}`, 'g'),
    new RegExp(String.raw`status: 'halt',\s*runStatus: [^,]+,\s*reason: ${reason}`, 'g'),
  ];
  for (const pattern of calls) {
    for (const m of all.matchAll(pattern)) add(m[1], m[2]);
  }
  return found;
};

describe('실행 종료 사유 표시명 (shared 대조)', () => {
  it('앱 표 = shared 표, 키 집합 = shared 형식의 값 집합', () => {
    expect(RUN_FAILURE_REASON_TEXT).toEqual(RUN_FAILURE_REASON_LABELS);
    expect(Object.keys(RUN_FAILURE_REASON_TEXT)).toEqual(RunFailureReason.options);
    expect(RUN_STATUS_TEXT).toEqual(RUN_STATUS_LABELS);
  });

  it('shared 형식의 값 집합 = 오케스트레이터 소스가 실행을 끝낼 때 남기는 사유 값의 집합', () => {
    const found = orchestratorFailureReasons();
    // 대표 값이 소스 읽기로 잡히는지 (읽기가 비어 통과하지 않게)
    for (const value of [
      'target_rule_retired',
      'objection_applied',
      'existing_rule_contradiction',
      'project_daily_budget_exceeded',
      'step_error',
      'judge_runner_error',
      'dependency_install_failed',
      'acceptance_ignored',
      'target_rule_unavailable',
      'conflict',
      'vetoed',
    ]) {
      expect(found.has(value), value).toBe(true);
    }
    expect([...found].sort()).toEqual([...RunFailureReason.options].sort());
  });

  it('표시명에 영어 식별자 · 문서 기호가 없다', () => {
    for (const label of Object.values(RUN_FAILURE_REASON_TEXT)) {
      expect(label).not.toMatch(/_|ADR|PRD|SCR|[\u2460-\u24ff]/);
    }
  });

  it('모르는 값(옛 행)은 "알 수 없는 사유", 객체 기본 속성 이름도 모르는 값', () => {
    expect(runFailureReasonText('existing_rule_contradiction')).toBe('기존 규칙 모순');
    expect(runFailureReasonText('old_reason_from_v0')).toBe(UNKNOWN_FAILURE_REASON_TEXT);
    expect(UNKNOWN_FAILURE_REASON_TEXT).toBe('알 수 없는 사유');
    expect(runFailureReasonText('toString')).toBe('알 수 없는 사유');
    expect(runFailureReasonText('__proto__')).toBe('알 수 없는 사유');
  });

  it('실행 상태 글: 실패 · 예산 초과만 사유를 붙인다', () => {
    expect(runStatusText({ status: 'failed', failureReason: 'target_rule_retired' })).toBe(
      '실패 · 대상 규칙 폐기',
    );
    expect(
      runStatusText({ status: 'budget_exceeded', failureReason: 'project_daily_budget_exceeded' }),
    ).toBe('예산 초과 · 프로젝트 하루 예산 초과');
    expect(runStatusText({ status: 'failed', failureReason: 'mystery' })).toBe(
      '실패 · 알 수 없는 사유',
    );
    expect(runStatusText({ status: 'failed', failureReason: null })).toBe('실패');
    expect(runStatusText({ status: 'merged', failureReason: null })).toBe('병합 완료');
    expect(runStatusText({ status: 'interrupted', failureReason: 'step_error' })).toBe('중단');
  });
});

const RULE = '01JC0000000000000000000002';
const OTHER = '01JC0000000000000000000009';
const sha = (c: string): string => c.repeat(40);

const judgment = (id: string, judgedAt: string, status: JudgmentResult['status']) =>
  ({
    id,
    ruleId: RULE,
    runId: null,
    stepId: null,
    commit: sha(id.slice(-1).toLowerCase()),
    judgedAt,
    status,
    runner: 'vitest',
    exitCode: status === 'pass' ? 0 : 1,
    reporterPath: null,
    cases: [],
    quarantineReason: null,
  }) as JudgmentResult;

const entry = (
  id: string,
  judgedAt: string,
  status: JudgmentResult['status'],
  run: string | null,
): RuleJudgmentEntry => ({ judgment: judgment(id, judgedAt, status), runDisplayId: run });

const run = (displayId: string, patch: Partial<Run>): Run =>
  ({
    id: `01JE00000000000000000000${displayId.slice(-2)}`,
    displayId,
    targetRuleIds: [RULE],
    status: 'merged',
    failureReason: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    startedAt: '2026-11-20T00:01:00.000Z',
    endedAt: '2026-11-20T00:10:00.000Z',
    ...patch,
  }) as Run;

describe('실행 이력 줄 (실행 하나가 한 줄)', () => {
  it('한 실행의 검사 · 병합 재검사 판정은 한 줄이고 가장 최근 판정을 싣는다', () => {
    const rows = runHistoryRows(
      RULE,
      [
        entry('01JD000000000000000000000B', '2026-11-21T10:05:00.000Z', 'pass', 'EXE-002'),
        entry('01JD000000000000000000000A', '2026-11-21T10:00:00.000Z', 'fail', 'EXE-002'),
        entry('01JD0000000000000000000001', '2026-11-20T10:00:00.000Z', 'pass', 'EXE-001'),
      ],
      [run('EXE-001', {}), run('EXE-002', {})],
    );
    expect(rows.map((r) => [r.runDisplayId, r.judgment?.id, r.status])).toEqual([
      ['EXE-002', '01JD000000000000000000000B', '병합 완료'],
      ['EXE-001', '01JD0000000000000000000001', '병합 완료'],
    ]);
  });

  it('판정 순서가 섞여 와도 그 실행의 가장 최근 판정을 고른다', () => {
    const rows = runHistoryRows(
      RULE,
      [
        entry('01JD000000000000000000000A', '2026-11-21T10:00:00.000Z', 'fail', 'EXE-002'),
        entry('01JD000000000000000000000B', '2026-11-21T10:05:00.000Z', 'pass', 'EXE-002'),
      ],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.judgment?.id).toBe('01JD000000000000000000000B');
    // 실행 목록을 못 읽었으면 상태 글이 없다
    expect(rows[0]?.status).toBeNull();
  });

  it('판정 없이 끝난 대상 실행(Red 확인 실패 등)도 줄이 있고, 실행 상태와 종료 사유를 보인다', () => {
    const rows = runHistoryRows(
      RULE,
      [entry('01JD0000000000000000000001', '2026-11-20T10:00:00.000Z', 'pass', 'EXE-001')],
      [
        run('EXE-001', {}),
        run('EXE-003', {
          status: 'failed',
          failureReason: 'judge_runner_error',
          endedAt: '2026-11-22T09:00:00.000Z',
        }),
        // 다른 규칙만 대상인 실행은 이 규칙의 판정이 없으면 줄이 없다
        run('EXE-004', { targetRuleIds: [OTHER], endedAt: '2026-11-23T09:00:00.000Z' }),
      ],
    );
    expect(rows.map((r) => [r.runDisplayId, r.judgment?.status ?? null, r.status])).toEqual([
      ['EXE-003', null, '실패 · 판정 실행기 오류'],
      ['EXE-001', 'pass', '병합 완료'],
    ]);
    expect(rows[0]?.at).toBe('2026-11-22T09:00:00.000Z');
  });

  it('판정만 있고 실행 목록에 없는 실행 · 실행 표시 ID가 없는 판정도 줄이 있다', () => {
    const rows = runHistoryRows(
      RULE,
      [
        entry('01JD0000000000000000000002', '2026-11-21T10:00:00.000Z', 'fail', 'EXE-009'),
        entry('01JD0000000000000000000001', '2026-11-20T10:00:00.000Z', 'pass', null),
      ],
      [],
    );
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['run:EXE-009', null],
      ['judgment:01JD0000000000000000000001', null],
    ]);
  });

  it('진행 중인 대상 실행은 생성 · 시작 시각으로 줄이 있고 사유가 없다', () => {
    const rows = runHistoryRows(
      RULE,
      [],
      [run('EXE-005', { status: 'running', endedAt: null, startedAt: '2026-11-24T01:00:00.000Z' })],
    );
    expect(rows.map((r) => [r.runDisplayId, r.at, r.status])).toEqual([
      ['EXE-005', '2026-11-24T01:00:00.000Z', '진행 중'],
    ]);
  });
});
