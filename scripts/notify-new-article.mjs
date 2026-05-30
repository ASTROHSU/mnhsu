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
const eventName = process.env.GITHUB_EVENT_NAME || '';

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

function bodyFromHtml(html) {
  return html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]?.trim() || html;
}

function articleUrl(filePath) {
  const relative = filePath.replace(/^public\//, '').replace(/index\.html$/, '');
  return `${siteOrigin}/${relative}`.replace(/([^:]\/)\/+/g, '$1');
}

function listNewArticleFiles() {
  if (forcedPath) return [forcedPath];
  if (eventName === 'workflow_dispatch') {
    const latest = latestArticlePathFromIndex();
    return latest ? [latest] : [];
  }
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

function latestArticlePathFromIndex() {
  const source = readFileSync('src/pages/index.astro', 'utf8');
  const href = source.match(/href:\s*'\/([^']+)\/'/)?.[1];
  return href ? `public/${href}/index.html` : '';
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
  const url = articleUrl(filePath);
  return {
    filePath,
    title,
    description,
    url,
    bodyHtml: articleBodyForEmail(html),
  };
}

function articleBodyForEmail(html) {
  let body = bodyFromHtml(html);
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<div class="scroll-hint"[\s\S]*?<\/div>/gi, '')
    .replace(/<div class="result-card"[\s\S]*?<div class="share-row">[\s\S]*?<\/div>\s*<\/div>/gi, '')
    .replace(/<div class="share-row"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/\sonclick="[^"]*"/gi, '')
    .replace(/<button\b/gi, '<div')
    .replace(/<\/button>/gi, '</div>')
    .replace(/\shref="\//g, ` href="${siteOrigin}/`)
    .replace(/\ssrc="\//g, ` src="${siteOrigin}/`);
  return body;
}

function emailCss() {
  return `
    body{margin:0;background:#FAFAF7;color:#2C2A25;}
    .email-wrap{font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC','Microsoft JhengHei',sans-serif;background:#FAFAF7;color:#2C2A25;padding:24px;}
    .email-shell{max-width:720px;margin:0 auto;background:#fff;border:1px solid #E8E3D8;border-radius:12px;overflow:hidden;}
    .email-head{padding:24px 24px 10px;border-bottom:1px solid #EFEAE0;}
    .email-kicker{margin:0 0 8px;color:#C06A3A;font-size:12px;letter-spacing:.12em;font-weight:700;}
    .email-head h1{margin:0 0 8px;font-size:24px;line-height:1.4;color:#2C2A25;}
    .email-desc{margin:0 0 12px;color:#6B6860;line-height:1.7;}
    .email-link{font-size:13px;color:#9E9A90;word-break:break-all;}
    .email-article{padding:0 24px 28px;}
    .email-article .hero{min-height:auto;text-align:center;padding:34px 0;background:linear-gradient(180deg,#EDE0D4,#FAFAF7);}
    .email-article .logo{height:42px;margin-bottom:18px;}
    .email-article h1,.email-article h2{font-family:Georgia,'Noto Serif TC',serif;color:#2C2A25;line-height:1.45;}
    .email-article h1{font-size:28px;margin:0 0 14px;}
    .email-article h2{font-size:23px;margin:0 0 18px;}
    .email-article p{font-size:17px;line-height:1.85;margin:0 0 18px;color:#2C2A25;}
    .email-article section{padding:30px 0;border-bottom:1px solid #EFEAE0;}
    .email-article .part-label{font-size:12px;letter-spacing:.14em;font-weight:700;color:#C06A3A;margin-bottom:12px;}
    .email-article .sub{color:#6B6860;max-width:560px;margin:0 auto;}
    .email-article .hl{background:#F9F3E6;font-weight:500;}
    .email-article .question-card,.email-article .book-card,.email-article .callout,.email-article .split-card,.email-article .signal div{background:#FAFAF7;border:1px solid #E8E3D8;border-radius:10px;padding:16px;margin:14px 0;}
    .email-article .book-grid,.email-article .signal{display:block;}
    .email-article .book-card .name,.email-article .signal .t{font-weight:700;color:#0D2E20;}
    .email-article .book-card .idea,.email-article .signal .d,.email-article .src{font-size:14px;line-height:1.7;color:#6B6860;}
    .email-article .split-row{display:block;border-bottom:1px solid #EFEAE0;padding:12px 0;}
    .email-article .split-row div{padding:4px 0;}
    .email-article .head,.email-article .label{font-weight:700;color:#0D2E20;}
    .email-article .big-quote{padding:34px 0;text-align:center;background:#F5EBE5;}
    .email-article .choice-section,.email-article .cta,.email-article .subscribe-cta{padding:30px 0;text-align:center;border-bottom:1px solid #EFEAE0;}
    .email-article .choice-btn{display:block;background:#FAFAF7;border:1px solid #E8E3D8;border-radius:10px;padding:14px;margin:10px 0;text-align:left;}
    .email-article .choice-btn .emoji{font-size:24px;}
    .email-article .choice-btn .label{font-weight:700;}
    .email-article .choice-btn .desc{font-size:14px;color:#6B6860;line-height:1.6;}
    .email-article .result-card,.email-article .share-row{display:none!important;}
    .email-article .cta-btn,.email-article .subscribe-btn{display:inline-block;background:#C06A3A;color:#fff!important;text-decoration:none;padding:10px 20px;border-radius:999px;font-weight:700;}
    .email-article .subscribe-cta{background:#0D2E20;color:#fff;padding-left:18px;padding-right:18px;}
    .email-article .subscribe-cta h2,.email-article .subscribe-cta p{color:#fff;}
    .email-article footer{text-align:center;padding:28px 0 0;}
    .email-article footer img{height:40px;opacity:.55;}
    .email-article .fade-in{opacity:1!important;transform:none!important;}
    @media(max-width:640px){.email-wrap{padding:0}.email-shell{border-radius:0;border-left:0;border-right:0}.email-head,.email-article{padding-left:18px;padding-right:18px}.email-article h1{font-size:25px}.email-article h2{font-size:21px}.email-article p{font-size:16px}}
  `;
}

function emailHtml(articles) {
  const articleBlocks = articles.map((article) => `
    <div class="email-head">
      <p class="email-kicker">MNHSU FULL ARTICLE</p>
      <h1>${htmlEscape(article.title)}</h1>
      ${article.description ? `<p class="email-desc">${htmlEscape(article.description)}</p>` : ''}
      <a class="email-link" href="${htmlEscape(article.url)}">${htmlEscape(article.url)}</a>
    </div>
    <div class="email-article">
      ${article.bodyHtml}
    </div>
  `).join('<hr style="border:0;border-top:8px solid #FAFAF7;margin:0;">');

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${emailCss()}</style>
  </head>
  <body>
    <div class="email-wrap">
      <div class="email-shell">
        ${articleBlocks}
      </div>
    </div>
  </body>
  </html>`;
}

async function sendEmail(articles) {
  const subject = articles.length === 1
    ? `mnhsu.xyz 新文章全文：${articles[0].title}`
    : `mnhsu.xyz 有 ${articles.length} 篇新文章全文`;

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
