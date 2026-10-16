// 인증된 연결이 부를 수 있는 메서드 처리기. 메서드는 각 이슈에서 여기에 더한다.
import type { MethodHandlers } from './server.js';

export interface HandlerDeps {
  orchestratorVersion: string;
}

export const createHandlers = ({ orchestratorVersion }: HandlerDeps): MethodHandlers => ({
  ping: () => ({ pong: true, version: orchestratorVersion }),
});
