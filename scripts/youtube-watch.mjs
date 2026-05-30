#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const sourcesFile = path.join(repoRoot, 'scripts/youtube-sources.json');
const sources = JSON.parse(readFileSync(sourcesFile, 'utf8'));
const codexBin = process.env.CODEX_BIN || '/Applications/Codex.app/Contents/Resources/codex';
const defaultModel = process.env.CODEX_MODEL || '';
const codexTimeoutMs = Number(process.env.CODEX_TIMEOUT_MS || 1000 * 60 * 12);

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const dryRun = args.has('--dry-run');
const processLatest = args.has('--process-latest');
const processAll = args.has('--all') || args.has('--once');
const force = args.has('--force');
const sourceId = argValue('--source');
const targetVideoId = argValue('--video-id');
const targetPlaylistIndex = argValue('--playlist-index');

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

function runChecked(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    maxBuffer: options.maxBuffer || 1024 * 1024 * 120,
    timeout: options.timeout,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${command} timed out after ${options.timeout}ms`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} failed with ${result.status}\n${detail}`);
  }
  return result.stdout || '';
}

function sourceStateDir(source) {
  return path.join(homedir(), '.local/state', source.stateDir || `mnhsu-${source.id}`);
}

function sourceStateFile(source) {
  return path.join(sourceStateDir(source), 'state.json');
}

function transcriptDir(source) {
  return path.join(homedir(), 'youtube-transcripts', source.transcriptDir || source.name);
}

function logDir(source) {
  return path.join(homedir(), 'Library/Logs', source.stateDir || `mnhsu-${source.id}`);
}

function ensureSourceDirs(source) {
  mkdirSync(sourceStateDir(source), { recursive: true });
  mkdirSync(transcriptDir(source), { recursive: true });
  mkdirSync(logDir(source), { recursive: true });
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
    '1:10',
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

function cleanupTitle(source, title) {
  let output = title;
  if (source.titleCleanupPattern) {
    output = output.replace(new RegExp(source.titleCleanupPattern, 'gi'), '');
  }
  return output.trim();
}

function slugify(source, title, id) {
  const cleanTitle = cleanupTitle(source, title);
  const base = cleanTitle
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${source.slugPrefix || source.id}-${base || id.toLowerCase()}`;
}

function cleanVtt(raw) {
  const seen = new Set();
  const output = [];
  for (const line of raw.split(/\r?\n/)) {
    let text = line.trim();
    if (!text) continue;
    if (text === 'WEBVTT') continue;
    if (/^Kind:/.test(text) || /^Language:/.test(text)) continue;
    if (/^\d+$/.test(text)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(text)) continue;
    if (/^NOTE\b/.test(text)) continue;
    text = text
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output.join('\n');
}

function downloadTranscript(source, video) {
  const transcriptPath = path.join(transcriptDir(source), `${video.id}.txt`);
  if (existsSync(transcriptPath) && readFileSync(transcriptPath, 'utf8').length > 1000) {
    log(`Transcript already exists: ${transcriptPath}`);
    return transcriptPath;
  }

  const tempPath = path.join(tmpdir(), `mnhsu-youtube-${source.id}-${video.id}-${Date.now()}`);
  mkdirSync(tempPath, { recursive: true });

  try {
    runChecked('yt-dlp', [
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en-orig,en',
      '--sub-format',
      'vtt',
      '-o',
      path.join(tempPath, '%(id)s.%(ext)s'),
      video.url,
    ], { maxBuffer: 1024 * 1024 * 120 });

    const subtitleFile = readdirSync(tempPath)
      .filter((name) => name.endsWith('.vtt'))
      .sort((a, b) => {
        const rank = (name) => {
          if (name.includes('.en-orig.')) return 0;
          if (name.includes('.en.')) return 1;
          return 9;
        };
        return rank(a) - rank(b);
      })[0];

    if (!subtitleFile) {
      throw new Error(`No VTT subtitle was downloaded for ${video.id}`);
    }

    const cleaned = cleanVtt(readFileSync(path.join(tempPath, subtitleFile), 'utf8'));
    if (cleaned.length < 1000) {
      throw new Error(`Transcript for ${video.id} is too short after cleanup`);
    }

    const header = [
      `Source: ${source.name}`,
      `Title: ${video.title}`,
      `URL: ${video.url}`,
      `Video ID: ${video.id}`,
      `Fetched: ${new Date().toISOString()}`,
      '',
      cleaned,
      '',
    ].join('\n');
    writeFileSync(transcriptPath, header);
    log(`Transcript saved: ${transcriptPath}`);
    return transcriptPath;
  } finally {
    rmSync(tempPath, { recursive: true, force: true });
  }
}

function todayForHomepage() {
  return new Date().toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).replace(/\//g, '.');
}

function makePrompt(source, video, transcriptPath, slug) {
  const cleanTitle = cleanupTitle(source, video.title);
  const tags = JSON.stringify(source.homepageTags || [source.name, 'YouTube']);
  return `
你現在在 mnhsu.xyz 的 Astro repo。請把這支 YouTube 影片逐字稿轉成一個可分享的互動式單頁，並保持跟現有頁面一致。
請使用本機已安裝的 article-experience skill 作為頁面結構、互動區塊、CTA、手機版檢查與品質 checklist 的依據。

來源已驗證：
- Source: ${source.name}
- Source URL: ${source.url}
- YouTube: ${video.url}
- 影片標題: ${video.title}
- 逐字稿檔案: ${transcriptPath}

來源脈絡：
${source.promptContext || `這是 ${source.name} 的 YouTube 影片。請把核心論點轉成互動式閱讀頁。`}

請完成這些工作：
1. 讀取逐字稿，理解影片的核心論點與結構。
2. 建立頁面：public/${slug}/index.html
3. 更新 src/pages/index.astro，把新頁面加在 work 清單最上方。
4. 只做檔案修改與必要驗證，不要 git commit，也不要 git push。

頁面要求：
- 使用 zh-Hant，寫給台灣讀者。禁止任何簡體中文或中國術語。
- 保持 mnhsu 近期互動頁風格：Noto Sans TC / Noto Serif TC、暖底色、清楚 hero、分段閱讀、卡片或表格輔助理解、最後有互動選擇與分享按鈕。
- 不是逐字稿全文堆疊，也不要像一張圖。請做成「讀完就知道這支影片在講什麼」的社群閱讀版。
- 可以引用少量英文原詞，但主體用繁體中文解釋。
- 頁尾標註來源為 ${source.footerSource || source.name}，附上 YouTube 來源連結 ${video.url}。
- 不要新增未驗證外部連結。若需要外部連結，只使用上面已驗證的 YouTube URL、既有的區塊勢訂閱連結、既有 logo 連結。
- 手機上要清楚：字級不要太小，行距足夠，互動按鈕可點，表格或卡片不可超出螢幕。
- 頁面 metadata 的 og:url 請用 https://www.mnhsu.xyz/${slug}/

首頁卡片建議：
- href: /${slug}/
- zh: 請根據這支影片內容寫一個 12 字以內的中文標題
- en: ${source.homepageEnPrefix || source.name + ':'} ${cleanTitle}
- date: ${todayForHomepage()}
- tags: ${tags}

驗證：
- 跑 npm run build。
- 檢查 public/${slug}/index.html 遵守 AGENTS.md 的台灣用語規範。
`.trim();
}

function runCodex(source, video, transcriptPath, slug) {
  if (!existsSync(codexBin)) {
    throw new Error(`Codex binary not found: ${codexBin}`);
  }
  const prompt = makePrompt(source, video, transcriptPath, slug);
  const promptPath = path.join(sourceStateDir(source), `prompt-${video.id}.md`);
  writeFileSync(promptPath, `${prompt}\n`);

  const commandArgs = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    repoRoot,
  ];
  if (defaultModel) commandArgs.push('-m', defaultModel);
  commandArgs.push(readFileSync(promptPath, 'utf8'));

  runChecked(codexBin, commandArgs, {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    maxBuffer: 1024 * 1024 * 120,
    timeout: codexTimeoutMs,
  });
}

function hasGitChanges() {
  return run('git', ['status', '--short']).trim().length > 0;
}

function deploy(video, slug) {
  runChecked('npm', ['run', 'build'], { stdio: 'inherit' });
  if (!hasGitChanges()) {
    log('No git changes after page generation.');
    return;
  }
  runChecked('git', ['add', 'src/pages/index.astro', `public/${slug}/index.html`], { stdio: 'inherit' });
  runChecked('git', ['commit', '-m', `Add YouTube page for ${video.id}`], { stdio: 'inherit' });
  runChecked('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
}

function markFailure(source, state, video, error) {
  state.failures[video.id] = {
    title: video.title,
    url: video.url,
    failedAt: new Date().toISOString(),
    message: error.message,
  };
  saveState(source, state);
}

function normalizePending(state, options = {}) {
  const seen = new Set();
  state.pending = (state.pending || []).filter((video) => {
    if (!video?.id || seen.has(video.id)) return false;
    if (!options.force && state.processed?.[video.id]) return false;
    seen.add(video.id);
    return true;
  });
}

async function processSource(source) {
  ensureSourceDirs(source);
  log(`Source: ${source.id} (${source.name})`);
  const state = loadState(source);
  const entries = fetchPlaylist(source);
  if (entries.length === 0) throw new Error(`${source.id} returned no entries.`);
  const latest = entries[0];
  const manualTarget = targetVideoId
    ? entries.find((entry) => entry.id === targetVideoId)
    : targetPlaylistIndex
      ? entries[Number(targetPlaylistIndex) - 1]
      : null;

  if ((targetVideoId || targetPlaylistIndex) && !manualTarget) {
    throw new Error(`Could not find requested video in ${source.id}.`);
  }

  if (!state.lastSeenId && !processLatest && !manualTarget) {
    state.lastSeenId = latest.id;
    state.lastSeenTitle = latest.title;
    state.lastCheckedAt = new Date().toISOString();
    if (!dryRun) saveState(source, state);
    log(`Initialized watcher at latest video ${latest.id}. Use --process-latest to publish it now.`);
    return;
  }

  if (manualTarget) {
    state.pending = [manualTarget, ...(state.pending || [])];
  } else if (processLatest && !state.processed?.[latest.id]) {
    state.pending = [latest, ...(state.pending || [])];
  } else if (state.lastSeenId && latest.id !== state.lastSeenId) {
    const lastSeenIndex = entries.findIndex((entry) => entry.id === state.lastSeenId);
    const newEntries = lastSeenIndex === -1 ? [latest] : entries.slice(0, lastSeenIndex);
    state.pending = [...(state.pending || []), ...newEntries.reverse()];
  }

  state.lastSeenId = latest.id;
  state.lastSeenTitle = latest.title;
  state.lastCheckedAt = new Date().toISOString();
  normalizePending(state, { force: Boolean(manualTarget && force) });

  if (state.pending.length === 0) {
    if (!dryRun) saveState(source, state);
    log(`No new video to process for ${source.id}.`);
    return;
  }

  const video = state.pending[0];
  const slug = slugify(source, video.title, video.id);
  log(`Processing ${video.id}: ${video.title}`);

  if (dryRun) {
    log(`Dry run only. Would publish /${slug}/`);
    log('Dry run did not update state or publish changes.');
    return;
  }

  saveState(source, state);

  try {
    const transcriptPath = downloadTranscript(source, video);
    runCodex(source, video, transcriptPath, slug);
    deploy(video, slug);

    state.processed[video.id] = {
      title: video.title,
      url: video.url,
      slug,
      processedAt: new Date().toISOString(),
    };
    delete state.failures[video.id];
    state.pending = state.pending.filter((item) => item.id !== video.id);
    saveState(source, state);
    log(`Published https://www.mnhsu.xyz/${slug}/`);
  } catch (error) {
    markFailure(source, state, video, error);
    throw error;
  }
}

async function main() {
  log(`Repo: ${repoRoot}`);
  runChecked('git', ['pull', '--ff-only', 'origin', 'main'], { stdio: 'inherit' });
  const selectedSources = sourceId
    ? sources.filter((source) => source.id === sourceId)
    : processAll
      ? sources
      : sources.filter((source) => source.id === 'money-stuff');

  if (selectedSources.length === 0) {
    throw new Error(`Unknown source: ${sourceId}`);
  }

  for (const source of selectedSources) {
    await processSource(source);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
