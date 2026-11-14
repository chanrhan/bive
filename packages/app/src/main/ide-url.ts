// 코드 열기의 IDE URL 만들기 (MET-01, ADR-018 · ADR-084). Electron에 의존하지 않는 순수 함수라 단위 테스트에서 부른다.
// - 열 파일 = 프로젝트 루트 + 프로젝트 루트 기준 상대 경로. 루트 밖으로 나가면 만들지 않는다(`resolveProjectFile`)
// - URL은 고정 틀에서만 만든다. 지금은 기본값 VS Code `vscode://file/{path}:{line}` 하나다(ADR-018).
//   설정의 IDE 선택(Cursor · 사용자 지정 틀)은 #45(M2-03)가 `IdeUrlBuilder`를 바꿔 끼워 더한다
// - 여는 곳(`shell.openExternal`)은 `open-external.ts` 한 곳이고, 그 전에 `assertIdeUrl`로 스킴을 확인한다
import path from 'node:path';

import { isProjectRelativePath } from '@bive/shared';

/** 열 수 있는 IDE URL 스킴 (콜론 포함, `URL.protocol` 모양). */
export const IDE_URL_SCHEMES = ['vscode:'] as const;

/** 절대 파일 경로 + 줄 → IDE URL. */
export type IdeUrlBuilder = (absolutePath: string, line: number) => string;

/**
 * 프로젝트 루트 기준 상대 경로를 절대 경로로 푼다. 루트가 절대 경로가 아니거나, 경로 형식이 틀리거나
 * (`isProjectRelativePath`), 푼 경로가 루트 밖이거나 루트 자체면 `null`.
 */
export const resolveProjectFile = (
  root: string,
  file: string,
  pathApi: path.PlatformPath = path,
): string | null => {
  if (!pathApi.isAbsolute(root) || !isProjectRelativePath(file)) return null;
  const base = pathApi.resolve(root);
  const resolved = pathApi.resolve(base, ...file.split('/'));
  const relative = pathApi.relative(base, resolved);
  if (relative === '' || relative.startsWith('..') || pathApi.isAbsolute(relative)) return null;
  return resolved;
};

/** 경로 조각 하나를 URL에 넣을 수 있게 바꾼다. Windows 드라이브(`C:`)는 그대로 둔다. */
const encodeSegment = (segment: string, index: number): string =>
  index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment);

/**
 * VS Code 파일 URL `vscode://file/{절대 경로}:{줄}` (ADR-018 기본값). 경로 구분자는 `/`로 바꾸고 조각마다 퍼센트
 * 인코딩한다(`#` · `?` · `%` · 공백 · 한글이 URL 구조를 깨지 않게). Windows 경로(`C:\a`)는 `/C:/a`가 된다.
 */
export const vscodeFileUrl: IdeUrlBuilder = (absolutePath, line) => {
  if (!Number.isSafeInteger(line) || line < 1) throw new RangeError(`줄 번호가 아닙니다: ${line}`);
  const slashed = absolutePath.replaceAll('\\', '/');
  const rooted = slashed.startsWith('/') ? slashed : `/${slashed}`;
  const encoded = rooted.split('/').map(encodeSegment).join('/');
  return `vscode://file${encoded}:${String(line)}`;
};

/** 여는 곳에 넘기기 전 확인: 고정 스킴(`IDE_URL_SCHEMES`)의 URL만. 아니면 예외. */
export const assertIdeUrl = (url: string): void => {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error('IDE URL 형식이 아닙니다');
  }
  if (!(IDE_URL_SCHEMES as readonly string[]).includes(protocol)) {
    throw new Error(`허용하지 않는 URL 스킴: ${protocol}`);
  }
};
