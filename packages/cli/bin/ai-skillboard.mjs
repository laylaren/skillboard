#!/usr/bin/env node
// Thin launcher so users can run `ai-skillboard` without invoking tsx by hand.
// We shell out to tsx to execute the TS entrypoint directly.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Resolve tsx's CLI via its public export ("tsx/cli") — works for both the
// monorepo (hoisted root) and a flat npm install (tsx as a direct dep of
// ai-skillboard). We avoid the internal "tsx/dist/cli.mjs" path because newer
// tsx versions don't expose it through their package "exports" map.
const tsxBin = require.resolve('tsx/cli');
const entry = resolve(here, '..', 'src', 'cli.ts');

const child = spawn(
  process.execPath,
  [tsxBin, entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
