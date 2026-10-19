// 인증된 연결이 부를 수 있는 메서드 처리기. 메서드는 각 이슈에서 여기에 더한다.
import { createProjectHandlers } from './project-handlers.js';
import { createProposalHandlers } from './proposal-handlers.js';
import { createRequirementHandlers } from './requirement-handlers.js';
import type { MethodHandlers } from './server.js';
import { createSettingsHandlers } from './settings-handlers.js';

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
}

export const createHandlers = ({
  orchestratorVersion,
  status,
  biveHome,
  now = Date.now,
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
  ...createRequirementHandlers({ biveHome, now }),
  ...createProposalHandlers({ biveHome, now }),
  ...createSettingsHandlers({ biveHome, now }),
});
