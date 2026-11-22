// `rule.*` 처리기 (NRM-02, NRM-04, JDG-02, M1-11, ADR-060, M7-03 #215 · ADR-109).
// - 규칙 테이블의 규범(효력 · 잠정 승인)만 돌려준다. 승인 전 제안은 `proposals`에만 있으므로 섞이지 않는다 (NRM-04)
// - `rule.list`는 폐기된 규칙을 빼고 돌려준다(M7-09 #221, ADR-112). `includeRetired: true`면 폐기된 규칙도 넣는다(규칙 화면의
//   [폐기 포함], M7-15 #227 · ADR-114). `rule.get` · `judgment.list`는 폐기된 규칙도 돌려준다(판정 이력은 지우지 않는다).
//   폐기된 규칙의 항목에는 `retirement`(폐기 시각 · 대체한 규칙 · 사유가 든 규범 변경 기록 순번)가 실린다. 폐기 기록은 효력
//   모듈에서 읽는다
// - 규칙마다 최신 판정을 붙인다. 판정 기록이 없으면 미판정 (judgments/latest-judgment.ts)
// - `judgment.list`: 규칙 상세의 실행 이력. 판정 기록 테이블(`judgments`)의 기록을 최신부터, 실행 표시 ID와 함께 (ADR-073)
// - `rule.update`: 사람의 규칙 직접 편집(제목 · 진술, ADR-100 B② · A8). 사람 주체만 받고(에이전트 -32020) 편집 · 확인됨 ·
//   승인 기록 `rule_edit`(before · after diff)을 트랜잭션 1개로 남긴다(C2: 사람 행동은 승인 기록). 이 처리기가 저장소의
//   규칙 편집(`rules.update`)을 부르는 유일한 곳이다. 역할 세션의 도구에는 규칙 편집 도구가 없다
// - 진술이 바뀐 편집이 저장되면 그 뒤에 오케스트레이터 배선이 넘긴 창구(`ruleEditStarter`)로 인수 테스트를 다시 쓰는 실행을
//   자동 시작한다(규범 변경 기록 `auto_start`, 원인 = 이 편집의 승인 기록 순번). 제목만 바뀌면 실행이 없다
import {
  type ApprovalLogEntry,
  DomainErrorReason,
  ErrorCode,
  type HumanAuthor,
  RULE_STATEMENT_MAX,
  RULE_TITLE_MAX,
  type Rule,
  type RuleEditAutoStart,
  type RuleEditConflictReason,
  type RuleJudgmentEntry,
  type RuleUpdateParams,
  type RuleWithJudgment,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { confirmHumanRuleEdit, requireHuman } from '../confirmations/confirmation-service.js';
import {
  type LatestJudgmentLookup,
  type LatestJudgmentSource,
  storedLatestJudgments,
  toRuleJudgment,
} from '../judgments/latest-judgment.js';
import {
  isEffectiveRule,
  listedRules,
  retiredRuleSet,
  ruleRetirementView,
} from '../norms/effective.js';
import { CONTROL_CHARACTERS, earsStatementProblem } from '../tools/ears.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers, type RequestContext } from './server.js';

/**
 * 진술이 바뀐 사람 편집 뒤 실행을 자동 시작하는 창구 (오케스트레이터 배선이 `AutoStarter`로 넘긴다, ADR-109).
 * 던지지 않는다. 만들지 않았거나 실패하면 `null`.
 */
export interface RuleEditStarter {
  afterRuleEdit(projectId: string, approvalSeq: number): RuleEditAutoStart | null;
}

export interface RuleHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 최신 판정 조회 (기본: 프로젝트 저장소의 판정 기록) */
  latestJudgments?: LatestJudgmentSource;
  /** 시계 (ms, 기본 `Date.now`). 편집 시각에 쓴다 */
  now?: () => number;
  /** 진술이 바뀐 편집 뒤 실행 자동 시작 (생략하면 실행을 만들지 않는다: 처리기만 시험할 때) */
  ruleEditStarter?: RuleEditStarter;
}

type RuleMethods = Pick<MethodHandlers, 'rule.list' | 'rule.get' | 'rule.update' | 'judgment.list'>;

const withJudgment = (rule: Rule, lookup: LatestJudgmentLookup): RuleWithJudgment => ({
  rule,
  judgment: toRuleJudgment(lookup(rule.id)),
});

/** 목록 · 단건 조회 항목: 폐기된 규칙에만 `retirement`를 싣는다 (ADR-114). */
const listedItem = (
  store: ProjectStore,
  rule: Rule,
  lookup: LatestJudgmentLookup,
  retired: ReadonlySet<string>,
): RuleWithJudgment => {
  const retirement = ruleRetirementView(store, rule.id, retired);
  return retirement === null
    ? withJudgment(rule, lookup)
    : { ...withJudgment(rule, lookup), retirement };
};

const ruleOrThrow = (store: ProjectStore, id: string): Rule => {
  const rule = store.rules.get(id);
  if (rule === null) {
    throw new RpcError(ErrorCode.NotFound, `규칙을 찾을 수 없습니다: ${id}`);
  }
  return rule;
};

/** 판정 기록 → 실행 이력 항목. 같은 실행의 표시 ID는 한 번만 읽는다. */
const judgmentEntries = (store: ProjectStore, ruleId: string): RuleJudgmentEntry[] => {
  const runDisplayIds = new Map<string, string | null>();
  const runDisplayId = (runId: string): string | null => {
    if (!runDisplayIds.has(runId))
      runDisplayIds.set(runId, store.runs.get(runId)?.displayId ?? null);
    return runDisplayIds.get(runId) ?? null;
  };
  return store.judgments.listByRule(ruleId).map((judgment) => ({
    judgment,
    runDisplayId: judgment.runId === null ? null : runDisplayId(judgment.runId),
  }));
};

/** 편집 결과 (트랜잭션 안에서 만든 값). */
interface RuleEdited {
  readonly item: RuleWithJudgment;
  readonly approvalLog: ApprovalLogEntry;
  readonly statementChanged: boolean;
}

/** 편집할 수 없는 상태의 -32009 (`data.reason`으로 화면이 사유를 고른다). */
const conflict = (reason: RuleEditConflictReason, message: string): RpcError =>
  new RpcError(ErrorCode.StateConflict, message, { reason });

/** 제목 · 진술의 형식 문제 (바뀐 칸만 본다). 저장은 받은 원문 그대로다(표시는 화면 · 작업 지시가 표시 값으로). */
const editIssues = (change: {
  readonly title?: string;
  readonly statement?: string;
}): { path: string; message: string }[] => {
  const issues: { path: string; message: string }[] = [];
  if (change.title !== undefined) {
    if (change.title.trim().length === 0)
      issues.push({ path: 'title', message: '제목이 비어 있음' });
    else if (CONTROL_CHARACTERS.test(change.title)) {
      issues.push({ path: 'title', message: '제목은 한 줄이어야 함 (줄바꿈 · 제어 문자 불가)' });
    } else if (change.title !== change.title.trim()) {
      // 앞뒤 공백은 다듬지 않고 거부한다(사람이 쓴 글을 조용히 바꾸지 않는다. 진술의 EARS 검사와 같은 기준)
      issues.push({ path: 'title', message: '제목 앞뒤에 공백을 둘 수 없음' });
    } else if (change.title.length > RULE_TITLE_MAX) {
      issues.push({ path: 'title', message: `제목은 ${String(RULE_TITLE_MAX)}자까지` });
    }
  }
  if (change.statement !== undefined) {
    const problem =
      change.statement.length > RULE_STATEMENT_MAX
        ? `진술은 ${String(RULE_STATEMENT_MAX)}자까지`
        : earsStatementProblem(change.statement);
    if (problem !== null) issues.push({ path: 'statement', message: problem });
  }
  return issues;
};

/**
 * 사람의 규칙 직접 편집 (트랜잭션 1개): 규칙 편집 → 승인 기록 `rule_edit` → 확인됨(근거 = 그 순번).
 * 어느 쓰기든 실패하면 셋 다 남지 않는다.
 * @throws {RpcError} -32004 없는 규칙 · -32009 삭제됨 · 내장 · 효력 없음 · 수정 시각 다름 · -32001 형식 · 바뀐 것 없음
 */
const editRuleByHuman = (
  store: ProjectStore,
  input: Omit<RuleUpdateParams, 'projectId' | 'author'> & { readonly by: HumanAuthor },
  clientId: string,
  at: string,
  lookup: () => LatestJudgmentLookup,
): RuleEdited =>
  store.transaction(() => {
    const current = ruleOrThrow(store, input.id);
    if (current.deletedAt !== null) {
      throw conflict('rule_deleted', `삭제된 규칙입니다 (${current.deletedAt})`);
    }
    // 내장 구조 규칙의 진술은 구조 검사 코드와 짝이다: 글만 바꾸면 검사와 어긋나므로 사람 편집도 받지 않는다 (ADR-109)
    if (current.builtin) {
      throw conflict('builtin_rule', '내장 구조 규칙은 직접 편집할 수 없습니다');
    }
    // 효력 판정은 효력 모듈 한 곳 (잠정 · 폐기된 규칙은 효력이 없다, M7-09 · ADR-112). 폐기된 규칙의 편집도 같은 사유로 거부한다
    if (!isEffectiveRule(current, retiredRuleSet(store))) {
      throw conflict(
        'rule_not_effective',
        retiredRuleSet(store).has(current.id)
          ? '폐기된 규칙입니다'
          : `효력 없는 규칙입니다 (${current.normState})`,
      );
    }
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== current.updatedAt) {
      throw conflict(
        'rule_changed',
        `규칙이 그 사이 바뀌었습니다 (저장된 수정 시각 ${current.updatedAt})`,
      );
    }
    const change = {
      ...(input.title !== undefined && input.title !== current.title ? { title: input.title } : {}),
      ...(input.statement !== undefined && input.statement !== current.statement
        ? { statement: input.statement }
        : {}),
    };
    if (change.title === undefined && change.statement === undefined) {
      throw new RpcError(ErrorCode.ValidationFailed, '바뀐 내용이 없습니다', {
        reason: DomainErrorReason.RuleEditNoChange,
      });
    }
    const issues = editIssues(change);
    if (issues.length > 0) {
      throw new RpcError(
        ErrorCode.ValidationFailed,
        `규칙 편집 형식 오류: ${issues.map((issue) => issue.message).join(' · ')}`,
        { reason: DomainErrorReason.RuleEditInvalid, issues },
      );
    }
    const edited = store.rules.update(current.id, change, at);
    const approvalLog = store.approvalLog.append({
      at,
      action: 'rule_edit',
      actor: input.by,
      targetRef: { entity: 'Rule', id: current.id },
      clientId,
      detail: {
        diff: {
          before: { title: current.title, statement: current.statement },
          after: { title: edited.title, statement: edited.statement },
        },
      },
    });
    // 사람이 고친 규칙은 저장이 곧 확인됨이다. 근거는 이 편집의 승인 기록 (ADR-100 B② · A8)
    const confirmation = confirmHumanRuleEdit(store, approvalLog);
    const rule: Rule = { ...edited, confirmation };
    return {
      item: withJudgment(rule, lookup()),
      approvalLog,
      statementChanged: change.statement !== undefined,
    };
  });

/** 승인 기록의 `clientId`: 요청이 들어온 파이프 연결 번호 (기동마다 1부터, 증거용). */
const clientIdOf = (context: RequestContext): string => `pipe-${String(context.connectionId)}`;

export const createRuleHandlers = ({
  biveHome,
  latestJudgments = storedLatestJudgments,
  now = Date.now,
  ruleEditStarter,
}: RuleHandlerDeps): RuleMethods => ({
  'rule.list': ({ projectId, includeRetired }) =>
    withProjectStore(biveHome, projectId, (store) => {
      const lookup = latestJudgments(store);
      const retired = retiredRuleSet(store);
      return {
        rules: listedRules(store, includeRetired === true).map((rule) =>
          listedItem(store, rule, lookup, retired),
        ),
      };
    }),
  'rule.get': ({ projectId, id }) =>
    withProjectStore(biveHome, projectId, (store) => {
      const rule = ruleOrThrow(store, id);
      return listedItem(store, rule, latestJudgments(store), retiredRuleSet(store));
    }),
  'rule.update': ({ projectId, id, author, title, statement, expectedUpdatedAt }, context) => {
    // 저장소를 열기 전에 주체를 본다: 에이전트 주체는 프로젝트 · 규칙 유무와 상관없이 -32020
    const by = requireHuman(
      author,
      '에이전트는 규칙을 직접 고칠 수 없습니다. 규칙 직접 편집은 사람만 합니다 (ADR-100 B②)',
    );
    const at = new Date(now()).toISOString();
    const edited = withProjectStore(biveHome, projectId, (store) =>
      editRuleByHuman(
        store,
        {
          id,
          by,
          ...(title === undefined ? {} : { title }),
          ...(statement === undefined ? {} : { statement }),
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        },
        clientIdOf(context),
        at,
        () => latestJudgments(store),
      ),
    );
    // 편집이 커밋된 뒤에 시작한다: 실행 저장이 실패해도 편집은 남는다. 진술이 바뀐 편집만 원인이 된다 (ADR-109)
    const autoStart = edited.statementChanged
      ? (ruleEditStarter?.afterRuleEdit(projectId, edited.approvalLog.seq) ?? null)
      : null;
    return { ...edited.item, approvalLog: edited.approvalLog, autoStart };
  },
  'judgment.list': ({ projectId, ruleId }) =>
    withProjectStore(biveHome, projectId, (store) => {
      const rule = ruleOrThrow(store, ruleId);
      return { judgments: judgmentEntries(store, rule.id) };
    }),
});
