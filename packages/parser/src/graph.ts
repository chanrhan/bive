// dependency-cruiser 출력 → import 그래프 (M3-02 #47, ADR-125 ①). 변환만 한다: 간선의 끝은 dependency-cruiser가 푼 경로
// (`resolved`) 그대로이고, 파서가 경로 별칭 · 확장자 · index 파일을 따로 풀지 않는다(ADR-033).
import { ParserError } from './errors.js';
import { type Capped, capped, PARSER_LIMITS } from './limits.js';
import type { CruiseOutput } from './cruise.js';

export interface ImportEdge {
  from: string;
  to: string;
}

export interface UnresolvedImport {
  from: string;
  /** 소스에 적힌 모듈 이름 그대로 */
  module: string;
}

export interface ImportGraph {
  /** 분석한 소스 파일 (프로젝트 루트 기준, 정렬) */
  modules: string[];
  /** 소스 파일끼리의 import (정렬, 같은 쌍은 하나) */
  edges: Capped<ImportEdge>;
  /** 소스 파일의 import 가운데 dependency-cruiser가 풀지 못한 것 (설치하지 않은 패키지 포함) */
  unresolved: Capped<UnresolvedImport>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 출력에서 그래프를 만든다. `files`는 파서가 모은 소스 파일 목록이다.
 * - 소스 파일인데 출력에 모듈로 없으면 오류(분석하지 않은 파일이 "import 없음"으로 읽히지 않게)
 * - 소스 파일 밖으로 풀린 import(패키지 · 프로젝트 밖 · JSON · CSS 등)는 간선에 넣지 않는다
 * - 소스 파일과 대소문자만 다른 경로로 풀린 import는 오류(대소문자를 가리지 않는 파일 시스템에서 간선을 잃지 않게)
 */
export const graphFromCruise = (output: CruiseOutput, files: readonly string[]): ImportGraph => {
  const fileSet = new Set(files);
  const lower = new Set(files.map((file) => file.toLowerCase()));
  const seen = new Set<string>();
  const edges = new Map<string, ImportEdge>();
  const unresolved: UnresolvedImport[] = [];
  for (const module of output.modules) {
    if (!fileSet.has(module.source)) continue;
    seen.add(module.source);
    for (const dependency of module.dependencies) {
      if (dependency.coreModule) continue;
      if (dependency.couldNotResolve) {
        unresolved.push({ from: module.source, module: dependency.module });
      } else if (fileSet.has(dependency.resolved)) {
        edges.set(`${module.source}\n${dependency.resolved}`, {
          from: module.source,
          to: dependency.resolved,
        });
      } else if (lower.has(dependency.resolved.toLowerCase())) {
        throw new ParserError(
          'path_case_mismatch',
          `import가 소스 파일과 대소문자만 다른 경로로 풀렸습니다 (${String(dependency.resolved.length)}자 경로)`,
        );
      }
    }
  }
  const missing = files.filter((file) => !seen.has(file)).length;
  if (missing > 0) {
    throw new ParserError(
      'file_not_analyzed',
      `dependency-cruiser가 소스 파일 ${String(missing)}개를 분석하지 않았습니다`,
    );
  }
  const sortedEdges = [...edges.values()].sort(
    (a, b) => compare(a.from, b.from) || compare(a.to, b.to),
  );
  unresolved.sort((a, b) => compare(a.from, b.from) || compare(a.module, b.module));
  return {
    modules: [...files],
    edges: capped(sortedEdges, PARSER_LIMITS.edges),
    unresolved: capped(unresolved, PARSER_LIMITS.unresolved),
  };
};
