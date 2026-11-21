// 규칙 작성 알림: 시도 기록 저장 뒤 → `event.ruleWriter.changed` (NRM-02, SCR-02, M3-26, ADR-099).
// - 규칙 작성 서비스가 시도 기록(대기 · 시작 · 끝 · 생략)을 저장한 뒤 요구사항마다 1개를 인증된 모든 연결에 보낸다
// - 식별자만 싣는다. 받는 쪽은 알림 값으로 화면을 그리지 않고 `ruleWriter.status`를 다시 조회한다
// - 기다리지 않는다: 송신 실패는 세션에 영향이 없고 기록만 남는다 (제안 알림과 같음, ADR-076)
import type { RuleWriterChangeListener } from '../rule-writer/rule-writer-service.js';
import type { NotificationSink } from './run-events.js';

export interface RuleWriterEventOptions {
  /** 지금 알림을 보낼 곳. 파이프 서버를 만들기 전이면 `null` */
  sink: () => NotificationSink | null;
  /** 송신 실패 기록 한 줄 */
  log?: (line: string) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 규칙 작성 서비스의 `onChanged`에 넘기는 알림 함수. 던지지 않는다. */
export const ruleWriterChangedNotifier = ({
  sink,
  log,
}: RuleWriterEventOptions): RuleWriterChangeListener => {
  const report = (error: unknown): void => {
    try {
      log?.(`규칙 작성 알림 전달 실패: ${errorMessage(error)}`);
    } catch {
      // 기록 실패는 무시한다
    }
  };
  return (projectId, requirementId) => {
    try {
      const target = sink();
      if (target === null) return;
      target.notify('event.ruleWriter.changed', { projectId, requirementId }).catch(report);
    } catch (error) {
      report(error);
    }
  };
};
