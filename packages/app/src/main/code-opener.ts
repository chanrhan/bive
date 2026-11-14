// main의 코드 열기 `app.openInIde` (MET-01, SCR-03 · 1.4 코드 열기, ADR-084 · ADR-087). Electron에 의존하지 않아 단위
// 테스트에서 그대로 부른다(test/code-opener.test.ts). 순서:
// 1) 대상 다시 검증(`CodeOpenTarget`) → 2) 프로젝트 루트(`project.list`)로 루트 안의 절대 경로를 푼다(실제 경로로도 확인)
// 3) 설정의 IDE 선택(`settings.get`)을 다시 읽어 URL을 만들고 허용 범위를 확인한다. 미설정이면 열지 않는다(화면이 먼저
//    선택을 받아 저장한다, ADR-018) → 4) `codeOpen.record`(사람 주체)로 기록 → 5) 기록이 성공해야 연다(`openUrl`).
// 1 ~ 3이 실패하면 기록도 열기도 없다. 기록이 실패하면 열지 않는다(MET-01 "열 때마다 기록"). 열기가 실패해도 기록은 남는다
// (사람이 사유를 골라 연 시도 1회). 렌더러는 URL · 틀을 넘기지 않는다.
import {
  type CodeOpenRecordResult,
  CodeOpenTarget,
  type ProjectListResult,
  type SettingsResult,
} from '@bive/shared';

import { OPEN_IN_IDE_METHOD } from '../common/bridge.js';
import { buildIdeUrl, resolveRealProjectFile } from './ide-url.js';
import type { AppMethodHandlers } from './rpc-bridge.js';

export interface CodeOpenerDeps {
  /** 오케스트레이터 요청 (결과는 메서드 스키마로 검증된 값) */
  request(method: string, params?: unknown): Promise<unknown>;
  /** URL을 연다 (Electron: `openExternalUrl`). 실패하면 예외 */
  openUrl(url: string): Promise<void>;
  /** 루트 + 상대 경로 → 루트 안의 절대 경로 또는 `null` (기본: 실제 경로까지 보는 `resolveRealProjectFile`) */
  resolveFile?(root: string, file: string): Promise<string | null>;
}

export interface CodeOpener {
  /** `bive:rpc`가 처리할 main 메서드 */
  readonly appMethods: AppMethodHandlers;
}

export const createCodeOpener = (deps: CodeOpenerDeps): CodeOpener => {
  const resolveFile = deps.resolveFile ?? resolveRealProjectFile;
  const openInIde = async (input: CodeOpenTarget): Promise<CodeOpenRecordResult> => {
    // 브리지가 이미 검증했지만 main 안의 다른 호출자도 같은 기준을 지나게 한 번 더 본다
    const target = CodeOpenTarget.parse(input);
    const { projects } = (await deps.request('project.list')) as ProjectListResult;
    const project = projects.find((item) => item.id === target.projectId);
    if (project === undefined) throw new Error(`등록되지 않은 프로젝트: ${target.projectId}`);
    const absolute = await resolveFile(project.rootPath, target.file);
    if (absolute === null) throw new Error(`프로젝트 루트 밖의 경로: ${target.file}`);
    const { settings } = (await deps.request('settings.get', {
      projectId: target.projectId,
    })) as SettingsResult;
    if (settings.ide === null) throw new Error('IDE 미설정');
    const url = buildIdeUrl(settings.ide, absolute, target.line);
    const recorded = (await deps.request('codeOpen.record', {
      ...target,
      author: { kind: 'human' },
    })) as CodeOpenRecordResult;
    await deps.openUrl(url);
    return recorded;
  };
  return { appMethods: { [OPEN_IN_IDE_METHOD]: openInIde } };
};
