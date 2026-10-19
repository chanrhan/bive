// 프로젝트 설정의 실행 전 검사 (COST-01, NFR-07, M1-05, ADR-057).
// - `settings.validateForRun` RPC는 검사 결과를 값으로 돌려주고(화면의 검증 상태 표시),
//   실행 생성(#25 `run.create`) · 규칙 자동 생성 세션(#21) 등 설정이 필요한 작업은 `requireRunnableSettings`로
//   같은 검사를 하고 미설정이면 -32010(`SETTINGS_INCOMPLETE`, "예산 · 모델 미설정")으로 거부한다
// - 검사 범위: 실행 전체 한도(USD · 턴)는 항상, 역할은 `roles`(생략하면 M1 필수 역할 rule-writer · test-writer ·
//   implementer)의 모델 · 한도(USD · 턴). planner · chat 등은 그 역할을 쓰는 이슈가 `roles`로 넘긴다
import {
  type AgentRole,
  ErrorCode,
  findMissingSettings,
  type MissingSetting,
  RUN_REQUIRED_ROLES,
  SETTINGS_INCOMPLETE_MESSAGE,
  SETTINGS_INCOMPLETE_REASON,
  type Settings,
  type SettingsIncompleteData,
  type SettingsValidateResult,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { RpcError } from '../ipc/server.js';

/** 검사 결과 (`settings.validateForRun`의 결과 값). */
export const validateSettingsForRun = (
  settings: Pick<Settings, 'run' | 'roles'>,
  roles: readonly AgentRole[] = RUN_REQUIRED_ROLES,
): SettingsValidateResult => {
  const missing = findMissingSettings(settings, roles);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    code: ErrorCode.SettingsIncomplete,
    reason: SETTINGS_INCOMPLETE_REASON,
    message: SETTINGS_INCOMPLETE_MESSAGE,
    missing,
  };
};

/** 설정 미비 오류 (-32010). `data`는 `{ reason: 'SETTINGS_INCOMPLETE', missing }`. */
export const settingsIncompleteError = (missing: readonly MissingSetting[]): RpcError => {
  const data: SettingsIncompleteData = {
    reason: SETTINGS_INCOMPLETE_REASON,
    missing: [...missing],
  };
  return new RpcError(ErrorCode.SettingsIncomplete, SETTINGS_INCOMPLETE_MESSAGE, data);
};

/**
 * 열린 저장소의 설정을 검사해 통과하면 설정을 돌려주고(실행의 예산 · 모델 스냅샷용), 아니면 -32010을 던진다.
 * 실행 생성처럼 같은 트랜잭션 안에서 검사와 저장을 함께 해야 하는 쪽이 쓴다.
 * @throws {RpcError} -32010 설정 미비
 */
export const requireRunnableSettings = (
  store: ProjectStore,
  roles: readonly AgentRole[] = RUN_REQUIRED_ROLES,
): Settings => {
  const settings = store.settings.get();
  const missing = findMissingSettings(settings, roles);
  if (missing.length > 0) throw settingsIncompleteError(missing);
  return settings;
};
