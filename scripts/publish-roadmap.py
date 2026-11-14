#!/usr/bin/env python3
"""docs/roadmap.md 를 GitHub 라벨 · 마일스톤 · 이슈로 발행하고 이슈 번호를 로드맵에 되써 넣는다.

절차: .claude/skills/publish-roadmap/SKILL.md, 형식: docs/roadmap-format.md.
멱등: 이미 있는 라벨 · 마일스톤은 재사용한다. 이슈는 열림 · 닫힘을 가리지 않고 기존 이슈를 찾으면
만들지 않고 번호만 기록한다(행의 '이슈' 열 번호 우선, 없으면 같은 제목. ADR-085).
닫힌 이슈의 본문은 고치지 않고, 로드맵과 다르면 '닫힌 이슈 본문 차이'로 알리기만 한다.
GitHub 호출은 전부 scripts/gh-rest.sh(= gh api)로 한다. --dry-run이면 GET 말고는 호출하지 않는다.

사용:
  python3 scripts/publish-roadmap.py --dry-run        # 쓰기 없이 계획만 출력 (읽기 GET만 수행)
  python3 scripts/publish-roadmap.py                  # 발행 + 로드맵 '이슈' 열 되써 넣기 + 검증
  python3 scripts/publish-roadmap.py --no-write-back  # 로드맵 파일은 건드리지 않음
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GH = ROOT / "scripts" / "gh-rest.sh"
ROADMAP = ROOT / "docs" / "roadmap.md"

LABELS = [
    ("type:feature", "1d76db"),
    ("type:bug", "d73a4a"),
    ("type:chore", "6a737d"),
    ("type:docs", "0075ca"),
    *[(f"area:{a}", "bfd4f2") for a in
      ("app", "orchestrator", "store", "parser", "shared", "ci", "docs")],
    ("needs-human", "d93f0b"),
]
MILESTONE_DESC_MAX = 2000
SLEEP = 1.0
RETRY_WAIT = 60

args = None
repo = "chanrhan/bive"


class GhError(Exception):
    pass


class DryRunWriteBlocked(Exception):
    """--dry-run 중 GET 아닌 호출. GhError와 달리 잡지 않고 실행을 멈춘다."""


def gh(method, path, payload=None, extra=()):
    """gh-rest.sh 호출. 요청 사이 1초 대기, 403/429면 60초 뒤 1회 재시도."""
    if args is not None and args.dry_run and method != "GET":
        raise DryRunWriteBlocked(f"dry-run 중 쓰기 호출 차단: {method} {path}")
    for attempt in (1, 2):
        time.sleep(SLEEP)
        cmd = [str(GH), method, path, *extra]
        if payload is not None:
            cmd += ["--input", "-"]
        r = subprocess.run(cmd, input=json.dumps(payload) if payload is not None else None,
                           capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout
        err = (r.stderr + r.stdout).strip()
        if attempt == 1 and re.search(r"\b(403|429)\b", err):
            print(f"  ! {method} {path}: 403/429, {RETRY_WAIT}초 뒤 재시도", file=sys.stderr)
            time.sleep(RETRY_WAIT)
            continue
        raise GhError(err[:500])


def gh_list(path):
    sep = "&" if "?" in path else "?"
    out = gh("GET", f"{path}{sep}per_page=100", extra=("--paginate", "-q", ".[]|tojson"))
    return [json.loads(line) for line in out.splitlines() if line.strip()]


# ---------------------------------------------------------------- 파싱

def parse_roadmap(text):
    lines = text.split("\n")
    milestones = []  # {n, title, description, issues:[...]}
    cur = None
    section = None  # 'goal' | 'flow' | None
    desc = []
    for line in lines:
        m = re.match(r"^### 2\.\d+ (M\d+ .+)$", line)
        if m:
            if cur:
                cur["description"] = "\n".join(desc).strip()
            title = m.group(1).strip()
            cur = {"n": title.split()[0], "title": title, "issues": [], "description": ""}
            milestones.append(cur)
            desc, section = [], None
            continue
        if re.match(r"^## ", line):
            if cur:
                cur["description"] = "\n".join(desc).strip()
                cur = None
            section = None
            continue
        if cur is None:
            continue
        if line.startswith("**목표**"):
            section = "desc"
        elif line.startswith("**범위 밖**"):
            section = None
        if section == "desc":
            desc.append(line)
        row = re.match(r"^\| (M\d+-\d+) \|", line)
        if row:
            cells = [c.strip() for c in line.strip().strip("|").split(" | ")]
            if len(cells) != 8:
                raise SystemExit(f"표 열 수 오류({len(cells)}): {line[:80]}")
            key, title, typ, area, dep, acc, ids, issue = cells
            num = re.fullmatch(r"#(\d+)", issue)
            cur["issues"].append({
                "key": key, "title": title, "type": typ,
                "areas": [a.strip() for a in area.split("·")],
                "deps": [] if dep in ("—", "") else [d.strip() for d in dep.split("·")],
                "criteria": [c.strip() for c in acc.split(" · ") if c.strip()],
                "ids": ids, "milestone": cur["n"],
                "num": int(num.group(1)) if num else None,
            })
    if cur:
        cur["description"] = "\n".join(desc).strip()
    return milestones


def milestone_description(text):
    if len(text) <= MILESTONE_DESC_MAX:
        return text
    return text[:MILESTONE_DESC_MAX - 1].rstrip() + "…"


def issue_title(it):
    return f"[{it['milestone']}] {it['title']}"


def issue_body(it, nums):
    deps = ", ".join(f"#{nums[d]} ({d})" if d in nums else d for d in it["deps"]) or "—"
    crit = "\n".join(f"- [ ] {c}" for c in it["criteria"])
    return (f"## 목표\n{it['title']}\n"
            f"## 수용 기준\n{crit}\n"
            f"## 관련 ID\n{it['ids']}\n"
            f"## 의존\n{deps}\n"
            f"## 로드맵 키\n{it['key']}\n")


# ---------------------------------------------------------------- 발행

def ensure_labels(report):
    existing = {l["name"] for l in gh_list(f"repos/{repo}/labels")}
    for name, color in LABELS:
        if name in existing:
            report["labels_skipped"].append(name)
            continue
        if args.dry_run:
            print(f"[dry-run] 라벨 생성: {name} #{color}")
            report["labels_created"].append(name)
            continue
        try:
            gh("POST", f"repos/{repo}/labels", {"name": name, "color": color})
            report["labels_created"].append(name)
            print(f"라벨 생성: {name}")
        except GhError as e:
            report["failures"].append(f"label {name}: {e}")


def ensure_milestones(milestones, report):
    existing = {m["title"]: m["number"] for m in gh_list(f"repos/{repo}/milestones?state=all")}
    numbers = {}
    for ms in milestones:
        if ms["title"] in existing:
            numbers[ms["n"]] = existing[ms["title"]]
            report["milestones_skipped"].append(ms["title"])
            continue
        desc = milestone_description(ms["description"])
        if args.dry_run:
            print(f"[dry-run] 마일스톤 생성: {ms['title']} (설명 {len(desc)}자)")
            numbers[ms["n"]] = None
            continue
        try:
            res = json.loads(gh("POST", f"repos/{repo}/milestones",
                                {"title": ms["title"], "description": desc}))
            numbers[ms["n"]] = res["number"]
            report["milestones_created"].append(ms["title"])
            print(f"마일스톤 생성: #{res['number']} {ms['title']}")
        except GhError as e:
            report["failures"].append(f"milestone {ms['title']}: {e}")
    return numbers


def milestone_issues(mn):
    """마일스톤의 이슈(열림 · 닫힘 모두, PR 제외)."""
    return [i for i in gh_list(f"repos/{repo}/issues?state=all&milestone={mn}")
            if "pull_request" not in i]


def pick_by_title(candidates):
    """같은 제목 후보 중 열린 것을 먼저, 그 안에서 번호가 가장 작은(먼저 발행된) 것을 고른다."""
    return min(candidates, key=lambda i: (i["state"] != "open", i["number"]))


def describe_state(i):
    if i["state"] == "open":
        return "열림"
    if i.get("state_reason") == "not_planned":
        return "닫힘, 계획 없음"
    return "닫힘"


def find_existing(it, by_num, by_title, report):
    """행에 대응하는 기존 이슈를 찾는다. 행의 '이슈' 열 번호가 먼저, 없으면 같은 제목(ADR-085).
    반환 (이슈 or None, 새로 만들어도 되는지). 행 번호가 그 마일스톤에 없으면 만들지 않고 실패로 보고한다."""
    title = issue_title(it)
    if it.get("num") is not None:
        i = by_num.get(it["num"])
        if i is None:
            report["failures"].append(
                f"issue {it['key']}: 행의 번호 #{it['num']}이 마일스톤 이슈에 없음, 생성하지 않음")
            return None, False
        if i["title"] != title:
            print(f"  제목 차이 (행 번호 #{it['num']} 사용): GitHub '{i['title']}' / 로드맵 '{title}'")
        return i, False
    cands = by_title.get(title, [])
    if len(cands) > 1:
        print(f"  같은 제목 {len(cands)}개: " + ", ".join(
            f"#{c['number']}({describe_state(c)})" for c in sorted(cands, key=lambda c: c["number"])))
    return (pick_by_title(cands) if cands else None), True


def publish_issues(milestones, ms_numbers, report):
    nums = {}      # key -> 이슈 번호
    state = {}     # key -> 현재 GitHub 본문 (새로 만든 이슈는 만든 본문)
    closed = {}    # key -> 닫힌 이슈 (본문을 고치지 않는다)
    for ms in milestones:
        mn = ms_numbers.get(ms["n"])
        if mn is None and not args.dry_run:
            report["failures"].append(f"{ms['title']}: 마일스톤 번호 없음, 이슈 {len(ms['issues'])}개 건너뜀")
            continue
        by_num, by_title = {}, {}
        if mn is not None:
            for i in milestone_issues(mn):
                by_num[i["number"]] = i
                by_title.setdefault(i["title"], []).append(i)
        for it in ms["issues"]:
            title = issue_title(it)
            found, creatable = find_existing(it, by_num, by_title, report)
            if found is not None:
                nums[it["key"]] = found["number"]
                state[it["key"]] = found.get("body") or ""
                if found["state"] != "open":
                    closed[it["key"]] = found
                report["issues_skipped"].append(it["key"])
                print(f"기존({describe_state(found)}): #{found['number']} {title}")
                continue
            if not creatable:
                continue
            body = issue_body(it, nums)
            if args.dry_run:
                report["issues_created"].append(it["key"])
                print(f"[dry-run] 이슈 생성: {title}")
                continue
            payload = {"title": title, "body": body, "milestone": mn,
                       "labels": [f"type:{it['type']}", *[f"area:{a}" for a in it["areas"]]]}
            try:
                res = json.loads(gh("POST", f"repos/{repo}/issues", payload))
                nums[it["key"]] = res["number"]
                state[it["key"]] = body
                report["issues_created"].append(it["key"])
                print(f"이슈 생성: #{res['number']} {title}")
            except GhError as e:
                report["failures"].append(f"issue {it['key']}: {e}")
    return nums, state, closed


def refresh_bodies(milestones, nums, state, closed, report):
    """번호가 정해진 뒤, 본문이 달라진 열린 이슈만 PATCH (생성 당시 번호를 몰랐던 의존 키 포함).
    닫힌 이슈는 고치지 않고 차이만 알린다."""
    for ms in milestones:
        for it in ms["issues"]:
            k = it["key"]
            if k not in nums:
                continue
            want = issue_body(it, nums)
            if (state.get(k) or "").strip() == want.strip():
                continue
            if k in closed:
                report["closed_body_diff"].append(k)
                print(f"닫힌 이슈 본문 차이 (고치지 않음): #{nums[k]} {k}")
                continue
            if args.dry_run:
                report["issues_patched"].append(k)
                print(f"[dry-run] 본문 갱신: #{nums[k]} {k}")
                continue
            try:
                gh("PATCH", f"repos/{repo}/issues/{nums[k]}", {"body": want})
                report["issues_patched"].append(k)
                print(f"본문 갱신: #{nums[k]} {k}")
            except GhError as e:
                report["failures"].append(f"patch {k} (#{nums[k]}): {e}")


def write_back(text, nums):
    out = []
    for line in text.split("\n"):
        m = re.match(r"^\| (M\d+-\d+) \|", line)
        if m and m.group(1) in nums:
            line = re.sub(r"\| [^|]*\|$", f"| #{nums[m.group(1)]} |", line)
        out.append(line)
    return "\n".join(out)


def verify(milestones, ms_numbers, nums, report):
    """표의 행마다 대응 이슈(열림 · 닫힘 모두)가 그 마일스톤에 있는지 확인한다.
    표에 없는 마일스톤 이슈(needs-human 등)는 정보로만 센다."""
    ok = True
    for ms in milestones:
        mn = ms_numbers.get(ms["n"])
        want = len(ms["issues"])
        if mn is None:
            ok = False
            print(f"검증 {ms['title']}: 마일스톤 없음, 표 행={want} 차이")
            report["verify"].append((ms["title"], None, 0, want))
            continue
        issues = {i["number"]: i for i in milestone_issues(mn)}
        rows = [issues.get(nums.get(it["key"])) for it in ms["issues"]]
        missing = [it["key"] for it, i in zip(ms["issues"], rows) if i is None]
        got = want - len(missing)
        n_open = sum(1 for i in rows if i is not None and i["state"] == "open")
        extra = len(issues) - len({i["number"] for i in rows if i is not None})
        flag = "OK" if not missing else "차이"
        ok &= not missing
        print(f"검증 {ms['title']} (#{mn}): 표 행={want}, 대응 이슈={got} "
              f"(열림 {n_open}, 닫힘 {got - n_open}), 표 밖 이슈={extra} {flag}"
              + (f" 대응 없음: {', '.join(missing)}" if missing else ""))
        report["verify"].append((ms["title"], mn, got, want))
    return ok


def main():
    global args, repo
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="GitHub에 쓰지 않고 계획만 출력")
    ap.add_argument("--no-write-back", action="store_true", help="로드맵 '이슈' 열을 갱신하지 않음")
    ap.add_argument("--show", metavar="KEY", help="해당 키의 이슈 본문을 출력 (예: M1-03)")
    ap.add_argument("--repo", default=repo)
    ap.add_argument("--roadmap", default=str(ROADMAP))
    args = ap.parse_args()
    repo = args.repo

    path = Path(args.roadmap)
    text = path.read_text(encoding="utf-8")
    milestones = parse_roadmap(text)
    total = sum(len(m["issues"]) for m in milestones)
    print(f"파싱: 마일스톤 {len(milestones)}개, 이슈 {total}개")
    if args.show:
        for ms in milestones:
            if ms["n"] == args.show.split("-")[0]:
                for it in ms["issues"]:
                    if it["key"] == args.show:
                        print(f"--- {issue_title(it)} / labels: type:{it['type']}, "
                              + ", ".join(f"area:{a}" for a in it["areas"]))
                        print(issue_body(it, {}))

    report = {k: [] for k in ("labels_created", "labels_skipped", "milestones_created",
                              "milestones_skipped", "issues_created", "issues_skipped",
                              "issues_patched", "closed_body_diff", "failures", "verify")}
    ensure_labels(report)
    ms_numbers = ensure_milestones(milestones, report)
    nums, state, closed = publish_issues(milestones, ms_numbers, report)
    refresh_bodies(milestones, nums, state, closed, report)

    if not args.dry_run and not args.no_write_back:
        path.write_text(write_back(text, nums), encoding="utf-8")
        print(f"로드맵 '이슈' 열 갱신: {len(nums)}행")
    verify(milestones, ms_numbers, nums, report)

    print("\n== 요약 ==")
    print(f"라벨 생성 {len(report['labels_created'])}, 건너뜀 {len(report['labels_skipped'])}")
    print(f"마일스톤 생성 {len(report['milestones_created'])}, 재사용 {len(report['milestones_skipped'])}")
    prefix = "[dry-run 예정] " if args.dry_run else ""
    print(f"{prefix}이슈 생성 {len(report['issues_created'])}건, "
          f"건너뜀(기존) {len(report['issues_skipped'])}건 (닫힘 {len(closed)}건), "
          f"본문 갱신 {len(report['issues_patched'])}건, "
          f"닫힌 이슈 본문 차이 {len(report['closed_body_diff'])}건(고치지 않음)")
    print("마일스톤 번호:", {m["title"]: ms_numbers.get(m["n"]) for m in milestones})
    print("키 -> 번호:", json.dumps(nums, ensure_ascii=False))
    if report["failures"]:
        print("실패:")
        for f in report["failures"]:
            print("  -", f)
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
