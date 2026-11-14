// 규칙 상세 표시 규칙 (이슈 #41, screens.md SCR-03 상세 · SCR-06 · 1.4 상세 접힘, ADR-073).
import { type JudgmentCase, type JudgmentResult, TestCaseStatus } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  CASE_STATUS_LABELS,
  caseCountText,
  caseLocation,
  checkKindsText,
  failureCases,
  latestRunDisplayId,
  outputOpenByDefault,
  ruleAuthorName,
  shortCommit,
} from '../src/renderer/src/screens/norm-detail/ruleDetailView.js';

const testCase = (name: string, status: JudgmentCase['status'], line: number | null = 3) => ({
  name,
  file: 'bive-acceptance/RULE-001/a.acc.ts',
  line,
  status,
  message: status === 'passed' ? null : `${name} 실패`,
});

const judgment = (patch: Partial<JudgmentResult> = {}): JudgmentResult => ({
  id: '01JD0000000000000000000001',
  ruleId: '01JC0000000000000000000001',
  runId: '01JE0000000000000000000001',
  stepId: null,
  commit: 'abcdef1234'.padEnd(40, '0'),
  judgedAt: '2026-10-16T02:00:00.000Z',
  status: 'fail',
  runner: 'vitest',
  exitCode: 1,
  reporterPath: null,
  cases: [],
  quarantineReason: null,
  ...patch,
});

describe('규칙 상세 표시', () => {
  it('케이스 상태 표시명은 실행기 상태 전부를 덮는다', () => {
    expect(Object.keys(CASE_STATUS_LABELS).sort()).toEqual([...TestCaseStatus.options].sort());
  });

  it('위치는 file:line, 줄을 모르면 파일만', () => {
    expect(caseLocation({ file: 'a.acc.ts', line: 18 })).toBe('a.acc.ts:18');
    expect(caseLocation({ file: 'a.acc.ts', line: null })).toBe('a.acc.ts');
  });

  it('실패 원인은 통과하지 않은 케이스이고 실패가 먼저다 (건너뜀도 통과 아님)', () => {
    const cases = [
      testCase('건너뜀', 'skipped'),
      testCase('통과', 'passed'),
      testCase('실패', 'failed'),
    ];
    expect(failureCases(cases).map((item) => item.name)).toEqual(['실패', '건너뜀']);
    expect(failureCases([testCase('통과', 'passed')])).toEqual([]);
  });

  it('케이스 개수는 0건 상태를 빼고, 케이스가 없으면 null', () => {
    expect(
      caseCountText([testCase('a', 'failed'), testCase('b', 'passed'), testCase('c', 'passed')]),
    ).toBe('통과 2 · 실패 1');
    expect(caseCountText([])).toBeNull();
  });

  it('테스트 출력은 최신 판정이 실패일 때만 처음부터 펼친다', () => {
    expect(outputOpenByDefault(judgment({ status: 'fail' }))).toBe(true);
    expect(outputOpenByDefault(judgment({ status: 'pass', exitCode: 0 }))).toBe(false);
    expect(outputOpenByDefault(judgment({ status: 'needs_recheck' }))).toBe(false);
    expect(outputOpenByDefault(null)).toBe(false);
  });

  it('최신 판정의 실행 ID는 이력의 같은 기록에서만 찾는다', () => {
    const latest = judgment();
    expect(latestRunDisplayId(latest, [{ judgment: latest, runDisplayId: 'EXE-003' }])).toBe(
      'EXE-003',
    );
    expect(latestRunDisplayId(latest, null)).toBeNull();
    expect(
      latestRunDisplayId(latest, [
        { judgment: judgment({ id: '01JD0000000000000000000002' }), runDisplayId: 'EXE-001' },
      ]),
    ).toBeNull();
    expect(latestRunDisplayId(null, [])).toBeNull();
  });

  it('생성 주체는 이름(에이전트는 역할명), 검사 종류 · 커밋 표기', () => {
    expect(ruleAuthorName({ kind: 'agent', role: 'rule-writer' })).toBe('에이전트 · 규칙 작성');
    expect(ruleAuthorName({ kind: 'human' })).toBe('사람');
    expect(checkKindsText(['test', 'static'])).toBe('인수 테스트 · 정적 분석');
    expect(shortCommit('abcdef1234')).toBe('abcdef1');
  });
});
