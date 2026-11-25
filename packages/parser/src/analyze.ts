// 프로젝트 분석 (M3-02 #47, ADR-125): 소스 파일 목록 → 파일과 블록 매핑 → dependency-cruiser 한 번(선언이 있고 겹침이 없으면
// 규칙을 넣어서) → 그래프 · 위반으로 옮김.
// - 선언이 없으면(`null`) 블록 판정 · 위반 판별 없이 그래프만 낸다(`structure: null`)
// - 겹침이 있으면 위반을 판별하지 않는다(`outcome.status = 'overlap'`). "위반 0건"과 구별된다
// - 블록에 속한 파일이 분석하지 않은 파일로 가는 import를 가지면 `outcome.status = 'incomplete'`다: 위반은 판별해 싣지만 그 import
//   너머(그 파일 안의 import)를 보지 못했으므로 통과로 읽을 수 없다. "위반 0건"(`checked`)과 구별된다
// - 분석을 끝까지 못 했으면 `ParserError`를 던진다
import { BlockDeclaration } from '@bive/shared';

import { mapFilesToBlocks, type FileOverlap, type PublicOutsideInclude } from './blocks.js';
import { type ProcessOptions, runCruise } from './cruise.js';
import { ParserError } from './errors.js';
import { listSourceFiles } from './files.js';
import { cappedGraph, collectGraph, type ImportEdge, type ImportGraph } from './graph.js';
import { type Capped, capped, PARSER_LIMITS } from './limits.js';
import { pathsOrBelowRegExp } from './regex.js';
import { buildRuleSet } from './rules.js';
import { type StructureViolation, violationsFromCruise } from './violations.js';

export interface BlockFilesResult {
  name: string;
  files: Capped<string>;
  publicFiles: Capped<string>;
}

export type StructureOutcome =
  /** 판별을 끝까지 했다. 위반이 0건이면 통과다 */
  | { status: 'checked'; violations: Capped<StructureViolation> }
  /** 판별했지만 블록 파일의 import 일부가 분석하지 않은 파일로 간다(`unanalyzed`). 위반이 0건이어도 통과가 아니다 */
  | {
      status: 'incomplete';
      violations: Capped<StructureViolation>;
      unanalyzed: Capped<ImportEdge>;
    }
  /** 겹침 때문에 판별하지 않았다 */
  | { status: 'overlap'; overlaps: Capped<FileOverlap> };

export interface StructureResult {
  blocks: BlockFilesResult[];
  unclassified: Capped<string>;
  publicOutsideInclude: Capped<PublicOutsideInclude>;
  outcome: StructureOutcome;
}

export interface ProjectAnalysis {
  graph: ImportGraph;
  /** 블록 선언이 없으면 `null` */
  structure: StructureResult | null;
}

export interface AnalyzeOptions extends ProcessOptions {
  projectDir: string;
  declaration: BlockDeclaration | null;
}

/**
 * 어느 깊이의 node_modules든, 파서가 건너뛴 자리 · 프로젝트 밖으로 풀린 경로는 dependency-cruiser가 따라가지 않는다(그 파일을 읽지
 * 않는다). 제외(`exclude`)가 아니라 따라가지 않기라 그리로 가는 import는 출력에 남는다(분석하지 않은 대상으로 드러난다).
 */
const doNotFollowRegExp = (skipped: readonly string[]): string =>
  [
    '(^|/)node_modules(/|$)',
    '^\\.\\./',
    ...(skipped.length > 0 ? [pathsOrBelowRegExp(skipped)] : []),
  ]
    .map((part) => `(?:${part})`)
    .join('|');

export const analyzeProject = async (options: AnalyzeOptions): Promise<ProjectAnalysis> => {
  let declaration: BlockDeclaration | null = null;
  if (options.declaration !== null) {
    const parsed = BlockDeclaration.safeParse(options.declaration);
    if (!parsed.success) {
      throw new ParserError('invalid_declaration', '블록 선언이 형식에 맞지 않습니다');
    }
    declaration = parsed.data;
  }
  const { root, files, skipped } = listSourceFiles(options.projectDir);
  const mapping = declaration === null ? null : mapFilesToBlocks(declaration, files);
  const ruleSet =
    declaration !== null && mapping !== null && mapping.overlaps.length === 0
      ? buildRuleSet(declaration, mapping)
      : null;
  const output = await runCruise(
    { root, doNotFollow: doNotFollowRegExp(skipped), ruleSet },
    options,
  );
  const full = collectGraph(output, files);
  const graph = cappedGraph(full, files);
  if (mapping === null) return { graph, structure: null };
  const fromBlocks = full.unanalyzed.filter((edge) => mapping.blockOf.has(edge.from));
  let outcome: StructureOutcome;
  if (ruleSet === null) {
    outcome = { status: 'overlap', overlaps: capped(mapping.overlaps, PARSER_LIMITS.overlaps) };
  } else if (fromBlocks.length > 0) {
    outcome = {
      status: 'incomplete',
      violations: violationsFromCruise(output, mapping),
      unanalyzed: capped(fromBlocks, PARSER_LIMITS.unanalyzed),
    };
  } else {
    outcome = { status: 'checked', violations: violationsFromCruise(output, mapping) };
  }
  return {
    graph,
    structure: {
      blocks: mapping.blocks.map((block) => ({
        name: block.name,
        files: capped(block.files, PARSER_LIMITS.files),
        publicFiles: capped(block.publicFiles, PARSER_LIMITS.files),
      })),
      unclassified: capped(mapping.unclassified, PARSER_LIMITS.files),
      publicOutsideInclude: capped(mapping.publicOutsideInclude, PARSER_LIMITS.files),
      outcome,
    },
  };
};
