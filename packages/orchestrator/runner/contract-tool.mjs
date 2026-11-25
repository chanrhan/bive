// 계약 검사 도구의 진입 (M3-47 #292, ADR-132 ②).
// 사용: node contract-tool.mjs <도구 진입 파일> [도구 인자...]
// 부모(오케스트레이터)가 표준 입력 파이프를 쥐고 있다. 부모가 어떤 까닭으로든 사라지면(강제 종료 포함) 파이프가 닫히고, 이 프로세스는
// 도구와 함께 끝난다(prism 프록시처럼 스스로 끝나지 않는 서버가 고아로 남지 않게). 도구는 같은 프로세스에서 불러온다: 인자를 도구가
// 직접 불린 것처럼 바꾼 뒤 진입 파일을 가져온다.
import { pathToFileURL } from 'node:url';

const [entry, ...args] = process.argv.slice(2);
if (entry === undefined) {
  process.stderr.write('사용법: contract-tool.mjs <도구 진입 파일> [인자...]\n');
  process.exit(2);
}

// 부모가 사라지면 끝낸다. 표준 입력은 이벤트 고리를 붙잡지 않는다(스스로 끝나는 도구는 그대로 끝난다)
const quit = () => process.exit(70);
process.stdin.on('end', quit);
process.stdin.on('close', quit);
process.stdin.on('error', quit);
process.stdin.resume();
process.stdin.unref?.();

process.argv = [process.argv[0], entry, ...args];
await import(pathToFileURL(entry).href);
