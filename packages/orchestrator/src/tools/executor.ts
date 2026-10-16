// 고정 도구 실행기 (NFR-01 · NFR-02 · ADR-024 · ADR-052). `SessionSpec.tools`에 넘기는 ToolExecutor 구현.
// 역할 허용 목록 밖 이름은 `denied`(`unknown_tool`), 인자는 도구 정의 스키마로 검증하고,
// 모든 호출(거부 · 오류 포함)을 ToolCallRecord로 남긴다. 기록 저장은 실행 엔진(M1-14)이 콜백으로 받는다.
import type { AgentRole } from '@bive/shared';

import type { ToolExecutor, ToolResult } from '../agent/adapter.js';
import { type CommandContext, runCommand } from './commands.js';
import {
  type CommandToolName,
  COMMAND_TOOL_NAMES,
  type FileToolName,
  type FixedToolName,
  ListFilesInput,
  ProposeRuleInput,
  ReadFileInput,
  roleToolNames,
  SearchFilesInput,
  WriteFileInput,
} from './definitions.js';
import { listFiles, readFile, searchFiles, writeFile } from './file-tools.js';
import { PathGuard } from './path-guard.js';
import { denied, failed, invalidArgs, ok } from './result.js';

/** 도구 호출 기록 (NFR-02). 경로 또는 명령 · 시각 · 결과 · 소요 시간. */
export interface ToolCallRecord {
  /** 호출 시작 시각 (ISO 8601 UTC) */
  at: string;
  role: AgentRole;
  /** 세션 ID. init 전 · 미지정이면 `null` */
  sessionId: string | null;
  /** 모델이 요청한 도구 이름 (허용 목록 밖 이름 포함) */
  name: string;
  /** 파일 도구는 경로, 명령 도구는 argv, 그 밖은 요청 인자 요약 */
  argsSummary: string;
  status: ToolResult['status'];
  reason?: string;
  durationMs: number;
}

/** 규칙 제안 등록 콜백의 문맥. */
export interface ProposalContext {
  role: AgentRole;
  sessionId: string | null;
}

export interface RoleToolsHooks {
  /**
   * `propose_rule` 등록. 제안은 항상 `pending`으로 만든다(NFR-01). 돌려준 문자열은 모델에게 보여 줄 본문.
   * 주입하지 않으면 호출이 `error`(`not_configured`)로 끝난다.
   */
  proposeRule?: (input: ProposeRuleInput, context: ProposalContext) => Promise<string> | string;
  /** 도구 호출이 끝날 때마다 (거부 · 오류 포함) */
  onToolCall?: (record: ToolCallRecord) => void;
}

export interface CreateRoleToolsOptions {
  role: AgentRole;
  /** 세션 루트: implementer = 실행 워크트리, test-writer = 세션 디렉터리 (ADR-024) */
  sessionRoot: string;
  biveHome: string;
  hooks?: RoleToolsHooks;
  /** 기록에 남길 세션 ID. init 뒤에 `setSessionId`로 정해도 된다 */
  sessionId?: string;
  /** 명령 도구 설정. `cwd` · `guard`는 세션 루트로 정해진다 */
  commands?: Omit<CommandContext, 'cwd' | 'guard'>;
  /** 시험용 시계 */
  now?: () => Date;
}

const ARGS_SUMMARY_MAX = 200;

const summarizeArgs = (args: Record<string, unknown>): string => {
  let text: string;
  try {
    text = JSON.stringify(args) ?? '';
  } catch {
    text = '(직렬화 불가 인자)';
  }
  return text.length <= ARGS_SUMMARY_MAX ? text : `${text.slice(0, ARGS_SUMMARY_MAX)}…`;
};

const pathSummary = (args: Record<string, unknown>, fallback: string): string =>
  typeof args.path === 'string' ? args.path : fallback;

const isCommandTool = (name: FixedToolName): name is CommandToolName =>
  (COMMAND_TOOL_NAMES as readonly string[]).includes(name);

export class FixedToolExecutor implements ToolExecutor {
  readonly role: AgentRole;
  readonly toolNames: readonly FixedToolName[];
  readonly guard: PathGuard;
  /** 이 실행기의 모든 호출 기록 (호출 순서) */
  readonly records: ToolCallRecord[] = [];
  private sessionId: string | null;
  private readonly hooks: RoleToolsHooks;
  private readonly commandContext: CommandContext;
  private readonly now: () => Date;

  constructor(options: CreateRoleToolsOptions) {
    this.role = options.role;
    this.toolNames = roleToolNames(options.role);
    this.guard = new PathGuard(options);
    this.sessionId = options.sessionId ?? null;
    this.hooks = options.hooks ?? {};
    this.commandContext = { ...options.commands, cwd: this.guard.root, guard: this.guard };
    this.now = options.now ?? (() => new Date());
  }

  /** init 이벤트의 세션 ID를 기록에 쓴다. */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const startedAt = this.now();
    const started = performance.now();
    let summary = summarizeArgs(args);
    let result: ToolResult;
    try {
      const outcome = await this.dispatch(name, args);
      result = outcome.result;
      summary = outcome.summary;
    } catch (error) {
      result = failed('tool_failed', error instanceof Error ? error.message : String(error));
    }
    const record: ToolCallRecord = {
      at: startedAt.toISOString(),
      role: this.role,
      sessionId: this.sessionId,
      name,
      argsSummary: summary,
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    };
    this.records.push(record);
    this.hooks.onToolCall?.(record);
    return result;
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: ToolResult; summary: string }> {
    const allowed = (this.toolNames as readonly string[]).includes(name);
    if (!allowed) {
      return {
        result: denied('unknown_tool', `이 역할(${this.role})에 없는 도구: ${name}`),
        summary: summarizeArgs(args),
      };
    }
    const tool = name as FixedToolName;
    if (isCommandTool(tool)) return runCommand(tool, args, this.commandContext);
    if (tool === 'propose_rule')
      return { result: await this.proposeRule(args), summary: summarizeArgs(args) };
    return {
      result: await this.fileTool(tool, args),
      summary: pathSummary(args, tool === 'search_files' || tool === 'list_files' ? '.' : ''),
    };
  }

  private async fileTool(name: FileToolName, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'read_file': {
        const parsed = ReadFileInput.safeParse(args);
        return parsed.success ? readFile(this.guard, parsed.data) : invalidArgs(name, parsed.error);
      }
      case 'write_file': {
        const parsed = WriteFileInput.safeParse(args);
        return parsed.success
          ? writeFile(this.guard, parsed.data)
          : invalidArgs(name, parsed.error);
      }
      case 'list_files': {
        const parsed = ListFilesInput.safeParse(args);
        return parsed.success
          ? listFiles(this.guard, parsed.data)
          : invalidArgs(name, parsed.error);
      }
      case 'search_files': {
        const parsed = SearchFilesInput.safeParse(args);
        return parsed.success
          ? searchFiles(this.guard, parsed.data)
          : invalidArgs(name, parsed.error);
      }
    }
  }

  private async proposeRule(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = ProposeRuleInput.safeParse(args);
    if (!parsed.success) return invalidArgs('propose_rule', parsed.error);
    const register = this.hooks.proposeRule;
    if (register === undefined) return failed('not_configured', '제안 등록 경로가 연결되지 않음');
    try {
      return ok(await register(parsed.data, { role: this.role, sessionId: this.sessionId }));
    } catch (error) {
      return failed('tool_failed', error instanceof Error ? error.message : String(error));
    }
  }
}

/** 역할의 고정 도구 실행기를 만든다. 결과를 `SessionSpec.tools`에 그대로 넘긴다. */
export const createRoleTools = (options: CreateRoleToolsOptions): FixedToolExecutor =>
  new FixedToolExecutor(options);
