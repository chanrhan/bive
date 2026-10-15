// lint-path: packages/app/src/main/__lint__.ts
// app: store · orchestrator · parser 금지. 오케스트레이터는 실행 파일 경로로만 기동 (architecture.md 2장)
import { openStore } from '@bive/store'; // 위반
import { startEngine } from '@bive/orchestrator'; // 위반
import { parse } from '@bive/parser'; // 위반
import { engine } from '../../../orchestrator/src/index.js'; // 위반
const lazyOrchestrator = await import('@bive/orchestrator'); // 위반
import { RunStatus } from '@bive/shared'; // 허용
import { app, BrowserWindow } from 'electron'; // 허용
