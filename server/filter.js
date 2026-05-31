/**
 * 筛选引擎 —— 双 1000 硬阈值 + 时间窗口 + 数据状态分层。
 *
 * 全部为确定性逻辑，不经过 AI。是否「达标入榜」完全由这里决定，
 * 因此关键判定不可能因为模型幻觉而出错。
 */

export const THRESHOLD = 1000;
export const ELIGIBLE_TYPES = ['video', 'article'];
export const ELIGIBLE_PLATFORMS = ['douyin', 'xiaohongshu', 'wechat_channels'];

/** 人工/授权来源的数据被视为可信；自动识别（OCR/页面文本）需人工确认后才可信。 */
export function isTrustedSource(src) {
  return src === 'manual' || src === 'authorized';
}

const known = (v) => v !== null && v !== undefined && v !== '';

/**
 * 计算单条内容的 data_status。优先级经过精心设计：
 *   duplicate > archived > needs_review(未确认的自动数据)
 *   > below_threshold(已知值 < 1000) > missing(已知值都 >=1000 但有缺失) > confirmed
 *
 * 关键原则「无法确认就不入榜」：只有 confirmed 才能进入正式日报。
 */
export function computeDataStatus(c) {
  if (c.is_duplicate === 1 || c.is_duplicate === true) return 'duplicate';
  if (c.archived === 1 || c.archived === true) return 'archived';

  // 新增规则：24小时内的新内容标记为 monitoring，等待发酵
  if (c.publish_time) {
    const pubTime = new Date(c.publish_time).getTime();
    if (!Number.isNaN(pubTime)) {
      const ageHours = (Date.now() - pubTime) / (1000 * 60 * 60);
      if (ageHours < 24 && c.user_confirmed !== 1 && c.user_confirmed !== true) {
        return 'monitoring';
      }
    }
  }

  const trusted =
    c.user_confirmed === 1 || c.user_confirmed === true || isTrustedSource(c.metrics_source);
  // 自动识别的数据在用户确认前一律视为需人工复核，绝不自动当作达标。
  if (!trusted) return 'needs_review';

  const L = c.like_count;
  const S = c.share_count;

  // 只要有一个「已知」指标低于阈值，就确定不达标。
  if ((known(L) && L < THRESHOLD) || (known(S) && S < THRESHOLD)) return 'below_threshold';

  // 走到这里，所有已知指标都 >= 1000。再看是否有缺失。
  if (!known(L) && !known(S)) return 'needs_review';
  if (!known(S)) return 'missing_share';
  if (!known(L)) return 'missing_like';

  return 'confirmed';
}

/**
 * 从 'last_N_day(s)' 解析出天数。解析不出则按 1 天兜底。
 * 单复数都接受（last_1_day / last_1_days / last_20_days）。
 */
export function windowDays(windowType) {
  const m = String(windowType).match(/^last_(\d+)_days?$/);
  const days = m ? Number(m[1]) : 1;
  return days >= 1 ? days : 1;
}

/** 规范化窗口字符串：任意输入 → 'last_N_days'（统一复数，避免单复数两套格式不一致）。 */
export function normalizeWindowType(windowType) {
  return `last_${windowDays(windowType)}_days`;
}

/** 窗口的中文标签：动态生成「最近 N 天」，支持任意天数（不再依赖硬编码表）。 */
export function windowLabel(windowType) {
  return `最近 ${windowDays(windowType)} 天`;
}

/**
 * 滚动时间窗口的起点（ISO 字符串，UTC）。
 * 支持任意天数：'last_N_days' 格式（如 last_1_day、last_5_days、last_14_days）。
 * @param {string} windowType  形如 'last_N_day(s)'
 */
export function windowStartISO(windowType, now = new Date()) {
  const ms = windowDays(windowType) * 24 * 3600 * 1000;
  return new Date(now.getTime() - ms).toISOString();
}

/**
 * 最终入选判定（防御性二次校验）。
 * data_status === 'confirmed' 已经隐含了双 1000，但这里再显式核一遍，
 * 宁可多写几行也要保证「绝不把不达标的算成达标」。
 */
export function isEligible(c) {
  return (
    c.data_status === 'confirmed' &&
    ELIGIBLE_PLATFORMS.includes(c.platform) &&
    known(c.account_id) &&
    ELIGIBLE_TYPES.includes(c.content_type) &&
    known(c.like_count) && c.like_count >= THRESHOLD &&
    known(c.share_count) && c.share_count >= THRESHOLD
  );
}
