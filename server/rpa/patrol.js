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
import { randomUUID } from 'node:crypto';
import { all } from '../db.js';
import { upsertCapture } from '../store.js';
import { SCREENSHOTS_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';

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
  await client.sleep(3000);

  // 获取最新视频链接
  const postUrl = await client.evaluate(`
    (() => {
      // 抖音主页：寻找视频链接
      const links = document.querySelectorAll('a[href*="/video/"]');
      for (const a of links) {
        const href = a.href || a.getAttribute('href');
        if (href && href.includes('/video/')) return a.href || (location.origin + href);
      }
      return null;
    })()
  `);

  if (!postUrl) {
    progress('  未找到最新视频链接');
    return null;
  }

  progress(`  进入最新视频: ${postUrl}`);
  await client.goto(postUrl);
  await client.sleep(4000);

  // 提取数据
  const data = await client.evaluate(`
    (() => {
      const getText = (selectors) => {
        for (const s of selectors) {
          const el = document.querySelector(s);
          if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
        }
        return null;
      };

      return {
        like: getText([
          '[data-e2e="video-player-digg"]',
          '[data-e2e="digg-count"]',
          '.like-cnt',
        ]),
        share: getText([
          '[data-e2e="video-player-share"]',
          '[data-e2e="share-count"]',
          '.share-cnt',
        ]),
        comment: getText([
          '[data-e2e="comment-count"]',
          '.comment-cnt',
        ]),
        pubTime: getText([
          'span[data-e2e="video-author-publishtime"]',
          '.video-publish-time',
        ]),
        title: getText([
          'h1.video-title',
          '[data-e2e="video-desc"]',
          'h1',
        ]),
        pageUrl: window.location.href,
      };
    })()
  `);

  progress(`  抓取到数据: 点赞=${data.like}, 转发=${data.share}`);

  // 截图
  const screenshotPath = await takeScreenshot(client, acc, 'douyin');
  progress(`  已截图: ${screenshotPath}`);

  return saveData(acc, data.pageUrl || postUrl, data, screenshotPath);
}

async function patrolXiaohongshu(client, acc, progress) {
  progress(`  打开主页: ${acc.homepage_url}`);
  await client.goto(acc.homepage_url);
  await client.sleep(4000);

  // 获取最新笔记链接
  const postUrl = await client.evaluate(`
    (() => {
      // 小红书主页：寻找笔记链接
      const links = document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]');
      for (const a of links) {
        const href = a.href || a.getAttribute('href');
        if (href) return a.href || (location.origin + href);
      }
      // 备用：找 section 里的第一个链接
      const section = document.querySelector('[class*="note-list"], [class*="user-note"]');
      if (section) {
        const a = section.querySelector('a');
        if (a) return a.href;
      }
      return null;
    })()
  `);

  if (!postUrl) {
    progress('  未找到最新笔记链接');
    return null;
  }

  progress(`  进入最新笔记: ${postUrl}`);
  await client.goto(postUrl);
  await client.sleep(3000);

  const data = await client.evaluate(`
    (() => {
      const getText = (selectors) => {
        for (const s of selectors) {
          const el = document.querySelector(s);
          if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
        }
        return null;
      };

      return {
        like: getText([
          '.interact-container .like-wrapper .count',
          '[class*="like"] [class*="count"]',
          'span.like-count',
        ]),
        share: getText([
          '.interact-container .share-wrapper .count',
          '[class*="share"] [class*="count"]',
        ]),
        comment: getText([
          '.interact-container .chat-wrapper .count',
          '[class*="comment"] [class*="count"]',
        ]),
        favorite: getText([
          '.interact-container .collect-wrapper .count',
          '[class*="collect"] [class*="count"]',
        ]),
        pubTime: getText([
          '.bottom-container .date',
          '.note-publish-date',
          '[class*="date"]',
        ]),
        title: getText([
          '#detail-title',
          '.note-title',
          'h1',
        ]),
        pageUrl: window.location.href,
      };
    })()
  `);

  progress(`  抓取到数据: 点赞=${data.like}, 转发=${data.share}`);

  const screenshotPath = await takeScreenshot(client, acc, 'xiaohongshu');
  progress(`  已截图: ${screenshotPath}`);

  return saveData(acc, data.pageUrl || postUrl, data, screenshotPath);
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

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
    content_type: 'video',
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
if (import.meta.url === `file://${process.argv[1]}`) {
  const { CDPClient } = await import('./cdp.js');
  const client = new CDPClient();
  await client.connect(9222);
  const result = await runPatrol(client, { onProgress: console.log });
  console.log(JSON.stringify(result, null, 2));
  client.close();
}
