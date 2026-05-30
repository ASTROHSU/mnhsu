#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { enqueueJobs, loadQueue, makeJob } from './youtube-queue.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const sources = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/youtube-sources.json'), 'utf8'));
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const dryRun = args.has('--dry-run');
const processLatest = args.has('--process-latest');
const processAll = args.has('--all') || args.has('--once') || !argValue('--source');
const sourceId = argValue('--source');
const latestUnprocessedArg = argValue('--latest-unprocessed') || argValue('--latest-unseen') || argValue('--backfill');
const latestUnprocessedCount = Number(latestUnprocessedArg || (processLatest ? 1 : 0));
const playlistLimit = Number(
  argValue('--playlist-limit') || (latestUnprocessedCount > 0 ? Math.max(30, latestUnprocessedCount * 5) : 10),
);

if (!Number.isInteger(latestUnprocessedCount) || latestUnprocessedCount < 0) {
  throw new Error('--latest-unprocessed must be a positive integer.');
}

if (!Number.isInteger(playlistLimit) || playlistLimit < 1) {
  throw new Error('--playlist-limit must be a positive integer.');
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

function run(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(' ')}`);
  return execFileSync(command, commandArgs, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer || 1024 * 1024 * 100,
  });
}

function sourceStateDir(source) {
  return path.join(homedir(), '.local/state', source.stateDir || `mnhsu-${source.id}`);
}

function sourceStateFile(source) {
  return path.join(sourceStateDir(source), 'state.json');
}

function ensureSourceDirs(source) {
  mkdirSync(sourceStateDir(source), { recursive: true });
}

function loadState(source) {
  const stateFile = sourceStateFile(source);
  if (!existsSync(stateFile)) {
    return {
      sourceId: source.id,
      sourceUrl: source.url,
      lastSeenId: null,
      pending: [],
      processed: {},
      failures: {},
    };
  }
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function saveState(source, state) {
  writeFileSync(sourceStateFile(source), `${JSON.stringify(state, null, 2)}\n`);
}

function fetchPlaylist(source) {
  const raw = run('yt-dlp', [
    '--flat-playlist',
    '--dump-single-json',
    '--playlist-items',
    `1:${playlistLimit}`,
    source.url,
  ]);
  const playlist = JSON.parse(raw);
  return (playlist.entries || [])
    .filter((entry) => entry?.id && entry?.title && entry?.url)
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      url: entry.url.startsWith('http') ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
    }));
}

function queuedVideoIdsForSource(sourceId) {
  const queue = loadQueue();
  return new Set(
    queue.jobs
      .filter((job) => job.sourceId === sourceId)
      .map((job) => job.video?.id || job.videoId)
      .filter(Boolean),
  );
}

function videosToQueue(source, state, entries) {
  const latest = entries[0];
  if (!latest) return [];

  if (!state.lastSeenId && latestUnprocessedCount === 0) {
    state.lastSeenId = latest.id;
    state.lastSeenTitle = latest.title;
    state.lastCheckedAt = new Date().toISOString();
    log(`Initialized ${source.id} at latest video ${latest.id}. Use --process-latest to enqueue it now.`);
    return [];
  }

  let candidates = [];
  if (latestUnprocessedCount > 0) {
    const queued = queuedVideoIdsForSource(source.id);
    const pending = new Set((state.pending || []).map((video) => video.id).filter(Boolean));
    candidates = entries
      .filter((video) => !state.processed?.[video.id])
      .filter((video) => !queued.has(video.id))
      .filter((video) => !pending.has(video.id))
      .slice(0, latestUnprocessedCount);
  } else if (state.lastSeenId && latest.id !== state.lastSeenId) {
    const lastSeenIndex = entries.findIndex((entry) => entry.id === state.lastSeenId);
    candidates = lastSeenIndex === -1 ? [latest] : entries.slice(0, lastSeenIndex).reverse();
  }

  state.lastSeenId = latest.id;
  state.lastSeenTitle = latest.title;
  state.lastCheckedAt = new Date().toISOString();

  return candidates
    .filter((video) => !state.processed?.[video.id])
    .map((video) => makeJob(source, video));
}

async function scanSource(source) {
  ensureSourceDirs(source);
  log(`Source: ${source.id} (${source.name})`);
  const state = loadState(source);
  const entries = fetchPlaylist(source);
  if (entries.length === 0) throw new Error(`${source.id} returned no entries.`);

  const jobs = videosToQueue(source, state, entries);
  if (!dryRun) saveState(source, state);

  if (jobs.length === 0) {
    log(`No new videos for ${source.id}.`);
    return [];
  }

  if (dryRun) {
    for (const job of jobs) log(`Dry run would enqueue ${job.video.id}: ${job.video.title}`);
    return jobs;
  }

  const added = enqueueJobs(jobs);
  for (const job of added) log(`Queued ${job.sourceId}/${job.video.id}: ${job.video.title}`);
  if (added.length < jobs.length) log(`${jobs.length - added.length} duplicate job(s) were already queued.`);
  return added;
}

async function main() {
  log(`Repo: ${repoRoot}`);
  const selectedSources = sourceId
    ? sources.filter((source) => source.id === sourceId)
    : processAll
      ? sources
      : [];

  if (selectedSources.length === 0) throw new Error(`Unknown source: ${sourceId}`);

  let addedCount = 0;
  for (const source of selectedSources) {
    const added = await scanSource(source);
    addedCount += added.length;
  }
  log(`Scan complete. ${dryRun ? 'Would add' : 'Added'} ${addedCount} job(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
