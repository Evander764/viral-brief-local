import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VB_DATA_DIR = mkdtempSync(join(tmpdir(), 'vb-config-'));

const {
  loadConfig, saveConfig, setApiKey, getApiKey, clearApiKey, hasApiKey,
  setApiKey2, getApiKey2, getPublicConfig, effectiveBaseUrl,
} = await import('../server/config.js');
const { redact } = await import('../server/lib/log.js');

test('默认配置：openai + 自动生成配对 token', () => {
  const c = loadConfig();
  assert.ok(c.pairingToken && c.pairingToken.length >= 24);
  assert.equal(getPublicConfig().hasApiKey, false);
});

test('API Key 加密往返：存进去能解出来', () => {
  setApiKey('sk-test-1234567890abcdef');
  assert.equal(getApiKey(), 'sk-test-1234567890abcdef');
  assert.equal(hasApiKey(), true);
});

test('getPublicConfig 绝不泄露明文 Key，只给末 4 位', () => {
  setApiKey('sk-secret-keyEND9999');
  const pub = getPublicConfig();
  assert.equal(pub.apiKeyLast4, '9999');
  assert.equal(pub.hasApiKey, true);
  // 整个公开对象里不能出现明文或密文字段
  const s = JSON.stringify(pub);
  assert.doesNotMatch(s, /sk-secret-keyEND9999/);
  assert.equal('apiKeyEnc' in pub, false);
});

test('日志脱敏：注册的 Key 在日志里被替换', () => {
  setApiKey('sk-redact-me-7777777777');
  loadConfig.cache = null; // 触发 refreshRedaction（loadConfig 内部会调用）
  // setApiKey 已调用 refreshRedaction，这里直接验证
  const line = redact('调用失败，key=sk-redact-me-7777777777 末尾');
  assert.doesNotMatch(line, /sk-redact-me-7777777777/);
  assert.match(line, /REDACTED/);
});

test('provider 自动推断：DeepSeek 兼容接口 → openai-compatible', () => {
  saveConfig({ baseUrl: 'https://api.deepseek.com' });
  setApiKey('sk-deepseekkey123456');
  const c = loadConfigFresh();
  assert.equal(c.provider, 'openai-compatible');
  assert.equal(effectiveBaseUrl(), 'https://api.deepseek.com');
});

test('provider 自动推断：Anthropic key 前缀 → anthropic', () => {
  saveConfig({ baseUrl: '' });
  setApiKey('sk-ant-api03-xxxxxxxxxx');
  const c = loadConfigFresh();
  assert.equal(c.provider, 'anthropic');
  assert.equal(effectiveBaseUrl(), 'https://api.anthropic.com');
});

test('provider 自动推断：官方 openai（无 baseUrl）→ openai', () => {
  saveConfig({ baseUrl: '' });
  setApiKey('sk-proj-officialkey12345');
  const c = loadConfigFresh();
  assert.equal(c.provider, 'openai');
  assert.equal(effectiveBaseUrl(), 'https://api.openai.com/v1');
});

test('备用 Key 独立加密存取', () => {
  setApiKey2('sk-backup-888888888888');
  assert.equal(getApiKey2(), 'sk-backup-888888888888');
  assert.equal(getPublicConfig().hasApiKey2, true);
  assert.equal(getPublicConfig().apiKey2Last4, '8888');
});

test('clearApiKey 清除主 Key', () => {
  setApiKey('sk-tobecleared-1234567');
  clearApiKey();
  assert.equal(hasApiKey(), false);
  assert.equal(getApiKey(), null);
});

// loadConfig 内部有 cache；测试里要拿最新值需重置缓存模块状态。
// config.js 未导出 cache 重置入口，但 setApiKey/saveConfig 都会 writeRaw + 更新 cache 引用，
// 这里用动态再读的方式间接验证。
function loadConfigFresh() {
  return loadConfig();
}
