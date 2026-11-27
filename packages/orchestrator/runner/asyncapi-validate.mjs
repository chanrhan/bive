// AsyncAPI 계약 문서의 유효성 검사 도구 (M3-49 #294, ADR-148).
// `contract-tool.mjs`가 같은 프로세스에서 불러온다. 사용: asyncapi-validate.mjs <문서 파일 이름>
// - 작업 폴더(빈 도구 폴더)의 문서 사본 하나를 `@asyncapi/parser`(오케스트레이터 패키지의 의존성)의 `parse`로 검사하고, 결과를 표준 출력에
//   JSON 한 줄로 쓴다. 판정은 부모(`contract-check/asyncapi.ts`)가 이 출력으로 한다
// - 바깥 참조 차단의 둘째 겹: 라이브러리의 기본 리졸버(`file` · `http` · `https`)는 끌 수 없고, 더한 리졸버가 오류를 던지면 기본 리졸버로
//   넘어간다(`resolver.js`의 `createSchemaResolver`). 그래서 같은 세 스킴에 먼저 도는 리졸버를 두어 빈 글을 돌려주고(기본 리졸버까지 가지
//   않는다) 읽으려 한 수만 센다. 부모는 그 수가 0이 아니면 판정하지 않는다(첫 겹은 부모의 사전 검사 `asyncapi-document.ts`).
//   순서 값은 1이다: 라이브러리는 거짓 같은 순서 값(0)을 맨 뒤(`Number.MAX_SAFE_INTEGER`, 기본 리졸버와 같은 자리)로 바꾸고, 같은
//   자리면 기본 리졸버가 먼저 돈다(실측: 순서 0이면 기본 리졸버가 파일을 읽고 원격 주소에 요청한다)
// - 라이브러리는 설정 파일 · 규칙 묶음 · 스키마 파서를 작업 폴더나 문서 위치에서 찾지 않는다(코드로 주는 것뿐). 이 스크립트는 기본
//   스키마 파서(AsyncAPI · JSON Schema draft-07) 밖의 파서를 등록하지 않는다
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Parser } = require('@asyncapi/parser');

/** 출력에 싣는 오류 문제 상한 (전체 수는 `errors`). */
const MAX_PROBLEMS = 100;

/** 라이브러리의 심각도 값 (`@stoplight/types`의 `DiagnosticSeverity`). */
const SEVERITY_ERROR = 0;
const SEVERITY_WARNING = 1;

const [documentFile] = process.argv.slice(2);
if (documentFile === undefined || documentFile.includes('/')) {
  process.stderr.write('사용법: asyncapi-validate.mjs <도구 폴더 안의 문서 파일 이름>\n');
  process.exit(2);
}

let externalReads = 0;
const blocked = () => {
  externalReads += 1;
  return '';
};
const parser = new Parser({
  __unstable: {
    resolver: {
      cache: false,
      resolvers: ['file', 'http', 'https'].map((schema) => ({ schema, order: 1, read: blocked })),
    },
  },
});

const text = readFileSync(documentFile, 'utf8');
const { document, diagnostics } = await parser.parse(text);

const errors = diagnostics.filter((item) => item.severity === SEVERITY_ERROR);
const problems = errors.slice(0, MAX_PROBLEMS).map((item) => ({
  code: typeof item.code === 'string' ? item.code : String(item.code ?? ''),
  message: String(item.message ?? ''),
  path: Array.isArray(item.path) ? item.path.map((part) => String(part)) : [],
  line: Number.isInteger(item.range?.start?.line) ? item.range.start.line + 1 : null,
}));

// 다 쓴 뒤 끝낸다 (라이브러리가 남긴 타이머를 기다리지 않는다)
process.stdout.write(
  `${JSON.stringify({
    tool: 'asyncapi-parser',
    parsed: document !== undefined,
    errors: errors.length,
    warnings: diagnostics.filter((item) => item.severity === SEVERITY_WARNING).length,
    uncaught: diagnostics.some((item) => item.code === 'uncaught-error'),
    externalReads,
    problems,
  })}\n`,
  () => process.exit(0),
);
