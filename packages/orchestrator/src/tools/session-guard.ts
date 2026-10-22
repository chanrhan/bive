// 세션 가드 (NFR-02 · ADR-024 · ADR-052 · ADR-059). 세션 init의 도구 목록 · MCP 서버를 역할 허용 목록과 대조하고
// 플러그인 · 권한 모드(보고하는 어댑터만)를 확인해, 다르면(계정 MCP · 내장 도구 · 빠진 도구 · 플러그인 · 다른 권한 모드)
// 세션을 중단한다. 도구 목록 · MCP 수는 위반 여부와 상관없이 기록한다.
import type { AgentRole, ToolManifestEntry } from '@bive/shared';

import type { SessionEvent, SessionInitEvent } from '../agent/adapter.js';
import { BIVE_MCP_SERVER, roleToolNames } from './definitions.js';

/** SDK가 MCP 도구에 붙이는 이름 접두 (`mcp__<서버>__<도구>`). BIVE 서버 도구만 접두를 떼고 비교한다. */
export const BIVE_TOOL_PREFIX = `mcp__${BIVE_MCP_SERVER}__`;

/** 에이전트 세션의 권한 모드: 미리 허용하지 않은 도구는 묻지 않고 거부 (ADR-059). */
export const REQUIRED_PERMISSION_MODE = 'dontAsk';

export type SessionGuardViolationKind =
  | 'init_missing'
  | 'tools_mismatch'
  | 'mcp_mismatch'
  | 'plugins_loaded'
  | 'permission_mode_mismatch';

export interface SessionGuardViolation {
  kind: SessionGuardViolationKind;
  /** 허용 목록에 없는데 init에 있는 도구 */
  unexpectedTools: string[];
  /** 허용 목록에 있는데 init에 없는 도구 */
  missingTools: string[];
  unexpectedMcpServers: string[];
  missingMcpServers: string[];
  /** init에 보고된 플러그인 (하나라도 있으면 위반) */
  unexpectedPlugins: string[];
  /** 기대와 다른 권한 모드 (같거나 보고가 없으면 `null`, 빈 문자열은 형식이 틀린 보고) */
  unexpectedPermissionMode: string | null;
}

/** 가드 위반으로 세션을 멈출 때의 중단 사유. 세션 종료 사유 `guard_violation`에 대응한다. */
export class SessionGuardError extends Error {
  readonly code = 'guard_violation' as const;
  readonly violation: SessionGuardViolation;
  readonly manifest: ToolManifestEntry | null;

  constructor(violation: SessionGuardViolation, manifest: ToolManifestEntry | null) {
    super(describeViolation(violation));
    this.name = 'SessionGuardError';
    this.violation = violation;
    this.manifest = manifest;
  }
}

export interface SessionGuardExpectation {
  role: AgentRole;
  /** 허용 도구 (기본 역할 허용 목록 `roleToolNames(role)`) */
  tools?: readonly string[];
  /** 허용 MCP 서버 (기본 `['bive']`) */
  mcpServers?: readonly string[];
  /** 기대 권한 모드 (기본 `dontAsk`). init이 권한 모드를 보고할 때만 검사한다 */
  permissionMode?: string;
}

export interface SessionInitCheck {
  /** 실행의 `toolManifest`에 넣을 항목 (init에 보고된 그대로) */
  manifest: ToolManifestEntry;
  violation: SessionGuardViolation | null;
}

/** 비교용 도구 이름: `mcp__bive__read_file` → `read_file`. 다른 서버 도구는 그대로 둔다. */
export const normalizeToolName = (name: string): string =>
  name.startsWith(BIVE_TOOL_PREFIX) ? name.slice(BIVE_TOOL_PREFIX.length) : name;

const difference = (left: Iterable<string>, right: ReadonlySet<string>): string[] =>
  [...new Set(left)].filter((item) => !right.has(item)).sort();

/**
 * init 이벤트를 허용 목록과 대조한다. 순서는 무시하고 집합으로 비교한다. 플러그인은 하나라도 보고되면,
 * 권한 모드는 보고된 값이 기대와 다르면 위반이다(보고하지 않는 어댑터는 두 항목을 검사하지 않음).
 */
export const checkSessionInit = (
  init: SessionInitEvent,
  expectation: SessionGuardExpectation,
): SessionInitCheck => {
  const manifest: ToolManifestEntry = {
    role: expectation.role,
    tools: [...init.tools],
    mcpServerCount: init.mcpServers.length,
  };
  const reportedTools = init.tools.map(normalizeToolName);
  const allowedTools = new Set(expectation.tools ?? roleToolNames(expectation.role));
  const allowedServers = new Set(expectation.mcpServers ?? [BIVE_MCP_SERVER]);
  const unexpectedTools = difference(reportedTools, allowedTools);
  const missingTools = difference(allowedTools, new Set(reportedTools));
  const unexpectedMcpServers = difference(init.mcpServers, allowedServers);
  const missingMcpServers = difference(allowedServers, new Set(init.mcpServers));
  // 같은 도구 · 서버가 두 번 보고되는 것도 허용 목록과 다르다
  const duplicatedTools = new Set(reportedTools).size !== reportedTools.length;
  const duplicatedServers = new Set(init.mcpServers).size !== init.mcpServers.length;
  const toolsBad = unexpectedTools.length > 0 || missingTools.length > 0 || duplicatedTools;
  const serversBad =
    unexpectedMcpServers.length > 0 || missingMcpServers.length > 0 || duplicatedServers;
  const unexpectedPlugins = [...(init.plugins ?? [])].sort();
  const expectedMode = expectation.permissionMode ?? REQUIRED_PERMISSION_MODE;
  const unexpectedPermissionMode =
    init.permissionMode !== undefined && init.permissionMode !== expectedMode
      ? init.permissionMode
      : null;
  const pluginsBad = unexpectedPlugins.length > 0;
  const modeBad = unexpectedPermissionMode !== null;
  if (!toolsBad && !serversBad && !pluginsBad && !modeBad) return { manifest, violation: null };
  let kind: SessionGuardViolationKind = 'permission_mode_mismatch';
  if (serversBad) kind = 'mcp_mismatch';
  else if (toolsBad) kind = 'tools_mismatch';
  else if (pluginsBad) kind = 'plugins_loaded';
  return {
    manifest,
    violation: {
      kind,
      unexpectedTools,
      missingTools,
      unexpectedMcpServers,
      missingMcpServers,
      unexpectedPlugins,
      unexpectedPermissionMode,
    },
  };
};

export const describeViolation = (violation: SessionGuardViolation): string => {
  if (violation.kind === 'init_missing') return '세션 가드: init 메시지 없이 세션이 시작됨';
  const parts: string[] = [];
  if (violation.unexpectedMcpServers.length > 0) {
    parts.push(`허용되지 않은 MCP 서버 ${violation.unexpectedMcpServers.join(', ')}`);
  }
  if (violation.missingMcpServers.length > 0) {
    parts.push(`빠진 MCP 서버 ${violation.missingMcpServers.join(', ')}`);
  }
  if (violation.unexpectedTools.length > 0) {
    parts.push(`허용되지 않은 도구 ${violation.unexpectedTools.join(', ')}`);
  }
  if (violation.missingTools.length > 0) {
    parts.push(`빠진 도구 ${violation.missingTools.join(', ')}`);
  }
  if (violation.unexpectedPlugins.length > 0) {
    parts.push(`허용되지 않은 플러그인 ${violation.unexpectedPlugins.join(', ')}`);
  }
  if (violation.unexpectedPermissionMode !== null) {
    parts.push(`허용되지 않은 권한 모드 ${violation.unexpectedPermissionMode || '(보고 없음)'}`);
  }
  if (parts.length === 0) parts.push('도구 또는 MCP 서버 중복 보고');
  return `세션 가드: ${parts.join(' · ')}`;
};

export interface GuardSessionOptions extends SessionGuardExpectation {
  /** 세션에 넘긴 `signal`의 컨트롤러. 위반이면 SessionGuardError를 사유로 중단한다 */
  controller: AbortController;
  /** init을 받을 때마다 도구 목록 · MCP 수 기록 (위반 여부와 무관) */
  onManifest?: (manifest: ToolManifestEntry, init: SessionInitEvent) => void;
  /** 위반 직후 (중단 전) */
  onViolation?: (error: SessionGuardError) => void;
}

/**
 * 어댑터 이벤트 흐름에 세션 가드를 건다. 첫 이벤트는 init이어야 하고, init(재보고 포함)이
 * 허용 목록과 다르면 `controller.abort(error)` 후 SessionGuardError를 던져 순회를 끝낸다.
 * 위반한 init 이벤트는 내보내지 않는다.
 */
export async function* guardSession(
  events: AsyncIterable<SessionEvent>,
  options: GuardSessionOptions,
): AsyncGenerator<SessionEvent> {
  let seenInit = false;
  const stop = (violation: SessionGuardViolation, manifest: ToolManifestEntry | null): never => {
    const error = new SessionGuardError(violation, manifest);
    options.onViolation?.(error);
    if (!options.controller.signal.aborted) options.controller.abort(error);
    throw error;
  };
  for await (const event of events) {
    if (event.type === 'init') {
      seenInit = true;
      const { manifest, violation } = checkSessionInit(event, options);
      options.onManifest?.(manifest, event);
      if (violation !== null) stop(violation, manifest);
    } else if (!seenInit) {
      stop(
        {
          kind: 'init_missing',
          unexpectedTools: [],
          missingTools: [],
          unexpectedMcpServers: [],
          missingMcpServers: [],
          unexpectedPlugins: [],
          unexpectedPermissionMode: null,
        },
        null,
      );
    }
    yield event;
  }
}
