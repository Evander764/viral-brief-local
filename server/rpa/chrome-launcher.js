/**
 * Chrome 进程管理器。
 *
 * 自动启动一个带有 --remote-debugging-port 的独立 Chrome 实例，
 * 并等待端口就绪后返回。使用独立的 user-data-dir 避免干扰用户日常浏览器。
 *
 * 关键改进：
 * - 支持多路径查找 Chrome（Chrome / Chrome Canary / Chromium）
 * - `isPortReady` 真正校验 JSON 响应（避免 "Using unsafe..." 类似非 JSON 被当作 ready）
 * - 更清晰的错误信息帮助用户排查
 */
import { exec, execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { log } from '../lib/log.js';
import { CHROME_PROFILE_DIR } from '../lib/paths.js';

const DEFAULT_PORT = 9222;

/** macOS 上可能的 Chrome 安装路径（按优先级排列）。 */
const CHROME_PATHS_MAC = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/**
 * 查找本机可用的 Chrome 路径。
 * @returns {string|null}
 */
function findChromePath() {
  if (process.platform === 'darwin') {
    for (const p of CHROME_PATHS_MAC) {
      if (existsSync(p)) return p;
    }
  }
  // Linux 兜底
  if (process.platform === 'linux') {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
      try {
        const result = execSync(`which ${cmd}`, { encoding: 'utf8', timeout: 3000 }).trim();
        if (result) return result;
      } catch { /* not found, try next */ }
    }
  }
  return null;
}

/**
 * 检查指定端口是否已有进程占用（用于清理残留 Chrome 进程）。
 * @returns {boolean}
 */
function isPortInUse(port) {
  try {
    const result = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
    return !!result;
  } catch {
    return false;
  }
}

/**
 * 启动一个带有远程调试端口的 Chrome 实例。
 * @param {object} opts
 * @param {number} [opts.port=9222] 调试端口
 * @param {string} [opts.dataDir] Chrome user-data-dir 路径
 * @param {number} [opts.waitMs=15000] 等待端口就绪的超时（毫秒）
 * @returns {Promise<{child: ChildProcess|null, port: number}>}
 */
export async function launchChrome({ port = DEFAULT_PORT, dataDir, waitMs = 15000 } = {}) {
  // 先检查端口是否已经可用（用户可能已经手动启动了 Chrome）
  if (await isPortReady(port)) {
    log.info(`Chrome 调试端口 ${port} 已就绪（外部启动），跳过启动。`);
    return { child: null, port };
  }

  const userDataDir = dataDir || CHROME_PROFILE_DIR;
  mkdirSync(userDataDir, { recursive: true });

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      '未找到 Chrome/Chromium 浏览器。请安装 Google Chrome 后重试。\n' +
      '预期路径（macOS）：/Applications/Google Chrome.app'
    );
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ].join(' ');

  const cmd = `"${chromePath}" ${args}`;
  log.info(`启动 RPA Chrome: port=${port}, path=${chromePath}`);

  const child = exec(cmd);
  // 收集 stderr 用于诊断（限制大小避免内存泄漏）
  let stderrBuf = '';
  child.stderr?.on('data', (chunk) => {
    if (stderrBuf.length < 2000) stderrBuf += chunk;
  });
  child.on('error', (err) => log.warn(`Chrome 进程错误: ${err.message}`));

  // 等待调试端口就绪
  const ready = await waitForPort(port, waitMs);
  if (!ready) {
    killChrome(child);
    const hint = stderrBuf ? `\nChrome stderr: ${stderrBuf.slice(0, 500)}` : '';
    throw new Error(
      `Chrome 启动超时（等待 ${waitMs}ms 仍未在端口 ${port} 就绪）。\n` +
      `请确保 Google Chrome 已安装且未被其他调试进程占用。${hint}`
    );
  }

  log.info(`Chrome 已就绪，调试端口 ${port}`);
  return { child, port };
}

/**
 * 轮询检查调试端口是否就绪。
 */
export async function waitForPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortReady(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * 检查 Chrome 调试端口是否已就绪。
 * 不只是检查端口能连上，而是校验 /json/version 返回有效 JSON。
 * 这避免了 Chrome 端口已监听但调试接口未完全初始化的误判。
 */
async function isPortReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;

    // 必须校验返回内容是有效 JSON，避免 Chrome 返回警告文本被误认为 ready
    const text = await res.text();
    if (!text || !text.trim()) return false;
    const trimmed = text.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return false;

    // 进一步验证是合法 JSON
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安全关闭 Chrome 子进程。
 */
export function killChrome(child) {
  if (!child) return;
  try {
    child.kill('SIGTERM');
    // 给 2 秒优雅退出，之后强杀
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 2000);
  } catch { /* already dead */ }
}
