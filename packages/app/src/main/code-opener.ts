// main의 코드 열기 `app.openInIde` (MET-01, SCR-03 · 1.4 코드 열기, ADR-084). Electron에 의존하지 않아 단위 테스트에서
// 그대로 부른다(test/code-opener.test.ts). 순서:
// 1) 대상 다시 검증(`CodeOpenTarget`) → 2) 프로젝트 루트(`project.list`)로 루트 안의 절대 경로를 풀고 URL을 만든다
// 3) `codeOpen.record`(사람 주체)로 기록 → 4) 기록이 성공해야 연다(`openUrl`). 기록이 실패하면 열지 않는다(MET-01 "열 때마다 기록")
// 열기가 실패해도 기록은 남는다(사람이 사유를 골라 연 시도 1회). 렌더러는 URL을 넘기지 않고 main이 고정 틀로만 만든다.
// 이음매: URL 틀은 `buildUrl`(기본 `vscodeFileUrl`), 여는 곳은 `openUrl`(Electron은 `open-external.ts`) — #45가 바꿔 끼운다.
import { type CodeOpenRecordResult, CodeOpenTarget, type ProjectListResult } from '@bive/shared';

import { OPEN_IN_IDE_METHOD } from '../common/bridge.js';
import { type IdeUrlBuilder, resolveProjectFile, vscodeFileUrl } from './ide-url.js';
import type { AppMethodHandlers } from './rpc-bridge.js';

export interface CodeOpenerDeps {
  /** 오케스트레이터 요청 (결과는 메서드 스키마로 검증된 값) */
  request(method: string, params?: unknown): Promise<unknown>;
  /** URL을 연다 (Electron: `openExternalUrl`). 실패하면 예외 */
  openUrl(url: string): Promise<void>;
  /** 절대 경로 + 줄 → IDE URL (기본 VS Code, ADR-018) */
  buildUrl?: IdeUrlBuilder;
}

export interface CodeOpener {
  /** `bive:rpc`가 처리할 main 메서드 */
  readonly appMethods: AppMethodHandlers;
}

export const createCodeOpener = (deps: CodeOpenerDeps): CodeOpener => {
  const buildUrl = deps.buildUrl ?? vscodeFileUrl;
  const openInIde = async (input: CodeOpenTarget): Promise<CodeOpenRecordResult> => {
    // 브리지가 이미 검증했지만 main 안의 다른 호출자도 같은 기준을 지나게 한 번 더 본다
    const target = CodeOpenTarget.parse(input);
    const { projects } = (await deps.request('project.list')) as ProjectListResult;
    const project = projects.find((item) => item.id === target.projectId);
    if (project === undefined) throw new Error(`등록되지 않은 프로젝트: ${target.projectId}`);
    const absolute = resolveProjectFile(project.rootPath, target.file);
    if (absolute === null) throw new Error(`프로젝트 루트 밖의 경로: ${target.file}`);
    const url = buildUrl(absolute, target.line);
    const recorded = (await deps.request('codeOpen.record', {
      ...target,
      author: { kind: 'human' },
    })) as CodeOpenRecordResult;
    await deps.openUrl(url);
    return recorded;
  };
  return { appMethods: { [OPEN_IN_IDE_METHOD]: openInIde } };
};
