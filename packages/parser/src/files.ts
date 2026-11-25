// 분석 대상 소스 파일 목록 (M3-02 #47, ADR-125 ①).
// - 모듈을 "푸는" 일이 아니라 폴더를 훑어 파일 이름을 모으는 일이다(import 해석은 dependency-cruiser가 한다, ADR-033)
// - 경로는 프로젝트 루트 기준 상대 경로, 구분자 `/`, 디스크의 이름 그대로(대소문자 · 유니코드를 바꾸지 않음). `./` · 빈 구간이 없다
// - 기호 링크는 파일이든 폴더든 따라가지 않는다(프로젝트 밖을 가리킬 수 있다). 건너뛴 자리는 dependency-cruiser에도 제외로 넘긴다
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { ParserError } from './errors.js';
import { PARSER_LIMITS } from './limits.js';

/** 소스로 보는 확장자 (`.d.ts` · `.d.mts` · `.d.cts`도 끝이 같아 들어간다). dependency-cruiser가 읽는 확장자 가운데 JS · TS 계열. */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** 어느 깊이에서든 건너뛰는 폴더 이름 */
const SKIP_ANYWHERE = new Set(['node_modules']);
/** 프로젝트 루트 바로 아래에서만 건너뛰는 폴더 (git · Next.js 빌드 산출물 · BIVE 인수 테스트) */
const SKIP_AT_ROOT = new Set(['.git', '.next', 'bive-acceptance']);

export interface SourceFileList {
  /** 프로젝트 폴더의 실제 경로 */
  root: string;
  /** 소스 파일 (정렬) */
  files: string[];
  /** 건너뛴 자리 가운데 `node_modules`가 아닌 것 (루트 제외 폴더 · 기호 링크, 정렬) */
  skipped: string[];
}

const isSource = (name: string): boolean => SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));

const checkLength = (rel: string): void => {
  if (rel.length > PARSER_LIMITS.maxPathLength) {
    throw new ParserError(
      'path_too_long',
      `경로가 ${String(PARSER_LIMITS.maxPathLength)}자를 넘습니다 (${String(rel.length)}자)`,
    );
  }
};

/** 프로젝트 폴더의 소스 파일을 모은다. */
export const listSourceFiles = (projectDir: string): SourceFileList => {
  let root: string;
  try {
    root = realpathSync(projectDir);
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new ParserError('project_not_found', '프로젝트 폴더를 찾지 못했습니다');
  }
  const files: string[] = [];
  const skipped: string[] = [];
  const walk = (rel: string): void => {
    const entries = readdirSync(rel === '' ? root : path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      checkLength(child);
      if (entry.isSymbolicLink()) {
        skipped.push(child);
      } else if (entry.isDirectory()) {
        if (SKIP_ANYWHERE.has(entry.name)) continue;
        if (rel === '' && SKIP_AT_ROOT.has(entry.name)) {
          skipped.push(child);
          continue;
        }
        walk(child);
      } else if (entry.isFile() && isSource(entry.name)) {
        files.push(child);
        if (files.length > PARSER_LIMITS.maxFiles) {
          throw new ParserError(
            'too_many_files',
            `소스 파일이 ${String(PARSER_LIMITS.maxFiles)}개를 넘습니다`,
          );
        }
      }
    }
  };
  walk('');
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return { root, files: files.sort(order), skipped: skipped.sort(order) };
};
