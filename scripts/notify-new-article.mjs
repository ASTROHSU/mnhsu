#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const siteOrigin = process.env.SITE_ORIGIN || 'https://www.mnhsu.xyz';
const resendApiKey = process.env.RESEND_API_KEY || '';
const resendFrom = process.env.RESEND_FROM || 'mnhsu <notify@mnhsu.xyz>';
const resendTo = process.env.RESEND_TO || 'mnhsu@pm.me';
const dryRun = process.env.DRY_RUN === '1';
const lookbackHours = Number(process.env.LOOKBACK_HOURS || 24);

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

function listRecentArticleFiles() {
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error(`LOOKBACK_HOURS must be a positive number. Got: ${process.env.LOOKBACK_HOURS}`);
  }

  const raw = run('git', [
    'log',
    `--since=${lookbackHours} hours ago`,
    '--diff-filter=A',
    '--name-only',
    '--pretty=format:',
    '--',
    'public',
  ]);

  const seen = new Set();
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((filePath) => /^public\/[^/]+\/index\.html$/.test(filePath))
    .filter((filePath) => {
      if (seen.has(filePath)) return false;
      seen.add(filePath);
      return true;
    });
}

function readArticle(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const title = textFromMeta(html, 'og:title') || textFromTitle(html) || path.basename(path.dirname(filePath));
  return {
    filePath,
    title,
    url: articleUrl(filePath),
  };
}

function formatTaipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function emailCss() {
  return `
    body{margin:0;background:#FAFAF7;color:#2C2A25;}
    .wrap{font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC','Microsoft JhengHei',sans-serif;background:#FAFAF7;color:#2C2A25;padding:24px;}
    .shell{max-width:640px;margin:0 auto;background:#fff;border:1px solid #E8E3D8;border-radius:12px;overflow:hidden;}
    .head{padding:24px 24px 18px;border-bottom:1px solid #EFEAE0;}
    .kicker{margin:0 0 8px;color:#C06A3A;font-size:12px;letter-spacing:.12em;font-weight:700;}
    h1{margin:0 0 8px;font-size:24px;line-height:1.4;color:#2C2A25;}
    .meta{margin:0;color:#6B6860;font-size:14px;line-height:1.7;}
    .body{padding:8px 24px 28px;}
    ol{margin:0;padding:0;list-style:none;}
    li{border-bottom:1px solid #EFEAE0;}
    li:last-child{border-bottom:0;}
    a{display:block;padding:18px 0;color:#2C2A25!important;text-decoration:none;font-size:18px;font-weight:700;line-height:1.55;}
    a:hover{text-decoration:underline;}
    .empty{margin:12px 0 0;color:#6B6860;font-size:17px;line-height:1.8;}
    .foot{padding:18px 24px 24px;border-top:1px solid #EFEAE0;color:#9E9A90;font-size:13px;line-height:1.7;}
    @media(max-width:640px){.wrap{padding:0}.shell{border-radius:0;border-left:0;border-right:0}.head,.body,.foot{padding-left:18px;padding-right:18px}h1{font-size:22px}a{font-size:17px}}
  `;
}

function emailHtml(articles) {
  const generatedAt = formatTaipeiDate();
  const title = articles.length === 0
    ? '過去 24 小時沒有新頁面'
    : `過去 24 小時新增 ${articles.length} 個頁面`;
  const items = articles.map((article) => `
    <li><a href="${htmlEscape(article.url)}">${htmlEscape(article.title)}</a></li>
  `).join('');

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${emailCss()}</style>
  </head>
  <body>
    <div class="wrap">
      <div class="shell">
        <div class="head">
          <p class="kicker">MNHSU DAILY DIGEST</p>
          <h1>${htmlEscape(title)}</h1>
          <p class="meta">統計區間：過去 ${htmlEscape(lookbackHours)} 小時。寄送時間：${htmlEscape(generatedAt)}。</p>
        </div>
        <div class="body">
          ${articles.length > 0 ? `<ol>${items}</ol>` : '<p class="empty">今天沒有需要補看的新內容。</p>'}
        </div>
        <div class="foot">
          這封信只列標題。要看完整內容，直接點開原本的網頁。
        </div>
      </div>
    </div>
  </body>
  </html>`;
}

function emailText(articles) {
  const header = articles.length === 0
    ? '過去 24 小時沒有新頁面'
    : `過去 24 小時新增 ${articles.length} 個頁面`;
  const lines = articles.map((article, index) => `${index + 1}. ${article.title}\n${article.url}`);
  return [header, '', ...lines].join('\n');
}

async function sendEmail(articles) {
  const subject = articles.length === 0
    ? 'mnhsu.xyz 過去 24 小時沒有新頁面'
    : `mnhsu.xyz 過去 24 小時新增 ${articles.length} 個頁面`;

  const payload = {
    from: resendFrom,
    to: [resendTo],
    subject,
    html: emailHtml(articles),
    text: emailText(articles),
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('Sending daily digest via Resend');
  console.log(`From: ${resendFrom}`);
  console.log(`To: ${resendTo}`);
  console.log(`Subject: ${subject}`);

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
    throw new Error(`Resend API failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const result = await response.json();
  console.log(`Sent Resend daily digest: ${result.id}`);
}

const files = listRecentArticleFiles();
console.log(`Recent article files: ${files.length ? files.join(', ') : '(none)'}`);
const articles = files.map(readArticle);
await sendEmail(articles);
