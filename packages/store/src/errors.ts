// 저장소 오류. 오케스트레이터가 IPC 오류 코드(-32004 없음 · -32009 상태 충돌)로 옮길 때 종류로 구분한다.

/** 저장소 오류의 공통 부모. */
export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 찾는 대상(행 · DB 파일)이 없다. */
export class NotFoundError extends StoreError {
  constructor(
    readonly entity: string,
    readonly id: string,
    options?: ErrorOptions,
  ) {
    super(`${entity}을(를) 찾을 수 없습니다: ${id}`, options);
  }
}

/** 이미 있는 대상과 충돌한다 (중복 키 · 다른 내용의 같은 ID). */
export class ConflictError extends StoreError {
  constructor(
    readonly entity: string,
    readonly id: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${entity} 충돌 (${id}): ${detail}`, options);
  }
}

/** 마이그레이션 목록 · 적용 기록이 맞지 않는다. 이 DB는 열지 않는다. */
export class MigrationError extends StoreError {}

/** better-sqlite3의 기본 키 · 유일 제약 위반인지 확인한다. */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE');
