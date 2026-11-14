---
name: dev-env
description: 이 VM에서 화면 e2e · Electron 스모크 · 앱이나 오케스트레이터 기동 · CLI · 픽스처 설치와 초기화를 직접 실행할 때, 오래된 브랜치나 작업 공간에서 단위 테스트를 돌리기 전에 쓴다. 다음 오류를 만났을 때도 쓴다. Playwright가 chromium 실행 파일을 찾지 못함, Electron이 root에서 기동 실패, "소켓 경로가 너무 김", Vite 포트 충돌(`--strictPort`), 네이티브 모듈 빌드 스크립트 미실행, 테스트의 git 커밋이 서명 오류로 실패, 병렬 worktree에서 테스트 · e2e가 서로 간섭함.
---

# dev-env

CLAUDE.md 5장의 완료 조건 명령 9개로 부족할 때 읽는다. 여기 적는 것은 이 VM에서 실제로 실행해 확인한 것만이다. 환경 변수 전체 목록과 각 명령이 하는 일은 README 5~7장에 있다.

## 이 VM

Ubuntu 24.04 x86_64, GUI 없음, 4 vCPU · 15GB RAM. 외부 HTTPS는 정책 프록시 경유(TLS CA: `/root/.ccr/ca-bundle.crt`).

| 항목 | 사실 |
|---|---|
| Node · pnpm · Python | Node 22, pnpm 10 (루트 `package.json`의 `packageManager`로 고정), `python3` 있음 (`scripts/publish-roadmap.py`가 쓴다) |
| 가상 디스플레이 | Electron 창은 `xvfb-run -a <명령>`으로 띄운다. 화면 e2e는 헤드리스라 `xvfb`가 필요 없다 |
| 브라우저 | `/opt/pw-browsers/chromium-1194`만 있다. `playwright install` 금지. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`을 준다 (ADR-028 · ADR-043) |
| Electron | root라서 `--no-sandbox`가 필요하다. 스모크 · 앱 기동 코드는 root(uid 0)이거나 `BIVE_NO_SANDBOX=1`이면 스스로 붙인다 (ADR-028). 바이너리는 설치 때가 아니라 첫 `require('electron')` 때 내려받으므로 새 worktree의 첫 `pnpm smoke`는 그만큼 오래 걸린다 |
| GitHub | `scripts/gh-rest.sh`(= `gh api`)와 `git push`가 동작한다. 프록시가 인증을 넣으므로 `gh auth status`의 "token invalid" 경고는 무시한다. Actions 설정 · 브랜치 보호 API는 프록시가 막는다 (#108) |
| 에이전트 인증 | `ANTHROPIC_API_KEY` 없음. 실제 SDK 호출 불가, 가짜 어댑터 `BIVE_AGENT=scripted`와 `BIVE_SCENARIO=<이름>`으로 시험한다 (ADR-016 · ADR-049). 실제 호출 확인은 #126 |
| 커밋 서명 | 전역 git 설정이 커밋 서명을 강제한다(`commit.gpgsign=true`, 서명 프로그램은 로컬 서명 서버 호출). 제품의 git 실행기는 서명을 끄지만(ADR-058), 테스트 보조의 "사용자 git"은 전역 설정을 따른다 |

## 명령

2026-11-14 `main`(`2074c67`)에서 아래 표의 명령을 모두 실행해 기대 결과를 확인했다(`--open`은 README 6장 "M1 완료 기준 흐름 준비" 블록으로 띄워 원격 디버깅 포트로 요구사항 화면을 확인, 파이프라인 e2e 한 파일은 `forbidden-write.test.ts`).

| 작업 | 명령 | 기대 결과 |
|---|---|---|
| 앱 기동 | `BIVE_HOME=$(mktemp -d /tmp/bh.XXXX) BIVE_IDLE_SHUTDOWN_MS=2000 timeout 30 xvfb-run -a pnpm --filter @bive/app start` | 제한 시간까지 창이 떠 있어 종료 코드 124 (정상). dbus 연결 오류 로그는 GUI 없는 VM의 무해한 출력 |
| 프로젝트를 열며 기동 | 위 명령 끝에 `-- --open <폴더>` | 시작 화면 대신 그 폴더의 요구사항 화면으로 들어간다 (ADR-055) |
| 오케스트레이터 단독 기동 | `BIVE_HOME=$(mktemp -d /tmp/bh.XXXX) BIVE_IDLE_SHUTDOWN_MS=3000 pnpm --filter @bive/orchestrator start` | "오케스트레이터 기동" 출력 뒤 유휴 3초가 지나면 "오케스트레이터 종료 (idle)"로 스스로 끝난다. 종료 코드 0 |
| CLI 핑 | `BIVE_HOME=$(mktemp -d /tmp/bh.XXXX) BIVE_IDLE_SHUTDOWN_MS=3000 pnpm --filter @bive/app cli ping` | 출력 `pong`. 오케스트레이터가 없으면 CLI가 띄운다 |
| 픽스처 설치 | `pnpm -C fixtures/sample-next-app install --frozen-lockfile` | 픽스처는 루트 워크스페이스 밖이라 루트 `pnpm install`에 들어가지 않는다. 따로 설치해야 픽스처 테스트가 돈다 |
| 픽스처 테스트 | `pnpm -C fixtures/sample-next-app test` | 임시 SQLite 마이그레이션 → `next build` → `next start` → HTTP 확인 |
| 픽스처 초기화 | `scripts/reset-fixture.sh $(mktemp -d)/fx --verify` | 복사 → 설치 → git 커밋 → 테스트 통과 |
| 초기화 스크립트 검사 | `scripts/test-reset-fixture.sh` | 지우면 안 되는 경로를 거부하는지 검사 |
| 파이프라인 e2e 한 파일 | `packages/orchestrator`에서 `pnpm exec vitest run --config vitest.pipeline.config.ts e2e/pipeline/<파일>` | 그 시험 하나만 통과. 픽스처 설치가 먼저 필요하다. 파일마다 실제 설치 · `next build`를 해서 한 파일에 1분 남짓, 전체(`pnpm e2e:pipeline`)는 10분을 넘는다 |
| GitHub REST | `scripts/gh-rest.sh GET repos/chanrhan/bive/milestones` | 마일스톤 목록 JSON |

오케스트레이터의 개발 기동은 `packages/orchestrator`에서 `node --conditions=@bive/source --import tsx src/cli.ts`이고 `pnpm --filter @bive/orchestrator start`와 같다. 앱은 개발 중 같은 명령으로 분리 프로세스를 띄운다 (ADR-042).

## 자주 겪는 문제

- **`pnpm test`를 돌리면 세션(컨테이너)이 죽는다**: 커밋 `97b4d86`(main `1d4864f`, PR #145) 이전의 `packages/orchestrator/test/lock.test.ts`는 잠금 파일에 지어낸 pid 111 · 222를 적고, 정리 단계가 그 번호의 살아 있는 프로세스에 SIGKILL을 보냈다. 테스트가 root로 도는 이 VM에서는 그 번호가 세션을 받치는 실제 프로세스일 수 있다. 오래된 브랜치나 작업 공간에서는 `git merge-base --is-ancestor 97b4d86 HEAD`로 수정이 들어 있는지 먼저 확인하고, 없으면 main을 병합한 뒤에 테스트를 돌린다. 2026-11-13에 이 문제로 컨테이너가 여러 번 재시작됐다.
- **빌드 스크립트가 돌지 않는다** (`better-sqlite3` 네이티브 모듈 · Electron 바이너리 없음): pnpm 10은 postinstall을 기본 차단한다. 루트 `package.json`의 `pnpm.onlyBuiltDependencies`에 패키지를 넣고 `pnpm install`을 다시 실행한다 (ADR-028).
- **Electron이 root에서 기동 실패한다**: Chromium 샌드박스 때문이다. 직접 `electron`을 실행할 때만 손으로 `--no-sandbox`를 붙인다.
- **Playwright가 브라우저 실행 파일(chromium 1248)을 찾지 못한다**: 위 표의 환경 변수를 주고 `playwright install`은 쓰지 않는다.
- **오케스트레이터가 "소켓 경로가 너무 김"으로 기동하지 않는다**: Unix 소켓 경로는 Linux 107바이트, macOS 103바이트까지다. `BIVE_HOME`을 `mktemp -d /tmp/bh.XXXX`처럼 짧은 경로로 준다. worktree 안에 임시 폴더를 만들면 걸리기 쉽다.
- **`pnpm e2e`의 Vite 서버가 뜨지 않는다** (`--strictPort`): e2e의 Vite 서버는 매번 새로 뜨고 포트가 차 있으면 실패한다 (ADR-043). 기본 포트는 worktree 경로 해시로 정해져(5179 + hash % 500) 보통 겹치지 않는다. 겹치면 `BIVE_E2E_PORT`로 다른 포트를 준다 (ADR-046).
- **테스트의 `git commit`이 "failed to write commit object"로 실패한다** (출력에 `code-sign` · `failed to call MCP server`): 로컬 서명 서버가 응답하지 않는 것이다. 컨테이너 재시작 직후에 생긴다. 제품 결함이 아니므로 잠시 뒤 같은 테스트를 다시 실행해 확인한다. `worktree-reset.test.ts` · `test-writer.test.ts`처럼 테스트 보조의 사용자 git으로 커밋하는 시험에서 난다.
- **PR을 만들었는데 CI 검사가 생기지 않는다**: PR의 `mergeable_state`가 `dirty`(main과 충돌)면 CI가 아예 생기지 않는다. PR을 만든 직후 `scripts/gh-rest.sh GET repos/chanrhan/bive/pulls/<번호>`로 확인하고, `dirty`면 `git fetch origin main && git merge origin/main`으로 충돌을 풀고 다시 푸시한다.
- **변조 재현 때 다른 작업 공간까지 바뀐다**: `node_modules`의 파일은 전역 pnpm 저장소에서 하드 링크된 것이라 고치면 저장소 원본과 다른 작업 공간이 함께 바뀐다. 의존성 파일을 고쳐 재현할 때는 별도 `--store-dir`이나 복사 설치(`--package-import-method=copy`)에서 한다. `pnpm store status`가 `esbuild`를 수정됨으로 보고하는 것은 esbuild 설치 스크립트가 자기 파일을 바꾸는 알려진 동작이라 변조가 아니다.
- **병렬 worktree의 테스트가 서로 간섭한다**: 테스트는 `TMPDIR=$(mktemp -d /tmp/t<이슈>.XXXX) pnpm test`처럼 임시 폴더를 따로 준다. 로그 · PR 본문 같은 임시 파일을 공용 scratchpad에 둘 때는 이슈 번호를 파일 이름에 넣는다. 부하가 높아 프로세스 기동 시험이 시간 초과되면 그 파일만 단독으로 다시 실행해 판단한다 (ADR-064).
