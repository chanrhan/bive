// lint-path: packages/shared/src/__lint__.ts
// lint-path: packages/store/src/__lint__.ts
// lint-path: packages/parser/src/__lint__.ts
// lint-path: packages/orchestrator/src/__lint__.ts
// lint-path: packages/app/src/__lint__.ts
// 제품 코드에서 테스트 전용 모듈(e2e · fixtures · mock) import 금지 (NFR-03)
import { bridge } from '../../../e2e/support/bridge.js'; // 위반
import { health } from '../../../fixtures/sample-next-app/app/api/health.js'; // 위반
import { adapter } from './agents/mock-adapter.js'; // 위반
import { MockAdapter } from './agents/MockAdapter.js'; // 위반
import { seed } from 'some-mocks'; // 위반
export * from './mocks/index.js'; // 위반
export { mockRun } from './run-mock.js'; // 위반
const lazy = await import('./test-mocks/data.js'); // 위반
const lazyE2e = await import('../../../e2e/support/bridge.js'); // 위반
import { scripted } from './agents/scripted-adapter.js'; // 허용
import { loadFixturesConfig } from './fixtures-loader.js'; // 허용
