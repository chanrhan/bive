#!/usr/bin/env node
// 픽스처 사본의 구조 위반을 한 줄씩 찍는다 (M3-02 #47, scripts/test-make-variant.sh가 쓴다).
// 사용법: node scripts/variant-violations.mjs <dir> <블록 선언 JSON>
// 출력: 위반마다 `<종류> <from 파일> <to 파일>` 한 줄, 끝에 `total <개수>`. 파서 빌드(packages/parser/dist)가 먼저 필요하다
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../packages/parser/dist/index.js', import.meta.url));
if (!existsSync(dist)) {
  console.error('파서 빌드 없음: pnpm build를 먼저 실행할 것');
  process.exit(2);
}
const [dir, declarationFile] = process.argv.slice(2);
if (dir === undefined || declarationFile === undefined) {
  console.error('사용법: node scripts/variant-violations.mjs <dir> <블록 선언 JSON>');
  process.exit(2);
}
const { analyzeProject } = await import(dist);
const result = await analyzeProject({
  projectDir: dir,
  declaration: JSON.parse(readFileSync(declarationFile, 'utf8')),
});
const outcome = result.structure?.outcome;
if (outcome?.status !== 'checked') {
  console.error(`위반을 판별하지 않음: ${outcome?.status ?? '선언 없음'}`);
  process.exit(1);
}
for (const violation of outcome.violations.items) {
  console.log(`${violation.kind} ${violation.from.file} ${violation.to.file}`);
}
console.log(`total ${String(outcome.violations.total)}`);
