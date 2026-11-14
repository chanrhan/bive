// `verification.summary` 처리기 (JDG-03, COST-02, SCR-05, M1-18, ADR-072).
// 검증 화면이 읽는 값(판정 기준 · 준수 · 분모 목록 · 실행당 비용 · 규칙별 판정과 실행 링크 · 파이프라인)을
// 저장소를 한 번 열어 만든다. 읽기만 한다.
import { verificationSummary } from '../verification/summary.js';
import { withProjectStore } from './project-store-access.js';
import type { MethodHandlers } from './server.js';

export interface VerificationHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
}

type VerificationMethods = Pick<MethodHandlers, 'verification.summary'>;

export const createVerificationHandlers = ({
  biveHome,
}: VerificationHandlerDeps): VerificationMethods => ({
  'verification.summary': ({ projectId }) =>
    withProjectStore(biveHome, projectId, (store) => verificationSummary(store)),
});
