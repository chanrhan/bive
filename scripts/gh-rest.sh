#!/usr/bin/env bash
# GitHub REST 호출 래퍼. 프록시가 인증을 주입하므로 토큰 설정이 필요 없다.
# 사용: scripts/gh-rest.sh METHOD PATH [gh api 추가 인자...]
#   scripts/gh-rest.sh GET  repos/chanrhan/bive/milestones
#   scripts/gh-rest.sh POST repos/chanrhan/bive/milestones -f title=M0 -f description='...'
#   scripts/gh-rest.sh POST repos/chanrhan/bive/issues --input body.json
# 페이지네이션이 필요하면 --paginate 를 추가 인자로 넘긴다.
set -euo pipefail
if [ $# -lt 2 ]; then
  echo "usage: $0 METHOD PATH [gh api args...]" >&2
  exit 2
fi
method="$1"; path="$2"; shift 2
exec gh api -X "$method" -H "Accept: application/vnd.github+json" "$path" "$@"
