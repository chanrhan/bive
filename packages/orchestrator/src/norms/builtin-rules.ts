// 내장 구조 규칙 (JDG-05 · NRM-02 · NRM-06, 기획서 3.4, ADR-100 B⑨ · C2, M3-03 #48, ADR-127).
// - 블록 선언을 사람이 저장할 때(`blocks.set`) 그 저장과 같은 트랜잭션에서 내장 구조 규칙 두 개를 없으면 만들고 있으면 그대로 둔다
//   (판이 올라가도 다시 만들지 않는다). 선언이 없는 프로젝트에는 없다. 이 PR 전에 선언을 저장한 프로젝트는 다음 저장 때 생긴다
// - 규칙 행: 부모 요구사항 없음 · `builtin` · 종류 architecture · 검사 종류 structure · 대상 블록 빈 목록 · 위험도 없음 · 효력 상태.
//   생성 주체 칸은 사람이다(규칙의 생성 주체는 사람 · 에이전트뿐이고, 사람의 선언 저장이 계기다. 에이전트가 쓴 글이 아니다)
// - 기록: 규범 변경 기록 `created` 1건씩(주체 오케스트레이터, 고정 사유, 만든 내용과 계기가 된 선언의 판). 승인 기록에는 쓰지 않는다
//   (사람 행동만, C2). 확인 상태는 미확인으로 시작한다(확인됨을 만드는 것은 사람의 확인뿐이다)
// - 어느 규칙이 어느 내장 규칙인지는 고정 제목으로 가린다(`builtin` 행 가운데 제목이 같은 것). 내장 규칙은 사람 편집 · 에이전트 폐기 ·
//   대체를 받지 않으므로 제목이 바뀌지 않는다. 같은 제목의 내장 행이 둘 이상이면(저장소 밖 변조) 구조 검사가 판정하지 않고 멈춘다
// - 이 모듈은 규칙을 만들기만 한다. 판정은 검사 단계 · 병합 재검사의 구조 검사(`steps/structure-check.ts`)가 한다
import {
  BUILTIN_STRUCTURE_RULES,
  type BlockDeclarationRecord,
  type NormChangeEntry,
  type Rule,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

export type BuiltinStructureRuleKey = (typeof BUILTIN_STRUCTURE_RULES)[number];

/** 내장 구조 규칙의 고정 글 (제목 = 기획서 3.4의 설명, 진술 = EARS). 화면에 보이는 글이라 문서 기호 · 코드 표기를 넣지 않는다. */
export const BUILTIN_STRUCTURE_RULE_TEXTS: Readonly<
  Record<BuiltinStructureRuleKey, { readonly title: string; readonly statement: string }>
> = {
  'structure.public-api-only': {
    title: '공개 API로만 접근',
    statement:
      'WHILE 블록 선언이 있으면 THE SYSTEM SHALL 블록의 파일이 다른 블록의 파일을 가져올 때 그 블록이 공개한 파일만 가져온다',
  },
  'structure.declared-direction': {
    title: '선언한 방향으로만 의존',
    statement:
      'WHILE 블록 선언이 있으면 THE SYSTEM SHALL 블록의 파일이 같은 블록과 선언한 의존 블록의 파일만 가져온다',
  },
};

/** 내장 구조 규칙을 만든 규범 변경 기록의 사유 (고정 문장). */
export const BUILTIN_RULE_CREATED_REASON = '블록 선언 저장에 따른 내장 구조 규칙 생성';

/** 규칙이 내장 구조 규칙 `key`인지 (내장 행이고 고정 제목이 같다). */
export const isBuiltinStructureRule = (rule: Rule, key: BuiltinStructureRuleKey): boolean =>
  rule.builtin && rule.title === BUILTIN_STRUCTURE_RULE_TEXTS[key].title;

/** 내장 구조 규칙 하나를 가리는 열쇠 (없으면 `null`). */
export const builtinStructureKeyOf = (rule: Rule): BuiltinStructureRuleKey | null =>
  BUILTIN_STRUCTURE_RULES.find((key) => isBuiltinStructureRule(rule, key)) ?? null;

/** 만든 내장 구조 규칙 하나와 그 신규 기록. */
export interface BuiltinRuleCreation {
  readonly key: BuiltinStructureRuleKey;
  readonly rule: Rule;
  readonly normChange: NormChangeEntry;
}

/**
 * 열린 저장소의 트랜잭션 안에서 내장 구조 규칙을 없는 것만 만든다(고정 순서). 이미 있으면 아무것도 쓰지 않는다. 만든 것을 돌려준다.
 * `declaration`은 같은 트랜잭션에서 방금 저장한 선언의 판이다(신규 기록에 계기로 남긴다).
 */
export const ensureBuiltinStructureRules = (
  store: ProjectStore,
  input: {
    readonly declaration: BlockDeclarationRecord;
    readonly at: string;
    readonly newId: () => Ulid;
  },
): BuiltinRuleCreation[] =>
  store.transaction(() => {
    const existing = store.rules.list();
    const created: BuiltinRuleCreation[] = [];
    for (const key of BUILTIN_STRUCTURE_RULES) {
      if (existing.some((rule) => isBuiltinStructureRule(rule, key))) continue;
      const text = BUILTIN_STRUCTURE_RULE_TEXTS[key];
      const rule = store.rules.create({
        id: input.newId(),
        title: text.title,
        statement: text.statement,
        kind: 'architecture',
        checkKinds: ['structure'],
        parentRequirementId: null,
        builtin: true,
        // 대상 블록 · 위험도: 명세에 문장이 없다. 모든 블록 사이의 가져오기를 보는 규칙이라 특정 블록을 고르지 않는다(ADR-127)
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: { kind: 'human' },
        normState: 'approved',
        createdAt: input.at,
      });
      const normChange = store.normChanges.append({
        at: input.at,
        kind: 'created',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Rule', id: rule.id },
        sessionId: null,
        runId: null,
        reason: BUILTIN_RULE_CREATED_REASON,
        detail: {
          after: {
            title: rule.title,
            statement: rule.statement,
            kind: rule.kind,
            checkKinds: rule.checkKinds,
            parentRequirementId: null,
            builtin: key,
            targetBlockIds: [],
            risk: null,
            blockDeclarationVersion: input.declaration.version,
          },
        },
      });
      created.push({ key, rule, normChange });
    }
    return created;
  });
