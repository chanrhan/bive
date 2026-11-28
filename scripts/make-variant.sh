#!/usr/bin/env bash
# 테스트 대상 픽스처 사본에 변형 하나를 커밋한다 (M3-02 #47, ADR-125 ⑥. contract-mismatch는 M3-47 #292, ADR-132.
# touch-lib · flaky는 M3-14 #59, ADR-156).
#
# 사용법: scripts/make-variant.sh <dir> <이름>
#   <dir>: scripts/reset-fixture.sh로 만든 픽스처 사본 (저장소 안 · 원본 fixtures/sample-next-app은 거부)
#   <이름>: 아래 variant_<이름> 함수가 있는 변형 (- 는 _ 로 바꿔 찾는다)
#   변형마다 커밋 하나를 만든다. 되돌리기: git -C <dir> revert --no-edit HEAD
# 거부(종료 코드 1, 한 줄 안내): 모르는 이름, 없는 폴더, 저장소 안의 폴더, 픽스처 사본이 아닌 폴더, 더러운 작업 트리
# 변형을 더할 때: variant_<이름> 함수 하나를 더하고 VARIANTS에 이름을 적는다. 함수는 <dir> 안에서 돈다
set -euo pipefail

VARIANTS=(undeclared-import cycle contract-mismatch touch-lib flaky)

usage() {
  echo "사용법: $0 <dir> <이름> (이름: ${VARIANTS[*]})" >&2
  exit 2
}
refuse() {
  echo "$1" >&2
  exit 1
}

[[ $# -eq 2 ]] || usage
dir="$1"
name="$2"

known=0
for variant in "${VARIANTS[@]}"; do
  [[ "$variant" == "$name" ]] && known=1
done
[[ "$known" == 1 ]] || refuse "모르는 변형: $name (이름: ${VARIANTS[*]})"

[[ -d "$dir" ]] || refuse "폴더 없음: $dir"
target="$(cd -- "$dir" && pwd -P)"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
case "$target/" in
  "$repo_root"/*) refuse "저장소 안의 폴더에는 변형을 만들 수 없음 (reset-fixture.sh로 만든 사본을 줄 것): $target" ;;
esac

git_fx() {
  git -C "$target" \
    -c user.name='BIVE Fixture' \
    -c user.email='fixture@bive.invalid' \
    -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null \
    "$@"
}

# 픽스처 사본: 그 폴더가 git 저장소의 최상위이고, 첫 커밋이 reset-fixture.sh의 커밋이며, 픽스처 package.json이 있다
toplevel="$(git_fx rev-parse --show-toplevel 2> /dev/null || true)"
[[ -n "$toplevel" && "$(cd -- "$toplevel" && pwd -P)" == "$target" ]] ||
  refuse "픽스처 사본이 아님 (git 저장소 최상위가 아님): $target"
root_subject="$(git_fx log --max-parents=0 --format=%s HEAD 2> /dev/null || true)"
[[ "$root_subject" == 'fixture: initial' ]] ||
  refuse "픽스처 사본이 아님 (첫 커밋이 'fixture: initial'이 아님): $target"
grep -q '"name": "sample-next-app"' "$target/package.json" 2> /dev/null ||
  refuse "픽스처 사본이 아님 (package.json 이름이 sample-next-app이 아님): $target"
[[ -z "$(git_fx status --porcelain)" ]] || refuse "작업 트리가 깨끗하지 않음: $target"

# 선언 외 방향 import 하나: health 블록(허용 의존 lib)이 auth 블록 파일을 가져온다
variant_undeclared_import() {
  cat > src/app/api/health/session-probe.ts << 'EOF'
import { GET as getSession } from '@/app/api/auth/session/route';

/** 변형 undeclared-import: health 블록이 선언하지 않은 auth 블록을 가져온다. */
export function probeSession(): Response {
  return getSession();
}
EOF
}

# 순환 하나: lib 블록 안의 두 파일이 서로를 가져온다
variant_cycle() {
  cat > src/lib/cycle-a.ts << 'EOF'
import { cycleB } from './cycle-b';

/** 변형 cycle: cycle-b와 서로 가져온다. */
export function cycleA(n: number): number {
  return n <= 0 ? 0 : cycleB(n - 1);
}
EOF
  cat > src/lib/cycle-b.ts << 'EOF'
import { cycleA } from './cycle-a';

/** 변형 cycle: cycle-a와 서로 가져온다. */
export function cycleB(n: number): number {
  return n <= 0 ? 0 : cycleA(n - 1);
}
EOF
}

# 응답 필드 타입 위반 하나: 계약(openapi.yaml)은 GET /api/health의 ok를 boolean으로 정하지만 글을 돌려준다
variant_contract_mismatch() {
  cat > src/app/api/health/route.ts << 'EOF'
import { getDb } from '@/lib/db';

// 요청마다 실행한다(빌드 시점 정적 생성 금지).
export const dynamic = 'force-dynamic';

/** 변형 contract-mismatch: 계약(openapi.yaml)은 ok를 boolean으로 정하지만 글을 돌려준다. */
export async function GET(): Promise<Response> {
  await getDb().item.count();
  return Response.json({ ok: 'true' });
}
EOF
}

# 블록 lib 파일의 한 줄 변경 (M3-14 #59): 기준 브랜치에 사람이 직접 커밋한 lib 변경. 감시자가 lib 대상 규칙을 재검증 필요로 표시한다
variant_touch_lib() {
  printf '%s\n' '// 변형 touch-lib: lib 블록 파일 한 줄 변경' >> src/lib/db.ts
}

# 흔들리는 인수 테스트 하나 (M3-14 #59): 라우트 GET /api/flaky는 서버 작업 폴더(판정 체크아웃 루트)의 파일로 호출 횟수를 세어
# 두 번째 호출에서만 ok가 false다. 규칙 RULE-001 폴더의 인수 테스트가 그 라우트를 한 번 부르므로, 같은 체크아웃을 세 번 판정하면
# 통과 · 실패 · 통과다(시각 · 난수 없이 횟수로 정해진다). 판정마다 새로 만드는 임시 DB · 빌드 폴더(.next) · 환경 변수는 회차 사이에
# 남지 않아 횟수를 세는 자리로 쓰지 않는다. 재판정 불일치 격리는 orchestrator/test/reproducibility.test.ts
variant_flaky() {
  mkdir -p src/app/api/flaky bive-acceptance/RULE-001
  cat > src/app/api/flaky/route.ts << 'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 요청마다 실행한다(빌드 시점 정적 생성 금지).
export const dynamic = 'force-dynamic';

/** 호출 횟수 파일: 서버 작업 폴더(판정 체크아웃 루트)라 같은 체크아웃의 재판정 사이에 남는다. */
const COUNTER = path.join(process.cwd(), '.bive-flaky-count');

/** 변형 flaky: 같은 체크아웃에서 두 번째 호출만 ok가 false다. */
export function GET(): Response {
  let count = 0;
  try {
    count = Number.parseInt(readFileSync(COUNTER, 'utf8'), 10) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  writeFileSync(COUNTER, String(count));
  return Response.json({ ok: count !== 2 });
}
EOF
  cat > bive-acceptance/RULE-001/flaky.acc.ts << 'EOF'
import { describe, expect, inject, it } from 'vitest';

describe('변형 flaky', () => {
  it('호출 횟수를 세는 응답의 ok는 true', async () => {
    const res = await fetch(new URL('/api/flaky', inject('baseUrl')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
EOF
}

(cd "$target" && "variant_${name//-/_}")
git_fx add -A
git_fx commit -q -m "variant: $name"
echo "[make-variant] $name 커밋: $(git_fx rev-parse --short HEAD) (되돌리기: git -C '$target' revert --no-edit HEAD)"
