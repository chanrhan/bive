// 식별자 (docs/architecture.md 3장 공통 규칙, ADR-025).
// - 기본 키: ULID 문자열. 시간순으로 사전식 정렬된다
// - 표시 ID: 접두 + 프로젝트별 순번 (`REQ-001`). 순번은 저장소가 정하므로 호출자가 next-seq 함수로 주입한다
import { monotonicFactory } from 'ulid';
import { z } from 'zod';

/** ULID (Crockford Base32 26자). */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID 형식이 아닙니다');
export type Ulid = z.infer<typeof Ulid>;

/**
 * ULID 생성기를 만든다. 같은 밀리초 안에서도 단조 증가하므로 생성 순서 = 사전식 정렬 순서.
 * @param now 현재 시각(ms). 테스트에서 시계를 고정할 때 넘긴다
 */
export const createUlidGenerator = (now: () => number = Date.now): (() => Ulid) => {
  const next = monotonicFactory();
  return () => next(now());
};

/** 표시 ID 접두 (ADR-025). 실행은 PRD `RUN-xx`와 구분하려고 `EXE`. */
export const DisplayIdPrefix = z.enum(['REQ', 'RULE', 'CON', 'EXE', 'PRP', 'ADR']);
export type DisplayIdPrefix = z.infer<typeof DisplayIdPrefix>;

/** 엔터티별 표시 ID 접두. */
export const DISPLAY_ID_PREFIX_BY_ENTITY = {
  Requirement: 'REQ',
  Rule: 'RULE',
  Contract: 'CON',
  Run: 'EXE',
  Proposal: 'PRP',
  Adr: 'ADR',
} as const satisfies Record<string, DisplayIdPrefix>;

/** 순번 최소 자릿수. 1~999는 3자리로 0을 채우고, 1000부터는 자릿수가 늘어난다. */
export const DISPLAY_ID_MIN_DIGITS = 3;

const DISPLAY_ID_PATTERN = /^([A-Z]+)-(\d+)$/;

const assertSeq = (seq: number): void => {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new RangeError(`표시 ID 순번은 1 이상의 정수여야 합니다: ${String(seq)}`);
  }
};

/** 접두와 순번으로 표시 ID를 만든다. `formatDisplayId('REQ', 1)` → `REQ-001`. */
export const formatDisplayId = (prefix: DisplayIdPrefix, seq: number): string => {
  assertSeq(seq);
  return `${prefix}-${String(seq).padStart(DISPLAY_ID_MIN_DIGITS, '0')}`;
};

export interface ParsedDisplayId {
  prefix: DisplayIdPrefix;
  seq: number;
}

/** 표시 ID를 해석한다. 정규 형식(`formatDisplayId`가 만드는 형태)이 아니면 `null`. */
export const parseDisplayId = (value: string): ParsedDisplayId | null => {
  const match = DISPLAY_ID_PATTERN.exec(value);
  if (match === null) return null;
  const prefix = DisplayIdPrefix.safeParse(match[1]);
  const seq = Number(match[2]);
  if (!prefix.success || !Number.isSafeInteger(seq) || seq < 1) return null;
  // REQ-0001 · REQ-01 같은 비정규 표기는 거부해 같은 순번에 문자열이 둘 생기지 않게 한다
  if (formatDisplayId(prefix.data, seq) !== value) return null;
  return { prefix: prefix.data, seq };
};

/** 표시 ID 스키마. 접두를 지정하면 그 접두만 허용한다. */
export const displayIdSchema = (prefix?: DisplayIdPrefix) =>
  z.string().refine(
    (value) => {
      const parsed = parseDisplayId(value);
      return parsed !== null && (prefix === undefined || parsed.prefix === prefix);
    },
    `표시 ID 형식이 아닙니다${prefix === undefined ? '' : ` (${prefix}-NNN)`}`,
  );

/** 아무 접두나 허용하는 표시 ID 스키마. */
export const DisplayId = displayIdSchema();

/**
 * 표시 ID 비교 함수 (`Array.prototype.sort`용). 접두가 같으면 순번 숫자로 비교하므로
 * `REQ-999` < `REQ-1000`처럼 생성 순서(= 순번 순서)가 그대로 정렬 순서가 된다.
 * 형식이 아닌 문자열은 맨 뒤로 보내고 사전식으로 비교한다.
 */
export const compareDisplayIds = (a: string, b: string): number => {
  const pa = parseDisplayId(a);
  const pb = parseDisplayId(b);
  if (pa === null || pb === null) {
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (pa.prefix !== pb.prefix) return pa.prefix < pb.prefix ? -1 : 1;
  return pa.seq - pb.seq;
};

/**
 * 다음 순번 함수. 프로젝트 · 접두마다 1부터 증가하는 값을 돌려준다.
 * 저장소(store)가 트랜잭션 안에서 구현하고, shared는 저장소에 의존하지 않는다.
 */
export type NextSeq = (projectId: string, prefix: DisplayIdPrefix) => number;

export type DisplayIdGenerator = (projectId: string, prefix: DisplayIdPrefix) => string;

/** 주입한 next-seq 함수로 표시 ID 생성기를 만든다. 잘못된 순번(0 · 음수 · 소수)은 예외. */
export const createDisplayIdGenerator =
  (nextSeq: NextSeq): DisplayIdGenerator =>
  (projectId, prefix) =>
    formatDisplayId(DisplayIdPrefix.parse(prefix), nextSeq(projectId, prefix));
