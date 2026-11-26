// 변이 주입 역할의 시스템 프롬프트 · 작업 지시 (JDG-04 · RUN-04 · NFR-02, M3-07 #52, ADR-033 · ADR-139).
// 이 역할이 받는 것은 대상 규칙의 제목 · 진술과 대상 블록의 소스 사본(세션 폴더, 읽기 전용)뿐이다. 인수 테스트 · 판정 기록 · 케이스
// 이름 · 효력 있는 다른 규범은 싣지 않는다(역할 분리: 그 테스트만 피하는 변이를 고르지 못하게). 규칙의 글은 표시 값으로만 싣는다.
import type { Block, Rule } from '@bive/shared';

import { displayText } from '../text-limit.js';

/** 작업 지시에 싣는 글의 상한 (표시 값 기준). */
export const MUTATOR_TEXT_LIMITS = { title: 1000, statement: 8000, pattern: 200 } as const;

export const MUTATOR_SYSTEM_PROMPT = [
  '너는 BIVE의 변이 주입 역할이다. 대상 규칙의 인수 테스트가 결함을 잡는지 보려고, 그 규칙을 어기게 만드는 작은 결함(변이) 1개를 낸다.',
  '- 세션 폴더에는 대상 규칙의 글(rules/)과 대상 블록 소스 파일의 읽기 전용 사본만 있다. read_file · list_files · search_files로 읽는다. 파일을 쓰거나 명령을 실행할 수 없다.',
  '- 인수 테스트는 볼 수 없다. 규칙의 진술만 보고 그 동작을 어기는 변이를 고른다.',
  '- 변이는 propose_mutant로 한 번만 낸다: 대상 블록 파일 하나에서 정확히 한 번 나오는 글(search)을 다른 글(replace)로 바꾼다. 경로는 세션 폴더의 사본과 같은 프로젝트 루트 기준 경로다.',
  '- 빌드 · 기동을 깨는 변이(문법 오류, 없는 이름, 프로세스 종료)는 내지 않는다. 그런 변이는 검출로 세지 않는다. 진술의 동작만 바꾸는 작은 변경(값 · 조건 · 반환)을 고른다.',
  '- 변이가 받아들여지면 세션은 끝난다. 거부되면 사유를 읽고 고쳐 다시 낸다. 낼 변이가 없으면 내지 않고 끝내도 된다(그 규칙은 변이 미검증으로 남는다).',
].join('\n');

/** 작업 지시의 입력. */
export interface MutatorTaskInput {
  readonly runDisplayId: string;
  readonly rule: Pick<Rule, 'displayId' | 'title' | 'statement'>;
  /** 대상 규칙의 대상 블록 (지금 선언의 블록) */
  readonly blocks: readonly Pick<Block, 'name' | 'include'>[];
  /** 세션 폴더에 놓은 사본 수 · 상한으로 빼고 놓지 못한 수 */
  readonly copied: number;
  readonly omitted: number;
}

/** 규칙 글 파일의 세션 폴더 안 경로 (`rules/<표시 ID>.md`). */
export const mutatorRuleFile = (displayId: string): string => `rules/${displayId}.md`;

/** 작업 지시. 규칙 제목 · 진술 · 블록 패턴은 표시 값(한 줄)이다. */
export const mutatorTaskPrompt = (input: MutatorTaskInput): string => {
  const { rule } = input;
  const blocks = input.blocks.map(
    (block) =>
      `- ${block.name}: ${block.include
        .map((pattern) => displayText(pattern, MUTATOR_TEXT_LIMITS.pattern).text)
        .join(', ')}`,
  );
  return [
    `실행 ${input.runDisplayId}의 변이 주입. 대상 규칙 ${rule.displayId}`,
    `제목: ${displayText(rule.title, MUTATOR_TEXT_LIMITS.title).text}`,
    `진술: ${displayText(rule.statement, MUTATOR_TEXT_LIMITS.statement).text}`,
    '대상 블록 (이 include에 드는 파일만 바꿀 수 있다):',
    ...blocks,
    `세션 폴더: ${mutatorRuleFile(rule.displayId)}, 대상 블록 소스 사본 ${String(input.copied)}개${
      input.omitted > 0 ? ` (상한으로 빠진 파일 ${String(input.omitted)}개)` : ''
    }`,
    '이 규칙을 어기게 만드는 변이 1개를 propose_mutant로 낸다.',
  ].join('\n');
};
