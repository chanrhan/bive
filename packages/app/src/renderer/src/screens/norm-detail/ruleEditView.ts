// 규칙 직접 편집의 표시 규칙 (screens.md SCR-06 · 1.1, ADR-100 B②, M7-03 #215 · ADR-109). DOM · React에 의존하지 않는다
// (test/rule-edit-view.test.ts).
// - [편집]은 효력 있고 삭제되지 않은 규칙에만 있다. 내장 구조 규칙은 서버도 거부하므로 보이지 않는다(ADR-109)
// - 저장은 제목 · 진술이 비지 않고 하나라도 바뀌었을 때만 한다. 바뀐 칸만 보내고, 편집을 시작할 때 본 수정 시각을 함께 보내
//   다른 저장 위에 덮어쓰지 않는다(서버 -32009 `rule_changed`)
// - 오류 · 자동 시작 결과는 응답(`rule.update`)에서만 만든다(NFR-03). 문구는 명사형 (1.1)
import type {
  JsonRpcErrorObject,
  Rule,
  RuleEditAutoStart,
  RuleEditConflictReason,
  RuleUpdateParams,
} from '@bive/shared';

import { AUTO_START_SKIP_REASON_LABELS } from './ruleWriterStatusView.js';

export const RULE_EDIT_TEXT = {
  edit: '편집',
  title: '제목',
  titleLabel: '규칙 제목 편집',
  statementLabel: '규칙 진술 편집',
  save: '저장',
  cancel: '취소',
  confirmation: '확인',
  confirmed: '확인됨',
  unconfirmed: '미확인',
  saveFailed: '규칙 저장 실패',
  titleInvalid: '제목 형식 오류',
  statementInvalid: '진술 형식 오류',
  noChange: '변경 없음',
  autoStarted: '실행 자동 시작',
  pendingRun: '대기 실행에 반영',
  autoStartSkipped: '실행 자동 시작 생략',
} as const;

/** 서버가 -32009로 거부한 이유의 표시명 (shared `RuleEditConflictReason`과 같은 키, 시험이 대조). */
export const RULE_EDIT_CONFLICT_LABELS = {
  rule_deleted: '삭제된 규칙',
  rule_not_effective: '효력 없는 규칙',
  builtin_rule: '내장 구조 규칙',
  rule_changed: '다른 변경 먼저 저장됨',
} as const satisfies Record<RuleEditConflictReason, string>;

/** 편집 중인 값. */
export interface RuleEditDraft {
  readonly title: string;
  readonly statement: string;
}

/** 이 규칙에 [편집]을 보일지: 효력 상태 · 삭제 안 됨 · 내장 구조 규칙 아님. */
export const canEditRule = (rule: Pick<Rule, 'builtin' | 'deletedAt' | 'normState'>): boolean =>
  !rule.builtin && rule.deletedAt === null && rule.normState === 'approved';

/** 저장할 수 있는가: 제목 · 진술이 공백만이 아니고 하나라도 지금 값과 다를 때. */
export const canSaveRuleEdit = (
  rule: Pick<Rule, 'title' | 'statement'>,
  draft: RuleEditDraft,
): boolean =>
  draft.title.trim().length > 0 &&
  draft.statement.trim().length > 0 &&
  (draft.title !== rule.title || draft.statement !== rule.statement);

/** `rule.update` 요청: 바뀐 칸만, 편집을 시작할 때 본 수정 시각과 함께. 주체는 사람. */
export const ruleEditParams = (
  projectId: string,
  rule: Pick<Rule, 'id' | 'title' | 'statement' | 'updatedAt'>,
  draft: RuleEditDraft,
): RuleUpdateParams => ({
  projectId,
  id: rule.id,
  author: { kind: 'human' },
  ...(draft.title === rule.title ? {} : { title: draft.title }),
  ...(draft.statement === rule.statement ? {} : { statement: draft.statement }),
  expectedUpdatedAt: rule.updatedAt,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isRpcError = (error: unknown): error is JsonRpcErrorObject =>
  isRecord(error) && typeof error.code === 'number';

/** 저장 실패 문구: 한 줄 + (형식 오류면) 서버가 돌려준 사유. */
export interface RuleEditError {
  readonly label: string;
  readonly detail: string | null;
}

/** `rule.update` 실패 → 문구. */
export const ruleEditErrorText = (error: unknown): RuleEditError => {
  const failed = (reason: string | null): RuleEditError => ({
    label: reason === null ? RULE_EDIT_TEXT.saveFailed : `${RULE_EDIT_TEXT.saveFailed} · ${reason}`,
    detail: null,
  });
  if (!isRpcError(error)) return failed(null);
  const data = isRecord(error.data) ? error.data : {};
  if (error.code === -32001 && data.reason === 'RULE_EDIT_INVALID') {
    const issues = Array.isArray(data.issues) ? data.issues.filter(isRecord) : [];
    const titleIssue = issues.some((issue) => issue.path === 'title');
    const messages = issues
      .map((issue) => issue.message)
      .filter((message): message is string => typeof message === 'string');
    return {
      label: titleIssue ? RULE_EDIT_TEXT.titleInvalid : RULE_EDIT_TEXT.statementInvalid,
      detail: messages.length === 0 ? null : messages.join(' · '),
    };
  }
  if (error.code === -32001 && data.reason === 'RULE_EDIT_NO_CHANGE') {
    return { label: RULE_EDIT_TEXT.noChange, detail: null };
  }
  if (error.code === -32009) {
    const reason = data.reason;
    return failed(
      typeof reason === 'string' && Object.hasOwn(RULE_EDIT_CONFLICT_LABELS, reason)
        ? RULE_EDIT_CONFLICT_LABELS[reason as RuleEditConflictReason]
        : null,
    );
  }
  if (error.code === -32004) return failed('규칙 없음');
  if (error.code === -32020) return failed('편집 권한 없음');
  return failed(null);
};

/** 저장 뒤 실행 자동 시작 결과 한 줄. 결과가 없으면(제목만 바뀜 등) `null`. */
export const ruleEditAutoStartText = (autoStart: RuleEditAutoStart | null): string | null => {
  if (autoStart === null) return null;
  switch (autoStart.state) {
    case 'started':
      return `${RULE_EDIT_TEXT.autoStarted} · ${autoStart.runDisplayId}`;
    case 'pending':
      return `${RULE_EDIT_TEXT.pendingRun} · ${autoStart.runDisplayId}`;
    case 'skipped':
      return `${RULE_EDIT_TEXT.autoStartSkipped} · ${AUTO_START_SKIP_REASON_LABELS[autoStart.reason]}`;
  }
};

/** 확인 상태 표시명. */
export const confirmationText = (rule: Pick<Rule, 'confirmation'>): string =>
  rule.confirmation.state === 'confirmed' ? RULE_EDIT_TEXT.confirmed : RULE_EDIT_TEXT.unconfirmed;
