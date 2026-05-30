#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const siteOrigin = process.env.SITE_ORIGIN || 'https://www.mnhsu.xyz';
const resendApiKey = process.env.RESEND_API_KEY || '';
const resendFrom = process.env.RESEND_FROM || 'mnhsu <notify@mnhsu.xyz>';
const resendTo = process.env.RESEND_TO || 'mn@mnhsu.xyz';
const before = process.env.GITHUB_BEFORE || '';
const sha = process.env.GITHUB_SHA || 'HEAD';
const forcedPath = process.env.ARTICLE_PATH || '';
const dryRun = process.env.DRY_RUN === '1';

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 20,
  });
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function textFromMeta(html, property) {
  const pattern = new RegExp(`<meta\\s+(?:property|name)=["']${property}["']\\s+content=["']([^"']+)["']`, 'i');
  return html.match(pattern)?.[1]?.trim() || '';
}

function textFromTitle(html) {
  return html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || '';
}

function articleUrl(filePath) {
  const relative = filePath.replace(/^public\//, '').replace(/index\.html$/, '');
  return `${siteOrigin}/${relative}`.replace(/([^:]\/)\/+/g, '$1');
}

function listNewArticleFiles() {
  if (forcedPath) return [forcedPath];
  if (!before || /^0+$/.test(before)) {
    return [];
  }
  const diff = run('git', ['diff', '--name-status', before, sha, '--', 'public/**/index.html']);
  return diff
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter(([status]) => status === 'A')
    .map(([, filePath]) => filePath)
    .filter((filePath) => /^public\/[^/]+\/index\.html$/.test(filePath));
}

async function waitForLive(url, expectedTitle) {
  const deadline = Date.now() + 1000 * 60 * 8;
  let lastStatus = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'mnhsu-new-article-notifier/1.0' },
      });
      lastStatus = `${response.status} ${response.statusText}`;
      if (response.ok) {
        const body = await response.text();
        if (!expectedTitle || body.includes(expectedTitle)) return;
        lastStatus = `200 but title not found yet`;
      }
    } catch (error) {
      lastStatus = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  throw new Error(`Production page did not become ready: ${url} (${lastStatus})`);
}

function readArticle(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const title = textFromMeta(html, 'og:title') || textFromTitle(html) || path.basename(path.dirname(filePath));
  const description = textFromMeta(html, 'og:description') || textFromMeta(html, 'twitter:description') || '';
  return {
    filePath,
    title,
    description,
    url: articleUrl(filePath),
  };
}

function emailHtml(articles) {
  const items = articles.map((article) => `
    <li style="margin:0 0 18px;">
      <a href="${htmlEscape(article.url)}" style="font-size:18px;font-weight:700;color:#0D2E20;text-decoration:none;">${htmlEscape(article.title)}</a>
      ${article.description ? `<p style="margin:6px 0 0;color:#6B6860;line-height:1.7;">${htmlEscape(article.description)}</p>` : ''}
      <p style="margin:6px 0 0;color:#9E9A90;font-size:13px;">${htmlEscape(article.url)}</p>
    </li>
  `).join('');

  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC','Microsoft JhengHei',sans-serif;background:#FAFAF7;color:#2C2A25;padding:28px;">
    <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #E8E3D8;border-radius:12px;padding:28px;">
      <p style="margin:0 0 10px;color:#C06A3A;font-size:13px;letter-spacing:.12em;font-weight:700;">MNHSU NOTIFY</p>
      <h1 style="margin:0 0 18px;font-size:24px;line-height:1.4;">mnhsu.xyz 有新文章上線</h1>
      <ul style="padding-left:20px;margin:0;">${items}</ul>
    </div>
  </div>`;
}

async function sendEmail(articles) {
  const subject = articles.length === 1
    ? `mnhsu.xyz 新文章：${articles[0].title}`
    : `mnhsu.xyz 有 ${articles.length} 篇新文章`;

  const payload = {
    from: resendFrom,
    to: [resendTo],
    subject,
    html: emailHtml(articles),
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is missing. Add it to GitHub Actions secrets.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API failed: ${response.status} ${body}`);
  }

  const result = await response.json();
  console.log(`Sent Resend email: ${result.id}`);
}

const files = listNewArticleFiles();
if (files.length === 0) {
  console.log('No new article pages found.');
  process.exit(0);
}

const articles = files.map(readArticle);
for (const article of articles) {
  console.log(`Waiting for ${article.url}`);
  await waitForLive(article.url, article.title);
}

await sendEmail(articles);
