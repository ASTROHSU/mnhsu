#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  delayJob,
  ensureQueueDir,
  jobKey,
  loadQueue,
  lockFile,
  nextRunnableJob,
  removeJob,
  saveQueue,
} from './youtube-queue.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const sources = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/youtube-sources.json'), 'utf8'));
const rawArgs = process.argv.slice(2);
const drainQueue = rawArgs.includes('--drain') || process.env.YOUTUBE_PUBLISH_DRAIN === '1';
const maxJobs = drainQueue ? Number.POSITIVE_INFINITY : Number(argValue('--max-jobs') || process.env.YOUTUBE_PUBLISH_MAX_JOBS || 3);

if (!Number.isFinite(maxJobs) && !drainQueue) {
  throw new Error('--max-jobs must be a finite number.');
}

if (Number.isFinite(maxJobs) && (!Number.isInteger(maxJobs) || maxJobs < 1)) {
  throw new Error('--max-jobs must be a positive integer.');
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function argValue(flag) {
  const inline = rawArgs.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = rawArgs.indexOf(flag);
  if (index >= 0) return rawArgs[index + 1] || '';
  return '';
}

function pidIsRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  ensureQueueDir();
  if (existsSync(lockFile)) {
    try {
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (pidIsRunning(lock.pid)) {
        log(`Publisher already running with pid ${lock.pid}.`);
        return false;
      }
      log(`Removing stale publisher lock from pid ${lock.pid || 'unknown'}.`);
      rmSync(lockFile, { force: true });
    } catch {
      rmSync(lockFile, { force: true });
    }
  }

  let fd;
  try {
    fd = openSync(lockFile, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') log('Publisher lock exists.');
    else throw error;
    return false;
  } finally {
    if (fd) closeSync(fd);
  }
}

function releaseLock() {
  try {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (lock.pid === process.pid) rmSync(lockFile, { force: true });
  } catch {
    // Nothing to release.
  }
}

function stateFileForSource(source) {
  const stateDir = source.stateDir || `mnhsu-${source.id}`;
  return path.join(process.env.HOME, '.local/state', stateDir, 'state.json');
}

function isAlreadyProcessed(job) {
  const source = sources.find((item) => item.id === job.sourceId);
  if (!source) return false;
  const stateFile = stateFileForSource(source);
  if (!existsSync(stateFile)) return false;
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  return Boolean(state.processed?.[job.video.id]);
}

function publishJob(job) {
  const script = path.join(repoRoot, 'scripts/youtube-watch.mjs');
  const result = spawnSync(process.execPath, [
    script,
    '--source',
    job.sourceId,
    '--video-id',
    job.video.id,
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    maxBuffer: 1024 * 1024 * 120,
  });

  if (result.status !== 0) {
    throw new Error(`youtube-watch failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function main() {
  log(`Repo: ${repoRoot}`);
  if (!acquireLock()) return;

  try {
    let processed = 0;
    while (processed < maxJobs) {
      const queue = loadQueue();
      const job = nextRunnableJob(queue);
      if (!job) {
        log(`No runnable jobs in queue. Pending total: ${queue.jobs.length}.`);
        return;
      }

      const source = sources.find((item) => item.id === job.sourceId);
      if (!source) {
        log(`Dropping job with unknown source: ${jobKey(job)}`);
        removeJob(queue, job);
        saveQueue(queue);
        continue;
      }

      if (isAlreadyProcessed(job)) {
        log(`Dropping already processed job: ${jobKey(job)}`);
        removeJob(queue, job);
        saveQueue(queue);
        continue;
      }

      log(`Publishing ${jobKey(job)}: ${job.video.title}`);
      try {
        publishJob(job);
        const updatedQueue = loadQueue();
        removeJob(updatedQueue, job);
        saveQueue(updatedQueue);
        processed += 1;
        log(`Finished ${jobKey(job)}.`);
      } catch (error) {
        const updatedQueue = loadQueue();
        delayJob(updatedQueue, job, error);
        saveQueue(updatedQueue);
        processed += 1;
        log(`Delayed ${jobKey(job)} after failure: ${error.message}`);
      }
    }

    if (drainQueue) log(`Worker drained runnable queue after ${processed} job(s).`);
    else log(`Worker stopped after max jobs: ${maxJobs}.`);
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error);
  releaseLock();
  process.exit(1);
});
