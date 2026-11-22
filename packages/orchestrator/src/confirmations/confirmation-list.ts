// 확인할 것 목록 (`confirmation.list`, NRM-07, ADR-100 D3 · B⑦ · G · A7, M7-13 #225, ADR-113).
// - 저장소를 읽기만 한다. 항목은 규범 변경 기록(폐기 · 대체 · 확인 풀림 · 테스트 변경)과 요구사항 · 규칙의 확인 상태에서 만든다
// - 순서: ① 에이전트의 폐기 · 대체(확인 여부와 무관, B⑦) ② 확인됨 규칙의 테스트 변경 알림(G) ③ 미확인 요구사항 · 규칙.
//   ① · ②는 기록 시각 최신순(같으면 순번 큰 것 먼저), ③은 마지막 수정 시각 최신순(같으면 표시 ID 순). 확인 풀림은 그 원인인
//   폐기 · 대체 항목의 `released`로 싣는다(같은 폐기가 두 항목으로 나오지 않는다. 지금 확인 풀림의 원인은 폐기 · 대체뿐이고
//   0019 트리거가 그 밖의 원인을 거부한다)
// - 내려가는 조건: 사람이 대상을 [확인](`confirmation.set`)하면 빠진다. ① · ②는 대상 규칙의 확인 시각이 그 기록 시각보다 뒤일
//   때, ③은 확인됨일 때. 삭제된 대상은 빠진다. 폐기된 규칙은 ③에 오지 않는다(①에만)
// - 에이전트가 쓴 글은 표시 값(ADR-089)으로만 내보낸다. 저장된 기록은 바꾸지 않는다
import {
  CONFIRMATION_LIST_MAX_ITEMS,
  type Confirmation,
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
 * 사람이 그 기록 뒤에 대상 규칙을 확인했는지 (항목이 내려가는 조건). 확인 시각이 기록 시각보다 뒤인 확인됨이면 참이다.
 * 확인 풀림이 같은 트랜잭션에서 일어나므로 새 폐기 · 대체는 사람이 다시 확인하기 전까지 참이 아니다.
 */
export const seenAfter = (confirmation: Confirmation, at: string): boolean =>
  confirmation.state === 'confirmed' && Date.parse(confirmation.at) > Date.parse(at);

/** 폐기 · 대체 기록 (원인이 될 수 있는 종류). */
const isRetirement = (entry: NormChangeEntry): boolean =>
  entry.kind === 'retired' || entry.kind === 'superseded';

/** 대상 규칙이 아직 사람이 보지 않은 폐기 · 대체 · 테스트 변경 기록 (순번 순). */
const pendingNotices = (
  store: ProjectStore,
  entries: readonly NormChangeEntry[],
): { entry: NormChangeEntry; rule: Rule }[] => {
  const retired = retiredRuleSet(store);
  const rules = new Map<string, Rule | null>();
  const ruleOf = (id: string): Rule | null => {
    if (!rules.has(id)) rules.set(id, store.rules.get(id));
    return rules.get(id) ?? null;
  };
  const pending: { entry: NormChangeEntry; rule: Rule }[] = [];
  for (const entry of entries) {
    const notice = isRetirement(entry) || entry.kind === 'test_changed';
    if (!notice || entry.targetRef.entity !== 'Rule') continue;
    const rule = ruleOf(entry.targetRef.id);
    if (rule === null || rule.deletedAt !== null) continue;
    // 폐기된 규칙의 테스트 변경 알림은 그 폐기 항목이 대신한다
    if (entry.kind === 'test_changed' && retired.has(rule.id)) continue;
    if (seenAfter(rule.confirmation, entry.at)) continue;
    pending.push({ entry, rule });
  }
  return pending;
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
