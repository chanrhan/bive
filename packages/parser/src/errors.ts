// 파서 오류 (M3-02 #47, ADR-125). 분석을 끝까지 못 했으면 결과를 돌려주지 않고 이 오류로 던진다.
// "위반 0건"과 "분석 실패"가 같은 모양으로 읽히지 않게 하려는 것이다(닫힌 쪽, ADR-120의 원칙).

/** 오류 종류. 호출하는 쪽(M3-03)이 판정 기록 · 로그에 남길 고정 값이다. */
export type ParserErrorCode =
  /** 프로젝트 폴더가 없거나 폴더가 아님 */
  | 'project_not_found'
  /** 블록 선언이 shared 스키마를 지나지 않음 */
  | 'invalid_declaration'
  /** 소스 파일 수가 상한을 넘음 */
  | 'too_many_files'
  /** 경로 하나가 길이 상한을 넘음 */
  | 'path_too_long'
  /** dependency-cruiser 실행기가 0이 아닌 종료 코드로 끝났거나 신호로 죽음 */
  | 'cruise_failed'
  /** 시간 제한을 넘음 */
  | 'cruise_timeout'
  /** 출력이 크기 상한을 넘음 */
  | 'cruise_output_too_large'
  /** 출력이 JSON이 아니거나 읽는 모양과 다름 */
  | 'cruise_output_invalid'
  /** 우리가 찾은 소스 파일을 dependency-cruiser가 분석하지 않았음 */
  | 'file_not_analyzed'
  /** import가 대소문자만 다른 경로로 풀림 (대소문자를 가리지 않는 파일 시스템) */
  | 'path_case_mismatch';

export class ParserError extends Error {
  readonly code: ParserErrorCode;

  constructor(code: ParserErrorCode, message: string) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
  }
}
