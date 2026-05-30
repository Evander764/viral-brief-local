import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDataStatus, isEligible, windowStartISO, THRESHOLD, ELIGIBLE_PLATFORMS,
} from '../server/filter.js';

const base = {
  is_duplicate: 0, archived: 0, user_confirmed: 1, metrics_source: 'manual',
  platform: 'douyin', account_id: 'account-1',
  content_type: 'video', like_count: 5000, share_count: 5000,
};

test('双指标已确认且均 >= 1000 → confirmed', () => {
  assert.equal(computeDataStatus({ ...base }), 'confirmed');
  assert.equal(computeDataStatus({ ...base, like_count: 1000, share_count: 1000 }), 'confirmed');
});

test('任一已知指标 < 1000 → below_threshold', () => {
  assert.equal(computeDataStatus({ ...base, like_count: 999 }), 'below_threshold');
  assert.equal(computeDataStatus({ ...base, share_count: 0 }), 'below_threshold');
  // 即使另一个缺失，只要已知的那个不达标，就是确定不达标
  assert.equal(computeDataStatus({ ...base, like_count: 500, share_count: null }), 'below_threshold');
});

test('点赞达标但转发缺失 → missing_share（不可入榜）', () => {
  const s = computeDataStatus({ ...base, share_count: null });
  assert.equal(s, 'missing_share');
});

test('转发达标但点赞缺失 → missing_like', () => {
  assert.equal(computeDataStatus({ ...base, like_count: null }), 'missing_like');
});

test('两个指标都缺失 → needs_review', () => {
  assert.equal(computeDataStatus({ ...base, like_count: null, share_count: null }), 'needs_review');
});

test('关键：自动识别且未经人工确认 → needs_review（不自动达标）', () => {
  // 即便数字看起来达标，只要来源是自动识别且没确认，就必须人工复核
  const auto = { ...base, metrics_source: 'page_ocr', user_confirmed: 0 };
  assert.equal(computeDataStatus(auto), 'needs_review');
  const autoText = { ...base, metrics_source: 'page_text', user_confirmed: 0 };
  assert.equal(computeDataStatus(autoText), 'needs_review');
  // 用户确认后即可正常判定
  assert.equal(computeDataStatus({ ...auto, user_confirmed: 1 }), 'confirmed');
});

test('授权 API 来源视为可信', () => {
  assert.equal(computeDataStatus({ ...base, metrics_source: 'authorized', user_confirmed: 0 }), 'confirmed');
});

test('duplicate / archived 优先级最高', () => {
  assert.equal(computeDataStatus({ ...base, is_duplicate: 1 }), 'duplicate');
  assert.equal(computeDataStatus({ ...base, archived: 1 }), 'archived');
});

test('isEligible：只有账号池三平台 + confirmed + video/article + 双 1000 才入选', () => {
  assert.equal(isEligible({ ...base, data_status: 'confirmed' }), true);
  assert.equal(isEligible({ ...base, data_status: 'missing_share' }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', content_type: 'other' }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', platform: 'wechat_article' }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', account_id: null }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', like_count: 999 }), false);
  assert.equal(isEligible({ ...base, data_status: 'confirmed', share_count: null }), false);
});

test('阈值常量就是 1000', () => {
  assert.equal(THRESHOLD, 1000);
  assert.deepEqual(ELIGIBLE_PLATFORMS, ['douyin', 'xiaohongshu', 'wechat_channels']);
});

test('时间窗口起点计算', () => {
  const now = new Date('2026-05-30T12:00:00.000Z');
  assert.equal(windowStartISO('last_3_days', now), '2026-05-27T12:00:00.000Z');
  assert.equal(windowStartISO('last_7_days', now), '2026-05-23T12:00:00.000Z');
});
