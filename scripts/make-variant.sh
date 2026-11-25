#!/usr/bin/env bash
# 테스트 대상 픽스처 사본에 변형 하나를 커밋한다 (M3-02 #47, ADR-125 ⑥).
#
# 사용법: scripts/make-variant.sh <dir> <이름>
#   <dir>: scripts/reset-fixture.sh로 만든 픽스처 사본 (저장소 안 · 원본 fixtures/sample-next-app은 거부)
#   <이름>: 아래 variant_<이름> 함수가 있는 변형 (- 는 _ 로 바꿔 찾는다)
#   변형마다 커밋 하나를 만든다. 되돌리기: git -C <dir> revert --no-edit HEAD
# 거부(종료 코드 1, 한 줄 안내): 모르는 이름, 없는 폴더, 저장소 안의 폴더, 픽스처 사본이 아닌 폴더, 더러운 작업 트리
# 변형을 더할 때: variant_<이름> 함수 하나를 더하고 VARIANTS에 이름을 적는다. 함수는 <dir> 안에서 돈다
set -euo pipefail

VARIANTS=(undeclared-import cycle)

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

(cd "$target" && "variant_${name//-/_}")
git_fx add -A
git_fx commit -q -m "variant: $name"
echo "[make-variant] $name 커밋: $(git_fx rev-parse --short HEAD) (되돌리기: git -C '$target' revert --no-edit HEAD)"
