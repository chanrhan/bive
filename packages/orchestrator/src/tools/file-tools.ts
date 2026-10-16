// 파일 도구 (읽기 · 쓰기 · 목록 · 검색, ADR-024). 경로는 모두 PathGuard를 거치고,
// 목록 · 검색은 심볼릭 링크를 따라가지 않으며 `.git` · `.bive.json`을 건너뛴다.
import fs from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

import type { ToolResult } from '../agent/adapter.js';
import {
  type ListFilesInput,
  MAX_FILE_BYTES,
  type ReadFileInput,
  type SearchFilesInput,
  type WriteFileInput,
} from './definitions.js';
import { PathGuard } from './path-guard.js';
import { denied, failed, ok } from './result.js';

/** 목록 항목 상한 */
export const MAX_LIST_ENTRIES = 2000;
/** 검색 결과 줄 상한 */
export const MAX_SEARCH_MATCHES = 200;
/** 검색 결과 한 줄 길이 상한 */
const MAX_MATCH_LINE = 300;
/** 목록 · 검색이 내려가지 않는 폴더 (읽기는 허용, 크기 때문에 순회만 생략) */
const SKIPPED_DIRS = new Set(['node_modules']);

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export const readFile = async (
  guard: PathGuard,
  args: z.infer<typeof ReadFileInput>,
): Promise<ToolResult> => {
  const checked = guard.check(args.path, 'read');
  if (!checked.ok) return denied('path_denied', checked.detail);
  const stat = await fs.stat(checked.realPath).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
    throw error;
  });
  if (stat === null) return failed('not_found', `파일 없음: ${checked.relPath}`);
  if (!stat.isFile()) return failed('not_a_file', `파일이 아님: ${checked.relPath}`);
  if (stat.size > MAX_FILE_BYTES) {
    return failed('too_large', `파일이 너무 큼 (${stat.size}바이트, 상한 ${MAX_FILE_BYTES})`);
  }
  return ok(await fs.readFile(checked.realPath, 'utf8'));
};

export const writeFile = async (
  guard: PathGuard,
  args: z.infer<typeof WriteFileInput>,
): Promise<ToolResult> => {
  const checked = guard.check(args.path, 'write');
  if (!checked.ok) return denied('path_denied', checked.detail);
  if (checked.relPath === '.') return denied('path_denied', '세션 루트에는 쓸 수 없음');
  const stat = await fs.lstat(checked.realPath).catch(() => null);
  if (stat?.isDirectory()) return failed('not_a_file', `폴더임: ${checked.relPath}`);
  await fs.mkdir(path.dirname(checked.realPath), { recursive: true });
  // 실경로에 쓴다: 검사한 경로와 쓰는 경로가 같다
  await fs.writeFile(checked.realPath, args.content, 'utf8');
  return ok(`${checked.relPath}에 ${Buffer.byteLength(args.content, 'utf8')}바이트 기록`);
};

interface WalkEntry {
  rel: string;
  absolute: string;
  kind: 'file' | 'dir' | 'link';
}

/**
 * `start` 아래를 순회한다. 링크는 항목으로만 알리고 따라가지 않으며(`link`),
 * 금지 이름은 아예 건너뛴다. `visit`가 false를 돌려주면 멈춘다.
 */
const walk = async (
  root: string,
  start: string,
  recursive: boolean,
  visit: (entry: WalkEntry) => boolean | Promise<boolean>,
): Promise<void> => {
  const queue = [start];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (PathGuard.isForbiddenName(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file';
      if (!(await visit({ rel, absolute, kind }))) return;
      if (kind === 'dir' && recursive && !SKIPPED_DIRS.has(entry.name)) queue.push(absolute);
    }
  }
};

export const listFiles = async (
  guard: PathGuard,
  args: z.infer<typeof ListFilesInput>,
): Promise<ToolResult> => {
  const checked = guard.check(args.path ?? '.', 'read');
  if (!checked.ok) return denied('path_denied', checked.detail);
  const stat = await fs.stat(checked.realPath).catch(() => null);
  if (stat === null) return failed('not_found', `폴더 없음: ${checked.relPath}`);
  if (!stat.isDirectory()) return failed('not_a_directory', `폴더가 아님: ${checked.relPath}`);
  const lines: string[] = [];
  let truncated = false;
  await walk(guard.root, checked.realPath, args.recursive ?? false, ({ rel, kind }) => {
    if (lines.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return false;
    }
    lines.push(kind === 'dir' ? `${rel}/` : kind === 'link' ? `${rel} (링크)` : rel);
    return true;
  });
  if (truncated) lines.push(`… 항목이 많아 ${MAX_LIST_ENTRIES}개까지만 표시`);
  return ok(lines.length > 0 ? lines.join('\n') : '(빈 폴더)');
};

export const searchFiles = async (
  guard: PathGuard,
  args: z.infer<typeof SearchFilesInput>,
): Promise<ToolResult> => {
  const checked = guard.check(args.path ?? '.', 'read');
  if (!checked.ok) return denied('path_denied', checked.detail);
  const stat = await fs.stat(checked.realPath).catch(() => null);
  if (stat === null) return failed('not_found', `경로 없음: ${checked.relPath}`);
  const matches: string[] = [];
  let truncated = false;
  const searchOne = async (absolute: string, rel: string): Promise<boolean> => {
    const info = await fs.stat(absolute);
    if (info.size > MAX_FILE_BYTES) return true;
    const buffer = await fs.readFile(absolute);
    if (buffer.includes(0)) return true; // 바이너리
    const lines = buffer.toString('utf8').split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (!line.includes(args.query)) continue;
      if (matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        return false;
      }
      matches.push(`${rel}:${index + 1}: ${line.slice(0, MAX_MATCH_LINE)}`);
    }
    return true;
  };
  if (stat.isFile()) {
    await searchOne(checked.realPath, checked.relPath);
  } else {
    await walk(guard.root, checked.realPath, true, ({ rel, absolute, kind }) =>
      kind === 'file' ? searchOne(absolute, rel) : true,
    );
  }
  if (truncated) matches.push(`… 결과가 많아 ${MAX_SEARCH_MATCHES}줄까지만 표시`);
  return ok(matches.length > 0 ? matches.join('\n') : '(일치 없음)');
};
