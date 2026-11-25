// dependency-cruiser 실행기 (M3-02 #47, ADR-125). 파서가 자식 프로세스로 띄운다.
// - 입력: 표준 입력의 JSON 한 개 `{ args, options }`. `options`는 파서가 만든 cruise 옵션 그대로다(규칙 · 제외 · baseDir · tsConfig)
// - 출력: 표준 출력에 dependency-cruiser의 json 보고서. 오류는 표준 오류에 한 줄, 종료 코드 0이 아님
// - 공식 API `cruise`만 부른다. 설정 파일 찾기 · webpack · babel 설정 읽기 · 보고서 플러그인 · 캐시는 CLI에만 있거나 옵션을 줄 때만
//   돌므로, 여기서는 그 옵션들을 받지 않는다(허용 키 밖이면 거부)
// - TypeScript 파서가 없으면 .ts 파일의 import를 읽지 못한 채 "위반 0건"이 될 수 있어 거부한다
import { cruise, getAvailableTranspilers } from 'dependency-cruiser';

const ALLOWED_OPTION_KEYS = new Set([
  'baseDir',
  'exclude',
  'tsConfig',
  'tsPreCompilationDeps',
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

try {
  const result = await cruise(args, { ...options, outputType: 'json', cache: false });
  process.stdout.write(typeof result.output === 'string' ? result.output : JSON.stringify(result.output));
} catch (error) {
  fail(`분석 실패: ${error instanceof Error ? error.message.split('\n')[0] : '알 수 없는 오류'}`);
}
