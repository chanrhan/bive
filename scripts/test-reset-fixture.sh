#!/usr/bin/env bash
# scripts/reset-fixture.sh 검사 (M0-08).
# 실제 저장소가 아니라 임시 복사본(가짜 저장소 · 가짜 HOME · 가짜 pnpm)에서 실행한다.
#   1. 거부 경로(/, 저장소 루트, .git, fixtures, 픽스처 원본, docs, 저장소 상위, $HOME)는 종료 코드 1이고 대상이 그대로 있다
#   2. 허용 경로는 git 추적 파일만 복사하고 main 브랜치 커밋 1개로 초기화한다
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
work="$(realpath -- "$work")"

repo="$work/repo"
fake_home="$work/home"

g() { git -c user.name=t -c user.email=t@t.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

# 검사마다 가짜 저장소 · 가짜 HOME을 새로 만들어 검사끼리 영향을 주지 않게 한다
setup() {
  rm -rf -- "$repo" "$fake_home"
  mkdir -p "$repo/scripts" "$repo/fixtures/sample-next-app/node_modules/x" "$repo/docs" "$fake_home"
  cp "$here/reset-fixture.sh" "$repo/scripts/"
  echo '{}' > "$repo/fixtures/sample-next-app/package.json"
  echo 'node_modules/' > "$repo/fixtures/sample-next-app/.gitignore"
  echo 'x' > "$repo/fixtures/sample-next-app/node_modules/x/index.js"
  echo 'doc' > "$repo/docs/a.md"
  echo 'keep' > "$fake_home/keep"
  g -C "$repo" init -q -b main
  g -C "$repo" add -A
  g -C "$repo" commit -q -m init
  # 추적되지 않는 파일은 복사되면 안 된다
  echo 'untracked' > "$repo/fixtures/sample-next-app/untracked.txt"
}

# pnpm install은 가짜로 대신한다 (이 검사는 경로 가드와 복사 · git 초기화만 본다)
mkdir -p "$work/bin"
printf '#!/bin/sh\nexit 0\n' > "$work/bin/pnpm"
chmod +x "$work/bin/pnpm"
export PATH="$work/bin:$PATH" HOME="$fake_home"

fail=0
check_refused() {
  local arg="$1" probe="$2" code=0
  setup
  (cd "$repo" && scripts/reset-fixture.sh "$arg") > /dev/null 2>&1 || code=$?
  if [[ "$code" -ne 1 ]]; then
    echo "실패: '$arg' 종료 코드 $code (기대 1)"
    fail=1
  elif [[ ! -e "$probe" ]]; then
    echo "실패: '$arg' 거부됐지만 $probe 가 사라짐"
    fail=1
  else
    echo "통과: '$arg' 거부"
  fi
}

check_refused / /bin
check_refused . "$repo/.git/HEAD"
check_refused "$repo" "$repo/.git/HEAD"
check_refused .git "$repo/.git/HEAD"
check_refused fixtures "$repo/fixtures/sample-next-app/package.json"
check_refused fixtures/sample-next-app "$repo/fixtures/sample-next-app/package.json"
check_refused docs "$repo/docs/a.md"
check_refused scripts/../docs "$repo/docs/a.md"
check_refused .. "$repo/.git/HEAD"
check_refused "$fake_home" "$fake_home/keep"
check_refused "$work" "$fake_home/keep"

# 허용 경로: 기존 내용을 지우고 추적 파일만 복사, main 커밋 1개
setup
out="$work/out/fx"
mkdir -p "$out"
echo 'stale' > "$out/stale.txt"
if (cd "$repo" && scripts/reset-fixture.sh "$out") > /dev/null 2>&1; then
  files="$(cd "$out" && find . -path ./.git -prune -o -type f -print | sort | tr '\n' ' ')"
  commits="$(git -C "$out" rev-list --count main)"
  if [[ "$files" == './.gitignore ./package.json ' && "$commits" == 1 ]]; then
    echo "통과: 허용 경로 초기화 (추적 파일만, 커밋 1개)"
  else
    echo "실패: 허용 경로 결과 파일 [$files] 커밋 $commits"
    fail=1
  fi
else
  echo "실패: 허용 경로 초기화가 0이 아닌 코드로 종료"
  fail=1
fi

exit "$fail"
