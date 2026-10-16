// 파일 도구 (읽기 · 쓰기 · 목록 · 검색, ADR-024 · ADR-052). 경로는 모두 PathGuard를 거치고,
// 목록 · 검색은 심볼릭 링크를 따라가지 않으며 순회 항목마다 같은 가드(`allowsEntry`)를 통과시킨다.
// 일반 파일만 읽는다(FIFO · 장치 파일은 열지 않음). 쓰기는 임시 파일 + rename이라 기존 하드 링크를 타지 않는다.
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
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
/** FIFO를 열어도 막히지 않게 (Windows에는 없는 플래그) */
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

const isErrno = (error: unknown, ...codes: string[]): boolean =>
  error instanceof Error && 'code' in error && codes.includes(String(error.code));

type RegularRead =
  | { kind: 'ok'; buffer: Buffer }
  | { kind: 'not_found' | 'not_a_file' }
  | { kind: 'too_large'; size: number };

/**
 * 일반 파일만 읽는다. 연 뒤의 핸들로 종류 · 크기를 확인하므로 확인과 읽기 사이에 파일이 바뀌어도
 * FIFO에서 막히거나 상한을 넘겨 읽지 않는다.
 */
const readRegular = async (absolute: string): Promise<RegularRead> => {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absolute, fsConstants.O_RDONLY | O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return { kind: 'not_found' };
    if (isErrno(error, 'EISDIR', 'ENXIO', 'EAGAIN')) return { kind: 'not_a_file' };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: 'not_a_file' };
    if (stat.size > MAX_FILE_BYTES) return { kind: 'too_large', size: stat.size };
    return { kind: 'ok', buffer: await handle.readFile() };
  } finally {
    await handle.close();
  }
};

export const readFile = async (
  guard: PathGuard,
  args: z.infer<typeof ReadFileInput>,
): Promise<ToolResult> => {
  const checked = guard.check(args.path, 'read');
  if (!checked.ok) return denied('path_denied', checked.detail);
  const read = await readRegular(checked.realPath);
  switch (read.kind) {
    case 'ok':
      return ok(read.buffer.toString('utf8'));
    case 'not_found':
      return failed('not_found', `파일 없음: ${checked.relPath}`);
    case 'not_a_file':
      return failed('not_a_file', `일반 파일이 아님: ${checked.relPath}`);
    case 'too_large':
      return failed('too_large', `파일이 너무 큼 (${read.size}바이트, 상한 ${MAX_FILE_BYTES})`);
  }
};

export const writeFile = async (
  guard: PathGuard,
  args: z.infer<typeof WriteFileInput>,
): Promise<ToolResult> => {
  const checked = guard.check(args.path, 'write');
  if (!checked.ok) return denied('path_denied', checked.detail);
  if (checked.relPath === '.') return denied('path_denied', '세션 루트에는 쓸 수 없음');
  const target = checked.realPath;
  const stat = await fs.lstat(target).catch(() => null);
  if (stat !== null && !stat.isFile()) {
    return failed('not_a_file', `일반 파일이 아님: ${checked.relPath}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  // 같은 폴더의 임시 파일에 쓰고 rename으로 바꾼다: 기존 inode(하드 링크 · FIFO)에 쓰지 않는다
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.bive-${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await fs.writeFile(temp, args.content, { encoding: 'utf8', flag: 'wx', mode: 0o666 });
    if (stat !== null) await fs.chmod(temp, stat.mode & 0o777);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return ok(`${checked.relPath}에 ${Buffer.byteLength(args.content, 'utf8')}바이트 기록`);
};

interface WalkEntry {
  rel: string;
  absolute: string;
  kind: 'file' | 'dir' | 'link';
}

/**
 * `start` 아래를 순회한다. 링크는 항목으로만 알리고 따라가지 않으며(`link`), 일반 파일 · 폴더 · 링크가
 * 아닌 항목(FIFO · 소켓 · 장치)은 건너뛴다. 항목마다 `guard.allowsEntry`를 통과해야 하고 금지 폴더로는
 * 내려가지 않는다. `visit`가 false를 돌려주면 멈춘다.
 */
const walk = async (
  guard: PathGuard,
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
      const kind = entry.isSymbolicLink()
        ? 'link'
        : entry.isDirectory()
          ? 'dir'
          : entry.isFile()
            ? 'file'
            : null;
      if (kind === null) continue;
      const absolute = path.join(dir, entry.name);
      if (!guard.allowsEntry(absolute, kind)) continue;
      const rel = path.relative(guard.root, absolute).split(path.sep).join('/');
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
  await walk(guard, checked.realPath, args.recursive ?? false, ({ rel, kind }) => {
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
    const read = await readRegular(absolute);
    if (read.kind !== 'ok' || read.buffer.includes(0)) return true; // 일반 파일 아님 · 큼 · 바이너리
    const lines = read.buffer.toString('utf8').split(/\r?\n/u);
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
  } else if (stat.isDirectory()) {
    await walk(guard, checked.realPath, true, ({ rel, absolute, kind }) =>
      kind === 'file' ? searchOne(absolute, rel) : true,
    );
  } else {
    return failed('not_a_file', `일반 파일 · 폴더가 아님: ${checked.relPath}`);
  }
  if (truncated) matches.push(`… 결과가 많아 ${MAX_SEARCH_MATCHES}줄까지만 표시`);
  return ok(matches.length > 0 ? matches.join('\n') : '(일치 없음)');
};
