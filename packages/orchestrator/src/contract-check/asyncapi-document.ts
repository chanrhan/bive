// AsyncAPI 계약 문서의 사전 검사 (M3-49 #294, ADR-148).
// `@asyncapi/parser` 3.6.3은 문서의 `$ref`를 기본 리졸버(`file` · `http` · `https`, `@stoplight/json-ref-readers`)로 받아 오고 그 기본
// 리졸버를 끄는 선택 항목이 없다(더할 수만 있다). 그래서 도구를 부르기 전에 이 모듈이 문서를 데이터로 읽어(`yaml` 파서: 중복 키 · 별칭 ·
// 여러 문서 거부) 닫힌 쪽으로 끝낸다. 둘째 겹은 도구 진입 스크립트의 가로채는 리졸버다(`runner/asyncapi-validate.mjs`).
// - 바깥을 가리키는 값: 키 `$ref` · `$dynamicRef` · `$recursiveRef`의 값이 `#`로 시작하는 글이 아님(원격 주소 · 다른 파일 · 글이 아닌 값).
//   AsyncAPI 2.x · 3.x에서 바깥 문서를 가리키는 자리는 참조 객체(Reference Object: 채널 · 작업 · 메시지 · 스키마 · 서버 · 매개변수 ·
//   바인딩 · 특성 · 응답 · 응답 주소 등 모든 `$ref`)와 그 안의 스키마(JSON Schema)의 `$ref`뿐이다. 키 이름만 보고 자리는 가리지 않는다
//   (넓게 막는다). 실측: `$schema` · `$id` · `externalDocs.url` · `servers.*.url` · `id` · 응답 `location`(실행 때 표현식)은 요청하지 않는다
// - 도구가 검사하지 못하는 스키마 형식: 키 `schemaFormat`의 글 값이 도구에 등록된 형식(AsyncAPI 스키마 · JSON Schema draft-07,
//   {@link SUPPORTED_SCHEMA_FORMATS}) 밖이면(Avro · RAML · OpenAPI · Protobuf 등) 도구는 그 스키마를 검사하지 않고 넘긴다(그 형식의 파서를
//   등록하지 않는다: 다른 파서는 바깥 스키마를 받거나 다른 실행 파일을 부를 수 있다). 그런 문서의 "유효함"은 통과가 아니므로 판정하지
//   않는다
// - 문서를 읽지 못함(YAML · JSON 문법, 별칭 · 태그 · 중복 키, 여러 문서, 최상위가 객체가 아님)은 문서 형식 오류다
// 이 모듈은 문서를 해석해 판정하지 않는다: 유효성 판정은 도구가 한다(ADR-033).
import { parseAllDocuments } from 'yaml';

/** 바깥을 가리킬 수 있는 키. */
const REFERENCE_KEYS = ['$ref', '$dynamicRef', '$recursiveRef'] as const;

/** AsyncAPI 문서의 판 (`@asyncapi/specs` 6.11.1의 스키마 목록 = 도구가 받는 판). */
export const ASYNCAPI_SPEC_VERSIONS = [
  '2.0.0',
  '2.1.0',
  '2.2.0',
  '2.3.0',
  '2.4.0',
  '2.5.0',
  '2.6.0',
  '3.0.0',
  '3.1.0',
] as const;

/**
 * 도구가 검사하는 스키마 형식 (`@asyncapi/parser` 3.6.3의 기본 스키마 파서 `AsyncAPISchemaParser`의 `getMimeTypes`와 같은 목록. 시험이
 * 라이브러리 값과 대조한다). 키 `schemaFormat`이 없으면 도구는 문서 판의 AsyncAPI 스키마로 본다.
 */
export const SUPPORTED_SCHEMA_FORMATS: readonly string[] = [
  'application/schema;version=draft-07',
  'application/schema+json;version=draft-07',
  'application/schema+yaml;version=draft-07',
  ...ASYNCAPI_SPEC_VERSIONS.flatMap((version) => [
    `application/vnd.aai.asyncapi;version=${version}`,
    `application/vnd.aai.asyncapi+json;version=${version}`,
    `application/vnd.aai.asyncapi+yaml;version=${version}`,
  ]),
];

/** 사전 검사가 걸린 자리 한 건 (JSON 포인터 · 키). 값 글은 싣지 않는다(문서 글이 화면 · 기록에 그대로 가지 않게). */
export interface DocumentFinding {
  readonly pointer: string;
  readonly key: string;
}

export type AsyncApiDocumentRead =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unreadable'; readonly message: string }
  | {
      readonly kind: 'external';
      readonly references: readonly DocumentFinding[];
      readonly total: number;
    }
  | {
      readonly kind: 'unsupported_schema_format';
      readonly formats: readonly DocumentFinding[];
      readonly total: number;
    };

/** 결과에 싣는 자리 상한 (넘는 수는 `total`에 센다). */
export const MAX_DOCUMENT_FINDINGS = 20;

const escapePointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Collected {
  readonly items: DocumentFinding[];
  total: number;
}

/** 문서 값에서 바깥을 가리키는 값과 도구가 검사하지 못하는 스키마 형식을 모은다 (깊이 우선, 문서 순서). */
export const asyncApiFindings = (root: unknown): { references: Collected; formats: Collected } => {
  const references: Collected = { items: [], total: 0 };
  const formats: Collected = { items: [], total: 0 };
  const push = (into: Collected, pointer: string, key: string): void => {
    into.total += 1;
    if (into.items.length < MAX_DOCUMENT_FINDINGS) into.items.push({ pointer, key });
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
          if (typeof child !== 'string' || !child.startsWith('#')) push(references, here, key);
        } else if (
          key === 'schemaFormat' &&
          typeof child === 'string' &&
          !SUPPORTED_SCHEMA_FORMATS.includes(child)
        ) {
          push(formats, here, key);
        }
        children.push({ value: child, pointer: here });
      }
    }
    // 문서 순서로 걷도록 거꾸로 쌓는다
    for (const child of children.reverse()) stack.push(child);
  }
  return { references, formats };
};

/**
 * 계약 문서 글을 데이터로 읽어 본다. 문서를 읽지 못하면 `unreadable`(문서 형식 오류), 바깥을 가리키는 값이 있으면 `external`, 도구가
 * 검사하지 못하는 스키마 형식이 있으면 `unsupported_schema_format`, 없으면 `ok`(도구를 불러도 된다). 바깥 참조가 먼저다.
 */
export const readAsyncApiDocument = (text: string): AsyncApiDocumentRead => {
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
  const { references, formats } = asyncApiFindings(value);
  if (references.total > 0) {
    return { kind: 'external', references: references.items, total: references.total };
  }
  if (formats.total > 0) {
    return { kind: 'unsupported_schema_format', formats: formats.items, total: formats.total };
  }
  return { kind: 'ok' };
};
