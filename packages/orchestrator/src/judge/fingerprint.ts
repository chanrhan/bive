// 판정 입력 지문 (JDG-01 · NFR-01, 검토 1회차 · ADR-069).
// 판정 서버를 빌드 · 기동하는 동안(`prisma generate` · `next build` · `next start`) 에이전트가 쓴 코드(`next.config.ts`,
// `prisma.config.ts`, 라우트 등)가 같은 OS 사용자 권한으로 돈다. 그 코드가 인수 테스트 · 테스트 실행기(vitest) · BIVE가
// 만든 판정 설정을 바꾸면 거짓 통과가 된다. 그래서 판정 러너는 프로젝트 코드가 돌기 전에 이 지문을 만들고 vitest를
// 띄우기 직전과 끝난 직후에 다시 만들어 대조한다(다르면 판정 결과를 쓰지 않는다, fail closed).
// - 인수 테스트: `bive-acceptance/` 아래 일반 파일 (`hashAcceptanceFiles`)
// - 테스트 실행기: `node_modules/.bin/vitest`(링크면 대상 문자열, 파일이면 내용)와 `node_modules/vitest` 패키지의 의존성
//   닫힘(pnpm 배치: 의존성은 패키지 폴더의 형제 링크)에 있는 패키지들의 파일 (패키지 안 `node_modules` 포함)
// - 판정 폴더의 BIVE 생성 파일 (설정 · 수집 설정 · globalSetup · HTTP 도우미)
// 한계: 같은 OS 사용자라 대조 사이에 바꿨다가 되돌리거나, 실행기가 쓰는 결과 파일(`result.json`)을 바꾸는 것은 막지 못한다(#117).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashAcceptanceFiles } from './checkout.js';

/** 지문: 항목 이름(`bive-acceptance/…` · `runner:…` · `judge:…`) → SHA-256. */
export type JudgeInputFingerprint = Record<string, string>;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** `node_modules/vitest`에서 시작한 의존성 닫힘의 패키지 폴더 실경로 (pnpm 배치). 없으면 빈 목록. */
export const runnerPackageDirs = (worktreeDir: string): string[] => {
  let start: string;
  try {
    start = fs.realpathSync(path.join(worktreeDir, 'node_modules', 'vitest'));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined || seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg === null) continue;
    const deps = new Set<string>();
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const value = pkg[key];
      if (typeof value === 'object' && value !== null) {
        for (const name of Object.keys(value)) deps.add(name);
      }
    }
    // pnpm: `.pnpm/<id>/node_modules/<이름>`의 의존성은 같은 `node_modules`의 형제 링크다
    const name = typeof pkg.name === 'string' ? pkg.name : path.basename(dir);
    const container = name.startsWith('@') ? path.dirname(path.dirname(dir)) : path.dirname(dir);
    for (const dep of [...deps].sort()) {
      for (const candidate of [path.join(container, dep), path.join(dir, 'node_modules', dep)]) {
        try {
          queue.push(fs.realpathSync(candidate));
          break;
        } catch {
          // 설치되지 않은 선택 · 피어 의존성
        }
      }
    }
  }
  return [...seen].sort();
};

const hashTree = (root: string, label: string, into: JudgeInputFingerprint): void => {
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      const rel = `${label}/${path.relative(root, full).split(path.sep).join('/')}`;
      if (entry.isDirectory()) {
        // 패키지 안 `node_modules`(`.bin` 포함)도 걷는다: Node는 맨 이름 import를 형제 링크보다 이 자리에서 먼저
        // 찾으므로, 심은 사본이 새 항목으로 드러나야 한다 (검토 2회차)
        walk(full);
      } else if (entry.isSymbolicLink()) {
        into[rel] = sha256(`link:${fs.readlinkSync(full)}`);
      } else if (entry.isFile()) {
        into[rel] = sha256(fs.readFileSync(full));
      }
    }
  };
  walk(root);
};

/** 판정 입력 지문을 만든다. */
export const judgeInputFingerprint = (
  worktreeDir: string,
  judgeFiles: readonly string[],
): JudgeInputFingerprint => {
  const fingerprint: JudgeInputFingerprint = { ...hashAcceptanceFiles(worktreeDir) };
  const bin = path.join(worktreeDir, 'node_modules', '.bin', 'vitest');
  const stat = fs.lstatSync(bin, { throwIfNoEntry: false });
  fingerprint['runner:.bin/vitest'] =
    stat === undefined
      ? 'missing'
      : stat.isSymbolicLink()
        ? sha256(`link:${fs.readlinkSync(bin)}`)
        : sha256(fs.readFileSync(bin));
  const dirs = runnerPackageDirs(worktreeDir);
  if (dirs.length === 0) fingerprint['runner:vitest'] = 'missing';
  for (const dir of dirs) {
    const pkg = readJson(path.join(dir, 'package.json'));
    const name = typeof pkg?.name === 'string' ? pkg.name : path.basename(dir);
    const version = typeof pkg?.version === 'string' ? pkg.version : '?';
    hashTree(dir, `runner:${name}@${version}`, fingerprint);
  }
  for (const file of judgeFiles) {
    fingerprint[`judge:${path.basename(file)}`] = fs.existsSync(file)
      ? sha256(fs.readFileSync(file))
      : 'missing';
  }
  return fingerprint;
};

/** 두 지문의 차이 (추가 · 삭제 · 변경된 항목, 정렬). */
export const fingerprintChanges = (
  before: JudgeInputFingerprint,
  after: JudgeInputFingerprint,
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
