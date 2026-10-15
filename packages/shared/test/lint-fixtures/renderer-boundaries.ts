// lint-path: packages/app/src/renderer/__lint__.ts
// app renderer: electron · Node 모듈 · 다른 패키지 런타임 코드 금지, shared는 import type만 (architecture.md 2장)
import { ipcRenderer } from 'electron'; // 위반
import { readFileSync } from 'node:fs'; // 위반
import { RunStatus } from '@bive/shared'; // 위반
import { openStore } from '@bive/store'; // 위반
import { mockBridge } from '../../../e2e/support/bive-mock.js'; // 위반
import type { Rule } from '@bive/shared'; // 허용
import { useState } from 'react'; // 허용
