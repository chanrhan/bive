// 구조 검사: 내장 구조 규칙의 판정 (JDG-01 · JDG-05 · RUN-02 · RUN-08, ADR-033 · ADR-125, M3-03 #48, ADR-127).
// 검사 단계와 병합 재검사가 판정 절차(`judging.ts`의 `judgeCommit`) 안에서 같이 쓴다.
// - 언제 · 어디서: 판정할 커밋의 깨끗한 체크아웃(추적 파일만, 미추적 · 무시된 파일 0개를 체크아웃이 확인한다)에서, 의존성 설치 전에
//   돈다(설치 산출물이 소스로 섞이지 않는다). 선언은 단계를 열 때 한 번 읽은 판을 쓴다(판정 도중 사람이 새 판을 저장해도 그 판으로
//   판정하고, 판정 기록에 그 판 번호가 남는다)
// - 판정 근거는 파서 출력뿐이다(JDG-01). 위반을 이 모듈이 계산하지 않는다(ADR-033): 파서의 판정 상태 · 위반 목록을 규칙별로 나눌 뿐이다
// - 통과는 파서 결과가 `checked`이고 그 규칙 종류의 위반이 0건일 때뿐이다. `incomplete`(분석하지 않은 대상으로 가는 가져오기),
//   추적 중인 `node_modules`, 구현 역할이 만들 수 있는 파서 오류(시간 · 출력 · 파일 수 · 경로 상한, 대소문자, 분석 빠짐)는 두 내장
//   규칙의 실패다(구현 회귀). 순환(`structure.no-cycle`)은 블록 선언이 막는 것이 아니라 판정하지 않고 결과에만 센다
// - 판정하지 않고 단계를 끝내는 것: 겹침(`overlap`: 사람이 선언을 고칠 일, `block_declaration_overlap`), 구현 역할이 고칠 수 없는 파서
//   오류(실행기를 띄우지 못함 · 깨진 출력 등)와 선언을 읽지 못함(`judge_runner_error`), 내장 규칙 행이 맞지 않음(`state_inconsistent`)
// - 중단 신호 · 시간 제한은 파서 호출에 잇는다. 중단이면 판정하지 않고 신호의 사유로 던진다(엔진이 중단으로 다룬다)
// - 판정 기록의 케이스: 첫 케이스는 요약(선언 판 · 위반 수), 그 뒤 위반 한 건씩(상한). 위반의 파일 경로는 구현 역할이 정할 수 있는
//   글이라 표시 값으로 바꾸고 길이를 자른다. 파서 오류는 종류(`code`)만 싣는다(메시지에는 실행기 출력이 실릴 수 있다)
// - 겹침으로 끝나면 단계 결과에 겹친 파일(같은 표시 값 · 같은 상한)과 그 파일에 맞은 블록 이름 · 전체 수를 남긴다(M3-51 #296, ADR-144:
//   `run.list`의 종료 사유 보조 표시가 이것을 읽는다, `runs/failure-notes.ts`)
import fs from 'node:fs';
import path from 'node:path';

import {
  analyzeProject,
  ParserError,
  type ParserErrorCode,
  type ProjectAnalysis,
  type StructureViolation,
} from '@bive/parser';
import {
  BUILTIN_STRUCTURE_RULES,
  type BlockDeclaration,
  createUlidGenerator,
  type JudgmentCase,
  type JudgmentResult,
  type Rule,
} from '@bive/shared';
import { StoredBlockDeclarationError } from '@bive/store';

import type { StepContext, StepOutcome } from '../engine/types.js';
import { type BuiltinStructureRuleKey, isBuiltinStructureRule } from '../norms/builtin-rules.js';
import { displayText } from '../text-limit.js';
import { JUDGE_RUNNER_ERROR_REASON } from './red-check.js';

/** 블록 선언 겹침으로 판정하지 않고 실행을 끝낼 때의 실패 사유 (`Run.failureReason`). */
export const BLOCK_DECLARATION_OVERLAP_REASON = 'block_declaration_overlap';

/** 단계 결과 · 실패 상세의 단계 이름. */
export const STRUCTURE_STAGE = 'structure';

/** 판정 기록 한 건에 싣는 위반 케이스 상한 (넘는 수는 요약 케이스에 센다). */
export const MAX_STRUCTURE_CASES = 20;

/** 위반 경로 한 개의 표시 길이 상한. */
const MAX_PATH_CHARS = 300;

/** 요약 케이스의 위치 칸 (코드 위치가 아니라 블록 선언). */
export const STRUCTURE_SUMMARY_FILE = '블록 선언';

/**
 * 구현 역할이 소스로 만들 수 있는 파서 오류: 내장 규칙의 실패로 보고 구현으로 회귀한다 (큰 순환의 시간 초과 · 출력 초과, 파일 수 ·
 * 경로 길이 상한, 대소문자만 다른 가져오기, 분석이 빠진 소스). 그 밖의 오류는 실행기 · 환경 문제라 판정하지 않고 끝낸다.
 */
const FIXABLE_PARSER_ERRORS: ReadonlySet<ParserErrorCode> = new Set<ParserErrorCode>([
  'cruise_timeout',
  'cruise_output_too_large',
  'too_many_files',
  'path_too_long',
  'path_case_mismatch',
  'file_not_analyzed',
]);

/** 위반 종류의 표시명 (판정 기록 케이스 이름). */
const VIOLATION_LABELS: Readonly<Record<BuiltinStructureRuleKey, string>> = {
  'structure.public-api-only': '공개하지 않은 파일 가져오기',
  'structure.declared-direction': '선언하지 않은 방향의 가져오기',
};

/** 단계를 열 때 읽은 구조 검사 계획: 지금 선언의 판과 내장 규칙 행. */
export interface StructurePlan {
  readonly version: number;
  readonly declaration: BlockDeclaration;
  readonly rules: Readonly<Record<BuiltinStructureRuleKey, Rule>>;
}

export type StructurePlanRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'plan'; readonly plan: StructurePlan }
  | { readonly kind: 'halt'; readonly outcome: StepOutcome };

const halt = (reason: string, exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason,
  exitDetail,
});

/**
 * 단계를 열 때 구조 검사 계획을 읽는다. `rules`는 판정 대상(효력 있는 규칙)이다.
 * - 선언이 없고 내장 구조 규칙도 없으면 `none`(구조 검사를 하지 않는다: 지금과 같다)
 * - 선언을 읽지 못하면(저장소 밖 변조) 판정하지 않고 끝낸다. 선언과 내장 규칙 행이 짝이 맞지 않아도 끝낸다(통과로 저장되는 길이 없다)
 */
export const readStructurePlan = (
  context: StepContext,
  rules: readonly Rule[],
): StructurePlanRead => {
  let record;
  try {
    record = context.read((store) => store.blockDeclarations.current());
  } catch (error) {
    if (!(error instanceof StoredBlockDeclarationError)) throw error;
    return {
      kind: 'halt',
      outcome: halt(JUDGE_RUNNER_ERROR_REASON, {
        stage: STRUCTURE_STAGE,
        code: 'declaration_unreadable',
        message: '저장된 블록 선언을 읽지 못해 구조 검사를 하지 못했습니다',
      }),
    };
  }
  const found = BUILTIN_STRUCTURE_RULES.map((key) => ({
    key,
    matches: rules.filter((rule) => isBuiltinStructureRule(rule, key)),
  }));
  if (record === null) {
    if (found.every(({ matches }) => matches.length === 0)) return { kind: 'none' };
    return {
      kind: 'halt',
      outcome: halt('state_inconsistent', {
        stage: STRUCTURE_STAGE,
        message: '내장 구조 규칙은 있는데 블록 선언이 없습니다',
      }),
    };
  }
  if (found.some(({ matches }) => matches.length !== 1)) {
    return {
      kind: 'halt',
      outcome: halt('state_inconsistent', {
        stage: STRUCTURE_STAGE,
        message:
          '블록 선언은 있는데 내장 구조 규칙이 하나씩 있지 않습니다 (블록 선언을 다시 저장하면 없는 규칙이 생깁니다)',
        declarationVersion: record.version,
        builtinRules: Object.fromEntries(
          found.map(({ key, matches }) => [key, matches.map((rule) => rule.displayId)]),
        ),
      }),
    };
  }
  const byKey = Object.fromEntries(found.map(({ key, matches }) => [key, matches[0]])) as Record<
    BuiltinStructureRuleKey,
    Rule
  >;
  return {
    kind: 'plan',
    plan: { version: record.version, declaration: record.declaration, rules: byKey },
  };
};

/**
 * 규칙 가운데 내장 구조 규칙의 표시 ID (M3-51 #296, ADR-144): 구현 세션의 앞 시도 사유가 구조 위반을 인수 테스트 실패와 다른 머리
 * 문장 아래에 싣는 기준. 내장 규칙은 폐기 · 대체되지 않는다(ADR-127 ③).
 */
export const structureRuleDisplayIds = (rules: readonly Rule[]): Set<string> =>
  new Set(
    rules
      .filter((rule) => BUILTIN_STRUCTURE_RULES.some((key) => isBuiltinStructureRule(rule, key)))
      .map((rule) => rule.displayId),
  );

/** 구조 검사 계획의 내장 규칙 ID. */
export const structureRuleIds = (plan: StructurePlan | null): string[] =>
  plan === null ? [] : BUILTIN_STRUCTURE_RULES.map((key) => plan.rules[key].id);

/** 파서 호출 (시험용 주입, 기본 `analyzeProject`). */
export type StructureAnalyzer = (input: {
  readonly projectDir: string;
  readonly declaration: BlockDeclaration;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}) => Promise<ProjectAnalysis>;

export const defaultStructureAnalyzer: StructureAnalyzer = (input) =>
  analyzeProject({
    projectDir: input.projectDir,
    declaration: input.declaration,
    signal: input.signal,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });

/** 내장 규칙 하나의 판정 (기록 전). */
export interface StructureVerdict {
  readonly key: BuiltinStructureRuleKey;
  readonly rule: Rule;
  readonly status: 'pass' | 'fail';
  readonly cases: JudgmentCase[];
}

/** 구조 검사 결과의 요약 (단계 `exitDetail.structure`). 경로 글은 겹친 파일(표시 값)만 싣는다. */
export interface StructureSummary {
  readonly declarationVersion: number;
  readonly status: 'checked' | 'incomplete' | 'overlap' | 'tracked_install' | 'error';
  readonly violations?: Readonly<Record<string, number>>;
  readonly unanalyzed?: number;
  readonly trackedInstallDirs?: number;
  readonly code?: string;
  /**
   * 겹침(`overlap`)일 때만: 겹친 파일 앞 {@link MAX_STRUCTURE_CASES}개(경로는 판정 기록 케이스와 같은 표시 값, 블록 이름은 선언 순서)
   * 와 전체 수 (M3-51 #296, ADR-144). 사람이 선언을 고칠 자리를 알 수 있게 남긴다
   */
  readonly overlaps?: {
    readonly items: readonly { readonly file: string; readonly blocks: readonly string[] }[];
    readonly total: number;
  };
}

export type StructureRun =
  | {
      readonly kind: 'judged';
      readonly verdicts: StructureVerdict[];
      readonly summary: StructureSummary;
    }
  /** 판정하지 않고 실행을 끝낸다 (겹침 · 구현 역할이 고칠 수 없는 오류) */
  | {
      readonly kind: 'halt';
      readonly reason: typeof BLOCK_DECLARATION_OVERLAP_REASON | typeof JUDGE_RUNNER_ERROR_REASON;
      readonly summary: StructureSummary;
      readonly message: string;
    };

const shown = (value: string): string => displayText(value, MAX_PATH_CHARS, 'ends').text;

/** 체크아웃 안의 `node_modules` 폴더 (깨끗한 체크아웃이라 있으면 추적 중인 것이다). `.git`은 보지 않는다. 상한까지만 모은다. */
export const trackedInstallDirs = (root: string, limit = 10): string[] => {
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= limit) return;
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === 'node_modules') {
        found.push(next);
        continue;
      }
      walk(path.join(dir, entry.name), next);
    }
  };
  walk(root, '');
  return found;
};

const summaryCase = (
  version: number,
  status: 'passed' | 'failed',
  message: string | null,
): JudgmentCase => ({
  name: `구조 검사 · 블록 선언 판 ${String(version)}`,
  file: STRUCTURE_SUMMARY_FILE,
  line: null,
  status,
  message,
});

const violationCase = (key: BuiltinStructureRuleKey, item: StructureViolation): JudgmentCase => ({
  name: `${VIOLATION_LABELS[key]} · ${item.from.block} → ${item.to.block}`,
  file: shown(item.from.file),
  line: null,
  status: 'failed',
  message: `가져온 파일: ${shown(item.to.file)}`,
});

/** 두 내장 규칙 모두 같은 사정으로 실패 (판정 상태가 통과로 읽힐 수 없는 결과). */
const allFailed = (
  plan: StructurePlan,
  message: string,
  extra: (key: BuiltinStructureRuleKey) => JudgmentCase[] = () => [],
): StructureVerdict[] =>
  BUILTIN_STRUCTURE_RULES.map((key) => ({
    key,
    rule: plan.rules[key],
    status: 'fail',
    cases: [summaryCase(plan.version, 'failed', message), ...extra(key)],
  }));

/**
 * 체크아웃 `dir`에서 구조 검사를 한다 (설치 전). 중단 신호면 신호의 사유로 던진다. 모르는 예외는 그대로 던진다(엔진이 단계 오류로
 * 끝낸다: 통과로 저장되지 않는다).
 */
export const runStructureCheck = async (
  dir: string,
  plan: StructurePlan,
  options: {
    readonly signal: AbortSignal;
    readonly analyze?: StructureAnalyzer;
    readonly timeoutMs?: number;
  },
): Promise<StructureRun> => {
  const { version } = plan;
  options.signal.throwIfAborted();
  const installed = trackedInstallDirs(dir);
  if (installed.length > 0) {
    return {
      kind: 'judged',
      summary: {
        declarationVersion: version,
        status: 'tracked_install',
        trackedInstallDirs: installed.length,
      },
      verdicts: allFailed(plan, '추적 중인 node_modules가 있어 그 안의 가져오기를 볼 수 없음', () =>
        installed.map((rel) => ({
          name: '추적 중인 설치 폴더',
          file: shown(rel),
          line: null,
          status: 'failed',
          message: null,
        })),
      ),
    };
  }
  let analysis: ProjectAnalysis;
  try {
    analysis = await (options.analyze ?? defaultStructureAnalyzer)({
      projectDir: dir,
      declaration: plan.declaration,
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    options.signal.throwIfAborted();
    if (!(error instanceof ParserError)) throw error;
    const summary: StructureSummary = {
      declarationVersion: version,
      status: 'error',
      code: error.code,
    };
    if (FIXABLE_PARSER_ERRORS.has(error.code)) {
      return {
        kind: 'judged',
        summary,
        verdicts: allFailed(plan, `구조 검사를 끝내지 못함 (오류 종류 ${error.code})`),
      };
    }
    return {
      kind: 'halt',
      reason: JUDGE_RUNNER_ERROR_REASON,
      summary,
      message: '구조 검사 실행기가 끝까지 분석하지 못했습니다',
    };
  }
  options.signal.throwIfAborted();
  const structure = analysis.structure;
  if (structure === null) {
    return {
      kind: 'halt',
      reason: JUDGE_RUNNER_ERROR_REASON,
      summary: { declarationVersion: version, status: 'error', code: 'no_structure' },
      message: '선언을 넘겼는데 구조 검사 결과가 없습니다',
    };
  }
  const { outcome } = structure;
  if (outcome.status === 'overlap') {
    return {
      kind: 'halt',
      reason: BLOCK_DECLARATION_OVERLAP_REASON,
      summary: {
        declarationVersion: version,
        status: 'overlap',
        overlaps: {
          items: outcome.overlaps.items
            .slice(0, MAX_STRUCTURE_CASES)
            .map((item) => ({ file: shown(item.file), blocks: [...item.blocks] })),
          total: outcome.overlaps.total,
        },
      },
      message: `블록 선언에서 한 파일이 두 블록 이상에 맞아(${String(outcome.overlaps.total)}개) 구조 위반을 판별하지 않았습니다`,
    };
  }
  // 위반 목록은 파서가 앞쪽만 담는다(`items`). 건수는 자르기 전 전체 기준이 아니라 종류별로 담긴 항목을 센다: 담긴 위반이 하나라도 있으면
  // 실패이고, 잘렸으면(`total` > 담긴 수) 그 종류를 알 수 없으므로 두 규칙 모두 실패로 본다(닫힌 쪽)
  const items = outcome.violations.items;
  const truncated = outcome.violations.total > items.length;
  const count = (kind: string): number => items.filter((item) => item.kind === kind).length;
  const violations = {
    'structure.declared-direction': count('structure.declared-direction'),
    'structure.public-api-only': count('structure.public-api-only'),
    'structure.no-cycle': count('structure.no-cycle'),
    total: outcome.violations.total,
  };
  const incomplete = outcome.status === 'incomplete';
  const unanalyzed = incomplete ? outcome.unanalyzed : null;
  const verdicts = BUILTIN_STRUCTURE_RULES.map((key): StructureVerdict => {
    const own = items.filter((item) => item.kind === key);
    const failed = own.length > 0 || incomplete || truncated;
    const notes = [
      ...(own.length > 0 ? [`위반 ${String(own.length)}건`] : []),
      ...(own.length > MAX_STRUCTURE_CASES ? [`앞 ${String(MAX_STRUCTURE_CASES)}건만 실음`] : []),
      ...(truncated ? ['위반 목록이 잘려 종류를 다 알 수 없음'] : []),
      ...(unanalyzed === null
        ? []
        : [`분석하지 않은 대상으로 가는 가져오기 ${String(unanalyzed.total)}건`]),
    ];
    const extra =
      unanalyzed === null
        ? []
        : unanalyzed.items.slice(0, MAX_STRUCTURE_CASES).map((edge): JudgmentCase => ({
            name: '분석하지 않은 대상으로 가는 가져오기',
            file: shown(edge.from),
            line: null,
            status: 'failed',
            message: `가져온 대상: ${shown(edge.to)}`,
          }));
    return {
      key,
      rule: plan.rules[key],
      status: failed ? 'fail' : 'pass',
      cases: [
        summaryCase(
          version,
          failed ? 'failed' : 'passed',
          notes.length > 0 ? notes.join(' · ') : '위반 0건',
        ),
        ...own.slice(0, MAX_STRUCTURE_CASES).map((item) => violationCase(key, item)),
        ...extra,
      ],
    };
  });
  return {
    kind: 'judged',
    verdicts,
    summary: {
      declarationVersion: version,
      status: outcome.status,
      violations,
      ...(unanalyzed === null ? {} : { unanalyzed: unanalyzed.total }),
    },
  };
};

const newId = createUlidGenerator();

/**
 * 구조 검사 계획이 있는데 판정 기록이 두 내장 규칙을 모두 덮지 않으면 빠진 규칙의 표시 ID (덮으면 `[]`). 검사 단계 · 병합 재검사가
 * 기록 전에 스스로 확인해, 덮지 않으면 기록 없이 닫힌 쪽으로 끝낸다(구조 검사 결과가 빠진 채 통과로 가는 길을 한 겹 더 막는다).
 * 계획이 없으면(선언 없음) 늘 `[]`.
 */
export const missingStructureJudgments = (
  plan: StructurePlan | null,
  judgments: readonly Pick<JudgmentResult, 'ruleId'>[],
): string[] =>
  plan === null
    ? []
    : BUILTIN_STRUCTURE_RULES.map((key) => plan.rules[key])
        .filter((rule) => judgments.filter((judgment) => judgment.ruleId === rule.id).length !== 1)
        .map((rule) => rule.displayId);

/** 구조 검사 결과 → 내장 규칙별 판정 기록 (실행기 `dependency-cruiser`). 판정하지 않았으면 `[]`. */
export const structureJudgmentsFrom = (
  run: StructureRun | undefined,
  meta: { runId: string; stepId: string; commit: string; judgedAt: string },
): JudgmentResult[] =>
  run?.kind !== 'judged'
    ? []
    : run.verdicts.map((verdict) => ({
        id: newId(),
        ruleId: verdict.rule.id,
        runId: meta.runId,
        stepId: meta.stepId,
        commit: meta.commit,
        judgedAt: meta.judgedAt,
        status: verdict.status,
        runner: 'dependency-cruiser',
        exitCode: null,
        reporterPath: null,
        cases: verdict.cases,
        quarantineReason: null,
      }));
