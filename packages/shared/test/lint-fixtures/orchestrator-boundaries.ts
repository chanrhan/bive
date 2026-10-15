// lint-path: packages/orchestrator/src/__lint__.ts
// orchestrator: app 금지 (architecture.md 2장)
import { createWindow } from '@bive/app'; // 위반
import { preload } from '@bive/app/preload'; // 위반
import { main } from '../../app/src/main/index.js'; // 위반
import { RunStatus } from '@bive/shared'; // 허용
import { openStore } from '@bive/store'; // 허용
import { parse } from '@bive/parser'; // 허용
import { query } from '@anthropic-ai/claude-agent-sdk'; // 허용
import { createServer } from 'node:net'; // 허용
