#!/usr/bin/env bash
# scripts/make-variant.sh 검사 (M3-02 #47, ADR-125 ⑥). 파서 빌드(pnpm build)가 먼저 필요하다.
# 픽스처 사본은 scripts/reset-fixture.sh로 임시 폴더에 만든다(가짜 pnpm으로 설치는 건너뛴다. 분석에는 소스만 필요하다).
#   1. 거부: 인자 수, 모르는 이름, 없는 폴더, 저장소 안의 폴더(원본 픽스처 포함), 픽스처 사본이 아닌 폴더, 더러운 작업 트리.
#      거부는 종료 코드 1(인자 수는 2)이고 커밋 · 파일이 늘지 않는다
#   2. 예제 블록 선언으로 원본 위반 0건, undeclared-import · cycle 변형은 커밋 하나에 위반 정확히 1건(종류 · 파일까지),
#      git revert --no-edit HEAD 뒤 다시 0건
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$here/.." && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
work="$(realpath -- "$work")"
blocks="$repo/fixtures/blocks/sample-next-app.json"

mkdir -p "$work/bin"
printf '#!/bin/sh\nexit 0\n' > "$work/bin/pnpm"
chmod +x "$work/bin/pnpm"

g() { git -c user.name=t -c user.email=t@t.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

fx="$work/fx"
PATH="$work/bin:$PATH" "$here/reset-fixture.sh" "$fx" > /dev/null

fail=0
commits() { g -C "$1" rev-list --count HEAD 2> /dev/null || echo none; }

# 거부: 기대 종료 코드, 기대 글이 든 안내 한 줄, 대상의 커밋 수 · 파일 목록이 그대로
check_refused() {
  local label="$1" expected="$2" want="$3" probe="$4" script="$5"
  shift 5
  local before_commits before_files code=0 err
  before_commits="$(commits "$probe")"
  before_files="$(cd "$probe" && find . -path ./.git -prune -o -type f -print | sort | md5sum)"
  err="$("$script" "$@" 2>&1 > /dev/null)" || code=$?
  local after_files
  after_files="$(cd "$probe" && find . -path ./.git -prune -o -type f -print | sort | md5sum)"
  if [[ "$code" -ne "$expected" ]]; then
    echo "실패: $label 종료 코드 $code (기대 $expected)"
    fail=1
  elif [[ "$(printf '%s\n' "$err" | wc -l)" -ne 1 || "$err" != *"$want"* ]]; then
    echo "실패: $label 안내가 한 줄이 아님: $err"
    fail=1
  elif [[ "$(commits "$probe")" != "$before_commits" || "$after_files" != "$before_files" ]]; then
    echo "실패: $label 거부됐지만 대상이 바뀜"
    fail=1
  else
    echo "통과: $label 거부 ($err)"
  fi
}

mv="$here/make-variant.sh"
check_refused '인자 없음' 2 '사용법' "$fx" "$mv"
check_refused '인자 셋' 2 '사용법' "$fx" "$mv" "$fx" cycle extra
check_refused '모르는 이름' 1 '모르는 변형' "$fx" "$mv" "$fx" no-such-variant
check_refused '없는 폴더' 1 '폴더 없음' "$fx" "$mv" "$work/none" cycle
check_refused '원본 픽스처' 1 '저장소 안의 폴더' "$repo/fixtures/sample-next-app" "$mv" "$repo/fixtures/sample-next-app" cycle

# 원본 픽스처를 가리키는 기호 링크(저장소 밖에 둔 링크)도 실제 경로로 보고 거부한다
ln -s "$repo/fixtures/sample-next-app" "$work/link-to-original"
check_refused '원본 픽스처 기호 링크' 1 '저장소 안의 폴더' "$repo/fixtures/sample-next-app" \
  "$mv" "$work/link-to-original" cycle

# 저장소 안의 폴더: 가짜 저장소 안에 픽스처 사본 모양의 git 저장소를 두어도 거부한다
mkdir -p "$work/repo/scripts" "$work/repo/fixtures"
cp "$mv" "$work/repo/scripts/"
cp -a "$fx" "$work/repo/fixtures/sample-next-app"
check_refused '저장소 안 사본' 1 '저장소 안의 폴더' "$work/repo/fixtures/sample-next-app" \
  "$work/repo/scripts/make-variant.sh" "$work/repo/fixtures/sample-next-app" cycle

# 픽스처 사본이 아닌 폴더
plain="$work/plain"
mkdir -p "$plain"
cp "$fx/package.json" "$plain/"
check_refused 'git 저장소 아님' 1 '최상위가 아님' "$plain" "$mv" "$plain" cycle
sub="$work/sub"
cp -a "$fx" "$sub"
# 하위 폴더에도 픽스처 package.json을 커밋해 두어 최상위 검사만 이것을 거부하게 한다
mkdir -p "$sub/inner"
cp "$fx/package.json" "$sub/inner/"
g -C "$sub" add -A
g -C "$sub" commit -q -m inner
check_refused '저장소 최상위 아님' 1 '최상위가 아님' "$sub" "$mv" "$sub/inner" cycle
other="$work/other"
cp -a "$fx" "$other"
rm -rf "$other/.git"
g -C "$other" init -q -b main
g -C "$other" add -A
g -C "$other" commit -q -m 'something else'
check_refused '첫 커밋이 다름' 1 'fixture: initial' "$other" "$mv" "$other" cycle
renamed="$work/renamed"
cp -a "$fx" "$renamed"
rm -rf "$renamed/.git"
sed -i 's/"name": "sample-next-app"/"name": "other-app"/' "$renamed/package.json"
g -C "$renamed" init -q -b main
g -C "$renamed" add -A
g -C "$renamed" commit -q -m 'fixture: initial'
check_refused '다른 package.json' 1 'package.json' "$renamed" "$mv" "$renamed" cycle

# 더러운 작업 트리 (고친 파일 · 추적하지 않는 파일)
dirty="$work/dirty"
cp -a "$fx" "$dirty"
echo '// dirty' >> "$dirty/src/lib/db.ts"
check_refused '고친 파일' 1 '깨끗하지 않음' "$dirty" "$mv" "$dirty" cycle
g -C "$dirty" checkout -q -- src/lib/db.ts
echo 'x' > "$dirty/untracked.txt"
check_refused '추적하지 않는 파일' 1 '깨끗하지 않음' "$dirty" "$mv" "$dirty" cycle

# 위반 수: 원본 0건, 변형마다 커밋 하나 · 정확히 1건, 되돌리면 0건
violations() { node "$here/variant-violations.mjs" "$fx" "$blocks"; }
expect_violations() {
  local label="$1" expected="$2" actual
  actual="$(violations)" || {
    echo "실패: $label 분석 실패"
    fail=1
    return
  }
  if [[ "$actual" == "$expected" ]]; then
    echo "통과: $label"
  else
    echo "실패: $label"
    echo "  기대: $(printf '%s' "$expected" | tr '\n' '|')"
    echo "  실제: $(printf '%s' "$actual" | tr '\n' '|')"
    fail=1
  fi
}
check_variant() {
  local name="$1" line="$2" before
  before="$(commits "$fx")"
  if ! "$mv" "$fx" "$name" > /dev/null; then
    echo "실패: $name 변형이 0이 아닌 코드로 종료"
    fail=1
    return
  fi
  local subject
  subject="$(g -C "$fx" log -1 --format=%s)"
  if [[ "$(commits "$fx")" != "$((before + 1))" || "$subject" != "variant: $name" || -n "$(g -C "$fx" status --porcelain)" ]]; then
    echo "실패: $name 변형 커밋이 하나가 아님 (커밋 $(commits "$fx"), 제목 $subject)"
    fail=1
  fi
  expect_violations "$name 위반 1건" "$line
total 1"
  g -C "$fx" revert --no-edit HEAD > /dev/null
  expect_violations "$name 되돌린 뒤 위반 0건" 'total 0'
}

expect_violations '원본 위반 0건' 'total 0'
check_variant undeclared-import \
  'structure.declared-direction src/app/api/health/session-probe.ts src/app/api/auth/session/route.ts'
check_variant cycle 'structure.no-cycle src/lib/cycle-a.ts src/lib/cycle-b.ts'

exit "$fail"
