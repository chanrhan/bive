// 쓰기 허용 범위의 병합 전 대조 (TODO-02 · NFR-02, M3-58 #321, ADR-147 ⑥, ADR-155).
// 허용 목록 축소 재개로 만든 실행(과 그 범위를 이은 실행)의 구현 세션은 경로 가드가 파일 도구의 쓰기를 범위 안으로 좁힌다. 경로 가드를 지나지
// 않는 쓰기(명령 도구 `run_tests` · `prisma_generate` · `prisma_migrate` · `install_package`가 실행하는 코드 · 도구가 바꾸는 파일)와
// 오케스트레이터가 대신 커밋하는 작업 트리 변경은 가드만으로 닫히지 않으므로, 검사 단계를 열 때와 병합 직전에 이 실행의 시작 커밋과 판정할
// 커밋 사이의 변경을 git 객체로 대조한다(유형 C의 소스 파일 쓰기 거부 `testOnlyViolations` · 보강의 `existingTestViolations`와 같은 자리 ·
// 같은 방식). 범위 밖 파일이 있으면 그 실행은 `guard_violation`(`stage: 'write_scope'`)으로 멈춘다(닫힌 쪽).
// - 시작 커밋 = 이 실행의 작업 가지를 만든 커밋(원 실행의 `headCommit`, 없으면 기준 커밋: `continuationWorktreeStart`). 원 실행들이 이미
//   커밋한 변경은 그 실행의 대조가 맡았다(범위 없는 원 실행의 변경은 좁히기 전의 것이다)
// - 대상 규칙의 인수 테스트 폴더 · BIVE 선언 파일(테스트 작성 세션의 산출, `isTestOnlyPath`)은 이 대조에서 빼고 기존 보호(Red 해시 ·
//   테스트 작성 세션의 경로 가드)에 맡긴다. 그 밖의 경로는 경로 가드와 같은 판정(`writeScopeDenial`)으로 본다
// 범위가 붙지 않은 실행은 저장소에서 범위를 읽는 것 말고는 아무것도 하지 않는다(대조 없음).
import type { StepContext } from '../engine/types.js';
import type { GitRunner } from '../git/git-exec.js';
import { continuationWorktreeStart } from '../runs/run-continuation.js';
import { writeScopeDenial } from '../tools/path-guard.js';
import { changedPathsBetween, isTestOnlyPath } from './run-type.js';

/** 범위 밖 변경으로 멈출 때의 단계 결과 `stage`. */
export const WRITE_SCOPE_STAGE = 'write_scope';
/** 범위 밖 변경으로 멈출 때의 고정 사유. */
export const WRITE_SCOPE_VIOLATION_MESSAGE =
  '쓰기 허용 범위가 붙은 실행에서 허용 범위 밖의 파일이 바뀌었습니다';

/**
 * 이 실행의 시작 커밋과 `commit` 사이에서 쓰기 허용 범위 밖으로 바뀐(지움 포함) 경로들(정렬). 범위가 붙지 않은 실행이면 빈 목록.
 * @throws git이 실패하면 (커밋이 없음 등)
 */
export const writeScopeViolations = async (
  context: Pick<StepContext, 'run' | 'git' | 'read'>,
  git: GitRunner,
  commit: string,
): Promise<string[]> => {
  const plan = context.read((store) => {
    const scope = store.runWriteScopes.ofRun(context.run.id);
    if (scope === null) return null;
    return {
      scope,
      start: continuationWorktreeStart(store, context.run.id)?.commit ?? context.git.baseCommit,
      targets: context.run.targetRuleIds.map((id) => store.rules.get(id)?.displayId ?? id),
    };
  });
  if (plan === null) return [];
  return (await changedPathsBetween(git, context.git.repoPath, plan.start, commit)).filter(
    (file) => !isTestOnlyPath(file, plan.targets) && writeScopeDenial(plan.scope, file) !== null,
  );
};
