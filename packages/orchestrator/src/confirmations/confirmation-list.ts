// 확인할 것 목록 (`confirmation.list`, NRM-07, ADR-100 D3 · B⑦ · G · A7, M7-13 #225, ADR-113).
// - 저장소를 읽기만 한다. 항목은 규범 변경 기록(폐기 · 대체 · 확인 풀림 · 테스트 변경)과 요구사항 · 규칙의 확인 상태에서 만든다
// - 순서: ① 에이전트의 폐기 · 대체(확인 여부와 무관, B⑦) ② 확인됨 규칙의 테스트 변경 알림(G) ③ 미확인 요구사항 · 규칙.
//   ① · ②는 기록 시각 최신순(같으면 순번 큰 것 먼저), ③은 마지막 수정 시각 최신순(같으면 표시 ID 순). 확인 풀림은 그 원인인
//   폐기 · 대체 항목의 `released`로 싣는다(같은 폐기가 두 항목으로 나오지 않는다. 지금 확인 풀림의 원인은 폐기 · 대체뿐이고
//   0019 트리거가 그 밖의 원인을 거부한다)
// - 내려가는 조건: 사람이 대상을 [확인](`confirmation.set`)했을 때만 빠진다. ① · ②는 그 규칙의 승인 기록 `confirm` 가운데
//   `detail.seenNormChangeSeq`(확인 순간의 규범 변경 기록 마지막 순번)가 그 기록의 순번 이상인 것이 있을 때, ③은 확인됨일 때.
//   사람의 편집(`rule.update`) · 확인 행의 시각은 보지 않는다(편집은 "알림을 봤다"가 아니다). 시각을 비교하지 않으므로 시계가
//   뒤로 가거나 같은 밀리초여도 결과가 같다. 삭제된 대상은 빠진다. 폐기된 규칙은 ③에 오지 않는다(①에만). 폐기된 규칙의 테스트
//   변경 알림은 그 폐기 항목이 아직 내려가지 않았을 때만 그 항목이 대신한다(사람이 폐기를 본 뒤의 알림은 ②에 나온다)
// - 에이전트가 쓴 글은 표시 값(ADR-089)으로만 내보낸다. 저장된 기록은 바꾸지 않는다
import {
  CONFIRMATION_LIST_MAX_ITEMS,
  type ConfirmationItem,
  type ConfirmationListResult,
  type ConfirmationNormItem,
  type ConfirmationRetirementItem,
  type ConfirmationRuleText,
  type ConfirmationTarget,
  type ConfirmationTestChangeItem,
  NORM_CHANGE_TEXT_DISPLAY_MAX,
  type NormChangeEntry,
  type Rule,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { retiredRuleSet } from '../norms/effective.js';
import { displayText } from '../text-limit.js';

/** 표시 값 하나 (잘렸으면 `truncated`를 켠다). */
const shown = (text: string, truncated: { value: boolean }): string => {
  const value = displayText(text, NORM_CHANGE_TEXT_DISPLAY_MAX);
  if (value.truncated) truncated.value = true;
  return value.text;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 기록의 규칙 내용(`before` · `after`)에서 제목 · 진술. 모양이 다르면 `null`. */
const ruleText = (value: unknown, truncated: { value: boolean }): ConfirmationRuleText | null => {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.statement !== 'string') {
    return null;
  }
  return { title: shown(value.title, truncated), statement: shown(value.statement, truncated) };
};

/**
 * 사람이 규칙의 규범 변경 기록을 어디까지 봤는지: 그 규칙의 승인 기록 `confirm`의 `seenNormChangeSeq` 가운데 가장 큰 값
 * (없으면 0, 그 칸이 없는 옛 확인도 0). 이 값 이하 순번의 폐기 · 대체 · 테스트 변경 기록은 본 것이다 (ADR-113).
 */
export const seenNormChangeSeqOf = (store: ProjectStore, ruleId: string): number =>
  store.approvalLog
    .list({ entity: 'Rule', id: ruleId })
    .reduce(
      (seen, entry) =>
        entry.action === 'confirm' ? Math.max(seen, entry.detail.seenNormChangeSeq ?? 0) : seen,
      0,
    );

/** 폐기 · 대체 기록 (원인이 될 수 있는 종류). */
const isRetirement = (entry: NormChangeEntry): boolean =>
  entry.kind === 'retired' || entry.kind === 'superseded';

/** 대상 규칙이 아직 사람이 보지 않은 폐기 · 대체 · 테스트 변경 기록 (순번 순). */
const pendingNotices = (
  store: ProjectStore,
  entries: readonly NormChangeEntry[],
): { entry: NormChangeEntry; rule: Rule }[] => {
  const rules = new Map<string, { rule: Rule | null; seen: number }>();
  const ruleOf = (id: string) => {
    let found = rules.get(id);
    if (found === undefined) {
      found = { rule: store.rules.get(id), seen: seenNormChangeSeqOf(store, id) };
      rules.set(id, found);
    }
    return found;
  };
  const pending: { entry: NormChangeEntry; rule: Rule }[] = [];
  for (const entry of entries) {
    const notice = isRetirement(entry) || entry.kind === 'test_changed';
    if (!notice || entry.targetRef.entity !== 'Rule') continue;
    const { rule, seen } = ruleOf(entry.targetRef.id);
    if (rule === null || rule.deletedAt !== null) continue;
    if (entry.seq <= seen) continue;
    pending.push({ entry, rule });
  }
  // 폐기된 규칙의 테스트 변경 알림은 그 폐기 항목이 아직 남아 있을 때만 그 항목이 대신한다
  const retiring = new Set(
    pending.filter(({ entry }) => isRetirement(entry)).map(({ rule }) => rule.id),
  );
  return pending.filter(
    ({ entry, rule }) => !(entry.kind === 'test_changed' && retiring.has(rule.id)),
  );
};

/**
 * 대상에 사람이 아직 보지 않은 폐기 · 대체 · 테스트 변경 기록이 있는지. 이미 확인됨인 규칙도 이것이 참이면 다시 확인할 수 있다
 * (`confirmation.set`: "이 알림을 봤다", ADR-113).
 */
export const hasPendingNotice = (store: ProjectStore, target: ConfirmationTarget): boolean =>
  target.entity === 'Rule' &&
  pendingNotices(store, store.normChanges.list({ entity: 'Rule', id: target.id })).length > 0;

const byNewest = (a: { seq: number; at: string }, b: { seq: number; at: string }): number =>
  Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq;

const retirementItem = (
  entry: NormChangeEntry,
  rule: Rule,
  bySeq: ReadonlyMap<number, NormChangeEntry>,
  releases: ReadonlyMap<number, NormChangeEntry>,
): ConfirmationRetirementItem => {
  const truncated = { value: false };
  const retirement = entry.detail.retirement;
  const successor = retirement?.supersededBy ?? null;
  const created =
    retirement?.createdSeq === undefined ? undefined : bySeq.get(retirement.createdSeq);
  const afterText = created === undefined ? null : ruleText(created.detail.after, truncated);
  const release = releases.get(entry.seq);
  return {
    kind: entry.kind === 'superseded' ? 'superseded' : 'retired',
    seq: entry.seq,
    at: entry.at,
    actor: entry.actor,
    sessionId: entry.sessionId,
    rule: { id: rule.id, displayId: rule.displayId },
    before: ruleText(entry.detail.before, truncated),
    after: successor === null || afterText === null ? null : { ...afterText, rule: successor },
    grounds: entry.reason === null ? null : shown(entry.reason, truncated),
    rationale:
      created === undefined || created.reason === null ? null : shown(created.reason, truncated),
    released: release === undefined ? null : { seq: release.seq, at: release.at },
    textTruncated: truncated.value,
  };
};

const testChangeItem = (
  store: ProjectStore,
  entry: NormChangeEntry,
  rule: Rule,
): ConfirmationTestChangeItem | null => {
  const change = entry.detail.testChange;
  if (change === undefined || entry.runId === null) return null;
  const truncated = { value: false };
  return {
    kind: 'test_changed',
    seq: entry.seq,
    at: entry.at,
    rule: { id: rule.id, displayId: rule.displayId },
    title: shown(rule.title, truncated),
    runId: entry.runId,
    runDisplayId: store.runs.get(entry.runId)?.displayId ?? null,
    sessionId: entry.sessionId,
    files: change.files.map((file) => ({ path: shown(file.path, truncated), change: file.change })),
    fileCount: change.fileCount,
    textTruncated: truncated.value,
  };
};

/** 미확인 요구사항 · 규칙 (삭제 · 폐기 제외). */
const unconfirmedNorms = (store: ProjectStore): ConfirmationNormItem[] => {
  const retired = retiredRuleSet(store);
  const items: ConfirmationNormItem[] = [];
  for (const requirement of store.requirements.list()) {
    if (requirement.deletedAt !== null || requirement.confirmation.state === 'confirmed') continue;
    const truncated = { value: false };
    items.push({
      kind: 'unconfirmed_norm',
      at: requirement.updatedAt,
      target: { entity: 'Requirement', id: requirement.id },
      displayId: requirement.displayId,
      text: shown(requirement.text, truncated),
      author: requirement.author,
      textTruncated: truncated.value,
    });
  }
  for (const rule of store.rules.list()) {
    if (
      rule.deletedAt !== null ||
      retired.has(rule.id) ||
      rule.confirmation.state === 'confirmed'
    ) {
      continue;
    }
    const truncated = { value: false };
    items.push({
      kind: 'unconfirmed_norm',
      at: rule.updatedAt,
      target: { entity: 'Rule', id: rule.id },
      displayId: rule.displayId,
      text: shown(rule.title, truncated),
      author: rule.author,
      textTruncated: truncated.value,
    });
  }
  return items.sort(
    (a, b) =>
      Date.parse(b.at) - Date.parse(a.at) ||
      (a.displayId < b.displayId ? -1 : a.displayId > b.displayId ? 1 : 0),
  );
};

/** `confirmation.list` 본체 (열린 저장소). */
export const buildConfirmationList = (store: ProjectStore): ConfirmationListResult => {
  const entries = store.normChanges.list();
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  // 확인 풀림 기록을 원인 순번으로 (원인 1건에 풀림 1건, 0019)
  const releases = new Map<number, NormChangeEntry>();
  for (const entry of entries) {
    const cause = entry.kind === 'unconfirmed' ? entry.detail.unconfirm?.causeSeq : undefined;
    if (cause !== undefined) releases.set(cause, entry);
  }
  const pending = pendingNotices(store, entries);
  const top: ConfirmationItem[] = pending
    .filter(({ entry }) => isRetirement(entry))
    .sort((a, b) => byNewest(a.entry, b.entry))
    .map(({ entry, rule }) => retirementItem(entry, rule, bySeq, releases));
  const tests: ConfirmationItem[] = pending
    .filter(({ entry }) => entry.kind === 'test_changed')
    .sort((a, b) => byNewest(a.entry, b.entry))
    .flatMap(({ entry, rule }) => testChangeItem(store, entry, rule) ?? []);
  const all = [...top, ...tests, ...unconfirmedNorms(store)];
  return {
    items: all.slice(0, CONFIRMATION_LIST_MAX_ITEMS),
    total: all.length,
    truncated: all.length > CONFIRMATION_LIST_MAX_ITEMS,
  };
};
