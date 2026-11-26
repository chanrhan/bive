// 파이프라인 e2e: 실행 유형 B (M3-06 #51 수용 기준 4 · 5, RUN-07, ADR-020 · ADR-136, roadmap M3 완료 기준 흐름 1).
// 정적 검사 규칙(내장 방향 규칙 · OpenAPI 계약 검사 규칙)의 [실행](run.create, 유형을 주지 않음)이 유형 B 실행을 만들고, 테스트 작성 ·
// Red 확인을 생략한 채 구현 세션이 위반을 고치면 검사 단계(구조 검사 · 계약 검사 · 기존 인수 테스트, 실제 판정 러너)가 통과해 병합된다.
// 1. 요구사항 저장 → 규칙 작성 세션이 인수 테스트 검사 규칙 RULE-001(ok 유지)을 만든다. 그 인수 테스트는 사람이 기준 브랜치에 올린다
//    (유형 B에는 테스트 작성 단계가 없다)
// 2. 블록 선언 저장(내장 구조 규칙 두 개) → `undeclared-import` 변형 → 방향 규칙 [실행] → 유형 B 병합
// 3. 계약 등록(openapi.yaml, 계약 검사 규칙) → `contract-mismatch` 변형 → 계약 검사 규칙 [실행] → 유형 B 병합
// 판정은 실제 판정 러너(커밋의 깨끗한 체크아웃 · 설치 · next build · next start · vitest) · 실제 파서 · 실제 계약 도구로만 정한다.
import fs from 'node:fs';
import path from 'node:path';

import type { Rule } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_STRUCTURE_RULE_TEXTS } from '../../src/norms/builtin-rules.js';
import { REPO_ROOT } from '../../test/helpers/process.js';
import {
  attempts,
  cleanupPipeline,
  commitAsUser,
  git,
  human,
  mainTip,
  mergeCount,
  readStore,
  saveRequirement,
  startPipeline,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

/** RULE-001의 인수 테스트 (사람이 기준 브랜치에 올림): 헬스 체크 응답의 ok가 true. */
const RULE1_ACCEPTANCE = 'bive-acceptance/RULE-001/health-ok.acc.ts';
const RULE1_SOURCE = `// RULE-001: 헬스 체크 연결 상태. 기동된 서버에 HTTP로만 요청한다.
import { describe, expect, inject, it } from 'vitest';

describe('GET /api/health 연결 상태', () => {
  it('응답 JSON의 ok가 true다', async () => {
    const res = await fetch(new URL('/api/health', inject('baseUrl')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: unknown };
    expect(body.ok).toBe(true);
  });
});
`;

const SAMPLE_BLOCKS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'blocks', 'sample-next-app.json'), 'utf8'),
) as unknown;

/**
 * `scripts/make-variant.sh`의 두 변형과 같은 파일 내용을 사람 커밋으로 기준 브랜치에 올린다. 그 스크립트는 깨끗한 작업 트리만 받는데,
 * 등록된 프로젝트 폴더에는 BIVE의 미추적 파일(`.bive.json`)이 있어 스크립트를 그대로 부를 수 없다.
 */
const VARIANTS = {
  'undeclared-import': {
    file: 'src/app/api/health/session-probe.ts',
    content: `import { GET as getSession } from '@/app/api/auth/session/route';

/** 변형 undeclared-import: health 블록이 선언하지 않은 auth 블록을 가져온다. */
export function probeSession(): Response {
  return getSession();
}
`,
  },
  'contract-mismatch': {
    file: 'src/app/api/health/route.ts',
    content: `import { getDb } from '@/lib/db';

// 요청마다 실행한다(빌드 시점 정적 생성 금지).
export const dynamic = 'force-dynamic';

/** 변형 contract-mismatch: 계약(openapi.yaml)은 ok를 boolean으로 정하지만 글을 돌려준다. */
export async function GET(): Promise<Response> {
  await getDb().item.count();
  return Response.json({ ok: 'true' });
}
`,
  },
} as const;

const makeVariant = (repo: string, name: keyof typeof VARIANTS): void => {
  const { file, content } = VARIANTS[name];
  commitAsUser(repo, file, content, `variant: ${name}`);
};

const B_STEPS = [
  'approval#1:passed',
  'test_writing#1:skipped',
  'red_check#1:skipped',
  'implementation#1:passed',
  'check#1:passed',
  'mutation#1:skipped',
  'merge#1:passed',
  'screen_update#1:passed',
];

describe('run-type-b: 정적 검사 규칙 [실행] → 유형 B → 구현이 고침 → 검사 통과 → 병합', () => {
  it('내장 방향 규칙(undeclared-import 변형)과 OpenAPI 계약 검사 규칙(contract-mismatch 변형) 각각 유형 B 실행이 병합된다', async () => {
    const e = await startPipeline('run-type-b');
    const { rules } = await saveRequirement(e, '헬스 체크 응답으로 연결 상태 확인', 1);
    const [rule1] = rules;
    if (rule1 === undefined) throw new Error('규칙 없음');
    expect(rule1.displayId).toBe('RULE-001');
    fs.mkdirSync(path.join(e.repo, 'bive-acceptance', 'RULE-001'), { recursive: true });
    commitAsUser(e.repo, RULE1_ACCEPTANCE, RULE1_SOURCE, 'test: RULE-001 인수 테스트');

    // ── 1. 내장 방향 규칙 ──
    await e.client.call('blocks.set', {
      projectId: e.projectId,
      author: human,
      declaration: SAMPLE_BLOCKS,
    });
    const listed = (await e.client.call('rule.list', { projectId: e.projectId })).rules.map(
      (item) => item.rule,
    );
    const builtin = (key: keyof typeof BUILTIN_STRUCTURE_RULE_TEXTS): Rule => {
      const found = listed.find(
        (rule) => rule.builtin && rule.title === BUILTIN_STRUCTURE_RULE_TEXTS[key].title,
      );
      if (found === undefined) throw new Error(`내장 규칙 없음: ${key}`);
      return found;
    };
    const direction = builtin('structure.declared-direction');
    const publicApi = builtin('structure.public-api-only');
    // 시나리오의 구현 세션은 대상 규칙의 표시 ID로 고른다
    expect([publicApi.displayId, direction.displayId]).toEqual(['RULE-002', 'RULE-003']);
    makeVariant(e.repo, 'undeclared-import');
    const structureBase = mainTip(e);

    // 화면의 [실행]과 같은 요청(유형을 주지 않는다)이 유형 B 실행을 만든다
    const structureRun = (
      await e.client.call('run.create', {
        projectId: e.projectId,
        ruleIds: [direction.id],
        author: human,
      })
    ).run;
    expect(structureRun).toMatchObject({ type: 'B', targetRuleIds: [direction.id] });
    const structureDone = await waitForRunEnd(e, structureRun.id, 600_000);
    expect(structureDone.run).toMatchObject({
      displayId: 'EXE-001',
      status: 'merged',
      failureReason: null,
      regressionCount: 0,
      baseCommit: structureBase,
    });
    expect(attempts(structureDone)).toEqual(B_STEPS);
    expect(mergeCount(e)).toBe(1);
    expect(
      git(e.repo, 'diff', '--name-only', structureBase, String(structureDone.run.mergeCommit)),
    ).toBe('src/app/api/health/session-probe.ts');
    readStore(e, (store) => {
      const judged = store.judgments.listByRun(structureRun.id);
      expect(
        judged.map((judgment) => [
          listed.find((rule) => rule.id === judgment.ruleId)?.displayId ?? judgment.ruleId,
          judgment.runner,
          judgment.status,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['RULE-001', 'vitest', 'pass'],
          [publicApi.displayId, 'dependency-cruiser', 'pass'],
          [direction.displayId, 'dependency-cruiser', 'pass'],
        ]),
      );
      expect(judged).toHaveLength(3);
      // 세션은 구현 역할 하나뿐 (테스트 작성 · 판단 세션 없음)
      expect(store.sessions.listByRun(structureRun.id).map((session) => session.role)).toEqual([
        'implementer',
      ]);
    });

    // ── 2. OpenAPI 계약 검사 규칙 ──
    const { rule: contractRule } = await e.client.call('contract.register', {
      projectId: e.projectId,
      file: 'openapi.yaml',
      kind: 'openapi',
      author: human,
    });
    expect(contractRule.displayId).toBe('RULE-004');
    makeVariant(e.repo, 'contract-mismatch');
    const contractBase = mainTip(e);
    const contractRun = (
      await e.client.call('run.create', {
        projectId: e.projectId,
        ruleIds: [contractRule.id],
        author: human,
      })
    ).run;
    expect(contractRun).toMatchObject({ type: 'B', targetRuleIds: [contractRule.id] });
    const contractDone = await waitForRunEnd(e, contractRun.id, 600_000);
    expect(contractDone.run).toMatchObject({
      displayId: 'EXE-002',
      status: 'merged',
      failureReason: null,
      regressionCount: 0,
      baseCommit: contractBase,
    });
    expect(attempts(contractDone)).toEqual(B_STEPS);
    expect(mergeCount(e)).toBe(2);
    readStore(e, (store) => {
      const judged = store.judgments
        .listByRun(contractRun.id)
        .filter((judgment) => judgment.ruleId === contractRule.id);
      expect(judged.map((judgment) => [judgment.runner, judgment.status])).toEqual([
        ['redocly-prism', 'pass'],
      ]);
    });
    expect(git(e.repo, 'show', 'main:src/app/api/health/route.ts')).toContain(
      'Response.json({ ok: true })',
    );
  }, 1_500_000);
});
