#!/usr/bin/env python3
"""scripts/publish-roadmap.py 재발행 시험 (M2-05). GitHub를 부르지 않는다.

gh() · gh_list()를 가짜 GitHub(메모리)로 갈아 끼우고 main()을 임시 로드맵 파일에 대고 돌린다.
실행: python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("publish_roadmap", HERE / "publish-roadmap.py")
pr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pr)

REPO = "o/r"
MS_TITLE = "M9 시험"


def roadmap(rows):
    """rows: [(키, 제목, 이슈 열)] -> 최소 로드맵 문서."""
    lines = [
        "# 로드맵", "", "## 2. 마일스톤", "", f"### 2.1 {MS_TITLE}", "",
        "**목표**: 시험용.", "", "**범위 밖**: 없음.", "",
        "| 키 | 제목 | 유형 | 영역 | 의존 | 수용 기준 | 관련 ID | 이슈 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for key, title, issue in rows:
        lines.append(f"| {key} | {title} | chore | ci | — | 기준 하나 · 기준 둘 | ADR-015 | {issue} |")
    lines += ["", "## 3. 커버리지", ""]
    return "\n".join(lines)


def row_body(key, title):
    it = {"key": key, "title": title, "deps": [], "criteria": ["기준 하나", "기준 둘"], "ids": "ADR-015"}
    return pr.issue_body(it, {})


class FakeGitHub:
    """라벨 · 마일스톤은 이미 있고, 이슈 목록만 사례마다 다르다. 모든 호출을 calls에 남긴다."""

    def __init__(self, issues):
        self.issues = issues
        self.calls = []
        self.next_number = 1000

    def gh_list(self, path):
        self.calls.append(("GET", path))
        if path == f"repos/{REPO}/labels":
            return [{"name": n} for n, _ in pr.LABELS]
        if path == f"repos/{REPO}/milestones?state=all":
            return [{"title": MS_TITLE, "number": 9}]
        if path == f"repos/{REPO}/issues?state=all&milestone=9":
            return [dict(i) for i in self.issues]
        raise AssertionError(f"예상하지 않은 목록 호출: {path}")

    def gh(self, method, path, payload=None, extra=()):
        self.calls.append((method, path))
        if method == "POST" and path == f"repos/{REPO}/issues":
            self.next_number += 1
            self.issues.append({"number": self.next_number, "title": payload["title"],
                                "state": "open", "body": payload["body"]})
            return json.dumps({"number": self.next_number})
        if method == "PATCH":
            n = int(path.rsplit("/", 1)[1])
            next(i for i in self.issues if i["number"] == n)["body"] = payload["body"]
            return "{}"
        raise AssertionError(f"예상하지 않은 호출: {method} {path}")

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]

    def created(self):
        return [c for c in self.calls if c[0] == "POST"]

    def patched(self):
        return [c for c in self.calls if c[0] == "PATCH"]


def issue(number, title, state="closed", body="", reason=None):
    return {"number": number, "title": title, "state": state, "body": body,
            "state_reason": reason or ("completed" if state == "closed" else None)}


class PublishRoadmapTest(unittest.TestCase):
    def run_main(self, fake, rows, *flags):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "roadmap.md"
        path.write_text(roadmap(rows), encoding="utf-8")
        out = io.StringIO()
        argv = ["publish-roadmap.py", "--repo", REPO, "--roadmap", str(path), *flags]
        with mock.patch.object(pr, "gh", fake.gh), mock.patch.object(pr, "gh_list", fake.gh_list), \
                mock.patch.object(sys, "argv", argv), redirect_stdout(out):
            code = pr.main()
        return code, out.getvalue(), path.read_text(encoding="utf-8")

    def test_closed_issue_same_title_is_not_recreated(self):
        title = "닫힌 것"
        fake = FakeGitHub([issue(5, f"[M9] {title}", body=row_body("M9-01", title))])
        code, out, text = self.run_main(fake, [("M9-01", title, "—")])
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.created(), [])
        self.assertIn("| #5 |", text)
        self.assertIn("기존(닫힘): #5", out)
        self.assertIn("이슈 생성 0건", out)

    def test_open_preferred_over_closed_with_same_title(self):
        title = "같은 제목"
        t = f"[M9] {title}"
        body = row_body("M9-01", title)
        fake = FakeGitHub([issue(3, t, body=body), issue(7, t, state="open", body=body),
                           issue(4, t, body=body)])
        code, out, text = self.run_main(fake, [("M9-01", title, "—")])
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.created(), [])
        self.assertIn("| #7 |", text)
        self.assertIn("같은 제목 3개", out)

    def test_closed_issue_body_difference_is_reported_not_patched(self):
        title = "본문 바뀐 닫힌 것"
        fake = FakeGitHub([issue(5, f"[M9] {title}", body="## 목표\n구현을 반영해 고친 본문\n")])
        code, out, _ = self.run_main(fake, [("M9-01", title, "#5")])
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.writes(), [])
        self.assertIn("닫힌 이슈 본문 차이 (고치지 않음): #5 M9-01", out)
        self.assertIn("닫힌 이슈 본문 차이 1건", out)

    def test_open_issue_body_difference_is_still_patched(self):
        title = "열린 것"
        fake = FakeGitHub([issue(6, f"[M9] {title}", state="open", body="낡은 본문")])
        code, out, _ = self.run_main(fake, [("M9-01", title, "#6")])
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.patched(), [("PATCH", f"repos/{REPO}/issues/6")])
        self.assertEqual(fake.created(), [])

    def test_row_number_wins_over_title_mismatch(self):
        title = "로드맵 제목"
        fake = FakeGitHub([issue(8, f"[M9] {title} (검수 결함)", body=row_body("M9-01", title),
                                 reason="not_planned")])
        code, out, text = self.run_main(fake, [("M9-01", title, "#8")])
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.created(), [])
        self.assertIn("| #8 |", text)
        self.assertIn("제목 차이 (행 번호 #8 사용)", out)
        self.assertIn("기존(닫힘, 계획 없음): #8", out)

    def test_row_number_missing_from_milestone_is_not_created(self):
        fake = FakeGitHub([])
        code, out, text = self.run_main(fake, [("M9-01", "번호만 있음", "#99")])
        self.assertEqual(code, 1, out)
        self.assertEqual(fake.created(), [])
        self.assertIn("행의 번호 #99이 마일스톤 이슈에 없음", out)
        self.assertIn("| #99 |", text)

    def test_really_new_row_is_created_once(self):
        old = "닫힌 것"
        fake = FakeGitHub([issue(5, f"[M9] {old}", body=row_body("M9-01", old))])
        code, out, text = self.run_main(fake, [("M9-01", old, "#5"), ("M9-02", "새 것", "—")])
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.created(), [("POST", f"repos/{REPO}/issues")])
        self.assertIn("| M9-02 | 새 것 | chore | ci | — | 기준 하나 · 기준 둘 | ADR-015 | #1001 |", text)
        self.assertRegex(out, r"검증 M9 시험 \(#9\): 표 행=2, 대응 이슈=2 \(열림 1, 닫힘 1\), 표 밖 이슈=0 OK")

    def test_dry_run_makes_no_write_calls_and_compares_closed(self):
        old = "닫힌 것"
        fake = FakeGitHub([issue(5, f"[M9] {old}", body="다른 본문"),
                           issue(6, "[M9] 열린 것", state="open", body="낡은 본문"),
                           issue(7, "[needs-human] 표 밖", state="open")])
        rows = [("M9-01", old, "#5"), ("M9-02", "열린 것", "#6"), ("M9-03", "새 것", "—")]
        code, out, text = self.run_main(fake, rows, "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertEqual(fake.writes(), [])
        self.assertEqual(text, roadmap(rows))
        self.assertIn("[dry-run] 이슈 생성: [M9] 새 것", out)
        self.assertIn("[dry-run 예정] 이슈 생성 1건", out)
        self.assertIn("본문 갱신 1건", out)
        self.assertIn("닫힌 이슈 본문 차이 1건", out)
        self.assertRegex(out, r"표 행=3, 대응 이슈=2 \(열림 1, 닫힘 1\), 표 밖 이슈=1 차이 대응 없음: M9-03")

    def test_gh_blocks_non_get_calls_in_dry_run(self):
        with mock.patch.object(pr, "args", mock.Mock(dry_run=True)), \
                mock.patch.object(pr.subprocess, "run") as run:
            for method in ("POST", "PATCH", "PUT", "DELETE"):
                with self.assertRaises(pr.DryRunWriteBlocked):
                    pr.gh(method, f"repos/{REPO}/issues", {"title": "x"})
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
