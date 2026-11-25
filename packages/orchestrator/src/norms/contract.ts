// 계약 등록 (NRM-03, ADR-019 · ADR-033 · ADR-100 D1 · D2 · C2 · B⑨ · K1, M3-04 #49, ADR-129).
// - 계약 1건 = 원본 파일 1개(등록 단위). 요구사항과의 연결 단위도 파일이다(부모 요구사항 0~1개, ADR-019)
// - 내용은 기준 브랜치 커밋의 그 파일에서 읽는다(작업 트리 · 실행 워크트리가 아니다, {@link readContractSource}). 저장하는 것은
//   그 커밋과 내용의 SHA-256뿐이다. 경로 · 종류 · 확장자를 먼저 글자로 보고(git을 부르기 전), git 객체에서 일반 파일만 읽는다
//   (기호 링크 · 디렉터리 · 하위 모듈 거부, 대체 객체 무시)
// - 등록 한 번 = 트랜잭션 1개: 계약 행, 그 계약의 `contract` 검사 규칙(내장 규칙: 부모 없음 · 검사 종류 계약 · 대상 블록 없음 ·
//   위험도 없음 · 효력 상태 · 미확인), 기록. 승인 대기 제안을 만들지 않는다(ADR-100 D1). 실행을 자동으로 만들지 않는다
//   (정적 검사 규칙의 실행 유형 B는 M3-06)
//   - 사람의 등록({@link registerHumanContract}): 승인 기록 `contract_edit`(이전 없는 diff, 사람 행동, C2) + 그에 따라 오케스트레이터가
//     만드는 검사 규칙의 규범 변경 기록 `created`(주체 오케스트레이터). 계약을 확인됨으로 두는 것(근거 = 계약의 작성 기록)은 이 모듈이
//     아니라 같은 트랜잭션의 사람 RPC 처리기가 확인 서비스로 한다(확인됨을 만드는 곳은 사람 RPC 처리기뿐, 구조 시험)
//   - 에이전트 반영({@link reflectAgentContract}): 규범 변경 기록에만 남는다(계약의 `created`는 에이전트 주체 · 세션 · 사유, 검사
//     규칙의 `created`는 오케스트레이터). 계약은 미확인이다. 이 함수를 부르는 에이전트 도구는 아직 없다(도구 배선은 M3-10 · M5)
// - 이 모듈이 계약 · 계약 검사 규칙을 쓰는 유일한 곳이다(구조 시험 `integrity.test.ts`). 에이전트 도구 · 세션 · 엔진 · 단계는 이 모듈을
//   가져오지 않는다
import { createHash } from 'node:crypto';

import {
  type AgentAuthor,
  type ApprovalLogEntry,
  type Contract,
  type ContractEditSnapshot,
  type ContractInvalidCode,
  type ContractKind,
  type HumanAuthor,
  type NormChangeEntry,
  type Rule,
  type Ulid,
  CONTRACT_SOURCE_FILE_MAX,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import { effectiveRequirements } from './effective.js';

/** 지금 등록을 받는 계약 종류: NRM-03 제목의 세 종류 (ADR-033이 검사 도구를 정한 종류). */
export const REGISTRABLE_CONTRACT_KINDS = ['openapi', 'db-schema', 'asyncapi'] as const;
export type RegistrableContractKind = (typeof REGISTRABLE_CONTRACT_KINDS)[number];

/** 종류별 원본 파일 확장자 (소문자, 대소문자를 구분한다). */
export const CONTRACT_FILE_EXTENSIONS: Readonly<
  Record<RegistrableContractKind, readonly string[]>
> = {
  openapi: ['.yaml', '.yml', '.json'],
  'db-schema': ['.prisma'],
  asyncapi: ['.yaml', '.yml', '.json'],
};

/** 계약 원본 파일 크기 상한 (바이트). */
export const CONTRACT_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

/** 경로 한 구간에 쓸 수 있는 글자: 보이는 ASCII 가운데 영문 · 숫자 · `.` · `_` · `-` · `@` · `+`. */
const SEGMENT = /^[A-Za-z0-9._@+-]+$/u;

const isRegistrable = (kind: ContractKind): kind is RegistrableContractKind =>
  (REGISTRABLE_CONTRACT_KINDS as readonly string[]).includes(kind);

/**
 * 원본 파일 경로 · 종류의 글자 검사 (git을 부르기 전). 문제가 없으면 `null`.
 * 받는 경로: 프로젝트 루트 기준 상대 경로, `/` 구분, 구간마다 {@link SEGMENT} 글자만(공백 · 역슬래시 · 따옴표 · glob 글자 · 제어 ·
 * 비ASCII 글자 없음), 빈 구간 · `.` · `..` · `.git` 구간 없음, 길이 {@link CONTRACT_SOURCE_FILE_MAX} 이하.
 */
export const contractFileProblem = (
  file: string,
  kind: ContractKind,
): ContractInvalidCode | null => {
  if (!isRegistrable(kind)) return 'kind_not_supported';
  if (file.length === 0 || file.length > CONTRACT_SOURCE_FILE_MAX) return 'path_invalid';
  const segments = file.split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') return 'path_invalid';
    if (segment.toLowerCase() === '.git') return 'path_invalid';
  }
  const name = segments.at(-1) ?? '';
  const extensions = CONTRACT_FILE_EXTENSIONS[kind];
  if (!extensions.some((extension) => name.endsWith(extension) && name.length > extension.length)) {
    return 'extension_mismatch';
  }
  return null;
};

/** 기준 브랜치 커밋에서 읽은 계약 원본. */
export interface ContractSource {
  readonly commit: string;
  readonly contentHash: string;
}

export type ContractSourceRead =
  | ({ readonly ok: true } & ContractSource)
  | { readonly ok: false; readonly code: ContractInvalidCode };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/**
 * 기준 브랜치 커밋의 계약 원본을 git 객체에서 읽는다 (작업 트리 · 워크트리는 읽지 않는다). `file`은 {@link contractFileProblem}을
 * 지난 경로여야 한다(glob 글자가 없어 `ls-tree`의 경로가 글자 그대로 맞는다). 대체 객체(`refs/replace`)는 따르지 않는다.
 * - 브랜치 · 커밋을 읽지 못함(git 저장소가 아님 등) → `base_unreadable`, 파일 없음 → `file_missing`
 * - 일반 파일(모드 100644 · 100755)이 아님(기호 링크 · 디렉터리 · 하위 모듈) → `not_regular_file`
 * - 상한 초과 → `too_large`(내용을 읽지 않는다), UTF-8 글이 아님(디코드에 대체 문자 U+FFFD가 생기거나 원래 있음) → `not_text`
 * 해시는 그 바이트의 SHA-256이다(글로 읽어 손실 없이 디코드됐음을 확인한 뒤 UTF-8로 다시 부호화하므로 같은 바이트다).
 */
export const readContractSource = async (
  repoPath: string,
  baseBranch: string,
  file: string,
  git: GitRunner = createGitRunner(),
): Promise<ContractSourceRead> => {
  let commit: string;
  try {
    commit = (
      await git(
        [
          '--no-replace-objects',
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${baseBranch}^{commit}`,
        ],
        { cwd: repoPath },
      )
    ).stdout.trim();
  } catch {
    return { ok: false, code: 'base_unreadable' };
  }
  if (!COMMIT.test(commit)) return { ok: false, code: 'base_unreadable' };
  let listing: string;
  try {
    listing = (
      await git(['--no-replace-objects', 'ls-tree', '-z', '-l', commit, '--', file], {
        cwd: repoPath,
      })
    ).stdout;
  } catch {
    return { ok: false, code: 'base_unreadable' };
  }
  // `<모드> <종류> <객체> <크기>\t<경로>`: 경로가 글자 그대로 같은 항목만
  const entry = listing
    .split('\0')
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab < 0 ? null : { head: line.slice(0, tab).split(/ +/u), path: line.slice(tab + 1) };
    })
    .find((item) => item !== null && item.path === file);
  if (entry === undefined || entry === null) return { ok: false, code: 'file_missing' };
  const [mode, type, object, size] = entry.head;
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || object === undefined) {
    return { ok: false, code: 'not_regular_file' };
  }
  const bytes = Number(size);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, code: 'base_unreadable' };
  if (bytes > CONTRACT_SOURCE_MAX_BYTES) return { ok: false, code: 'too_large' };
  let text: string;
  try {
    text = (await git(['--no-replace-objects', 'cat-file', 'blob', object], { cwd: repoPath }))
      .stdout;
  } catch {
    return { ok: false, code: 'base_unreadable' };
  }
  if (text.includes('�') || Buffer.byteLength(text, 'utf8') !== bytes) {
    return { ok: false, code: 'not_text' };
  }
  return { ok: true, commit, contentHash: sha256(text) };
};

/** 계약 검사 규칙을 만든 규범 변경 기록의 사유 (고정 문장). */
export const CONTRACT_RULE_CREATED_REASON = '계약 등록에 따른 계약 검사 규칙 생성';

/** 계약 검사 규칙의 고정 글 (화면에 보이는 글이라 문서 기호 · 코드 표기를 넣지 않는다. 파일 경로도 넣지 않는다). */
export const contractRuleText = (
  contractDisplayId: string,
): { readonly title: string; readonly statement: string } => ({
  title: `계약 일치: ${contractDisplayId}`,
  statement: `WHILE 계약 ${contractDisplayId}이 등록되어 있으면 THE SYSTEM SHALL 그 계약의 원본 파일이 형식에 맞고 구현이 그 계약과 일치한다`,
});

/** 계약의 기록용 모양 (승인 기록 diff · 규범 변경 기록 `after`). */
export const contractSnapshot = (contract: Contract): ContractEditSnapshot => ({
  kind: contract.kind,
  sourceFile: contract.sourceFile,
  contentHash: contract.contentHash,
  sourceCommit: contract.sourceCommit,
  parentRequirementId: contract.parentRequirementId,
});

/** 계약 등록의 입력 (파일 · 종류는 {@link contractFileProblem}, 내용은 {@link readContractSource}를 지난 값). */
export interface ContractRegistration {
  readonly file: string;
  readonly kind: ContractKind;
  readonly source: ContractSource;
  /** 부모 요구사항 (없으면 `null`) */
  readonly requirementId: Ulid | null;
  readonly at: string;
  readonly newId: () => Ulid;
}

/** 등록 입력이 어긋남 (부모 요구사항 · 같은 파일). 아무것도 남지 않는다. */
export class ContractRegistrationError extends Error {
  override readonly name = 'ContractRegistrationError';
  constructor(
    readonly code:
      | 'requirement_not_found'
      | 'requirement_not_effective'
      | 'contract_exists'
      | 'contract_invalid',
    message: string,
    /** `contract_invalid`의 까닭 */
    readonly invalid: ContractInvalidCode | null = null,
  ) {
    super(message);
  }
}

export interface ContractRegistered {
  readonly contract: Contract;
  readonly rule: Rule;
  /** 검사 규칙의 신규 기록 (주체 오케스트레이터) */
  readonly ruleCreated: NormChangeEntry;
}

const assertRegistrable = (store: ProjectStore, input: ContractRegistration): void => {
  const problem = contractFileProblem(input.file, input.kind);
  if (problem !== null) {
    throw new ContractRegistrationError(
      'contract_invalid',
      `계약 등록을 받지 않음: ${problem}`,
      problem,
    );
  }
  if (input.requirementId !== null) {
    if (store.requirements.get(input.requirementId) === null) {
      throw new ContractRegistrationError(
        'requirement_not_found',
        `요구사항이 없습니다: ${input.requirementId}`,
      );
    }
    if (!effectiveRequirements(store).some((item) => item.id === input.requirementId)) {
      throw new ContractRegistrationError(
        'requirement_not_effective',
        `효력 있는 요구사항이 아닙니다(삭제 · 잠정): ${input.requirementId}`,
      );
    }
  }
  if (store.contracts.list().some((contract) => contract.sourceFile === input.file)) {
    throw new ContractRegistrationError(
      'contract_exists',
      `같은 파일의 계약이 이미 있습니다: ${input.file}`,
    );
  }
};

/** 계약 행 (호출한 쪽의 트랜잭션 안, 확인 기록 없음 = 미확인). */
const createContract = (
  store: ProjectStore,
  input: ContractRegistration,
  author: HumanAuthor | AgentAuthor,
): Contract => {
  assertRegistrable(store, input);
  return store.contracts.create({
    id: input.newId(),
    kind: input.kind,
    sourceFile: input.file,
    contentHash: input.source.contentHash,
    sourceCommit: input.source.commit,
    parentRequirementId: input.requirementId,
    author,
    createdAt: input.at,
  });
};

/** 계약의 검사 규칙과 그 신규 기록 (호출한 쪽의 트랜잭션 안). */
const createContractRule = (
  store: ProjectStore,
  contract: Contract,
  input: ContractRegistration,
): Pick<ContractRegistered, 'rule' | 'ruleCreated'> => {
  const text = contractRuleText(contract.displayId);
  const rule = store.rules.create({
    id: input.newId(),
    title: text.title,
    statement: text.statement,
    kind: 'tech-constraint',
    checkKinds: ['contract'],
    // 계약 검사 규칙은 계약에 매인 내장 규칙이다(부모 요구사항 없음 · 에이전트 폐기 · 사람 편집 · 실행 대상 불가, ADR-129).
    // 요구사항과의 연결은 계약 쪽에 있다(연결 단위 = 파일)
    parentRequirementId: null,
    builtin: true,
    targetBlockIds: [],
    risk: null,
    contractId: contract.id,
    author: contract.author,
    normState: 'approved',
    createdAt: input.at,
  });
  const ruleCreated = store.normChanges.append({
    at: input.at,
    kind: 'created',
    actor: { kind: 'orchestrator' },
    targetRef: { entity: 'Rule', id: rule.id },
    sessionId: null,
    runId: null,
    reason: CONTRACT_RULE_CREATED_REASON,
    detail: {
      after: {
        title: rule.title,
        statement: rule.statement,
        kind: rule.kind,
        checkKinds: rule.checkKinds,
        parentRequirementId: null,
        builtin: 'contract',
        contract: { id: contract.id, displayId: contract.displayId },
        targetBlockIds: [],
        risk: null,
      },
    },
  });
  return { rule, ruleCreated };
};

/**
 * 사람의 계약 등록 (열린 저장소의 트랜잭션 1개): 계약 · 승인 기록 `contract_edit`(`diff.before = null`) · 검사 규칙 · 검사 규칙의
 * 신규 기록. 계약은 미확인으로 돌려준다: 확인됨은 같은 트랜잭션에서 사람 RPC 처리기가 확인 서비스로 둔다.
 * @throws {ContractRegistrationError} 파일 형식 · 부모 요구사항 · 같은 파일 (아무것도 남지 않는다)
 */
export const registerHumanContract = (
  store: ProjectStore,
  input: ContractRegistration & { readonly by: HumanAuthor; readonly clientId: string | null },
): ContractRegistered & { readonly approvalLog: ApprovalLogEntry } =>
  store.transaction(() => {
    const contract = createContract(store, input, input.by);
    const approvalLog = store.approvalLog.append({
      at: input.at,
      action: 'contract_edit',
      actor: input.by,
      targetRef: { entity: 'Contract', id: contract.id },
      clientId: input.clientId,
      detail: { diff: { before: null, after: contractSnapshot(contract) } },
    });
    return { contract, approvalLog, ...createContractRule(store, contract, input) };
  });

/**
 * 에이전트의 계약 반영 (열린 저장소의 트랜잭션 1개): 계약(미확인) · 계약의 신규 기록(에이전트 주체 · 세션 · 사유) · 검사 규칙 ·
 * 검사 규칙의 신규 기록(주체 오케스트레이터). 승인 기록 · 확인 상태에는 닿지 않는다(ADR-100 C2 · I1). 이 함수를 부르는 에이전트
 * 도구는 아직 없다(ADR-129).
 * @throws {ContractRegistrationError} 파일 형식 · 부모 요구사항 · 같은 파일 (아무것도 남지 않는다)
 */
export const reflectAgentContract = (
  store: ProjectStore,
  input: ContractRegistration & {
    readonly actor: AgentAuthor;
    readonly sessionId: Ulid;
    readonly reason: string;
  },
): ContractRegistered & { readonly contractCreated: NormChangeEntry } =>
  store.transaction(() => {
    const contract = createContract(store, input, input.actor);
    const contractCreated = store.normChanges.append({
      at: input.at,
      kind: 'created',
      actor: input.actor,
      targetRef: { entity: 'Contract', id: contract.id },
      sessionId: input.sessionId,
      runId: null,
      reason: input.reason,
      detail: { after: contractSnapshot(contract) },
    });
    return { contract, contractCreated, ...createContractRule(store, contract, input) };
  });
