// 세션 가드를 건 에이전트 세션 1회 실행과 종료 사유 분류 (NFR-02 · ADR-049 · ADR-052 · ADR-062 · ADR-066).
// 규칙 작성 세션(ADR-062)과 실행 엔진의 단계 세션(ADR-066)이 같이 쓴다.
// - 이벤트는 `guardSession`을 거쳐 읽는다: init의 도구 · MCP 서버가 역할 허용 목록과 다르면 `guard_violation`
// - 종료 사유: 결과 이벤트가 있으면 그 subtype, 가드 위반 `guard_violation`, 중단 `aborted`, 그 밖 예외 · 결과 없음
//   `error_during_execution`. init 없이 결과만 오는 시작 실패는 세션 가드가 오류 결과로 넘긴다
import type { SessionEndReason, ToolManifestEntry } from '@bive/shared';

import {
  guardSession,
  SessionGuardError,
  type SessionGuardExpectation,
} from '../tools/session-guard.js';
import type {
  AgentAdapter,
  SessionEvent,
  SessionInitEvent,
  SessionResultEvent,
  SessionSpec,
} from './adapter.js';

export interface GuardedSessionOptions {
  adapter: AgentAdapter;
  /** 세션 입력. `signal`은 `controller.signal`로 정한다 */
  spec: Omit<SessionSpec, 'signal'>;
  /** 세션 중단 컨트롤러 (호출한 쪽이 종료 · 상위 중단을 이것으로 알린다). 가드 위반도 이것을 중단한다 */
  controller: AbortController;
  /** 허용 도구 · MCP 서버 (기본: 역할 허용 목록 · `bive`) */
  guard?: Omit<SessionGuardExpectation, 'role'>;
  /** init을 받을 때마다 (위반 여부와 무관) */
  onInit?: (manifest: ToolManifestEntry, init: SessionInitEvent) => void;
  /** 가드를 통과한 이벤트마다 */
  onEvent?: (event: SessionEvent) => void;
}

export interface GuardedSessionOutcome {
  endReason: SessionEndReason;
  /** 결과 이벤트 (없이 끝났으면 `null`) */
  result: SessionResultEvent | null;
  /** 마지막 init 이벤트 */
  init: SessionInitEvent | null;
  manifest: ToolManifestEntry | null;
  /** 결과 없이 끝난 사유 문장 (예외 메시지 · "결과 메시지 없이 세션이 끝남") */
  detail: string | null;
  /** 순회를 끝낸 예외 (`SessionGuardError` · 중단 사유 등) */
  error: unknown;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 세션 하나를 끝까지 돌리고 종료 사유를 분류한다. 예외를 던지지 않는다. */
export const runGuardedSession = async (
  options: GuardedSessionOptions,
): Promise<GuardedSessionOutcome> => {
  const { adapter, spec, controller } = options;
  const outcome: GuardedSessionOutcome = {
    endReason: 'error_during_execution',
    result: null,
    init: null,
    manifest: null,
    detail: null,
    error: null,
  };
  try {
    const events = guardSession(adapter.startSession({ ...spec, signal: controller.signal }), {
      ...options.guard,
      role: spec.role,
      controller,
      onManifest: (manifest, init) => {
        outcome.manifest = manifest;
        outcome.init = init;
        options.onInit?.(manifest, init);
      },
    });
    for await (const event of events) {
      if (event.type === 'result') outcome.result = event;
      options.onEvent?.(event);
    }
    if (outcome.result === null) {
      outcome.detail = '결과 메시지 없이 세션이 끝남';
    } else {
      outcome.endReason = outcome.result.subtype;
    }
  } catch (error) {
    outcome.error = error;
    outcome.detail = errorMessage(error);
    if (error instanceof SessionGuardError) {
      outcome.endReason = 'guard_violation';
    } else if (controller.signal.aborted) {
      outcome.endReason = 'aborted';
    }
  }
  return outcome;
};
