/**
 * 日报趋势数据生成（聚类 + 母题 + 改写标题 + 承接建议）。
 * 校验模型引用的编号必须真实存在，杜绝编造 content。
 */
import { loadConfig } from '../config.js';
import { callJSON } from './client.js';
import { SYSTEM_REPORT, buildReportUser } from './prompts.js';

const WINDOW_LABEL = { last_3_days: '最近 3 天', last_7_days: '最近 7 天' };

export async function generateReportData({ windowType, items, analyses }) {
  const cfg = loadConfig();
  const validRefs = new Set(items.map((_, i) => `C${i + 1}`));

  const validate = (j) => {
    if (!j || typeof j !== 'object') return '不是对象';
    if (!Array.isArray(j.top_topic_clusters)) return '缺少 top_topic_clusters 数组';
    for (const c of j.top_topic_clusters) {
      const refs = c.representative_content_ids || c.representative_contents || [];
      for (const r of refs) {
        if (!validRefs.has(String(r))) return `引用了不存在的编号 ${r}`;
      }
    }
    return null;
  };

  const { json, model } = await callJSON({
    system: SYSTEM_REPORT,
    user: buildReportUser(WINDOW_LABEL[windowType] || windowType, items, analyses),
    model: cfg.reportModel || cfg.model,
    task: 'report',
    temperature: 0.4,
    maxTokens: 4000,
    validate,
  });

  return { data: json, model };
}
