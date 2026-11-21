#!/usr/bin/env python3
"""파이프라인 e2e 묶음 대조 (M3-24). CI에서 나뉘어 돈 묶음들이 시험 폴더의 파일을 정확히 한 번씩 돌았는지 본다.

입력은 묶음마다 vitest json 보고서(`--reporter=json --outputFile.json=…`)다. 보고서의 testResults[].name
(실제로 돈 시험 파일의 절대 경로)을 모아 시험 폴더의 `*.test.ts` 목록(하위 폴더 포함, vitest 설정의
include `e2e/pipeline/**/*.test.ts`와 같은 범위)과 비교한다.
- 빠짐: 폴더에 있는데 어느 묶음에서도 돌지 않은 파일
- 중복: 두 번 이상 돈 파일(두 묶음에서, 또는 한 보고서에 두 번)
- 폴더 밖: 보고서에 있는데 시험 폴더의 파일이 아닌 것
하나라도 있으면 종료 코드 1, 모두 없으면 0. 보고서 파일이 없거나 읽을 수 없으면 종료 코드 2.

사용:
  python3 scripts/check-pipeline-groups.py --dir packages/orchestrator/e2e/pipeline 보고서1.json 보고서2.json
실행 시험: python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path, PurePosixPath


def folder_files(test_dir):
    """시험 폴더 기준 상대 경로(posix) 집합."""
    root = Path(test_dir)
    return {p.relative_to(root).as_posix() for p in root.rglob("*.test.ts") if p.is_file()}


def to_relative(name, test_dir):
    """보고서의 경로를 시험 폴더 기준 상대 경로로. 시험 폴더 밖이면 None.

    보고서를 만든 러너와 대조하는 러너의 작업 경로가 달라도 되도록 절대 경로를 비교하지 않고
    `/<시험 폴더 상대 경로>/`가 마지막으로 나타나는 곳 뒤를 쓴다.
    """
    marker = "/" + PurePosixPath(Path(test_dir).as_posix().strip("/")).as_posix() + "/"
    path = name.replace("\\", "/")
    idx = path.rfind(marker)
    if idx < 0:
        return None
    rel = path[idx + len(marker):]
    return rel or None


def ran_files(report_path):
    """보고서 하나에서 돈 시험 파일 경로 목록(중복 그대로)."""
    data = json.loads(Path(report_path).read_text(encoding="utf-8"))
    results = data.get("testResults")
    if not isinstance(results, list):
        raise ValueError(f"testResults 없음: {report_path}")
    return [r["name"] for r in results]


def compare(expected, runs, test_dir):
    """expected: 폴더의 상대 경로 집합, runs: [(보고서 이름, [돈 파일 경로])] -> (빠짐, 중복, 폴더 밖)."""
    counts = Counter()
    where = {}
    outside = []
    for label, names in runs:
        for name in names:
            rel = to_relative(name, test_dir)
            if rel is None or rel not in expected:
                outside.append(f"{name} ({label})")
                continue
            counts[rel] += 1
            where.setdefault(rel, []).append(label)
    missing = sorted(expected - set(counts))
    duplicated = sorted(f"{rel} ({', '.join(where[rel])})" for rel, n in counts.items() if n > 1)
    return missing, duplicated, sorted(outside)


def main(argv=None):
    ap = argparse.ArgumentParser(description="파이프라인 e2e 묶음 대조")
    ap.add_argument("--dir", required=True, help="시험 폴더 (예: packages/orchestrator/e2e/pipeline)")
    ap.add_argument("reports", nargs="+", help="묶음별 vitest json 보고서")
    args = ap.parse_args(argv)

    expected = folder_files(args.dir)
    if not expected:
        print(f"시험 폴더에 시험 파일이 없습니다: {args.dir}", file=sys.stderr)
        return 2
    runs = []
    for report in args.reports:
        try:
            runs.append((report, ran_files(report)))
        except (OSError, ValueError, KeyError, TypeError) as e:
            print(f"보고서를 읽을 수 없습니다: {report}: {e}", file=sys.stderr)
            return 2

    for label, names in runs:
        print(f"{label}: {len(names)}개 파일")
        for name in names:
            print(f"  {to_relative(name, args.dir) or name}")
    missing, duplicated, outside = compare(expected, runs, args.dir)
    print(f"시험 폴더 {len(expected)}개 파일, 묶음 {len(runs)}개")
    for title, items in (("빠짐", missing), ("중복", duplicated), ("폴더 밖", outside)):
        for item in items:
            print(f"{title}: {item}", file=sys.stderr)
    if missing or duplicated or outside:
        print("묶음 대조 실패: 시험 파일마다 정확히 한 묶음에서 돌아야 합니다", file=sys.stderr)
        return 1
    print("묶음 대조 통과: 모든 시험 파일이 정확히 한 묶음에서 돌았습니다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
