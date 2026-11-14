// 시험 전용 진입점 (M1-22, ADR-075): 네트워크 감시(`net-watch.ts`)를 건 뒤 제품 CLI(`src/cli.ts`)를 그대로 불러 오케스트레이터를 띄운다.
// 기록 파일은 환경 변수 `BIVE_NET_WATCH_LOG`(필수). 감시는 이 프로세스에만 걸린다(하위 프로세스는 범위 밖).
import { appendNetWatchLog, installNetWatch } from './net-watch.js';

const file = process.env.BIVE_NET_WATCH_LOG;
if (file === undefined || file.length === 0) {
  console.error('BIVE_NET_WATCH_LOG 없음');
  process.exit(2);
}
installNetWatch({ onRecord: appendNetWatchLog(file) });
// 감시를 건 뒤에 제품 코드를 불러온다 (정적 import는 감시보다 먼저 평가될 수 있다)
await import('../../src/cli.js');
