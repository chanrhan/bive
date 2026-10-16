// 파일 도구 경로 가드 (NFR-01 · NFR-02 · ADR-024 · ADR-052). OS 샌드박스에 의존하지 않고 BIVE 코드에서 거부한다.
// 모든 경로를 세션 루트 기준으로 정규화한 뒤, 글자 그대로의 경로와 심볼릭 링크를 따라간 실경로 둘 다 검사한다.
// - 세션 루트 밖 · `$BIVE_HOME/projects` · `$BIVE_HOME/run` · `.git` · `.bive.json` 거부 (읽기 · 쓰기 모두)
// - 중간 경로의 링크 · 대상이 없는 링크(쓰면 루트 밖에 생길 수 있음) 거부
// - 역할별 쓰기 금지: implementer는 `bive-acceptance/**`, test-writer는 `bive-acceptance/**` 밖 전부
import fs from 'node:fs';
import path from 'node:path';

import type { AgentRole } from '@bive/shared';

/** 인수 테스트 디렉터리 (ADR-026). */
export const ACCEPTANCE_DIR = 'bive-acceptance';
/** 어느 역할도 읽거나 쓸 수 없는 경로 구성 요소. */
export const FORBIDDEN_SEGMENTS = ['.git', '.bive.json'] as const;
/** `$BIVE_HOME` 아래 에이전트 접근 불가 폴더 (architecture.md 3장 저장소 배치). */
export const FORBIDDEN_HOME_DIRS = ['projects', 'run'] as const;

export type PathAccess = 'read' | 'write';

export type PathCheck =
  | {
      ok: true;
      /** 링크를 따라간 실제 절대 경로 (쓰기 대상이 없으면 존재하는 상위의 실경로 + 나머지) */
      realPath: string;
      /** 세션 루트(실경로) 기준 상대 경로, `/` 구분. 루트 자체는 `.` */
      relPath: string;
    }
  | { ok: false; detail: string };

export interface PathGuardOptions {
  role: AgentRole;
  /** 세션 루트 (implementer = 실행 워크트리, test-writer = 세션 디렉터리) */
  sessionRoot: string;
  biveHome: string;
}

/** `a`가 `b`와 같거나 그 아래인지 (둘 다 절대 · 정규화된 경로). */
export const isWithin = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * 비교용 이름. 대소문자를 구분하지 않는 파일 시스템(macOS · Windows)과
 * 끝의 점 · 공백을 버리는 Windows에서도 `.GIT` · `.git.`을 `.git`으로 본다.
 */
const fold = (segment: string): string => segment.toLowerCase().replace(/[. ]+$/u, '');

const toSegments = (rel: string): string[] =>
  rel.split(/[\\/]+/u).filter((s) => s !== '' && s !== '.');

const isErrno = (error: unknown, ...codes: string[]): boolean =>
  error instanceof Error && 'code' in error && codes.includes(String(error.code));

/**
 * 링크를 따라간 실경로. 경로 끝이 아직 없으면 존재하는 가장 가까운 상위의 실경로에 나머지를 붙인다.
 * 대상이 없는 링크가 중간 · 끝에 있으면 어디를 가리킬지 확정할 수 없으므로 `null`.
 */
export const resolveReal = (absolute: string): string | null => {
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch (error) {
      if (!isErrno(error, 'ENOENT', 'ENOTDIR')) throw error;
    }
    try {
      fs.lstatSync(current);
      // lstat은 되는데 realpath가 안 됨 = 대상 없는 링크
      return null;
    } catch (error) {
      if (!isErrno(error, 'ENOENT', 'ENOTDIR')) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    rest.push(path.basename(current));
    current = parent;
  }
};

export class PathGuard {
  readonly role: AgentRole;
  /** 세션 루트 실경로 */
  readonly root: string;
  private readonly forbiddenRoots: string[];

  constructor(options: PathGuardOptions) {
    this.role = options.role;
    const root = resolveReal(path.resolve(options.sessionRoot));
    if (root === null || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`세션 루트가 폴더가 아님: ${options.sessionRoot}`);
    }
    this.root = root;
    const home = path.resolve(options.biveHome);
    this.forbiddenRoots = FORBIDDEN_HOME_DIRS.flatMap((dir) => {
      const lexical = path.join(home, dir);
      const real = resolveReal(lexical);
      return real === null || real === lexical ? [lexical] : [lexical, real];
    });
  }

  /** 도구 인자의 경로를 검사한다. 거부 사유는 모델에게 그대로 돌려준다. */
  check(input: string, access: PathAccess): PathCheck {
    if (input.length === 0 || input.includes('\0')) return deny('경로 형식 오류');
    const lexical = path.resolve(this.root, input);
    if (!isWithin(lexical, this.root)) return deny('세션 루트 밖 경로');
    const lexicalCheck = this.checkRelative(path.relative(this.root, lexical), access);
    if (lexicalCheck !== null) return deny(lexicalCheck);

    const real = resolveReal(lexical);
    if (real === null) return deny('대상이 없는 심볼릭 링크');
    if (!isWithin(real, this.root)) return deny('심볼릭 링크가 세션 루트 밖을 가리킴');
    const realRel = path.relative(this.root, real);
    const realCheck = this.checkRelative(realRel, access);
    if (realCheck !== null) return deny(realCheck);
    if (this.forbiddenRoots.some((dir) => isWithin(real, dir) || isWithin(lexical, dir))) {
      return deny('BIVE 저장소 경로');
    }
    return { ok: true, realPath: real, relPath: toSegments(realRel).join('/') || '.' };
  }

  /** 디렉터리 순회 중 이름만으로 건너뛸 항목인지 (`.git` · `.bive.json`). */
  static isForbiddenName(name: string): boolean {
    const folded = fold(name);
    return FORBIDDEN_SEGMENTS.some((segment) => folded === segment);
  }

  /** 루트 기준 상대 경로의 구성 요소 · 역할 규칙. 위반이면 사유, 아니면 `null`. */
  private checkRelative(rel: string, access: PathAccess): string | null {
    const segments = toSegments(rel).map(fold);
    for (const forbidden of FORBIDDEN_SEGMENTS) {
      if (segments.includes(forbidden)) return `${forbidden} 접근 불가`;
    }
    if (access !== 'write') return null;
    const inAcceptance = segments[0] === ACCEPTANCE_DIR;
    if (this.role === 'test-writer') {
      // 세션 디렉터리의 인수 테스트 폴더 아래 파일만 쓸 수 있다
      if (!inAcceptance || segments.length < 2) return `${ACCEPTANCE_DIR} 폴더 밖 쓰기 불가`;
      return null;
    }
    if (this.role === 'implementer') {
      if (inAcceptance) return '인수 테스트 쓰기 불가';
      return null;
    }
    return '이 역할은 파일 쓰기 불가';
  }
}

const deny = (detail: string): PathCheck => ({ ok: false, detail });
