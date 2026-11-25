// dependency-cruiser 실행기 (M3-02 #47, ADR-125). 파서가 자식 프로세스로 띄운다.
// - 입력: 표준 입력의 JSON 한 개 `{ args, options }`. `options`는 파서가 만든 cruise 옵션 그대로다(규칙 · 제외 · baseDir · tsConfig)
// - 출력: 표준 출력에 dependency-cruiser 결과(json 보고서와 같은 내용) 가운데 파서가 읽는 칸만 담은 JSON. 오류는 표준 오류에 한 줄,
//   종료 코드 0이 아님. 칸을 고르기만 하고 값은 바꾸지 않는다(의존마다 붙는 순환 경로처럼 큰 칸을 싣지 않으려는 것)
// - 공식 API `cruise`만 부른다. 설정 파일 찾기 · webpack · babel 설정 읽기 · 보고서 플러그인 · 캐시는 CLI에만 있거나 옵션을 줄 때만
//   돌므로, 여기서는 그 옵션들을 받지 않는다(허용 키 밖이면 거부)
// - TypeScript 파서가 없으면 .ts 파일의 import를 읽지 못한 채 "위반 0건"이 될 수 있어 거부한다
import { cruise, getAvailableTranspilers } from 'dependency-cruiser';

const ALLOWED_OPTION_KEYS = new Set([
  'baseDir',
  'exclude',
  'tsConfig',
  'tsPreCompilationDeps',
  'skipAnalysisNotInRules',
  'ruleSet',
  'validate',
]);

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

let input;
try {
  input = JSON.parse(await readStdin());
} catch {
  fail('입력 JSON을 읽지 못함');
}
const { args, options } = input ?? {};
if (!Array.isArray(args) || typeof options !== 'object' || options === null) {
  fail('입력 모양이 다름');
}
for (const key of Object.keys(options)) {
  if (!ALLOWED_OPTION_KEYS.has(key)) fail(`허용하지 않는 옵션: ${key}`);
}
const typescript = getAvailableTranspilers().find((t) => t.name === 'typescript');
if (typescript?.available !== true) fail('TypeScript 파서를 찾지 못함');

let result;
try {
  // 보고서 종류를 주지 않으면 결과 객체 그대로(json 보고서가 직렬화하는 것과 같은 객체)를 받는다
  result = (await cruise(args, { ...options, cache: false })).output;
} catch (error) {
  fail(`분석 실패: ${error instanceof Error ? error.message.split('\n')[0] : '알 수 없는 오류'}`);
}
if (typeof result !== 'object' || result === null) fail('분석 결과가 객체가 아님');

const pick = (object, keys) =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(object, key)).map((key) => [key, object[key]]));

process.stdout.write(
  JSON.stringify({
    modules: (result.modules ?? []).map((module) => ({
      ...pick(module, ['source']),
      dependencies: (module.dependencies ?? []).map((dependency) =>
        pick(dependency, ['module', 'resolved', 'coreModule', 'couldNotResolve']),
      ),
    })),
    summary: {
      violations: (result.summary?.violations ?? []).map((violation) => ({
        ...pick(violation, ['type', 'from', 'to', 'rule']),
        ...(Array.isArray(violation.cycle)
          ? { cycle: violation.cycle.map((step) => pick(step, ['name'])) }
          : {}),
      })),
    },
  }),
);
