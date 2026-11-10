// 규범 저장소 무결성 스냅숏 (NFR-01, #117 기본 조치, ADR-052 한계 · ADR-069).
// 고정 도구의 경로 가드는 파일 도구만 막는다. `run_tests` · 판정이 실행하는 프로젝트 코드는 같은 OS 사용자 권한으로
// `bive.db`를 읽고 쓸 수 있으므로, 에이전트 코드가 도는 구간(세션 · 판정)의 앞뒤에서 판정에 영향을 주는 기록을 대조한다.
// 스냅숏은 오케스트레이터 메모리에만 두고(DB에 두면 같은 경로로 고칠 수 있다) 같은 단계 실행기 안에서만 비교한다.
//
// 대조 대상과 규칙 (오케스트레이터 자신 · 사람의 정상 쓰기와 겹치지 않는 범위):
// - 승인 기록: 해시 체인이 유효하고, 스냅숏 때까지의 기록(순번 · 해시)이 그대로여야 한다. 뒤에 붙는 기록은 허용한다
//   (실행 중 사람이 다른 제안을 승인 · 실행을 시작할 수 있다. 추가 전용 기록이라 앞부분이 그대로면 변조가 아니다)
// - 규칙: 스냅숏 때 있던 규칙마다 판정에 쓰이는 열(표시 ID · 제목 · 진술 · 종류 · 검사 종류 · 내장 · 규범 상태 · 삭제 시각)이
//   그대로여야 하고 사라지면 안 된다. 새 규칙은 허용한다(사람의 승인). 부모 해제 열은 사람의 요구사항 삭제로 바뀌므로 보지 않는다
// - 이 실행의 기록: 실행 행 · 대상 규칙 · 단계 시도 · 판정 기록은 단계 실행기가 도는 동안 엔진도 쓰지 않으므로 전부 그대로여야 한다
//   (Red 확인의 인수 테스트 해시 · 예산 스냅숏 · 대상 규칙을 고쳐 가드를 우회하는 것을 막는다)
// 세션 · 도구 호출 기록, 제안, 다른 실행의 기록은 정상 동작 중에도 바뀌므로 대조하지 않는다.
import { createHash } from 'node:crypto';

import { canonicalJson } from './approval-chain.js';
import type { ProjectStore } from './project-store.js';

/** 규범 저장소 스냅숏. 오케스트레이터 메모리에만 둔다. */
export interface NormSnapshot {
  readonly runId: string;
  /** 승인 기록 체인이 유효한지 (아니면 깨진 순번 · 사유) */
  readonly approvalChain: { readonly valid: boolean; readonly detail: string | null };
  /** 승인 기록 수 · 마지막 해시 */
  readonly approvalCount: number;
  readonly approvalHead: string | null;
  /** 순번 → 해시 (앞부분 불변 확인용) */
  readonly approvalHashes: ReadonlyMap<number, string>;
  /** 규칙 ID → 판정 관련 열의 해시 */
  readonly rules: ReadonlyMap<string, { readonly displayId: string; readonly hash: string }>;
  /** 이 실행의 실행 · 대상 규칙 · 단계 · 판정 기록 해시 */
  readonly runRecords: string;
}

/** 스냅숏 대조 결과 한 건. */
export interface NormMismatch {
  readonly kind:
    | 'approval_chain_broken'
    | 'approval_log_rewritten'
    | 'rule_changed'
    | 'rule_removed'
    | 'run_records_changed'
    | 'unreadable';
  readonly detail: string;
}

const sha256 = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

interface RuleColumns {
  id: string;
  display_id: string;
  title: string;
  statement: string;
  kind: string;
  check_kinds: string;
  builtin: number;
  norm_state: string;
  deleted_at: string | null;
}

/**
 * 규범 저장소의 현재 모습을 스냅숏으로 만든다. 행은 스키마 검증 없이 그대로 읽는다(고쳐진 행도 읽어야 한다).
 * @throws {SqliteError} 테이블을 읽지 못할 때 (호출자는 불일치로 다룬다)
 */
export const captureNormSnapshot = (store: ProjectStore, runId: string): NormSnapshot => {
  const db = store.db;
  const approvals = db
    .prepare<[], { seq: number; hash: string }>('SELECT seq, hash FROM approval_log ORDER BY seq')
    .all();
  const chain = store.approvalLog.verify();
  const rules = db
    .prepare<[], RuleColumns>(
      `SELECT id, display_id, title, statement, kind, check_kinds, builtin, norm_state, deleted_at
       FROM rules ORDER BY id`,
    )
    .all();
  const runRows = {
    run: db.prepare('SELECT * FROM runs WHERE id = ?').all(runId),
    targets: db
      .prepare('SELECT * FROM run_target_rules WHERE run_id = ? ORDER BY position')
      .all(runId),
    steps: db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY id').all(runId),
    judgments: db.prepare('SELECT * FROM judgments WHERE run_id = ? ORDER BY id').all(runId),
  };
  return {
    runId,
    approvalChain: chain.valid
      ? { valid: true, detail: null }
      : {
          valid: false,
          detail: `${chain.reason}${chain.brokenAtSeq === null ? '' : ` (순번 ${String(chain.brokenAtSeq)})`}`,
        },
    approvalCount: approvals.length,
    approvalHead: approvals.at(-1)?.hash ?? null,
    approvalHashes: new Map(approvals.map((row) => [row.seq, row.hash])),
    rules: new Map(rules.map((row) => [row.id, { displayId: row.display_id, hash: sha256(row) }])),
    runRecords: sha256(runRows),
  };
};

/** 앞 스냅숏 이후 판정에 영향을 주는 기록이 바뀌었는지 대조한다. 빈 목록이면 그대로다. */
export const compareNormSnapshots = (before: NormSnapshot, after: NormSnapshot): NormMismatch[] => {
  const mismatches: NormMismatch[] = [];
  if (!after.approvalChain.valid) {
    mismatches.push({
      kind: 'approval_chain_broken',
      detail: `승인 기록 해시 체인이 깨졌습니다: ${String(after.approvalChain.detail)}`,
    });
  }
  if (after.approvalCount < before.approvalCount) {
    mismatches.push({
      kind: 'approval_log_rewritten',
      detail: `승인 기록이 줄었습니다 (${String(before.approvalCount)} → ${String(after.approvalCount)})`,
    });
  } else {
    for (const [seq, hash] of before.approvalHashes) {
      if (after.approvalHashes.get(seq) !== hash) {
        mismatches.push({
          kind: 'approval_log_rewritten',
          detail: `승인 기록 순번 ${String(seq)}이(가) 바뀌었습니다`,
        });
        break;
      }
    }
  }
  for (const [id, rule] of before.rules) {
    const now = after.rules.get(id);
    if (now === undefined) {
      mismatches.push({ kind: 'rule_removed', detail: `규칙이 사라졌습니다: ${rule.displayId}` });
    } else if (now.hash !== rule.hash) {
      mismatches.push({ kind: 'rule_changed', detail: `규칙이 바뀌었습니다: ${rule.displayId}` });
    }
  }
  if (before.runId !== after.runId || before.runRecords !== after.runRecords) {
    mismatches.push({
      kind: 'run_records_changed',
      detail: '실행 · 대상 규칙 · 단계 · 판정 기록이 바뀌었습니다',
    });
  }
  return mismatches;
};
