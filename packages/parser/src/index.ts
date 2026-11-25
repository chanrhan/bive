/** 패키지 식별자. 워크스페이스 뼈대 확인용 최소 export (M0-01). */
export const PACKAGE_NAME = '@bive/parser';

export {
  analyzeProject,
  type AnalyzeOptions,
  type BlockFilesResult,
  type ProjectAnalysis,
  type StructureOutcome,
  type StructureResult,
} from './analyze.js';
export type { FileOverlap, PublicOutsideInclude } from './blocks.js';
export { ParserError, type ParserErrorCode } from './errors.js';
export type { ImportEdge, ImportGraph, UnresolvedImport } from './graph.js';
export { type Capped, PARSER_LIMITS } from './limits.js';
export type { ViolationKind } from './rules.js';
export type { StructureViolation, ViolationEnd } from './violations.js';
