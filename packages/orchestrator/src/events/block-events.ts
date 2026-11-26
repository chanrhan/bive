// 블록 선언 알림: 사람의 `blocks.set`이 새 판을 저장한 뒤 → `event.blocks.changed` (NRM-09, SCR-02 · SCR-03 · SCR-06,
// M3-42 #283, ADR-135).
// - 블록 선언을 쓰는 곳은 `blocks.set` 처리기 하나라 그 처리기가 저장(커밋) 뒤 1개를 인증된 모든 연결에 보낸다
// - 내용 없이 프로젝트 ID와 새 판 번호만 싣는다. 받는 쪽은 알림 값으로 화면을 그리지 않고 `blocks.get`을 다시 조회한다
// - 기다리지 않는다: 송신 실패는 저장에 영향이 없고 기록만 남는다 (규칙 작성 알림과 같음, ADR-076)
import type { NotificationSink } from './run-events.js';

export interface BlockEventOptions {
  /** 지금 알림을 보낼 곳. 파이프 서버를 만들기 전이면 `null` */
  sink: () => NotificationSink | null;
  /** 송신 실패 기록 한 줄 */
  log?: (line: string) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `blocks.set` 처리기의 `onChanged`에 넘기는 알림 함수. 던지지 않는다. */
export const blocksChangedNotifier = ({
  sink,
  log,
}: BlockEventOptions): ((projectId: string, version: number) => void) => {
  const report = (error: unknown): void => {
    try {
      log?.(`블록 선언 알림 전달 실패: ${errorMessage(error)}`);
    } catch {
      // 기록 실패는 무시한다
    }
  };
  return (projectId, version) => {
    try {
      const target = sink();
      if (target === null) return;
      target.notify('event.blocks.changed', { projectId, version }).catch(report);
    } catch (error) {
      report(error);
    }
  };
};
