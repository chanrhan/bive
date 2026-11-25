// 프로젝트 분석 (M3-02 #47, ADR-125): 소스 파일 목록 → 파일과 블록 매핑 → dependency-cruiser 한 번(선언이 있고 겹침이 없으면
// 규칙을 넣어서) → 그래프 · 위반으로 옮김.
// - 선언이 없으면(`null`) 블록 판정 · 위반 판별 없이 그래프만 낸다(`structure: null`)
// - 겹침이 있으면 위반을 판별하지 않는다(`outcome.status = 'overlap'`). "위반 0건"과 구별된다
// - 분석을 끝까지 못 했으면 `ParserError`를 던진다
import { BlockDeclaration } from '@bive/shared';

import { mapFilesToBlocks, type FileOverlap, type PublicOutsideInclude } from './blocks.js';
import { type ProcessOptions, runCruise } from './cruise.js';
import { ParserError } from './errors.js';
import { listSourceFiles } from './files.js';
import { graphFromCruise, type ImportGraph } from './graph.js';
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
  | { status: 'checked'; violations: Capped<StructureViolation> }
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

/** 어느 깊이의 node_modules든, 그리고 파서가 건너뛴 자리 · 프로젝트 밖으로 풀린 경로를 dependency-cruiser에서도 제외한다. */
const excludeRegExp = (skipped: readonly string[]): string =>
  ['(^|/)node_modules(/|$)', '^\\.\\./', ...(skipped.length > 0 ? [pathsOrBelowRegExp(skipped)] : [])]
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
  const output = await runCruise({ root, exclude: excludeRegExp(skipped), ruleSet }, options);
  const graph = graphFromCruise(output, files);
  if (mapping === null) return { graph, structure: null };
  const outcome: StructureOutcome =
    ruleSet === null
      ? { status: 'overlap', overlaps: capped(mapping.overlaps, PARSER_LIMITS.overlaps) }
      : { status: 'checked', violations: violationsFromCruise(output, mapping) };
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
