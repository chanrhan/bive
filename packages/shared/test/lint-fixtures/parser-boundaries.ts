// lint-path: packages/parser/src/__lint__.ts
// parser: store · orchestrator · app 금지 (architecture.md 2장)
import { openStore } from '@bive/store'; // 위반
import { startEngine } from '@bive/orchestrator'; // 위반
import { createWindow } from '@bive/app'; // 위반
import { repo } from '../../store/src/repo.js'; // 위반
import { RunStatus } from '@bive/shared'; // 허용
import { readFile } from 'node:fs/promises'; // 허용
