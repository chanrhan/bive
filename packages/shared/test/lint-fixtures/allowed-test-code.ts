// lint-path: packages/orchestrator/test/__lint__.test.ts
// lint-path: packages/app/e2e/__lint__.spec.ts
// 테스트 코드는 제품 코드 규칙 대상이 아니다: 목 · e2e · fixtures import 허용
import { mockBridge } from '../../../e2e/support/bive-mock.js'; // 허용
import { health } from '../../../fixtures/sample-next-app/app/api/health.js'; // 허용
import { MockAdapter } from '../src/agents/MockAdapter.js'; // 허용
import { createWindow } from '@bive/app'; // 허용
