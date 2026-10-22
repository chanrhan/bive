// 규칙 진술(EARS) 형식 검사 (NRM-02, 기획서 3.1, ADR-062).
// M1은 사건 기반 패턴 `WHEN <조건> THE SYSTEM SHALL <응답>` 하나만 받는다(보수적 최소 형식).
// - 키워드는 대문자만 인정한다(`when` · `The system shall`은 키워드가 아님)
// - 진술은 한 줄이다(줄바꿈 · 탭 등 제어 문자 불가). 앞뒤 공백도 받지 않는다
// - `WHEN` 뒤와 `THE SYSTEM SHALL` 앞뒤는 공백 한 칸이고, 조건 · 응답은 비어 있지 않으며 공백으로 시작 · 끝나지 않는다
// - `THE SYSTEM SHALL`은 한 번만 나온다
// 상시형(`THE SYSTEM SHALL …`) · 상태형(`WHILE`) · 선택형(`WHERE`) · 비정상형(`IF … THEN`)은 M1에서 받지 않는다.

/** 조건 키워드 (문장 맨 앞, 뒤에 공백 한 칸). */
export const EARS_WHEN = 'WHEN';
/** 응답 키워드 (앞뒤 공백 한 칸). */
export const EARS_SHALL = 'THE SYSTEM SHALL';

/** 진술 형식 예시 (도구 오류 · 시스템 프롬프트에 그대로 쓴다). */
export const EARS_FORMAT = `${EARS_WHEN} <조건> ${EARS_SHALL} <응답>`;

/** 줄바꿈 · 탭을 포함한 제어 문자와 줄 · 문단 구분 문자 (한 줄 문장 검사용). */
// eslint-disable-next-line no-control-regex -- 제어 문자를 찾는 것이 목적
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** 비어 있지 않고 공백으로 시작 · 끝나지 않는 구절. */
const TRIMMED_PHRASE = /^\S(?:.*\S)?$/u;

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * 진술이 `WHEN <조건> THE SYSTEM SHALL <응답>` 형식이 아니면 사유(모델에게 돌려줄 문장)를, 맞으면 `null`을 돌려준다.
 */
export const earsStatementProblem = (statement: string): string | null => {
  if (CONTROL_CHARACTERS.test(statement))
    return '진술은 한 줄이어야 함 (줄바꿈 · 탭 등 제어 문자 불가)';
  if (statement !== statement.trim()) return '진술 앞뒤에 공백을 둘 수 없음';
  const head = `${EARS_WHEN} `;
  if (!statement.startsWith(head)) {
    return `진술은 대문자 ${EARS_WHEN}와 공백 한 칸으로 시작해야 함 (${EARS_FORMAT})`;
  }
  const occurrences = countOccurrences(statement, EARS_SHALL);
  if (occurrences === 0) return `진술에 대문자 ${EARS_SHALL}가 있어야 함 (${EARS_FORMAT})`;
  if (occurrences > 1) return `${EARS_SHALL}는 한 번만 쓸 수 있음`;
  const separator = ` ${EARS_SHALL} `;
  const at = statement.indexOf(separator);
  if (at < 0) return `${EARS_SHALL} 앞뒤는 공백 한 칸이어야 함 (${EARS_FORMAT})`;
  const condition = statement.slice(head.length, at);
  const response = statement.slice(at + separator.length);
  if (!TRIMMED_PHRASE.test(condition)) {
    return `${EARS_WHEN} 뒤 조건이 비어 있거나 공백이 겹침 (${EARS_FORMAT})`;
  }
  if (!TRIMMED_PHRASE.test(response)) {
    return `${EARS_SHALL} 뒤 응답이 비어 있거나 공백이 겹침 (${EARS_FORMAT})`;
  }
  return null;
};

/** 진술이 M1의 EARS 형식인지. */
export const isEarsStatement = (statement: string): boolean =>
  earsStatementProblem(statement) === null;
