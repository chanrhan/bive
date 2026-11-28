// 판정 상태 표시: 재검증 필요 · 재판정 불일치 격리 (JDG-02 · NFR-05, M3-14 #59, ADR-156).
// 표시는 판정이 아니다. 실행기 출력 없이 통과 · 실패를 바꾸지 않고(JDG-01), "그 규칙의 최신 판정이 낡았다 · 흔들린다"를 실행 밖
// 판정 기록 한 줄(실행 · 단계 없음, 케이스 없음)로 남길 뿐이다. 새 표는 없다(M3-08의 판정 격리와 같은 모양, ADR-145).
// - 재검증 필요: 상태 `needs_recheck`, 격리 사유 없음. 커밋 = 감시자는 그때의 기준 브랜치 머리, 규칙 편집 · 블록 선언 변경은 낡은
//   판정의 커밋. 실행기 = 낡은 판정의 실행기. 판정 시각 = 표시 시각(낡은 판정보다 늘 뒤)
// - 재판정 불일치 격리: 상태 `quarantined`, 사유 고정 글 {@link REJUDGE_MISMATCH_REASON}. 사람의 판정 격리(검토 대기열 처리)와는
//   검토 항목 연결 유무로 가른다(사람의 격리 기록은 처리된 항목이 가리킨다)
// - 표시할 수 있는 규칙: 최신 판정 기록이 있고 그것이 재검증 필요 · 격리가 아님(미판정 규칙은 낡을 판정이 없다. 격리는 사람 ·
//   재현성 확인의 결정이라 덮지 않는다). 그 규칙을 실제로 판정한 새 기록이 생기면 그것이 최신이다
// - 쓰기는 부르는 쪽의 저장소 트랜잭션 안에서 한다. 쓰기 직전에 최신 판정이 그대로인지 다시 본다(그 사이 새 판정이 생겼으면 표시하지
//   않는다)
// - 이 모듈과 판정 단계(`steps/judging.ts`) · 검토 대기열(`review/review-queue.ts`)만 판정 기록을 쓴다(`integrity.test.ts`)
import type { Block, BlockDeclaration, JudgmentResult, Rule } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { isEffectiveRule, retiredRuleSet } from '../norms/effective.js';

/** 재현성 확인이 같은 커밋의 판정이 흔들린 규칙에 남기는 격리 사유 (고정 글). */
export const REJUDGE_MISMATCH_REASON = '재판정 불일치';

/** 표시 시각과 ID. */
export interface MarkClock {
  /** 표시 시각 (ms) */
  readonly now: number;
  readonly newId: () => string;
}

/** 최신 판정이 재검증 필요로 표시할 수 있는 판정인지: 기록이 있고 재검증 필요 · 격리가 아니다. */
export const isMarkableJudgment = (latest: JudgmentResult | null): latest is JudgmentResult =>
  latest !== null && latest.status !== 'needs_recheck' && latest.status !== 'quarantined';

/** 대상 블록으로 재검증 필요를 따지는 규칙: 효력 있고, 내장 규칙이 아니고, 대상 블록이 있다. */
export const isBlockTargetedRule = (rule: Rule, retired: ReadonlySet<string>): boolean =>
  isEffectiveRule(rule, retired) && !rule.builtin && rule.targetBlockIds.length > 0;

/** 블록 대상 규칙과 그 최신 판정 (표시할 수 있는 것만, 표시 ID 순). 감시자 · 블록 선언 변경이 쓴다. */
export const blockTargetedCandidates = (
  store: ProjectStore,
): { rule: Rule; latest: JudgmentResult }[] => {
  const retired = retiredRuleSet(store);
  const latest = store.judgments.latestForRules();
  const found: { rule: Rule; latest: JudgmentResult }[] = [];
  for (const rule of store.rules.list()) {
    if (!isBlockTargetedRule(rule, retired)) continue;
    const judgment = latest.get(rule.id) ?? null;
    if (isMarkableJudgment(judgment)) found.push({ rule, latest: judgment });
  }
  return found;
};

/** 표시 하나: 이 규칙의 최신 판정 `latest`가 낡았고, 표시 기록의 커밋은 `commit`. */
export interface RecheckMark {
  readonly rule: Pick<Rule, 'id'>;
  readonly latest: JudgmentResult;
  readonly commit: string;
}

/** 판정 시각 문자열: 표시 시각이 낡은 판정보다 앞이거나 같으면 그 판정의 1ms 뒤 (최신 판정 순서가 판정 시각 → ID라서). */
const markTime = (now: number, latest: JudgmentResult): string =>
  new Date(Math.max(now, Date.parse(latest.judgedAt) + 1)).toISOString();

/**
 * 재검증 필요 표시를 남긴다 (부르는 쪽 트랜잭션 안). 규칙마다 지금 최신 판정이 `latest`와 같을 때만 남긴다.
 * @returns 남긴 기록 (받은 순서)
 */
export const recordNeedsRecheck = (
  store: ProjectStore,
  marks: readonly RecheckMark[],
  clock: MarkClock,
): JudgmentResult[] => {
  const records: JudgmentResult[] = [];
  for (const { rule, latest, commit } of marks) {
    if (store.judgments.latestByRule(rule.id)?.id !== latest.id) continue;
    records.push({
      id: clock.newId(),
      ruleId: rule.id,
      runId: null,
      stepId: null,
      commit,
      judgedAt: markTime(clock.now, latest),
      status: 'needs_recheck',
      runner: latest.runner,
      exitCode: null,
      reporterPath: null,
      cases: [],
      quarantineReason: null,
    });
  }
  return records.length === 0 ? [] : store.judgments.record(records);
};

/**
 * 사람이 규칙의 진술을 고친 편집의 재검증 필요 (편집 트랜잭션 안, ADR-109): 최신 판정이 표시할 수 있는 판정이면 1건(커밋 = 그 판정의
 * 커밋). 제목만 고친 편집은 부르지 않는다.
 */
export const markStatementEdited = (
  store: ProjectStore,
  ruleId: string,
  clock: MarkClock,
): JudgmentResult[] => {
  const latest = store.judgments.latestByRule(ruleId);
  if (!isMarkableJudgment(latest)) return [];
  return recordNeedsRecheck(
    store,
    [{ rule: { id: ruleId }, latest, commit: latest.commit }],
    clock,
  );
};

/** 같은 이름 블록의 include가 같은지 (순서까지). */
const sameInclude = (a: Block, b: Block): boolean =>
  a.include.length === b.include.length &&
  a.include.every((pattern, i) => pattern === b.include[i]);

/**
 * 블록 선언 새 판으로 대상이 바뀐 블록 이름: 앞 판에 있던 블록 가운데 새 판에 같은 이름이 없거나(지움 · 이름 바꿈) include가 다른 것.
 * 앞 판이 없으면(첫 선언) 없다.
 */
export const changedBlockNames = (
  previous: BlockDeclaration | null,
  next: BlockDeclaration,
): Set<string> => {
  const changed = new Set<string>();
  if (previous === null) return changed;
  const byName = new Map(next.blocks.map((block) => [block.name, block]));
  for (const block of previous.blocks) {
    const after = byName.get(block.name);
    if (after === undefined || !sameInclude(block, after)) changed.add(block.name);
  }
  return changed;
};

/** 앞 판의 행이 깨져 읽지 못함 (모든 대상 블록이 바뀐 것으로 본다: 닫힌 쪽). */
export const UNREADABLE_DECLARATION = 'unreadable';

/**
 * 블록 선언 저장의 재검증 필요 (선언 저장 트랜잭션 안): 대상 블록 가운데 바뀐 블록({@link changedBlockNames})이 있는 블록 대상 규칙
 * 마다 1건(커밋 = 낡은 판정의 커밋). 앞 판을 읽지 못했으면 블록 대상 규칙 전부다.
 */
export const markBlocksChanged = (
  store: ProjectStore,
  previous: BlockDeclaration | null | typeof UNREADABLE_DECLARATION,
  next: BlockDeclaration,
  clock: MarkClock,
): JudgmentResult[] => {
  const changed = previous === UNREADABLE_DECLARATION ? null : changedBlockNames(previous, next);
  if (changed !== null && changed.size === 0) return [];
  const marks = blockTargetedCandidates(store)
    .filter(({ rule }) => changed === null || rule.targetBlockIds.some((name) => changed.has(name)))
    .map(({ rule, latest }) => ({ rule, latest, commit: latest.commit }));
  return recordNeedsRecheck(store, marks, clock);
};

/** 재판정 불일치 격리 하나: 같은 커밋 `commit`의 판정이 흔들린 규칙. */
export interface RejudgeMismatch {
  readonly ruleId: string;
  readonly commit: string;
  readonly runner: JudgmentResult['runner'];
}

/**
 * 재판정 불일치 격리를 남긴다 (트랜잭션 1개). 규칙마다 1건(상태 '격리', 사유 {@link REJUDGE_MISMATCH_REASON}, 실행 · 단계 · 케이스
 * 없음). 격리는 무엇도 통과시키지 않는다(준수 분모에서 빠질 뿐이고 검사 · 병합 재검사는 저장된 판정을 읽지 않는다).
 */
export const recordRejudgeMismatch = (
  store: ProjectStore,
  mismatches: readonly RejudgeMismatch[],
  clock: MarkClock,
): JudgmentResult[] => {
  if (mismatches.length === 0) return [];
  return store.transaction(() =>
    store.judgments.record(
      mismatches.map(({ ruleId, commit, runner }) => {
        const latest = store.judgments.latestByRule(ruleId);
        return {
          id: clock.newId(),
          ruleId,
          runId: null,
          stepId: null,
          commit,
          judgedAt:
            latest === null ? new Date(clock.now).toISOString() : markTime(clock.now, latest),
          status: 'quarantined' as const,
          runner,
          exitCode: null,
          reporterPath: null,
          cases: [],
          quarantineReason: REJUDGE_MISMATCH_REASON,
        };
      }),
    ),
  );
};
