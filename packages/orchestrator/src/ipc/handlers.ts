// 인증된 연결이 부를 수 있는 메서드 처리기. 메서드는 각 이슈에서 여기에 더한다.
import type { ProposalChangeListener } from '../events/proposal-events.js';
import type { RuleSplitLauncher, RuleWriterLauncher } from '../rule-writer/rule-writer-service.js';
import type { RunEngineHooks } from './run-handlers.js';
import { createBlockHandlers } from './block-handlers.js';
import { createCodeOpenHandlers } from './code-open-handlers.js';
import { createConfirmationHandlers } from './confirmation-handlers.js';
import { createContractHandlers } from './contract-handlers.js';
import { createNormChangeHandlers } from './norm-change-handlers.js';
import { createProjectHandlers } from './project-handlers.js';
import { createProposalHandlers } from './proposal-handlers.js';
import { createRequirementHandlers } from './requirement-handlers.js';
import { createReviewQueueHandlers } from './review-queue-handlers.js';
import { createRuleHandlers, type RuleEditStarter } from './rule-handlers.js';
import { createRuleWriterHandlers } from './rule-writer-handlers.js';
import { createRunHandlers } from './run-handlers.js';
import type { MethodHandlers } from './server.js';
import { createSettingsHandlers } from './settings-handlers.js';
import { createToolCallHandlers } from './tool-call-handlers.js';
import { createVerificationHandlers } from './verification-handlers.js';

/** `system.status`가 읽는 오케스트레이터 상태 (ADR-045). */
export interface StatusSource {
  /** 기동 시각 (`now()`와 같은 시계, ms) */
  readonly startedAt: number;
  /** 열린 파이프 연결 수 (인증 여부 무관, ADR-041 유휴 종료 기준과 같음) */
  readonly connectionCount: number;
  /** 진행 중 실행 수 (`RunTracker.activeRunCount`) */
  readonly activeRunCount: number;
}

export interface HandlerDeps {
  orchestratorVersion: string;
  status: StatusSource;
  /** `$BIVE_HOME` 절대 경로. 프로젝트 저장소 · 등록부를 여기서 연다 */
  biveHome: string;
  /** 시계 (기본 `Date.now`) */
  now?: () => number;
  /** `requirement.create` 뒤 규칙 자동 생성 세션 창구 (M1-08). 생략하면 세션을 띄우지 않는다 */
  ruleWriter?: RuleWriterLauncher;
  /** 예산 초과 항목의 규칙 분할 세션 창구 (M3-57, ADR-153). 생략하면 규칙 분할 RPC가 -32603 */
  ruleSplitter?: RuleSplitLauncher;
  /** 실행 엔진 (M1-14): 실행 생성 · 규칙 승인 뒤 승인 단계 판정, `run.resume`. 생략하면 실행이 진행되지 않는다 */
  engine?: RunEngineHooks;
  /** 제안 처리가 저장된 뒤 부른다 (제안 알림 `event.proposal.changed`, M1-36, ADR-076). 생략하면 알리지 않는다 */
  onProposalChanged?: ProposalChangeListener;
  /** 사람이 규칙 진술을 고친 뒤 실행 자동 시작 (M7-03, ADR-109). 생략하면 실행을 만들지 않는다 */
  ruleEditStarter?: RuleEditStarter;
  /** 블록 선언 새 판이 저장된 뒤 부른다 (`event.blocks.changed`, M3-42 · ADR-135). 생략하면 알리지 않는다 */
  onBlocksChanged?: (projectId: string, version: number) => void;
}

export const createHandlers = ({
  orchestratorVersion,
  status,
  biveHome,
  now = Date.now,
  ruleWriter,
  ruleSplitter,
  engine,
  onProposalChanged,
  ruleEditStarter,
  onBlocksChanged,
}: HandlerDeps): MethodHandlers => ({
  ping: () => ({ pong: true, version: orchestratorVersion }),
  'system.status': () => ({
    version: orchestratorVersion,
    // 시계가 뒤로 가도 음수를 내보내지 않는다 (결과 스키마: 0 이상 정수)
    uptimeMs: Math.max(0, Math.floor(now() - status.startedAt)),
    connections: status.connectionCount,
    runsInProgress: status.activeRunCount,
  }),
  ...createProjectHandlers({ biveHome, now }),
  ...createRequirementHandlers({
    biveHome,
    now,
    ...(ruleWriter === undefined ? {} : { ruleWriter }),
  }),
  ...createRuleHandlers({
    biveHome,
    now,
    ...(ruleEditStarter === undefined ? {} : { ruleEditStarter }),
  }),
  ...createRuleWriterHandlers({ biveHome }),
  ...createProposalHandlers({
    biveHome,
    now,
    ...(engine === undefined ? {} : { engine }),
    ...(onProposalChanged === undefined ? {} : { onProposalChanged }),
  }),
  ...createConfirmationHandlers({ biveHome, now }),
  ...createNormChangeHandlers({ biveHome }),
  ...createBlockHandlers({
    biveHome,
    now,
    ...(onBlocksChanged === undefined ? {} : { onChanged: onBlocksChanged }),
  }),
  ...createContractHandlers({ biveHome, now }),
  ...createSettingsHandlers({ biveHome, now }),
  ...createRunHandlers({ biveHome, now, ...(engine === undefined ? {} : { engine }) }),
  ...createReviewQueueHandlers({
    biveHome,
    now,
    ...(ruleSplitter === undefined ? {} : { ruleSplitter }),
  }),
  ...createVerificationHandlers({ biveHome }),
  ...createToolCallHandlers({ biveHome }),
  ...createCodeOpenHandlers({ biveHome, now }),
});
