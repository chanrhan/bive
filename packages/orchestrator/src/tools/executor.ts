// 고정 도구 실행기 (NFR-01 · NFR-02 · ADR-024 · ADR-052). `SessionSpec.tools`에 넘기는 ToolExecutor 구현.
// 역할 허용 목록 밖 이름은 `denied`(`unknown_tool`), 인자는 도구 정의 스키마로 검증하고,
// 모든 호출(거부 · 오류 포함)을 ToolCallRecord로 남긴다. 기록 저장은 실행 엔진(M1-14)이 콜백으로 받는다.
import path from 'node:path';

import type { AgentRole } from '@bive/shared';

import type { ToolExecutor, ToolResult } from '../agent/adapter.js';
import { clipText } from '../text-limit.js';
import { type CommandContext, runCommand } from './commands.js';
import {
  type CommandToolName,
  COMMAND_TOOL_NAMES,
  FILE_TOOL_NAMES,
  type FileToolName,
  type FixedToolName,
  ListFilesInput,
  ProposeMutantInput,
  ProposeRuleInput,
  RaiseObjectionInput,
  ReadFileInput,
  RetireRuleInput,
  roleToolNames,
  SearchFilesInput,
  SupersedeRuleInput,
  UpholdRuleInput,
  WriteFileInput,
} from './definitions.js';
import { listFiles, readFile, searchFiles, writeFile } from './file-tools.js';
import { PathGuard, type WriteScope } from './path-guard.js';
import { denied, failed, invalidArgs, ok } from './result.js';

/** 도구 호출 기록 (NFR-02). 경로 또는 명령 · 시각 · 결과 · 소요 시간. */
export interface ToolCallRecord {
  /** 호출 시작 시각 (ISO 8601 UTC) */
  at: string;
  role: AgentRole;
  /** 세션 ID. init 전 · 미지정이면 `null` */
  sessionId: string | null;
  /** 모델이 요청한 도구 이름 (허용 목록 밖 이름 포함, 1024자 상한 · 넘으면 잘라 `…`, ADR-089) */
  name: string;
  /** 파일 도구는 경로(4096자 상한, 넘으면 가운데를 `…`로 줄임), 명령 도구는 argv, 그 밖은 요청 인자 요약 */
  argsSummary: string;
  status: ToolResult['status'];
  reason?: string;
  durationMs: number;
}

/** 규칙 생성 콜백의 문맥. */
export interface ProposalContext {
  role: AgentRole;
  sessionId: string | null;
}

export interface RoleToolsHooks {
  /**
   * `propose_rule`(규칙 생성, M7-02): 규칙을 바로 반영하고 규범 변경 기록을 남긴다. 돌려준 문자열은 모델에게 보여 줄
   * 본문(`ok`)이고, 반영을 거부하거나 실패를 알릴 때는 `ToolResult`(`denied` · `error` + 사유 코드, ADR-052 · ADR-062)를 돌려준다.
   * 주입하지 않으면 호출이 `error`(`not_configured`)로 끝난다.
   */
  proposeRule?: (
    input: ProposeRuleInput,
    context: ProposalContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
  /**
   * `retire_rule`(규칙 폐기, M7-09): 규칙을 폐기하고 규범 변경 기록을 남긴다. 반환 규칙은 `proposeRule`과 같다.
   * 주입하지 않으면 호출이 `error`(`not_configured`)로 끝난다.
   */
  retireRule?: (
    input: RetireRuleInput,
    context: ProposalContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
  /**
   * `supersede_rule`(규칙 대체, M7-09): 폐기와 새 규칙 반영을 한 트랜잭션으로 한다. 반환 규칙은 `proposeRule`과 같다.
   * 주입하지 않으면 호출이 `error`(`not_configured`)로 끝난다.
   */
  supersedeRule?: (
    input: SupersedeRuleInput,
    context: ProposalContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
  /**
   * `uphold_rule`(이의 판단의 유지, M7-11): 판단 기록을 남긴다. 반환 규칙은 `proposeRule`과 같다. 주입하지 않으면 호출이
   * `error`(`not_configured`)로 끝난다.
   */
  upholdRule?: (
    input: UpholdRuleInput,
    context: ProposalContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
  /**
   * `raise_objection`(구현 역할의 이의 제기, M7-11 #223, ADR-115): 이의 기록 1건만 남긴다(규칙 · 인수 테스트 · 규범 저장소의 다른
   * 표를 바꾸지 않는다). 결과가 `ok`이면 실행기가 닫히고(`close('objection_raised')`) 그 뒤 호출은 모두 `denied`
   * (`session_closed`)다. 결과 본문 끝에 {@link OBJECTION_ACCEPTED_TEXT}를 붙인다. 주입하지 않으면 호출이
   * `error`(`not_configured`)로 끝난다.
   */
  raiseObjection?: (
    input: RaiseObjectionInput,
    context: ProposalContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
  /**
   * `propose_mutant`(변이 제안, M3-07 #52, ADR-139): 주입한 콜백이 판정 커밋에서 변이를 검증하고 받아 둔다(작업 트리 · 저장소를 바꾸지
   * 않는다). 결과가 `ok`이면 실행기가 닫히고(`close('mutant_proposed')`, 세션마다 변이 1개) 그 뒤 호출은 모두 `denied`
   * (`session_closed`)다. 결과 본문 끝에 {@link MUTANT_ACCEPTED_TEXT}를 붙인다. 거부면 닫지 않는다(사유를 읽고 고쳐 다시 낼 수 있다).
   * 주입하지 않으면 호출이 `error`(`not_configured`)로 끝난다.
   */
  proposeMutant?: (
    input: ProposeMutantInput,
    context: ProposalContext,
  ) => Promise<string | ToolResult> | string | ToolResult;
  /** 실행기가 닫힐 때 한 번 (이의 제기 · 판단 완료 · 변이 제안). 세션을 여는 쪽이 이것으로 세션을 끝낸다 */
  onClose?: (reason: ToolExecutorCloseReason) => void;
  /** 도구 호출이 끝날 때마다 (거부 · 오류 포함) */
  onToolCall?: (record: ToolCallRecord) => void;
}

/** 실행기를 닫은 이유: 구현 역할의 이의 제기 · 이의 판단 세션의 판단 완료 (M7-11) · 변이 주입 역할의 변이 제안 (M3-07). */
export type ToolExecutorCloseReason = 'objection_raised' | 'judgment_complete' | 'mutant_proposed';

/**
 * 이의 제기가 받아들여졌을 때 도구 결과 끝에 붙이는 고정 문장 (M7-11, ADR-115 검토 1회차). 세션을 중단하지 않고 모델이 스스로
 * 끝내게 해 결과 이벤트의 실제 비용으로 기록한다.
 */
export const OBJECTION_ACCEPTED_TEXT =
  '이의가 접수됐다. 더 할 일이 없다. 도구를 더 부르지 말고 세션을 끝내라.';

/** 변이가 받아들여졌을 때 도구 결과 끝에 붙이는 고정 문장 (M3-07, ADR-139). 모델이 스스로 세션을 끝내게 한다. */
export const MUTANT_ACCEPTED_TEXT =
  '변이가 접수됐다. 판정은 오케스트레이터가 한다. 도구를 더 부르지 말고 세션을 끝내라.';

/** 닫힌 실행기의 거부 문장. */
const CLOSED_TEXT: Record<ToolExecutorCloseReason, string> = {
  objection_raised: '이의를 제기해 이 세션은 끝났다. 더 이상 도구를 부르지 않는다',
  judgment_complete: '판단을 모두 남겨 이 세션은 끝났다. 더 이상 도구를 부르지 않는다',
  mutant_proposed: '변이를 내서 이 세션은 끝났다. 더 이상 도구를 부르지 않는다',
};

export interface CreateRoleToolsOptions {
  role: AgentRole;
  /** 세션 루트: implementer = 실행 워크트리, test-writer = 세션 디렉터리 (ADR-024) */
  sessionRoot: string;
  biveHome: string;
  /** test-writer가 쓸 수 있는 규칙 폴더 (`PathGuardOptions.writableRuleDirs`, ADR-068) */
  writableRuleDirs?: readonly string[];
  /** implementer의 쓰기 허용 범위 (`PathGuardOptions.writeScope`, 허용 목록 축소 재개로 만든 실행만, ADR-155) */
  writeScope?: WriteScope;
  hooks?: RoleToolsHooks;
  /** 기록에 남길 세션 ID. init 뒤에 `setSessionId`로 정해도 된다 */
  sessionId?: string;
  /** 명령 도구 설정. `cwd` · `guard`는 세션 루트로 정해진다 */
  commands?: Omit<CommandContext, 'cwd' | 'guard'>;
  /** 시험용 시계 */
  now?: () => Date;
}

const ARGS_SUMMARY_MAX = 200;
/** 저장할 파일 도구 경로 요약의 상한: OS 경로 길이 상한(Linux `PATH_MAX`)과 같다 (ADR-089) */
const PATH_SUMMARY_MAX = 4096;
/** 저장할 도구 이름의 상한: 모르는 도구 이름은 에이전트가 정한 임의 문자열이다 (ADR-089) */
const TOOL_NAME_RECORD_MAX = 1024;

const summarizeArgs = (args: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(args) ?? '';
  } catch {
    text = '(직렬화 불가 인자)';
  }
  return text.length <= ARGS_SUMMARY_MAX ? text : `${text.slice(0, ARGS_SUMMARY_MAX)}…`;
};

/** 인자의 문자열 `path`. 인자가 객체가 아니거나 읽기가 예외를 던지면(getter · Proxy) 없음으로 본다. */
const pathArg = (args: unknown): string | undefined => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  try {
    const value: unknown = (args as Record<string, unknown>).path;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
};

const isFileToolName = (name: string): name is FileToolName =>
  (FILE_TOOL_NAMES as readonly string[]).includes(name);

/**
 * 호출 기록의 인자 요약. 파일 도구 이름이면 역할 허용 · 인자 검증 · 예외 여부와 상관없이 대상 경로만 남긴다
 * (쓰기 내용이 기록에 섞이지 않게, ADR-083). 경로가 문자열이 아니면 고정 표기(목록 · 검색은 `.`, 그 밖은 빈 값).
 * 인자가 객체가 아니거나(`null` · 배열 · 원시 값) 읽기가 예외를 던져도 예외 없이 요약을 만든다. 경로는 글자를 바꾸지 않고
 * 길이만 제한한다(앞 · 뒤를 남기고 가운데를 줄인다. 뒤쪽에 실제 대상 파일 이름이 온다, ADR-089).
 */
const summaryOf = (name: string, args: unknown): string => {
  if (!isFileToolName(name)) return summarizeArgs(args);
  const target = pathArg(args);
  if (target !== undefined) return clipText(target, PATH_SUMMARY_MAX, 'ends');
  return name === 'search_files' || name === 'list_files' ? '.' : '';
};

const isCommandTool = (name: FixedToolName): name is CommandToolName =>
  (COMMAND_TOOL_NAMES as readonly string[]).includes(name);

export class FixedToolExecutor implements ToolExecutor {
  readonly role: AgentRole;
  readonly toolNames: readonly FixedToolName[];
  readonly guard: PathGuard;
  /** 이 실행기의 모든 호출 기록 (호출 순서) */
  readonly records: ToolCallRecord[] = [];
  private sessionId: string | null;
  private closedBy: ToolExecutorCloseReason | null = null;
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

  /** 예외 메시지에서 세션 루트 절대 경로를 지운다 (모델 · 기록에 호스트 경로를 노출하지 않음). */
  private hidePaths(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.split(`${this.guard.root}${path.sep}`).join('').split(this.guard.root).join('.');
  }

  /** init 이벤트의 세션 ID를 기록에 쓴다. */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** 닫혔으면 그 이유, 아니면 `null`. */
  get closed(): ToolExecutorCloseReason | null {
    return this.closedBy;
  }

  /**
   * 실행기를 닫는다 (M7-11, ADR-115): 이후 모든 호출(허용 도구 포함)은 실행하지 않고 `denied`(`session_closed`)로 기록된다.
   * 처음 닫을 때만 `onClose`를 부른다.
   */
  close(reason: ToolExecutorCloseReason): void {
    if (this.closedBy !== null) return;
    this.closedBy = reason;
    this.hooks.onClose?.(reason);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const startedAt = this.now();
    const started = performance.now();
    let summary = summaryOf(name, args);
    let result: ToolResult;
    try {
      const outcome = await this.dispatch(name, args);
      result = outcome.result;
      summary = outcome.summary;
    } catch (error) {
      result = failed('tool_failed', this.hidePaths(error));
    }
    const record: ToolCallRecord = {
      at: startedAt.toISOString(),
      role: this.role,
      sessionId: this.sessionId,
      name: clipText(name, TOOL_NAME_RECORD_MAX),
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
    // 닫힌 실행기는 이름 · 인자와 무관하게 아무것도 하지 않는다 (이의를 부른 뒤 구현 코드를 더 쓰지 못한다, ADR-115)
    if (this.closedBy !== null) {
      return {
        result: denied('session_closed', CLOSED_TEXT[this.closedBy]),
        summary: summaryOf(name, args),
      };
    }
    const allowed = (this.toolNames as readonly string[]).includes(name);
    if (!allowed) {
      return {
        result: denied('unknown_tool', `이 역할(${this.role})에 없는 도구: ${name}`),
        summary: summaryOf(name, args),
      };
    }
    const tool = name as FixedToolName;
    if (isCommandTool(tool)) return runCommand(tool, args, this.commandContext);
    if (tool === 'propose_rule')
      return { result: await this.proposeRule(args), summary: summarizeArgs(args) };
    if (tool === 'retire_rule' || tool === 'supersede_rule')
      return { result: await this.retirement(tool, args), summary: summarizeArgs(args) };
    if (tool === 'uphold_rule')
      return { result: await this.uphold(args), summary: summarizeArgs(args) };
    if (tool === 'raise_objection')
      return { result: await this.objection(args), summary: summarizeArgs(args) };
    // 변이 글은 기록에 싣지 않는다: 대상 경로만 (파일 도구와 같은 요약)
    if (tool === 'propose_mutant')
      return { result: await this.mutant(args), summary: summaryOf('read_file', args) };
    return { result: await this.fileTool(tool, args), summary: summaryOf(tool, args) };
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
    if (register === undefined) return failed('not_configured', '규칙 반영 경로가 연결되지 않음');
    try {
      const outcome = await register(parsed.data, { role: this.role, sessionId: this.sessionId });
      return typeof outcome === 'string' ? ok(outcome) : outcome;
    } catch (error) {
      return failed('tool_failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** 폐기 · 대체 (M7-09): 인자 검증 뒤 주입된 콜백에 넘긴다. */
  private async retirement(
    tool: 'retire_rule' | 'supersede_rule',
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const context = { role: this.role, sessionId: this.sessionId };
    try {
      if (tool === 'retire_rule') {
        const parsed = RetireRuleInput.safeParse(args);
        if (!parsed.success) return invalidArgs(tool, parsed.error);
        const retire = this.hooks.retireRule;
        if (retire === undefined) return failed('not_configured', '규칙 폐기 경로가 연결되지 않음');
        const outcome = await retire(parsed.data, context);
        return typeof outcome === 'string' ? ok(outcome) : outcome;
      }
      const parsed = SupersedeRuleInput.safeParse(args);
      if (!parsed.success) return invalidArgs(tool, parsed.error);
      const supersede = this.hooks.supersedeRule;
      if (supersede === undefined)
        return failed('not_configured', '규칙 대체 경로가 연결되지 않음');
      const outcome = await supersede(parsed.data, context);
      return typeof outcome === 'string' ? ok(outcome) : outcome;
    } catch (error) {
      return failed('tool_failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** 이의 판단의 유지 (M7-11): 인자 검증 뒤 주입된 콜백에 넘긴다. */
  private async uphold(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = UpholdRuleInput.safeParse(args);
    if (!parsed.success) return invalidArgs('uphold_rule', parsed.error);
    const uphold = this.hooks.upholdRule;
    if (uphold === undefined) return failed('not_configured', '이의 판단 경로가 연결되지 않음');
    try {
      const outcome = await uphold(parsed.data, { role: this.role, sessionId: this.sessionId });
      return typeof outcome === 'string' ? ok(outcome) : outcome;
    } catch (error) {
      return failed('tool_failed', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 이의 제기 (M7-11, ADR-115): 인자 검증 뒤 주입된 콜백(이의 기록 1건)에 넘긴다. 콜백이 `ok`를 돌려주면 실행기를 닫고 세션을
   * 끝내라는 고정 문장을 붙인다. 거부 · 오류면 닫지 않는다(사유를 읽고 고쳐 다시 부를 수 있다).
   */
  private async objection(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = RaiseObjectionInput.safeParse(args);
    if (!parsed.success) return invalidArgs('raise_objection', parsed.error);
    const raise = this.hooks.raiseObjection;
    if (raise === undefined) return failed('not_configured', '이의 기록 경로가 연결되지 않음');
    let result: ToolResult;
    try {
      const outcome = await raise(parsed.data, { role: this.role, sessionId: this.sessionId });
      result = typeof outcome === 'string' ? ok(outcome) : outcome;
    } catch (error) {
      return failed('tool_failed', error instanceof Error ? error.message : String(error));
    }
    if (result.status !== 'ok') return result;
    this.close('objection_raised');
    return { ...result, content: `${result.content}\n${OBJECTION_ACCEPTED_TEXT}` };
  }

  /**
   * 변이 제안 (M3-07, ADR-139): 인자 검증 뒤 주입된 콜백(판정 커밋에서 검증 · 받아 두기)에 넘긴다. 콜백이 `ok`를 돌려주면 실행기를
   * 닫는다(세션마다 변이 1개). 거부 · 오류면 닫지 않는다.
   */
  private async mutant(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = ProposeMutantInput.safeParse(args);
    if (!parsed.success) return invalidArgs('propose_mutant', parsed.error);
    const propose = this.hooks.proposeMutant;
    if (propose === undefined) return failed('not_configured', '변이 판정 경로가 연결되지 않음');
    let result: ToolResult;
    try {
      const outcome = await propose(parsed.data, { role: this.role, sessionId: this.sessionId });
      result = typeof outcome === 'string' ? ok(outcome) : outcome;
    } catch (error) {
      return failed('tool_failed', error instanceof Error ? error.message : String(error));
    }
    if (result.status !== 'ok') return result;
    this.close('mutant_proposed');
    return { ...result, content: `${result.content}\n${MUTANT_ACCEPTED_TEXT}` };
  }
}

/** 역할의 고정 도구 실행기를 만든다. 결과를 `SessionSpec.tools`에 그대로 넘긴다. */
export const createRoleTools = (options: CreateRoleToolsOptions): FixedToolExecutor =>
  new FixedToolExecutor(options);
