#!/usr/bin/env python3
"""docs/roadmap.md 를 GitHub 라벨 · 마일스톤 · 이슈로 발행하고 이슈 번호를 로드맵에 되써 넣는다.

절차: .claude/skills/publish-roadmap/SKILL.md, 형식: docs/roadmap-format.md.
멱등: 이미 있는 라벨 · 마일스톤은 재사용하고, 같은 제목의 열린 이슈가 있으면 만들지 않고 번호만 기록한다.
GitHub 호출은 전부 scripts/gh-rest.sh(= gh api)로 한다.

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


def gh(method, path, payload=None, extra=()):
    """gh-rest.sh 호출. 요청 사이 1초 대기, 403/429면 60초 뒤 1회 재시도."""
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
            cur["issues"].append({
                "key": key, "title": title, "type": typ,
                "areas": [a.strip() for a in area.split("·")],
                "deps": [] if dep in ("—", "") else [d.strip() for d in dep.split("·")],
                "criteria": [c.strip() for c in acc.split(" · ") if c.strip()],
                "ids": ids, "milestone": cur["n"],
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


def publish_issues(milestones, ms_numbers, report):
    nums = {}      # key -> 이슈 번호
    state = {}     # key -> {'body': 현재 GitHub 본문 or None}
    for ms in milestones:
        mn = ms_numbers.get(ms["n"])
        if mn is None and not args.dry_run:
            report["failures"].append(f"{ms['title']}: 마일스톤 번호 없음, 이슈 {len(ms['issues'])}개 건너뜀")
            continue
        existing = {}
        if mn is not None:
            for i in gh_list(f"repos/{repo}/issues?state=all&milestone={mn}"):
                if "pull_request" in i or i["state"] != "open":
                    continue
                existing.setdefault(i["title"], i)
        for it in ms["issues"]:
            title = issue_title(it)
            if title in existing:
                nums[it["key"]] = existing[title]["number"]
                state[it["key"]] = existing[title].get("body") or ""
                report["issues_skipped"].append(it["key"])
                print(f"기존: #{nums[it['key']]} {title}")
                continue
            body = issue_body(it, nums)
            if args.dry_run:
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
    return nums, state


def refresh_bodies(milestones, nums, state, report):
    """번호가 정해진 뒤, 본문이 달라진 이슈만 PATCH (생성 당시 번호를 몰랐던 의존 키 포함)."""
    for ms in milestones:
        for it in ms["issues"]:
            k = it["key"]
            if k not in nums:
                continue
            want = issue_body(it, nums)
            if (state.get(k) or "").strip() == want.strip():
                continue
            if args.dry_run:
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


def verify(milestones, ms_numbers, report):
    ok = True
    for ms in milestones:
        mn = ms_numbers.get(ms["n"])
        if mn is None:
            continue
        got = json.loads(gh("GET", f"repos/{repo}/milestones/{mn}"))["open_issues"]
        want = len(ms["issues"])
        flag = "OK" if got == want else "차이"
        ok &= got == want
        print(f"검증 {ms['title']} (#{mn}): open_issues={got}, 표 행={want} {flag}")
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
                              "issues_patched", "failures", "verify")}
    ensure_labels(report)
    ms_numbers = ensure_milestones(milestones, report)
    nums, state = publish_issues(milestones, ms_numbers, report)
    refresh_bodies(milestones, nums, state, report)

    if not args.dry_run:
        if not args.no_write_back:
            path.write_text(write_back(text, nums), encoding="utf-8")
            print(f"로드맵 '이슈' 열 갱신: {len(nums)}행")
        verify(milestones, ms_numbers, report)

    print("\n== 요약 ==")
    print(f"라벨 생성 {len(report['labels_created'])}, 건너뜀 {len(report['labels_skipped'])}")
    print(f"마일스톤 생성 {len(report['milestones_created'])}, 재사용 {len(report['milestones_skipped'])}")
    print(f"이슈 생성 {len(report['issues_created'])}, 건너뜀 {len(report['issues_skipped'])}, "
          f"본문 갱신 {len(report['issues_patched'])}")
    print("마일스톤 번호:", {m["title"]: ms_numbers.get(m["n"]) for m in milestones})
    print("키 -> 번호:", json.dumps(nums, ensure_ascii=False))
    if report["failures"]:
        print("실패:")
        for f in report["failures"]:
            print("  -", f)
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
