// OpenAPI 계약 문서의 사전 검사 (M3-47 #292, ADR-132 ③).
// 두 도구는 문서가 가리키는 바깥 자원을 받아 온다. 바깥 자료를 푸는 칸(도구 소스에서 리졸버를 부르는 자리, ADR-132 ③):
//   - `@redocly/cli` 2.77.0: 모든 객체의 `$ref`, 예시의 `externalValue`, `discriminator.mapping`의 값 · `discriminator.defaultMapping`
//     (참조처럼 생긴 글이면 `$ref`로 바꿔 푼다)
//   - `@stoplight/prism-cli` 5.14.2: `$ref`(json-schema-ref-parser의 http · 파일 리졸버)
//   끄는 선택 항목이 없어 도구를 부르기 전에 이 모듈이 문서를 데이터로 읽어 계약 파일 밖을 가리키는 값이 하나라도 있으면 도구를 부르지
//   않는다(닫힌 쪽).
// - 바깥을 가리키는 값: 키 `$ref` · `$dynamicRef` · `$recursiveRef` · `operationRef`의 값이 `#`로 시작하는 글이 아님(원격 주소 · 다른
//   파일 · 글이 아닌 값), `externalValue` 키가 있음, 키 `discriminator` 아래 `mapping`의 값 · `defaultMapping`이 문서 안 참조(`#`로
//   시작)도 받는 스키마 이름도 아님. 받는 스키마 이름 = `components.schemas` · `definitions`의 키이면서 컴포넌트 이름 글자
//   (`A-Za-z0-9._-`)만으로 되고 대소문자 가리지 않고 `.yaml` · `.yml` · `.json`으로 끝나지 않는 값({@link isPlainSchemaName}: redocly가
//   참조로 읽는 값보다 좁다). 키 이름만 보고 자리는 가리지 않는다(넓게 막는다)
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

/**
 * 판별자 대응 값으로 받는 스키마 이름의 모양 (허용 목록): 컴포넌트 이름 글자(`A-Za-z0-9._-`)만, 대소문자 가리지 않고 `.yaml` · `.yml` ·
 * `.json`으로 끝나지 않음. redocly 2.77.0은 `#`로 시작 · `http://` · `https://` · `file://` · `data:`로 시작 · `./` · `../`로 시작 · `/`
 * 포함 · `.ya?ml` · `.json`으로 끝남(대소문자 무시)을 참조로 읽어 푼다. 이 허용 목록은 `#` · `:` · `/`를 받지 않고 그 끝말을 받지 않아
 * 그 가운데 어느 것에도 걸리지 않는다(스키마 이름과 같아도 이 모양이 아니면 바깥 참조로 막는다).
 */
export const isPlainSchemaName = (value: string): boolean =>
  /^[A-Za-z0-9._-]+$/u.test(value) && !/\.(?:ya?ml|json)$/iu.test(value);

/** 문서의 스키마 이름 (`components.schemas` · `definitions`의 키). */
const schemaNames = (root: unknown): Set<string> => {
  const names = new Set<string>();
  if (!isRecord(root)) return names;
  const components = root.components;
  for (const table of [isRecord(components) ? components.schemas : undefined, root.definitions]) {
    if (isRecord(table)) for (const name of Object.keys(table)) names.add(name);
  }
  return names;
};

/** 문서 값에서 바깥을 가리키는 값을 모은다 (깊이 우선, 문서 순서). */
export const externalReferences = (
  root: unknown,
): { items: ExternalReference[]; total: number } => {
  const items: ExternalReference[] = [];
  let total = 0;
  const names = schemaNames(root);
  /** 판별자 대응 값이 문서 안인지: 문서 안 참조 또는 받는 스키마 이름 */
  const inside = (value: unknown): boolean =>
    typeof value === 'string' &&
    (value.startsWith('#') || (isPlainSchemaName(value) && names.has(value)));
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
        } else if (key === 'discriminator' && isRecord(child)) {
          if ('mapping' in child) {
            const mapping = child.mapping;
            if (!isRecord(mapping)) push(`${here}/mapping`, 'mapping');
            else {
              for (const [name, target] of Object.entries(mapping)) {
                if (!inside(target)) push(`${here}/mapping/${escapePointer(name)}`, 'mapping');
              }
            }
          }
          if ('defaultMapping' in child && !inside(child.defaultMapping)) {
            push(`${here}/defaultMapping`, 'defaultMapping');
          }
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
