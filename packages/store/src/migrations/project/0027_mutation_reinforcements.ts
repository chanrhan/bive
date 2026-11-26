import type { Migration } from '../../migrate.js';

/**
 * 변이 보강 연결 (JDG-04 · RUN-07, M3-54 #311, ADR-141 ③ · ADR-143).
 * - `mutation_reinforcements`: 변이 생존의 자동 테스트 보강 실행(유형 C) 1개와 그 원인 변이 기록 1건. 실행 표를 다시 만들지 않고
 *   이 표의 연결이 있는 유형 C 실행을 "보강"으로 본다(변이 주입 단계 = 그 변이의 재주입). `seq`는 그 실행 시작 주체
 *   (`runs.started_by`, `causeLog: 'mutation_reinforcements'`)의 원인 순번이다: 0016의 시작 주체 CHECK가 양의 정수 순번을 요구한다
 * - 실행마다 하나 · 변이 기록마다 하나(`UNIQUE`): 같은 변이로 보강 실행이 둘 생기지 않고, 보강이 실패로 끝난 뒤에도 같은 변이로
 *   다시 만들지 않는다
 * - 넣을 때(트리거): 원인 기록이 '변이 생존'이고 그 기록의 실행이 유형 A(보강 실행의 재주입 기록은 원인이 될 수 없다: 고리 방지),
 *   잇는 실행이 유형 C이고 그 대상 규칙에 원인 기록의 규칙이 있어야 한다. 추가 전용(수정 · 삭제 거부)
 * - 새 표만 더한다
 */
export const migration: Migration = {
  version: 27,
  name: 'mutation_reinforcements',
  up: `
CREATE TABLE mutation_reinforcements (
  seq INTEGER PRIMARY KEY NOT NULL CHECK (seq > 0),
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (id),
  mutation_result_id TEXT NOT NULL UNIQUE REFERENCES mutation_results (id),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  )
) STRICT;

CREATE TRIGGER mutation_reinforcements_cause BEFORE INSERT ON mutation_reinforcements
WHEN NOT EXISTS (
  SELECT 1 FROM mutation_results AS m JOIN runs AS origin ON origin.id = m.run_id
  WHERE m.id = NEW.mutation_result_id AND m.status = 'survived' AND origin.type = 'A'
)
BEGIN
  SELECT RAISE(ABORT, 'mutation_reinforcements: 원인은 유형 A 실행의 변이 생존 기록이어야 합니다');
END;

CREATE TRIGGER mutation_reinforcements_run BEFORE INSERT ON mutation_reinforcements
WHEN NOT EXISTS (
  SELECT 1 FROM runs AS r JOIN run_target_rules AS t ON t.run_id = r.id
  WHERE r.id = NEW.run_id AND r.type = 'C'
    AND t.rule_id = (SELECT rule_id FROM mutation_results WHERE id = NEW.mutation_result_id)
)
BEGIN
  SELECT RAISE(ABORT, 'mutation_reinforcements: 보강 실행은 원인 규칙을 대상으로 한 유형 C 실행이어야 합니다');
END;

CREATE TRIGGER mutation_reinforcements_no_update BEFORE UPDATE ON mutation_reinforcements
BEGIN
  SELECT RAISE(ABORT, 'mutation_reinforcements: 변이 보강 연결은 바꿀 수 없습니다');
END;

CREATE TRIGGER mutation_reinforcements_no_delete BEFORE DELETE ON mutation_reinforcements
BEGIN
  SELECT RAISE(ABORT, 'mutation_reinforcements: 변이 보강 연결은 지울 수 없습니다');
END;
`,
};
