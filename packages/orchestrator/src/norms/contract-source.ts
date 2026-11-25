// 계약 원본 파일 읽기 (NRM-03, M3-04 #49 · ADR-129 ④, M3-47 #292 · ADR-132).
// 작업 트리 · 실행 워크트리가 아니라 git 객체에서 읽는다(`--no-replace-objects`, 셸 없는 git 실행기). 일반 파일만, 크기 상한,
// UTF-8 글만. 등록(`norms/contract.ts`)은 기준 브랜치 커밋에서, 계약 검사(`steps/contract-check.ts`)는 등록 때 기록한 커밋에서 읽는다.
// 이 모듈은 읽기만 한다: 계약 · 규칙 · 기록을 쓰지 않는다(쓰는 곳은 `norms/contract.ts` 하나, 구조 시험).
import { createHash } from 'node:crypto';

import type { ContractInvalidCode } from '@bive/shared';

import { createGitRunner, type GitRunner } from '../git/git-exec.js';

/** 계약 원본 파일 크기 상한 (바이트). */
export const CONTRACT_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

/** 기준 브랜치 커밋에서 읽은 계약 원본. */
export interface ContractSource {
  readonly commit: string;
  readonly contentHash: string;
}

export type ContractSourceRead =
  | ({ readonly ok: true } & ContractSource)
  | { readonly ok: false; readonly code: ContractInvalidCode };

/** 커밋 하나에서 읽은 계약 원본 내용. */
export type ContractBlobRead =
  | { readonly ok: true; readonly text: string; readonly contentHash: string }
  | { readonly ok: false; readonly code: ContractInvalidCode };

/** 디코드가 손실이면 생기는 대체 문자 U+FFFD (원문에 있어도 손실과 구별할 수 없어 거부한다). */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** git 커밋 객체 이름의 형식 (SHA-1 40자 · SHA-256 64자, 소문자 16진). */
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 커밋 `commit`의 계약 원본을 git 객체에서 읽는다. `file`은 등록 검사(`contractFileProblem`)를 지난 경로여야 한다(glob 글자가 없어
 * `ls-tree`의 경로가 글자 그대로 맞는다). 커밋 이름이 형식이 아니거나 읽지 못하면 `base_unreadable`, 그 밖은
 * {@link readContractSource}와 같다.
 */
export const readContractBlob = async (
  repoPath: string,
  commit: string,
  file: string,
  git: GitRunner = createGitRunner(),
): Promise<ContractBlobRead> => {
  if (!COMMIT_PATTERN.test(commit)) return { ok: false, code: 'base_unreadable' };
  let listing: string;
  try {
    listing = (
      await git(['--no-replace-objects', 'ls-tree', '-z', '-l', commit, '--', file], {
        cwd: repoPath,
      })
    ).stdout;
  } catch {
    return { ok: false, code: 'base_unreadable' };
  }
  // `<모드> <종류> <객체> <크기>\t<경로>`: 경로가 글자 그대로 같은 항목만
  const entry = listing
    .split('\0')
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab < 0 ? null : { head: line.slice(0, tab).split(/ +/u), path: line.slice(tab + 1) };
    })
    .find((item) => item !== null && item.path === file);
  if (entry === undefined || entry === null) return { ok: false, code: 'file_missing' };
  const [mode, type, object, size] = entry.head;
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || object === undefined) {
    return { ok: false, code: 'not_regular_file' };
  }
  // 크기를 읽지 못하면(숫자가 아님) 상한 초과로 본다 (닫힌 쪽)
  if (!(Number(size) <= CONTRACT_SOURCE_MAX_BYTES)) return { ok: false, code: 'too_large' };
  let text: string;
  try {
    text = (await git(['--no-replace-objects', 'cat-file', 'blob', object], { cwd: repoPath }))
      .stdout;
  } catch {
    return { ok: false, code: 'base_unreadable' };
  }
  if (text.includes(REPLACEMENT_CHARACTER)) return { ok: false, code: 'not_text' };
  return { ok: true, text, contentHash: sha256(text) };
};

/**
 * 기준 브랜치 커밋의 계약 원본을 git 객체에서 읽는다 (작업 트리 · 워크트리는 읽지 않는다). 대체 객체(`refs/replace`)는 따르지 않는다.
 * - 브랜치 · 커밋을 읽지 못함(git 저장소가 아님 등) → `base_unreadable`, 파일 없음 → `file_missing`
 * - 일반 파일(모드 100644 · 100755)이 아님(기호 링크 · 디렉터리 · 하위 모듈) → `not_regular_file`
 * - 상한 초과 → `too_large`(내용을 읽지 않는다), UTF-8 글이 아님(디코드에 대체 문자 U+FFFD가 생기거나 원래 있음) → `not_text`
 * 해시는 그 바이트의 SHA-256이다(UTF-8 디코드는 잘못된 바이트를 대체 문자로만 바꾸므로, 대체 문자가 없으면 디코드가 손실 없고 다시
 * 부호화한 바이트가 원래 바이트와 같다).
 */
export const readContractSource = async (
  repoPath: string,
  baseBranch: string,
  file: string,
  git: GitRunner = createGitRunner(),
): Promise<ContractSourceRead> => {
  let commit: string;
  try {
    commit = (
      await git(
        [
          '--no-replace-objects',
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${baseBranch}^{commit}`,
        ],
        { cwd: repoPath },
      )
    ).stdout.trim();
  } catch {
    return { ok: false, code: 'base_unreadable' };
  }
  const read = await readContractBlob(repoPath, commit, file, git);
  return read.ok ? { ok: true, commit, contentHash: read.contentHash } : read;
};
