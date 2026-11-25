// OpenAPI 계약 문서의 사전 검사 (M3-47 #292, ADR-132 ③).
// 두 도구는 문서가 가리키는 바깥 자원을 받아 온다(실측: `@redocly/cli` 2.77.0은 원격 · 파일 `$ref`와 예시의 `externalValue`를,
// `@stoplight/prism-cli` 5.14.2는 원격 `$ref`를 받아 오고, 끄는 선택 항목이 없다). 그래서 도구를 부르기 전에 이 모듈이 문서를 데이터로
// 읽어 계약 파일 밖을 가리키는 값이 하나라도 있으면 도구를 부르지 않는다(닫힌 쪽).
// - 바깥을 가리키는 값: 키 `$ref` · `$dynamicRef` · `$recursiveRef` · `operationRef`의 값이 `#`로 시작하는 글이 아님(원격 주소 · 다른
//   파일 · 글이 아닌 값), `externalValue` 키가 있음. 키 이름만 보고 자리(스키마 안 · 속성 이름 등)는 가리지 않는다(넓게 막는다)
// - 문서를 읽지 못함(YAML · JSON 문법, 별칭 · 태그 · 중복 키, 여러 문서, 최상위가 객체가 아님)은 문서 형식 오류다
// 이 모듈은 문서를 해석해 판정하지 않는다: 형식 · 일치 판정은 도구가 한다(ADR-033).
import { parseAllDocuments } from 'yaml';

/** 바깥을 가리킬 수 있는 키. */
const REFERENCE_KEYS = ['$ref', '$dynamicRef', '$recursiveRef', 'operationRef'] as const;

/** 값이 있으면 늘 바깥 자원인 키. */
const EXTERNAL_VALUE_KEYS = ['externalValue'] as const;

/** 바깥을 가리키는 값 한 건 (JSON 포인터 · 키). 값 글은 싣지 않는다(문서 글이 화면 · 기록에 그대로 가지 않게). */
export interface ExternalReference {
  readonly pointer: string;
  readonly key: string;
}

export type OpenApiDocumentRead =
  /** `hasPaths`: `paths`에 항목이 하나라도 있는지 (prism은 작업이 없는 문서로 뜨지 않는다) */
  | { readonly kind: 'ok'; readonly hasPaths: boolean }
  | { readonly kind: 'unreadable'; readonly message: string }
  | {
      readonly kind: 'external';
      readonly references: readonly ExternalReference[];
      readonly total: number;
    };

/** 결과에 싣는 바깥 참조 상한 (넘는 수는 `total`에 센다). */
export const MAX_EXTERNAL_REFERENCES = 20;

const escapePointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 문서 값에서 바깥을 가리키는 값을 모은다 (깊이 우선, 문서 순서). */
export const externalReferences = (
  root: unknown,
): { items: ExternalReference[]; total: number } => {
  const items: ExternalReference[] = [];
  let total = 0;
  const push = (pointer: string, key: string): void => {
    total += 1;
    if (items.length < MAX_EXTERNAL_REFERENCES) items.push({ pointer, key });
  };
  const stack: { value: unknown; pointer: string }[] = [{ value: root, pointer: '' }];
  while (stack.length > 0) {
    const { value, pointer } = stack.pop()!;
    const children: { value: unknown; pointer: string }[] = [];
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        children.push({ value: item, pointer: `${pointer}/${String(index)}` }),
      );
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        const here = `${pointer}/${escapePointer(key)}`;
        if ((REFERENCE_KEYS as readonly string[]).includes(key)) {
          if (typeof child !== 'string' || !child.startsWith('#')) push(here, key);
        } else if ((EXTERNAL_VALUE_KEYS as readonly string[]).includes(key)) {
          push(here, key);
        }
        children.push({ value: child, pointer: here });
      }
    }
    // 문서 순서로 걷도록 거꾸로 쌓는다
    for (const child of children.reverse()) stack.push(child);
  }
  return { items, total };
};

/**
 * 계약 문서 글을 데이터로 읽어 바깥 참조를 본다. 문서를 읽지 못하면 `unreadable`(문서 형식 오류), 바깥을 가리키는 값이 있으면
 * `external`, 없으면 `ok`(도구를 불러도 된다).
 */
export const readOpenApiDocument = (text: string): OpenApiDocumentRead => {
  let documents;
  try {
    documents = parseAllDocuments(text, { uniqueKeys: true, merge: false });
  } catch {
    return { kind: 'unreadable', message: 'YAML · JSON으로 읽지 못함' };
  }
  if (!Array.isArray(documents) || documents.length !== 1) {
    return { kind: 'unreadable', message: '문서가 하나가 아님' };
  }
  const [document] = documents;
  if (document === undefined || document.errors.length > 0) {
    return { kind: 'unreadable', message: 'YAML · JSON 문법 오류' };
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { kind: 'unreadable', message: 'YAML 별칭 · 태그를 풀지 못함' };
  }
  if (!isRecord(value)) return { kind: 'unreadable', message: '최상위가 객체가 아님' };
  const { items, total } = externalReferences(value);
  if (total > 0) return { kind: 'external', references: items, total };
  return { kind: 'ok', hasPaths: isRecord(value.paths) && Object.keys(value.paths).length > 0 };
};
