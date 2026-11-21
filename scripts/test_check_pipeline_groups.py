#!/usr/bin/env python3
"""scripts/check-pipeline-groups.py 시험 (M3-24). 임시 시험 폴더와 가짜 vitest json 보고서로 돈다.

실행: python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("check_pipeline_groups", HERE / "check-pipeline-groups.py")
cg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cg)

REL_DIR = "packages/orchestrator/e2e/pipeline"
# 보고서를 만든 러너의 작업 경로. 대조하는 쪽과 달라도 된다
RUNNER = "/home/runner/work/bive/bive"


class CheckPipelineGroupsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.test_dir = self.root / REL_DIR
        self.test_dir.mkdir(parents=True)
        for name in ("a.test.ts", "b.test.ts", "c.test.ts", "sub/d.test.ts"):
            p = self.test_dir / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("")
        # 시험 파일이 아닌 보조 파일은 대조 대상이 아니다
        (self.test_dir / "harness.ts").write_text("")

    def tearDown(self):
        self._tmp.cleanup()

    def report(self, label, files):
        path = self.root / f"{label}.json"
        results = [{"name": f"{RUNNER}/{REL_DIR}/{f}", "status": "passed"} for f in files]
        path.write_text(json.dumps({"success": True, "testResults": results}))
        return str(path)

    def run_main(self, *reports):
        # CI처럼 저장소 루트(여기서는 임시 폴더)에서 상대 경로로 시험 폴더를 준다
        out, err = io.StringIO(), io.StringIO()
        cwd = os.getcwd()
        os.chdir(self.root)
        try:
            with redirect_stdout(out), redirect_stderr(err):
                code = cg.main(["--dir", REL_DIR, *reports])
        finally:
            os.chdir(cwd)
        return code, out.getvalue(), err.getvalue()

    def test_pass_when_every_file_runs_exactly_once(self):
        code, out, err = self.run_main(
            self.report("g1", ["a.test.ts", "sub/d.test.ts"]),
            self.report("g2", ["b.test.ts", "c.test.ts"]),
        )
        self.assertEqual(code, 0, err)
        self.assertIn("묶음 대조 통과", out)

    def test_fail_when_a_file_runs_in_no_group(self):
        code, _, err = self.run_main(
            self.report("g1", ["a.test.ts"]),
            self.report("g2", ["b.test.ts", "c.test.ts"]),
        )
        self.assertEqual(code, 1)
        self.assertIn("빠짐: sub/d.test.ts", err)

    def test_fail_when_a_file_runs_in_two_groups(self):
        code, _, err = self.run_main(
            self.report("g1", ["a.test.ts", "b.test.ts", "sub/d.test.ts"]),
            self.report("g2", ["b.test.ts", "c.test.ts"]),
        )
        self.assertEqual(code, 1)
        self.assertIn("중복: b.test.ts", err)

    def test_fail_when_report_has_file_outside_test_dir(self):
        code, _, err = self.run_main(
            self.report("g1", ["a.test.ts", "sub/d.test.ts", "../other.test.ts"]),
            self.report("g2", ["b.test.ts", "c.test.ts"]),
        )
        self.assertEqual(code, 1)
        self.assertIn("폴더 밖", err)

    def test_missing_report_is_error(self):
        code, _, err = self.run_main(self.report("g1", ["a.test.ts"]), str(self.root / "none.json"))
        self.assertEqual(code, 2)
        self.assertIn("보고서를 읽을 수 없습니다", err)

    def test_relative_dir_argument_matches_absolute_report_paths(self):
        rel = cg.to_relative(f"{RUNNER}/{REL_DIR}/sub/d.test.ts", REL_DIR)
        self.assertEqual(rel, "sub/d.test.ts")
        self.assertIsNone(cg.to_relative(f"{RUNNER}/packages/orchestrator/test/x.test.ts", REL_DIR))


if __name__ == "__main__":
    unittest.main()
