// 디자인 토큰 대조 (이슈 #13 수용 기준 2): docs/prototype-map.md 3장 토큰 표를 읽어
// src/renderer/styles/tokens.css의 :root에 이름이 전부 CSS 변수로 있고 값이 표와 같은지 확인한다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PROTOTYPE_MAP = fileURLToPath(new URL('../../../docs/prototype-map.md', import.meta.url));
const TOKENS_CSS = fileURLToPath(new URL('../src/renderer/styles/tokens.css', import.meta.url));

interface TokenRow {
  /** 표 한 줄의 토큰 이름들 (범위 `--a-1` ~ `--a-4`는 펼친다) */
  names: string[];
  /** 값 칸 맨 앞의 코드 표기 값들. 설명만 있는 줄(예: 흐린 점)은 빈 배열 */
  values: string[];
  /** 구분 열 (근거 있음 · 제안) */
  kind: string;
}

/** `--font-size-1` ~ `--font-size-4` → 1~4를 펼친다. */
const expandRange = (from: string, to: string): string[] => {
  const a = /^(.*-)(\d+)$/.exec(from);
  const b = /^(.*-)(\d+)$/.exec(to);
  if (a === null || b === null || a[1] !== b[1]) throw new Error(`범위 형식 아님: ${from} ~ ${to}`);
  const out: string[] = [];
  for (let i = Number(a[2]); i <= Number(b[2]); i += 1) out.push(`${a[1]}${i}`);
  return out;
};

/** 값 칸 앞에서부터 `값` · `값` … 을 읽고, 코드 표기가 아닌 글자(설명 · 괄호)를 만나면 멈춘다. */
const leadingCodeValues = (cell: string): string[] => {
  const values: string[] = [];
  let rest = cell.trim();
  for (
    let m = /^`([^`]+)`\s*(?:·\s*)?/.exec(rest);
    m !== null;
    m = /^`([^`]+)`\s*(?:·\s*)?/.exec(rest)
  ) {
    values.push(m[1] ?? '');
    rest = rest.slice(m[0].length);
  }
  return values;
};

/** prototype-map.md 3장 표를 읽는다. */
const parseTokenTable = (markdown: string): TokenRow[] => {
  const start = markdown.indexOf('## 3. 디자인 토큰');
  if (start === -1) throw new Error('prototype-map.md에 "## 3. 디자인 토큰" 절 없음');
  const end = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  const rows: TokenRow[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `--')) continue;
    const cells = line.split('|').slice(1, -1);
    const [tokenCell = '', valueCell = '', , kindCell = ''] = cells;
    const found = [...tokenCell.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1] ?? '');
    const names =
      found.length === 2 && tokenCell.includes('~')
        ? expandRange(found[0] ?? '', found[1] ?? '')
        : found;
    rows.push({ names, values: leadingCodeValues(valueCell), kind: kindCell.trim() });
  }
  return rows;
};

/** tokens.css의 `:root { … }` 선언 (이름 → 값). 주석은 뺀다. */
const parseRootDeclarations = (css: string): Map<string, string> => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*\{([^}]*)\}/.exec(withoutComments);
  if (root === null) throw new Error('tokens.css에 :root 블록 없음');
  const declarations = new Map<string, string>();
  for (const part of (root[1] ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim();
    if (!name.startsWith('--')) continue;
    if (declarations.has(name)) throw new Error(`tokens.css에 ${name}가 두 번 선언됨`);
    declarations.set(name, part.slice(colon + 1).trim());
  }
  return declarations;
};

/** 비교용: 공백 하나로 · 따옴표 통일(형식 도구가 바꾼다) · 소문자. */
const normalize = (value: string): string =>
  value.replace(/\s+/g, ' ').replace(/"/g, "'").trim().toLowerCase();

const rows = parseTokenTable(readFileSync(PROTOTYPE_MAP, 'utf8'));
const declared = parseRootDeclarations(readFileSync(TOKENS_CSS, 'utf8'));
const tableNames = rows.flatMap((row) => row.names);

describe('디자인 토큰 표 읽기', () => {
  it('표에서 토큰을 읽고 범위 표기를 펼친다', () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
    expect(tableNames).toContain('--chat-width');
    expect(tableNames).toEqual(expect.arrayContaining(['--font-size-1', '--font-size-4']));
    expect(tableNames).toEqual(expect.arrayContaining(['--space-1', '--space-6']));
    expect(tableNames).toEqual(expect.arrayContaining(['--radius-1', '--radius-2']));
    expect(new Set(tableNames).size).toBe(tableNames.length);
  });

  it('값이 여러 개인 줄은 토큰 수와 값 수가 같다', () => {
    for (const row of rows) {
      if (row.values.length > 0)
        expect(row.values, row.names.join(' ')).toHaveLength(row.names.length);
    }
  });
});

describe('tokens.css', () => {
  it('표의 토큰 이름이 전부 :root의 CSS 변수로 있다', () => {
    const missing = tableNames.filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it('표에 없는 변수를 :root에 두지 않는다', () => {
    const extra = [...declared.keys()].filter((name) => !tableNames.includes(name));
    expect(extra).toEqual([]);
  });

  it('값이 코드로 적힌 토큰은 표의 값과 같다 (근거 있음은 그대로, 제안은 제안값)', () => {
    const mismatched: string[] = [];
    for (const row of rows) {
      row.values.forEach((value, i) => {
        const name = row.names[i] ?? '';
        const actual = declared.get(name);
        if (actual === undefined || normalize(actual) !== normalize(value)) {
          mismatched.push(`${name}: 표 ${value} / css ${actual ?? '없음'} (${row.kind})`);
        }
      });
    }
    expect(mismatched).toEqual([]);
  });

  it('설명만 있는 토큰도 빈 값이 아니다', () => {
    for (const row of rows.filter((r) => r.values.length === 0)) {
      for (const name of row.names) expect(declared.get(name), name).toMatch(/\S/);
    }
  });
});
