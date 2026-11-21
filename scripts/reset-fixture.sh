#!/usr/bin/env bash
# 테스트 대상 프로젝트 초기화 (M0-08).
#
# 사용법: scripts/reset-fixture.sh [--verify] <dir>
#   1. <dir>을 지운다 (/, 홈과 그 상위, 저장소 루트와 그 아래 전부, 저장소의 상위는 거부)
#   2. fixtures/sample-next-app에서 git 추적 파일만 복사한다
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
fixture_rel='fixtures/sample-next-app'
[[ -f "$repo_root/$fixture_rel/package.json" ]] || {
  echo "픽스처 원본 없음: $repo_root/$fixture_rel" >&2
  exit 1
}

# 절대 경로로 정규화한다 (GNU `realpath -m` 대체, macOS BSD realpath · bash 3.2에서도 동작).
# 존재하는 디렉터리 구성 요소는 심볼릭 링크를 따라가 물리 경로로 바꾸고,
# 존재하지 않는 구성 요소와 그 뒤의 `..`는 글자 그대로 처리한다.
canonicalize() {
  local path="$1" cur rest comp next
  if [[ "$path" == /* ]]; then
    cur='/'
    rest="${path#/}"
  else
    cur="$(pwd -P)"
    rest="$path"
  fi
  while [[ -n "$rest" ]]; do
    comp="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=''; fi
    case "$comp" in
      '' | .) ;;
      ..)
        cur="${cur%/*}"
        [[ -n "$cur" ]] || cur='/'
        ;;
      *)
        if [[ "$cur" == / ]]; then next="/$comp"; else next="$cur/$comp"; fi
        if [[ -d "$next" ]]; then
          cur="$(CDPATH='' cd -P -- "$next" && pwd -P)"
        else
          cur="$next"
        fi
        ;;
    esac
  done
  printf '%s\n' "$cur"
}

target="$(canonicalize "$dir")"
home="$(canonicalize "${HOME:-/}")"

# 지우면 안 되는 경로: 루트, 홈, 저장소 루트와 그 아래 전부
case "$target" in
  / | "$home" | "$repo_root" | "$repo_root"/*)
    echo "이 경로는 초기화할 수 없음: $target" >&2
    exit 1
    ;;
esac
# 저장소나 홈을 포함하는 상위 경로
for protected in "$repo_root" "$home"; do
  case "$protected/" in
    "$target"/*)
      echo "저장소나 홈을 포함하는 경로는 초기화할 수 없음: $target" >&2
      exit 1
      ;;
  esac
done

# 복사 대상 = git 추적 파일만 (node_modules · .next · *.db · 생성 코드 같은 미추적 · 무시 파일은 빠진다)
tracked="$(git -C "$repo_root" ls-files -- "$fixture_rel" | wc -l)"
[[ "$tracked" -gt 0 ]] || {
  echo "git이 추적하는 픽스처 파일 없음: $repo_root/$fixture_rel" >&2
  exit 1
}

echo "[reset-fixture] 삭제: $target"
rm -rf -- "$target"
mkdir -p -- "$target"

echo "[reset-fixture] 복사: $repo_root/$fixture_rel → $target (추적 파일 ${tracked}개)"
git -C "$repo_root" ls-files -z -- "$fixture_rel" |
  tar -C "$repo_root" --null -T - -cf - |
  tar -C "$target" --strip-components=2 -xf -

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
