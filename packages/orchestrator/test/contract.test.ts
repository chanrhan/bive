// 계약 등록 · contract 검사 규칙 (M3-04 #49 수용 기준 1, NRM-03 · ADR-019 · ADR-100 D1 · D2 · C2 · I1 · B⑨, ADR-129).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소 · 실제 처리기 · 실제 git 저장소(프로젝트 폴더). 규범 입력(수용 기준 4)은
// rule-writer.test.ts · implementer.test.ts, CLI는 app/test/cli-contract.test.ts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type Author,
  CONTRACT_INVALID_REASON,
  type ContractInvalidCode,
  ContractInvalidData,
  createUlidGenerator,
  type Rule,
} from '@bive/shared';
import { ConflictError, type ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { retireAgentRule } from '../src/norms/agent-rule.js';
import {
  CONTRACT_RULE_CREATED_REASON,
  CONTRACT_SOURCE_MAX_BYTES,
  contractFileProblem,
  readContractSource,
  reflectAgentContract,
  registerHumanContract,
} from '../src/norms/contract.js';
import { createRun } from '../src/runs/run-service.js';
import { RpcCallError, type TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const agent = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;
const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await cleanup();
});

/** 사용자 쪽 git (서명 · 훅 끔). */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=사용자',
      '-c',
      'user.email=user@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${os.devNull}`,
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

const OPENAPI = 'openapi: 3.1.0\ninfo:\n  title: 샘플\n  version: 1.0.0\npaths: {}\n';
const PRISMA =
  'datasource db {\n  provider = "sqlite"\n}\n\nmodel Item {\n  id Int @id @default(autoincrement())\n}\n';
const ASYNCAPI = 'asyncapi: 3.0.0\ninfo:\n  title: 이벤트\n  version: 1.0.0\n';

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** 프로젝트 폴더: `main`에 계약 파일들을 커밋한 git 저장소. */
const makeRepo = (files: Readonly<Record<string, string | Buffer>> = {}): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-contract-'));
  temps.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const all = {
    'openapi.yaml': OPENAPI,
    'prisma/schema.prisma': PRISMA,
    'docs/events.yaml': ASYNCAPI,
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', '계약 파일');
  return dir;
};

const mainTip = (repo: string): string => git(repo, 'rev-parse', 'refs/heads/main');

const harness = async (rootPath: string): Promise<ProjectHarness> =>
  startProjectHarness({ servers, clients }, { rootPath });

const rpcError = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcCallError) return error;
    throw error;
  }
  throw new Error('오류가 나지 않았습니다');
};

/** 등록이 남기는 모든 자리의 수 (아무것도 남지 않았는지 대조). */
const footprint = (store: ProjectStore) => ({
  contracts: store.contracts.list().length,
  rules: store.rules.list().length,
  approvals: store.approvalLog.list().length,
  changes: store.normChanges.list().length,
  proposals: store.proposals.list().length,
  runs: store.runs.list().length,
});

const EMPTY = { contracts: 0, rules: 0, approvals: 0, changes: 0, proposals: 0, runs: 0 };

const register = (h: ProjectHarness, file: string, kind = 'openapi', extra: object = {}) =>
  h.client.call('contract.register', {
    projectId: h.project.id,
    file,
    kind: kind as 'openapi',
    author: human,
    ...extra,
  });

describe('contract.register: 사람의 CLI 등록 (수용 기준 1, ADR-100 C2)', () => {
  it('승인 대기 제안 없이 트랜잭션 1개로 계약(파일 · 내용 해시 · 확인됨, 근거 = 계약의 작성 기록) · contract 검사 규칙 · 승인 기록 contract_edit · 규범 변경 기록(규칙 신규, 주체 오케스트레이터)을 남기고, 실행을 만들지 않는다', async () => {
    const repo = makeRepo();
    // 작업 트리의 커밋하지 않은 수정은 보지 않는다: 해시는 기준 브랜치 커밋의 내용이다
    fs.writeFileSync(path.join(repo, 'openapi.yaml'), `${OPENAPI}# 커밋 안 한 수정\n`);
    const h = await harness(repo);
    h.clock.now = T0 + 5000;
    const result = await register(h, 'openapi.yaml');
    const at = iso(T0 + 5000);
    expect(result.contract).toEqual({
      id: result.contract.id,
      displayId: 'CON-001',
      kind: 'openapi',
      sourceFile: 'openapi.yaml',
      contentHash: sha256(OPENAPI),
      sourceCommit: mainTip(repo),
      parentRequirementId: null,
      author: human,
      createdAt: at,
      confirmation: {
        state: 'confirmed',
        at,
        by: human,
        basis: { kind: 'contract_record', at },
      },
    });
    expect(result.rule).toEqual({
      id: result.rule.id,
      displayId: 'RULE-001',
      title: '계약 일치: CON-001',
      statement:
        'WHILE 계약 CON-001이 등록되어 있으면 THE SYSTEM SHALL 그 계약의 원본 파일이 형식에 맞고 구현이 그 계약과 일치한다',
      kind: 'tech-constraint',
      checkKinds: ['contract'],
      parentRequirementId: null,
      parentDetachedAt: null,
      builtin: true,
      targetBlockIds: [],
      risk: null,
      contractId: result.contract.id,
      author: human,
      normState: 'approved',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      // 오케스트레이터가 만든 규칙은 미확인이다(확인됨은 사람의 확인뿐, 내장 구조 규칙과 같다)
      confirmation: { state: 'unconfirmed' },
    });
    // 사람 행동은 승인 기록에: 이전 없는 계약 편집 1건
    expect(result.approvalLog).toMatchObject({
      seq: 1,
      at,
      action: 'contract_edit',
      actor: human,
      targetRef: { entity: 'Contract', id: result.contract.id },
      detail: {
        diff: {
          before: null,
          after: {
            kind: 'openapi',
            sourceFile: 'openapi.yaml',
            contentHash: sha256(OPENAPI),
            sourceCommit: mainTip(repo),
            parentRequirementId: null,
          },
        },
      },
    });
    expect(result.approvalLog.clientId).toMatch(/^pipe-\d+$/);
    h.read((store) => {
      expect(store.approvalLog.list()).toEqual([result.approvalLog]);
      // 오케스트레이터 행동(규칙 생성)은 규범 변경 기록에만: 규칙 신규 1건, 계약 대상 기록은 없다(사람 행동은 승인 기록, C2)
      const changes = store.normChanges.list();
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        seq: 1,
        at,
        kind: 'created',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Rule', id: result.rule.id },
        sessionId: null,
        runId: null,
        reason: CONTRACT_RULE_CREATED_REASON,
        detail: {
          after: {
            title: '계약 일치: CON-001',
            checkKinds: ['contract'],
            parentRequirementId: null,
            builtin: 'contract',
            contract: { id: result.contract.id, displayId: 'CON-001' },
          },
        },
      });
      // 저장된 값 = 응답, 승인 대기 제안 · 실행 없음, 두 체인 유효
      expect(store.contracts.list()).toEqual([result.contract]);
      expect(store.rules.get(result.rule.id)).toEqual(result.rule);
      expect(footprint(store)).toEqual({
        ...EMPTY,
        contracts: 1,
        rules: 1,
        approvals: 1,
        changes: 1,
      });
      expect(store.approvalLog.verify()).toMatchObject({ valid: true });
      expect(store.normChanges.verify()).toMatchObject({ valid: true });
    });
  });

  it('요구사항과의 연결 단위는 파일이다: 계약(파일 1개)마다 부모 요구사항 0~1개를 두고, 한 요구사항에 여러 계약 파일을 이을 수 있으며, 검사 규칙은 요구사항이 아니라 계약에 매인다 (ADR-019)', async () => {
    const h = await harness(makeRepo());
    const requirement = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '헬스 체크 응답 모양',
      author: human,
    });
    const reqId = requirement.requirement.id;
    const api = await register(h, 'openapi.yaml', 'openapi', { requirementId: reqId });
    const db = await register(h, 'prisma/schema.prisma', 'db-schema', { requirementId: reqId });
    const events = await register(h, 'docs/events.yaml', 'asyncapi');
    expect(api.contract.parentRequirementId).toBe(reqId);
    expect(db.contract.parentRequirementId).toBe(reqId);
    expect(events.contract.parentRequirementId).toBeNull();
    // 연결은 파일 단위다: 계약에는 엔드포인트 · 테이블 같은 부분 단위 칸이 없다
    expect(Object.keys(api.contract).sort()).toEqual(
      [
        'author',
        'confirmation',
        'contentHash',
        'createdAt',
        'displayId',
        'id',
        'kind',
        'parentRequirementId',
        'sourceCommit',
        'sourceFile',
      ].sort(),
    );
    expect(api.approvalLog.detail.diff).toMatchObject({ after: { parentRequirementId: reqId } });
    expect(
      [api, db, events].map(({ contract, rule }) => [
        contract.displayId,
        contract.kind,
        rule.displayId,
        rule.parentRequirementId,
        rule.contractId === contract.id,
      ]),
    ).toEqual([
      ['CON-001', 'openapi', 'RULE-001', null, true],
      ['CON-002', 'db-schema', 'RULE-002', null, true],
      ['CON-003', 'asyncapi', 'RULE-003', null, true],
    ]);
    // 요구사항의 자식 규칙 목록에는 계약 검사 규칙이 없다 (요구사항 재판단 · 규칙 작성 흐름에 끼지 않는다)
    h.read((store) => expect(store.rules.listByParent(reqId)).toEqual([]));
  });

  it('부모 요구사항: 없으면 -32004, 삭제됨 · 잠정(효력 아님)이면 -32009이고 아무것도 남지 않는다', async () => {
    const h = await harness(makeRepo());
    const missing = await rpcError(
      register(h, 'openapi.yaml', 'openapi', { requirementId: newId() }),
    );
    expect(missing.code).toBe(-32004);
    const created = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '지울 요구사항',
      author: human,
    });
    const provisional = h.read((store) =>
      store.requirements.create({
        id: newId(),
        text: '잠정 요구사항',
        author: agent,
        normState: 'provisional',
        createdAt: iso(T0),
      }),
    );
    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: created.requirement.id,
      author: human,
    });
    const before = h.read(footprint);
    for (const requirementId of [created.requirement.id, provisional.id]) {
      const error = await rpcError(register(h, 'openapi.yaml', 'openapi', { requirementId }));
      expect(error.code, requirementId).toBe(-32009);
      expect(error.data).toEqual({ reason: 'requirement_not_effective' });
    }
    expect(h.read(footprint)).toEqual(before);
    expect(h.read((store) => store.contracts.list())).toEqual([]);
  });

  it('같은 파일을 다시 등록하면(같은 종류 · 다른 종류 모두) -32009이고 아무것도 남지 않는다: 등록 단위 = 파일, 내용이 바뀌어도 다시 등록이 아니라 변경 반영이다', async () => {
    const repo = makeRepo({ 'api.json': '{"openapi":"3.1.0"}' });
    const h = await harness(repo);
    await register(h, 'docs/events.yaml', 'asyncapi');
    const before = h.read(footprint);
    for (const kind of ['asyncapi', 'openapi']) {
      const error = await rpcError(register(h, 'docs/events.yaml', kind));
      expect(error.code, kind).toBe(-32009);
      expect(error.data).toEqual({ reason: 'contract_exists' });
    }
    // 기준 브랜치의 내용이 바뀐 뒤에도 같다
    fs.writeFileSync(path.join(repo, 'docs/events.yaml'), `${ASYNCAPI}# 바뀜\n`);
    git(repo, 'commit', '-q', '-am', '바뀜');
    expect((await rpcError(register(h, 'docs/events.yaml', 'asyncapi'))).code).toBe(-32009);
    expect(h.read(footprint)).toEqual(before);
    // 대조군: 다른 파일은 등록된다
    await register(h, 'api.json', 'openapi');
    expect(h.read(footprint).contracts).toBe(2);
  });

  it('에이전트 주체는 저장소를 열기 전에 -32020이다 (없는 프로젝트여도), 아무것도 남지 않는다', async () => {
    const h = await harness(makeRepo());
    for (const projectId of [h.project.id, newId()]) {
      const error = await rpcError(
        h.client.call('contract.register', {
          projectId,
          file: 'openapi.yaml',
          kind: 'openapi',
          author: agent,
        }),
      );
      expect(error.code, projectId).toBe(-32020);
    }
    expect(h.read(footprint)).toEqual(EMPTY);
    // 대조군: 사람 주체는 같은 요청으로 등록된다
    await register(h, 'openapi.yaml');
    expect(h.read(footprint).contracts).toBe(1);
  });
});

describe('contract.register: 파일 · 종류 거부 (-32001 CONTRACT_INVALID, 아무것도 남지 않음)', () => {
  const invalid = async (
    h: ProjectHarness,
    file: string,
    kind: string,
    code: ContractInvalidCode,
  ): Promise<void> => {
    const error = await rpcError(register(h, file, kind));
    expect({ file, kind, code: error.code }).toEqual({ file, kind, code: -32001 });
    expect(ContractInvalidData.parse(error.data), `${file} ${kind}`).toEqual({
      reason: CONTRACT_INVALID_REASON,
      code,
    });
  };

  it('종류 · 경로 · 확장자는 git을 부르기 전에 글자로 거부한다', async () => {
    const h = await harness(makeRepo());
    const cases: [string, string, ContractInvalidCode][] = [
      // 지금 등록을 받는 종류는 NRM-03의 세 종류뿐
      ['schema.json', 'json-schema', 'kind_not_supported'],
      ['external.yaml', 'external-api', 'kind_not_supported'],
      ['cache.yaml', 'cache', 'kind_not_supported'],
      // 프로젝트 밖 · 비정규 경로
      ['/etc/openapi.yaml', 'openapi', 'path_invalid'],
      ['../openapi.yaml', 'openapi', 'path_invalid'],
      ['docs/../openapi.yaml', 'openapi', 'path_invalid'],
      ['./openapi.yaml', 'openapi', 'path_invalid'],
      ['docs//events.yaml', 'asyncapi', 'path_invalid'],
      ['docs/', 'asyncapi', 'path_invalid'],
      ['', 'openapi', 'path_invalid'],
      ['.git/openapi.yaml', 'openapi', 'path_invalid'],
      ['sub/.GIT/openapi.yaml', 'openapi', 'path_invalid'],
      ['docs\\events.yaml', 'asyncapi', 'path_invalid'],
      ['C:/openapi.yaml', 'openapi', 'path_invalid'],
      ['open api.yaml', 'openapi', 'path_invalid'],
      ['*.yaml', 'openapi', 'path_invalid'],
      ['계약.yaml', 'openapi', 'path_invalid'],
      [`${'a/'.repeat(600)}x.yaml`, 'openapi', 'path_invalid'],
      // 종류와 맞지 않는 확장자 (대소문자 구분, 확장자만인 이름)
      ['prisma/schema.prisma', 'openapi', 'extension_mismatch'],
      ['openapi.yaml', 'db-schema', 'extension_mismatch'],
      ['openapi.YAML', 'openapi', 'extension_mismatch'],
      ['openapi.txt', 'openapi', 'extension_mismatch'],
      ['.yaml', 'openapi', 'extension_mismatch'],
    ];
    for (const [file, kind, code] of cases) {
      expect(contractFileProblem(file, kind as 'openapi'), file).toBe(code);
      await invalid(h, file, kind, code);
    }
    expect(h.read(footprint)).toEqual(EMPTY);
    // 대조군: 받는 경로 · 확장자 (규칙에 맞는 글자 · 하위 폴더 · 세 확장자)
    for (const [file, kind] of [
      ['openapi.yaml', 'openapi'],
      ['docs/v1/api.yml', 'openapi'],
      ['a-b_c@d+e.json', 'asyncapi'],
      ['prisma/schema.prisma', 'db-schema'],
    ] as const) {
      expect(contractFileProblem(file, kind), file).toBeNull();
    }
  });

  it('기준 브랜치 커밋의 git 객체로 판단한다: 커밋하지 않은 파일 · 기호 링크(프로젝트 밖 포함) · 디렉터리 · 하위 모듈 · 크기 상한 초과 · UTF-8이 아닌 글 · 대체 문자가 든 글은 거부한다', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-contract-outside-'));
    temps.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.yaml'), OPENAPI);
    const repo = makeRepo({
      'dir.yaml/inner.txt': '디렉터리',
      'big.json': Buffer.alloc(CONTRACT_SOURCE_MAX_BYTES + 1, 0x20),
      'edge.json': Buffer.alloc(CONTRACT_SOURCE_MAX_BYTES, 0x20),
      'latin1.yaml': Buffer.from([0x6f, 0x70, 0x65, 0x6e, 0xe9, 0x0a]),
      // 4바이트 글자의 앞 세 바이트 + ASCII: 대체 문자 하나(3바이트)로 바뀌어 길이가 같아진다
      'truncated.yaml': Buffer.from([0xf0, 0x90, 0x80, 0x41, 0x0a]),
      'replacement.yaml': 'title: \uFFFD\n',
    });
    fs.symlinkSync(path.join(outside, 'secret.yaml'), path.join(repo, 'link.yaml'));
    fs.symlinkSync('openapi.yaml', path.join(repo, 'inner-link.yaml'));
    git(repo, 'add', 'link.yaml', 'inner-link.yaml');
    // 하위 모듈 항목 (gitlink)
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${mainTip(repo)},sub.yaml`);
    git(repo, 'commit', '-q', '-m', '거부할 항목');
    fs.writeFileSync(path.join(repo, 'uncommitted.yaml'), OPENAPI);
    const h = await harness(repo);
    const cases: [string, string, ContractInvalidCode][] = [
      ['uncommitted.yaml', 'openapi', 'file_missing'],
      ['nothing/here.yaml', 'openapi', 'file_missing'],
      ['link.yaml', 'openapi', 'not_regular_file'],
      ['inner-link.yaml', 'openapi', 'not_regular_file'],
      ['dir.yaml', 'openapi', 'not_regular_file'],
      ['sub.yaml', 'openapi', 'not_regular_file'],
      ['big.json', 'openapi', 'too_large'],
      ['latin1.yaml', 'openapi', 'not_text'],
      ['truncated.yaml', 'openapi', 'not_text'],
      ['replacement.yaml', 'openapi', 'not_text'],
    ];
    for (const [file, kind, code] of cases) await invalid(h, file, kind, code);
    expect(h.read(footprint)).toEqual(EMPTY);
    // 대조군: 상한과 같은 크기 · 일반 파일은 받는다
    const edge = await register(h, 'edge.json');
    expect(edge.contract.contentHash).toBe(sha256(Buffer.alloc(CONTRACT_SOURCE_MAX_BYTES, 0x20)));
  });

  it('기준 브랜치를 읽지 못하면 base_unreadable: git 저장소가 아닌 폴더, 기준 브랜치가 없는 저장소', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-contract-plain-'));
    temps.push(plain);
    fs.writeFileSync(path.join(plain, 'openapi.yaml'), OPENAPI);
    await invalid(await harness(plain), 'openapi.yaml', 'openapi', 'base_unreadable');
    const other = makeRepo();
    git(other, 'branch', '-q', '-m', 'main', 'trunk');
    const h = await harness(other);
    await invalid(h, 'openapi.yaml', 'openapi', 'base_unreadable');
    expect(h.read(footprint)).toEqual(EMPTY);
    // 대조군: 읽는 함수는 실제 기준 브랜치에서 같은 파일을 읽는다
    expect(await readContractSource(other, 'trunk', 'openapi.yaml')).toEqual({
      ok: true,
      commit: git(other, 'rev-parse', 'refs/heads/trunk'),
      contentHash: sha256(OPENAPI),
    });
  });
});

describe('에이전트 반영: 미확인 · 규범 변경 기록에만 (수용 기준 1, ADR-100 C2 · I1)', () => {
  it('반영 모듈을 에이전트 주체로 부르면 계약은 미확인이고, 승인 기록 · 확인 상태에 닿지 않으며, 계약 신규(에이전트 · 세션 · 사유)와 검사 규칙 신규(오케스트레이터)만 남는다', async () => {
    const repo = makeRepo();
    const h = await harness(repo);
    const source = await readContractSource(repo, 'main', 'openapi.yaml');
    if (!source.ok) throw new Error(source.code);
    const sessionId = newId();
    const result = h.read((store) =>
      reflectAgentContract(store, {
        file: 'openapi.yaml',
        kind: 'openapi',
        source,
        requirementId: null,
        at: iso(T0 + 10),
        newId,
        actor: agent,
        sessionId,
        reason: '구현에 쓰는 API 모양을 계약으로 둔다',
      }),
    );
    expect(result.contract).toMatchObject({
      displayId: 'CON-001',
      author: agent,
      contentHash: sha256(OPENAPI),
      confirmation: { state: 'unconfirmed' },
    });
    expect(result.rule).toMatchObject({
      builtin: true,
      contractId: result.contract.id,
      author: agent,
      confirmation: { state: 'unconfirmed' },
    });
    h.read((store) => {
      expect(store.approvalLog.list()).toEqual([]);
      expect(store.confirmations.get({ entity: 'Contract', id: result.contract.id })).toEqual({
        state: 'unconfirmed',
      });
      expect(
        store.normChanges
          .list()
          .map((entry) => [
            entry.kind,
            entry.actor,
            entry.targetRef.entity,
            entry.sessionId,
            entry.reason,
          ]),
      ).toEqual([
        ['created', agent, 'Contract', sessionId, '구현에 쓰는 API 모양을 계약으로 둔다'],
        ['created', { kind: 'orchestrator' }, 'Rule', null, CONTRACT_RULE_CREATED_REASON],
      ]);
      expect(store.normChanges.list()[0]?.detail.after).toEqual({
        kind: 'openapi',
        sourceFile: 'openapi.yaml',
        contentHash: sha256(OPENAPI),
        sourceCommit: mainTip(repo),
        parentRequirementId: null,
      });
      expect(store.normChanges.verify()).toMatchObject({ valid: true });
    });
    // 같은 파일은 사람이 다시 등록할 수 없다 (등록 단위 = 파일)
    expect((await rpcError(register(h, 'openapi.yaml'))).code).toBe(-32009);
  });

  it('반영 · 등록 모듈의 트랜잭션은 하나다: 중간 쓰기가 실패하면 계약 · 규칙 · 승인 기록 · 규범 변경 기록 · 표시 ID 순번이 모두 남지 않는다', async () => {
    const repo = makeRepo();
    const h = await harness(repo);
    const source = await readContractSource(repo, 'main', 'openapi.yaml');
    if (!source.ok) throw new Error(source.code);
    const base = {
      file: 'openapi.yaml',
      kind: 'openapi' as const,
      source,
      requirementId: null,
      newId,
    };
    const failing = (store: ProjectStore) => {
      const original = store.normChanges.append.bind(store.normChanges);
      store.normChanges.append = () => {
        throw new Error('기록 실패');
      };
      return () => {
        store.normChanges.append = original;
      };
    };
    h.read((store) => {
      const restore = failing(store);
      try {
        expect(() =>
          registerHumanContract(store, { ...base, at: iso(T0), by: human, clientId: null }),
        ).toThrow('기록 실패');
        expect(() =>
          reflectAgentContract(store, {
            ...base,
            at: iso(T0),
            actor: agent,
            sessionId: newId(),
            reason: '사유',
          }),
        ).toThrow('기록 실패');
      } finally {
        restore();
      }
      expect(footprint(store)).toEqual(EMPTY);
      expect(store.sequences.last('CON')).toBe(0);
      expect(store.sequences.last('RULE')).toBe(0);
    });
  });

  it('반영 모듈은 형식 · 같은 파일을 다시 본다 (처리기를 거치지 않는 호출도 막는다)', async () => {
    const repo = makeRepo();
    const h = await harness(repo);
    const source = await readContractSource(repo, 'main', 'openapi.yaml');
    if (!source.ok) throw new Error(source.code);
    h.read((store) => {
      const input = {
        kind: 'openapi' as const,
        source,
        requirementId: null,
        at: iso(T0),
        newId,
        actor: agent,
        sessionId: newId(),
        reason: '사유',
      };
      expect(() => reflectAgentContract(store, { ...input, file: '../x.yaml' })).toThrow(
        /path_invalid/,
      );
      reflectAgentContract(store, { ...input, file: 'openapi.yaml' });
      expect(() => reflectAgentContract(store, { ...input, file: 'openapi.yaml' })).toThrow(
        /같은 파일/,
      );
      expect(footprint(store)).toMatchObject({ contracts: 1, rules: 1 });
    });
  });
});

describe('contract 검사 규칙: 계약에 매인 내장 규칙 (ADR-100 B⑨, ADR-129)', () => {
  const settle = (store: ProjectStore) =>
    store.settings.update(
      {
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: {
          'rule-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
          'test-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
          implementer: { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
        },
      },
      { by: human, at: iso(T0) },
    );

  it('사람의 [실행] 대상이 되지 않고(-32009, 실행 유형 B 전), 사람 편집 · 에이전트 폐기도 받지 않으며(builtin_rule), 자동 시작이 없다', async () => {
    const h = await harness(makeRepo());
    h.read(settle);
    const { rule } = await register(h, 'openapi.yaml');
    const run = await rpcError(
      h.client.call('run.create', { projectId: h.project.id, ruleIds: [rule.id], author: human }),
    );
    expect(run.code).toBe(-32009);
    h.read((store) =>
      expect(() =>
        createRun(
          store,
          { ruleIds: [rule.id], author: human },
          { clientId: null },
          {
            now: () => T0,
            newId,
          },
        ),
      ).toThrow(ConflictError),
    );
    const edit = await rpcError(
      h.client.call('rule.update', {
        projectId: h.project.id,
        id: rule.id,
        title: '바꾼 제목',
        author: human,
      }),
    );
    expect(edit.code).toBe(-32009);
    expect(edit.data).toMatchObject({ reason: 'builtin_rule' });
    h.read((store) => {
      expect(() =>
        retireAgentRule(
          store,
          {
            ruleId: rule.displayId,
            grounds: '"원본 파일이 형식에 맞고 구현이 그 계약과 일치한다"는 필요 없다',
            author: agent,
            sessionId: newId(),
          },
          { now: () => T0 },
        ),
      ).toThrow(/내장/);
      expect(store.runs.list()).toEqual([]);
      expect(store.ruleRetirements.retiredRuleIds().size).toBe(0);
      expect(store.rules.get(rule.id)).toEqual(rule);
      expect(store.normChanges.list().map((entry) => entry.kind)).toEqual(['created']);
    });
  });

  it('확인할 것 목록: 검사 규칙은 미확인 규칙 항목으로 오르고, 사람이 등록한 계약 자체는 확인됨이라 오르지 않는다. 확인 RPC는 계약을 대상으로 받지 않는다(-32602)', async () => {
    const h = await harness(makeRepo());
    const { contract, rule } = await register(h, 'openapi.yaml');
    const listed = await h.client.call('confirmation.list', { projectId: h.project.id });
    expect(listed.items.map((item) => [item.kind, 'target' in item ? item.target : null])).toEqual([
      ['unconfirmed_norm', { entity: 'Rule', id: rule.id }],
    ]);
    const raw = await h.client.requestRaw({
      jsonrpc: '2.0',
      id: 99,
      method: 'confirmation.set',
      params: {
        projectId: h.project.id,
        target: { entity: 'Contract', id: contract.id },
        author: human,
      },
    });
    expect(raw).toMatchObject({ error: { code: -32602 } });
    // 대조군: 검사 규칙은 사람이 확인할 수 있다
    await h.client.call('confirmation.set', {
      projectId: h.project.id,
      target: { entity: 'Rule', id: rule.id },
      author: human,
    });
    expect((await h.client.call('confirmation.list', { projectId: h.project.id })).items).toEqual(
      [],
    );
  });

  it('저장소 제약: 계약 검사 규칙은 있는 계약마다 하나이고 내장 · 부모 없음 · 검사 종류 계약뿐이다 (DB 트리거, 처리기를 거치지 않는 쓰기도 막는다)', async () => {
    const h = await harness(makeRepo());
    const { contract } = await register(h, 'openapi.yaml');
    const base = {
      title: '계약 규칙',
      statement: 'WHEN 요청이 오면 THE SYSTEM SHALL 계약대로 응답한다',
      kind: 'tech-constraint' as const,
      checkKinds: ['contract' as const],
      parentRequirementId: null,
      builtin: true,
      targetBlockIds: [],
      risk: null,
      author: human,
      normState: 'approved' as const,
      createdAt: iso(T0),
    };
    h.read((store) => {
      const req = store.requirements.create({
        id: newId(),
        text: '부모',
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      });
      const attempts: [string, Partial<Rule>][] = [
        ['두 번째 검사 규칙', {}],
        ['없는 계약', { contractId: newId() }],
        ['내장 아님', { builtin: false, parentRequirementId: req.id }],
        ['부모 있음', { parentRequirementId: req.id }],
        ['검사 종류', { checkKinds: ['test'] }],
      ];
      for (const [label, patch] of attempts) {
        expect(
          () =>
            store.rules.create({
              ...base,
              contractId: contract.id,
              id: newId(),
              ...patch,
            } as never),
          label,
        ).toThrow(/계약 검사 규칙/);
      }
      expect(store.rules.list()).toHaveLength(1);
    });
  });
});

describe('contract.list: 표시 ID · 종류 · 원본 파일 · 해시 · 확인 상태 · 검사 규칙과 지금 기준 브랜치 파일의 어긋남', () => {
  it('등록 때 해시를 저장하고, 기준 브랜치의 파일이 바뀌면 changed(지금 해시), 지워지면 missing으로 보인다 (변경 반영은 하지 않는다)', async () => {
    const repo = makeRepo();
    const h = await harness(repo);
    const api = await register(h, 'openapi.yaml');
    const db = await register(h, 'prisma/schema.prisma', 'db-schema');
    const list = () => h.client.call('contract.list', { projectId: h.project.id });
    expect(await list()).toEqual({
      contracts: [
        {
          contract: api.contract,
          rule: { id: api.rule.id, displayId: 'RULE-001' },
          source: { status: 'same' },
        },
        {
          contract: db.contract,
          rule: { id: db.rule.id, displayId: 'RULE-002' },
          source: { status: 'same' },
        },
      ],
    });
    // 작업 트리만 바뀌면 그대로(기준 브랜치 커밋 기준)
    const changed = `${OPENAPI}# 응답 필드 더함\n`;
    fs.writeFileSync(path.join(repo, 'openapi.yaml'), changed);
    expect((await list()).contracts.map((entry) => entry.source)).toEqual([
      { status: 'same' },
      { status: 'same' },
    ]);
    git(repo, 'commit', '-q', '-am', '계약 파일 수정');
    git(repo, 'rm', '-q', 'prisma/schema.prisma');
    git(repo, 'commit', '-q', '-m', '스키마 지움');
    const after = await list();
    expect(after.contracts.map((entry) => entry.source)).toEqual([
      { status: 'changed', contentHash: sha256(changed) },
      { status: 'missing' },
    ]);
    // 저장된 계약은 등록 때 그대로다
    expect(after.contracts.map((entry) => entry.contract)).toEqual([api.contract, db.contract]);
  });

  it('계약이 없으면 빈 목록, 기준 브랜치를 읽지 못하면 unreadable', async () => {
    const repo = makeRepo();
    const h = await harness(repo);
    expect(await h.client.call('contract.list', { projectId: h.project.id })).toEqual({
      contracts: [],
    });
    await register(h, 'openapi.yaml');
    git(repo, 'branch', '-q', '-m', 'main', 'trunk');
    expect(
      (await h.client.call('contract.list', { projectId: h.project.id })).contracts.map(
        (entry) => entry.source,
      ),
    ).toEqual([{ status: 'unreadable' }]);
  });
});
