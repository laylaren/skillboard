import { agentsAdapter } from './agents.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { openclawAdapter } from './openclaw.js';
import type { Adapter } from './types.js';

export const adapters: Adapter[] = [
  agentsAdapter,
  claudeCodeAdapter,
  cursorAdapter,
  openclawAdapter,
  codexAdapter,
];

export type { Adapter } from './types.js';
