// 코드 열기의 IDE URL 만들기 (MET-01, ADR-018 · ADR-084 · ADR-087). Electron에 의존하지 않아 단위 테스트에서 부른다.
// - 열 파일 = 프로젝트 루트 + 프로젝트 루트 기준 상대 경로. 루트 밖으로 나가면 만들지 않는다(`resolveProjectFile`).
//   파일 시스템에서 실제 경로로도 다시 본다(`resolveRealProjectFile`: 루트 안 심볼릭 링크가 밖을 가리키면 거부)
// - URL은 설정의 IDE 선택(VS Code · Cursor · 사용자 지정 틀, shared `IdeSetting`)에서만 만든다(`buildIdeUrl`).
//   `{path}`에는 절대 경로를 조각마다 퍼센트 인코딩해 넣는다(틀이 인코딩을 끌 수 없다)
// - 여는 곳(`url-opener.ts`) 바로 앞에서 `assertIdeUrl`로 허용 스킴 · 고정 호스트를 다시 확인한다
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  IDE_URL_LINE_PLACEHOLDER,
  IDE_URL_PATH_PLACEHOLDER,
  IDE_URL_TEMPLATES,
  IdeSetting,
  isAllowedIdeUrl,
  isProjectRelativePath,
} from '@bive/shared';

/**
 * 프로젝트 루트 기준 상대 경로를 절대 경로로 푼다(글자 비교만). 루트가 절대 경로가 아니거나, 경로 형식이 틀리거나
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
  return isInside(base, resolved, pathApi) ? resolved : null;
};

const isInside = (base: string, target: string, pathApi: path.PlatformPath = path): boolean => {
  const relative = pathApi.relative(base, target);
  return relative !== '' && !relative.startsWith('..') && !pathApi.isAbsolute(relative);
};

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * 실제 경로 기준으로 루트 안인지 본 뒤 절대 경로(글자 그대로 푼 값)를 돌려준다. 아니면 `null` (ADR-087).
 * - 루트의 실제 경로를 구한다(없으면 `null`)
 * - 파일이 있으면 그 실제 경로가 루트의 실제 경로 안이어야 한다(루트 안 심볼릭 링크가 밖을 가리키면 거부)
 * - 파일이 없으면 있는 가장 가까운 상위 폴더의 실제 경로로 같은 확인을 한다(없는 파일은 지금처럼 열 수 있다)
 * - 중간이든 끝이든 끊어진 심볼릭 링크(링크는 있는데 대상이 없음)는 거부
 */
export const resolveRealProjectFile = async (
  root: string,
  file: string,
): Promise<string | null> => {
  const resolved = resolveProjectFile(root, file);
  if (resolved === null) return null;
  let realRoot: string;
  try {
    realRoot = await realpath(path.resolve(root));
  } catch {
    return null;
  }
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = await realpath(current);
      const target = missing.length === 0 ? real : path.join(real, ...missing.reverse());
      return isInside(realRoot, target) ? resolved : null;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') return null;
    }
    // 대상이 없을 때: 그 자리에 링크 자체가 있으면 끊어진 링크다
    try {
      await lstat(current);
      return null;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    missing.push(path.basename(current));
    current = parent;
  }
};

/** 경로 조각 하나를 URL에 넣을 수 있게 바꾼다. Windows 드라이브(`C:`)는 그대로 둔다. */
const encodeSegment = (segment: string, index: number): string =>
  index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment);

/**
 * 절대 경로 → 틀의 `{path}` 값. 경로 구분자는 `/`로 바꾸고 조각마다 퍼센트 인코딩한다(`#` · `?` · `%` · `&` · 공백 ·
 * 한글이 URL 구조를 깨지 않게). 맨 앞의 `/` 하나는 뺀다(틀 `vscode://file/{path}:{line}`이 `/`를 가진다).
 * POSIX `/a/b` → `a/b`, Windows `C:\a` → `C:/a`, UNC `\\srv\share\a` → `/srv/share/a`.
 */
export const encodeIdePath = (absolutePath: string): string => {
  const slashed = absolutePath.replaceAll('\\', '/');
  const rooted = slashed.startsWith('/') ? slashed : `/${slashed}`;
  return rooted.split('/').map(encodeSegment).join('/').slice(1);
};

/** 선택의 URL 틀: 내장(VS Code · Cursor)은 고정 틀, 사용자 지정은 저장된 틀. */
export const ideUrlTemplate = (setting: IdeSetting): string =>
  setting.kind === 'custom' ? setting.template : IDE_URL_TEMPLATES[setting.kind];

/** 여는 곳에 넘기기 전 확인: 허용 스킴 · 고정 호스트의 URL만 (shared `isAllowedIdeUrl`). 아니면 예외. */
export const assertIdeUrl = (url: string): void => {
  if (!isAllowedIdeUrl(url)) throw new Error('허용하지 않는 IDE URL');
};

/**
 * IDE 선택 + 절대 경로 + 줄 → URL (ADR-018 · ADR-087). 선택을 다시 검증하고(`IdeSetting`, 사용자 지정 틀의 허용 범위
 * 포함), 자리 표시자를 채운 뒤 `assertIdeUrl`로 확인한다. 어느 하나라도 틀리면 예외.
 */
export const buildIdeUrl = (setting: unknown, absolutePath: string, line: number): string => {
  if (!Number.isSafeInteger(line) || line < 1) throw new RangeError(`줄 번호가 아닙니다: ${line}`);
  const checked = IdeSetting.safeParse(setting);
  if (!checked.success) throw new Error('IDE 설정이 허용 범위가 아닙니다');
  const encodedPath = encodeIdePath(absolutePath);
  const url = ideUrlTemplate(checked.data)
    .replace(IDE_URL_PATH_PLACEHOLDER, () => encodedPath)
    .replace(IDE_URL_LINE_PLACEHOLDER, () => String(line));
  assertIdeUrl(url);
  return url;
};
