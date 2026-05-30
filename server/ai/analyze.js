/**
 * 单条内容分析。
 * 省 token 的关键：结果按 content_id 永久缓存，已分析过的不再花钱。
 */
import { getAnalysis, upsertAnalysis } from '../store.js';
import { loadConfig } from '../config.js';
import { callJSON } from './client.js';
import { SYSTEM_ANALYZE, buildAnalyzeUser } from './prompts.js';

export async function analyzeContent(content, { force = false } = {}) {
  if (!force) {
    const cached = getAnalysis(content.id);
    if (cached) return { analysis: cached, cached: true };
  }
  const cfg = loadConfig();
  const { json, model } = await callJSON({
    system: SYSTEM_ANALYZE,
    user: buildAnalyzeUser(content),
    model: cfg.model,
    task: 'analyze',
    maxTokens: 1500,
    validate: (j) => {
      if (!j || typeof j !== 'object') return '不是对象';
      if (!j.extracted_topic && !j.summary) return '缺少 summary/extracted_topic';
      return null;
    },
  });
  const analysis = upsertAnalysis(content.id, json, model);
  return { analysis, cached: false };
}
