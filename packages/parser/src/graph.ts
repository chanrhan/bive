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

export interface PackageImport {
  /** 패키지 이름 (모듈 이름의 첫 구간, `@범위/이름`이면 두 구간) */
  name: string;
  /**
   * dependency-cruiser가 그 import를 "manifest에 있음"으로 본 것(의존 종류가 `npm-no-pkg` · `npm-unknown`이 아님) 그대로다. 기준은
   * 가져오는 파일의 폴더에서 가장 가까운 package.json이다(프로젝트 루트가 아닐 수 있다). 여러 파일이 가져오면 하나라도 아니면
   * `false`. 안전 신호가 아니다(ADR-125 ⑨)
   */
  inManifest: boolean;
}

export interface ImportGraph {
  /** 분석한 소스 파일 (프로젝트 루트 기준, 정렬) */
  modules: string[];
  /** 소스 파일끼리의 import (정렬, 같은 쌍은 하나) */
  edges: Capped<ImportEdge>;
  /** 소스 파일의 import 가운데 dependency-cruiser가 풀지 못한 것 (설치하지 않은 패키지 포함) */
  unresolved: Capped<UnresolvedImport>;
  /**
   * 소스 파일의 import 가운데 프로젝트 안팎의 "분석하지 않은 파일"로 풀린 것(정렬, 같은 쌍은 하나): 소스 확장자가 아닌 파일, 건너뛴
   * 폴더(`.next` · `node_modules` 등) 안 파일을 경로로 가리킨 것, 프로젝트 밖. 그 파일 안의 import는 읽지 않았으므로 그 너머는
   * 그래프에 없다. 코드를 실을 수 없는 데이터 형식({@link DATA_EXTENSIONS})은 넣지 않는다
   */
  unanalyzed: Capped<ImportEdge>;
  /** 소스 파일이 패키지 이름으로 가져온 패키지 (이름순, 이름마다 하나). 패키지 안은 따라가지 않는다 */
  packages: Capped<PackageImport>;
}

/** 코드를 실을 수 없는 데이터 형식 (import해도 그 너머로 이어지는 JS import가 없다): JSON · 스타일시트 · 그림 · 글꼴 */
export const DATA_EXTENSIONS = [
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
];

const isData = (file: string): boolean => {
  const lower = file.toLowerCase();
  return DATA_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

/** dependency-cruiser가 패키지 찾기(node_modules)로 푼 의존 종류 (`npm` · `npm-dev` · `npm-no-pkg` 등) */
const isPackage = (types: readonly string[]): boolean =>
  types.some((type) => type.startsWith('npm'));

const packageName = (module: string): string => {
  const parts = module.split('/');
  return module.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? module);
};

/** 자르기 전 전체 목록 (구조 판정이 쓴다) */
export interface FullGraph {
  edges: ImportEdge[];
  unresolved: UnresolvedImport[];
  unanalyzed: ImportEdge[];
  packages: PackageImport[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 출력에서 그래프를 만든다. `files`는 파서가 모은 소스 파일 목록이다.
 * - 소스 파일인데 출력에 모듈로 없으면 오류(분석하지 않은 파일이 "import 없음"으로 읽히지 않게)
 * - 소스 파일 밖으로 풀린 import는 간선이 아니다: 패키지 이름으로 가져온 것은 `packages`, 그 밖(소스가 아닌 파일 · 건너뛴 폴더 ·
 *   프로젝트 밖)은 `unanalyzed`(데이터 형식만 뺀다). 조용히 버리지 않는다
 * - 소스 파일과 대소문자만 다른 경로로 풀린 import는 오류(대소문자를 가리지 않는 파일 시스템에서 간선을 잃지 않게)
 */
export const collectGraph = (output: CruiseOutput, files: readonly string[]): FullGraph => {
  const fileSet = new Set(files);
  const lower = new Set(files.map((file) => file.toLowerCase()));
  const seen = new Set<string>();
  const edges = new Map<string, ImportEdge>();
  const unresolved: UnresolvedImport[] = [];
  const unanalyzed = new Map<string, ImportEdge>();
  const packages = new Map<string, PackageImport>();
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
      } else if (isPackage(dependency.dependencyTypes)) {
        const name = packageName(dependency.module);
        const inManifest = !dependency.dependencyTypes.some(
          (type) => type === 'npm-no-pkg' || type === 'npm-unknown',
        );
        const known = packages.get(name);
        packages.set(name, { name, inManifest: (known?.inManifest ?? true) && inManifest });
      } else if (!isData(dependency.resolved)) {
        unanalyzed.set(`${module.source}\n${dependency.resolved}`, {
          from: module.source,
          to: dependency.resolved,
        });
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
  const byEnds = (a: ImportEdge, b: ImportEdge): number =>
    compare(a.from, b.from) || compare(a.to, b.to);
  unresolved.sort((a, b) => compare(a.from, b.from) || compare(a.module, b.module));
  return {
    edges: [...edges.values()].sort(byEnds),
    unresolved,
    unanalyzed: [...unanalyzed.values()].sort(byEnds),
    packages: [...packages.values()].sort((a, b) => compare(a.name, b.name)),
  };
};

/** 전체 목록 → 상한으로 자른 그래프. */
export const cappedGraph = (full: FullGraph, files: readonly string[]): ImportGraph => ({
  modules: [...files],
  edges: capped(full.edges, PARSER_LIMITS.edges),
  unresolved: capped(full.unresolved, PARSER_LIMITS.unresolved),
  unanalyzed: capped(full.unanalyzed, PARSER_LIMITS.unanalyzed),
  packages: capped(full.packages, PARSER_LIMITS.packages),
});

export const graphFromCruise = (output: CruiseOutput, files: readonly string[]): ImportGraph =>
  cappedGraph(collectGraph(output, files), files);
