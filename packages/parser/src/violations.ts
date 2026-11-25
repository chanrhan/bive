// dependency-cruiser 위반 출력 → 구조 위반 (M3-02 #47, ADR-125 ③). 판별은 규칙(rules.ts)과 dependency-cruiser가 했고 여기서는
// 모양만 바꾼다: 규칙 이름 → 종류, 파일 → 블록, 순환은 같은 순환이 여러 번 나와도 하나로 모은다.
import type { BlockMapping } from './blocks.js';
import type { CruiseOutput } from './cruise.js';
import { ParserError } from './errors.js';
import { type Capped, capped, PARSER_LIMITS } from './limits.js';
import { RULE_PREFIX, type ViolationKind } from './rules.js';

export interface ViolationEnd {
  file: string;
  block: string;
}

export interface StructureViolation {
  kind: ViolationKind;
  from: ViolationEnd;
  to: ViolationEnd;
  /** 순환이면 순환하는 파일 (`from`에서 시작해 `from`으로 돌아가기 직전까지, 첫 파일이 사전순 가장 앞), 아니면 `null` */
  cycle: Capped<string> | null;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const kindOf = (ruleName: string): ViolationKind | null => {
  for (const [kind, prefix] of Object.entries(RULE_PREFIX) as [ViolationKind, string][]) {
    if (kind === 'structure.no-cycle' ? ruleName === prefix : ruleName.startsWith(`${prefix}--`)) {
      return kind;
    }
  }
  return null;
};

const unexpected = (what: string): ParserError =>
  new ParserError(
    'cruise_output_invalid',
    `dependency-cruiser 위반 출력이 예상과 다릅니다: ${what}`,
  );

/** 순환 경로를 사전순 가장 앞 파일에서 시작하게 돌린다. */
const rotate = (loop: string[]): string[] => {
  let start = 0;
  loop.forEach((file, index) => {
    if (compare(file, loop[start] as string) < 0) start = index;
  });
  return [...loop.slice(start), ...loop.slice(0, start)];
};

export const violationsFromCruise = (
  output: CruiseOutput,
  mapping: BlockMapping,
): Capped<StructureViolation> => {
  const end = (file: string): ViolationEnd => {
    const block = mapping.blockOf.get(file);
    if (block === undefined) throw unexpected('블록에 속하지 않은 파일');
    return { file, block };
  };
  const found = new Map<string, StructureViolation>();
  for (const violation of output.summary.violations) {
    const kind = kindOf(violation.rule.name);
    if (kind === null) throw unexpected('모르는 규칙');
    if (kind === 'structure.no-cycle') {
      // dependency-cruiser의 순환 경로는 `to`에서 시작해 `from`에서 끝난다
      const tail = (violation.cycle ?? []).map((step) => step.name);
      if (tail.length === 0 || tail[tail.length - 1] !== violation.from) {
        throw unexpected('순환 경로');
      }
      const loop = rotate([violation.from, ...tail.slice(0, -1)]);
      const key = `${kind}\n${loop.join('\n')}`;
      if (found.has(key)) continue;
      found.set(key, {
        kind,
        from: end(loop[0] as string),
        to: end(loop[1 % loop.length] as string),
        cycle: capped(loop, PARSER_LIMITS.cyclePath),
      });
    } else {
      const key = `${kind}\n${violation.from}\n${violation.to}`;
      found.set(key, { kind, from: end(violation.from), to: end(violation.to), cycle: null });
    }
  }
  const all = [...found.values()].sort(
    (a, b) =>
      compare(a.kind, b.kind) || compare(a.from.file, b.from.file) || compare(a.to.file, b.to.file),
  );
  return capped(all, PARSER_LIMITS.violations);
};
