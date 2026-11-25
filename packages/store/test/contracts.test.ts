// 계약 리포지토리 (M3-04 #49, NRM-03 · ADR-019 · ADR-100 D2, ADR-129).
import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import type { ContractCreateInput } from '../src/repositories/contract-repository.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-11-25T00:00:00.000Z';
const T1 = '2026-11-25T01:00:00.000Z';
const human = { kind: 'human' } as const;

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const input = (patch: Partial<ContractCreateInput> = {}): ContractCreateInput => ({
  id: newId(),
  kind: 'openapi',
  sourceFile: 'openapi.yaml',
  contentHash: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
  parentRequirementId: null,
  author: human,
  createdAt: T0,
  ...patch,
});

describe('contracts 리포지토리', () => {
  it('표시 ID(CON-NNN)를 붙여 저장하고, 기본은 미확인이며 확인 상태는 확인 기록에서 함께 읽는다 (목록은 표시 ID 순)', () => {
    withStore((store) => {
      const first = store.contracts.create(input());
      const second = store.contracts.create(
        input({ sourceFile: 'prisma/schema.prisma', kind: 'db-schema' }),
      );
      expect([first.displayId, second.displayId]).toEqual(['CON-001', 'CON-002']);
      expect(first.confirmation).toEqual({ state: 'unconfirmed' });
      store.confirmations.confirm(
        { entity: 'Contract', id: first.id },
        { by: human, at: T1, basis: { kind: 'contract_record', at: T0 } },
      );
      const confirmed = {
        ...first,
        confirmation: {
          state: 'confirmed',
          at: T1,
          by: human,
          basis: { kind: 'contract_record', at: T0 },
        },
      };
      expect(store.contracts.get(first.id)).toEqual(confirmed);
      expect(store.contracts.list()).toEqual([confirmed, second]);
      expect(store.contracts.get(newId())).toBeNull();
    });
  });

  it('같은 파일 · 같은 ID는 ConflictError, 없는 부모 요구사항은 NotFoundError, 삭제된 부모는 ConflictError이고 표시 ID 순번을 쓰지 않는다', () => {
    withStore((store) => {
      const requirement = store.requirements.create({
        id: newId(),
        text: '부모',
        author: human,
        normState: 'approved',
        createdAt: T0,
      });
      const first = store.contracts.create(input({ parentRequirementId: requirement.id }));
      expect(() => store.contracts.create(input())).toThrow(ConflictError);
      expect(() =>
        store.contracts.create(input({ kind: 'asyncapi', sourceFile: 'openapi.yaml' })),
      ).toThrow(ConflictError);
      expect(() => store.contracts.create(input({ id: first.id, sourceFile: 'b.yaml' }))).toThrow(
        ConflictError,
      );
      expect(() =>
        store.contracts.create(input({ sourceFile: 'c.yaml', parentRequirementId: newId() })),
      ).toThrow(NotFoundError);
      store.requirements.softDelete(requirement.id, { by: human, at: T1 });
      expect(() =>
        store.contracts.create(
          input({ sourceFile: 'd.yaml', parentRequirementId: requirement.id }),
        ),
      ).toThrow(ConflictError);
      expect(store.sequences.last('CON')).toBe(1);
      expect(store.contracts.list()).toEqual([first]);
    });
  });
});
