/**
 * 每日总结处理管线（文档 8.1）。
 * 顺序：刷新状态(零token) → 硬筛选(零token) → 逐条分析(命中缓存不花钱)
 *       → 趋势聚类 → 渲染 MD/HTML/CSV → 落库 + 导出文件。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowStartISO } from './filter.js';
import {
  recomputeAll, getEligible, getAnalysesForContents, insertReport, countsByStatus, getUsageForDay,
} from './store.js';
import { analyzeContent } from './ai/analyze.js';
import { generateReportData } from './ai/report.js';
import { renderMarkdown, renderHtml, renderCsv, fallbackReportData } from './report/render.js';
import { hasApiKey, loadConfig } from './config.js';
import { EXPORTS_DIR } from './lib/paths.js';
import { log } from './lib/log.js';

export async function runDailyReport({ windowType = 'last_3_days', force = false } = {}) {
  const startISO = windowStartISO(windowType);

  // 1-4：确定性，零 token。是否达标完全由代码说了算。
  recomputeAll(startISO);
  const items = getEligible(startISO);
  const counts = countsByStatus();
  const reportDate = new Date().toISOString().slice(0, 10);
  const cfg = loadConfig();

  let reportData;
  let model = null;
  let aiUsed = false;

  if (items.length === 0) {
    // 0 达标 → 完全跳过 AI，一分钱不花。
    reportData = fallbackReportData(windowType, counts);
    log.info('本期 0 条达标，跳过 AI 调用。');
  } else {
    if (!hasApiKey()) throw new Error('未配置 API Key，无法生成 AI 日报。请先在「设置」里填写。');

    // 预算软提醒（不硬停：用户明确表示数据正确优先于省钱）
    if (cfg.budgetDailyTokens > 0) {
      const used = getUsageForDay().total;
      if (used >= cfg.budgetDailyTokens) {
        log.warn(`今日 token 用量 ${used} 已达预算 ${cfg.budgetDailyTokens}，仍继续以保证日报完整。`);
      }
    }

    // 逐条分析：命中缓存的直接复用，不重复花钱。
    for (const it of items) {
      try {
        await analyzeContent(it, { force });
      } catch (e) {
        log.warn(`单条分析失败（不影响整体）：${it.id} ${e.message}`);
      }
    }
    const analyses = getAnalysesForContents(items.map((i) => i.id));
    const r = await generateReportData({ windowType, items, analyses });
    reportData = r.data;
    model = r.model;
    aiUsed = true;
  }

  const analyses = getAnalysesForContents(items.map((i) => i.id));
  const meta = { windowType, reportDate, generatedAt: new Date().toISOString(), counts, model, aiUsed };

  const md = renderMarkdown(reportData, items, analyses, meta);
  const html = renderHtml(reportData, items, analyses, meta);
  const csv = renderCsv(items, analyses);

  const stamp = `${reportDate}_${windowType}`;
  const mdPath = join(EXPORTS_DIR, `report_${stamp}.md`);
  const htmlPath = join(EXPORTS_DIR, `report_${stamp}.html`);
  const csvPath = join(EXPORTS_DIR, `report_${stamp}.csv`);
  writeFileSync(mdPath, md);
  writeFileSync(htmlPath, html);
  writeFileSync(csvPath, csv);

  const row = insertReport({
    report_date: reportDate,
    window_type: windowType,
    eligible_count: items.length,
    report_json: JSON.stringify(reportData),
    report_markdown: md,
    export_md_path: mdPath,
    export_html_path: htmlPath,
    export_csv_path: csvPath,
  });

  log.info(`日报已生成：${windowType}，达标 ${items.length} 条，${aiUsed ? `AI=on(${model})` : 'AI=skip'}`);
  return { report: row, markdown: md, eligibleCount: items.length, aiUsed };
}
