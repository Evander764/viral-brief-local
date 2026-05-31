/**
 * AI 调用客户端 —— 供应商无关（OpenAI / OpenAI 兼容 / Anthropic），
 * 用内置 fetch，无需任何 SDK 依赖。
 *
 * Token 策略落地在这里：
 *  - 省：系统提示词稳定且靠前，Anthropic 显式打 prompt cache，OpenAI 自动命中前缀缓存。
 *  - 准（宁可多花）：返回的 JSON 强制校验，失败就带着「上次哪里错了」重试，
 *    直到拿到合法结构为止——绝不把脏数据吞下去。
 */
import { loadConfig, getApiKey, getApiKey2, effectiveBaseUrl } from '../config.js';
import { addUsage } from '../store.js';
import { log } from '../lib/log.js';

export class AIError extends Error {}

/** 从模型文本里稳健地抽出 JSON 对象。 */
export function extractJson(text) {
  if (!text || !text.trim()) throw new AIError('模型返回为空');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* 继续兜底 */ }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* 落到报错 */ }
  }
  throw new AIError('模型返回不是有效 JSON');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** 真正打一次模型，返回 { text, usage }。usage 统一为 {input, output, cached}。 */
function baseUrlForProvider(provider, cfg, providerOverride) {
  // 备用 Key 可能属于另一家供应商。跨供应商 fallback 时不能沿用主 Key 的
  // baseUrl，否则会出现「主 Key 401 后，备用 Anthropic Key 被发到 DeepSeek」
  // 这类偶发失败。
  if (!providerOverride || providerOverride === cfg.provider) return effectiveBaseUrl();
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  return (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
}

async function callRaw({ system, user, model, temperature, maxTokens, key, cfg, providerOverride }) {
  const provider = providerOverride || cfg.provider;
  const base = baseUrlForProvider(provider, cfg, providerOverride);

  if (provider === 'anthropic') {
    const url = `${base}/v1/messages`;
    const body = {
      model,
      max_tokens: maxTokens || 2048,
      temperature,
      // 把稳定的系统提示词打上 ephemeral 缓存标记，重复调用省 token。
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    };
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }, cfg.timeoutMs);
    if (!res.ok) throw new AIError(`Anthropic 请求失败 ${res.status}: ${(await safeText(res)).slice(0, 500)}`);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const u = data.usage || {};
    return {
      text,
      usage: {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cached: (u.cache_read_input_tokens || 0),
      },
    };
  }

  // OpenAI / OpenAI 兼容
  const url = `${base}/chat/completions`;
  const body = {
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  // 仅官方 OpenAI 强制 JSON 模式；兼容端点未必支持，靠提示词 + 兜底解析。
  if (provider === 'openai') body.response_format = { type: 'json_object' };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, cfg.timeoutMs);
  if (!res.ok) throw new AIError(`AI 请求失败 ${res.status}: ${(await safeText(res)).slice(0, 500)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  return {
    text,
    usage: {
      input: u.prompt_tokens || 0,
      output: u.completion_tokens || 0,
      cached: u.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

async function callRawWithNetworkRetry(args, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await callRaw(args);
    } catch (e) {
      lastErr = e;
      // 鉴权类错误别重试，直接抛
      if (/ 401| 403/.test(e.message)) throw e;
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 调用模型并返回校验过的 JSON。
 * @param {object} o
 * @param {string} o.system 系统提示词（稳定，利于缓存）
 * @param {string} o.user 用户内容
 * @param {string} [o.model]
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {string} [o.task] 用量归类
 * @param {(json:any)=>(string|null)} [o.validate] 返回 null 表示通过，返回字符串表示错误原因
 */
const isAuthError = (msg) => / 401| 403/.test(String(msg));

/** 把底层错误转成对用户可读、可行动的提示。 */
export function friendlyError(e) {
  const m = String(e?.message || e);
  if (isAuthError(m)) {
    return new AIError('API Key 无效或认证失败（401/403）。请到「设置」检查并重新保存 Key，再点「测试调用」。');
  }
  if (/AbortError|aborted|timeout/i.test(m)) {
    return new AIError('AI 请求超时。请检查网络或代理，或在「设置」调大超时时间后重试。');
  }
  if (/ 429/.test(m)) {
    return new AIError('AI 接口限流（429）。请稍后重试，或更换额度充足的 Key。');
  }
  return e instanceof AIError ? e : new AIError(m);
}

export async function callJSON({ system, user, model, temperature, maxTokens, task = 'ai', validate }) {
  const cfg = loadConfig();
  const key = getApiKey();
  if (!key) throw new AIError('未配置 API Key，请在「设置」里填写。');

  const useModel = model || cfg.model;
  const jsonRetries = cfg.retries ?? 2;
  let lastErr;
  let extra = '';

  for (let attempt = 0; attempt <= jsonRetries; attempt++) {
    const userMsg = extra ? `${user}\n\n${extra}` : user;
    let raw;
    try {
      raw = await callRawWithNetworkRetry({
        system, user: userMsg, model: useModel,
        temperature: temperature ?? cfg.temperature, maxTokens, key, cfg,
      }, cfg.retries ?? 2);
    } catch (netErr) {
      // 网络/鉴权类错误：先尝试备用 Key，再决定是否抛出。
      lastErr = netErr;
      if (isAuthError(netErr.message)) {
        const viaBackup = await tryBackupKey({ system, user, model: useModel, temperature, maxTokens, task, validate, cfg });
        if (viaBackup) return viaBackup;
      }
      throw friendlyError(netErr);
    }

    // 用量始终记账（即便这次 JSON 不合法，token 也确实花了）
    addUsage({ task, model: useModel, input: raw.usage.input, output: raw.usage.output, cached: raw.usage.cached });

    try {
      const json = extractJson(raw.text);
      if (validate) {
        const err = validate(json);
        if (err) {
          lastErr = new AIError(`校验未通过：${err}`);
          extra = `上次输出有问题（${err}）。请只返回一个严格合法的 JSON 对象，不要任何额外文字或代码块。`;
          log.warn(`[${task}] JSON 校验失败，重试 ${attempt + 1}/${jsonRetries}: ${err}`);
          continue;
        }
      }
      return { json, usage: raw.usage, model: useModel };
    } catch (e) {
      lastErr = e;
      extra = '上次输出不是合法 JSON。请只返回一个 JSON 对象，不要 Markdown 代码块或解释。';
      log.warn(`[${task}] JSON 解析失败，重试 ${attempt + 1}/${jsonRetries}`);
    }
  }
  throw friendlyError(lastErr || new AIError('AI 调用失败'));
}

/** 主 Key 鉴权失败时用备用 Key 重试一次。成功返回结果对象，否则返回 null。 */
async function tryBackupKey({ system, user, model, temperature, maxTokens, task, validate, cfg }) {
  const backupKey = getApiKey2();
  if (!backupKey) return null;
  log.info('[备用Key] 主 Key 鉴权失败，尝试备用 Key…');
  const base = (cfg.baseUrl || '').toLowerCase();
  const backupProvider = backupKey.startsWith('sk-ant-') ? 'anthropic'
    : (base && !base.includes('openai.com')) ? 'openai-compatible' : 'openai';
  try {
    const raw = await callRawWithNetworkRetry({
      system, user, model,
      temperature: temperature ?? cfg.temperature, maxTokens, key: backupKey, cfg,
      providerOverride: backupProvider,
    }, cfg.retries ?? 2);
    addUsage({ task, model, input: raw.usage.input, output: raw.usage.output, cached: raw.usage.cached });
    const json = extractJson(raw.text);
    if (validate) {
      const err = validate(json);
      if (err) throw new AIError(`备用 Key 校验未通过：${err}`);
    }
    log.info('[备用Key] 成功。');
    return { json, usage: raw.usage, model };
  } catch (e2) {
    log.warn(`[备用Key] 也失败了：${e2.message}`);
    return null;
  }
}

/** 配置页的「测试调用」用：用最小代价验证 Key/模型可用。 */
export async function testConnection() {
  const cfg = loadConfig();
  const { json, model, usage } = await callJSON({
    system: '你是一个连通性测试器。无论收到什么，只返回 {"ok": true}。',
    user: '请只返回 {"ok": true}',
    task: 'test',
    maxTokens: 50,
    validate: (j) => (j && j.ok === true ? null : '未返回 {"ok":true}'),
  });
  return { ok: true, model, usage, provider: cfg.provider, baseUrl: effectiveBaseUrl() };
}
