// 계약 검사: `contract` 검사 규칙의 판정 (NRM-03 · JDG-01 · RUN-02, ADR-033 · ADR-129 · ADR-130 ⑤, M3-47 #292 · ADR-132).
// 검사 단계와 병합 재검사가 판정 절차(`judging.ts`의 `judgeCommit`) 안에서 같이 쓴다(구조 검사와 같은 자리).
// - 대상: 판정 대상(효력 있는 규칙) 가운데 계약 검사 규칙(`builtin` · `contractId` 있음). 인수 테스트로는 판정하지 않는다
// - 실행기는 계약 종류별이다. 지금 있는 것은 OpenAPI 하나(`contract-check/openapi.ts`). 실행기가 없는 종류(DB 스키마 · AsyncAPI)의
//   규칙은 판정 없음으로 남는다: 판정 기록을 남기지 않고(통과로 세지 않는다), 단계의 통과 · 회귀에 끼지 않는다(다른 규칙을 막지 않는다)
// - 판정하는 문서: 등록 때 기록한 커밋(`Contract.sourceCommit`)의 원본 파일을 git 객체에서 읽고 등록 해시와 대조한다(작업 트리 ·
//   실행 워크트리 · 판정 커밋의 파일이 아니다). 구현 역할은 실행 워크트리에서 계약 파일을 쓸 수 있으므로 판정 커밋의 파일로 판정하면 자기
//   채점 기준을 바꿀 수 있다. 판정 커밋의 같은 파일이 등록 때와 같은지는 요약에만 남긴다
// - 판정 규칙 (근거는 도구 출력뿐, ADR-033):
//   - 문서 형식 오류(데이터로 읽지 못함 · lint 오류): `fail`. 등록된 문서의 문제라 구현이 고칠 수 없어 회귀하지 않는다(단계 통과를 막지
//     않는다: 막으면 그 프로젝트의 모든 실행이 회귀 상한으로 끝난다)
//   - 트래픽 검증에서 계약과 다른 응답이 하나라도 있음: `fail`, 구현 회귀(구조 검사 실패와 같다)
//   - 계약 밖을 가리키는 값(원격 · 파일 참조) · 경로 없는 문서 · 등록 원본을 읽지 못함 · 계약 안 요청이 없음 · 검증하지 못한 요청이 있음:
//     판정 없음(기록 없음, 통과로 세지 않음, 다른 규칙을 막지 않음)
//   - 통과: 문서 형식 오류 0건이고, 계약 안 요청이 1건 이상이며 모두 검증되었고 위반이 0건일 때뿐
// - 도구를 끝까지 못 돌림(띄우지 못함 · 시간 초과 · 출력 초과 · 예상 밖 종료 코드 · 출력 모양): 판정하지 않고 실행을 끝낸다
//   (`judge_runner_error`, 단계 이름 `contract`). 통과로 읽히는 길이 없다. 중단 신호는 도구까지 이어지고 신호의 사유로 던진다
// - 판정 기록의 케이스: 첫 케이스는 요약, 그 뒤 문서 형식 오류 · 계약과 다른 응답 한 건씩(상한). 경로 · 메시지는 표시 값으로 바꾼다
import type { Contract, JudgmentCase, JudgmentResult, Rule } from '@bive/shared';
import { createUlidGenerator } from '@bive/shared';

import {
  disposePrepared,
  type OpenApiPrepared,
  prepareOpenApiContract,
  verifyOpenApiTraffic,
} from '../contract-check/openapi.js';
import type { ExchangeVerdict, PrismResult } from '../contract-check/prism.js';
import type { RecordedExchange } from '../contract-check/recorder.js';
import { ContractToolError } from '../contract-check/tool.js';
import type { StepOutcome } from '../engine/types.js';
import type { GitRunner } from '../git/git-exec.js';
import { readContractBlob } from '../norms/contract-source.js';
import { displayText } from '../text-limit.js';
import { JUDGE_RUNNER_ERROR_REASON } from './red-check.js';

/** 단계 결과 · 실패 상세의 단계 이름. */
export const CONTRACT_STAGE = 'contract';

/** 판정 기록 한 건에 싣는 문제 · 위반 케이스 상한. */
export const MAX_CONTRACT_CASES = 20;

/** 판정 기록의 실행기 값 (shared `JudgeRunner`). */
export const CONTRACT_JUDGE_RUNNER = 'redocly-prism';

const MAX_TEXT_CHARS = 300;
const shown = (value: string): string => displayText(value, MAX_TEXT_CHARS, 'ends').text;

/** 실행기가 있는 계약 종류. */
export type ContractRunnerKind = 'openapi';

const runnerOf = (contract: Contract): ContractRunnerKind | null =>
  contract.kind === 'openapi' ? 'openapi' : null;

/** 단계를 열 때 읽은 계약 검사 계획의 한 줄: 계약 검사 규칙과 그 계약. */
export interface ContractPlanItem {
  readonly rule: Rule;
  readonly contract: Contract;
  /** 실행기 (없으면 `null`: 판정 없음으로 남는다) */
  readonly runner: ContractRunnerKind | null;
}

export interface ContractPlan {
  readonly items: readonly ContractPlanItem[];
}

export type ContractPlanRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'plan'; readonly plan: ContractPlan }
  | { readonly kind: 'halt'; readonly outcome: StepOutcome };

/** 계약 검사 규칙인지 (`builtin` · 계약 칸 있음, ADR-129 ⑤). */
export const isContractRule = (rule: Rule): boolean => rule.builtin && rule.contractId !== null;

/**
 * 단계를 열 때 계약 검사 계획을 만든다. `rules`는 판정 대상(효력 있는 규칙), `contracts`는 효력 있는 계약(`effectiveContracts`)이다.
 * 계약 검사 규칙이 없으면 `none`(지금과 같다). 규칙이 가리키는 계약이 없으면 판정하지 않고 끝낸다(DB 트리거가 막는 상태라 저장소 밖
 * 변조다: 통과로 저장되는 길이 없다).
 */
export const contractPlanOf = (
  rules: readonly Rule[],
  contracts: readonly Contract[],
): ContractPlanRead => {
  const contractRules = rules.filter(isContractRule);
  if (contractRules.length === 0) return { kind: 'none' };
  const items: ContractPlanItem[] = [];
  for (const rule of contractRules) {
    const contract = contracts.find((item) => item.id === rule.contractId);
    if (contract === undefined) {
      return {
        kind: 'halt',
        outcome: {
          status: 'halt',
          runStatus: 'failed',
          reason: 'state_inconsistent',
          exitDetail: {
            stage: CONTRACT_STAGE,
            message: '계약 검사 규칙이 가리키는 계약이 없습니다',
            ruleId: rule.displayId,
          },
        },
      };
    }
    items.push({ rule, contract, runner: runnerOf(contract) });
  }
  return { kind: 'plan', plan: { items } };
};

/** 계약 검사 계획의 규칙 ID. */
export const contractRuleIds = (plan: ContractPlan | null): string[] =>
  plan === null ? [] : plan.items.map((item) => item.rule.id);

/** 판정 없음의 사유. */
export type ContractUnjudgedReason =
  | 'no_runner'
  | 'source_unreadable'
  | 'external_reference'
  | 'no_operations'
  | 'no_traffic'
  | 'unverified';

/** 판정 사유 (기록 · 단계 결과). */
export type ContractVerdictReason = 'verified' | 'document_invalid' | 'response_mismatch';

/** 계약 검사 규칙 하나의 판정 (기록 전). */
export type ContractVerdict =
  | {
      readonly kind: 'judged';
      readonly item: ContractPlanItem;
      readonly status: 'pass' | 'fail';
      readonly reason: ContractVerdictReason;
      /** 실패가 단계 통과를 막는지 (구현이 고칠 수 있는 실패만) */
      readonly blocking: boolean;
      readonly cases: JudgmentCase[];
    }
  | {
      readonly kind: 'unjudged';
      readonly item: ContractPlanItem;
      readonly reason: ContractUnjudgedReason;
    };

/** 단계 결과(`exitDetail.contracts`)의 한 줄. 경로 · 문서 글은 싣지 않는다. */
export interface ContractSummaryItem {
  readonly ruleId: string;
  readonly contractId: string;
  readonly kind: Contract['kind'];
  readonly outcome: 'pass' | 'fail' | 'unjudged';
  readonly reason: ContractVerdictReason | ContractUnjudgedReason;
  readonly blocking?: boolean;
}

export const contractSummary = (verdicts: readonly ContractVerdict[]): ContractSummaryItem[] =>
  verdicts.map((verdict) => ({
    ruleId: verdict.item.rule.displayId,
    contractId: verdict.item.contract.displayId,
    kind: verdict.item.contract.kind,
    outcome: verdict.kind === 'judged' ? verdict.status : 'unjudged',
    reason: verdict.reason,
    ...(verdict.kind === 'judged' && verdict.status === 'fail'
      ? { blocking: verdict.blocking }
      : {}),
  }));

/** 판정 커밋의 원본 파일이 등록 때와 같은지 (요약에만 싣는다). */
type SourceAtCommit = 'same' | 'changed' | 'missing';

const SOURCE_AT_COMMIT_TEXT: Readonly<Record<SourceAtCommit, string>> = {
  same: '판정 커밋의 원본 파일은 등록 때와 같음',
  changed: '판정 커밋의 원본 파일은 등록 때와 다름 (등록 내용으로 판정)',
  missing: '판정 커밋에 원본 파일 없음 (등록 내용으로 판정)',
};

/** 준비(판정 서버 전)를 마친 계약 하나. */
type PreparedItem =
  | {
      readonly kind: 'unjudged';
      readonly item: ContractPlanItem;
      readonly reason: ContractUnjudgedReason;
    }
  | {
      readonly kind: 'openapi';
      readonly item: ContractPlanItem;
      readonly prepared: OpenApiPrepared;
      readonly sourceAtCommit: SourceAtCommit;
    };

/** 준비 결과 (판정 서버를 띄우기 전). 도구 폴더가 남을 수 있어 {@link disposeContracts}로 정리한다. */
export interface PreparedContracts {
  readonly items: readonly PreparedItem[];
  /** 트래픽 검증이 필요한 계약이 있는지 (있으면 판정 서버 앞에 기록 프록시를 끼운다) */
  readonly needsTraffic: boolean;
}

export type ContractRun =
  | { readonly kind: 'judged'; readonly verdicts: ContractVerdict[] }
  /** 도구를 끝까지 못 돌렸다: 판정하지 않고 실행을 끝낸다 */
  | {
      readonly kind: 'halt';
      readonly reason: typeof JUDGE_RUNNER_ERROR_REASON;
      readonly message: string;
      readonly code: ContractToolError['code'];
      readonly ruleId: string;
    };

export interface ContractCheckOptions {
  readonly signal: AbortSignal;
  readonly git?: GitRunner;
  readonly lintTimeoutMs?: number;
  readonly prismTimeoutMs?: number;
  /** 도구 폴더의 상위 (기본 시스템 임시 폴더) */
  readonly tempDir?: string;
}

const toolHalt = (
  error: ContractToolError,
  item: ContractPlanItem,
): Extract<ContractRun, { kind: 'halt' }> => ({
  kind: 'halt',
  reason: JUDGE_RUNNER_ERROR_REASON,
  message: '계약 검사 도구를 끝까지 돌리지 못했습니다',
  code: error.code,
  ruleId: item.rule.displayId,
});

/** 준비한 계약의 도구 폴더를 지운다. */
export const disposeContracts = (prepared: PreparedContracts | undefined): void => {
  for (const item of prepared?.items ?? [])
    if (item.kind === 'openapi') disposePrepared(item.prepared);
};

/**
 * ① 준비 (판정할 커밋 `commit`의 체크아웃을 만든 뒤 · 의존성 설치 전): 등록 원본을 읽고 문서를 검사한다. 도구 오류면 `halt`(그때까지
 * 준비한 도구 폴더는 지운다), 중단이면 신호의 사유로 던진다.
 */
export const prepareContracts = async (
  repoPath: string,
  commit: string,
  plan: ContractPlan,
  options: ContractCheckOptions,
): Promise<
  | { readonly kind: 'prepared'; readonly prepared: PreparedContracts }
  | Extract<ContractRun, { kind: 'halt' }>
> => {
  const items: PreparedItem[] = [];
  const done = (): PreparedContracts => ({
    items,
    needsTraffic: items.some((item) => item.kind === 'openapi' && item.prepared.kind === 'ready'),
  });
  try {
    for (const item of plan.items) {
      options.signal.throwIfAborted();
      if (item.runner === null) {
        items.push({ kind: 'unjudged', item, reason: 'no_runner' });
        continue;
      }
      const { contract } = item;
      const registered = await readContractBlob(
        repoPath,
        contract.sourceCommit,
        contract.sourceFile,
        ...(options.git === undefined ? [] : [options.git]),
      );
      if (!registered.ok || registered.contentHash !== contract.contentHash) {
        items.push({ kind: 'unjudged', item, reason: 'source_unreadable' });
        continue;
      }
      const atCommit = await readContractBlob(
        repoPath,
        commit,
        contract.sourceFile,
        ...(options.git === undefined ? [] : [options.git]),
      );
      const sourceAtCommit: SourceAtCommit = !atCommit.ok
        ? 'missing'
        : atCommit.contentHash === contract.contentHash
          ? 'same'
          : 'changed';
      const prepared = await prepareOpenApiContract(registered.text, {
        sourceFile: contract.sourceFile,
        signal: options.signal,
        ...(options.lintTimeoutMs === undefined ? {} : { lintTimeoutMs: options.lintTimeoutMs }),
        ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
      });
      items.push({ kind: 'openapi', item, prepared, sourceAtCommit });
    }
  } catch (error) {
    disposeContracts(done());
    options.signal.throwIfAborted();
    if (!(error instanceof ContractToolError)) throw error;
    const item = plan.items[items.length];
    return toolHalt(error, item ?? plan.items[0]!);
  }
  return { kind: 'prepared', prepared: done() };
};

const summaryCase = (
  item: ContractPlanItem,
  status: 'passed' | 'failed',
  notes: readonly string[],
): JudgmentCase => ({
  name: `계약 검사 · ${item.contract.displayId} (OpenAPI)`,
  file: shown(item.contract.sourceFile),
  line: null,
  status,
  message: notes.join(' · '),
});

const documentVerdict = (
  item: ContractPlanItem,
  prepared: Extract<OpenApiPrepared, { kind: 'document_invalid' }>,
  sourceAtCommit: SourceAtCommit,
): ContractVerdict => ({
  kind: 'judged',
  item,
  status: 'fail',
  reason: 'document_invalid',
  blocking: false,
  cases: [
    summaryCase(item, 'failed', [
      prepared.reason === 'lint'
        ? `문서 형식 오류 ${String(prepared.errors)}건`
        : `문서 형식 오류 (${prepared.message})`,
      ...(prepared.problems.length > MAX_CONTRACT_CASES
        ? [`앞 ${String(MAX_CONTRACT_CASES)}건만 실음`]
        : []),
      '등록된 문서의 문제라 구현 회귀 없음',
      SOURCE_AT_COMMIT_TEXT[sourceAtCommit],
    ]),
    ...prepared.problems.slice(0, MAX_CONTRACT_CASES).map((problem): JudgmentCase => ({
      name: `문서 형식 오류 · ${shown(problem.ruleId)}`,
      file: shown(item.contract.sourceFile),
      line: null,
      status: 'failed',
      message: shown(
        [
          problem.pointer === null ? null : `위치 ${problem.pointer}`,
          problem.line === null ? null : `줄 ${String(problem.line)}`,
          problem.message,
        ]
          .filter((part) => part !== null)
          .join(' · '),
      ),
    })),
  ],
});

/** 교환 판정 → 계약 하나의 판정. */
export const trafficVerdict = (
  item: ContractPlanItem,
  result: PrismResult,
  sourceAtCommit: SourceAtCommit,
  extra: { readonly overflow: number; readonly warnings: number },
): ContractVerdict => {
  const count = (outcome: ExchangeVerdict['outcome']): number =>
    result.exchanges.filter((exchange) => exchange.outcome === outcome).length;
  const ok = count('ok');
  const outside = count('outside');
  const unverified = count('unverified') + extra.overflow;
  const violating = result.exchanges.filter((exchange) => exchange.outcome === 'violation');
  const notes = [
    `계약과 다른 응답 ${String(violating.length)}건`,
    `검증한 요청 ${String(ok)}건`,
    `계약 밖 요청 ${String(outside)}건`,
    ...(unverified > 0 ? [`검증하지 못한 요청 ${String(unverified)}건`] : []),
    ...(extra.warnings > 0 ? [`문서 경고 ${String(extra.warnings)}건`] : []),
    ...(violating.length > MAX_CONTRACT_CASES ? [`앞 ${String(MAX_CONTRACT_CASES)}건만 실음`] : []),
    SOURCE_AT_COMMIT_TEXT[sourceAtCommit],
  ];
  if (violating.length > 0) {
    return {
      kind: 'judged',
      item,
      status: 'fail',
      reason: 'response_mismatch',
      blocking: true,
      cases: [
        summaryCase(item, 'failed', notes),
        ...violating.slice(0, MAX_CONTRACT_CASES).map((exchange): JudgmentCase => ({
          name: `계약과 다른 응답 · ${shown(`${exchange.method} ${exchange.target}`)}`,
          file: shown(item.contract.sourceFile),
          line: null,
          status: 'failed',
          message: shown(
            exchange.violations
              .map((violation) => `${violation.location}: ${violation.message}`)
              .join(' / '),
          ),
        })),
      ],
    };
  }
  if (unverified > 0) return { kind: 'unjudged', item, reason: 'unverified' };
  if (ok === 0) return { kind: 'unjudged', item, reason: 'no_traffic' };
  return {
    kind: 'judged',
    item,
    status: 'pass',
    reason: 'verified',
    blocking: false,
    cases: [summaryCase(item, 'passed', notes)],
  };
};

/**
 * ② 판정 (판정 러너가 케이스 결과를 낸 뒤): 준비 결과와 기록된 교환으로 계약마다 판정한다. 도구 오류면 `halt`, 중단이면 신호의 사유로
 * 던진다. 도구 폴더는 호출자가 {@link disposeContracts}로 지운다.
 */
export const finishContracts = async (
  prepared: PreparedContracts,
  traffic: { readonly exchanges: readonly RecordedExchange[]; readonly overflow: number } | null,
  options: ContractCheckOptions,
): Promise<ContractRun> => {
  const verdicts: ContractVerdict[] = [];
  for (const entry of prepared.items) {
    options.signal.throwIfAborted();
    if (entry.kind === 'unjudged') {
      verdicts.push({ kind: 'unjudged', item: entry.item, reason: entry.reason });
      continue;
    }
    const { item, prepared: doc, sourceAtCommit } = entry;
    switch (doc.kind) {
      case 'document_invalid':
        verdicts.push(documentVerdict(item, doc, sourceAtCommit));
        continue;
      case 'external':
        verdicts.push({ kind: 'unjudged', item, reason: 'external_reference' });
        continue;
      case 'no_operations':
        verdicts.push({ kind: 'unjudged', item, reason: 'no_operations' });
        continue;
      case 'ready':
        break;
    }
    if (traffic === null) {
      verdicts.push({ kind: 'unjudged', item, reason: 'no_traffic' });
      continue;
    }
    let result: PrismResult;
    try {
      result = await verifyOpenApiTraffic(doc, traffic.exchanges, {
        signal: options.signal,
        ...(options.prismTimeoutMs === undefined ? {} : { timeoutMs: options.prismTimeoutMs }),
      });
    } catch (error) {
      options.signal.throwIfAborted();
      if (!(error instanceof ContractToolError)) throw error;
      return toolHalt(error, item);
    }
    verdicts.push(
      trafficVerdict(item, result, sourceAtCommit, {
        overflow: traffic.overflow,
        warnings: doc.warnings,
      }),
    );
  }
  return { kind: 'judged', verdicts };
};

/**
 * 계약 검사 계획이 있는데 판정이 계약 검사 규칙마다 정확히 하나씩(판정 · 판정 없음)이 아니면 빠진 규칙의 표시 ID (맞으면 `[]`).
 * 검사 단계 · 병합 재검사가 기록 전에 스스로 확인한다(계약 검사 결과가 빠진 채 통과로 가는 길을 한 겹 더 막는다).
 */
export const missingContractVerdicts = (
  plan: ContractPlan | null,
  run: ContractRun | undefined,
): string[] =>
  plan === null
    ? []
    : plan.items
        .filter(
          (item) =>
            run?.kind !== 'judged' ||
            run.verdicts.filter((verdict) => verdict.item.rule.id === item.rule.id).length !== 1,
        )
        .map((item) => item.rule.displayId);

const newId = createUlidGenerator();

/** 계약 검사 결과 → 판정 기록 (실행기 `redocly-prism`). 판정 없음은 기록하지 않는다. */
export const contractJudgmentsFrom = (
  run: ContractRun | undefined,
  meta: { runId: string; stepId: string; commit: string; judgedAt: string },
): JudgmentResult[] =>
  run?.kind !== 'judged'
    ? []
    : run.verdicts.flatMap((verdict) =>
        verdict.kind !== 'judged'
          ? []
          : [
              {
                id: newId(),
                ruleId: verdict.item.rule.id,
                runId: meta.runId,
                stepId: meta.stepId,
                commit: meta.commit,
                judgedAt: meta.judgedAt,
                status: verdict.status,
                runner: CONTRACT_JUDGE_RUNNER,
                exitCode: null,
                reporterPath: null,
                cases: verdict.cases,
                quarantineReason: null,
              },
            ],
      );

/** 단계 통과를 막지 않는 계약 판정의 규칙 ID (등록된 문서의 형식 오류: 구현이 고칠 수 없다). */
export const nonBlockingContractRuleIds = (run: ContractRun | undefined): Set<string> =>
  new Set(
    run?.kind !== 'judged'
      ? []
      : run.verdicts
          .filter((verdict) => verdict.kind === 'judged' && !verdict.blocking)
          .map((verdict) => verdict.item.rule.id),
  );
