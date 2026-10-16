#!/usr/bin/env bash
# 테스트 대상 프로젝트 초기화 (M0-08).
#
# 사용법: scripts/reset-fixture.sh [--verify] <dir>
#   1. <dir>을 지운다
#   2. fixtures/sample-next-app을 복사한다 (node_modules · .next · *.db · 생성 코드 제외)
#   3. <dir>에서 pnpm install --frozen-lockfile
#   4. git init -b main 후 커밋 1개 ("fixture: initial")
#   --verify: 끝에 pnpm -C <dir> test까지 실행한다
set -euo pipefail

usage() {
  echo "사용법: $0 [--verify] <dir>" >&2
  exit 2
}

verify=0
dir=''
for arg in "$@"; do
  case "$arg" in
    --verify) verify=1 ;;
    -h | --help) usage ;;
    -*)
      echo "알 수 없는 옵션: $arg" >&2
      usage
      ;;
    *)
      [[ -z "$dir" ]] || usage
      dir="$arg"
      ;;
  esac
done
[[ -n "$dir" ]] || usage

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
src="$repo_root/fixtures/sample-next-app"
[[ -f "$src/package.json" ]] || {
  echo "픽스처 원본 없음: $src" >&2
  exit 1
}

target="$(realpath -m -- "$dir")"

# 지우면 안 되는 경로: 루트, 홈, 저장소 루트와 그 상위, 픽스처 원본과 그 안쪽
case "$target" in
  / | "$HOME" | "$repo_root" | "$src" | "$src"/*)
    echo "이 경로는 초기화할 수 없음: $target" >&2
    exit 1
    ;;
esac
case "$repo_root/" in
  "$target"/*)
    echo "저장소를 포함하는 경로는 초기화할 수 없음: $target" >&2
    exit 1
    ;;
esac

echo "[reset-fixture] 삭제: $target"
rm -rf -- "$target"
mkdir -p -- "$target"

echo "[reset-fixture] 복사: $src → $target"
tar -C "$src" \
  --exclude='./node_modules' \
  --exclude='./.next' \
  --exclude='./src/generated' \
  --exclude='./next-env.d.ts' \
  --exclude='*.tsbuildinfo' \
  --exclude='*.db' \
  --exclude='*.db-journal' \
  -cf - . | tar -C "$target" -xf -

echo "[reset-fixture] 의존성 설치"
pnpm -C "$target" install --frozen-lockfile

echo "[reset-fixture] git 저장소 초기화"
git_fx() {
  git -C "$target" \
    -c user.name='BIVE Fixture' \
    -c user.email='fixture@bive.invalid' \
    -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null \
    "$@"
}
git_fx init -q -b main
git_fx add -A
git_fx commit -q -m 'fixture: initial'

if [[ "$verify" == 1 ]]; then
  echo "[reset-fixture] 검증: pnpm -C $target test"
  pnpm -C "$target" test
else
  echo "[reset-fixture] 완료. 검증: pnpm -C $target test"
fi
