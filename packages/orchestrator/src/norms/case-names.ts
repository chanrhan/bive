// 인수 테스트 케이스 이름의 대조 (ADR-100 A5 · A6 · A14, M7-12 #224 · ADR-118, M3-37 #265 · ADR-121).
// - 케이스 이름은 판정 러너가 보고한 글이다. 테스트 작성 역할이 이름을 실행 값(`it.each` · 보간 · 응답 값)으로 만들면 이름이 판정
//   때 정해져, 구현 역할이 쓴 코드의 출력이 이름에 섞일 수 있다. 그 이름이 규범 자료 · 판단 입력 · 인용 출처에 그대로 들어가면 구현
//   역할의 글이 규범 담당 역할의 입력에 "판정 결과"의 모습으로 들어간다(역할 분리 약화)
// - 그래서 세션 입력에 싣는 케이스 이름은 모두 {@link knownCaseMatcher} 한 함수로 거른다: 이름을 ` > `로 나눈 조각마다 그 규칙
//   폴더(`bive-acceptance/<표시 ID>/`) 인수 테스트 파일의 `describe` · `it` · `test` 호출 첫 인자 리터럴 값과 전체가 같아야 "알려진
//   케이스"이고, 나머지는 수로만 싣는다("알 수 없는 케이스 N건"). 인수 테스트 파일은 Red 확인 뒤 해시로 잠겨 구현이 바꿀 수 없다
// - 대조할 파일 글: 검사 실패 판단은 판정한 체크아웃에서 읽은 글(`steps/judging.ts`), 그 밖의 세션(규칙 작성 · 요구사항 재판단 ·
//   이의 판단 · 테스트 작성 · 구현)은 규칙마다 최근 판정을 한 커밋의 글을 git 객체에서 읽는다({@link judgedCaseFilter}). 판정 기록은
//   인수 테스트 해시가 Red 확인 기록과 같은 커밋에서만 남으므로 그 커밋의 규칙 폴더 글은 테스트 작성 역할(또는 사람)이 쓴 글이다
// - 해석이 애매하면 모르는 이름으로 본다(덜 싣는 쪽): 문법 오류가 있는 파일 · 읽지 못한 커밋 · 기호 링크 · 1 MiB 뒤의 글은 대조에
//   쓰지 않는다
import type { ProjectStore } from '@bive/store';
import type TS from 'typescript6';

import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import { parseAcceptanceSource } from '../judge/acceptance-lint.js';

/** 케이스 이름이 그 규칙의 인수 테스트 파일에 적힌 이름인지 (규칙 표시 ID, 판정 러너의 이름 `상위 묶음 > 케이스`). */
export type CaseNameFilter = (ruleDisplayId: string, name: string) => boolean;

/** 아무 이름도 모른다 (대조할 글이 없을 때의 기본값: 덜 싣는 쪽). */
export const NO_KNOWN_CASES: CaseNameFilter = () => false;

/** 인수 테스트 파일 하나에서 대조에 쓰는 상한 (넘는 부분은 쓰지 않는다: 그 뒤의 이름은 모르는 이름이 된다). */
export const ACCEPTANCE_TEXT_MAX_BYTES = 1024 * 1024;

/** 케이스 이름을 정하는 호출 (판정 러너 vitest의 묶음 · 케이스 함수). */
export const CASE_NAME_CALLEES: readonly string[] = ['describe', 'it', 'test'];

/**
 * 호출 앞에 붙어도 이름을 그대로 두는 수식 (인자 없는 속성만). `each` · `for` · `skipIf(…)` · `runIf(…)` · `extend(…)`처럼
 * 이름을 실행 값으로 만들거나 호출을 한 번 더 거치는 꼴은 받지 않는다.
 */
export const CASE_NAME_MODIFIERS: readonly string[] = [
  'skip',
  'only',
  'todo',
  'concurrent',
  'sequential',
  'fails',
  'shuffle',
];

/**
 * 인수 테스트 파일 글에서 케이스 이름 리터럴을 모은다: `describe` · `it` · `test`(와 {@link CASE_NAME_MODIFIERS} 수식을 붙인 꼴)
 * 호출의 첫 인자가 문자열 리터럴(작은 · 큰따옴표)이나 보간 없는 템플릿 리터럴일 때 그 값(이스케이프를 푼 실행 값). 주석 · import
 * 지정자 · 다른 호출의 인자 · 이어 붙이기 · 보간 · 변수로 준 이름은 모으지 않는다. 문법 오류가 있으면 아무것도 모으지 않는다.
 * TypeScript 파서(이미 인수 테스트 import 검사가 쓰는 것)로 읽는다.
 */
export const caseNameLiterals = (text: string): Set<string> => {
  const values = new Set<string>();
  const parsed = parseAcceptanceSource(text);
  if (parsed === null) return values;
  const { ts, sourceFile } = parsed;
  /** 호출 대상이 케이스 함수(수식 포함)인지. 괄호 · 대괄호 접근 · 선택적 연결 · 형식 인자는 받지 않는다. */
  const isCaseCallee = (callee: TS.Expression): boolean => {
    let current = callee;
    while (ts.isPropertyAccessExpression(current)) {
      if (current.questionDotToken !== undefined) return false;
      if (!CASE_NAME_MODIFIERS.includes(current.name.text)) return false;
      current = current.expression;
    }
    return ts.isIdentifier(current) && CASE_NAME_CALLEES.includes(current.text);
  };
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.questionDotToken === undefined &&
      node.typeArguments === undefined &&
      isCaseCallee(node.expression)
    ) {
      const [first] = node.arguments;
      if (
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        first.text.length > 0
      ) {
        values.add(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
};

/** 이름이 리터럴 값들을 ` > `로 이은 것으로 남김없이 나뉘는지 (리터럴 값 안에 ` > `가 있어도 된다). */
const coveredBy = (name: string, literals: ReadonlySet<string>): boolean => {
  const memo = new Map<number, boolean>();
  const from = (start: number): boolean => {
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    let found = false;
    for (const literal of literals) {
      if (!name.startsWith(literal, start)) continue;
      const end = start + literal.length;
      if (end === name.length || (name.startsWith(' > ', end) && from(end + 3))) {
        found = true;
        break;
      }
    }
    memo.set(start, found);
    return found;
  };
  return name.length > 0 && from(0);
};

/**
 * 케이스 이름이 그 규칙의 인수 테스트 파일에 적혀 있는지 보는 함수 (세션 입력에 케이스 이름을 싣는 모든 길이 이 함수를 지난다).
 * 이름(판정 러너의 `상위 묶음 > 케이스`)을 ` > `로 나눈 조각마다 그 규칙 폴더(`bive-acceptance/<표시 ID>/`) 파일의 케이스 이름
 * 리터럴({@link caseNameLiterals}) 하나와 전체가 같아야 한다. 부분 문자열 · 주석 · import 지정자 · 다른 호출의 인자 · 실행 값으로
 * 만든 이름은 찾지 못한다(덜 싣는 쪽: 모르는 케이스로 센다). 이름 없음(`(이름 없음)`)도 모르는 케이스다.
 * @param acceptanceTexts 저장소 상대 경로(`bive-acceptance/…`) → 파일 글
 */
export const knownCaseMatcher = (
  acceptanceTexts: Readonly<Record<string, string>>,
): CaseNameFilter => {
  const byRule = new Map<string, Set<string>>();
  const literalsOf = (ruleDisplayId: string): Set<string> => {
    const cached = byRule.get(ruleDisplayId);
    if (cached !== undefined) return cached;
    const prefix = `bive-acceptance/${ruleDisplayId}/`;
    const literals = new Set<string>();
    for (const [file, text] of Object.entries(acceptanceTexts)) {
      if (!file.startsWith(prefix)) continue;
      for (const value of caseNameLiterals(text)) literals.add(value);
    }
    byRule.set(ruleDisplayId, literals);
    return literals;
  };
  return (ruleDisplayId, name) => coveredBy(name, literalsOf(ruleDisplayId));
};

/** 규칙의 최근 판정을 한 커밋 (대조할 글을 읽는 곳). */
export interface JudgedCaseSource {
  readonly ruleDisplayId: string;
  readonly commit: string;
}

/** 저장소의 규칙마다 최근 판정을 한 커밋 (판정 기록이 있는 규칙만, 읽기만). */
export const latestJudgedSources = (store: ProjectStore): JudgedCaseSource[] =>
  [...store.judgments.latestForRules()].flatMap(([ruleId, judgment]) => {
    const rule = store.rules.get(ruleId);
    return rule === null ? [] : [{ ruleDisplayId: rule.displayId, commit: judgment.commit }];
  });

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** UTF-8로 앞 `max` 바이트까지만 (넘지 않으면 그대로). */
const clipBytes = (text: string, max: number): string => {
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= max ? text : bytes.subarray(0, max).toString('utf8');
};

/**
 * 규칙마다 최근 판정을 한 커밋의 그 규칙 폴더 인수 테스트 파일 글을 git 객체에서 읽는다 (작업 트리 · 워크트리는 읽지 않는다).
 * 대체 객체(`refs/replace`)는 따르지 않는다(`--no-replace-objects`, 판정한 커밋 그대로). 커밋 형식(16진 40 · 64자)이 아닌 값은
 * git을 부르지 않는다. 일반 파일(모드 100644 · 100755)만 읽고 기호 링크 · 하위 모듈은 건너뛴다. 커밋을 읽지 못하면 그 규칙은
 * 글이 없다(모르는 이름이 된다).
 * @returns 저장소 상대 경로(`bive-acceptance/<표시 ID>/…`) → 글 (파일당 {@link ACCEPTANCE_TEXT_MAX_BYTES}까지)
 */
export const readJudgedAcceptanceTexts = async (
  repoPath: string,
  sources: readonly JudgedCaseSource[],
  git: GitRunner = createGitRunner(),
): Promise<Record<string, string>> => {
  const byCommit = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!COMMIT_SHA.test(source.commit)) continue;
    const ids = byCommit.get(source.commit) ?? new Set<string>();
    ids.add(source.ruleDisplayId);
    byCommit.set(source.commit, ids);
  }
  const texts: Record<string, string> = {};
  for (const [commit, ids] of byCommit) {
    let listing: string;
    try {
      listing = (
        await git(
          ['--no-replace-objects', 'ls-tree', '-r', '-z', '-l', commit, '--', 'bive-acceptance/'],
          {
            cwd: repoPath,
          },
        )
      ).stdout;
    } catch {
      continue;
    }
    for (const entry of listing.split('\0')) {
      // `<모드> <종류> <객체> <크기>\t<경로>`
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, object] = entry.slice(0, tab).split(/ +/u);
      const file = entry.slice(tab + 1);
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || object === undefined) {
        continue;
      }
      const ruleDir = file.split('/')[1];
      if (ruleDir === undefined || !ids.has(ruleDir)) continue;
      try {
        const blob = (
          await git(['--no-replace-objects', 'cat-file', 'blob', object], { cwd: repoPath })
        ).stdout;
        texts[file] = clipBytes(blob, ACCEPTANCE_TEXT_MAX_BYTES);
      } catch {
        continue;
      }
    }
  }
  return texts;
};

/** 규칙마다 최근 판정을 한 커밋의 인수 테스트 파일과 대조하는 함수 ({@link knownCaseMatcher}). */
export const judgedCaseFilter = async (
  repoPath: string,
  sources: readonly JudgedCaseSource[],
  git?: GitRunner,
): Promise<CaseNameFilter> =>
  knownCaseMatcher(await readJudgedAcceptanceTexts(repoPath, sources, git));

/**
 * Red 확인을 돈 테스트 작성 커밋의 대상 규칙 폴더 (테스트 작성 세션의 앞 시도 사유를 거르는 기준, M3-40 #281 · ADR-128).
 * 케이스 이름은 {@link knownCaseMatcher}로, 위치(파일 경로)는 그 커밋의 대상 규칙 폴더에 있는 일반 파일인지로 대조한다.
 */
export interface WrittenAcceptance {
  /** 그 커밋의 대상 규칙 폴더 파일에 케이스 이름 리터럴로 적힌 이름인지 */
  readonly isKnownCase: CaseNameFilter;
  /** 그 커밋의 대상 규칙 폴더 일반 파일 (저장소 상대 경로 `bive-acceptance/<표시 ID>/…`) */
  readonly files: ReadonlySet<string>;
  /** 대상 규칙 표시 ID (규칙 폴더 자체 `bive-acceptance/<표시 ID>`를 위치로 받는 기준) */
  readonly ruleDisplayIds: ReadonlySet<string>;
}

/** 아무 이름 · 위치도 모른다 (커밋을 읽지 못했거나 Red 확인 결과가 아닐 때: 덜 싣는 쪽). */
export const NO_WRITTEN_ACCEPTANCE: WrittenAcceptance = {
  isKnownCase: NO_KNOWN_CASES,
  files: new Set(),
  ruleDisplayIds: new Set(),
};

/**
 * Red 확인 단계 결과에 남은 커밋(`exitDetail.commit`, Red 확인이 판정한 테스트 작성 커밋)의 대상 규칙 폴더 파일을 git 객체에서
 * 읽어 대조 기준을 만든다({@link readJudgedAcceptanceTexts}와 같은 읽기: 작업 트리를 읽지 않고, 대체 객체를 따르지 않고, 커밋
 * 형식 · 일반 파일만). 커밋이 문자열이 아니거나 읽지 못하면 아무 이름 · 위치도 모른다(닫힌 쪽).
 */
export const writtenAcceptanceOf = async (
  repoPath: string,
  commit: unknown,
  ruleDisplayIds: readonly string[],
  git?: GitRunner,
): Promise<WrittenAcceptance> => {
  if (typeof commit !== 'string') return NO_WRITTEN_ACCEPTANCE;
  const texts = await readJudgedAcceptanceTexts(
    repoPath,
    ruleDisplayIds.map((ruleDisplayId) => ({ ruleDisplayId, commit })),
    git,
  );
  const files = Object.keys(texts);
  if (files.length === 0) return NO_WRITTEN_ACCEPTANCE;
  return {
    isKnownCase: knownCaseMatcher(texts),
    files: new Set(files),
    ruleDisplayIds: new Set(ruleDisplayIds),
  };
};

/**
 * 세션 입력을 모으기 직전에 부른다: 저장소에서 규칙마다 최근 판정 커밋을 읽고, 그 커밋의 인수 테스트 파일과 대조하는 함수를 만든다.
 * 규범 자료(`collectNormInput`)와 인용 출처(`norms/agent-rule.ts`)가 같은 함수를 받는다.
 */
export const latestJudgedCaseFilter = async (
  read: <T>(fn: (store: ProjectStore) => T) => T,
  repoPath: string,
  git?: GitRunner,
): Promise<CaseNameFilter> => judgedCaseFilter(repoPath, read(latestJudgedSources), git);
