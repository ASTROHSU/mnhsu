#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const script = path.join(repoRoot, 'scripts/youtube-run-queue.mjs');
const args = process.argv.slice(2);
if (!args.some((arg) => arg === '--source' || arg.startsWith('--source='))) {
  args.unshift('--source', 'money-stuff');
}

const result = spawnSync(process.execPath, [script, ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
