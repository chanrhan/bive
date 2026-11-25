// 블록 선언 (기획서 3.3 · 4.4 구조 검사, NRM-09 · JDG-05 · DSN-01, ADR-005, M3-01 #46, ADR-122).
// - 블록 = 사람이 선언한 코드 단위: 이름 · 종류(도메인 · 공유) · 포함 경로(include) · 공개 API(public) · 허용 의존(dependsOn) ·
//   위험도(risk). 경계는 코드에서 재지 않고 선언한다(기획서 3.3). 원본은 프로젝트 폴더 밖 저장소에 있고 사람만 바꾼다(ADR-005)
// - 블록의 식별자는 이름이다. 규칙의 대상 블록(`Rule.targetBlockIds`)도 블록 이름을 담는다(칸 이름은 옛 그대로, ADR-122)
// - 경로 패턴은 프로젝트 루트 기준 상대 경로의 작은 글롭이다({@link matchesBlockPattern}): `/`로 나눈 구간마다 `**`(구간 전체,
//   0개 이상의 구간) · `*`(구간 안의 `/` 아닌 글자 0개 이상)만 특수 글자이고 나머지는 글자 그대로다(`[id]` · `(group)` · `@slot`
//   같은 Next.js 폴더 이름이 글자 그대로 맞는다). 절대 경로 · `..` · `.` 구간 · 빈 구간 · 역슬래시는 받지 않는다(프로젝트 폴더 밖을
//   가리킬 수 없다)
// - 저장할 때 거부: 이름 중복, 없는 블록 · 자기 자신을 가리키는 `dependsOn`, `dependsOn`의 순환, 두 블록에 같은 포함 경로 패턴.
//   글자가 다른 패턴끼리 실제 파일에서 겹치는지는 파서(M3-02)가 파일 기준으로 본다
// - 모든 글자는 보이는 ASCII만이라 세션 입력에 옮겨도 숨은 글자가 없다(표시 값 변환이 값을 바꾸지 않는다)
import { z } from 'zod';

import { BlockKind, Risk } from './enums.js';

/** 블록 선언 크기 상한 (ADR-122). 세션 입력(작업 지시 · 사본)의 크기를 묶는다. */
export const BLOCK_LIMITS = {
  /** 블록 수 */
  blocks: 30,
  /** 블록 하나의 포함 경로 · 공개 API 패턴 수 (각각) */
  patterns: 20,
  /** 패턴 하나의 길이 */
  patternLength: 200,
  /** 이름 길이 */
  nameLength: 40,
  /** 규칙 하나의 대상 블록 수 */
  ruleTargets: 10,
} as const;

/** 블록 이름: 소문자로 시작하고 소문자 · 숫자 · `-`만, `-`로 끝나지 않음. */
export const BlockName = z
  .string()
  .max(BLOCK_LIMITS.nameLength)
  .regex(
    /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/u,
    '블록 이름은 소문자로 시작하고 소문자 · 숫자 · -만 쓰며 -로 끝나지 않습니다',
  );
export type BlockName = z.infer<typeof BlockName>;

/** 패턴 글자: 보이는 ASCII 가운데 경로 글자로 흔한 것 (역슬래시 · 공백 · 따옴표 · `:` 등 없음). */
const PATTERN_CHARS = /^[A-Za-z0-9._\-/*()[\]@+]+$/u;

/** 패턴이 받을 수 없는 이유 (받으면 `null`). */
export const blockPatternProblem = (pattern: string): string | null => {
  if (pattern.length === 0) return '빈 패턴';
  if (pattern.length > BLOCK_LIMITS.patternLength) {
    return `패턴이 ${String(BLOCK_LIMITS.patternLength)}자를 넘습니다`;
  }
  if (!PATTERN_CHARS.test(pattern)) {
    return '패턴에는 영문자 · 숫자 · . _ - / * ( ) [ ] @ +만 씁니다';
  }
  if (pattern.startsWith('/')) return '절대 경로는 받지 않습니다 (프로젝트 루트 기준 상대 경로)';
  const segments = pattern.split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment === '') return '빈 경로 구간(// 또는 끝의 /)은 받지 않습니다';
    if (segment === '.' || segment === '..') {
      return '. · .. 구간은 받지 않습니다 (프로젝트 폴더 밖을 가리킬 수 없습니다)';
    }
    if (segment.includes('**') && segment !== '**') return '**는 구간 전체로만 씁니다';
    if (segment === '**' && segments[index - 1] === '**') {
      return '**를 잇달아 쓸 수 없습니다 (**/**는 ** 하나와 같습니다)';
    }
  }
  return null;
};

/** 경로 패턴 (프로젝트 루트 기준 상대 경로의 작은 글롭, 위 머리 설명). */
export const BlockPattern = z.string().superRefine((pattern, ctx) => {
  const problem = blockPatternProblem(pattern);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
});
export type BlockPattern = z.infer<typeof BlockPattern>;

/**
 * 구간 하나의 글롭(`*`만 특수 글자)이 글자 그대로의 구간에 맞는지. 별을 만나면 그 자리를 기억해 두고 어긋날 때 별이 한 글자 더
 * 먹게 하는 방식이라 되돌아감이 마지막 별 하나뿐이다(최악 패턴 길이 × 구간 길이).
 */
const segmentMatches = (glob: string, text: string): boolean => {
  let g = 0;
  let t = 0;
  let star = -1;
  let starText = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g;
      starText = t;
      g += 1;
    } else if (g < glob.length && glob[g] === text[t]) {
      g += 1;
      t += 1;
    } else if (star >= 0) {
      g = star + 1;
      starText += 1;
      t = starText;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g += 1;
  return g === glob.length;
};

/**
 * 프로젝트 루트 기준 상대 경로(`/` 구분)가 패턴에 맞는지. 정규식을 쓰지 않는 구간 단위 매처다(ADR-122 ②): 패턴 구간마다 경로의 닿을
 * 수 있는 자리 집합을 한 번 넘겨 가며 계산한다(최악 패턴 구간 수 × 경로 구간 수 × 구간 비교). 뜻:
 * 가운데 `**`는 빈 글이 아닌 구간 0개 이상, 끝의 `**`는 빈 글이 아닌 나머지 전부, 구간 안 `*`는 `/` 아닌 글자 0개 이상.
 */
export const matchesBlockPattern = (pattern: string, relPath: string): boolean => {
  const globs = pattern.split('/');
  const parts = relPath.split('/');
  const n = parts.length;
  let reach = new Array<boolean>(n + 1).fill(false);
  reach[0] = true;
  for (const [index, glob] of globs.entries()) {
    const last = index === globs.length - 1;
    if (glob === '**' && last) {
      // 남은 경로(`/`로 이은 글)가 빈 글이 아니면 맞는다
      return reach.some((ok, at) => ok && at < n && (at < n - 1 || (parts[at] ?? '') !== ''));
    }
    const next = new Array<boolean>(n + 1).fill(false);
    if (glob === '**') {
      for (let at = 0; at <= n; at += 1) {
        next[at] =
          (reach[at] ?? false) ||
          (at > 0 && (next[at - 1] ?? false) && (parts[at - 1] ?? '') !== '');
      }
    } else {
      for (let at = 0; at < n; at += 1) {
        if ((reach[at] ?? false) && segmentMatches(glob, parts[at] ?? '')) next[at + 1] = true;
      }
    }
    reach = next;
  }
  return reach[n] ?? false;
};

const uniqueList = <T extends z.ZodType<string>>(item: T, min: number, max: number, what: string) =>
  z
    .array(item)
    .min(min)
    .max(max)
    .refine((list) => new Set(list).size === list.length, `${what}이 중복됐습니다`);

/** 블록 하나. */
export const Block = z.strictObject({
  name: BlockName,
  kind: BlockKind,
  /** 이 블록에 속하는 파일 (1개 이상) */
  include: uniqueList(BlockPattern, 1, BLOCK_LIMITS.patterns, '포함 경로'),
  /** 다른 블록이 가져와도 되는 파일 (없으면 다른 블록은 이 블록을 가져올 수 없다) */
  public: uniqueList(BlockPattern, 0, BLOCK_LIMITS.patterns, '공개 API'),
  /** 이 블록이 가져와도 되는 다른 블록 */
  dependsOn: uniqueList(BlockName, 0, BLOCK_LIMITS.blocks - 1, '허용 의존'),
  risk: Risk,
});
export type Block = z.infer<typeof Block>;

/**
 * `dependsOn` 그래프에서 순환 하나를 찾는다 (처음 이름이 끝에 다시 오는 목록, 없으면 `null`). 없는 블록 · 자기 자신을 가리키는
 * 간선은 건너뛴다(따로 거부한다).
 */
export const blockDependencyCycle = (blocks: readonly Block[]): string[] | null => {
  const edges = new Map(blocks.map((block) => [block.name, block.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    const seen = state.get(name);
    if (seen === 'done') return null;
    if (seen === 'visiting') return [...stack.slice(stack.indexOf(name)), name];
    state.set(name, 'visiting');
    stack.push(name);
    for (const next of edges.get(name) ?? []) {
      if (next === name || !edges.has(next)) continue;
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(name, 'done');
    return null;
  };
  for (const block of blocks) {
    const cycle = visit(block.name);
    if (cycle !== null) return cycle;
  }
  return null;
};

/**
 * 블록 선언 (설정 파일 `blocks`와 같은 모양, 기획서 3.3). 블록 1개 이상. 저장 때 거부하는 경우는 머리 설명과 ADR-122의 표.
 */
export const BlockDeclaration = z
  .strictObject({
    blocks: z.array(Block).min(1).max(BLOCK_LIMITS.blocks),
  })
  .superRefine(({ blocks }, ctx) => {
    const names = new Set<string>();
    blocks.forEach((block, index) => {
      if (names.has(block.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `블록 이름이 중복됐습니다: ${block.name}`,
          path: ['blocks', index, 'name'],
        });
      }
      names.add(block.name);
    });
    blocks.forEach((block, index) => {
      block.dependsOn.forEach((target, at) => {
        if (target === block.name) {
          ctx.addIssue({
            code: 'custom',
            message: `자기 자신을 허용 의존으로 둘 수 없습니다: ${target}`,
            path: ['blocks', index, 'dependsOn', at],
          });
        } else if (!names.has(target)) {
          ctx.addIssue({
            code: 'custom',
            message: `선언되지 않은 블록을 허용 의존으로 가리킵니다: ${target}`,
            path: ['blocks', index, 'dependsOn', at],
          });
        }
      });
    });
    const cycle = blockDependencyCycle(blocks);
    if (cycle !== null) {
      ctx.addIssue({
        code: 'custom',
        message: `허용 의존이 순환합니다: ${cycle.join(' → ')}`,
        path: ['blocks'],
      });
    }
    const owners = new Map<string, string>();
    blocks.forEach((block, index) => {
      block.include.forEach((pattern, at) => {
        const owner = owners.get(pattern);
        if (owner !== undefined && owner !== block.name) {
          ctx.addIssue({
            code: 'custom',
            message: `같은 포함 경로 패턴이 두 블록에 있습니다: ${pattern} (${owner}, ${block.name})`,
            path: ['blocks', index, 'include', at],
          });
        }
        owners.set(pattern, block.name);
      });
    });
  });
export type BlockDeclaration = z.infer<typeof BlockDeclaration>;

/** 규칙의 대상 블록 (NRM-09): 블록 이름 1개 이상, 중복 없음. 새로 만드는 규칙에만 강제한다(옛 행은 빈 목록, ADR-122). */
export const RuleTargetBlocks = uniqueList(BlockName, 1, BLOCK_LIMITS.ruleTargets, '대상 블록');
export type RuleTargetBlocks = z.infer<typeof RuleTargetBlocks>;
