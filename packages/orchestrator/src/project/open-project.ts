// 프로젝트 폴더 열기 (PRJ-01, SCR-01, ADR-025 · ADR-036 · ADR-040 · ADR-054).
// - 루트 `.bive.json`이 없으면 새 프로젝트 ID로 저장소에 등록한 뒤 파일(`projectId` · `schemaVersion`만)을 만든다
// - 있으면 그 ID로 진입한다. 파일은 다시 쓰지 않는다(수정 시각 유지). 등록부에 없으면 다시 등록한다(ADR-040)
// - 폴더 · 설정 파일 검사는 모두 동기 호출이다. 오케스트레이터는 한 스레드라 같은 폴더를 두 요청이 동시에 열어도
//   검사와 쓰기 사이에 다른 요청이 끼어들지 않는다
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  ErrorCode,
  type Project,
  PROJECT_FILE_NAME,
  PROJECT_FILE_SCHEMA_VERSION,
  ProjectFile,
  type ProjectOpenResult,
  type Ulid,
} from '@bive/shared';
import {
  NotFoundError,
  openProjectStore,
  openRegistry,
  registerProject,
  unregisterProject,
} from '@bive/store';

import { RpcError } from '../ipc/server.js';

/** git 정보가 없을 때의 기준 브랜치 이름. */
export const DEFAULT_BASE_BRANCH = 'main';

export interface OpenProjectDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 새 프로젝트 ID */
  newId: () => Ulid;
  /** ISO 8601 UTC 시각 (등록 시각 · 생성 시각) */
  timestamp: () => string;
}

const errnoCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

const validation = (message: string): RpcError => new RpcError(ErrorCode.ValidationFailed, message);

const realpathOrResolved = (target: string): string => {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

/** `child`가 `parent`와 같거나 그 아래인지 (둘 다 절대 경로). */
const isSameOrInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  // `..이름` 같은 하위 폴더 이름은 상위로 보지 않는다
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !outside && !path.isAbsolute(relative);
};

/**
 * 경로를 검사해 실경로(심볼릭 링크 해석)를 돌려준다.
 * 절대 경로 아님 -32602 · 없음 -32004 · 폴더 아님 · 접근 불가 -32001.
 * `$BIVE_HOME`과 같거나 그 아래 · 그 상위인 폴더도 -32001이다. 저장소가 프로젝트 폴더 안에 들어가거나
 * 저장소 안에 설정 파일이 생기면 "프로젝트 폴더 밖 저장소" 전제가 깨진다 (ADR-005 · ADR-025 · NFR-01).
 * 오류 메시지에는 경로를 싣지 않는다.
 */
export const resolveProjectRoot = (input: string, biveHome: string): string => {
  // 프로토콜 스키마가 이미 막지만, 처리기를 직접 부르는 경로도 같은 기준을 지키게 한다
  if (!path.isAbsolute(input)) {
    throw new RpcError(ErrorCode.InvalidParams, '절대 경로가 아닙니다');
  }
  let root: string;
  try {
    root = realpathSync(input);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RpcError(ErrorCode.NotFound, '폴더를 찾을 수 없습니다');
    }
    throw validation('폴더에 접근할 수 없습니다');
  }
  if (!statSync(root).isDirectory()) throw validation('폴더가 아닙니다');
  const home = realpathOrResolved(biveHome);
  if (isSameOrInside(home, root) || isSameOrInside(root, home)) {
    throw validation('저장소와 겹치는 폴더');
  }
  return root;
};

/**
 * 폴더 안 `.bive.json`을 읽는다. 없으면 null.
 * 일반 파일이 아니거나(폴더 · 심볼릭 링크) JSON · 스키마가 틀리거나 지원하지 않는 버전이면 -32001.
 * 형식이 틀린 파일은 고치거나 덮어쓰지 않는다(사람이 확인한다).
 */
export const readProjectFile = (root: string): ProjectFile | null => {
  const file = path.join(root, PROJECT_FILE_NAME);
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw validation('설정 파일에 접근할 수 없습니다');
  }
  if (!stat.isFile()) throw validation('설정 파일이 일반 파일이 아닙니다');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw validation('설정 파일 형식 오류');
  }
  const parsed = ProjectFile.safeParse(raw);
  if (!parsed.success) throw validation('설정 파일 형식 오류');
  if (parsed.data.schemaVersion > PROJECT_FILE_SCHEMA_VERSION) {
    throw validation('지원하지 않는 설정 파일 버전');
  }
  return parsed.data;
};

/** `.bive.json` 내용: 두 키만, 2칸 들여쓰기, 끝 개행. */
export const formatProjectFile = (projectId: Ulid): string =>
  `${JSON.stringify({ projectId, schemaVersion: PROJECT_FILE_SCHEMA_VERSION } satisfies ProjectFile, null, 2)}\n`;

/** `.bive.json` 말고는 항목이 없는 폴더인지. */
export const isEmptyFolder = (root: string): boolean =>
  readdirSync(root).every((name) => name === PROJECT_FILE_NAME);

const readTextOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * 기준 브랜치: git 저장소면 HEAD가 가리키는 브랜치, 아니거나 HEAD가 브랜치가 아니면 `main`.
 * git을 실행하지 않고 `.git/HEAD`(워크트리는 `.git` 파일의 `gitdir:`)만 읽는다.
 */
export const detectBaseBranch = (root: string): string => {
  const dotGit = path.join(root, '.git');
  let gitDir: string | null = null;
  try {
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit;
    } else {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readTextOrNull(dotGit) ?? '');
      if (pointer?.[1] !== undefined) gitDir = path.resolve(root, pointer[1]);
    }
  } catch {
    return DEFAULT_BASE_BRANCH;
  }
  if (gitDir === null) return DEFAULT_BASE_BRANCH;
  const head = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(
    readTextOrNull(path.join(gitDir, 'HEAD')) ?? '',
  );
  return head?.[1] ?? DEFAULT_BASE_BRANCH;
};

/** 등록부에 있는 프로젝트인지. 등록부 파일이 없으면 등록된 프로젝트가 없는 것이다. */
const isRegistered = (biveHome: string, projectId: Ulid): boolean => {
  let registry;
  try {
    registry = openRegistry({ home: biveHome, create: false });
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
  try {
    return registry.entries.get(projectId) !== null;
  } finally {
    registry.close();
  }
};

/** 프로젝트별 DB의 프로젝트 행. DB나 행이 없으면 null (DB를 새로 만들지 않는다). */
const readStoredProject = (biveHome: string, projectId: Ulid): Project | null => {
  let store;
  try {
    store = openProjectStore(projectId, { home: biveHome, create: false });
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  try {
    return store.getProject();
  } finally {
    store.close();
  }
};

/** 같은 프로젝트 ID가 다른 폴더에 등록돼 있으면 -32009 (복사한 폴더가 같은 저장소를 쓰지 않게, NFR-01). */
const assertSameRoot = (project: Project, root: string): void => {
  if (project.rootPath !== root) {
    throw new RpcError(ErrorCode.StateConflict, '다른 경로에 등록된 프로젝트의 설정 파일입니다');
  }
};

/** 설정 파일이 있는 폴더: 그 ID로 진입한다. 등록부에 없으면 다시 등록한다. 파일은 건드리지 않는다. */
const enterLinkedFolder = (root: string, file: ProjectFile, deps: OpenProjectDeps): Project => {
  const { biveHome } = deps;
  const stored = readStoredProject(biveHome, file.projectId);
  if (isRegistered(biveHome, file.projectId)) {
    // 등록부에 있는데 프로젝트별 DB · 행이 없으면 저장소 손상이다. 숨기지 않는다 (ADR-040)
    if (stored === null) throw new NotFoundError('프로젝트 행', file.projectId);
    assertSameRoot(stored, root);
    return stored;
  }
  if (stored !== null) {
    // 등록 해제됐거나 등록부 추가 전에 멈춘 프로젝트: 저장된 행 그대로 등록부에 다시 넣는다(규범 · 기록 보존)
    assertSameRoot(stored, root);
    return registerProject(stored, { home: biveHome, now: deps.timestamp });
  }
  // 다른 BIVE_HOME에서 만든 설정 파일 등: 그 ID로 새 저장소를 만든다
  return registerProject(
    {
      id: file.projectId,
      name: path.basename(root),
      rootPath: root,
      baseBranch: detectBaseBranch(root),
      createdAt: deps.timestamp(),
    },
    { home: biveHome, now: deps.timestamp },
  );
};

/** 미연결 폴더: 새 ID로 등록한 뒤 `.bive.json`을 만든다. 파일을 못 만들면 등록을 되돌린다. */
const linkNewFolder = (root: string, deps: OpenProjectDeps): Project => {
  const { biveHome } = deps;
  const project = registerProject(
    {
      id: deps.newId(),
      name: path.basename(root),
      rootPath: root,
      baseBranch: detectBaseBranch(root),
      createdAt: deps.timestamp(),
    },
    { home: biveHome, now: deps.timestamp },
  );
  try {
    // `wx`: 이미 있으면 실패한다. 다른 프로세스가 그 사이에 만든 파일을 덮어쓰지 않는다
    writeFileSync(path.join(root, PROJECT_FILE_NAME), formatProjectFile(project.id), {
      flag: 'wx',
      mode: 0o644,
    });
  } catch (error) {
    // 등록부 항목만 지운다. 비어 있는 프로젝트별 DB는 남는다(ADR-040: 등록 해제는 등록부만)
    unregisterProject(project.id, { home: biveHome });
    if (errnoCode(error) === 'EEXIST') {
      throw new RpcError(ErrorCode.StateConflict, '설정 파일이 이미 생겼습니다');
    }
    throw validation('설정 파일을 쓸 수 없습니다');
  }
  return project;
};

/**
 * 폴더를 연다. 오류는 `RpcError` 또는 저장소 오류로 던진다(처리기가 IPC 오류로 바꾼다).
 */
export const openProjectFolder = (input: string, deps: OpenProjectDeps): ProjectOpenResult => {
  const root = resolveProjectRoot(input, deps.biveHome);
  const file = readProjectFile(root);
  const empty = isEmptyFolder(root);
  if (file !== null) {
    return { project: enterLinkedFolder(root, file, deps), created: false, empty };
  }
  return { project: linkNewFolder(root, deps), created: true, empty };
};
