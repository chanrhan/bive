// 실행 유형별 단계 실행기의 차이 (RUN-07, ADR-020 · ADR-136). 단계 실행기는 유형 A의 규칙을 그대로 두고 여기서 유형만 묻는다.
// - 판정할 커밋을 만든 단계: A · B · D = 구현, C = 테스트 작성(구현 생략)
// - 인수 테스트 보호의 기준: A = Red 확인 때의 해시, C · D = Green 확인 때의 해시(C: 새 테스트, D: 기준 커밋), B = 기준 커밋의
//   git 트리(그 실행에서 인수 테스트를 쓰는 단계가 없다: 기준 커밋과 판정 커밋 사이에 `bive-acceptance/` 변경이 없어야 한다)
// - 유형 C의 소스 파일 쓰기 거부: 기준 커밋과 판정 커밋 사이의 변경이 대상 규칙 폴더와 BIVE 선언 파일뿐이어야 한다
import type { JudgmentResult, Run, RunType, Step, StepKind } from '@bive/shared';

import type { GitRunner } from '../git/git-exec.js';
import { ACCEPTANCE_DECLARATION_FILES } from '../judge/acceptance-env.js';
import { ACCEPTANCE_DIR } from '../judge/config.js';
import { lastPassed, redAcceptanceHashes } from './judging.js';

/** 판정 · 병합할 커밋을 만든 단계 (`Run.headCommit`이 이 단계의 마지막 통과 커밋이어야 한다). */
export const headStepKindOf = (
  type: RunType,
): Extract<StepKind, 'implementation' | 'test_writing'> =>
  type === 'C' ? 'test_writing' : 'implementation';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Green 확인 통과 때 기록한 인수 테스트 해시. 없거나 형식이 틀리면 `null`. */
export const greenAcceptanceHashes = (steps: readonly Step[]): Record<string, string> | null => {
  const green = lastPassed(steps, 'green_check');
  const hashes = isRecord(green?.exitDetail) ? green.exitDetail.acceptanceHashes : undefined;
  if (!isRecord(hashes)) return null;
  const entries = Object.entries(hashes);
  if (entries.length === 0 || entries.some(([, value]) => typeof value !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
};

/**
 * 인수 테스트 보호의 기준.
 * - `hashes`: 판정 전 체크아웃의 해시가 같아야 한다 (A: Red 확인, C · D: Green 확인)
 * - `base_tree`: 기준 커밋과 판정 커밋 사이에 `bive-acceptance/` 변경이 없어야 한다 (B)
 * 기록이 없으면 `null`(상태 불일치: 판정하지 않는다).
 */
export type AcceptanceBaseline =
  | {
      readonly kind: 'hashes';
      readonly hashes: Record<string, string>;
      readonly from: 'red' | 'green';
    }
  | { readonly kind: 'base_tree' };

export const acceptanceBaselineOf = (
  run: Pick<Run, 'type'>,
  steps: readonly Step[],
): AcceptanceBaseline | null => {
  switch (run.type) {
    case 'A': {
      const hashes = redAcceptanceHashes(steps);
      return hashes === null ? null : { kind: 'hashes', hashes, from: 'red' };
    }
    case 'C':
    case 'D': {
      const hashes = greenAcceptanceHashes(steps);
      return hashes === null ? null : { kind: 'hashes', hashes, from: 'green' };
    }
    case 'B':
      return { kind: 'base_tree' };
  }
};

/** 기록이 없을 때의 문장. */
export const missingBaselineMessage = (type: RunType): string =>
  type === 'A'
    ? 'Red 확인 통과 기록(인수 테스트 해시)이 없습니다'
    : 'Green 확인 통과 기록(인수 테스트 해시)이 없습니다';

/**
 * 두 커밋 사이에 바뀐 경로 (git 객체 비교, 작업 트리와 무관, 이름 바꾸기도 두 경로로). `pathspec`을 주면 그 아래만.
 * @throws git이 실패하면 (커밋이 없음 등)
 */
export const changedPathsBetween = async (
  git: GitRunner,
  repoPath: string,
  from: string,
  to: string,
  pathspec?: string,
): Promise<string[]> => {
  const result = await git(
    [
      '--no-replace-objects',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      from,
      to,
      '--',
      ...(pathspec === undefined ? [] : [pathspec]),
    ],
    { cwd: repoPath },
  );
  return result.stdout
    .split('\0')
    .filter((file) => file !== '')
    .sort();
};

/**
 * 유형 C가 바꿀 수 있는 경로인지: 대상 규칙 폴더(`bive-acceptance/<표시 ID>/…`)와 BIVE 선언 파일(테스트 작성 실행기가 옮기는 파일)만.
 */
export const isTestOnlyPath = (file: string, ruleDisplayIds: readonly string[]): boolean =>
  Object.hasOwn(ACCEPTANCE_DECLARATION_FILES, file) ||
  ruleDisplayIds.some((id) => file.startsWith(`${ACCEPTANCE_DIR}/${id}/`));

/**
 * 유형 C의 소스 파일 쓰기 거부 (ADR-020 · architecture.md C-18, ADR-136): 기준 커밋과 판정 커밋 사이에 대상 규칙 폴더 · BIVE 선언
 * 파일 밖 변경이 있으면 그 경로들(정렬). 없으면 빈 목록.
 */
export const testOnlyViolations = async (
  git: GitRunner,
  repoPath: string,
  baseCommit: string,
  commit: string,
  ruleDisplayIds: readonly string[],
): Promise<string[]> =>
  (await changedPathsBetween(git, repoPath, baseCommit, commit)).filter(
    (file) => !isTestOnlyPath(file, ruleDisplayIds),
  );

/**
 * 유형 B의 대상 정적 검사 규칙 가운데 판정이 병합으로 갈 수 없는 것 (ADR-136 ⑫): 판정 기록이 없음(판정 없음) · 막지 않는 실패(등록
 * 문서의 형식 오류)만 있음. 막는 실패는 여기 들지 않는다(검사 단계는 구현 회귀, 병합 재검사는 재검사 실패). 검사 단계와 병합 재검사가
 * 같이 쓴다. 유형 B가 아니면 늘 빈 목록.
 */
export const unjudgedStaticTargets = (
  run: Pick<Run, 'type' | 'targetRuleIds'>,
  recorded: readonly Pick<JudgmentResult, 'ruleId' | 'status'>[],
  nonBlocking: ReadonlySet<string>,
): string[] =>
  run.type !== 'B'
    ? []
    : run.targetRuleIds.filter(
        (id) =>
          !recorded.some(
            (judgment) =>
              judgment.ruleId === id && (judgment.status === 'pass' || !nonBlocking.has(id)),
          ),
      );
