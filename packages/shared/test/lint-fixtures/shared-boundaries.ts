// lint-path: packages/shared/src/__lint__.ts
// shared: 다른 워크스페이스 패키지 전부 · Node 전용 모듈 금지 (architecture.md 2장)
import { openStore } from '@bive/store'; // 위반
import { parse } from '@bive/parser'; // 위반
import { startEngine } from '@bive/orchestrator'; // 위반
import { createWindow } from '@bive/app'; // 위반
import { migrate } from '@bive/store/migrations'; // 위반
import { engine } from '../../orchestrator/src/index.js'; // 위반
import { readFileSync } from 'node:fs'; // 위반
import { join } from 'path'; // 위반
import { readFile } from 'fs/promises'; // 위반
const lazyStore = await import('@bive/store'); // 위반
import { z } from 'zod'; // 허용
import { ulid } from 'ulid'; // 허용
import { RunStatus } from './enums.js'; // 허용
