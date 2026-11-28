#!/usr/bin/env python3
""".github/workflows/ci.yml 의 잡 제한 시간 · 집계 잡의 needs · 잡 이름 시험 (M3-52 · M3-61, ADR-138 · ADR-154).

CI 러너의 기본 파이썬에 YAML 파서가 있다고 기대하지 않으므로 표준 라이브러리만 쓴다.
`jobs:` 아래 두 칸 들여쓴 잡 키로 잡 블록을 나누고, 블록 안의 네 칸 들여쓴 키 값을 읽는다.

실행: python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import re
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "ci.yml"

_JOB_KEY = re.compile(r"^  ([A-Za-z0-9_-]+):\s*(#.*)?$")
_TOP_KEY = re.compile(r"^\S")


def job_blocks(text):
    """{잡 키: [블록의 줄]}. `jobs:` 밖의 줄과 주석 · 빈 줄은 잡 경계로 치지 않는다."""
    lines = text.splitlines()
    try:
        start = lines.index("jobs:")
    except ValueError:
        raise ValueError("최상위 `jobs:` 줄이 없다")
    blocks = {}
    current = None
    for line in lines[start + 1 :]:
        if _TOP_KEY.match(line) and not line.startswith("#"):
            break
        m = _JOB_KEY.match(line)
        if m:
            current = m.group(1)
            if current in blocks:
                raise ValueError(f"잡 키가 두 번 나온다: {current}")
            blocks[current] = []
        elif current is not None:
            blocks[current].append(line)
    return blocks


def job_value(blocks, job, key):
    """잡 블록에서 네 칸 들여쓴 `key:`의 값(글자 그대로). 없거나 두 번 나오면 오류."""
    if job not in blocks:
        raise KeyError(f"잡이 없다: {job}")
    pat = re.compile(rf"^    {re.escape(key)}:\s*(.*?)\s*$")
    found = [m.group(1) for m in (pat.match(line) for line in blocks[job]) if m]
    if len(found) != 1:
        raise ValueError(f"{job}.{key}가 {len(found)}번 나온다")
    return found[0]


def timeout_minutes(blocks, job):
    raw = job_value(blocks, job, "timeout-minutes")
    if not re.fullmatch(r"\d+", raw):
        raise ValueError(f"{job}.timeout-minutes가 정수가 아니다: {raw!r}")
    return int(raw)


def needs(blocks, job):
    """`needs: [a, b]` 또는 `needs: a` 모양만 읽는다(여러 줄 목록은 오류)."""
    raw = job_value(blocks, job, "needs")
    m = re.fullmatch(r"\[(.*)\]", raw)
    if m:
        return [item.strip() for item in m.group(1).split(",") if item.strip()]
    if not raw:
        raise ValueError(f"{job}.needs가 여러 줄 목록이라 읽지 않는다")
    return [raw]


class CiWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.blocks = job_blocks(WORKFLOW.read_text(encoding="utf-8"))

    def test_checks_timeout_is_40(self):
        # ADR-154: 30 → 40
        self.assertEqual(timeout_minutes(self.blocks, "checks"), 40)

    def test_pipeline_group_timeout_is_40(self):
        self.assertEqual(timeout_minutes(self.blocks, "pipeline-e2e-group"), 40)

    def test_aggregate_job_timeouts_unchanged(self):
        self.assertEqual(timeout_minutes(self.blocks, "pipeline-e2e"), 5)
        self.assertEqual(timeout_minutes(self.blocks, "ci"), 5)

    def test_aggregate_job_needs_unchanged(self):
        self.assertEqual(needs(self.blocks, "ci"), ["checks", "pipeline-e2e"])
        self.assertEqual(needs(self.blocks, "pipeline-e2e"), ["pipeline-e2e-group"])

    def test_job_names_unchanged(self):
        # 잡 키 네 개와 그 이름. `ci`는 브랜치 보호의 필수 검사 이름이고 CLAUDE.md 5장이 세 검사를 이 이름으로 부른다 (ADR-154)
        self.assertEqual(sorted(self.blocks), sorted(["checks", "pipeline-e2e-group", "pipeline-e2e", "ci"]))
        self.assertEqual(job_value(self.blocks, "checks", "name"), "checks")
        self.assertEqual(
            job_value(self.blocks, "pipeline-e2e-group", "name"),
            "pipeline-e2e-group (${{ matrix.group }})",
        )
        self.assertEqual(job_value(self.blocks, "pipeline-e2e", "name"), "pipeline-e2e")
        self.assertEqual(job_value(self.blocks, "ci", "name"), "ci")


class ParserTest(unittest.TestCase):
    """읽는 함수가 다른 잡 · 더 깊은 줄의 값을 잘못 집지 않는지."""

    SAMPLE = "\n".join(
        [
            "name: ci",
            "jobs:",
            "  # 주석",
            "  a:",
            "    timeout-minutes: 7",
            "    steps:",
            "      - name: x",
            "        timeout-minutes: 99",
            "",
            "  b:",
            "    needs: [a]",
            "    timeout-minutes: 3",
            "  c:",
            "    needs: a",
            "  d:",
            "    needs:",
            "      - a",
            "",
        ]
    )

    def setUp(self):
        self.blocks = job_blocks(self.SAMPLE)

    def test_reads_job_level_value_only(self):
        self.assertEqual(timeout_minutes(self.blocks, "a"), 7)
        self.assertEqual(timeout_minutes(self.blocks, "b"), 3)

    def test_needs_forms(self):
        self.assertEqual(needs(self.blocks, "b"), ["a"])
        self.assertEqual(needs(self.blocks, "c"), ["a"])
        with self.assertRaises(ValueError):
            needs(self.blocks, "d")

    def test_missing_job_or_key(self):
        with self.assertRaises(KeyError):
            timeout_minutes(self.blocks, "z")
        with self.assertRaises(ValueError):
            timeout_minutes(self.blocks, "c")

    def test_duplicate_key_rejected(self):
        blocks = job_blocks("jobs:\n  a:\n    timeout-minutes: 1\n    timeout-minutes: 2\n")
        with self.assertRaises(ValueError):
            timeout_minutes(blocks, "a")


if __name__ == "__main__":
    unittest.main()
