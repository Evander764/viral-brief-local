/**
 * 配置中心。负责 config.json 的读写，以及 API Key 的加密存取与脱敏。
 * 桌面端保存 Key，浏览器插件绝不保存（文档 6.3）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CONFIG_PATH } from './lib/paths.js';
import { encryptSecret, decryptSecret } from './lib/secret.js';
import { addRedaction, clearRedaction } from './lib/log.js';

const DEFAULTS = {
  provider: 'openai',          // 'openai' | 'openai-compatible' | 'anthropic'
  baseUrl: '',                 // 留空则用 provider 默认地址
  model: 'gpt-4o-mini',        // 默认便宜模型，用户可改
  reportModel: '',             // 日报可单独配更强模型；留空则与 model 相同
  temperature: 0.3,
  timeoutMs: 60000,
  retries: 2,
  budgetDailyTokens: 0,        // 0 = 不限制，仅记录用量
  schedule: { enabled: false, time: '09:00', window: 'last_3_days', catchUp: true },
  pairingToken: '',
  apiKeyEnc: null,
};

let cache = null;

function readRaw() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeRaw(obj) {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function refreshRedaction() {
  clearRedaction();
  const k = getApiKey();
  if (k) addRedaction(k);
}

export function loadConfig() {
  if (cache) return cache;
  const raw = readRaw();
  const cfg = {
    ...DEFAULTS,
    ...raw,
    schedule: { ...DEFAULTS.schedule, ...(raw.schedule || {}) },
  };
  let changed = false;
  if (!cfg.pairingToken) { cfg.pairingToken = randomBytes(24).toString('hex'); changed = true; }
  cache = cfg;
  if (changed) writeRaw(cfg);
  refreshRedaction();
  return cfg;
}

export function saveConfig(patch = {}) {
  const cfg = loadConfig();
  const { apiKeyEnc, apiKey, pairingToken, ...safe } = patch; // 这些字段有专用入口，禁止经此写入
  Object.assign(cfg, safe);
  if (patch.schedule) cfg.schedule = { ...cfg.schedule, ...patch.schedule };
  writeRaw(cfg);
  return getPublicConfig();
}

export function getApiKey() {
  const cfg = cache || readMerged();
  return decryptSecret(cfg.apiKeyEnc);
}
// 仅供 getApiKey 在 cache 未建立时使用，避免与 loadConfig 的 refreshRedaction 互相递归
function readMerged() {
  const raw = readRaw();
  return { ...DEFAULTS, ...raw, schedule: { ...DEFAULTS.schedule, ...(raw.schedule || {}) } };
}

export function setApiKey(plain) {
  const cfg = loadConfig();
  cfg.apiKeyEnc = encryptSecret(plain);
  writeRaw(cfg);
  refreshRedaction();
}
export function clearApiKey() { setApiKey(null); }
export function hasApiKey() { return !!getApiKey(); }

export function regeneratePairingToken() {
  const cfg = loadConfig();
  cfg.pairingToken = randomBytes(24).toString('hex');
  writeRaw(cfg);
  return cfg.pairingToken;
}

/** 对外暴露的配置：绝不含 apiKeyEnc / 明文 Key，只给末 4 位用于展示。 */
export function getPublicConfig() {
  const cfg = loadConfig();
  const key = getApiKey();
  const { apiKeyEnc, ...rest } = cfg;
  return { ...rest, hasApiKey: !!key, apiKeyLast4: key ? key.slice(-4) : null };
}

/** 解析有效的 base URL（按 provider 给默认值）。 */
export function effectiveBaseUrl() {
  const cfg = loadConfig();
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/$/, '');
  if (cfg.provider === 'anthropic') return 'https://api.anthropic.com';
  return 'https://api.openai.com/v1';
}
