#!/usr/bin/env python3
"""docs/roadmap.md 를 GitHub 라벨 · 마일스톤 · 이슈로 발행하고 이슈 번호를 로드맵에 되써 넣는다.

절차: .claude/skills/publish-roadmap/SKILL.md, 형식: docs/roadmap-format.md.
멱등: 이미 있는 라벨 · 마일스톤은 재사용한다. 이슈는 열림 · 닫힘을 가리지 않고 기존 이슈를 찾으면
만들지 않고 번호만 기록한다(행의 '이슈' 열 번호 우선, 없으면 같은 제목. ADR-085).
닫힌 이슈의 본문은 고치지 않고, 로드맵과 다르면 '닫힌 이슈 본문 차이'로 알리기만 한다.
열린 이슈 본문은 로드맵이 만드는 절만 비교 · 갱신하고 사람이 더한 절과 꼬리말은 그대로 둔다(ADR-086).
검증은 표 행마다 대응 이슈가 있고 겹치지 않는지 보며, 차이는 종료 코드 1이다.
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


PER_PAGE = 100
MAX_PAGES = 50


def gh_list(path):
    """목록 전체. `--paginate`는 다음 페이지 링크(repositories/<id>/...)를 이 환경의 프록시가 거부하므로
    page 번호를 1부터 올려 가며 읽고, 한 페이지가 PER_PAGE보다 적게(빈 페이지 포함) 오면 멈춘다.
    API가 page를 무시해 늘 꽉 찬 페이지를 주는 경우에 끝없이 돌지 않도록 MAX_PAGES쪽을 넘으면 실패로 멈춘다."""
    sep = "&" if "?" in path else "?"
    items, page = [], 1
    while True:
        if page > MAX_PAGES:
            raise GhError(f"목록 {path}: {MAX_PAGES}쪽({MAX_PAGES * PER_PAGE}개)을 넘음, 읽기 중단")
        out = gh("GET", f"{path}{sep}per_page={PER_PAGE}&page={page}", extra=("-q", ".[]|tojson"))
        got = [json.loads(line) for line in out.splitlines() if line.strip()]
        items += got
        if len(got) < PER_PAGE:
            return items
        page += 1


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


# 로드맵이 만드는 절의 제목. 이 순서로 본문을 만들고(issue_body), 재발행은 이 절만 비교 · 갱신한다(ADR-086).
SECTION_GOAL, SECTION_CRITERIA, SECTION_IDS, SECTION_DEPS, SECTION_KEY = (
    "목표", "수용 기준", "관련 ID", "의존", "로드맵 키")
ROADMAP_SECTIONS = (SECTION_GOAL, SECTION_CRITERIA, SECTION_IDS, SECTION_DEPS, SECTION_KEY)
# 로드맵이 한 줄만 만드는 절. 줄이 더 있으면 사람이 쓴 것으로 보고 고치지 않는다(수동 확인 필요).
SINGLE_LINE_SECTIONS = (SECTION_IDS, SECTION_DEPS, SECTION_KEY)


def issue_sections(it, nums):
    """로드맵 절 제목 -> 내용 줄 목록."""
    deps = ", ".join(f"#{nums[d]} ({d})" if d in nums else d for d in it["deps"]) or "—"
    return {
        SECTION_GOAL: [it["title"]],
        SECTION_CRITERIA: [f"- [ ] {c}" for c in it["criteria"]],
        SECTION_IDS: [it["ids"]],
        SECTION_DEPS: [deps],
        SECTION_KEY: [it["key"]],
    }


def issue_body(it, nums):
    sections = issue_sections(it, nums)
    return "".join(f"## {name}\n" + "".join(f"{l}\n" for l in sections[name])
                   for name in ROADMAP_SECTIONS)


# ---------------------------------------------------------------- 본문 절 대조 (ADR-086)

FOOTER_RE = re.compile(r"^_Generated by .*_$")
CHECK_RE = re.compile(r"^- \[([ xX])\] (.*)$")


def split_body(body):
    """본문 -> (머리 줄, [(절 제목, 제목 줄, 내용 줄)], 꼬리말 줄) 또는 None(구조를 알아볼 수 없음).
    꼬리말은 끝의 `---` 줄과 생성 표시 줄(그 앞뒤 빈 줄 포함). 코드 블록 안의 `## `는 제목으로 보지 않는다."""
    lines = (body or "").replace("\r\n", "\n").split("\n")
    end = len(lines)
    while end and not lines[end - 1].strip():
        end -= 1
    footer_start = end
    if end and FOOTER_RE.match(lines[end - 1].strip()):
        j = end - 1
        while j and not lines[j - 1].strip():
            j -= 1
        if j and lines[j - 1].strip() == "---":
            footer_start = j - 1
            while footer_start and not lines[footer_start - 1].strip():
                footer_start -= 1
    head, sections, fence = [], [], False
    for line in lines[:footer_start]:
        if line.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"^## (.+?)\s*$", line)
        if m:
            sections.append((m.group(1), line, []))
        elif sections:
            sections[-1][2].append(line)
        else:
            head.append(line)
    if any(l.strip() for l in head) or not sections:
        return None
    return head, sections, lines[footer_start:]


def norm(lines):
    """줄 끝 공백과 앞뒤 빈 줄을 무시한 내용."""
    out = [l.rstrip() for l in lines]
    while out and not out[0]:
        out.pop(0)
    while out and not out[-1]:
        out.pop()
    return out


def merge_criteria(have, want):
    """수용 기준 절. 항목 문장이 같으면 사람이 한 체크 표시를 살린 새 내용, 체크리스트가 아닌 줄이 있으면 None."""
    checked = {}
    for l in norm(have):
        m = CHECK_RE.match(l)
        if not m:
            return None
        if m.group(1) != " ":
            checked[m.group(2).strip()] = m.group(1)
    out = []
    for l in want:
        m = CHECK_RE.match(l)
        mark = checked.get(m.group(2).strip(), " ")
        out.append(f"- [{mark}] {m.group(2)}")
    return out


def plan_body(current, it, nums):
    """현재 본문과 로드맵 행을 절 단위로 대조한다.
    반환 {'status': 'same' | 'update' | 'manual', 'body': 고친 본문 or None, 'changed': [절], 'notes': [문장]}.
    - 비교 대상은 로드맵 절만이다. 사람이 더한 절 · 머리 · 꼬리말은 비교하지 않고 그대로 둔다.
    - 목표는 사람이 문장으로 고쳐 쓸 수 있는 절(roadmap-format 4장)이라 다르면 알리기만 하고 고치지 않는다.
    - 로드맵 키는 첫 낱말이 키와 같으면 같다고 본다(`M2-05 (M1 후속)` 같은 덧붙임 허용).
    - 수용 기준은 항목 문장으로 비교하고, 고칠 때 문장이 같은 항목의 체크 표시는 살린다.
    - 로드맵 절이 없거나 둘 이상이거나 구조를 알아볼 수 없으면 고치지 않고 'manual'.
    - 꼬리말은 끝의 `---` 줄 + `_Generated by …_` 줄 모양만 알아본다. 다른 모양은 마지막 절의 내용으로 읽히지만,
      한 줄 절(관련 ID · 의존 · 로드맵 키)과 수용 기준 절은 로드맵이 만들지 않은 줄이 있으면 'manual'이라 지워지지 않는다."""
    want = issue_sections(it, nums)
    parsed = split_body(current)
    if parsed is None:
        return {"status": "manual", "body": None, "changed": [], "notes": ["절 구조를 알아볼 수 없음"]}
    head, sections, footer = parsed
    names = [s[0] for s in sections]
    bad = [n for n in ROADMAP_SECTIONS if names.count(n) != 1]
    if bad:
        notes = [f"'{n}' 절 {names.count(n)}개" for n in bad]
        return {"status": "manual", "body": None, "changed": [], "notes": notes}
    changed, notes, new_sections = [], [], []
    for name, heading, content in sections:
        if name not in ROADMAP_SECTIONS:
            new_sections.append((heading, content))
            continue
        have, target = norm(content), want[name]
        if name == SECTION_GOAL:
            if have != target:
                notes.append("목표 문장 다름(고치지 않음)")
            new_sections.append((heading, content))
            continue
        if name in SINGLE_LINE_SECTIONS and len(have) > 1:
            # 한 줄 절에 로드맵이 만들지 않은 줄(사람 메모, 알아보지 못한 꼬리말 등)이 있으면 값이 달라도 고치지 않는다
            return {"status": "manual", "body": None, "changed": [],
                    "notes": [f"'{name}' 절에 로드맵이 만들지 않은 줄"]}
        if name == SECTION_KEY:
            first = have[0].split()[0] if have and have[0].split() else ""
            if len(have) == 1 and first == it["key"]:
                new_sections.append((heading, content))
                continue
        if name == SECTION_CRITERIA:
            merged = merge_criteria(content, target)
            if merged is None:
                return {"status": "manual", "body": None, "changed": [],
                        "notes": ["수용 기준 절에 체크리스트가 아닌 줄"]}
            target = merged
        if have == target:
            new_sections.append((heading, content))
            continue
        changed.append(name)
        # 절 끝의 빈 줄(다음 절과의 간격)은 그대로 둔다
        trail = 0
        while trail < len(content) and not content[-1 - trail].strip():
            trail += 1
        new_sections.append((heading, target + content[len(content) - trail:]))
    if not changed:
        return {"status": "same", "body": None, "changed": [], "notes": notes}
    out = list(head)
    for heading, content in new_sections:
        out += [heading, *content]
    body = "\n".join(out + footer)
    return {"status": "update", "body": body, "changed": changed, "notes": notes}


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


def why_not_in_milestone(n, ms_title):
    """행 번호가 그 마일스톤의 이슈 목록에 없을 때 원인을 GET 한 번으로 가린다."""
    try:
        i = json.loads(gh("GET", f"repos/{repo}/issues/{n}"))
    except GhError:
        return "GitHub에 없는 번호"
    if "pull_request" in i:
        return "풀 리퀘스트 번호"
    other = (i.get("milestone") or {}).get("title")
    if other is None:
        return "마일스톤이 없는 이슈"
    if other != ms_title:
        return f"다른 마일스톤({other})의 이슈"
    return "마일스톤 이슈 목록에 없음"


def claim_row_numbers(ms, by_num, report):
    """행에 적힌 번호를 먼저 예약한다(ADR-085 · ADR-086). 반환 {번호: 키}.
    마일스톤에 없는 번호와 다른 행이 이미 잡은 번호는 예약하지 않고 실패로 보고한다."""
    claimed = {}
    for it in ms["issues"]:
        n = it.get("num")
        if n is None:
            continue
        if n not in by_num:
            report["failures"].append(
                f"issue {it['key']}: 행의 번호 #{n}이 {why_not_in_milestone(n, ms['title'])}, 생성하지 않음")
        elif n in claimed:
            report["failures"].append(
                f"issue {it['key']}: 중복 대응, 행의 번호 #{n}은 이미 {claimed[n]} 행이 씀")
        else:
            claimed[n] = it["key"]
    return claimed


def find_existing(it, by_num, by_title, claimed, report):
    """행에 대응하는 기존 이슈를 찾는다. 행의 '이슈' 열 번호가 먼저, 없으면 같은 제목(ADR-085).
    반환 (이슈 or None, 새로 만들어도 되는지). 행 번호가 예약되지 못했으면 만들지 않는다(실패는 이미 보고됨).
    같은 제목 후보는 다른 행이 잡은 번호를 빼고 고르고, 후보가 모두 다른 행의 것이면 만들지 않고 실패로 보고한다."""
    title = issue_title(it)
    if it.get("num") is not None:
        if claimed.get(it["num"]) != it["key"]:
            return None, False
        i = by_num[it["num"]]
        if i["title"] != title:
            print(f"  제목 차이 (행 번호 #{it['num']} 사용): GitHub '{i['title']}' / 로드맵 '{title}'")
        return i, False
    all_cands = by_title.get(title, [])
    cands = [c for c in all_cands if c["number"] not in claimed]
    if all_cands and not cands:
        report["failures"].append(
            f"issue {it['key']}: 중복 대응, 같은 제목 이슈 " + ", ".join(
                f"#{c['number']}({claimed[c['number']]})" for c in all_cands)
            + "가 이미 다른 행에 대응, 생성하지 않음")
        return None, False
    if len(cands) > 1:
        print(f"  같은 제목 {len(cands)}개: " + ", ".join(
            f"#{c['number']}({describe_state(c)})" for c in sorted(cands, key=lambda c: c["number"])))
    if cands:
        found = pick_by_title(cands)
        claimed[found["number"]] = it["key"]
        return found, True
    return None, True


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
        claimed = claim_row_numbers(ms, by_num, report)
        for it in ms["issues"]:
            title = issue_title(it)
            found, creatable = find_existing(it, by_num, by_title, claimed, report)
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
    """번호가 정해진 뒤, 로드맵 절의 내용이 달라진 열린 이슈만 그 절을 바꿔 PATCH (생성 당시 번호를 몰랐던
    의존 키 포함). 사람이 더한 절 · 꼬리말은 그대로 둔다. 구조를 알아볼 수 없으면 고치지 않고 '수동 확인 필요'.
    닫힌 이슈는 고치지 않고 차이만 알린다 (ADR-085 · ADR-086)."""
    for ms in milestones:
        for it in ms["issues"]:
            k = it["key"]
            if k not in nums:
                continue
            plan = plan_body(state.get(k) or "", it, nums)
            if plan["notes"] and plan["status"] != "manual":
                report["body_notes"].append(k)
                print(f"본문 참고: #{nums[k]} {k}: {', '.join(plan['notes'])}")
            if plan["status"] == "same":
                continue
            what = ", ".join(plan["changed"]) if plan["status"] == "update" else ", ".join(plan["notes"])
            if k in closed:
                report["closed_body_diff"].append(k)
                print(f"닫힌 이슈 본문 차이 (고치지 않음): #{nums[k]} {k} ({what})")
                continue
            if plan["status"] == "manual":
                report["body_manual"].append(k)
                print(f"본문 수동 확인 필요 (고치지 않음): #{nums[k]} {k} ({what})")
                continue
            if args.dry_run:
                report["issues_patched"].append(k)
                print(f"[dry-run] 본문 갱신: #{nums[k]} {k} ({what})")
                continue
            try:
                gh("PATCH", f"repos/{repo}/issues/{nums[k]}", {"body": plan["body"]})
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
    """표의 행마다 대응 이슈(열림 · 닫힘 모두)가 그 마일스톤에 있고 두 행이 한 이슈를 함께 쓰지 않는지 확인한다.
    차이는 실패로 보고해 종료 코드에 반영한다. dry-run에서 생성 예정인 행 · 마일스톤은 차이로 치지 않는다.
    표에 없는 마일스톤 이슈(needs-human 등)는 번호와 제목을 나열만 한다 (ADR-086)."""
    ok = True
    planned = set(report["issues_created"]) if args.dry_run else set()
    owners = {}
    for k, n in nums.items():
        owners.setdefault(n, []).append(k)
    for ms in milestones:
        mn = ms_numbers.get(ms["n"])
        want = len(ms["issues"])
        if mn is None:
            if args.dry_run:
                print(f"검증 {ms['title']}: 마일스톤 생성 예정, 표 행={want}")
                continue
            ok = False
            print(f"검증 {ms['title']}: 마일스톤 없음, 표 행={want} 차이")
            report["failures"].append(f"검증 {ms['title']}: 마일스톤 없음")
            report["verify"].append((ms["title"], None, 0, want))
            continue
        issues = {i["number"]: i for i in milestone_issues(mn)}
        rows = [issues.get(nums.get(it["key"])) for it in ms["issues"]]
        keys = [it["key"] for it in ms["issues"]]
        missing = [k for k, i in zip(keys, rows) if i is None and k not in planned]
        pending = [k for k, i in zip(keys, rows) if i is None and k in planned]
        dup = sorted({i["number"] for i in rows if i is not None and len(owners[i["number"]]) > 1})
        got = sum(1 for i in rows if i is not None)
        n_open = sum(1 for i in rows if i is not None and i["state"] == "open")
        mapped = {i["number"] for i in rows if i is not None}
        extra = [i for n, i in sorted(issues.items()) if n not in mapped]
        bad = bool(missing or dup)
        ok &= not bad
        print(f"검증 {ms['title']} (#{mn}): 표 행={want}, 대응 이슈={got} "
              f"(열림 {n_open}, 닫힘 {got - n_open}), 표 밖 이슈={len(extra)} {'차이' if bad else 'OK'}"
              + (f" 대응 없음: {', '.join(missing)}" if missing else "")
              + (f" 중복 대응: " + ", ".join(f"#{n}({'·'.join(owners[n])})" for n in dup) if dup else "")
              + (f" 생성 예정: {', '.join(pending)}" if pending else ""))
        for i in extra:
            print(f"  표 밖 이슈: #{i['number']} ({describe_state(i)}) {i['title']}")
        if missing:
            report["failures"].append(f"검증 {ms['title']}: 대응 이슈 없음 {', '.join(missing)}")
        if dup:
            report["failures"].append(f"검증 {ms['title']}: 중복 대응 " + ", ".join(f"#{n}" for n in dup))
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
                              "issues_patched", "body_manual", "body_notes", "closed_body_diff",
                              "failures", "verify")}
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
          f"본문 수동 확인 필요 {len(report['body_manual'])}건(고치지 않음), "
          f"본문 참고 {len(report['body_notes'])}건, "
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
