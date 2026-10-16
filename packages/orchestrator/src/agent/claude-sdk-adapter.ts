// 실제 Claude Agent SDK 어댑터 자리 (ADR-016). 옵션 조립 · 호출은 M1-26에서 구현한다.
// 지금은 같은 인터페이스로 선택 · 기동만 가능하고, 세션을 순회하면 미구현 오류로 끝난다.
import type { AgentAdapter, SessionEvent, SessionSpec } from './adapter.js';

export const CLAUDE_SDK_NOT_IMPLEMENTED = 'ClaudeSdkAdapter 미구현(M1-26)';

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly kind = 'claude' as const;

  startSession(spec: SessionSpec): AsyncIterable<SessionEvent> {
    return notImplemented(spec);
  }
}

// eslint-disable-next-line require-yield -- 순회 시작에서 바로 실패하는 자리 구현
async function* notImplemented(spec: SessionSpec): AsyncGenerator<SessionEvent> {
  spec.signal?.throwIfAborted();
  throw new Error(CLAUDE_SDK_NOT_IMPLEMENTED);
}
