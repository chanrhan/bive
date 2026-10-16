import type { BiveBridge } from '../../common/bridge.js';

declare global {
  interface Window {
    /** preload가 노출하는 브리지. `invoke` · `on` 두 키뿐이다. */
    readonly bive: BiveBridge;
  }
}
