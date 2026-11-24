// 요구사항 → 규칙 자동 생성 rule-writer 세션 (NRM-02, NFR-01 · NFR-02 · NFR-07, ADR-009 · ADR-024 · ADR-057 · ADR-062).
// - `requirement.create`가 요구사항을 저장한 같은 저장소 열림 안에서 `start`를 부른다. `start`는 중복 · 설정 검사만
//   동기로 하고 세션은 대기열에서 하나씩 비동기로 돈다(응답을 세션 종료까지 붙잡지 않는다)
// - 설정의 rule-writer 모델 · 한도(`roleSessionSettings(settings, 'rule-writer')`, 실행 전체 한도 검사 포함)가 없으면 세션을 띄우지 않고
//   그 사실을 기록한다. 요구사항 저장 자체는 성공한다 (NRM-01, ADR-062)
// - 폐기 · 대체 도구 `retire_rule` · `supersede_rule`(M7-09 #221, ADR-112)도 같은 반영 모듈이 트랜잭션 1개로 남긴다. 대체로 생긴
//   새 규칙은 신규 기록을 남기므로 세션이 끝나면 그 규칙의 실행이 자동 시작된다(폐기만이면 실행 없음)
// - 세션 도구는 규칙 생성 도구 `propose_rule`과 위의 폐기 · 대체 도구뿐이다(ADR-024). 규칙 생성 호출 1건이 승인 대기 제안 없이 규칙 1개(효력 상태, 미확인,
//   생성 주체 규칙 작성 역할)와 규범 변경 기록 1건(신규)을 트랜잭션 1개로 남긴다(`norms/agent-rule.ts`, M7-02 #214,
//   ADR-100 D1 · C2, ADR-103). 세션 가드가 init의 도구 · MCP 서버 목록을 검사한다(NFR-02)
// - 같은 요구사항에 세션을 두 번 띄우지 않는다: 프로세스 안에서는 요구사항별 기록으로, 재기동 뒤에는 그 요구사항에서
//   규칙 작성 역할이 만든 규칙(또는 이 변경 전의 `rule_generation` 제안)으로 가린다. 재기동 때 끊긴 세션을 다시 띄우지
//   않는다 (PRD 5.1 자동 재개 없음)
// - 세션 기록(도구 호출 · 매니페스트 · 결과)은 메모리 · 로그와 함께 프로젝트 저장소(`sessions` · `tool_calls`,
//   실행 밖 세션, ADR-066)에도 남긴다. 저장 실패는 로그만 남기고 세션을 막지 않는다
// - 중복이 아닌 시도마다 시도 기록(`rule_writer_requests`, 세션 ID와 같은 ID)을 남기고, 세션을 열지 않으면 생략 사유를
//   거기에 채운다. 화면 · `ruleWriter.status`는 이 기록과 세션 기록에서만 상태를 만든다 (M3-26, ADR-099)
// - 시도 기록이 바뀌면(대기 · 시작 · 끝 · 생략) `onChanged`로 알린다 (`event.ruleWriter.changed`)
// - 규범 입력(M7-07 #219, ADR-100 K1 · A15, ADR-106): 세션을 열기 직전에 효력 있는 요구사항 · 규칙을 읽어 작업 지시에 읽기 전용
//   자료로 싣는다(도구가 아니라 프롬프트로만). 받은 수 · 잘린 사실은 세션 기록(`normInput`, 세션 행에도, M7-08 ADR-108)과
//   로그에 남긴다. 규칙 생성마다 받는
//   모순 판단은 반영 모듈이 같은 트랜잭션에서 규범 변경 기록(판단)에 남긴다
// - 세션 행이 있는 세션이 끝나면 종료 기록 저장 뒤 `onSessionEnded`를 부른다. 오케스트레이터가 이것으로 실행을 자동 시작한다
//   (M7-05 #217, ADR-107). 세션 안에서는 실행을 만들 수 없다(규칙 작성 역할의 도구는 규칙 생성 · 폐기 · 대체뿐)
// - 실행 안의 판단 세션(`judge`, M7-11 #223, ADR-100 D4 · A4 · A5, ADR-115): 오케스트레이터 배선(`orchestrator.ts`)이 엔진의
//   판단 요청을 이 서비스에 잇는다(엔진 · 단계는 이 서비스를 모른다). 같은 규칙 작성 역할 · 같은 도구 목록으로 원인 기록(지금은
//   구현 역할의 이의) 대상 규칙을 폐기 · 대체 · 유지로 판단하는 세션을 한 번 연다. 원인 글은 작업 지시에 들여 쓴 표시 값으로만
//   싣고(구현 세션의 다른 글은 넣지 않는다), 판단은 대상 규칙마다 한 번, 대상 밖 규칙 · 새 규칙 만들기는 거부한다. 판단을 모두
//   남기면 실행기를 닫는다. 한도는 min(규칙 작성 역할 설정, 프로젝트 하루 잔여, 실행 잔여)이고 세션 행은 그 실행 · 판단을 청한
//   단계 시도에 묶인다(하루 합계와 실행 합계 모두에 든다, M7-12 · ADR-118. 이의 판단도 같다).
//   세션이 끝나면 요구사항 세션과 같은 `onSessionEnded`(대체로 생긴 새 규칙의 실행 자동 시작)를 부른다. 요구사항 세션의
//   대기열 · 시도 기록과는 따로 돈다
// - 검사 실패 판단(M7-12 #224, ADR-100 B⑧ · A4 · A5, ADR-118): 원인이 검사 단계 · 병합 재검사의 대상 밖 규칙 실패면 판단 대상은
//   실패한 기존 규칙뿐이고, 작업 지시에는 이 실행의 대상 규칙(새 규칙) · 실패한 규칙 · 인수 테스트 파일에 적힌 실패 케이스 이름(표시
//   값, 틀 안)만 싣는다(실행기 출력 원문 · 구현 세션의 글 없음). 규범 자료의 케이스 이름도 같은 기준으로 거른다
// - 다시 시도(`retry`): 사람이 요구사항을 직접 편집해 저장했을 때, 가장 최근 시도가 생략 · 실패(`success` 아닌 종료)이고
//   그 요구사항에서 규칙 작성 역할이 만든 규칙(이 변경 전의 규칙 자동 생성 제안 포함)이 없으면 새 시도를 띄운다. 진행 중 · 대기 중이거나 성공한 요구사항은 띄우지 않는다 (ADR-099)
// - 요구사항 변경의 재판단(`rejudge`, M7-10 #222, ADR-100 NRM-01 · NRM-02 행 · D5 · D6, ADR-116): 사람이 효력 있는 자식 규칙이 있는
//   요구사항의 본문을 고치거나(같은 글 다시 저장은 아님) 요구사항을 지우면, 요구사항 세션과 같은 대기열 · 시도 기록 · 세션 행 ·
//   `onSessionEnded`로 재판단 세션을 띄운다. 자식 규칙마다 유지 · 대체 · 폐기(삭제는 유지 · 폐기) 가운데 하나를 판단 기록(주제
//   `requirement_change`)과 함께 남기고, 판단하지 못한 자식 규칙은 세션이 어떻게 끝났든(열지 못함 · 실패 · 한도 · 가드 위반 · 종료
//   포함) 오케스트레이터의 유지(`undecided`)로 마무리한다. 판단 없음을 폐기로 보지 않는다. 같은 요구사항의 세션이 대기 · 진행 중이면
//   새로 띄우지 않고 1건으로 접어 두었다가 그 세션이 끝난 뒤 최신 본문으로 한 번 더 띄운다(본문이 그 세션이 본 것과 같으면 띄우지 않는다)
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type AgentRole,
  createUlidGenerator,
  ErrorCode,
  type MissingSetting,
  type NormJudgmentRequirementChange,
  type NormRequirementChangeKind,
  type Requirement,
  type RuleWriterSkipReason as StoredSkipReason,
  type SessionEndReason,
  type SessionNormInput,
  SettingsIncompleteData,
  TOOL_CALL_NAME_DISPLAY_MAX,
  type ToolManifestEntry,
} from '@bive/shared';
import { ConflictError, NotFoundError, type ProjectStore } from '@bive/store';

import type {
  AgentAdapter,
  SessionBudget,
  SessionResultEvent,
  ToolResult,
} from '../agent/adapter.js';
import { runGuardedSession } from '../agent/guarded-session.js';
import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import type { NormJudgeOutcome, NormJudgeRequest } from '../engine/types.js';
import { RpcError } from '../ipc/server.js';
import type { TaskTracker } from '../lifecycle.js';
import {
  type AgentCheckJudgment,
  type AgentObjectionJudgment,
  type AgentRequirementChangeJudgment,
  createAgentRule,
  NormJudgmentInputError,
  NormRetirementInputError,
  retireAgentRule,
  settleRequirementChange,
  supersedeAgentRule,
  upholdAgentRule,
} from '../norms/agent-rule.js';
import {
  type CaseNameFilter,
  latestJudgedCaseFilter,
  NO_KNOWN_CASES,
} from '../norms/case-names.js';
import {
  collectNormInput,
  effectiveRules,
  type NormInput,
  type NormInputSummary,
  normInputRecord,
  normInputSummaryText,
} from '../norms/norm-input.js';
import {
  dailyBudgetReached,
  type DailyBudgetState,
  PROJECT_DAILY_BUDGET_EXCEEDED_TEXT,
  projectDailyBudget,
} from '../settings/project-budget.js';
import { roleSessionSettings } from '../settings/settings-service.js';
import { displayText } from '../text-limit.js';
import type {
  ProposeRuleInput,
  RetireRuleInput,
  SupersedeRuleInput,
  UpholdRuleInput,
} from '../tools/definitions.js';
import {
  createRoleTools,
  type FixedToolExecutor,
  type ToolCallRecord,
  type RoleToolsHooks,
} from '../tools/executor.js';
import { denied, failed, invalidArgs, type IssueList, ok } from '../tools/result.js';
import {
  type JudgmentPromptRule,
  RULE_WRITER_CHECK_JUDGMENT_SYSTEM_PROMPT,
  RULE_WRITER_JUDGMENT_SYSTEM_PROMPT,
  RULE_WRITER_REQUIREMENT_DELETED_SYSTEM_PROMPT,
  RULE_WRITER_REQUIREMENT_UPDATED_SYSTEM_PROMPT,
  RULE_WRITER_SYSTEM_PROMPT,
  ruleWriterCheckJudgmentPrompt,
  ruleWriterJudgmentPrompt,
  ruleWriterRejudgePrompt,
  ruleWriterTaskPrompt,
} from './prompts.js';

/** 이 세션의 역할. 설정 검사도 이 역할만 본다 (ADR-057: 실행 전체 한도는 항상 함께 검사). */
export const RULE_WRITER_ROLE = 'rule-writer' as const satisfies AgentRole;

/**
 * 세션을 띄우지 않은 이유. 저장하는 사유(설정 미비 · 종료 중 · 시작 실패 · 요구사항 없음)는 shared `RuleWriterSkipReason`이고,
 * 중복(같은 요구사항에 이미 세션을 띄웠거나 그 요구사항에서 만든 규칙 · 이 변경 전의 규칙 자동 생성 제안이 있음)은
 * 저장하지 않는다.
 */
export type RuleWriterSkipReason = StoredSkipReason | 'duplicate';

/** 요구사항 하나의 시도 기록이 저장된 뒤 부른다 (`event.ruleWriter.changed`). 던지지 않아야 한다. */
export type RuleWriterChangeListener = (projectId: string, requirementId: string) => void;

/**
 * 세션 행이 있는 세션이 끝나 종료 기록(비용 포함)을 저장한 뒤, 그 끝남을 알리기 전에 부른다 (오케스트레이터의 실행 자동 시작,
 * M7-05 #217, ADR-107). 세션 밖의 일이므로 세션 도구가 아니다. 던져도 세션 기록 · 알림은 그대로 간다.
 */
export type RuleWriterSessionEndListener = (
  projectId: string,
  sessionId: string,
  endReason: SessionEndReason,
) => void;

export type RuleWriterSessionStatus = 'skipped' | 'queued' | 'running' | 'ended';

/** rule-writer 세션 1개의 기록 (메모리, 저장은 M1-14). */
export interface RuleWriterSessionRecord {
  /** 기록 ID = 세션 작업 폴더 이름 (ULID) */
  readonly id: string;
  readonly projectId: string;
  readonly requirementId: string;
  readonly requirementDisplayId: string;
  status: RuleWriterSessionStatus;
  /** `skipped`일 때만 */
  skipReason: RuleWriterSkipReason | null;
  /** `settings_incomplete`일 때 비어 있는 설정 항목 */
  missing: MissingSetting[];
  /** 세션 시작에 쓴 설정의 rule-writer 모델 (생략이면 `null`) */
  model: string | null;
  /** 세션 시작에 쓴 설정의 rule-writer 한도 */
  budget: SessionBudget | null;
  /** init에 보고된 도구 목록 · MCP 수 (NFR-02, 위반이어도 기록) */
  manifest: ToolManifestEntry | null;
  /** init의 세션 ID */
  sdkSessionId: string | null;
  /** 모든 도구 호출 (거부 · 오류 포함, ADR-052) */
  toolCalls: ToolCallRecord[];
  /** 이 세션이 바로 반영한 규칙 ID (만든 순서) */
  ruleIds: string[];
  /** 작업 지시에 실은 규범 입력 (세션을 열기 직전에 읽음, 열지 않았으면 `null`, M7-07) */
  normInput: RuleWriterNormInputRecord | null;
  /** 결과 메시지 (없으면 `null`) */
  result: SessionResultEvent | null;
  /** 종료 사유 (`ended`일 때) */
  endReason: SessionEndReason | null;
  /** 생략 · 실패 설명 */
  error: string | null;
  /** 요구사항 변경의 재판단이면 그 종류와 판단 대상 자식 규칙 ID (세션 시작 때 다시 고른다, M7-10). 요구사항 세션이면 `null` */
  rejudge: { readonly change: NormRequirementChangeKind; ruleIds: string[] } | null;
  readonly createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * 세션이 받은 규범 입력의 기록: 수 · 잘린 사실과 실은 항목의 표시 ID (ADR-100 A15). 테스트 작성 · 구현 세션과 같은 모양이고
 * 세션 행(`sessions.norm_input`)에도 남는다(M7-08, ADR-108).
 */
export type RuleWriterNormInputRecord = SessionNormInput;

export interface RuleWriterStartInput {
  readonly projectId: string;
  /** 방금 저장한 요구사항 */
  readonly requirement: Pick<Requirement, 'id' | 'displayId' | 'text'>;
}

export type RuleWriterStartResult =
  | { readonly status: 'queued'; readonly record: RuleWriterSessionRecord }
  | {
      readonly status: 'skipped';
      readonly reason: RuleWriterSkipReason;
      /** 새로 남긴 생략 기록. 중복이면 이미 있는 기록(없으면 `null`) */
      readonly record: RuleWriterSessionRecord | null;
    };

/** 사람의 요구사항 수정 · 삭제 뒤 재판단 요청 (M7-10, ADR-116). */
export type RuleWriterRejudgeInput =
  | {
      readonly projectId: string;
      /** 방금 고친 요구사항 */
      readonly requirement: Requirement;
      readonly change: 'updated';
      /** 고치기 전 본문 (같으면 재판단하지 않는다) */
      readonly previousText: string;
    }
  | {
      readonly projectId: string;
      /** 방금 지운 요구사항 (삭제 시각이 찬 것) */
      readonly requirement: Requirement;
      readonly change: 'deleted';
      /** 지우기 전의 자식 규칙 ID (같은 트랜잭션에서 부모가 해제됐다) */
      readonly childRuleIds: readonly string[];
    };

/** `requirement.create` · `requirement.update` · `requirement.delete` 처리기가 쓰는 창구. 던지지 않는다. */
export interface RuleWriterLauncher {
  start(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult;
  /** 가장 최근 시도가 생략 · 실패일 때만 새 시도를 띄운다. 대상이 아니면 `null` */
  retry(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult | null;
  /**
   * 효력 있는 자식 규칙이 있는 요구사항의 수정(본문이 바뀐 것) · 삭제 뒤 재판단 세션을 띄운다(같은 요구사항의 세션이 대기 · 진행
   * 중이면 1건으로 접는다). 재판단할 것이 아니면(본문이 같음 · 효력 있는 자식 규칙 없음) `null`
   */
  rejudge(store: ProjectStore, input: RuleWriterRejudgeInput): RuleWriterStartResult | null;
}

export interface RuleWriterServiceOptions {
  /** `$BIVE_HOME` 절대 경로 */
  readonly biveHome: string;
  /** 선택된 어댑터 (`BIVE_AGENT`, 시험은 ScriptedAdapter) */
  readonly adapter: AgentAdapter;
  /** 시계 (ms, 기본 `Date.now`) */
  readonly now?: () => number;
  /** 진행 중 세션이 있으면 유휴 종료를 미룬다 (오케스트레이터의 Lifecycle) */
  readonly tasks?: TaskTracker;
  /** 기록 한 줄 (기본: 버림) */
  readonly log?: (line: string) => void;
  /** `close`가 세션 정리를 기다리는 최대 시간 (기본 5000ms) */
  readonly closeTimeoutMs?: number;
  /** 시도 기록이 저장된 뒤 (기본: 알리지 않음) */
  readonly onChanged?: RuleWriterChangeListener;
  /** 세션이 끝나 종료 기록을 저장한 뒤 (기본: 아무것도 하지 않음) */
  readonly onSessionEnded?: RuleWriterSessionEndListener;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

const keyOf = (projectId: string, requirementId: string): string =>
  `${projectId}\u0000${requirementId}`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isIssueList = (error: unknown): error is Error & IssueList =>
  error instanceof Error &&
  error.name === 'ZodError' &&
  Array.isArray((error as Partial<IssueList>).issues);

/** `signal`이 중단되면 그 사유로 거부된다 (중단되지 않으면 풀리지 않는다). */
const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });

/** 판단 세션 1개의 문맥: 대상 규칙과 판단을 남긴 규칙. */
interface JudgmentSession {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly label: string;
  readonly rules: readonly JudgmentPromptRule[];
  readonly decided: Set<string>;
  /** 반영 모듈에 넘기는 실행 안 판단 문맥 (이의 또는 검사 실패, 정확히 하나) */
  readonly context:
    { readonly objection: AgentObjectionJudgment } | { readonly check: AgentCheckJudgment };
  readonly normInput: NormInputSummary;
  /** 규범 자료 · 인용 출처의 케이스 이름 기준 (M3-37, ADR-121) */
  readonly isKnownCase: CaseNameFilter;
  tools: FixedToolExecutor | null;
}

/** 판단 대상과 판단을 남긴 규칙 (판단 세션 · 재판단 세션 공통). */
type JudgedTargets = Pick<JudgmentSession, 'rules' | 'decided'>;

/** 재판단 시도 1개의 문맥 (M7-10, ADR-116). */
interface RejudgeContext {
  readonly change: NormRequirementChangeKind;
  /** 고치기 전 본문 (수정일 때) */
  readonly previousText: string | null;
  /** 판단 대상 자식 규칙 (요청 때 고르고 세션 시작 때 다시 고른다) */
  rules: JudgmentPromptRule[];
  readonly decided: Set<string>;
  /** 판단 기록의 원인 (세션 시작 때 다시 읽은 요구사항으로 바꾼다) */
  cause: NormJudgmentRequirementChange;
  /** 시도 기록 행을 만들었는지 (판단할 변경 · 대상을 확인한 뒤 · 진짜 생략일 때만 만든다) */
  attempted: boolean;
  /** 세션이 받은 규범 입력의 요약 (열기 전이면 `null`) */
  normInput: NormInputSummary | null;
  tools: FixedToolExecutor | null;
  /** 판단 없는 자식 규칙을 마무리했는지 (한 번만) */
  settled: boolean;
}

/** 대기 · 진행 중인 세션 뒤로 접어 둔 재판단 (요구사항마다 1건). */
interface PendingRejudge {
  /** 접기 시작한 때의 고치기 전 본문 (뒤 세션이 열리지 않고 끝났을 때의 비교 기준) */
  readonly previousText: string | null;
  /** 삭제 때의 자식 규칙 ID (접는 동안 모은 것) */
  readonly childRuleIds: readonly string[];
}

/** 생략 사유 → 판단 없음의 사정 (`NormUndecidedReason`). 종료 중이면 중단, 요구사항이 없어졌으면 마무리하지 않는다(삭제의 재판단이 따른다). */
const undecidedOfSkip = (reason: StoredSkipReason): string | null =>
  reason === 'requirement_unavailable' ? null : reason === 'closed' ? 'aborted' : reason;

/** 판단 기록의 원인: 요구사항 · 변경 종류 · 그 시각 · 본문의 SHA-256 (ADR-116). */
const requirementChangeOf = (
  requirement: Requirement,
  change: NormRequirementChangeKind,
): NormJudgmentRequirementChange => ({
  requirement: { id: requirement.id, displayId: requirement.displayId },
  change,
  at:
    change === 'deleted' && requirement.deletedAt !== null
      ? requirement.deletedAt
      : requirement.updatedAt,
  textHash: createHash('sha256').update(requirement.text, 'utf8').digest('hex'),
});

/** 재판단 대상: 효력 있고 내장이 아닌 규칙 가운데 그 요구사항의 자식(수정) · 지우기 전 자식(삭제), 표시 ID 순. */
const rejudgeTargets = (
  store: ProjectStore,
  requirementId: string,
  childRuleIds: readonly string[] | null,
): JudgmentPromptRule[] =>
  effectiveRules(store)
    .filter(
      (rule) =>
        !rule.builtin &&
        (childRuleIds === null
          ? rule.parentRequirementId === requirementId
          : childRuleIds.includes(rule.id)),
    )
    .map((rule) => ({
      id: rule.id,
      displayId: rule.displayId,
      title: rule.title,
      statement: rule.statement,
      parentRequirementId: rule.parentRequirementId,
    }));

export class RuleWriterService implements RuleWriterLauncher {
  readonly #biveHome: string;
  readonly #adapter: AgentAdapter;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #tasks: TaskTracker | undefined;
  readonly #log: (line: string) => void;
  /** 저장소에 세션 행을 만든 기록 ID */
  readonly #persisted = new Set<string>();
  readonly #closeTimeoutMs: number;
  readonly #onChanged: RuleWriterChangeListener | undefined;
  readonly #onSessionEnded: RuleWriterSessionEndListener | undefined;
  /** 모든 기록 (생략 포함, 만든 순서) */
  readonly #records: RuleWriterSessionRecord[] = [];
  /** 세션을 띄운(대기열에 넣은) 요구사항 → 기록 */
  readonly #launched = new Map<string, RuleWriterSessionRecord>();
  /** 기록 ID → 세션이 끝나면 풀리는 약속 */
  readonly #settled = new Map<string, Promise<void>>();
  /** 재판단 기록 ID → 문맥 (M7-10) */
  readonly #rejudges = new Map<string, RejudgeContext>();
  /** 대기 · 진행 중 세션 뒤로 접어 둔 재판단 (요구사항 → 1건) */
  readonly #pending = new Map<string, PendingRejudge>();
  /** 기록 ID → 세션 시작 때 읽은 요구사항 본문 (접어 둔 재판단을 띄울지 비교한다) */
  readonly #usedText = new Map<string, string>();
  /**
   * 기록 ID → 세션 시작 때 만든 케이스 이름 기준 (규범 자료와 폐기 · 대체 근거의 인용 출처가 같은 함수를 쓴다, M3-37 · ADR-121).
   * 없으면 아무 이름도 모른다
   */
  readonly #caseFilters = new Map<string, CaseNameFilter>();
  readonly #controllers = new Set<AbortController>();
  /** 세션을 하나씩 돌리는 대기열 */
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: RuleWriterServiceOptions) {
    this.#biveHome = options.biveHome;
    this.#adapter = options.adapter;
    this.#now = options.now ?? Date.now;
    this.#newId = createUlidGenerator(this.#now);
    this.#tasks = options.tasks;
    const log = options.log;
    // 기록 함수의 예외가 요구사항 저장 · 세션을 깨지 않게 한다
    this.#log = (line) => {
      try {
        log?.(line);
      } catch {
        // 기록 실패는 무시한다
      }
    };
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#onChanged = options.onChanged;
    this.#onSessionEnded = options.onSessionEnded;
  }

  /** 기록 사본 (만든 순서). */
  get records(): readonly RuleWriterSessionRecord[] {
    return this.#records.map((record) => structuredClone(record));
  }

  /** 요구사항의 기록 사본 (만든 순서). */
  recordsFor(projectId: string, requirementId: string): RuleWriterSessionRecord[] {
    return this.#records
      .filter((record) => record.projectId === projectId && record.requirementId === requirementId)
      .map((record) => structuredClone(record));
  }

  /**
   * 요구사항 저장 직후 부른다. 같은 저장소 열림에서 중복 · 설정을 검사하고, 통과하면 세션을 대기열에 넣는다.
   * 던지지 않는다(요구사항 저장 응답을 바꾸지 않음).
   */
  start(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult {
    return this.#begin(store, input, false);
  }

  /**
   * 사람이 요구사항을 직접 편집해 저장한 뒤 부른다(같은 저장소 열림). 저장된 가장 최근 시도가 생략이거나 `success`가 아닌
   * 종료일 때만 `start`와 같은 검사(종료 중 · 중복 · 만든 규칙 있음 · 설정)를 거쳐 새 시도를 띄운다. 시도 기록이 없거나
   * 대기 · 진행 중 · 성공이면 `null`. 던지지 않는다.
   */
  retry(store: ProjectStore, input: RuleWriterStartInput): RuleWriterStartResult | null {
    try {
      const latest = store.ruleWriterRequests.latest(input.requirement.id);
      const failed =
        latest !== null &&
        (latest.state === 'skipped' ||
          (latest.state === 'ended' && latest.endReason !== 'success'));
      if (!failed) return null;
    } catch (error) {
      this.#log(
        `규칙 작성 다시 시도 확인 실패 (${input.requirement.displayId}): ${errorMessage(error)}`,
      );
      return null;
    }
    this.#log(`규칙 작성 다시 시도 (${input.requirement.displayId})`);
    return this.#begin(store, input, true);
  }

  /**
   * 사람이 요구사항을 고치거나 지운 뒤 부른다(같은 저장소 열림, 저장 트랜잭션 뒤). 본문이 바뀌지 않았거나 효력 있는 자식 규칙이 없으면
   * `null`(수정이면 처리기가 `retry`를 부른다). 같은 요구사항의 세션이 대기 · 진행 중이면 새로 띄우지 않고 1건으로 접어 두며(그
   * 세션이 끝난 뒤 최신 본문으로 다시 본다) 결과는 `duplicate`다. 아니면 `start`와 같은 검사(종료 중 · 설정 · 하루 한도)를 거쳐
   * 재판단 세션을 대기열에 넣는다. 던지지 않는다.
   */
  rejudge(store: ProjectStore, input: RuleWriterRejudgeInput): RuleWriterStartResult | null {
    const { projectId, requirement, change } = input;
    let rules: JudgmentPromptRule[];
    try {
      if (change === 'updated' && input.previousText === requirement.text) return null;
      rules = rejudgeTargets(
        store,
        requirement.id,
        change === 'deleted' ? input.childRuleIds : null,
      );
    } catch (error) {
      this.#log(`재판단 확인 실패 (${requirement.displayId}): ${errorMessage(error)}`);
      return null;
    }
    if (rules.length === 0) return null;
    const previousText = change === 'updated' ? input.previousText : null;
    const key = keyOf(projectId, requirement.id);
    const launched = this.#launched.get(key);
    if (launched?.status === 'queued' || launched?.status === 'running') {
      // 겹친 변경은 1건으로 접는다: 지금 세션이 끝난 뒤 최신 본문 · 자식 규칙으로 한 번 더 본다 (ADR-062 중복 방지, ADR-116)
      const pending = this.#pending.get(key);
      this.#pending.set(key, {
        previousText: pending === undefined ? previousText : pending.previousText,
        childRuleIds: [
          ...new Set([...(pending?.childRuleIds ?? []), ...rules.map((rule) => rule.id)]),
        ],
      });
      this.#log(
        `재판단 접음 (${requirement.displayId}, ${change === 'deleted' ? '삭제' : '수정'}, 대기 · 진행 중인 세션 뒤에 다시 봄)`,
      );
      return { status: 'skipped', reason: 'duplicate', record: structuredClone(launched) };
    }
    this.#log(
      `재판단 요청 (${requirement.displayId}, ${change === 'deleted' ? '삭제' : '수정'}, 자식 규칙 ${rules.map((rule) => rule.displayId).join(', ')})`,
    );
    return this.#begin(store, { projectId, requirement }, true, {
      change,
      previousText,
      rules,
      decided: new Set(),
      cause: requirementChangeOf(requirement, change),
      attempted: false,
      normInput: null,
      tools: null,
      settled: false,
    });
  }

  #begin(
    store: ProjectStore,
    input: RuleWriterStartInput,
    relaunch: boolean,
    rejudge: RejudgeContext | null = null,
  ): RuleWriterStartResult {
    const { projectId, requirement } = input;
    try {
      if (this.#closed) {
        return this.#skip(store, input, 'closed', '오케스트레이터 종료 중', [], rejudge);
      }
      const launched = this.#launched.get(keyOf(projectId, requirement.id));
      // 다시 시도는 이 프로세스에서 끝난(생략 포함) 세션을 막지 않는다. 대기 · 진행 중이면 중복이다
      const existing =
        relaunch && (launched?.status === 'ended' || launched?.status === 'skipped')
          ? undefined
          : launched;
      // 재판단은 자식 규칙이 있어야 뜬다: 만든 규칙 있음으로 막지 않는다 (대기 · 진행 중 겹침은 `rejudge`가 접었다)
      if (
        existing !== undefined ||
        (rejudge === null && this.#hasGeneratedNorms(store, requirement.id))
      ) {
        this.#log(
          `규칙 작성 생략 (${requirement.displayId}, 이미 세션을 띄웠거나 만든 규칙이 있음)`,
        );
        return {
          status: 'skipped',
          reason: 'duplicate',
          record: existing === undefined ? null : structuredClone(existing),
        };
      }
      let session;
      try {
        // 실행 전체 한도까지 검사하고(ADR-057) rule-writer 모델 · 한도를 쓴다. 실행 밖 세션이라 실행 잔여는 없고,
        // USD 한도는 프로젝트 하루 잔여로 묶는다(ADR-104). 하루 한도에 이르렀으면 세션을 띄우지 않는다
        const settings = store.settings.get();
        const daily = projectDailyBudget(store, settings, this.#now());
        session = roleSessionSettings(
          settings,
          RULE_WRITER_ROLE,
          daily === null ? {} : { maxBudgetUsd: daily.remaining },
        );
        if (dailyBudgetReached(daily)) return this.#skipDaily(store, input, daily, rejudge);
      } catch (error) {
        if (error instanceof RpcError && error.code === ErrorCode.SettingsIncomplete) {
          const data = SettingsIncompleteData.safeParse(error.data);
          return this.#skip(
            store,
            input,
            'settings_incomplete',
            error.message,
            data.success ? data.data.missing : [],
            rejudge,
          );
        }
        throw error;
      }
      const record = this.#newRecord(input, 'queued', rejudge);
      record.model = session.model;
      record.budget = { ...session.budget };
      this.#launched.set(keyOf(projectId, requirement.id), record);
      // 시도 기록 저장이 실패해도 세션은 띄운다(세션 행만으로도 시도로 읽힌다). 재판단은 판단할 변경 · 대상을 시작 직전에 확인한 뒤
      // 시도 기록을 만든다(판단할 것이 없으면 시도 기록도 없다, ADR-116 검토 2회차). 그동안의 중복 방지 · 접기는 메모리의 대기 상태다
      if (rejudge === null) {
        this.#saveAttempt(record, () =>
          store.ruleWriterRequests.create({
            id: record.id,
            requirementId: record.requirementId,
            requestedAt: record.createdAt,
          }),
        );
      }
      this.#enqueue(record, requirement);
      return { status: 'queued', record: structuredClone(record) };
    } catch (error) {
      return this.#skip(store, input, 'start_failed', errorMessage(error), [], rejudge);
    }
  }

  /**
   * 요구사항의 세션이 끝날 때까지 기다린다 (없거나 생략이면 바로). 그 세션 뒤로 접어 둔 재판단이 띄운 세션도 끝날 때까지 기다린다.
   */
  async whenSettled(projectId: string, requirementId: string): Promise<void> {
    const key = keyOf(projectId, requirementId);
    for (;;) {
      const record = this.#launched.get(key);
      if (record === undefined) return;
      await this.#settled.get(record.id);
      if (this.#launched.get(key) === record) return;
    }
  }

  /** 대기열이 빌 때까지 기다린다 (기다리는 사이 들어온 세션 포함). */
  async idle(): Promise<void> {
    for (;;) {
      const current = this.#chain;
      await current;
      if (current === this.#chain) return;
    }
  }

  /**
   * 새 세션을 받지 않고, 진행 중 · 대기 중 세션을 중단한다(기록 `aborted`). 이미 반영된 규칙은 그대로 효력을 갖는다.
   * 세션이 중단 신호를 따르지 않아도 `closeTimeoutMs` 뒤에는 돌아온다.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort(new Error('오케스트레이터 종료'));
    const timeout = new AbortController();
    await Promise.race([
      this.idle(),
      delay(this.#closeTimeoutMs, undefined, { signal: timeout.signal }).catch(() => undefined),
    ]);
    timeout.abort();
  }

  #timestamp(): string {
    return new Date(this.#now()).toISOString();
  }

  #newRecord(
    input: RuleWriterStartInput,
    status: RuleWriterSessionStatus,
    rejudge: RejudgeContext | null = null,
  ): RuleWriterSessionRecord {
    const record: RuleWriterSessionRecord = {
      id: this.#newId(),
      projectId: input.projectId,
      requirementId: input.requirement.id,
      requirementDisplayId: input.requirement.displayId,
      status,
      skipReason: null,
      missing: [],
      model: null,
      budget: null,
      manifest: null,
      sdkSessionId: null,
      toolCalls: [],
      ruleIds: [],
      normInput: null,
      result: null,
      endReason: null,
      error: null,
      rejudge:
        rejudge === null
          ? null
          : { change: rejudge.change, ruleIds: rejudge.rules.map((rule) => rule.id) },
      createdAt: this.#timestamp(),
      startedAt: null,
      endedAt: null,
    };
    this.#records.push(record);
    if (rejudge !== null) this.#rejudges.set(record.id, rejudge);
    return record;
  }

  #skip(
    store: ProjectStore,
    input: RuleWriterStartInput,
    reason: StoredSkipReason,
    detail: string,
    missing: readonly MissingSetting[],
    rejudge: RejudgeContext | null = null,
  ): RuleWriterStartResult {
    const record = this.#newRecord(input, 'skipped', rejudge);
    record.skipReason = reason;
    record.missing = [...missing];
    record.error = detail;
    const suffix = missing.length > 0 ? `: ${missing.join(', ')}` : '';
    this.#log(`규칙 작성 생략 (${input.requirement.displayId}, ${detail}${suffix})`);
    this.#saveAttempt(record, () =>
      store.ruleWriterRequests.create({
        id: record.id,
        requirementId: record.requirementId,
        requestedAt: record.createdAt,
        skip: { reason, detail, missing, at: record.createdAt },
      }),
    );
    // 재판단을 열지 못했다: 자식 규칙은 판단 없음 → 유지로 마무리한다 (폐기로 보지 않는다, ADR-116)
    const undecided = undecidedOfSkip(reason);
    if (undecided !== null) this.#settleRejudge(record, undecided, store);
    return { status: 'skipped', reason, record: structuredClone(record) };
  }

  /** 하루 한도에 이르러 세션을 띄우지 않는다 (생략 사유 `project_daily_budget_exceeded`, ADR-104). */
  #skipDaily(
    store: ProjectStore,
    input: RuleWriterStartInput,
    daily: DailyBudgetState | null,
    rejudge: RejudgeContext | null,
  ): RuleWriterStartResult {
    if (daily !== null) this.#logDaily(input.requirement.displayId, daily);
    return this.#skip(
      store,
      input,
      'project_daily_budget_exceeded',
      PROJECT_DAILY_BUDGET_EXCEEDED_TEXT,
      [],
      rejudge,
    );
  }

  #logDaily(displayId: string, daily: DailyBudgetState): void {
    this.#log(
      `프로젝트 하루 예산 초과 (${displayId}, ${daily.day.start} 부터, 한도 USD ${String(daily.limit)}, ` +
        `지출 USD ${String(daily.spend.spent)}, 추정 세션 ${String(daily.spend.unknownSessions)}개)`,
    );
  }

  /**
   * 시도 기록을 쓰고(실패는 로그만) 바뀌었음을 알린다. 알림은 지금 저장소 열림 구간이 끝난 뒤 보낸다(ADR-069:
   * 열림 구간 안에서 보내지 않는다).
   */
  #saveAttempt(record: RuleWriterSessionRecord, write: () => unknown): void {
    try {
      write();
    } catch (error) {
      this.#log(
        `규칙 작성 시도 기록 저장 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`,
      );
      return;
    }
    this.#notify(record);
  }

  #notify(record: RuleWriterSessionRecord): void {
    const listener = this.#onChanged;
    if (listener === undefined) return;
    const { projectId, requirementId } = record;
    queueMicrotask(() => {
      try {
        listener(projectId, requirementId);
      } catch (error) {
        this.#log(`규칙 작성 알림 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`);
      }
    });
  }

  /** 세션을 열지 못하고 끝난 시도를 저장소의 시도 기록에 생략으로 남긴다 (실패는 로그만). */
  #saveSkip(
    record: RuleWriterSessionRecord,
    reason: StoredSkipReason,
    detail: string | null,
  ): void {
    const at = record.endedAt ?? this.#timestamp();
    const rejudge = this.#rejudges.get(record.id);
    if (rejudge !== undefined && !rejudge.attempted) {
      // 시도 기록을 만들기 전의 재판단: 진짜 생략(하루 한도 · 설정 · 시작 실패)만 이 시점에 생략 기록으로 만든다. 종료 중 · 요구사항
      // 없어짐은 시도 기록을 남기지 않는다(판단 없음은 규범 변경 기록에 남고, 요구사항이 지워졌으면 삭제의 재판단이 뒤따른다)
      if (reason !== 'closed' && reason !== 'requirement_unavailable') {
        rejudge.attempted = true;
        this.#saveAttempt(record, () =>
          withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
            store.ruleWriterRequests.create({
              id: record.id,
              requirementId: record.requirementId,
              requestedAt: record.createdAt,
              skip: { reason, detail: detail ?? reason, missing: [], at },
            }),
          ),
        );
      }
    } else {
      this.#saveAttempt(record, () =>
        withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
          store.ruleWriterRequests.skip(record.id, { reason, detail, at }),
        ),
      );
    }
    const undecided = undecidedOfSkip(reason);
    if (undecided !== null) this.#settleRejudge(record, undecided);
  }

  /**
   * 판단할 것이 없는 재판단(고친 본문이 고치기 전과 같음 · 남은 자식 규칙 없음)을 끝낸다: 시도 기록 · 판단 없음 기록을 남기지 않는다
   * (바뀐 것이 없으니 상태 줄도 앞 상태 그대로다, ADR-116 검토 2회차).
   */
  #dropRejudge(record: RuleWriterSessionRecord, rejudge: RejudgeContext, detail: string): void {
    rejudge.settled = true;
    record.status = 'skipped';
    record.error = detail;
    record.endedAt = this.#timestamp();
    this.#log(`재판단 생략 (${record.requirementDisplayId}, ${detail})`);
  }

  /**
   * 재판단에서 판단 기록이 없는 자식 규칙을 오케스트레이터의 유지(`undecided`)로 마무리한다 (한 번만, 실패는 로그만, ADR-116).
   * 세션을 열지 못했으면 연결 세션 ID 없이 남긴다. 재판단이 아닌 기록이면 아무것도 하지 않는다.
   */
  #settleRejudge(record: RuleWriterSessionRecord, reason: string, store?: ProjectStore): void {
    const context = this.#rejudges.get(record.id);
    if (context === undefined || context.settled) return;
    context.settled = true;
    const ruleIds = context.rules.map((rule) => rule.id).filter((id) => !context.decided.has(id));
    if (ruleIds.length === 0) return;
    const write = (target: ProjectStore) =>
      settleRequirementChange(
        target,
        {
          cause: context.cause,
          sessionId: this.#persisted.has(record.id) ? record.id : null,
          ruleIds,
          endReason: reason,
          normInput: context.normInput,
        },
        { now: this.#now },
      );
    try {
      const written =
        store === undefined
          ? withRegisteredProjectStore(this.#biveHome, record.projectId, write)
          : write(store);
      this.#log(
        `재판단 판단 없음 → 유지 (${record.requirementDisplayId}, ${reason}, ${String(written.length)}건)`,
      );
    } catch (error) {
      this.#log(
        `재판단 판단 없음 기록 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`,
      );
    }
  }

  /**
   * 세션이 끝난 뒤(대기열 안) 그 요구사항에 접어 둔 재판단이 있으면 최신 요구사항으로 한 번 더 본다: 지워졌으면 삭제의 재판단, 아니면
   * 본문이 끝난 세션이 본 것(열지 못했으면 접기 시작한 때의 고치기 전 본문)과 다를 때만 수정의 재판단 (ADR-116).
   */
  #drainPending(record: RuleWriterSessionRecord): void {
    const key = keyOf(record.projectId, record.requirementId);
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    this.#pending.delete(key);
    try {
      withRegisteredProjectStore(this.#biveHome, record.projectId, (store) => {
        const current = store.requirements.get(record.requirementId);
        if (current === null) return;
        const base = this.#usedText.get(record.id) ?? pending.previousText;
        if (current.deletedAt !== null) {
          this.rejudge(store, {
            projectId: record.projectId,
            requirement: current,
            change: 'deleted',
            childRuleIds: pending.childRuleIds,
          });
          return;
        }
        if (base === null || base === current.text) {
          this.#log(`재판단 생략 (${record.requirementDisplayId}, 본 본문과 같음)`);
          return;
        }
        this.rejudge(store, {
          projectId: record.projectId,
          requirement: current,
          change: 'updated',
          previousText: base,
        });
      });
    } catch (error) {
      this.#log(`접어 둔 재판단 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`);
    }
  }

  /**
   * 재기동 뒤 중복 방지: 이 요구사항에서 규칙 작성 역할이 이미 규범을 만들었는지. 바로 반영된 규칙(M7-02)과, 이 변경
   * 전부터 있던 규칙 자동 생성 제안(대기 · 처리 무관)을 함께 본다.
   */
  #hasGeneratedNorms(store: ProjectStore, requirementId: string): boolean {
    const madeRule = store.rules
      .listByParent(requirementId)
      .some((rule) => rule.author.kind === 'agent' && rule.author.role === RULE_WRITER_ROLE);
    if (madeRule) return true;
    return store.proposals
      .list({ kind: 'rule_new' })
      .some(
        (proposal) =>
          proposal.source === 'rule_generation' &&
          proposal.targetRef?.entity === 'Requirement' &&
          proposal.targetRef.id === requirementId,
      );
  }

  #enqueue(
    record: RuleWriterSessionRecord,
    requirement: RuleWriterStartInput['requirement'],
  ): void {
    const task = this.#tasks?.beginTask();
    const settled = this.#chain.then(async () => {
      try {
        await this.#run(record, requirement);
      } catch (error) {
        // #run은 던지지 않지만, 대기열이 끊기지 않도록 한 번 더 막는다
        if (record.status !== 'ended')
          this.#end(record, 'error_during_execution', errorMessage(error));
      } finally {
        // 겹친 요구사항 변경은 이 세션이 끝난 뒤 한 번 더 본다 (대기열 뒤에 붙는다)
        this.#drainPending(record);
        task?.end();
      }
    });
    this.#settled.set(record.id, settled);
    this.#chain = settled;
  }

  /** 세션 1개를 끝까지 돌린다. 던지지 않는다. */
  async #run(
    record: RuleWriterSessionRecord,
    queued: RuleWriterStartInput['requirement'],
  ): Promise<void> {
    if (this.#closed) {
      this.#end(record, 'aborted', '오케스트레이터 종료로 세션을 시작하지 않음');
      return;
    }
    // 대기하는 사이 바뀌었을 수 있으므로 시작 직전에 다시 읽는다: 삭제됐으면 생략, 수정됐으면 최신 본문
    const requirement = this.#reloadRequirement(record, queued);
    if (requirement === null) return;
    this.#usedText.set(record.id, requirement.text);
    const rejudge = this.#rejudges.get(record.id) ?? null;
    // 재판단이면 원인을 다시 읽은 요구사항으로 바꾼다 (하루 한도 생략의 판단 없음도 그 변경의 것이다)
    if (rejudge !== null) rejudge.cause = requirementChangeOf(requirement, rejudge.change);
    // 대기하는 사이 고치기 전 본문으로 되돌렸으면(A → B → A) 판단할 변경이 없다: 세션을 열지 않고 판단 없음 기록도 남기지 않는다
    if (rejudge?.change === 'updated' && rejudge.previousText === requirement.text) {
      this.#dropRejudge(record, rejudge, '고친 본문이 고치기 전 본문과 같아 판단할 변경 없음');
      return;
    }
    // 재판단 대상은 시작 직전에 다시 고른다 (대기하는 사이 폐기 · 대체 · 새 자식 규칙이 생겼을 수 있다). 남은 대상이 없으면 판단할
    // 것이 없으므로 하루 한도 · 설정을 보기 전에 끝낸다 (시도 기록 없음)
    if (rejudge !== null && !this.#retargetRejudge(record, rejudge, requirement.id)) return;
    const { model } = record;
    if (model === null || record.budget === null) {
      this.#end(record, 'error_during_execution', '세션 설정 없음');
      return;
    }
    // 대기하는 사이 다른 세션이 하루 지출을 늘렸을 수 있으므로 시작 직전에 하루 잔여를 다시 읽는다 (ADR-104)
    const budget = this.#dailyCappedBudget(record, record.budget);
    if (budget === null) return;
    record.budget = budget;
    // 재판단의 시도 기록은 판단할 변경 · 대상을 확인한 이 시점에 만든다 (상태 줄에 진행이 보인다)
    if (rejudge !== null && !rejudge.attempted) {
      rejudge.attempted = true;
      this.#saveAttempt(record, () =>
        withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
          store.ruleWriterRequests.create({
            id: record.id,
            requirementId: record.requirementId,
            requestedAt: record.createdAt,
          }),
        ),
      );
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const workDir = path.join(this.#biveHome, 'work', record.projectId, 'sessions', record.id);
    record.status = 'running';
    record.startedAt = this.#timestamp();
    this.#log(
      `규칙 작성 세션 시작 (${record.requirementDisplayId}, 모델 ${model}, ` +
        `한도 USD ${String(budget.maxBudgetUsd)} · 턴 ${String(budget.maxTurns)})`,
    );
    let endReason: SessionEndReason = 'error_during_execution';
    let detail: string | null;
    try {
      // rule-writer는 파일 도구가 없으므로 작업 폴더는 비어 있다 (ADR-024 허용 목록 방식)
      mkdirSync(workDir, { recursive: true, mode: 0o700 });
      // 효력 있는 규범은 작업 지시로만 준다 (도구 목록은 그대로, ADR-100 K1 · D4). 읽지 못하면 세션을 열지 않는다. 케이스
      // 이름은 최근 판정 커밋의 인수 테스트 파일에 적힌 것만 싣고 인용 출처로 쓴다 (M3-37, ADR-121)
      const isKnownCase = await this.#caseFilter(record.projectId);
      this.#caseFilters.set(record.id, isKnownCase);
      const norms = this.#readNormInput(record, requirement, rejudge, isKnownCase);
      const prompt =
        rejudge === null
          ? ruleWriterTaskPrompt(requirement, norms)
          : ruleWriterRejudgePrompt({
              requirement,
              change: rejudge.change,
              previousText: rejudge.previousText,
              rules: rejudge.rules,
              norms,
            });
      const tools = createRoleTools({
        role: RULE_WRITER_ROLE,
        sessionRoot: workDir,
        biveHome: this.#biveHome,
        now: () => new Date(this.#now()),
        hooks: {
          ...(rejudge === null
            ? {
                proposeRule: (input: ProposeRuleInput) =>
                  this.#propose(record, norms.summary, input),
                retireRule: (input: RetireRuleInput) => this.#retire(record, input),
                supersedeRule: (input: SupersedeRuleInput) =>
                  this.#supersede(record, norms.summary, input),
                // 유지는 판단 세션(실행 안의 이의 판단 · 요구사항 변경의 재판단)에서만 받는다 (새 요구사항에는 판단할 규칙이 없다)
                upholdRule: () =>
                  denied(
                    'invalid_args',
                    'uphold_rule은 판단 세션(실행 안의 이의 판단 · 요구사항 변경의 재판단)에서만 쓴다 (이 세션에는 판단할 규칙이 없음)',
                  ),
              }
            : this.#rejudgeHooks(record, rejudge, norms.summary)),
          onToolCall: (call) => {
            record.toolCalls.push(call);
            this.#persistToolCall(record, call);
            // 도구 이름은 에이전트가 정한 임의 문자열이다: 줄바꿈 등으로 로그 줄을 꾸미지 못하게 표시 값으로 (ADR-089)
            const name = displayText(call.name, TOOL_CALL_NAME_DISPLAY_MAX).text;
            this.#log(
              `규칙 작성 도구 호출 (${record.requirementDisplayId}, ${name} ${call.status}` +
                `${call.reason === undefined ? '' : ` ${call.reason}`})`,
            );
          },
        },
      });
      if (rejudge !== null) rejudge.tools = tools;
      this.#persist(record, (store) =>
        store.sessions.start({
          id: record.id,
          runId: null,
          stepId: null,
          requirementId: requirement.id,
          role: RULE_WRITER_ROLE,
          model,
          workDir,
          budget,
          normInput: record.normInput,
          startedAt: record.startedAt ?? this.#timestamp(),
        }),
      );
      // 세션 행은 프로젝트 하루 예산 합산의 원천이다: 행을 남기지 못하면 그 지출이 하루 한도에 잡히지 않으므로 세션을 열지 않는다
      // (시도 기록에 시작 실패로 남는다, ADR-104)
      if (!this.#persisted.has(record.id)) {
        throw new Error('세션 기록 저장 실패로 세션을 열지 않음');
      }
      this.#notify(record);
      const outcome = await runGuardedSession({
        adapter: this.#adapter,
        controller,
        spec: {
          role: RULE_WRITER_ROLE,
          systemPrompt:
            rejudge === null
              ? RULE_WRITER_SYSTEM_PROMPT
              : rejudge.change === 'updated'
                ? RULE_WRITER_REQUIREMENT_UPDATED_SYSTEM_PROMPT
                : RULE_WRITER_REQUIREMENT_DELETED_SYSTEM_PROMPT,
          prompt,
          workDir,
          tools,
          budget,
          model,
          vars: {
            projectId: record.projectId,
            requirementId: requirement.id,
            requirementDisplayId: requirement.displayId,
            // 재판단 세션의 시나리오 자리표시자 (판단 세션과 같은 이름: 종류 · 첫 대상 규칙 · 대상 규칙)
            ...(rejudge === null
              ? {}
              : {
                  judgment: `requirement_${rejudge.change}`,
                  ruleId: rejudge.rules[0]?.displayId ?? '',
                  ruleIds: rejudge.rules.map((rule) => rule.displayId).join(','),
                }),
          },
        },
        onInit: (manifest, init) => {
          record.manifest = manifest;
          record.sdkSessionId = init.sessionId;
          tools.setSessionId(init.sessionId);
          this.#persist(record, (store) =>
            store.sessions.recordInit(record.id, {
              sdkSessionId: init.sessionId,
              tools: init.tools,
              mcpServers: init.mcpServers,
            }),
          );
        },
      });
      record.result = outcome.result;
      endReason = outcome.endReason;
      detail = outcome.detail;
    } catch (error) {
      // 작업 폴더 · 도구 준비 실패 (세션 실행 자체의 예외는 runGuardedSession이 분류한다)
      detail = errorMessage(error);
    } finally {
      this.#controllers.delete(controller);
      rmSync(workDir, { recursive: true, force: true });
    }
    this.#end(record, endReason, detail);
  }

  /**
   * 시작 직전의 하루 잔여로 묶은 세션 한도. 하루 한도에 이르렀으면 생략(`project_daily_budget_exceeded`) 기록을 남기고
   * `null`. 하루 지출을 읽지 못하면 시작 실패로 생략한다(한도를 모르고 세션을 열지 않는다).
   */
  #dailyCappedBudget(record: RuleWriterSessionRecord, budget: SessionBudget): SessionBudget | null {
    let reason: StoredSkipReason;
    let detail: string;
    try {
      const daily = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        projectDailyBudget(store, store.settings.get(), this.#now()),
      );
      if (!dailyBudgetReached(daily)) {
        return daily === null
          ? budget
          : { ...budget, maxBudgetUsd: Math.min(budget.maxBudgetUsd, daily.remaining) };
      }
      if (daily !== null) this.#logDaily(record.requirementDisplayId, daily);
      reason = 'project_daily_budget_exceeded';
      detail = PROJECT_DAILY_BUDGET_EXCEEDED_TEXT;
    } catch (error) {
      reason = 'start_failed';
      detail = errorMessage(error);
    }
    record.status = 'skipped';
    record.skipReason = reason;
    record.error = detail;
    record.endedAt = this.#timestamp();
    this.#log(`규칙 작성 생략 (${record.requirementDisplayId}, ${detail})`);
    this.#saveSkip(record, reason, detail);
    return null;
  }

  /**
   * 시작 직전의 요구사항. 삭제 · 없음 · 읽기 실패면 생략 기록을 남기고 `null`. 삭제의 재판단은 지워진 요구사항을 그대로 받는다(수정의
   * 재판단이 대기하는 사이 지워졌으면 생략하고, 겹친 삭제의 재판단이 뒤따른다).
   */
  #reloadRequirement(
    record: RuleWriterSessionRecord,
    queued: RuleWriterStartInput['requirement'],
  ): Requirement | null {
    let detail: string;
    try {
      const current = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        store.requirements.get(queued.id),
      );
      const deletedOk = record.rejudge?.change === 'deleted';
      if (current !== null && (current.deletedAt === null || deletedOk)) return current;
      detail = current === null ? '요구사항 없음' : `요구사항 삭제됨 (${current.deletedAt})`;
    } catch (error) {
      detail = errorMessage(error);
    }
    record.status = 'skipped';
    record.skipReason = 'requirement_unavailable';
    record.error = detail;
    record.endedAt = this.#timestamp();
    this.#log(`규칙 작성 생략 (${record.requirementDisplayId}, ${detail})`);
    // 프로젝트 등록이 해제됐으면 저장할 곳이 없어 로그만 남는다
    this.#saveSkip(record, 'requirement_unavailable', detail);
    return null;
  }

  /**
   * 작업 지시에 실을 효력 있는 규범을 읽고(초점 = 작업 대상 요구사항) 받은 수 · 잘린 사실을 세션 기록과 로그에 남긴다.
   * @throws 저장소를 읽지 못함 (세션을 열지 않는다)
   */
  #readNormInput(
    record: RuleWriterSessionRecord,
    requirement: RuleWriterStartInput['requirement'],
    rejudge: RejudgeContext | null,
    isKnownCase: CaseNameFilter,
  ): NormInput {
    // 재판단은 자식 규칙도 초점이다 (지운 요구사항은 효력이 없어 자료에 없다)
    const norms = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
      collectNormInput(
        store,
        {
          requirementIds: rejudge?.change === 'deleted' ? [] : [requirement.id],
          ruleIds: rejudge?.rules.map((rule) => rule.id) ?? [],
        },
        { isKnownCase },
      ),
    );
    record.normInput = normInputRecord(norms);
    if (rejudge !== null) rejudge.normInput = norms.summary;
    const truncated = norms.summary.truncated ? ' 잘림' : '';
    this.#log(
      `규칙 작성 규범 입력${truncated} (${record.requirementDisplayId}, ${normInputSummaryText(norms.summary)})`,
    );
    return norms;
  }

  /** 세션의 케이스 이름 기준 (세션 시작 때 만든 것, 없으면 아무 이름도 모른다). */
  #caseFilterOf(record: RuleWriterSessionRecord): CaseNameFilter {
    return this.#caseFilters.get(record.id) ?? NO_KNOWN_CASES;
  }

  /**
   * 케이스 이름 기준 (M3-37, ADR-121): 규칙마다 최근 판정 커밋의 인수 테스트 파일(프로젝트 git 객체)과 대조한다. 프로젝트 폴더가
   * 없으면 아무 이름도 모른다.
   * @throws 저장소를 읽지 못함
   */
  async #caseFilter(projectId: string): Promise<CaseNameFilter> {
    const rootPath = withRegisteredProjectStore(
      this.#biveHome,
      projectId,
      (store) => store.getProject()?.rootPath ?? null,
    );
    if (rootPath === null) return NO_KNOWN_CASES;
    return latestJudgedCaseFilter(
      (fn) => withRegisteredProjectStore(this.#biveHome, projectId, fn),
      rootPath,
    );
  }

  /** 세션 기록을 프로젝트 저장소에 남긴다 (실패는 로그만). 세션 행을 만든 기록은 `#persisted`에 둔다. */
  #persist(record: RuleWriterSessionRecord, fn: (store: ProjectStore) => unknown): void {
    try {
      withRegisteredProjectStore(this.#biveHome, record.projectId, fn);
      this.#persisted.add(record.id);
    } catch (error) {
      this.#log(
        `규칙 작성 세션 기록 저장 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`,
      );
    }
  }

  #persistToolCall(record: RuleWriterSessionRecord, call: ToolCallRecord): void {
    if (!this.#persisted.has(record.id)) return;
    this.#persist(record, (store) =>
      store.sessions.appendToolCall({
        id: this.#newId(),
        runId: null,
        sessionId: record.id,
        at: call.at,
        role: call.role,
        name: call.name,
        argsSummary: call.argsSummary,
        status: call.status,
        reason: call.reason ?? null,
        durationMs: Math.max(0, Math.round(call.durationMs)),
      }),
    );
  }

  #end(record: RuleWriterSessionRecord, endReason: SessionEndReason, detail: string | null): void {
    this.#caseFilters.delete(record.id);
    record.status = 'ended';
    record.endReason = endReason;
    record.error = detail;
    record.endedAt = this.#timestamp();
    const endedAt = record.endedAt;
    if (this.#persisted.has(record.id)) {
      // 재판단 세션: 판단하지 못한 자식 규칙은 종료 사유와 함께 유지로 마무리한다 (자동 시작 · 끝남 알림 전, ADR-116)
      this.#settleRejudge(record, endReason);
      const { result } = record;
      this.#persist(record, (store) =>
        store.sessions.end(record.id, {
          endReason,
          error: detail,
          totalCostUsd: result?.total_cost_usd ?? null,
          numTurns: result?.num_turns ?? null,
          modelUsage: Object.fromEntries(
            Object.entries(result?.modelUsage ?? {}).map(([name, usage]) => [
              name,
              {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadInputTokens: usage.cacheReadInputTokens,
                cacheCreationInputTokens: usage.cacheCreationInputTokens,
                costUsd: usage.costUSD,
              },
            ]),
          ),
          endedAt,
        }),
      );
      // 세션 밖의 후속(실행 자동 시작)은 종료 기록 저장 뒤 · 끝남을 알리기 전에 한다: 알림을 받고 상태를 다시 읽는 화면이
      // 자동 시작 결과(생략 기록)까지 함께 본다
      this.#afterSession(record, endReason);
      this.#notify(record);
    } else {
      // 세션 행을 만들기 전에 끝났다(종료 중 · 준비 실패): 시도 기록에 생략으로 남긴다
      this.#saveSkip(record, endReason === 'aborted' ? 'closed' : 'start_failed', detail);
    }
    const cost = record.result?.total_cost_usd;
    this.#log(
      `규칙 작성 세션 종료 (${record.requirementDisplayId}, ${endReason}, ` +
        `규칙 ${String(record.ruleIds.length)}건, 비용 ${cost === undefined || cost === null ? '없음' : `USD ${String(cost)}`}, ` +
        `턴 ${record.result === null ? '없음' : String(record.result.num_turns)}` +
        `${detail === null ? '' : `, ${detail}`})`,
    );
  }

  #afterSession(record: RuleWriterSessionRecord, endReason: SessionEndReason): void {
    try {
      this.#onSessionEnded?.(record.projectId, record.id, endReason);
    } catch (error) {
      this.#log(
        `규칙 작성 세션 후속 처리 실패 (${record.requirementDisplayId}): ${errorMessage(error)}`,
      );
    }
  }

  /**
   * `propose_rule`(규칙 생성) 콜백: 규칙을 바로 반영하고 규범 변경 기록(신규)을 같은 트랜잭션으로 남긴다.
   * 입력 형식(제목 · EARS 진술 · 검사 종류 등)은 실행기가 이미 검사했다.
   * - 부모가 이 세션의 요구사항이 아니면 `denied`(`invalid_args`)
   * - 부모 요구사항 · 프로젝트가 없으면 `error`(`not_found`), 부모가 삭제됐으면 `error`(`state_conflict`)
   * - 모순 대상이 지금 효력 있는 규칙이 아니면 `denied`(`invalid_args`, 사유를 돌려줘 모델이 고쳐 다시 부르게 한다)
   */
  async #propose(
    record: RuleWriterSessionRecord,
    normInput: NormInputSummary,
    input: ProposeRuleInput,
  ): Promise<ToolResult> {
    if (input.parentRequirementId !== record.requirementId) {
      return denied(
        'invalid_args',
        `propose_rule 인자 오류: parentRequirementId는 이 세션의 요구사항 ${record.requirementId}만 쓸 수 있음`,
      );
    }
    const { rationale, contradiction, ...payload } = input;
    try {
      const { rule, judgment } = withRegisteredProjectStore(
        this.#biveHome,
        record.projectId,
        (store) =>
          createAgentRule(
            store,
            {
              payload,
              rationale,
              author: { kind: 'agent', role: RULE_WRITER_ROLE },
              sessionId: record.id,
              contradiction,
              normInput,
            },
            { now: this.#now, newId: this.#newId },
          ),
      );
      record.ruleIds.push(rule.id);
      const targets = judgment.detail.judgment?.contradicts.map((ref) => ref.displayId) ?? [];
      const judged = targets.length === 0 ? '모순 없음' : `모순 (${targets.join(', ')})`;
      return ok(
        `규칙 ${rule.displayId} 반영 (바로 효력, 사람은 나중에 봄). 판단 기록: ${judged}, 기존 규칙은 그대로 효력`,
      );
    } catch (error) {
      if (error instanceof NormJudgmentInputError) {
        return denied(
          'invalid_args',
          `propose_rule 인자 오류: contradiction.ruleIds ${error.message} (작업 지시의 효력 있는 규칙 표시 ID를 쓴다)`,
        );
      }
      if (error instanceof ConflictError) {
        return failed('state_conflict', `부모 요구사항이 삭제됨: ${input.parentRequirementId}`);
      }
      if (error instanceof NotFoundError) {
        return failed('not_found', `부모 요구사항 없음: ${input.parentRequirementId}`);
      }
      if (error instanceof RpcError && error.code === ErrorCode.NotFound) {
        return failed('not_found', error.message);
      }
      if (isIssueList(error)) return invalidArgs('propose_rule', error);
      throw error;
    }
  }

  /** 폐기 · 대체 도구의 저장소 오류를 도구 결과로 바꾼다 (모르는 오류는 다시 던진다). */
  #retirementError(
    tool: 'retire_rule' | 'supersede_rule' | 'uphold_rule',
    error: unknown,
  ): ToolResult {
    if (error instanceof NormRetirementInputError) {
      return denied(
        error.code,
        `${tool} 인자 오류: ${error.message} (작업 지시의 효력 있는 규칙 표시 ID를 쓴다)`,
      );
    }
    if (error instanceof NormJudgmentInputError) {
      return denied(
        'invalid_args',
        `${tool} 인자 오류: contradiction.ruleIds ${error.message} (작업 지시의 효력 있는 규칙 표시 ID를 쓴다)`,
      );
    }
    if (error instanceof ConflictError) {
      return failed('state_conflict', `${tool}: ${error.message}`);
    }
    if (error instanceof NotFoundError) {
      return failed('not_found', `${tool}: ${error.message}`);
    }
    if (error instanceof RpcError && error.code === ErrorCode.NotFound) {
      return failed('not_found', error.message);
    }
    if (isIssueList(error)) return invalidArgs(tool, error);
    throw error;
  }

  /**
   * `retire_rule`(규칙 폐기) 콜백 (M7-09, ADR-112): 규칙을 폐기하고 규범 변경 기록(`retired`)을 같은 트랜잭션으로 남긴다.
   * 대상이 없거나 효력이 없거나 근거가 인용하지 않으면 `denied`(`invalid_args`), 내장 구조 규칙이면 `denied`(`builtin_rule`).
   */
  async #retire(record: RuleWriterSessionRecord, input: RetireRuleInput): Promise<ToolResult> {
    try {
      const { rule } = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        retireAgentRule(
          store,
          {
            ruleId: input.ruleId,
            grounds: input.grounds,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: record.id,
            isKnownCase: this.#caseFilterOf(record),
          },
          { now: this.#now },
        ),
      );
      return ok(`규칙 ${rule.displayId} 폐기 (판정 · 실행의 기준에서 빠짐, 사람은 나중에 봄)`);
    } catch (error) {
      return this.#retirementError('retire_rule', error);
    }
  }

  /**
   * `supersede_rule`(규칙 대체) 콜백 (M7-09, ADR-100 D6, ADR-112): 대상 폐기와 새 규칙 반영을 같은 트랜잭션으로 남긴다.
   * 새 규칙의 부모는 이 세션의 요구사항이어야 한다(`propose_rule`과 같다). 거부 사유는 `#retire` · `#propose`와 같다.
   */
  async #supersede(
    record: RuleWriterSessionRecord,
    normInput: NormInputSummary,
    input: SupersedeRuleInput,
  ): Promise<ToolResult> {
    if (input.parentRequirementId !== record.requirementId) {
      return denied(
        'invalid_args',
        `supersede_rule 인자 오류: parentRequirementId는 이 세션의 요구사항 ${record.requirementId}만 쓸 수 있음`,
      );
    }
    const { rationale, contradiction, ruleId, grounds, ...payload } = input;
    try {
      const { rule, superseded } = withRegisteredProjectStore(
        this.#biveHome,
        record.projectId,
        (store) =>
          supersedeAgentRule(
            store,
            {
              payload,
              rationale,
              author: { kind: 'agent', role: RULE_WRITER_ROLE },
              sessionId: record.id,
              contradiction,
              normInput,
              ruleId,
              grounds,
              isKnownCase: this.#caseFilterOf(record),
            },
            { now: this.#now, newId: this.#newId },
          ),
      );
      record.ruleIds.push(rule.id);
      return ok(
        `규칙 ${superseded.displayId}을 폐기하고 ${rule.displayId}로 대체 (바로 효력, 사람은 나중에 봄)`,
      );
    } catch (error) {
      return this.#retirementError('supersede_rule', error);
    }
  }

  // ── 요구사항 변경의 재판단 세션 (M7-10 #222, ADR-116) ─────────────────

  /**
   * 재판단 대상 자식 규칙을 시작 직전에 다시 고른다. 남은 대상이 없으면 판단할 것이 없어 시도 기록 · 판단 없음 기록 없이 `false`,
   * 읽지 못하면 시작 실패 생략 기록을 남기고 `false`.
   */
  #retargetRejudge(
    record: RuleWriterSessionRecord,
    rejudge: RejudgeContext,
    requirementId: string,
  ): boolean {
    let reason: StoredSkipReason;
    let detail: string;
    try {
      const rules = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        rejudgeTargets(
          store,
          requirementId,
          rejudge.change === 'deleted' ? rejudge.rules.map((rule) => rule.id) : null,
        ),
      );
      if (rules.length > 0) {
        rejudge.rules = rules;
        if (record.rejudge !== null) record.rejudge.ruleIds = rules.map((rule) => rule.id);
        return true;
      }
      // 대기하는 사이 자식 규칙이 모두 효력을 잃었다: 판단할 것이 없다 (시도 기록 · 판단 없음 기록 없음)
      this.#dropRejudge(record, rejudge, '판단할 효력 있는 자식 규칙 없음');
      return false;
    } catch (error) {
      reason = 'start_failed';
      detail = errorMessage(error);
    }
    record.status = 'skipped';
    record.skipReason = reason;
    record.error = detail;
    record.endedAt = this.#timestamp();
    this.#log(`규칙 작성 생략 (${record.requirementDisplayId}, ${detail})`);
    this.#saveSkip(record, reason, detail);
    return false;
  }

  /**
   * 재판단 세션의 규범 도구 (ADR-116). 자식 규칙(판단 대상)마다 유지 · 대체 · 폐기 가운데 한 번(삭제는 유지 · 폐기), 판단 기록과
   * 함께 남긴다. 수정: 자식이 아닌 효력 있는 규칙의 폐기 · 대체와 새 규칙(`propose_rule`)은 요구사항 세션과 같다(D5, 부모는 이
   * 요구사항). 삭제: 대체 · 새 규칙은 거부(부모가 될 요구사항이 없다), 자식 규칙을 모두 판단하면 실행기를 닫는다.
   */
  #rejudgeHooks(
    record: RuleWriterSessionRecord,
    rejudge: RejudgeContext,
    normInput: NormInputSummary,
  ): Pick<RoleToolsHooks, 'proposeRule' | 'retireRule' | 'supersedeRule' | 'upholdRule'> {
    const judgment = (): AgentRequirementChangeJudgment => ({
      cause: rejudge.cause,
      normInput,
    });
    if (rejudge.change === 'deleted') {
      const noParent = (tool: string): ToolResult =>
        denied(
          'invalid_args',
          `${tool}은 요구사항 삭제의 재판단 세션에서 쓰지 않는다 (새 규칙의 부모가 될 요구사항이 없음, 자식 규칙은 uphold_rule 또는 retire_rule)`,
        );
      return {
        proposeRule: () => noParent('propose_rule'),
        supersedeRule: () => noParent('supersede_rule'),
        retireRule: (input) => this.#rejudgeRetire(record, rejudge, judgment(), input),
        upholdRule: (input) => this.#rejudgeUphold(record, rejudge, judgment(), input),
      };
    }
    return {
      proposeRule: (input) => this.#propose(record, normInput, input),
      retireRule: (input) => this.#rejudgeRetire(record, rejudge, judgment(), input),
      supersedeRule: (input) =>
        this.#rejudgeSupersede(record, rejudge, judgment(), normInput, input),
      upholdRule: (input) => this.#rejudgeUphold(record, rejudge, judgment(), input),
    };
  }

  /** 판단 대상 자식 규칙 (표시 ID 또는 ID). 없으면 `undefined`. */
  #childOf(rejudge: RejudgeContext, given: string): JudgmentPromptRule | undefined {
    return rejudge.rules.find((rule) => rule.id === given || rule.displayId === given);
  }

  /** 자식 규칙 하나를 판단했다. 삭제의 재판단은 모두 판단하면 실행기를 닫는다 (수정은 새 규칙이 남을 수 있어 닫지 않는다). */
  #rejudgeDecided(rejudge: RejudgeContext, rule: JudgmentPromptRule): void {
    rejudge.decided.add(rule.id);
    if (rejudge.change === 'deleted' && rejudge.decided.size >= rejudge.rules.length) {
      rejudge.tools?.close('judgment_complete');
    }
  }

  async #rejudgeRetire(
    record: RuleWriterSessionRecord,
    rejudge: RejudgeContext,
    judgment: AgentRequirementChangeJudgment,
    input: RetireRuleInput,
  ): Promise<ToolResult> {
    // 수정의 재판단: 자식이 아닌 규칙의 폐기는 요구사항 세션의 폐기와 같다 (모순 해소, D5)
    if (rejudge.change === 'updated' && this.#childOf(rejudge, input.ruleId) === undefined) {
      return this.#retire(record, input);
    }
    const rule = this.#judgedRule(rejudge, 'retire_rule', input.ruleId);
    if (!('id' in rule)) return rule;
    try {
      withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        retireAgentRule(
          store,
          {
            ruleId: rule.id,
            grounds: input.grounds,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: record.id,
            requirementChange: judgment,
            isKnownCase: this.#caseFilterOf(record),
          },
          { now: this.#now },
        ),
      );
    } catch (error) {
      return this.#retirementError('retire_rule', error);
    }
    this.#rejudgeDecided(rejudge, rule);
    return ok(
      `자식 규칙 ${rule.displayId} 폐기로 판단 (판정 · 실행의 기준에서 빠짐, 사람은 나중에 봄)`,
    );
  }

  async #rejudgeSupersede(
    record: RuleWriterSessionRecord,
    rejudge: RejudgeContext,
    judgment: AgentRequirementChangeJudgment,
    normInput: NormInputSummary,
    input: SupersedeRuleInput,
  ): Promise<ToolResult> {
    if (this.#childOf(rejudge, input.ruleId) === undefined) {
      return this.#supersede(record, normInput, input);
    }
    const rule = this.#judgedRule(rejudge, 'supersede_rule', input.ruleId);
    if (!('id' in rule)) return rule;
    if (input.parentRequirementId !== record.requirementId) {
      return denied(
        'invalid_args',
        `supersede_rule 인자 오류: parentRequirementId는 이 세션의 요구사항 ${record.requirementId}만 쓸 수 있음`,
      );
    }
    const { rationale, contradiction, ruleId, grounds, ...payload } = input;
    let created;
    try {
      created = withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        supersedeAgentRule(
          store,
          {
            payload,
            rationale,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: record.id,
            contradiction,
            normInput,
            // 판단 대상인지는 위에서 봤다 (표시 ID 또는 ID 그대로 넘긴다)
            ruleId,
            grounds,
            requirementChange: judgment,
            isKnownCase: this.#caseFilterOf(record),
          },
          { now: this.#now, newId: this.#newId },
        ),
      );
    } catch (error) {
      return this.#retirementError('supersede_rule', error);
    }
    record.ruleIds.push(created.rule.id);
    this.#rejudgeDecided(rejudge, rule);
    return ok(
      `자식 규칙 ${rule.displayId}을 폐기하고 ${created.rule.displayId}로 대체로 판단 (새 규칙은 바로 효력, 세션이 끝나면 실행이 자동으로 시작된다)`,
    );
  }

  async #rejudgeUphold(
    record: RuleWriterSessionRecord,
    rejudge: RejudgeContext,
    judgment: AgentRequirementChangeJudgment,
    input: UpholdRuleInput,
  ): Promise<ToolResult> {
    const rule = this.#judgedRule(rejudge, 'uphold_rule', input.ruleId);
    if (!('id' in rule)) return rule;
    try {
      withRegisteredProjectStore(this.#biveHome, record.projectId, (store) =>
        upholdAgentRule(
          store,
          {
            ruleId: rule.id,
            grounds: input.grounds,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: record.id,
            requirementChange: judgment,
          },
          { now: this.#now },
        ),
      );
    } catch (error) {
      return this.#retirementError('uphold_rule', error);
    }
    this.#rejudgeDecided(rejudge, rule);
    return ok(
      rejudge.change === 'deleted'
        ? `자식 규칙 ${rule.displayId} 유지로 판단 (부모 요구사항 없는 규칙으로 효력 유지, 사람은 나중에 봄)`
        : `자식 규칙 ${rule.displayId} 유지로 판단 (규칙 · 인수 테스트는 그대로, 사람은 나중에 봄)`,
    );
  }

  // ── 실행 안의 판단 세션 (M7-11 #223, ADR-115) ─────────────────────

  /**
   * 실행 안의 판단 세션을 한 번 연다 (오케스트레이터 배선만 부른다). 끝날 때까지 기다린다. 열지 못하면 `not_opened`(하루 한도에
   * 이름 · 규칙 작성 역할 설정 미비 · 세션 행 저장 등 시작 실패), 열었으면 종료 사유와 함께 `ended`. 판단 내용은 저장소의 판단 기록이
   * 원천이다. 중단 신호(실행 중단 · 오케스트레이터 종료)가 오면 세션을 `aborted`로 끝내고 그 사유로 거부한다. 서비스가 닫힌 뒤에는
   * 세션을 열지 않고 중단 신호를 기다린다(종료 중인 엔진이 곧 그 실행을 중단한다: 판단 없음을 남기지 않는다).
   */
  async judge(request: NormJudgeRequest): Promise<NormJudgeOutcome> {
    const { signal } = request;
    signal.throwIfAborted();
    if (this.#closed) return untilAborted(signal);
    const { cause } = request;
    const label =
      cause.kind === 'objection'
        ? `${request.run.displayId} 원인 ${String(cause.seq)}`
        : `${request.run.displayId} 검사 실패 ${cause.stage}`;
    const id = this.#newId();
    const workDir = path.join(this.#biveHome, 'work', request.projectId, 'sessions', id);
    let prepared;
    let isKnownCase: CaseNameFilter;
    try {
      // 케이스 이름의 기준: 검사 실패 판단은 판정한 체크아웃의 인수 테스트 파일, 이의 판단은 규칙마다 최근 판정 커밋의 파일
      // (규범 자료와 인용 출처가 같은 함수를 쓴다, M3-37 · ADR-121)
      isKnownCase =
        cause.kind === 'check_failure'
          ? cause.isKnownCase
          : await this.#caseFilter(request.projectId);
      prepared = withRegisteredProjectStore(this.#biveHome, request.projectId, (store) =>
        this.#prepareJudgment(store, request, id, workDir, isKnownCase),
      );
    } catch (error) {
      this.#log(`판단 세션 시작 실패 (${label}): ${errorMessage(error)}`);
      return { status: 'not_opened', reason: 'start_failed', detail: errorMessage(error) };
    }
    if (prepared.status === 'not_opened') {
      this.#log(`판단 세션 생략 (${label}, ${prepared.reason})`);
      return prepared;
    }
    const { model, budget, norms, rules, targets } = prepared;
    const session: JudgmentSession = {
      id,
      projectId: request.projectId,
      runId: request.run.id,
      label,
      rules,
      decided: new Set(),
      context:
        cause.kind === 'objection'
          ? { objection: { causeSeq: cause.seq, runId: request.run.id, normInput: norms.summary } }
          : {
              check: {
                runId: request.run.id,
                stage: cause.stage,
                stepId: request.stepId,
                targets: targets.map((rule) => ({ id: rule.id, displayId: rule.displayId })),
                failures: cause.failures,
                normInput: norms.summary,
              },
            },
      normInput: norms.summary,
      isKnownCase,
      tools: null,
    };
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    const task = this.#tasks?.beginTask();
    this.#log(
      `판단 세션 시작 (${label}, 대상 ${rules.map((rule) => rule.displayId).join(', ')}, 모델 ${model}, ` +
        `한도 USD ${String(budget.maxBudgetUsd)} · 턴 ${String(budget.maxTurns)})`,
    );
    let endReason: SessionEndReason = 'error_during_execution';
    let detail: string | null = null;
    let result: SessionResultEvent | null = null;
    try {
      mkdirSync(workDir, { recursive: true, mode: 0o700 });
      const tools = createRoleTools({
        role: RULE_WRITER_ROLE,
        sessionRoot: workDir,
        biveHome: this.#biveHome,
        now: () => new Date(this.#now()),
        hooks: {
          proposeRule: () =>
            denied(
              'invalid_args',
              'propose_rule은 판단 세션에서 쓰지 않는다 (규칙을 바꾸려면 판단 대상 규칙의 supersede_rule)',
            ),
          retireRule: (input) => this.#judgeRetire(session, input),
          supersedeRule: (input) => this.#judgeSupersede(session, input),
          upholdRule: (input) => this.#judgeUphold(session, input),
          onToolCall: (call) => {
            this.#persistJudgmentToolCall(session, call);
            const name = displayText(call.name, TOOL_CALL_NAME_DISPLAY_MAX).text;
            this.#log(
              `판단 세션 도구 호출 (${label}, ${name} ${call.status}` +
                `${call.reason === undefined ? '' : ` ${call.reason}`})`,
            );
          },
        },
      });
      session.tools = tools;
      const outcome = await runGuardedSession({
        adapter: this.#adapter,
        controller,
        spec: {
          role: RULE_WRITER_ROLE,
          systemPrompt:
            cause.kind === 'objection'
              ? RULE_WRITER_JUDGMENT_SYSTEM_PROMPT
              : RULE_WRITER_CHECK_JUDGMENT_SYSTEM_PROMPT,
          prompt:
            cause.kind === 'objection'
              ? ruleWriterJudgmentPrompt({
                  runDisplayId: request.run.displayId,
                  causeSeq: cause.seq,
                  rules,
                  text: cause.text,
                  norms,
                })
              : ruleWriterCheckJudgmentPrompt({
                  runDisplayId: request.run.displayId,
                  stage: cause.stage,
                  targets,
                  failures: rules.map((rule) => {
                    const failure = cause.failures.find((item) => item.ruleId === rule.id);
                    return {
                      rule,
                      cases: failure?.cases ?? [],
                      unknownCases: failure?.unknownCases ?? 0,
                    };
                  }),
                  norms,
                }),
          workDir,
          tools,
          budget,
          model,
          runId: request.run.id,
          vars: {
            projectId: request.projectId,
            runId: request.run.displayId,
            judgment: cause.kind,
            causeSeq: cause.kind === 'objection' ? String(cause.seq) : '',
            ruleId: rules[0]?.displayId ?? '',
            ruleIds: rules.map((rule) => rule.displayId).join(','),
            requirementId: rules[0]?.parentRequirementId ?? '',
          },
        },
        onInit: (_manifest, init) => {
          this.#quietlyPersist(session, (store) =>
            store.sessions.recordInit(id, {
              sdkSessionId: init.sessionId,
              tools: init.tools,
              mcpServers: init.mcpServers,
            }),
          );
        },
      });
      result = outcome.result;
      endReason = signal.aborted ? 'aborted' : outcome.endReason;
      detail = outcome.detail;
    } catch (error) {
      detail = errorMessage(error);
    } finally {
      signal.removeEventListener('abort', forward);
      rmSync(workDir, { recursive: true, force: true });
      task?.end();
    }
    this.#quietlyPersist(session, (store) =>
      store.sessions.end(id, {
        endReason,
        error: detail,
        totalCostUsd: result?.total_cost_usd ?? null,
        numTurns: result?.num_turns ?? null,
        modelUsage: Object.fromEntries(
          Object.entries(result?.modelUsage ?? {}).map(([name, usage]) => [
            name,
            {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              cacheCreationInputTokens: usage.cacheCreationInputTokens,
              costUsd: usage.costUSD,
            },
          ]),
        ),
        endedAt: this.#timestamp(),
      }),
    );
    const cost = result?.total_cost_usd;
    this.#log(
      `판단 세션 종료 (${label}, ${endReason}, 판단 ${String(session.decided.size)}/${String(rules.length)}건, ` +
        `비용 ${cost === undefined || cost === null ? '없음' : `USD ${String(cost)}`}${detail === null ? '' : `, ${detail}`})`,
    );
    signal.throwIfAborted();
    // 대체로 생긴 새 규칙의 실행 자동 시작 (요구사항 세션과 같은 배선, 정상 종료일 때만 만든다)
    try {
      this.#onSessionEnded?.(request.projectId, id, endReason);
    } catch (error) {
      this.#log(`판단 세션 후속 처리 실패 (${label}): ${errorMessage(error)}`);
    }
    return { status: 'ended', sessionId: id, endReason };
  }

  /**
   * 판단 세션을 열기 전 (열린 저장소): 하루 한도 · 규칙 작성 역할 설정 · 실행 잔여로 한도를 정하고, 대상 규칙 · 규범 입력을 읽고,
   * 세션 행을 만든다(세션 행은 하루 예산 합산의 원천이라 남기지 못하면 열지 않는다).
   */
  #prepareJudgment(
    store: ProjectStore,
    request: NormJudgeRequest,
    id: string,
    workDir: string,
    isKnownCase: CaseNameFilter,
  ):
    | Extract<NormJudgeOutcome, { status: 'not_opened' }>
    | {
        readonly status: 'ready';
        readonly model: string;
        readonly budget: SessionBudget;
        readonly norms: NormInput;
        readonly rules: JudgmentPromptRule[];
        /** 이 실행의 대상 규칙 (검사 실패 판단의 다른 쪽, 이의 판단은 쓰지 않는다) */
        readonly targets: JudgmentPromptRule[];
      } {
    const settings = store.settings.get();
    const daily = projectDailyBudget(store, settings, this.#now());
    if (dailyBudgetReached(daily)) {
      if (daily !== null) this.#logDaily(request.run.displayId, daily);
      return {
        status: 'not_opened',
        reason: 'project_daily_budget_exceeded',
        detail: PROJECT_DAILY_BUDGET_EXCEEDED_TEXT,
      };
    }
    let role;
    try {
      role = roleSessionSettings(
        settings,
        RULE_WRITER_ROLE,
        daily === null ? {} : { maxBudgetUsd: daily.remaining },
      );
    } catch (error) {
      if (error instanceof RpcError && error.code === ErrorCode.SettingsIncomplete) {
        return { status: 'not_opened', reason: 'settings_incomplete', detail: error.message };
      }
      throw error;
    }
    const budget: SessionBudget = {
      maxBudgetUsd: Math.min(role.budget.maxBudgetUsd, request.runBudget.maxBudgetUsd),
      maxTurns: Math.min(role.budget.maxTurns, request.runBudget.maxTurns),
    };
    const promptRules = (ids: readonly string[]): JudgmentPromptRule[] =>
      ids.flatMap((ruleId) => {
        const rule = store.rules.get(ruleId);
        return rule === null
          ? []
          : [
              {
                id: rule.id,
                displayId: rule.displayId,
                title: rule.title,
                statement: rule.statement,
                parentRequirementId: rule.parentRequirementId,
              },
            ];
      });
    const { cause } = request;
    const rules = promptRules(request.ruleIds);
    const runTargets = store.runs.get(request.run.id)?.targetRuleIds ?? [];
    const targets = cause.kind === 'check_failure' ? promptRules(runTargets) : [];
    // 검사 실패 판단의 초점은 두 쪽 규칙. 케이스 이름은 두 원인 모두 인수 테스트 파일에 적힌 것만 싣는다 (ADR-100 A5, ADR-118,
    // ADR-121)
    const norms = collectNormInput(
      store,
      {
        requirementIds: [],
        ruleIds:
          cause.kind === 'check_failure'
            ? [...targets.map((rule) => rule.id), ...request.ruleIds]
            : request.ruleIds,
      },
      { isKnownCase },
    );
    // 세션 행은 이 실행 · 판단을 청한 단계 시도에 묶는다(실행 안 판단 세션, 저장소가 규칙 작성 역할만 단계 역할과 달라도 받는다):
    // 하루 합계와 실행 합계 모두에 들고 `run.get`의 세션 목록에 나온다. 재기동 때는 그 실행의 세션으로 닫힌다 (M7-12, ADR-118)
    store.sessions.start({
      id,
      runId: request.run.id,
      stepId: request.stepId,
      requirementId: null,
      role: RULE_WRITER_ROLE,
      model: role.model,
      workDir,
      budget,
      normInput: normInputRecord(norms),
      startedAt: this.#timestamp(),
    });
    return { status: 'ready', model: role.model, budget, norms, rules, targets };
  }

  /** 판단 세션 기록 쓰기 (실패는 로그만). */
  #quietlyPersist(session: JudgmentSession, fn: (store: ProjectStore) => unknown): void {
    try {
      withRegisteredProjectStore(this.#biveHome, session.projectId, fn);
    } catch (error) {
      this.#log(`판단 세션 기록 저장 실패 (${session.label}): ${errorMessage(error)}`);
    }
  }

  #persistJudgmentToolCall(session: JudgmentSession, call: ToolCallRecord): void {
    this.#quietlyPersist(session, (store) =>
      store.sessions.appendToolCall({
        id: this.#newId(),
        runId: session.runId,
        sessionId: session.id,
        at: call.at,
        role: call.role,
        name: call.name,
        argsSummary: call.argsSummary,
        status: call.status,
        reason: call.reason ?? null,
        durationMs: Math.max(0, Math.round(call.durationMs)),
      }),
    );
  }

  /** 판단 대상 규칙 하나 (표시 ID 또는 ID). 대상 밖 · 이미 판단한 규칙이면 거부 결과. */
  #judgedRule(
    session: JudgedTargets,
    tool: 'retire_rule' | 'supersede_rule' | 'uphold_rule',
    given: string,
  ): JudgmentPromptRule | ToolResult {
    const rule = session.rules.find((item) => item.id === given || item.displayId === given);
    if (rule === undefined) {
      return denied(
        'invalid_args',
        `${tool} 인자 오류: ${JSON.stringify(given)}는 판단 대상 규칙이 아님 (${session.rules.map((item) => item.displayId).join(', ')} 가운데)`,
      );
    }
    if (session.decided.has(rule.id)) {
      return denied(
        'invalid_args',
        `${tool} 인자 오류: ${rule.displayId}는 이미 판단함 (규칙마다 한 번)`,
      );
    }
    return rule;
  }

  /** 판단을 하나 남겼다: 대상 규칙을 모두 판단했으면 실행기를 닫는다 (이후 호출은 거부). */
  #decided(session: JudgmentSession, rule: JudgmentPromptRule): void {
    session.decided.add(rule.id);
    if (session.decided.size >= session.rules.length) session.tools?.close('judgment_complete');
  }

  #judgeRetire(session: JudgmentSession, input: RetireRuleInput): ToolResult {
    const rule = this.#judgedRule(session, 'retire_rule', input.ruleId);
    if (!('id' in rule)) return rule;
    try {
      withRegisteredProjectStore(this.#biveHome, session.projectId, (store) =>
        retireAgentRule(
          store,
          {
            ruleId: rule.id,
            grounds: input.grounds,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: session.id,
            ...session.context,
            isKnownCase: session.isKnownCase,
          },
          { now: this.#now },
        ),
      );
    } catch (error) {
      return this.#retirementError('retire_rule', error);
    }
    this.#decided(session, rule);
    return ok(`규칙 ${rule.displayId} 폐기로 판단 (이 실행은 병합 없이 끝난다, 사람은 나중에 봄)`);
  }

  #judgeSupersede(session: JudgmentSession, input: SupersedeRuleInput): ToolResult {
    const rule = this.#judgedRule(session, 'supersede_rule', input.ruleId);
    if (!('id' in rule)) return rule;
    if (
      rule.parentRequirementId === null ||
      input.parentRequirementId !== rule.parentRequirementId
    ) {
      return denied(
        'invalid_args',
        rule.parentRequirementId === null
          ? `supersede_rule 인자 오류: ${rule.displayId}는 부모 요구사항이 없어 대체할 수 없음 (폐기 또는 유지)`
          : `supersede_rule 인자 오류: parentRequirementId는 대상 규칙의 부모 요구사항 ${rule.parentRequirementId}만 쓸 수 있음`,
      );
    }
    const { rationale, contradiction, ruleId, grounds, ...payload } = input;
    let created;
    try {
      created = withRegisteredProjectStore(this.#biveHome, session.projectId, (store) =>
        supersedeAgentRule(
          store,
          {
            payload,
            rationale,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: session.id,
            contradiction,
            normInput: session.normInput,
            // 판단 대상인지는 위에서 봤다 (표시 ID 또는 ID 그대로 넘긴다)
            ruleId,
            grounds,
            ...session.context,
            isKnownCase: session.isKnownCase,
          },
          { now: this.#now, newId: this.#newId },
        ),
      );
    } catch (error) {
      return this.#retirementError('supersede_rule', error);
    }
    this.#decided(session, rule);
    return ok(
      `규칙 ${rule.displayId}을 폐기하고 ${created.rule.displayId}로 대체로 판단 (새 규칙의 실행이 자동으로 시작되고 이 실행은 병합 없이 끝난다)`,
    );
  }

  #judgeUphold(session: JudgmentSession, input: UpholdRuleInput): ToolResult {
    const rule = this.#judgedRule(session, 'uphold_rule', input.ruleId);
    if (!('id' in rule)) return rule;
    try {
      withRegisteredProjectStore(this.#biveHome, session.projectId, (store) =>
        upholdAgentRule(
          store,
          {
            ruleId: rule.id,
            grounds: input.grounds,
            author: { kind: 'agent', role: RULE_WRITER_ROLE },
            sessionId: session.id,
            ...session.context,
          },
          { now: this.#now },
        ),
      );
    } catch (error) {
      return this.#retirementError('uphold_rule', error);
    }
    this.#decided(session, rule);
    return ok(
      'check' in session.context
        ? `규칙 ${rule.displayId} 모순 아님으로 판단 (규칙 · 인수 테스트는 그대로, 근거는 구현 역할에게 전해진다)`
        : `규칙 ${rule.displayId} 유지로 판단 (규칙 · 인수 테스트는 그대로, 근거는 구현 역할에게 전해진다)`,
    );
  }
}
