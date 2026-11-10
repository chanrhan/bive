// implementer 세션의 시스템 프롬프트 · 작업 지시 (RUN-04 · JDG-01 · NFR-02, 기획서 4.2, ADR-024 · ADR-052 · ADR-069).
// 고정 부분(작업 위치 · 쓰기 금지 범위 · 판정 방식)만 둔다. 역할별 문장 지침(작성 규칙, NRM-10)은 M6-05.
import { ACCEPTANCE_DIR } from '../judge/config.js';

/** implementer 시스템 프롬프트 (고정 부분). */
export const IMPLEMENTER_SYSTEM_PROMPT = [
  '너는 BIVE의 구현 역할(implementer)이다. 승인된 규칙의 인수 테스트가 통과하도록 프로젝트 코드를 고친다.',
  '',
  '작업 폴더는 이 실행 전용 워크트리다. 커밋 · 병합은 BIVE가 한다.',
  `- ${ACCEPTANCE_DIR}/ 아래 인수 테스트는 읽기만 할 수 있다. 고칠 수 없고, 바뀌면 실행이 실패한다.`,
  '- .git · .bive.json · node_modules는 쓸 수 없다. 의존성 설치는 BIVE가 한다.',
  '- 파일 도구(read_file · write_file · list_files · search_files)와 고정 명령(run_tests · prisma_generate · prisma_migrate · install_package)만 쓸 수 있다. 셸 · git · 승인 도구는 없다.',
  '',
  '판정',
  '- 세션이 끝나면 BIVE가 바뀐 코드를 커밋하고, 그 커밋의 깨끗한 체크아웃에서 판정 러너로 대상 규칙의 인수 테스트를 직접 돌린다.',
  '- 대상 인수 테스트의 케이스가 전부 통과해야 구현 단계가 끝난다. 세션의 보고 내용(통과했다는 말 등)은 판정에 쓰이지 않는다.',
  '- 커밋되지 않는 파일(.gitignore에 걸린 파일)은 판정 · 병합에 들어가지 않는다.',
].join('\n');

export interface ImplementerPromptRule {
  readonly displayId: string;
  readonly title: string;
  readonly statement: string;
}

/** 구현 작업 지시 (첫 사용자 메시지). `feedback`은 앞 시도가 끝나지 못한 이유. */
export const implementerTaskPrompt = (input: {
  runDisplayId: string;
  rules: readonly ImplementerPromptRule[];
  acceptanceFiles: readonly string[];
  feedback: string | null;
}): string => {
  const lines = [`실행: ${input.runDisplayId}`, '', '대상 규칙'];
  for (const rule of input.rules) {
    lines.push(`- ${rule.displayId} ${rule.title}`, `  진술: ${rule.statement}`);
  }
  lines.push('', '대상 인수 테스트');
  for (const file of input.acceptanceFiles) lines.push(`- ${file}`);
  if (input.feedback !== null) {
    lines.push('', '앞 시도가 구현 · 검사 단계를 끝내지 못한 이유', input.feedback);
  }
  lines.push('', '대상 인수 테스트가 통과하도록 구현하라.');
  return lines.join('\n');
};
