// main의 프로젝트 열기 (M1-01, SCR-01). Electron에 의존하지 않아 단위 테스트에서 그대로 부른다(test/open-arg.test.ts).
// - 기동 인자 `--open <path>`가 있으면 대화상자 없이 `project.open`을 부른다
// - 렌더러 [폴더 열기]는 `app.pickFolder`(대화상자) → 렌더러가 `project.open`을 부른다
// - main을 거친 `project.open`이 성공하면 모든 창에 `project.opened`를 보낸다(늦게 뜬 창은 `project.current`로 따라잡는다)
import type { ProjectOpenResult } from '@bive/shared';

import {
  type BridgeEvent,
  PICK_FOLDER_METHOD,
  PROJECT_OPENED_EVENT,
  type ProjectOpenedEventParams,
} from '../common/bridge.js';
import { parseOpenArg } from './open-arg.js';
import type { AppMethodHandlers } from './rpc-bridge.js';

export interface ProjectOpenerDeps {
  /** 오케스트레이터 요청 (결과는 메서드 스키마로 검증된 값) */
  request(method: string, params?: unknown): Promise<unknown>;
  /** OS 폴더 선택 대화상자. 취소하면 null */
  pickFolder(): Promise<string | null>;
  /** 모든 창에 알림 */
  emit(event: BridgeEvent): void;
  /** main 로그 (기본 표준 오류) */
  log?: (message: string) => void;
}

export interface ProjectOpener {
  /** `bive:rpc`가 처리할 main 메서드 */
  readonly appMethods: AppMethodHandlers;
  /** `bive:rpc`의 파이프 요청 성공 후처리: `project.open`이면 알림을 보낸다 */
  onResult(method: string, result: unknown): void;
  /** 폴더를 연다. 성공하면 알림을 보내고 결과를, 실패하면 예외를 던진다 */
  open(path: string): Promise<ProjectOpenResult>;
  /**
   * 기동 인자에 `--open`이 있으면 그 폴더를 연다(대화상자 없음). 열었으면 결과, 인자가 없거나 실패하면 null.
   * 실패는 main 로그에만 남기고 화면은 프로젝트 시작에 머문다.
   */
  openFromArgv(argv: readonly string[], cwd: string): Promise<ProjectOpenResult | null>;
}

export const createProjectOpener = (deps: ProjectOpenerDeps): ProjectOpener => {
  const log = deps.log ?? ((message: string) => console.error(message));
  const notify = (result: ProjectOpenResult): void => {
    const params: ProjectOpenedEventParams = result;
    deps.emit({ event: PROJECT_OPENED_EVENT, params });
  };
  const open = async (path: string): Promise<ProjectOpenResult> => {
    const result = (await deps.request('project.open', { path })) as ProjectOpenResult;
    notify(result);
    return result;
  };
  return {
    appMethods: {
      [PICK_FOLDER_METHOD]: async () => ({ path: await deps.pickFolder() }),
    },
    onResult: (method, result) => {
      if (method === 'project.open') notify(result as ProjectOpenResult);
    },
    open,
    openFromArgv: async (argv, cwd) => {
      const arg = parseOpenArg(argv, cwd);
      if (arg.kind === 'none') return null;
      if (arg.kind === 'missing') {
        log('--open 뒤에 폴더 경로가 없음');
        return null;
      }
      try {
        return await open(arg.path);
      } catch (error) {
        const detail =
          typeof error === 'object' && error !== null && 'message' in error
            ? String(error.message)
            : String(error);
        log(`프로젝트 열기 실패 (${arg.path}): ${detail}`);
        return null;
      }
    },
  };
};
