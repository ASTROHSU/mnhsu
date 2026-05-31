#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const rawArgs = process.argv.slice(2);
const scanArgs = [];
const workerArgs = [];
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === '--max-jobs') {
    workerArgs.push(arg, rawArgs[index + 1]);
    index += 1;
  } else if (arg.startsWith('--max-jobs=')) {
    workerArgs.push(arg);
  } else if (arg === '--drain') {
    workerArgs.push(arg);
  } else {
    scanArgs.push(arg);
  }
}
if (!scanArgs.some((arg) => arg === '--all' || arg === '--once' || arg === '--source' || arg.startsWith('--source='))) {
  scanArgs.unshift('--all');
}

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

const scanStatus = run('youtube-scan.mjs', scanArgs);
if (scanStatus !== 0) process.exit(scanStatus);

process.exit(run('youtube-publish-worker.mjs', workerArgs));
