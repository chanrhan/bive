// 파이프라인 e2e: 변이 생존 → 자동 테스트 보강 → 재주입 검출 (M3-54 #311 수용 기준 1, ADR-100 B④ · ADR-141 · ADR-143,
// roadmap M3 완료 기준 흐름 3). 실제 판정 러너(커밋의 깨끗한 체크아웃 · 설치 · next build · next start · vitest)로만 판정한다.
// 1. 블록 선언 저장(내장 구조 규칙 RULE-001 · 002) → 하루 한도 채움 → 요구사항 저장 → 규칙 작성 세션이 RULE-003 → 자동 시작 EXE-001(유형 A)
// 2. EXE-001: 약한 인수 테스트 · 구현 · 검사 → 변이 주입(생략 아님): 서비스 이름을 바꾸는 변이가 살아남음 → 병합, 규칙 '변이 생존'
// 3. 사람 조작 없이 EXE-002(유형 C 보강): 테스트 작성(새 보강 테스트 파일만, 기존 테스트는 바이트까지 그대로) → Green 확인 → 구현 생략 → 검사 → 변이 주입 = 같은 변이 재주입 → 검출
//    → 규칙 '변이 검증됨' → 병합. 변이는 main · 어떤 ref에도 없다
// 카드 예외 표시는 M3-15의 몫이라 여기서는 저장된 변이 상태를 본다(변이 상태를 내는 RPC는 아직 없다).
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../test/helpers/process.js';
import {
  attempts,
  cleanupPipeline,
  git,
  human,
  mainTip,
  readStore,
  ROUTE,
  saveRequirement,
  startPipeline,
  waitForRunCreated,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

/** 실행 하나의 제한 시간 (판정 두 번: 구현 · 검사 + 병합 재검사 · 변이 판정, 각각 설치 · 빌드). */
const RUN_TIMEOUT_MS = 12 * 60_000;

const SAMPLE_BLOCKS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'blocks', 'sample-next-app.json'), 'utf8'),
) as unknown;

describe('mutant-survives: 변이 생존 → 자동 보강(유형 C) → 재주입 검출 → 변이 검증됨', () => {
  it(
    '첫 실행은 변이가 살아남은 채 병합되고, 사람 조작 없이 생긴 보강 실행이 같은 변이를 재주입해 잡아 그 규칙이 변이 검증됨이 된다',
    async () => {
      const e = await startPipeline('mutant-survives');
      const base = mainTip(e);
      await e.client.call('blocks.set', {
        projectId: e.projectId,
        author: human,
        declaration: SAMPLE_BLOCKS,
      });
      // 하루 한도를 채운다 (비어 있으면 자동 시작 없음, ADR-100 B⑤)
      await e.client.call('settings.update', {
        projectId: e.projectId,
        patch: { dailyBudgetUsd: 10 },
        author: human,
      });
      const { rules, autoStartedRunId } = await saveRequirement(
        e,
        '헬스 체크 응답에 서비스 이름 포함',
        1,
        { autoStart: 'started' },
      );
      const [rule] = rules;
      if (rule === undefined || autoStartedRunId === null) throw new Error('규칙 · 실행 없음');
      expect(rule.displayId).toBe('RULE-003');

      // ── 첫 실행 (유형 A): 변이 주입 단계가 돌고 변이는 살아남지만 실행은 병합된다 ──
      const first = await waitForRunEnd(e, autoStartedRunId, RUN_TIMEOUT_MS);
      expect(first.run).toMatchObject({ displayId: 'EXE-001', type: 'A', status: 'merged' });
      expect(attempts(first, 'mutation')).toEqual(['mutation#1:passed']);
      const firstResults = readStore(e, (store) => store.mutations.listByRun(first.run.id));
      expect(firstResults.map((item) => [item.status, item.outcome, item.mutant?.path])).toEqual([
        ['survived', 'survived', ROUTE],
      ]);
      expect(first.sessions?.map((session) => session.role)).toEqual([
        'test-writer',
        'implementer',
        'mutator',
      ]);

      const weakTest = 'bive-acceptance/RULE-003/health-service.acc.ts';
      const weakBytes = git(e.repo, 'show', `main:${weakTest}`);

      // ── 보강 실행 (유형 C): 사람의 [실행] 없이 생긴다 ──
      const created = await waitForRunCreated(e, 'EXE-002', 60_000);
      const second = await waitForRunEnd(e, created.id, RUN_TIMEOUT_MS);
      expect(second.run).toMatchObject({
        type: 'C',
        status: 'merged',
        targetRuleIds: [rule.id],
        startedBy: { kind: 'orchestrator', causeLog: 'mutation_reinforcements' },
      });
      expect(attempts(second)).toEqual([
        'approval#1:passed',
        'test_writing#1:passed',
        'green_check#1:passed',
        'implementation#1:skipped',
        'check#1:passed',
        'mutation#1:passed',
        'merge#1:passed',
        'screen_update#1:passed',
      ]);
      // 재주입은 새 변이 세션 없이 같은 변이를 다시 적용했다
      expect(second.sessions?.map((session) => session.role)).toEqual(['test-writer']);
      const reinjected = readStore(e, (store) => store.mutations.listByRun(second.run.id));
      expect(reinjected.map((item) => [item.status, item.outcome, item.mutant])).toEqual([
        ['verified', 'killed', firstResults[0]?.mutant],
      ]);
      expect(readStore(e, (store) => store.mutations.statusOf(rule.id))).toBe('verified');
      // 시작 근거: 자동 시작 항목의 원인 = 첫 실행의 생존 기록
      const autoStart = readStore(e, (store) =>
        store.normChanges
          .list()
          .find((entry) => entry.kind === 'auto_start' && entry.targetRef.id === second.run.id),
      );
      expect(autoStart?.detail).toEqual({
        mutationResultIds: [firstResults[0]?.id],
        ruleIds: [rule.id],
      });

      // 보강은 더하기만 한다: 세션은 새 파일 하나만 냈고, main의 기존 인수 테스트는 바이트까지 그대로다 (ADR-143 ⑮)
      expect(git(e.repo, 'show', `main:${weakTest}`)).toBe(weakBytes);
      expect(
        git(e.repo, 'ls-tree', '-r', '--name-only', 'main', 'bive-acceptance/RULE-003/').split(
          '\n',
        ),
      ).toEqual(['bive-acceptance/RULE-003/health-service-name.acc.ts', weakTest]);
      expect(
        git(
          e.repo,
          'diff',
          '--name-only',
          first.run.mergeCommit ?? '',
          'main',
          '--',
          'bive-acceptance/RULE-003/',
        ).split('\n'),
      ).toEqual(['bive-acceptance/RULE-003/health-service-name.acc.ts']);
      // 변이는 main · 어떤 ref에도 없고, main에는 보강 테스트가 들어왔다
      expect(git(e.repo, 'log', '--all', '-S', 'unknown-service', '--format=%H')).toBe('');
      expect(git(e.repo, 'show', `main:${ROUTE}`)).toContain("service: 'sample-next-app'");
      expect(git(e.repo, 'diff', '--name-only', base, 'main').split('\n')).toEqual(
        expect.arrayContaining([
          'bive-acceptance/RULE-003/health-service.acc.ts',
          'bive-acceptance/RULE-003/health-service-name.acc.ts',
        ]),
      );
      // 고리 없음: 보강 실행의 재주입 결과로 새 실행이 생기지 않는다
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const { runs } = await e.client.call('run.list', { projectId: e.projectId });
      expect(runs.map((run) => run.displayId)).toEqual(['EXE-001', 'EXE-002']);
    },
    30 * 60_000,
  );
});
