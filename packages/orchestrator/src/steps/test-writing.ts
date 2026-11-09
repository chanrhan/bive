// 테스트 작성 단계 실행기 (RUN-03 · RUN-04 · JDG-01 · NFR-02, architecture.md 4장 2단계, ADR-024 · ADR-026 · ADR-068).
// 1. 세션 디렉터리 `$BIVE_HOME/work/<projectId>/sessions/<ID>/`(0700)에 허용 입력 사본만 둔다 (`test-writer/inputs.ts`)
// 2. test-writer 세션을 연다: 세션 루트 = 세션 디렉터리, 쓰기는 대상 규칙 폴더 `bive-acceptance/<RULE-ID>/`만
// 3. 종료 조건: 세션이 성공으로 끝나고, 대상 규칙마다 `*.acc.ts`가 1개 이상이고, 모든 파일이 import 허용 목록을 지킨다
//    (`judge/acceptance-lint.ts`). 아니면 `unmet` → 엔진이 새 세션으로 재시도(상한 2회, ADR-026)
// 4. 통과면 결과 파일과 BIVE 선언 파일을 실행 워크트리에 옮기고 `passed` → 엔진이 커밋한다
// 세션 디렉터리는 단계가 끝나면(통과 · 미충족 · 예외 모두) 지운다.
import fs from 'node:fs';
import path from 'node:path';

import { createUlidGenerator, type Step } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { lintAcceptanceSource } from '../judge/acceptance-lint.js';
import {
  applyTestWriterOutputs,
  collectTestWriterOutputs,
  prepareTestWriterInputs,
  type TestWriterRule,
} from '../test-writer/inputs.js';
import { TEST_WRITER_SYSTEM_PROMPT, testWriterTaskPrompt } from '../test-writer/prompts.js';

/** 테스트 작성 단계 미충족 사유 (`exitDetail.reason`). */
export type TestWritingUnmetReason = 'session_error' | 'missing_tests' | 'lint';

export interface AcceptanceLintFinding {
  /** 워크트리 기준 경로 */
  file: string;
  line: number;
  message: string;
}

const newId = createUlidGenerator();

/** 피드백 · 기록에 담는 항목 상한. */
const MAX_LISTED = 50;
const MAX_FEEDBACK_CHARS = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 실행의 대상 규칙. 없거나 삭제된 규칙이 있으면 `null`. */
export const loadTargetRules = (context: StepContext): TestWriterRule[] | null =>
  context.read((store) => {
    const rules: TestWriterRule[] = [];
    for (const id of context.run.targetRuleIds) {
      const rule = store.rules.get(id);
      if (rule === null || rule.deletedAt !== null) return null;
      rules.push(rule);
    }
    return rules;
  });

const listed = (items: readonly string[]): string =>
  items.slice(0, MAX_LISTED).join('\n') +
  (items.length > MAX_LISTED ? `\n… 외 ${String(items.length - MAX_LISTED)}건` : '');

/** 앞 시도의 미충족 결과를 다음 세션에 줄 문장으로 바꾼다. 모르는 모양이면 `null`. */
export const describeUnmet = (exitDetail: unknown): string | null => {
  if (!isRecord(exitDetail)) return null;
  const items = (key: string): string[] =>
    Array.isArray(exitDetail[key])
      ? (exitDetail[key] as unknown[]).map((item) => {
          if (typeof item === 'string') return `- ${item}`;
          if (!isRecord(item)) return `- ${JSON.stringify(item)}`;
          const where = [item.file, item.line].filter(
            (part) => part !== undefined && part !== null,
          );
          const head = where.length > 0 ? `${where.map(String).join(':')} ` : '';
          return `- ${head}${String(item.name ?? item.message ?? '')}`.trimEnd();
        })
      : [];
  switch (exitDetail.reason) {
    case 'not_red':
      return `Red 확인: 구현 전에 실패하지 않은 케이스가 있다 (모든 케이스가 실패해야 한다)\n${listed(items('notFailedCases'))}`;
    case 'collect_error':
      return `Red 확인: 테스트 파일을 불러오거나 수집하지 못했다\n${listed(items('problems'))}`;
    case 'lint':
      return `허용되지 않은 import · 모듈 로드\n${listed(items('problems'))}`;
    case 'missing_tests':
      return `인수 테스트 파일(*.acc.ts)이 없는 규칙\n${listed(items('missing'))}`;
    case 'session_error':
      return `세션이 정상 종료되지 않았다: ${String(exitDetail.detail ?? exitDetail.endReason ?? '')}`;
    default:
      return null;
  }
};

/** 이번 시도 앞의 마지막 미충족 시도(테스트 작성 · Red 확인, 재기동 중단 제외)의 사유 문장. */
export const previousFeedback = (steps: readonly Step[], current: Step): string | null => {
  const earlier = steps.filter(
    (step) =>
      step.id !== current.id &&
      (step.kind === 'test_writing' || step.kind === 'red_check') &&
      step.status === 'failed' &&
      step.endedAt !== null &&
      !(isRecord(step.exitDetail) && step.exitDetail.interrupted === true),
  );
  const last = earlier.sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt))).at(-1);
  if (last === undefined) return null;
  const text = describeUnmet(last.exitDetail);
  if (text === null) return null;
  return text.length <= MAX_FEEDBACK_CHARS ? text : `${text.slice(0, MAX_FEEDBACK_CHARS)}…`;
};

/** 대상 규칙 폴더의 결과를 검사한다. 문제가 없으면 `null`과 옮길 파일. */
const checkOutputs = (
  sessionDir: string,
  rules: readonly TestWriterRule[],
): { unmet: StepOutcome | null; files: string[]; ignored: string[] } => {
  const ruleIds = rules.map((rule) => rule.displayId);
  const outputs = collectTestWriterOutputs(sessionDir, ruleIds);
  const files = ruleIds.flatMap((id) => outputs.byRule[id] ?? []);
  const missing = ruleIds.filter((id) => (outputs.byRule[id] ?? []).length === 0);
  if (missing.length > 0) {
    return {
      unmet: {
        status: 'unmet',
        exitDetail: { reason: 'missing_tests', missing, files, ignoredFiles: outputs.ignored },
      },
      files,
      ignored: outputs.ignored,
    };
  }
  const problems: AcceptanceLintFinding[] = files.flatMap((file) =>
    lintAcceptanceSource(fs.readFileSync(path.join(sessionDir, file), 'utf8')).map((problem) => ({
      file,
      ...problem,
    })),
  );
  if (problems.length > 0) {
    return {
      unmet: {
        status: 'unmet',
        exitDetail: { reason: 'lint', problems: problems.slice(0, MAX_LISTED), files },
      },
      files,
      ignored: outputs.ignored,
    };
  }
  return { unmet: null, files, ignored: outputs.ignored };
};

/** 테스트 작성 단계 실행기를 만든다 (기본 실행기 목록에 등록된다). */
export const createTestWritingExecutor =
  (): StepExecutor =>
  async (context): Promise<StepOutcome> => {
    const rules = loadTargetRules(context);
    if (rules === null || rules.length === 0) {
      return {
        status: 'halt',
        runStatus: 'failed',
        reason: 'target_rule_unavailable',
        exitDetail: { ruleIds: context.run.targetRuleIds },
      };
    }
    const ruleIds = rules.map((rule) => rule.displayId);
    const sessionDir = path.join(context.biveHome, 'work', context.project.id, 'sessions', newId());
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    try {
      const inputs = prepareTestWriterInputs({
        worktree: context.git.worktreePath,
        sessionDir,
        rules,
      });
      const session = await context.runSession({
        workDir: sessionDir,
        systemPrompt: TEST_WRITER_SYSTEM_PROMPT,
        prompt: testWriterTaskPrompt({
          runDisplayId: context.run.displayId,
          rules,
          feedback: previousFeedback(context.steps, context.step),
        }),
        vars: {
          ruleId: ruleIds[0] ?? '',
          ruleIds: ruleIds.join(','),
          runId: context.run.displayId,
        },
        writableRuleDirs: ruleIds,
      });
      if (session.endReason !== 'success') {
        return {
          status: 'unmet',
          exitDetail: {
            reason: 'session_error',
            sessionId: session.sessionId,
            endReason: session.endReason,
            detail: session.detail,
          },
        };
      }
      const checked = checkOutputs(sessionDir, rules);
      if (checked.unmet !== null) {
        const detail = checked.unmet.exitDetail as Record<string, unknown>;
        return { status: 'unmet', exitDetail: { ...detail, sessionId: session.sessionId } };
      }
      const applied = applyTestWriterOutputs({
        worktree: context.git.worktreePath,
        sessionDir,
        ruleIds,
        files: checked.files,
      });
      return {
        status: 'passed',
        exitDetail: {
          sessionId: session.sessionId,
          ruleIds,
          inputs: inputs.files,
          files: applied.written,
          removedFiles: applied.removed,
          ignoredFiles: checked.ignored,
        },
      };
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  };
