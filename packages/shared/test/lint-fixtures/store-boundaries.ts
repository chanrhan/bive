// lint-path: packages/store/src/__lint__.ts
// store: orchestrator · parser · app 금지 (architecture.md 2장)
import { startEngine } from '@bive/orchestrator'; // 위반
import { parse } from '@bive/parser'; // 위반
import { createWindow } from '@bive/app'; // 위반
import { tools } from '@bive/orchestrator/tools'; // 위반
import { engine } from '../../orchestrator/src/engine.js'; // 위반
import { graph } from '../../../packages/parser/dist/index.js'; // 위반
import { RunStatus } from '@bive/shared'; // 허용
import Database from 'better-sqlite3'; // 허용
import { mkdirSync } from 'node:fs'; // 허용
