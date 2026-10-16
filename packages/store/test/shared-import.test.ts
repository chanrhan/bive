// 패키지 간 import가 shared 빌드 없이 해석되는지 확인한다 (architecture.md 2장, M0-03).
// @bive/shared는 `@bive/source` 조건으로 src를 가리키므로 dist가 없어도 typecheck · test가 통과해야 한다.
import { JudgmentStatus } from '@bive/shared';
import { describe, expect, it } from 'vitest';

describe('@bive/shared import', () => {
  it('shared의 enum 값을 쓸 수 있다', () => {
    expect(JudgmentStatus.options).toEqual([
      'pass',
      'fail',
      'unjudged',
      'quarantined',
      'needs_recheck',
    ]);
  });
});
