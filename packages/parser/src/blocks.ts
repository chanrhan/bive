// 파일 → 블록 매핑 (M3-02 #47, ADR-125 ②).
// - 판정은 shared의 `matchesBlockPattern`만 쓴다(패턴을 정규식으로 옮기지 않는다, ADR-122 ②)
// - 경로는 `listSourceFiles`가 준 형태(루트 기준, `/` 구분, 디스크 이름 그대로)이고 패턴과 대소문자를 구분해 맞춘다
// - 한 파일이 두 블록 이상의 include에 맞으면 어느 블록에도 넣지 않고 겹침으로 낸다(하나를 고르지 않는다). 겹침이 있으면 위반
//   판별을 하지 않는다(분석 쪽)
// - 공개 파일 = 그 블록에 속한 파일 가운데 public 패턴에 맞는 것. public 패턴에 맞지만 그 블록에 속하지 않는 파일은 공개로 치지 않고
//   목록으로 낸다(공개 범위가 넓어지는 쪽으로 읽지 않는다)
import { type BlockDeclaration, matchesBlockPattern } from '@bive/shared';

export interface FileOverlap {
  file: string;
  /** 이 파일의 include에 맞는 블록 이름 (선언 순서) */
  blocks: string[];
}

export interface PublicOutsideInclude {
  block: string;
  file: string;
}

export interface BlockFiles {
  name: string;
  /** 이 블록에 속한 파일 (정렬) */
  files: string[];
  /** 그 가운데 공개 파일 (정렬) */
  publicFiles: string[];
}

export interface BlockMapping {
  /** 선언 순서의 블록별 파일 */
  blocks: BlockFiles[];
  /** 파일 → 블록 이름 (겹침 · 미분류 파일은 없음) */
  blockOf: Map<string, string>;
  /** 어느 블록의 include에도 맞지 않는 파일 (정렬) */
  unclassified: string[];
  /** 두 블록 이상의 include에 맞는 파일 (정렬) */
  overlaps: FileOverlap[];
  /** public 패턴에 맞지만 그 블록에 속하지 않는 파일 */
  publicOutsideInclude: PublicOutsideInclude[];
}

/** 파일 목록(정렬된 것)을 블록 선언으로 나눈다. */
export const mapFilesToBlocks = (
  declaration: BlockDeclaration,
  files: readonly string[],
): BlockMapping => {
  const blockOf = new Map<string, string>();
  const unclassified: string[] = [];
  const overlaps: FileOverlap[] = [];
  for (const file of files) {
    const owners = declaration.blocks
      .filter((block) => block.include.some((pattern) => matchesBlockPattern(pattern, file)))
      .map((block) => block.name);
    if (owners.length === 0) unclassified.push(file);
    else if (owners.length > 1) overlaps.push({ file, blocks: owners });
    else blockOf.set(file, owners[0] as string);
  }
  const publicOutsideInclude: PublicOutsideInclude[] = [];
  const blocks = declaration.blocks.map((block): BlockFiles => {
    const own: string[] = [];
    const publicFiles: string[] = [];
    for (const file of files) {
      const isPublic = block.public.some((pattern) => matchesBlockPattern(pattern, file));
      if (blockOf.get(file) === block.name) {
        own.push(file);
        if (isPublic) publicFiles.push(file);
      } else if (isPublic) {
        publicOutsideInclude.push({ block: block.name, file });
      }
    }
    return { name: block.name, files: own, publicFiles };
  });
  return { blocks, blockOf, unclassified, overlaps, publicOutsideInclude };
};
