import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const queueDir = path.join(homedir(), '.local/state/mnhsu-youtube-queue');
export const queueFile = path.join(queueDir, 'queue.json');
export const lockFile = path.join(queueDir, 'publisher.lock');

export function ensureQueueDir() {
  mkdirSync(queueDir, { recursive: true });
}

export function loadQueue() {
  ensureQueueDir();
  if (!existsSync(queueFile)) {
    return {
      version: 1,
      updatedAt: null,
      jobs: [],
    };
  }
  const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
  queue.jobs = Array.isArray(queue.jobs) ? queue.jobs : [];
  return queue;
}

export function saveQueue(queue) {
  ensureQueueDir();
  queue.version = 1;
  queue.updatedAt = new Date().toISOString();
  const tmpFile = `${queueFile}.${process.pid}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(queue, null, 2)}\n`);
  renameSync(tmpFile, queueFile);
}

export function jobKey(job) {
  return `${job.sourceId}:${job.video?.id || job.videoId}`;
}

export function makeJob(source, video) {
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    video: {
      id: video.id,
      title: video.title,
      url: video.url,
    },
    queuedAt: new Date().toISOString(),
    attempts: 0,
    nextRunAt: null,
    lastError: null,
    failedAt: null,
  };
}

export function enqueueJobs(jobs) {
  const queue = loadQueue();
  const existing = new Set(queue.jobs.map(jobKey));
  const added = [];

  for (const job of jobs) {
    const key = jobKey(job);
    if (existing.has(key)) continue;
    existing.add(key);
    queue.jobs.push(job);
    added.push(job);
  }

  saveQueue(queue);
  return added;
}

export function isJobRunnable(job, now = new Date()) {
  return !job.nextRunAt || new Date(job.nextRunAt) <= now;
}

export function nextRunnableJob(queue, now = new Date()) {
  return queue.jobs.find((job) => isJobRunnable(job, now)) || null;
}

export function removeJob(queue, targetJob) {
  const key = jobKey(targetJob);
  queue.jobs = queue.jobs.filter((job) => jobKey(job) !== key);
}

export function delayJob(queue, targetJob, error) {
  const key = jobKey(targetJob);
  const index = queue.jobs.findIndex((job) => jobKey(job) === key);
  if (index === -1) return;

  const job = queue.jobs[index];
  const attempts = Number(job.attempts || 0) + 1;
  const delayHours = Math.min(24, 2 ** Math.min(attempts - 1, 5));
  job.attempts = attempts;
  job.lastError = error?.message || String(error);
  job.failedAt = new Date().toISOString();
  job.nextRunAt = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();

  queue.jobs.splice(index, 1);
  queue.jobs.push(job);
}
