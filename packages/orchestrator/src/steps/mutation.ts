// 변이 주입 단계 실행기 (JDG-04 · RUN-02 · RUN-04 · NRM-09 · COST-01 · NFR-01 · NFR-02, M3-07 #52, ADR-033 · ADR-139).
// 실행의 대상 규칙 가운데 변이 대상(인수 테스트로 판정하는 규칙 · 대상 블록이 지금 선언에 있음 · 인수 테스트 있음)을 위험도 high → medium →
// low → 없음, 같으면 표시 ID 순으로 하나씩 다룬다. 규칙마다:
//   ① 변이 주입 역할 세션 1개(세션 폴더 = 대상 규칙 글 + 대상 블록 소스의 읽기 전용 사본, 인수 테스트 없음, 도구 = 읽기 3종 +
//      `propose_mutant`). 변이는 판정 커밋의 git 객체에서 검증한다(`mutation/mutant.ts`)
//   ② 변이를 냈으면 판정 커밋의 격리 체크아웃(`judgeCommit`: detached 체크아웃, 판정 뒤 지움)에 적용하고 그 규칙의 인수 테스트만 판정
//      러너로 돌린다. 커밋하지 않으므로 실행 브랜치 · 기준 브랜치에 남지 않는다
//   ③ 결과를 그 규칙의 변이 기록으로 바로 남긴다: 대상 케이스가 하나라도 실패 = 검출(검증됨), 모두 통과 = 생존, 그 밖(변이 없음 ·
//      케이스 없음 · 체크아웃 · 설치 · 수집 · 러너 오류)은 판정 불가(미검증, 검출로 세지 않는다)
// 변이 생존 · 판정 불가는 실행을 실패로 만들지 않는다(단계 통과). 세션을 열 예산이 없으면 엔진이 실행을 예산 초과로 끝내고(병합 전), 남은
// 규칙은 기록 없이 '변이 미검증'으로 남는다. 인수 테스트 변조 · 규범 저장소 불일치는 판정을 믿을 수 없어 실행을 끝낸다(검사 단계와 같다).
// 기본 실행기 목록의 변이 주입 단계다(M3-54 #311, ADR-143). 유형 A만 새 변이를 내고 그 밖의 유형은 생략으로 기록한다.
import fs from 'node:fs';
import path from 'node:path';

import {
  type Block,
  createUlidGenerator,
  type MutationOutcome,
  type MutationReinforcement,
  type MutationResult,
  mutationStatusOf,
  type Risk,
  type Rule,
} from '@bive/shared';

import type { StepContext, StepExecutor, StepOutcome } from '../engine/types.js';
import { createGitRunner } from '../git/git-exec.js';
import { effectiveContracts } from '../norms/effective.js';
import {
  type CheckedMutant,
  checkMutant,
  inBlocks,
  isRegularBlob,
  listCommitFiles,
  MUTANT_FILE_MAX_BYTES,
  mutantPathProblem,
  readBlobText,
  type TreeFile,
} from '../mutation/mutant.js';
import { MUTATOR_SYSTEM_PROMPT, mutatorRuleFile, mutatorTaskPrompt } from '../mutation/prompts.js';
import { denied } from '../tools/result.js';
import {
  casesOf,
  createNormGuard,
  judgeCommit,
  type JudgingOptions,
  lastPassed,
  MAX_LISTED,
  type NormGuard,
  normHalt,
} from './judging.js';
import { acceptanceBaselineOf, headStepKindOf, missingBaselineMessage } from './run-type.js';
import { JUDGE_RUNNER_ERROR_REASON } from './red-check.js';

const newId = createUlidGenerator();

/** 변이 주입 단계 실행기의 선택 (판정 · 설치 · git을 바꿔 끼운다, 기본은 실제 판정 러너 · 설치). */
export type MutationStepOptions = JudgingOptions;

/** 세션 폴더에 놓는 대상 블록 소스 사본의 상한 (파일 수 · 바이트 합). 넘는 파일은 놓지 않고 수만 작업 지시에 적는다. */
export const MUTATOR_COPY_LIMITS = { files: 200, bytes: 4 * 1024 * 1024 } as const;

/** 변이 대상이 아닌 대상 규칙의 사유. */
export type MutationExclusion =
  /** 내장 규칙(구조 · 계약 검사): 인수 테스트로 판정하지 않는다 */
  | 'builtin'
  /** 블록 선언이 없다 */
  | 'no_block_declaration'
  /** 대상 블록이 없거나 지금 선언에 없는 이름뿐이다 */
  | 'no_target_blocks'
  /** 판정 커밋에 그 규칙의 인수 테스트가 없다 */
  | 'no_acceptance';

/** 위험도 순위: high → medium → low → 없음(`null`, 값이 있는 규칙 뒤). */
const RISK_RANK: Readonly<Record<Risk | 'null', number>> = { high: 0, medium: 1, low: 2, null: 3 };

/** 표시 ID 순 (`RULE-NNN`: 길이 → 글자, 자리수가 늘어도 수 순서와 같다). */
const compareDisplayIds = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/** 변이 대상 순서 (NRM-09 "고위험 규칙부터"): 위험도 high → medium → low → 없음, 같으면 표시 ID 순. */
export const compareMutationOrder = (
  a: Pick<Rule, 'risk' | 'displayId'>,
  b: Pick<Rule, 'risk' | 'displayId'>,
): number =>
  RISK_RANK[a.risk ?? 'null'] - RISK_RANK[b.risk ?? 'null'] ||
  compareDisplayIds(a.displayId, b.displayId);

/** 규칙의 대상 블록 가운데 지금 선언에 있는 블록 (선언 순서). */
const targetBlocksOf = (rule: Pick<Rule, 'targetBlockIds'>, blocks: readonly Block[]): Block[] =>
  blocks.filter((block) => rule.targetBlockIds.includes(block.name));

/** 변이 대상 고르기: 대상 규칙마다 대상이면 블록과 함께, 아니면 사유. 대상은 변이 순서로 정렬한다. */
export const selectMutationTargets = (
  rules: readonly Rule[],
  declaration: readonly Block[] | null,
  acceptanceRuleDirs: readonly string[],
): {
  targets: { rule: Rule; blocks: Block[] }[];
  excluded: { rule: Rule; reason: MutationExclusion }[];
} => {
  const targets: { rule: Rule; blocks: Block[] }[] = [];
  const excluded: { rule: Rule; reason: MutationExclusion }[] = [];
  for (const rule of rules) {
    if (rule.builtin) {
      excluded.push({ rule, reason: 'builtin' });
      continue;
    }
    if (declaration === null) {
      excluded.push({ rule, reason: 'no_block_declaration' });
      continue;
    }
    const blocks = targetBlocksOf(rule, declaration);
    if (blocks.length === 0) {
      excluded.push({ rule, reason: 'no_target_blocks' });
      continue;
    }
    if (!acceptanceRuleDirs.includes(rule.displayId)) {
      excluded.push({ rule, reason: 'no_acceptance' });
      continue;
    }
    targets.push({ rule, blocks });
  }
  targets.sort((a, b) => compareMutationOrder(a.rule, b.rule));
  return { targets, excluded };
};

const halt = (reason: string, exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason,
  exitDetail,
});

/** 세션 폴더: 대상 규칙 글 + 대상 블록 소스의 사본 (판정 커밋의 git 객체에서, 상한 안). */
const prepareSession = async (
  context: StepContext,
  sessionDir: string,
  rule: Rule,
  blocks: readonly Block[],
  files: readonly TreeFile[],
  contractFiles: readonly string[],
  git: ReturnType<typeof createGitRunner>,
): Promise<{ copied: string[]; omitted: number }> => {
  const ruleFile = path.join(sessionDir, mutatorRuleFile(rule.displayId));
  fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
  fs.writeFileSync(ruleFile, `# ${rule.displayId} ${rule.title}\n\n${rule.statement}\n`);
  const sources = files
    .filter(
      (file) =>
        isRegularBlob(file) &&
        mutantPathProblem(file.path, contractFiles) === null &&
        inBlocks(file.path, blocks),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const copied: string[] = [];
  let bytes = 0;
  let omitted = 0;
  for (const file of sources) {
    const fits =
      copied.length < MUTATOR_COPY_LIMITS.files &&
      file.size <= MUTANT_FILE_MAX_BYTES &&
      bytes + file.size <= MUTATOR_COPY_LIMITS.bytes;
    const text = fits ? await readBlobText(git, context.git.repoPath, file.object) : null;
    if (text === null) {
      omitted += 1;
      continue;
    }
    const target = path.join(sessionDir, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    copied.push(file.path);
    bytes += file.size;
  }
  return { copied, omitted };
};

/** 격리 체크아웃에 변이를 쓴다: 경로가 체크아웃 안의 일반 파일일 때만 (링크를 따라가지 않는다). */
const writeMutant = (checkoutDir: string, mutant: CheckedMutant): void => {
  const target = path.join(checkoutDir, ...mutant.patch.path.split('/'));
  const relative = path.relative(checkoutDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('체크아웃 밖 경로');
  if (!fs.lstatSync(target).isFile()) throw new Error('일반 파일이 아님');
  fs.writeFileSync(target, mutant.mutated);
};

/**
 * 변이 하나를 판정 커밋의 격리 체크아웃에 적용해 그 규칙의 인수 테스트를 판정한다 (첫 주입 · 재주입 공통). 판정을 믿을 수 없으면
 * (인수 테스트 · 판정 입력 변조, 규범 저장소 불일치) 실행을 끝내는 결과를 돌려준다.
 */
const judgeMutant = async (
  context: StepContext,
  input: {
    readonly commit: string;
    readonly rule: Rule;
    readonly mutant: CheckedMutant;
    readonly hashes: Readonly<Record<string, string>>;
    readonly norms: NormGuard;
    readonly options: MutationStepOptions;
  },
): Promise<
  { kind: 'outcome'; outcome: MutationOutcome } | { kind: 'halt'; outcome: StepOutcome }
> => {
  const { commit, rule, mutant } = input;
  const judged = await judgeCommit(
    context,
    {
      commit,
      selectRules: (dirs) => (dirs.includes(rule.displayId) ? [rule.displayId] : []),
      expectedAcceptanceHashes: input.hashes,
      norms: input.norms,
      signal: context.signal,
      applyMutant: (dir) => writeMutant(dir, mutant),
    },
    input.options,
  );
  const of = (outcome: MutationOutcome) => ({ kind: 'outcome', outcome }) as const;
  switch (judged.kind) {
    case 'acceptance_changed':
      return {
        kind: 'halt',
        outcome: halt('guard_violation', {
          commit,
          stage: judged.stage,
          ...(judged.moment === undefined ? {} : { moment: judged.moment }),
          message: '변이 판정 중 인수 테스트 · 테스트 실행기 · 판정 설정이 바뀌었습니다',
          changed: judged.changed.slice(0, MAX_LISTED),
        }),
      };
    case 'norm_mismatch':
      return { kind: 'halt', outcome: normHalt(judged.moment, judged.mismatches, { commit }) };
    case 'checkout_error':
      return of('checkout_error');
    case 'install_error':
      return of('install_error');
    case 'no_rules':
      return of('no_cases');
    case 'structure_halt':
    case 'contract_halt':
      return of('runner_error');
    case 'judged': {
      const { result } = judged;
      if (result.status === 'collect_error') return of('collect_error');
      if (result.status === 'runner_error') return of('runner_error');
      const cases = casesOf(result, rule.displayId);
      if (cases.some((item) => item.status === 'failed')) return of('killed');
      if (cases.length > 0 && cases.every((item) => item.status === 'passed'))
        return of('survived');
      return of('no_cases');
    }
  }
};

/**
 * 보강 실행(유형 C + 변이 보강 연결)의 변이 주입 단계 = 재주입 (ADR-141 ⑥ · ADR-143). 새 세션을 열지 않고 원인 기록의 변이(살아남았던
 * 같은 변이)를 판정 커밋(테스트 작성 커밋)에서 다시 검증해 격리 체크아웃에 적용하고 대상 규칙의 인수 테스트를 판정한다.
 * - 검출: 그 규칙에 '변이 검증됨' 기록 · 단계 통과(→ 병합)
 * - 생존: '변이 생존' 기록 · 미충족(→ 테스트 작성으로 회귀, 회귀 수 `regressionCount`, 상한 뒤 실패)
 * - 판정 불가(변이를 더는 적용할 수 없음 · 체크아웃 · 설치 · 수집 · 러너 오류 · 케이스 없음): 기록 없이(규칙은 '변이 생존' 그대로) 실행을
 *   끝낸다(닫힌 쪽: 검증됨으로 세지 않고 회귀로 헛돌지 않는다)
 */
const reinject = async (
  context: StepContext,
  link: Pick<MutationReinforcement, 'mutationResultId'>,
  options: MutationStepOptions,
  git: ReturnType<typeof createGitRunner>,
): Promise<StepOutcome> => {
  const commit = context.run.headCommit;
  if (
    commit === null ||
    lastPassed(context.steps, headStepKindOf(context.run.type))?.commit !== commit
  ) {
    return halt('state_inconsistent', {
      message: '판정 커밋이 실행의 마지막 완료 단계 커밋이 아닙니다',
      commit,
    });
  }
  const baseline = acceptanceBaselineOf(context.run, context.steps);
  if (baseline === null || baseline.kind !== 'hashes') {
    return halt('state_inconsistent', { message: missingBaselineMessage(context.run.type) });
  }
  const { cause, rule, declaration, contractFiles } = context.read((store) => {
    const found = store.mutations.get(link.mutationResultId);
    return {
      cause: found,
      rule: found === null ? null : store.rules.get(found.ruleId),
      declaration: store.blockDeclarations.current()?.declaration.blocks ?? null,
      contractFiles: effectiveContracts(store).map((contract) => contract.sourceFile),
    };
  });
  if (
    cause === null ||
    cause.mutant === null ||
    rule === null ||
    !context.run.targetRuleIds.includes(rule.id)
  ) {
    return halt('state_inconsistent', {
      message: '보강 실행의 원인 변이 기록을 읽지 못했습니다',
      mutationResultId: link.mutationResultId,
    });
  }
  const base = { commit, ruleId: rule.displayId, reinjected: link.mutationResultId };
  const blocks = declaration === null ? [] : targetBlocksOf(rule, declaration);
  const files = await listCommitFiles(git, context.git.repoPath, commit);
  const checked = await checkMutant(cause.mutant, {
    git,
    repoPath: context.git.repoPath,
    files: new Map(files.map((file) => [file.path, file])),
    blocks,
    contractFiles,
  });
  if (!checked.ok) {
    return halt(JUDGE_RUNNER_ERROR_REASON, {
      ...base,
      stage: 'reinject',
      message: '살아남았던 변이를 판정 커밋에 다시 적용할 수 없습니다',
      detail: checked.result.reason ?? checked.result.status,
    });
  }
  const judged = await judgeMutant(context, {
    commit,
    rule,
    mutant: checked.mutant,
    hashes: baseline.hashes,
    norms: createNormGuard(context),
    options,
  });
  if (judged.kind === 'halt') return judged.outcome;
  const { outcome } = judged;
  if (outcome !== 'killed' && outcome !== 'survived') {
    return halt(JUDGE_RUNNER_ERROR_REASON, {
      ...base,
      stage: 'reinject',
      message: '재주입 판정을 끝내지 못했습니다 (검증됨으로 세지 않는다)',
      outcome,
    });
  }
  const record: MutationResult = {
    id: newId(),
    ruleId: rule.id,
    runId: context.run.id,
    stepId: context.step.id,
    sessionId: null,
    commit,
    status: mutationStatusOf(outcome),
    outcome,
    // 실제로 다시 적용한 변이 (원인 기록의 변이와 같아야 한다)
    mutant: checked.mutant.patch,
    recordedAt: new Date().toISOString(),
  };
  context.read((store) => store.mutations.record(record));
  const detail = { ...base, status: record.status, outcome, mutationResultId: record.id };
  return outcome === 'killed'
    ? { status: 'passed', exitDetail: detail }
    : { status: 'unmet', exitDetail: { ...detail, reason: MUTANT_SURVIVED_REASON } };
};

/** 재주입에서도 살아남은 미충족의 사유 (`exitDetail.reason`). */
export const MUTANT_SURVIVED_REASON = 'mutant_survived';

/** 변이 대상이 하나도 없어 생략한 변이 주입 단계의 사유 (`exitDetail.reason`). */
export const NO_MUTATION_TARGETS = 'no_mutation_targets';

/** 변이 주입 단계 실행기를 만든다. */
export const createMutationExecutor =
  (options: MutationStepOptions = {}): StepExecutor =>
  async (context): Promise<StepOutcome> => {
    const git = options.git ?? createGitRunner();
    // 유형 A만 새 변이를 낸다. 유형 C는 보강 실행(변이 보강 연결이 있음)일 때만 재주입한다 (ADR-020: 변이 주입은 A · C(보강)만,
    // 유형 B는 계획에서 생략, D는 계획에 없음)
    if (context.run.type === 'C') {
      // 자동 보강 · 사람이 시작한 보강(검토 대기열의 테스트 보강, M3-08 #53 · ADR-145)이 같은 재주입을 탄다
      const causeId = context.read((store) =>
        store.mutations.reinforcementCauseOfRun(context.run.id),
      );
      if (causeId !== null) return reinject(context, { mutationResultId: causeId }, options, git);
    }
    if (context.run.type !== 'A') {
      return { status: 'skipped', exitDetail: { reason: 'run_type', runType: context.run.type } };
    }
    const { rules, declaration, contractFiles } = context.read((store) => ({
      rules: context.run.targetRuleIds
        .map((id) => store.rules.get(id))
        .filter((rule): rule is Rule => rule !== null && rule.deletedAt === null),
      declaration: store.blockDeclarations.current()?.declaration.blocks ?? null,
      contractFiles: effectiveContracts(store).map((contract) => contract.sourceFile),
    }));
    // 블록 선언 · 대상 블록으로 대상이 하나도 없으면 커밋 · 해시를 보기 전에 세션 · 판정 없이 끝난다: 이 실행에서 한 일이 없으므로
    // 생략으로 기록한다 (사유 `no_mutation_targets`, ADR-143)
    const early = selectMutationTargets(
      rules,
      declaration,
      rules.map((rule) => rule.displayId),
    );
    if (early.targets.length === 0) {
      return {
        status: 'skipped',
        exitDetail: {
          reason: NO_MUTATION_TARGETS,
          commit: context.run.headCommit,
          excluded: early.excluded.map(({ rule, reason }) => ({ ruleId: rule.displayId, reason })),
        },
      };
    }
    // 판정할 커밋 = 마지막 완료 단계 커밋 (검사 단계가 판정한 커밋)
    const commit = context.run.headCommit;
    const headKind = headStepKindOf(context.run.type);
    if (commit === null || lastPassed(context.steps, headKind)?.commit !== commit) {
      return halt('state_inconsistent', {
        message: '판정 커밋이 실행의 마지막 완료 단계 커밋이 아닙니다',
        commit,
      });
    }
    const baseline = acceptanceBaselineOf(context.run, context.steps);
    if (baseline === null || baseline.kind !== 'hashes') {
      return halt('state_inconsistent', { message: missingBaselineMessage(context.run.type) });
    }
    const acceptanceDirs = [
      ...new Set(
        Object.keys(baseline.hashes)
          .map((file) => file.split('/')[1])
          .filter((dir): dir is string => dir !== undefined),
      ),
    ];
    const { targets, excluded } = selectMutationTargets(rules, declaration, acceptanceDirs);
    const excludedDetail = excluded.map(({ rule, reason }) => ({ ruleId: rule.displayId, reason }));
    if (targets.length === 0) {
      return { status: 'passed', exitDetail: { commit, results: [], excluded: excludedDetail } };
    }
    const files = await listCommitFiles(git, context.git.repoPath, commit);
    const tree = new Map(files.map((file) => [file.path, file]));
    const norms = createNormGuard(context);
    const results: Record<string, unknown>[] = [];
    for (const { rule, blocks } of targets) {
      context.signal.throwIfAborted();
      const sessionDir = path.join(
        context.biveHome,
        'work',
        context.project.id,
        'sessions',
        newId(),
      );
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      // 세션 콜백이 채운다 (닫힘 안의 대입은 흐름 분석이 보지 못해 칸으로 둔다)
      const proposed: { mutant: CheckedMutant | null } = { mutant: null };
      let sessionId: string;
      let sessionEnd: string;
      try {
        const inputs = await prepareSession(
          context,
          sessionDir,
          rule,
          blocks,
          files,
          contractFiles,
          git,
        );
        const session = await context.runSession({
          workDir: sessionDir,
          systemPrompt: MUTATOR_SYSTEM_PROMPT,
          prompt: mutatorTaskPrompt({
            runDisplayId: context.run.displayId,
            rule,
            blocks,
            copied: inputs.copied.length,
            omitted: inputs.omitted,
          }),
          vars: { ruleId: rule.displayId, runId: context.run.displayId },
          hooks: {
            proposeMutant: async (input) => {
              // 실행기가 첫 변이 뒤 닫히므로 둘째 변이는 여기까지 오지 않는다 (이중 방어)
              if (proposed.mutant !== null) return denied('session_closed', '변이는 세션마다 1개');
              const checked = await checkMutant(input, {
                git,
                repoPath: context.git.repoPath,
                files: tree,
                blocks,
                contractFiles,
              });
              if (!checked.ok) return checked.result;
              proposed.mutant = checked.mutant;
              return `변이 접수: ${input.path}`;
            },
          },
        });
        sessionId = session.sessionId;
        sessionEnd = session.endReason;
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
      const { mutant } = proposed;
      // 세션이 정상 종료하지 않았고 변이도 받지 못했으면 '변이 없음'으로 삼키지 않는다: 다른 역할의 세션 오류처럼 단계 미충족
      // (변이 주입 단계에는 회귀 규칙이 없어 실행이 `step_unmet`으로 끝난다, ADR-143). 변이를 받았으면 세션 끝이 어떻든 판정한다
      if (mutant === null && sessionEnd !== 'success') {
        return {
          status: 'unmet',
          exitDetail: {
            reason: 'session_error',
            ruleId: rule.displayId,
            sessionId,
            endReason: sessionEnd,
            commit,
            results,
          },
        };
      }
      let outcome: MutationOutcome;
      if (mutant === null) {
        outcome = 'no_mutant';
      } else {
        const judged = await judgeMutant(context, {
          commit,
          rule,
          mutant,
          hashes: baseline.hashes,
          norms,
          options,
        });
        if (judged.kind === 'halt') return judged.outcome;
        outcome = judged.outcome;
      }
      const record: MutationResult = {
        id: newId(),
        ruleId: rule.id,
        runId: context.run.id,
        stepId: context.step.id,
        sessionId,
        commit,
        status: mutationStatusOf(outcome),
        outcome,
        mutant: mutant?.patch ?? null,
        recordedAt: new Date().toISOString(),
      };
      context.read((store) => store.mutations.record(record));
      results.push({
        ruleId: rule.displayId,
        status: record.status,
        outcome,
        sessionId,
        mutantPath: mutant?.patch.path ?? null,
      });
    }
    return { status: 'passed', exitDetail: { commit, results, excluded: excludedDetail } };
  };
