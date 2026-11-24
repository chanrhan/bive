// 규범 변경 알림: 규범 변경 기록이 늘어난 저장소 사용이 끝난 뒤 → `event.normChange.appended` (NRM-07 · TODO-01, M7-14 #226,
// ADR-119).
// - 저장소를 여닫는 한 곳(`ipc/project-store-access.ts`의 `onNormChangeAppended`)이 사용 전후 마지막 순번을 비교해 부른다.
//   기록을 쓰는 모듈(바로 반영 · 폐기 · 판단 · 자동 시작 · 테스트 변경)은 이 알림을 모른다
// - 내용 없이 프로젝트 ID와 마지막 순번만 싣는다. 받는 쪽은 알림 값으로 화면을 그리지 않고 다시 조회한다
// - 기다리지 않는다: 송신 실패는 그 쓰기에 영향이 없고 기록만 남는다 (규칙 작성 알림과 같음, ADR-076)
import type { NormChangeAppendedListener } from '../ipc/project-store-access.js';
import type { NotificationSink } from './run-events.js';

export interface NormChangeEventOptions {
  /** 지금 알림을 보낼 곳. 파이프 서버를 만들기 전이면 `null` */
  sink: () => NotificationSink | null;
  /** 송신 실패 기록 한 줄 */
  log?: (line: string) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `onNormChangeAppended`에 넘기는 알림 함수. 던지지 않는다. */
export const normChangeAppendedNotifier = ({
  sink,
  log,
}: NormChangeEventOptions): NormChangeAppendedListener => {
  const report = (error: unknown): void => {
    try {
      log?.(`규범 변경 알림 전달 실패: ${errorMessage(error)}`);
    } catch {
      // 기록 실패는 무시한다
    }
  };
  return (projectId, lastSeq) => {
    try {
      const target = sink();
      if (target === null) return;
      target.notify('event.normChange.appended', { projectId, lastSeq }).catch(report);
    } catch (error) {
      report(error);
    }
  };
};
