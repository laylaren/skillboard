#!/usr/bin/env node
// Thin launcher so users can run `one-skill` without invoking tsx by hand.
// We shell out to tsx to execute the TS entrypoint directly.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Resolve tsx via node_modules — works for both the monorepo (hoisted root)
// and a flat npm install (tsx as a direct dep of one-skill).
const tsxBin = require.resolve('tsx/dist/cli.mjs');
const entry = resolve(here, '..', 'src', 'cli.ts');

const child = spawn(
  process.execPath,
  [tsxBin, entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
