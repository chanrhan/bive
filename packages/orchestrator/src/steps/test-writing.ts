// 테스트 작성 단계 실행기 (RUN-03 · RUN-04 · JDG-01 · NFR-02, architecture.md 4장 2단계, ADR-024 · ADR-026 · ADR-068).
// 1. 세션 디렉터리 `$BIVE_HOME/work/<projectId>/sessions/<ID>/`(0700)에 허용 입력 사본만 둔다 (`test-writer/inputs.ts`)
// 2. test-writer 세션을 연다: 세션 루트 = 세션 디렉터리, 쓰기는 대상 규칙 폴더 `bive-acceptance/<RULE-ID>/`만.
//    작업 지시에는 세션을 열기 직전에 읽은 효력 있는 규범(초점 = 대상 규칙)을 싣고, 받은 표시 ID · 수를 세션 행에 남긴다
//    (M7-08 #220, ADR-108). 재시도 · 재개의 새 세션은 그때 다시 읽는다
// 3. 종료 조건: 세션이 성공으로 끝나고, 대상 규칙마다 `*.acc.ts`가 1개 이상이고, 모든 파일이 import 허용 목록을 지킨다
//    (`judge/acceptance-lint.ts`). 아니면 `unmet` → 엔진이 새 세션으로 재시도(상한 2회, ADR-026)
// 4. 통과면 결과 파일과 BIVE 선언 파일을 실행 워크트리에 옮기고 `passed` → 엔진이 커밋한다. 옮긴 파일이 프로젝트의
//    무시 규칙(`.gitignore` 등)에 걸려 커밋에서 빠지면 `failed`(`acceptance_ignored`): 커밋 · 판정 · 병합에 테스트가
//    없게 되고, 테스트를 다시 써도 무시 규칙은 그대로라 재시도하지 않는다
// 세션 디렉터리는 단계가 끝나면(통과 · 미충족 · 예외 모두) 지운다.
import fs from 'node:fs';
import path from 'node:path';

import { createUlidGenerator, type Step } from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import { lintAcceptanceSource } from '../judge/acceptance-lint.js';
import { NO_ACCEPTANCE_FILES_MESSAGE } from '../judge/runner.js';
import { ACCEPTANCE_DIR } from '../judge/config.js';
import {
  NO_TESTS_COLLECTED_MESSAGE,
  ruleIdOfAcceptanceFile,
  SUITE_FAILURE_MESSAGE,
} from '../judge/report.js';
import {
  latestJudgedCaseFilter,
  NO_WRITTEN_ACCEPTANCE,
  type WrittenAcceptance,
  writtenAcceptanceOf,
} from '../norms/case-names.js';
import { collectNormInput, normInputRecord } from '../norms/norm-input.js';
import { NO_CASES_MESSAGE } from './red-check.js';
import {
  applyTestWriterOutputs,
  collectTestWriterOutputs,
  prepareTestWriterInputs,
  type TestWriterRule,
} from '../test-writer/inputs.js';
import { TEST_WRITER_SYSTEM_PROMPT, testWriterTaskPrompt } from '../test-writer/prompts.js';

/** 옮긴 인수 테스트 · 선언 파일이 무시 규칙에 걸려 커밋되지 않을 때의 실행 실패 사유 (`Run.failureReason`). */
export const ACCEPTANCE_IGNORED_REASON = 'acceptance_ignored';

export interface TestWritingOptions {
  /** git 실행 함수 (무시 규칙 확인용, 기본 셸 없는 `execFile`) */
  git?: GitRunner;
}

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

/** Red 확인 수집 오류 가운데 글 그대로 싣는 BIVE 고정 문구 (판정 러너 · Red 확인이 만드는 글). */
const FIXED_PROBLEM_MESSAGES: ReadonlySet<string> = new Set([
  NO_CASES_MESSAGE,
  NO_ACCEPTANCE_FILES_MESSAGE,
  NO_TESTS_COLLECTED_MESSAGE,
]);

/** Red 확인 수집 오류의 메시지 원문 대신 싣는 글. */
export const RED_PROBLEM_WITHHELD = '불러오기 · 수집 오류 (메시지 원문은 싣지 않음)';

/** 위치를 뺀 수집 오류에 붙이는 글 (판정한 커밋의 대상 규칙 폴더 파일 · 폴더가 아닌 위치). */
export const RED_PROBLEM_OUTSIDE = '(대상 규칙 폴더의 파일로 확인되지 않은 위치는 싣지 않음)';

/**
 * 수집 오류 메시지 대신 싣는 글: BIVE 고정 문구와 같으면 그 문구, 스위트 훅 실패 안내로 시작하면 안내 앞부분만, 나머지는 원문 대신
 * {@link RED_PROBLEM_WITHHELD}. 판정 중 프로젝트 코드가 던진 오류의 메시지는 vitest의 파일 메시지에 그대로 실려 러너 오류와
 * 글로 가려낼 수 없다(ADR-128).
 */
const problemMessage = (message: unknown): string => {
  if (typeof message !== 'string') return RED_PROBLEM_WITHHELD;
  if (FIXED_PROBLEM_MESSAGES.has(message)) return message;
  if (message === SUITE_FAILURE_MESSAGE || message.startsWith(`${SUITE_FAILURE_MESSAGE}:`)) {
    return SUITE_FAILURE_MESSAGE;
  }
  return RED_PROBLEM_WITHHELD;
};

/** 위치가 판정한 커밋의 대상 규칙 폴더 파일이거나 대상 규칙 폴더 자체면 그 경로, 아니면 `null`. */
const writtenLocation = (file: unknown, written: WrittenAcceptance): string | null => {
  if (typeof file !== 'string') return null;
  if (written.files.has(file)) return file;
  return [...written.ruleDisplayIds].some((id) => file === `${ACCEPTANCE_DIR}/${id}`) ? file : null;
};

/**
 * Red 확인의 실패하지 않은 케이스 줄: 위치가 판정한 커밋의 대상 규칙 폴더 파일이고 이름이 그 규칙 폴더 파일의 케이스 이름
 * 리터럴과 맞을 때만 위치 · 이름을 싣고, 나머지는 "알 수 없는 케이스 N건"으로 센다 (M3-40 #281, ADR-121 · ADR-128).
 */
const redCaseLines = (cases: unknown, written: WrittenAcceptance): string[] => {
  if (!Array.isArray(cases)) return [];
  const lines: string[] = [];
  let unknown = 0;
  for (const item of cases) {
    const file = isRecord(item) && typeof item.file === 'string' ? item.file : null;
    const name = isRecord(item) && typeof item.name === 'string' ? item.name : null;
    const ruleId = file === null ? null : ruleIdOfAcceptanceFile(file);
    if (
      file === null ||
      name === null ||
      ruleId === null ||
      !written.files.has(file) ||
      !written.isKnownCase(ruleId, name)
    ) {
      unknown += 1;
      continue;
    }
    const line =
      isRecord(item) &&
      typeof item.line === 'number' &&
      Number.isInteger(item.line) &&
      item.line > 0
        ? `:${String(item.line)}`
        : '';
    lines.push(`- ${file}${line} ${name}`);
  }
  if (unknown > 0) {
    lines.push(
      `- (알 수 없는 케이스 ${String(unknown)}건: 인수 테스트 파일에서 이름을 찾지 못해 싣지 않음)`,
    );
  }
  return lines;
};

/**
 * Red 확인의 수집 오류 줄: 위치는 판정한 커밋의 대상 규칙 폴더 안의 것만, 메시지는 {@link problemMessage}로 바꾼 글만 싣는다
 * (M3-40 #281, ADR-128).
 */
const redProblemLines = (problems: unknown, written: WrittenAcceptance): string[] => {
  if (!Array.isArray(problems)) return [];
  return problems.map((item) => {
    const record = isRecord(item) ? item : {};
    const where = writtenLocation(record.file, written);
    const outside = record.file !== undefined && record.file !== null && where === null;
    const parts = [where, problemMessage(record.message), outside ? RED_PROBLEM_OUTSIDE : null];
    return `- ${parts.filter((part) => part !== null).join(' ')}`;
  });
};

/**
 * 앞 시도의 미충족 결과를 다음 세션에 줄 문장으로 바꾼다. 모르는 모양이면 `null`. Red 확인 결과(실패하지 않은 케이스 · 수집 오류)는
 * `written`(그 Red 확인이 판정한 커밋의 대상 규칙 폴더)과 대조한 것만 싣는다.
 */
export const describeUnmet = (exitDetail: unknown, written: WrittenAcceptance): string | null => {
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
      return `Red 확인: 구현 전에 실패하지 않은 케이스가 있다 (모든 케이스가 실패해야 한다)\n${listed(redCaseLines(exitDetail.notFailedCases, written))}`;
    case 'collect_error':
      return `Red 확인: 테스트 파일을 불러오거나 수집하지 못했다\n${listed(redProblemLines(exitDetail.problems, written))}`;
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

/** 이번 시도 앞의 마지막 미충족 시도(테스트 작성 · Red 확인, 재기동 중단 제외). */
export const lastUnmetAttempt = (steps: readonly Step[], current: Step): Step | undefined =>
  steps
    .filter(
      (step) =>
        step.id !== current.id &&
        (step.kind === 'test_writing' || step.kind === 'red_check') &&
        step.status === 'failed' &&
        step.endedAt !== null &&
        !(isRecord(step.exitDetail) && step.exitDetail.interrupted === true),
    )
    .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)))
    .at(-1);

/**
 * 앞 시도(`lastUnmetAttempt`)의 사유 문장. 앞 시도가 Red 확인이면 그 결과에 남은 커밋(Red 확인이 판정한 테스트 작성 커밋)의
 * 대상 규칙 폴더 글을 git 객체에서 읽어 대조 기준으로 쓴다. 다른 시도는 Red 확인 결과가 없으므로 아무것도 모르는 기준이다.
 */
export const previousFeedback = async (
  last: Step | undefined,
  repoPath: string,
  ruleDisplayIds: readonly string[],
): Promise<string | null> => {
  if (last === undefined) return null;
  const written =
    last.kind === 'red_check' && isRecord(last.exitDetail)
      ? await writtenAcceptanceOf(repoPath, last.exitDetail.commit, ruleDisplayIds)
      : NO_WRITTEN_ACCEPTANCE;
  const text = describeUnmet(last.exitDetail, written);
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

/**
 * 워크트리에 옮긴 파일 중 커밋(`add --all`)에서 빠질 파일: 추적되지 않았고 무시 규칙(`.gitignore` · `.git/info/exclude` ·
 * `core.excludesFile`)에 걸린 것. `check-ignore`는 `--no-index` 없이 쓰므로 이미 추적된 파일은 걸리지 않는다(커밋과 같음).
 */
const ignoredForCommit = async (
  git: GitRunner,
  worktree: string,
  files: readonly string[],
): Promise<string[]> => {
  if (files.length === 0) return [];
  const result = await git(['check-ignore', '--stdin', '-z'], {
    cwd: worktree,
    okCodes: [0, 1],
    input: `${files.join('\0')}\0`,
  });
  return result.stdout
    .split('\0')
    .filter((file) => file !== '')
    .sort();
};

/** 테스트 작성 단계 실행기를 만든다 (기본 실행기 목록에 등록된다). */
export const createTestWritingExecutor =
  (options: TestWritingOptions = {}): StepExecutor =>
  async (context): Promise<StepOutcome> => {
    const git = options.git ?? createGitRunner();
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
      // 블록 선언은 읽기 전용 사본으로 둔다 (선언이 없으면 사본도 없다, M3-01 #46 · ADR-122)
      const blocks = context.read((store) => store.blockDeclarations.current());
      const inputs = prepareTestWriterInputs({
        worktree: context.git.worktreePath,
        sessionDir,
        rules,
        blocks: blocks?.declaration ?? null,
      });
      // 효력 있는 규범은 작업 지시의 글로만 준다 (파일로 복사하지 않는다, ADR-100 A14). 케이스 이름은 최근 판정 커밋의 인수
      // 테스트 파일에 적힌 것만 싣는다 (M3-37, ADR-121)
      const isKnownCase = await latestJudgedCaseFilter(context.read, context.git.repoPath);
      const norms = context.read((store) =>
        collectNormInput(
          store,
          { requirementIds: [], ruleIds: context.run.targetRuleIds },
          { isKnownCase },
        ),
      );
      const session = await context.runSession({
        workDir: sessionDir,
        systemPrompt: TEST_WRITER_SYSTEM_PROMPT,
        prompt: testWriterTaskPrompt({
          runDisplayId: context.run.displayId,
          rules,
          norms,
          // 앞 시도의 사유: Red 확인 결과의 케이스 이름 · 위치는 판정한 커밋의 대상 규칙 폴더 글과 대조한다 (M3-40, ADR-128)
          feedback: await previousFeedback(
            lastUnmetAttempt(context.steps, context.step),
            context.git.repoPath,
            ruleIds,
          ),
        }),
        normInput: normInputRecord(norms),
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
      const ignoredByRules = await ignoredForCommit(git, context.git.worktreePath, applied.written);
      if (ignoredByRules.length > 0) {
        return {
          status: 'halt',
          runStatus: 'failed',
          reason: ACCEPTANCE_IGNORED_REASON,
          exitDetail: {
            sessionId: session.sessionId,
            ruleIds,
            ignoredByRules: ignoredByRules.slice(0, MAX_LISTED),
            detail:
              '인수 테스트 · 선언 파일이 프로젝트의 무시 규칙(.gitignore 등)에 걸려 커밋에 들어가지 않습니다. 무시 규칙을 고친 뒤 다시 실행합니다',
          },
        };
      }
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
