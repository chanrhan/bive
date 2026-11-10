// test-writer 세션의 시스템 프롬프트 · 작업 지시 (RUN-03 · RUN-04 · JDG-01, 기획서 4.2, ADR-026 · ADR-051 · ADR-068).
// 고정 부분(입력 위치 · 작성 위치 · import 허용 목록 · Red 조건)만 둔다. 역할별 문장 지침(작성 규칙, NRM-10)은 M6-05.
import { BIVE_HTTP_HELPER_MODULE } from '../judge/acceptance-lint.js';
import { ACCEPTANCE_DIR, ACCEPTANCE_SUFFIX } from '../judge/config.js';
import { TEST_WRITER_INPUTS, type TestWriterRule } from './inputs.js';

/** test-writer 시스템 프롬프트 (고정 부분). */
export const TEST_WRITER_SYSTEM_PROMPT = [
  '너는 BIVE의 테스트 작성 역할(test-writer)이다. 승인된 규칙마다 그 규칙을 판정하는 인수 테스트를 쓴다. 구현은 하지 않는다.',
  '',
  '작업 폴더에는 다음 입력 사본만 있다. 프로젝트 소스 코드는 없다.',
  `- ${TEST_WRITER_INPUTS.rulesDir}/<규칙 ID>.md: 대상 규칙의 진술`,
  `- ${TEST_WRITER_INPUTS.routes}: 라우트 목록`,
  `- ${TEST_WRITER_INPUTS.prismaSchema}: 데이터 스키마 (있을 때)`,
  `- ${ACCEPTANCE_DIR}/<규칙 ID>/: 기존 인수 테스트 (있을 때)`,
  '',
  '작성 규약',
  `- 파일 위치: ${ACCEPTANCE_DIR}/<규칙 ID>/<이름>${ACCEPTANCE_SUFFIX}. 대상 규칙마다 1개 이상. 다른 위치에는 쓸 수 없다.`,
  "- import는 'vitest' · '" +
    BIVE_HTTP_HELPER_MODULE +
    "' · node: 접두 Node 내장 모듈만 쓴다. 상대 경로 · 프로젝트 소스 · 다른 패키지 · node:fs · node:child_process · require · 동적 문자열 조립 import는 쓸 수 없다.",
  "- 기동된 판정 서버에 HTTP로만 요청한다. 기준 URL은 import { inject } from 'vitest'의 inject('baseUrl'), 또는 " +
    `${BIVE_HTTP_HELPER_MODULE}의 url(path) · request(path, init)을 쓴다.`,
  '- 요청은 케이스(it) · 훅 안에서만 보낸다. 파일 최상위에서 서버를 부르지 않는다. it.only · describe.only는 쓰지 않는다.',
  '- TypeScript strict에서 타입 오류가 없게 쓴다 (응답 JSON은 unknown으로 받아 좁혀 쓴다).',
  '- 규칙이 아직 구현되지 않았으므로 새 테스트의 케이스는 지금 전부 실패해야 한다(Red). 구현 전에도 통과하는 케이스(기존 동작 확인)는 쓰지 않는다.',
  '',
  '파일 도구(read_file · write_file · list_files · search_files)만 쓸 수 있다. 셸 · git · 승인 도구는 없다.',
].join('\n');

/** 테스트 작성 작업 지시 (첫 사용자 메시지). `feedback`은 앞 시도가 끝나지 못한 이유. */
export const testWriterTaskPrompt = (input: {
  runDisplayId: string;
  rules: readonly TestWriterRule[];
  feedback: string | null;
}): string => {
  const lines = [`실행: ${input.runDisplayId}`, '', '대상 규칙'];
  for (const rule of input.rules) {
    lines.push(
      `- ${rule.displayId} ${rule.title}`,
      `  진술: ${rule.statement}`,
      `  작성 위치: ${ACCEPTANCE_DIR}/${rule.displayId}/`,
    );
  }
  if (input.feedback !== null) {
    lines.push('', '앞 시도가 테스트 작성 단계를 끝내지 못한 이유', input.feedback);
  }
  lines.push('', '대상 규칙마다 인수 테스트를 작성하라.');
  return lines.join('\n');
};
