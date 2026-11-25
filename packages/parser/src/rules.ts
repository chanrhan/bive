// 블록 선언 → dependency-cruiser 규칙 (M3-02 #47, ADR-125 ③). 판별은 dependency-cruiser가 하고 파서는 규칙을 만들고 결과를 옮긴다.
// - 규칙의 `path`에는 매핑에서 정한 파일 경로를 글자 그대로 이스케이프한 목록만 넣는다(regex.ts)
// - 같은 블록 안 import · 미분류 · 겹침 파일이 낀 import는 어느 규칙의 `path`에도 들지 않아 위반이 되지 않는다
// - 공유(`shared`) 블록도 도메인 블록과 같은 규칙이다(종류는 판정에 쓰지 않는다)
import type { BlockDeclaration } from '@bive/shared';

import type { BlockMapping } from './blocks.js';
import { exactPathsRegExp } from './regex.js';

/** 위반 종류. 앞의 둘은 내장 구조 규칙 이름과 같다(기획서 3.4). */
export type ViolationKind =
  | 'structure.declared-direction'
  | 'structure.public-api-only'
  | 'structure.no-cycle';

/** dependency-cruiser 규칙 이름의 머리 (뒤에 `--<블록 이름>`) → 위반 종류 */
export const RULE_PREFIX: Record<ViolationKind, string> = {
  'structure.declared-direction': 'declared-direction',
  'structure.public-api-only': 'public-api-only',
  'structure.no-cycle': 'no-cycle',
};

export interface CruiseRule {
  name: string;
  severity: 'error';
  from: { path: string };
  to: { path?: string; pathNot?: string; circular?: true; viaOnly?: { path: string } };
}

export interface CruiseRuleSet {
  forbidden: CruiseRule[];
}

/**
 * 규칙 세 갈래.
 * - 선언 외 방향: 블록 B의 파일 → B 자신도 B의 `dependsOn`도 아닌 블록의 파일
 * - 공개 API 외 접근: 블록 T를 `dependsOn`에 둔 블록의 파일 → T의 공개 파일이 아닌 T의 파일. 방향이 허용된 import만 본다
 *   (선언 외 방향 import는 방향 위반 하나로만 센다)
 * - 순환: 블록에 속한 파일에서 시작해 블록에 속한 파일만 거쳐 돌아오는 순환
 */
export const buildRuleSet = (
  declaration: BlockDeclaration,
  mapping: BlockMapping,
): CruiseRuleSet => {
  const filesOf = new Map(mapping.blocks.map((block) => [block.name, block]));
  const forbidden: CruiseRule[] = [];
  for (const block of declaration.blocks) {
    const own = filesOf.get(block.name)?.files ?? [];
    if (own.length === 0) continue;
    const allowed = new Set([block.name, ...block.dependsOn]);
    const targets = mapping.blocks
      .filter((other) => !allowed.has(other.name))
      .flatMap((other) => other.files);
    if (targets.length > 0) {
      forbidden.push({
        name: `${RULE_PREFIX['structure.declared-direction']}--${block.name}`,
        severity: 'error',
        from: { path: exactPathsRegExp(own) },
        to: { path: exactPathsRegExp(targets) },
      });
    }
  }
  for (const target of declaration.blocks) {
    const files = filesOf.get(target.name);
    if (files === undefined) continue;
    const publicFiles = new Set(files.publicFiles);
    const hidden = files.files.filter((file) => !publicFiles.has(file));
    const importers = declaration.blocks
      .filter((block) => block.dependsOn.includes(target.name))
      .flatMap((block) => filesOf.get(block.name)?.files ?? []);
    if (hidden.length === 0 || importers.length === 0) continue;
    forbidden.push({
      name: `${RULE_PREFIX['structure.public-api-only']}--${target.name}`,
      severity: 'error',
      from: { path: exactPathsRegExp(importers) },
      to: { path: exactPathsRegExp(hidden) },
    });
  }
  const classified = mapping.blocks.flatMap((block) => block.files);
  if (classified.length > 0) {
    const all = exactPathsRegExp([...classified].sort());
    forbidden.push({
      name: RULE_PREFIX['structure.no-cycle'],
      severity: 'error',
      from: { path: all },
      to: { circular: true, viaOnly: { path: all } },
    });
  }
  return { forbidden };
};
