/**
 * 本地服务入口。
 *  - 监听 127.0.0.1（绝不对外暴露）。
 *  - 托管浏览器仪表盘（桌面端 UI）。
 *  - 提供 /api/capture 给浏览器插件。
 *  - 启动自动调度器：接入 API Key + 开启调度后，每天自动产出日报。
 *
 * 安全：所有 /api/*（除 /api/health）都需要配对 token；仪表盘从本地服务
 * 注入 token，插件由用户手动粘贴 token。可防普通网页 CSRF / 越权调用。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync, existsSync, createReadStream, statSync, unlinkSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { CDPClient } from './rpa/cdp.js';
import { runPatrol } from './rpa/patrol.js';
import { launchChrome, killChrome } from './rpa/chrome-launcher.js';

import { WEB_DIR, SCREENSHOTS_DIR, ensureDirs } from './lib/paths.js';
import { log } from './lib/log.js';
import {
  loadConfig, getPublicConfig, saveConfig, setApiKey, clearApiKey, hasApiKey,
  setApiKey2, clearApiKey2, regeneratePairingToken,
} from './config.js';
import {
  upsertCapture, confirmContent, archiveContent, deleteContent, getContent, listContents,
  countsByStatus, listAccounts, upsertAccount, deleteAccount, importAccountsCsv, importAccountsLines,
  listReports, getReport, deleteReport, getUsageForDay, getAnalysis,
} from './store.js';
import { runDailyReport } from './pipeline.js';
import { startScheduler, restartScheduler } from './scheduler.js';
import { testConnection } from './ai/client.js';
import { analyzeContent, suggestAccountsFromAI } from './ai/analyze.js';


ensureDirs();
const cfg = loadConfig();
const PORT = Number(process.env.VB_PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  return JSON.parse(b.toString('utf8'));
}

function tokenOf(req, url) {
  return req.headers['x-vb-token'] || url.searchParams.get('token');
}

function saveScreenshot(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = join(SCREENSHOTS_DIR, `${randomUUID()}.${ext}`);
  writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

async function serveStatic(res, filePath, { inline = true, downloadName } = {}) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const headers = { 'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream' };
  if (!inline) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(downloadName || basename(filePath))}"`;
  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

function removeReportFiles(report) {
  for (const p of [
    report.export_md_path, report.export_html_path, report.export_csv_path, report.export_zip_path,
  ]) {
    if (!p) continue;
    try { if (existsSync(p)) unlinkSync(p); } catch (e) { log.warn(`删除日报文件失败：${p} ${e.message}`); }
  }
}

async function serveIndex(res) {
  let html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
  html = html.replace(/%%VB_TOKEN%%/g, cfg.pairingToken).replace(/%%VB_PORT%%/g, String(PORT));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ---------------------------------------------------------------- dispatch ----

async function handleApi(req, res, url, segs) {
  const method = req.method;
  const p = segs.slice(1); // 去掉 'api'

  // health 不需要 token，供插件探测桌面端是否在运行
  if (p[0] === 'health') {
    return sendJson(res, 200, { ok: true, app: 'viral-brief-local', version: '1.0.0', hasApiKey: hasApiKey() });
  }

  // 鉴权
  if (tokenOf(req, url) !== cfg.pairingToken) {
    return sendJson(res, 401, { error: '配对 token 无效或缺失' });
  }

  // ---- capture（插件入口）----
  if (p[0] === 'capture' && method === 'POST') {
    const payload = await readJson(req);
    if (payload.screenshot) {
      const sp = saveScreenshot(payload.screenshot);
      if (sp) payload.screenshot_path = sp;
      delete payload.screenshot;
    }
    const r = upsertCapture(payload);
    return sendJson(res, 200, r);
  }

  // ---- stats ----
  if (p[0] === 'stats' && method === 'GET') {
    return sendJson(res, 200, {
      counts: countsByStatus(),
      usage: getUsageForDay(),
      schedule: cfg.schedule,
      hasApiKey: hasApiKey(),
    });
  }

  // ---- settings ----
  if (p[0] === 'settings') {
    if (p.length === 1 && method === 'GET') return sendJson(res, 200, getPublicConfig());
    if (p.length === 1 && method === 'PUT') {
      const body = await readJson(req);
      const pub = saveConfig(body);
      restartScheduler();
      return sendJson(res, 200, pub);
    }
    if (p[1] === 'apikey' && method === 'POST') {
      const { apiKey } = await readJson(req);
      setApiKey(apiKey);
      return sendJson(res, 200, getPublicConfig());
    }
    if (p[1] === 'apikey' && method === 'DELETE') {
      clearApiKey();
      return sendJson(res, 200, getPublicConfig());
    }
    if (p[1] === 'apikey2' && method === 'POST') {
      const { apiKey } = await readJson(req);
      setApiKey2(apiKey);
      return sendJson(res, 200, getPublicConfig());
    }
    if (p[1] === 'apikey2' && method === 'DELETE') {
      clearApiKey2();
      return sendJson(res, 200, getPublicConfig());
    }
  }

  // ---- rpa patrol ----
  if (p[0] === 'patrol' && p[1] === 'run' && method === 'POST') {
    let chromeChild = null;
    let client = null;
    try {
      const chrome = await launchChrome({ port: 9222, waitMs: 15000 });
      chromeChild = chrome.child;
      client = new CDPClient();
      await client.connect(chrome.port);
      const result = await runPatrol(client);
      return sendJson(res, 200, { success: true, ...result });
    } catch (e) {
      log.error('巡检失败: ' + e.message);
      // 对常见错误给出更友好的前端提示
      let userMsg = e.message;
      if (e.message.includes('未找到 Chrome')) {
        userMsg = '未找到 Chrome 浏览器。请安装 Google Chrome 后重试。';
      } else if (e.message.includes('启动超时')) {
        userMsg = 'Chrome 启动超时。请关闭所有 Chrome 窗口后重试，或手动运行: npm run rpa:chrome';
      }
      return sendJson(res, 500, { error: userMsg });
    } finally {
      if (client) client.close();
      if (chromeChild) killChrome(chromeChild);
    }
  }

  // ---- settings - additional ----
  if (p[0] === 'settings') {
    if (p[1] === 'test' && method === 'POST') {
      const body = await readJson(req);
      const r = await testConnection(body);
      return sendJson(res, 200, r);
    }
    if (p[1] === 'pairing' && p[2] === 'regenerate' && method === 'POST') {
      const t = regeneratePairingToken();
      return sendJson(res, 200, { pairingToken: t });
    }
  }

  // ---- contents ----
  if (p[0] === 'contents') {
    if (p.length === 1 && method === 'GET') {
      return sendJson(res, 200, listContents({
        status: url.searchParams.get('status') || undefined,
        platform: url.searchParams.get('platform') || undefined,
        window: url.searchParams.get('window') || undefined,
        q: url.searchParams.get('q') || undefined,
      }));
    }
    const id = p[1];
    if (id && p.length === 2 && method === 'GET') {
      const c = getContent(id);
      return c ? sendJson(res, 200, { ...c, analysis: getAnalysis(id) }) : sendJson(res, 404, { error: '未找到' });
    }
    if (id && p[2] === 'confirm' && method === 'POST') {
      const body = await readJson(req);
      const c = confirmContent(id, body);
      return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: '未找到' });
    }
    if (id && p[2] === 'archive' && method === 'POST') {
      return sendJson(res, 200, archiveContent(id));
    }
    if (id && p[2] === 'analyze' && method === 'POST') {
      const c = getContent(id);
      if (!c) return sendJson(res, 404, { error: '未找到' });
      try {
        const r = await analyzeContent(c, { force: url.searchParams.get('force') === '1' });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 200, { error: String(e.message) });
      }
    }
    if (id && p.length === 2 && method === 'DELETE') {
      deleteContent(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- accounts ----
  if (p[0] === 'accounts') {
    if (p.length === 1 && method === 'GET') return sendJson(res, 200, listAccounts());
    if (p.length === 1 && method === 'POST') return sendJson(res, 200, upsertAccount(await readJson(req)));
    if (p[1] === 'search-suggest' && method === 'POST') {
      const { q } = await readJson(req);
      if (!q || !q.trim()) return sendJson(res, 400, { error: '查询内容不能为空' });
      try {
        const r = await suggestAccountsFromAI(q);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 500, { error: String(e.message) });
      }
    }
    if (p[1] === 'import' && method === 'POST') {
      const { csv } = await readJson(req);
      return sendJson(res, 200, importAccountsCsv(csv || ''));
    }
    if (p[1] === 'import-lines' && method === 'POST') {
      const { text } = await readJson(req);
      return sendJson(res, 200, importAccountsLines(text || ''));
    }
    if (p[1] && method === 'DELETE') { deleteAccount(p[1]); return sendJson(res, 200, { ok: true }); }
  }

  // ---- reports ----
  if (p[0] === 'reports') {
    if (p.length === 1 && method === 'GET') return sendJson(res, 200, listReports());
    if (p[1] === 'generate' && method === 'POST') {
      const body = await readJson(req);
      try {
        const r = await runDailyReport({
          windowType: body.window || cfg.schedule.window,
          force: !!body.force,
          skipRpa: body.skipRpa === true,
        });
        return sendJson(res, 200, {
          id: r.report.id,
          eligibleCount: r.eligibleCount,
          aiUsed: r.aiUsed,
          patrolResult: r.patrolResult || null,
          rpaError: r.rpaError || null,
        });
      } catch (e) {
        return sendJson(res, 200, { error: String(e.message || e) });
      }
    }
    const id = p[1];
    if (id && p.length === 2 && method === 'GET') {
      const r = getReport(id);
      return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: '未找到' });
    }
    if (id && p.length === 2 && method === 'DELETE') {
      const r = deleteReport(id);
      if (!r) return sendJson(res, 404, { error: '未找到' });
      removeReportFiles(r);
      return sendJson(res, 200, { ok: true });
    }
    if (id && p[2] === 'export' && method === 'GET') {
      const r = getReport(id);
      if (!r) return sendJson(res, 404, { error: '未找到' });
      const fmt = url.searchParams.get('format') || 'md';
      const path = fmt === 'html' ? r.export_html_path
        : fmt === 'csv' ? r.export_csv_path
          : fmt === 'zip' ? r.export_zip_path
            : r.export_md_path;
      if (!path) return sendJson(res, 404, { error: '导出文件不存在' });
      const inline = url.searchParams.get('inline') === '1';
      return serveStatic(res, path, { inline, downloadName: basename(path) });
    }
  }

  return sendJson(res, 404, { error: '未知接口' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const segs = url.pathname.split('/').filter(Boolean);

  // CORS（主要给浏览器插件跨源访问 /api/capture）
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-vb-token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (segs[0] === 'api') return await handleApi(req, res, url, segs);

    // 静态：截图
    if (segs[0] === 'screenshots' && segs[1]) {
      return serveStatic(res, join(SCREENSHOTS_DIR, basename(segs[1])));
    }
    // 静态：仪表盘
    if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const staticFile = join(WEB_DIR, basename(url.pathname));
    if (existsSync(staticFile)) return serveStatic(res, staticFile);

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    log.error('请求处理出错：', e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const urlStr = `http://127.0.0.1:${PORT}`;
  log.info(`爆款选题雷达 Local 已启动：${urlStr}`);
  log.info(`API Key：${hasApiKey() ? '已配置' : '未配置（请在仪表盘「设置」里填写）'}`);
  startScheduler();
  if ((process.env.VB_OPEN_BROWSER ?? 'true') !== 'false') {
    // 用 execFile + 参数数组，避免 shell 字符串拼接（更安全、无弃用告警）。
    try {
      if (process.platform === 'darwin') execFile('open', [urlStr], () => {});
      else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', urlStr], () => {});
      else execFile('xdg-open', [urlStr], () => {});
    } catch { /* 打不开浏览器不影响服务 */ }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log.error(`端口 ${PORT} 已被占用。可设置环境变量 VB_PORT 换一个端口后重试。`);
  else log.error('服务器错误：', e);
  process.exit(1);
});
