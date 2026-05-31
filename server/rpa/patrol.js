/**
 * RPA 巡检模块 —— 控制浏览器逐账号采集最新内容的数据。
 *
 * 设计为纯函数模块：
 * - 接受一个已连接的 CDPClient 实例（不自己管生命周期）
 * - 返回结构化的采集结果（不直接打日志）
 * - 每条内容自动截图存档
 *
 * 被 pipeline.js 在日报生成时调用——先采集，后分析。
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { all } from '../db.js';
import { upsertCapture } from '../store.js';
import { SCREENSHOTS_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { deriveMetrics } from '../../extension/extract-core.js';

/**
 * 对所有开启了 monitor_enabled 的账号执行巡检。
 *
 * @param {import('./cdp.js').CDPClient} client 已连接的 CDP 客户端
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.onProgress] 进度回调
 * @returns {Promise<PatrolResult>}
 *
 * @typedef {object} PatrolResult
 * @property {number} total 总账号数
 * @property {number} success 成功采集的账号数
 * @property {number} failed 失败的账号数
 * @property {number} newItems 新入库的内容数
 * @property {number} duplicates 去重跳过的内容数
 * @property {AccountResult[]} details 每个账号的详情
 *
 * @typedef {object} AccountResult
 * @property {string} accountId
 * @property {string} nickname
 * @property {string} platform
 * @property {'ok'|'error'|'skipped'} status
 * @property {string} [error]
 * @property {CapturedItem|null} item
 *
 * @typedef {object} CapturedItem
 * @property {string} id 入库后的 content id
 * @property {string} url
 * @property {string} title
 * @property {boolean} duplicate
 * @property {string} dataStatus
 * @property {string|null} screenshotPath
 */
export async function runPatrol(client, opts = {}) {
  const { onProgress } = opts;
  const progress = (msg) => {
    log.info(`[RPA] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  const accounts = all('SELECT * FROM accounts WHERE monitor_enabled = 1');
  progress(`共 ${accounts.length} 个账号需要巡检`);

  const result = {
    total: accounts.length,
    success: 0,
    failed: 0,
    newItems: 0,
    duplicates: 0,
    details: [],
  };

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    progress(`(${i + 1}/${accounts.length}) 正在巡检: [${acc.platform}] ${acc.nickname}`);

    if (!acc.homepage_url) {
      result.details.push({
        accountId: acc.id, nickname: acc.nickname, platform: acc.platform,
        status: 'skipped', error: '无主页链接', item: null,
      });
      continue;
    }

    try {
      let item;
      if (acc.platform === 'douyin') {
        item = await patrolDouyin(client, acc, progress);
      } else if (acc.platform === 'xiaohongshu') {
        item = await patrolXiaohongshu(client, acc, progress);
      } else {
        result.details.push({
          accountId: acc.id, nickname: acc.nickname, platform: acc.platform,
          status: 'skipped', error: `暂不支持平台: ${acc.platform}`, item: null,
        });
        continue;
      }

      result.success++;
      if (item) {
        if (item.duplicate) result.duplicates++;
        else result.newItems++;
      }
      result.details.push({
        accountId: acc.id, nickname: acc.nickname, platform: acc.platform,
        status: 'ok', item,
      });
    } catch (e) {
      result.failed++;
      result.details.push({
        accountId: acc.id, nickname: acc.nickname, platform: acc.platform,
        status: 'error', error: e.message, item: null,
      });
      log.warn(`[RPA] 巡检 ${acc.nickname} 失败: ${e.message}`);
    }

    // 模拟人类操作节奏（2~4 秒随机间隔）
    await client.sleep(2000 + Math.random() * 2000);
  }

  progress(`巡检完成: 成功 ${result.success}, 失败 ${result.failed}, 新增 ${result.newItems}, 去重 ${result.duplicates}`);
  return result;
}

// ---------------------------------------------------------------------------
// 平台采集逻辑
// ---------------------------------------------------------------------------

async function patrolDouyin(client, acc, progress) {
  progress(`  打开主页: ${acc.homepage_url}`);
  await client.goto(acc.homepage_url);
  await client.sleep(4000);

  await assertNotBlocked(client, 'douyin');

  // 获取最新视频链接
  const postUrl = (await waitForPostUrls(client, 'douyin'))[0];

  if (!postUrl) {
    progress('  未找到最新视频链接');
    return null;
  }

  progress(`  进入最新视频: ${postUrl}`);
  await client.goto(postUrl);
  await client.sleep(4000);
  await assertNotBlocked(client, 'douyin');

  // 提取数据
  const data = buildCaptureData(await extractPageRaw(client, 'douyin'), 'douyin');
  const finalUrl = isDetailUrl('douyin', data.pageUrl) ? data.pageUrl : postUrl;

  progress(`  抓取到数据: 点赞=${data.like}, 转发=${data.share}`);

  // 截图
  const screenshotPath = await takeScreenshot(client, acc, 'douyin');
  progress(`  已截图: ${screenshotPath}`);

  return saveData(acc, finalUrl, data, screenshotPath);
}

async function patrolXiaohongshu(client, acc, progress) {
  progress(`  打开主页: ${acc.homepage_url}`);
  await client.goto(acc.homepage_url);
  await client.sleep(5000);
  await assertNotBlocked(client, 'xiaohongshu');

  // 获取最新笔记链接
  const postUrls = await waitForPostUrls(client, 'xiaohongshu');

  if (postUrls.length === 0) {
    progress('  未找到最新笔记链接');
    return null;
  }

  progress(`  找到 ${postUrls.length} 个候选笔记，按最新顺序尝试`);
  for (let i = 0; i < Math.min(postUrls.length, 8); i++) {
    const postUrl = postUrls[i];
    progress(`  进入候选笔记 ${i + 1}: ${postUrl}`);
    await client.goto(postUrl);
    await client.sleep(8000);
    await assertNotBlocked(client, 'xiaohongshu');

    const raw = await extractPageRaw(client, 'xiaohongshu');
    const data = buildCaptureData(raw, 'xiaohongshu');
    const finalUrl = isDetailUrl('xiaohongshu', data.pageUrl) ? data.pageUrl : postUrl;

    if (isUnavailablePage(raw) || !hasCaptureSignal(data)) {
      progress(`  候选笔记不可采，跳过: ${data.title || raw.pageUrl || postUrl}`);
      continue;
    }

    progress(`  抓取到数据: 点赞=${data.like}, 转发=${data.share}`);

    const screenshotPath = await takeScreenshot(client, acc, 'xiaohongshu');
    progress(`  已截图: ${screenshotPath}`);

    return saveData(acc, finalUrl, data, screenshotPath);
  }

  progress('  候选笔记均未能打开可采详情');
  return null;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function postLinksScript(platform) {
  return `
    (() => {
      const platform = ${JSON.stringify(platform)};
      const toAbs = (href) => {
        try { return new URL(href, location.href).href; } catch { return null; }
      };
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const isDetail = (url) => {
        if (!url) return false;
        try {
          const u = new URL(url);
          if (platform === 'douyin') return /\\/video\\/[^/?#]+/.test(u.pathname);
          if (platform === 'xiaohongshu') {
            return /\\/explore\\/[^/?#]+/.test(u.pathname) || /\\/discovery\\/item\\/[^/?#]+/.test(u.pathname);
          }
        } catch {}
        return false;
      };
      const out = [];
      const seen = new Set();
      const push = (href) => {
        if (!href || seen.has(href)) return;
        seen.add(href);
        out.push(href);
      };
      const links = [...document.querySelectorAll('a[href]')];
      for (const a of links) {
        const href = toAbs(a.getAttribute('href') || a.href);
        if (isDetail(href) && isVisible(a)) push(href);
      }
      for (const a of links) {
        const href = toAbs(a.getAttribute('href') || a.href);
        if (isDetail(href)) push(href);
      }
      return out;
    })()
  `;
}

async function waitForPostUrls(client, platform, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const urls = await client.evaluate(postLinksScript(platform));
    if (Array.isArray(urls) && urls.length > 0) return urls;
    await client.sleep(700);
  }
  return [];
}

async function assertNotBlocked(client, platform) {
  const state = await client.evaluate(`
    (() => ({
      title: document.title || '',
      url: location.href,
      text: (document.body && document.body.innerText || '').slice(0, 1000),
    }))()
  `);
  const haystack = `${state.title}\n${state.url}\n${state.text}`;
  if (/验证码|安全验证|滑动验证|captcha|verify|登录后查看/.test(haystack)) {
    throw new Error(`${platform === 'douyin' ? '抖音' : '小红书'}页面被登录/验证码拦截，请使用已登录 Chrome 资料目录后重试`);
  }
}

async function extractPageRaw(client, platform) {
  return client.evaluate(`
    (() => {
      const platform = ${JSON.stringify(platform)};
      const textOf = (el) => {
        if (!el) return null;
        return (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim() || null;
      };
      const getText = (selectors) => {
        for (const s of selectors) {
          const el = document.querySelector(s);
          const text = textOf(el);
          if (text) return text;
        }
        return null;
      };
      const meta = (name) => document.querySelector(\`meta[property="\${name}"], meta[name="\${name}"]\`)?.content || '';
      const scripts = [...document.querySelectorAll('script:not([src]), script[type="application/json"]')]
        .map((s) => s.textContent || '')
        .filter((s) => /(digg|share|comment|collect|liked|interact|aweme|note)/i.test(s))
        .slice(0, 12)
        .map((s) => s.slice(0, 250000));
      for (const key of ['__INITIAL_STATE__', '__NUXT__', '__NEXT_DATA__', 'SIGI_STATE']) {
        try {
          const v = window[key];
          if (v) scripts.unshift(JSON.stringify(v).slice(0, 250000));
        } catch {}
      }
      const ariaText = [...document.querySelectorAll('[aria-label], [title]')]
        .map((el) => [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('\\n')
        .slice(0, 30000);
      const bodyText = (document.body?.innerText || '').slice(0, 50000);
      const common = {
        dataBlobs: scripts,
        textSample: [bodyText, ariaText].filter(Boolean).join('\\n'),
        pageUrl: location.href,
      };
      if (platform === 'douyin') {
        return {
          ...common,
          domTexts: {
            like: getText(['[data-e2e="video-player-digg"]', '[data-e2e="digg-count"]', '.like-cnt', '[aria-label*="点赞"]']),
            share: getText(['[data-e2e="video-player-share"]', '[data-e2e="share-count"]', '.share-cnt', '[aria-label*="分享"]', '[aria-label*="转发"]']),
            comment: getText(['[data-e2e="comment-count"]', '.comment-cnt', '[aria-label*="评论"]']),
            favorite: getText(['[data-e2e*="collect"]', '[aria-label*="收藏"]']),
          },
          title: getText(['h1.video-title', '[data-e2e="video-desc"]', 'h1']) || meta('og:title') || document.title,
          pubTime: getText(['span[data-e2e="video-author-publishtime"]', '.video-publish-time', 'time']) || document.querySelector('time')?.dateTime || null,
          contentType: 'video',
        };
      }
      return {
        ...common,
        domTexts: {
          like: getText(['.interact-container .like-wrapper .count', '[class*="like-wrapper"] .count', '[class*="like"] [class*="count"]', '[aria-label*="点赞"]']),
          share: getText(['.interact-container .share-wrapper .count', '[class*="share-wrapper"] .count', '[class*="share"] [class*="count"]', '[aria-label*="分享"]', '[aria-label*="转发"]']),
          comment: getText(['.interact-container .chat-wrapper .count', '[class*="comment-wrapper"] .count', '[class*="comment"] [class*="count"]', '[aria-label*="评论"]']),
          favorite: getText(['.interact-container .collect-wrapper .count', '[class*="collect-wrapper"] .count', '[class*="collect"] [class*="count"]', '[aria-label*="收藏"]']),
        },
        title: getText(['#detail-title', '.note-title', '[class*="title"]', 'h1']) || meta('og:title') || document.title,
        pubTime: getText(['.bottom-container .date', '.note-publish-date', '[class*="date"]', 'time']) || document.querySelector('time')?.dateTime || null,
        contentType: 'article',
      };
    })()
  `);
}

function buildCaptureData(raw, platform) {
  const metrics = deriveMetrics(raw);
  return {
    ...metrics,
    title: cleanupTitle(raw.title, platform),
    pubTime: raw.pubTime,
    pageUrl: raw.pageUrl,
    contentType: raw.contentType,
  };
}

function isDetailUrl(platform, url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (platform === 'douyin') return /\/video\/[^/?#]+/.test(u.pathname);
    if (platform === 'xiaohongshu') {
      return /\/explore\/[^/?#]+/.test(u.pathname) || /\/discovery\/item\/[^/?#]+/.test(u.pathname);
    }
  } catch {
    return false;
  }
  return false;
}

function isUnavailablePage(raw = {}) {
  const text = `${raw.title || ''}\n${raw.pageUrl || ''}\n${raw.textSample || ''}`;
  return /页面不见了|暂时无法浏览|error_code=|\/404\b|404/.test(text)
    || ((raw.pageUrl || '').endsWith('/explore') && /小红书\s*-\s*你的生活兴趣社区/.test(raw.title || ''));
}

function hasCaptureSignal(data = {}) {
  return Boolean(
    data.title && data.title !== '小红书 - 你的生活兴趣社区'
    && (data.like !== null || data.share !== null || data.comment !== null || data.favorite !== null)
  );
}

function cleanupTitle(title, platform) {
  const s = String(title || '').trim();
  if (!s) return '';
  if (platform === 'xiaohongshu') return s.replace(/\s*-\s*小红书\s*$/, '').trim();
  if (platform === 'douyin') return s.replace(/\s*-\s*抖音\s*$/, '').trim();
  return s;
}

/**
 * 截图并保存到 data/screenshots/。
 * @returns {string} 相对路径（存入 DB 的 screenshot_path）
 */
async function takeScreenshot(client, acc, platform) {
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const filename = `rpa_${platform}_${acc.nickname}_${Date.now()}.png`;
    const filepath = join(SCREENSHOTS_DIR, filename);
    const buf = await client.screenshot();
    writeFileSync(filepath, buf);
    return `screenshots/${filename}`;
  } catch (e) {
    log.warn(`[RPA] 截图失败: ${e.message}`);
    return null;
  }
}

/**
 * 将采集到的数据通过 upsertCapture 入库。
 * @returns {CapturedItem}
 */
function saveData(acc, url, data, screenshotPath) {
  const payload = {
    platform: acc.platform,
    account_id: acc.id,
    author_name: acc.nickname,
    url: url,
    title: data.title || '无标题',
    content_type: data.contentType || 'video',
    metrics_raw: {
      like: data.like,
      share: data.share,
      comment: data.comment,
      favorite: data.favorite,
    },
    publish_time: parseHumanTime(data.pubTime),
    metrics_source: 'rpa',
    screenshot_path: screenshotPath,
  };

  const res = upsertCapture(payload);

  return {
    id: res.id,
    url,
    title: data.title || '无标题',
    duplicate: !!res.duplicate,
    dataStatus: res.status || res.reason || 'unknown',
    screenshotPath,
  };
}

/**
 * 尽力解析人类可读的时间表达（"刚刚"、"3小时前"、"昨天"、"05-12"、ISO 格式等）。
 */
function parseHumanTime(str) {
  if (!str) return null;
  const now = new Date();

  if (str.includes('刚刚')) return now.toISOString();

  const minMatch = str.match(/(\d+)\s*分钟前/);
  if (minMatch) return new Date(now.getTime() - Number(minMatch[1]) * 60000).toISOString();

  const hrMatch = str.match(/(\d+)\s*小时前/);
  if (hrMatch) return new Date(now.getTime() - Number(hrMatch[1]) * 3600000).toISOString();

  const dayMatch = str.match(/(\d+)\s*天前/);
  if (dayMatch) return new Date(now.getTime() - Number(dayMatch[1]) * 86400000).toISOString();

  if (str.includes('昨天')) return new Date(now.getTime() - 86400000).toISOString();

  // "10-21" -> "2026-10-21"
  if (/^\d{2}-\d{2}$/.test(str)) {
    return new Date(`${now.getFullYear()}-${str}`).toISOString();
  }

  // 兜底尝试原生解析
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) return d.toISOString();

  return null;
}

// 如果是直接运行该脚本，则自动执行（向后兼容）
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { CDPClient } = await import('./cdp.js');
  const { launchChrome, killChrome } = await import('./chrome-launcher.js');
  const chrome = await launchChrome({ port: 9222, waitMs: 15000 });
  const client = new CDPClient();
  try {
    await client.connect(chrome.port);
    const result = await runPatrol(client, { onProgress: console.log });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.close();
    if (chrome.closeOnDone && chrome.child) killChrome(chrome.child);
  }
}
