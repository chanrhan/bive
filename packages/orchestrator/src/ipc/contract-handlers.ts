// `contract.*` 처리기 (NRM-03, ADR-019 · ADR-033 · ADR-100 D1 · D2 · C2, M3-04 #49, ADR-129).
// - `contract.register`: 사람 주체만(-32020은 저장소를 열기 전, `blocks.set` · `confirmation.set`과 같은 장치. 판정 중인 코드가 토큰으로
//   사람 주체 RPC를 위조할 수 있다는 한계 #117은 그대로다). 종류 · 경로를 글자로 보고(-32001) 기준 브랜치 커밋의 파일을 읽은 뒤
//   (-32001), 트랜잭션 1개로 계약 · 승인 기록 `contract_edit` · 검사 규칙 · 규범 변경 기록(`norms/contract.ts`)과 계약의 확인됨
//   (근거 = 계약의 작성 기록, 확인 서비스)을 남긴다. 실행은 만들지 않는다
// - `contract.list`: 계약과 그 검사 규칙, 지금 기준 브랜치의 파일이 등록 때 내용과 같은지(읽기 전용)
// - 계약을 쓰는 RPC는 `contract.register` 하나다. 에이전트 도구 · 세션 · 엔진 · 단계는 이 처리기를 모른다(구조 시험)
import {
  CONTRACT_INVALID_REASON,
  type ContractInvalidCode,
  type ContractInvalidData,
  type ContractListResult,
  type ContractSourceState,
  createUlidGenerator,
  ErrorCode,
} from '@bive/shared';

import {
  confirmHumanContractRegistration,
  requireHuman,
} from '../confirmations/confirmation-service.js';
import type { GitRunner } from '../git/git-exec.js';
import {
  ContractRegistrationError,
  contractFileProblem,
  readContractSource,
  registerHumanContract,
} from '../norms/contract.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers, type RequestContext } from './server.js';

export interface ContractHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 등록 시각에 쓴다 */
  now: () => number;
  /** 계약 · 검사 규칙의 ID (기본 ULID 생성기) */
  newId?: () => string;
  /** git 실행 (시험용 주입, 기본 셸 없는 git) */
  git?: GitRunner;
}

type ContractMethods = Pick<MethodHandlers, 'contract.register' | 'contract.list'>;

/** 승인 기록의 `clientId`: 요청이 들어온 파이프 연결 번호 (기동마다 1부터, 증거용). */
const clientIdOf = (context: RequestContext): string => `pipe-${String(context.connectionId)}`;

const CODE_MESSAGES: Readonly<Record<ContractInvalidCode, string>> = {
  kind_not_supported: '지금 등록을 받는 계약 종류는 openapi · db-schema · asyncapi입니다',
  path_invalid:
    '원본 파일은 프로젝트 루트 기준 상대 경로(/ 구분, 영문 · 숫자 · . _ - @ + 글자, .. · .git 없음)여야 합니다',
  extension_mismatch: '종류와 맞지 않는 확장자입니다',
  base_unreadable: '기준 브랜치 커밋을 읽지 못했습니다',
  file_missing: '기준 브랜치 커밋에 그 파일이 없습니다 (커밋된 파일만 등록합니다)',
  not_regular_file: '일반 파일이 아닙니다 (디렉터리 · 기호 링크 · 하위 모듈)',
  too_large: '파일이 크기 상한을 넘습니다',
  not_text: 'UTF-8 글 파일이 아닙니다',
};

const invalid = (code: ContractInvalidCode): RpcError => {
  const data: ContractInvalidData = { reason: CONTRACT_INVALID_REASON, code };
  return new RpcError(ErrorCode.ValidationFailed, `계약 등록 실패: ${CODE_MESSAGES[code]}`, data);
};

/** 프로젝트 루트 · 기준 브랜치 (등록된 프로젝트의 행). */
const projectOf = (biveHome: string, projectId: string) =>
  withProjectStore(biveHome, projectId, (store) => {
    const project = store.getProject();
    if (project === null) throw new RpcError(ErrorCode.NotFound, `프로젝트 없음: ${projectId}`);
    return { rootPath: project.rootPath, baseBranch: project.baseBranch };
  });

export const createContractHandlers = ({
  biveHome,
  now,
  newId = createUlidGenerator(),
  git,
}: ContractHandlerDeps): ContractMethods => ({
  'contract.register': async ({ projectId, file, kind, author, requirementId }, context) => {
    const by = requireHuman(
      author,
      '계약 등록은 사람만 합니다 (에이전트의 계약 반영은 규범 변경 기록에 남는 다른 경로다)',
    );
    const problem = contractFileProblem(file, kind);
    if (problem !== null) throw invalid(problem);
    const project = projectOf(biveHome, projectId);
    const source = await readContractSource(project.rootPath, project.baseBranch, file, git);
    if (!source.ok) throw invalid(source.code);
    return withProjectStore(biveHome, projectId, (store) =>
      store.transaction(() => {
        let registered;
        try {
          registered = registerHumanContract(store, {
            file,
            kind,
            source: { commit: source.commit, contentHash: source.contentHash },
            requirementId: requirementId ?? null,
            at: new Date(now()).toISOString(),
            newId,
            by,
            clientId: clientIdOf(context),
          });
        } catch (error) {
          if (!(error instanceof ContractRegistrationError)) throw error;
          if (error.code === 'requirement_not_found') {
            throw new RpcError(ErrorCode.NotFound, error.message);
          }
          if (error.code === 'contract_invalid') throw invalid(error.invalid ?? 'path_invalid');
          throw new RpcError(ErrorCode.StateConflict, error.message, { reason: error.code });
        }
        const contract = confirmHumanContractRegistration(store, registered.contract);
        return { contract, rule: registered.rule, approvalLog: registered.approvalLog };
      }),
    );
  },
  'contract.list': async ({ projectId }) => {
    const project = projectOf(biveHome, projectId);
    const listed = withProjectStore(biveHome, projectId, (store) => {
      const rules = store.rules.list();
      return store.contracts.list().map((contract) => {
        const rule = rules.find((item) => item.contractId === contract.id) ?? null;
        return {
          contract,
          rule: rule === null ? null : { id: rule.id, displayId: rule.displayId },
        };
      });
    });
    const contracts: ContractListResult['contracts'] = [];
    for (const entry of listed) {
      const read = await readContractSource(
        project.rootPath,
        project.baseBranch,
        entry.contract.sourceFile,
        git,
      );
      let source: ContractSourceState;
      if (read.ok) {
        source =
          read.contentHash === entry.contract.contentHash
            ? { status: 'same' }
            : { status: 'changed', contentHash: read.contentHash };
      } else if (read.code === 'file_missing' || read.code === 'not_regular_file') {
        source = { status: 'missing' };
      } else {
        source = { status: 'unreadable' };
      }
      contracts.push({ ...entry, source });
    }
    return { contracts };
  },
});
