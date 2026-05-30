import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.VB_DATA_DIR = mkdtempSync(join(tmpdir(), 'viral-brief-test-'));

const {
  upsertAccount, upsertCapture, confirmContent, getEligible,
} = await import('../server/store.js');

const recent = new Date().toISOString();

test('getEligible 只返回账号池三平台里的 confirmed 双 1000 内容', () => {
  const account = upsertAccount({
    platform: 'douyin',
    nickname: '商业老王',
    category: '商业',
    priority: 'A',
    monitor_enabled: false,
  });

  const matched = upsertCapture({
    platform: 'douyin',
    content_type: 'video',
    author_name: '商业老王',
    title: '增长模型',
    publish_time: recent,
    metrics_source: 'manual',
    metrics_raw: { like: '2000', share: '1500' },
  });
  confirmContent(matched.id, { like_count: 2000, share_count: 1500, account_id: account.id });

  const unlinked = upsertCapture({
    platform: 'xiaohongshu',
    content_type: 'article',
    author_name: '陌生作者',
    title: '未关注账号',
    publish_time: recent,
    metrics_source: 'manual',
    metrics_raw: { like: '5000', share: '5000' },
  });
  confirmContent(unlinked.id, { like_count: 5000, share_count: 5000 });

  const articleAccount = upsertAccount({
    platform: 'wechat_article',
    nickname: '公众号作者',
    category: '商业',
    priority: 'A',
    monitor_enabled: false,
  });
  const wechatArticle = upsertCapture({
    platform: 'wechat_article',
    content_type: 'article',
    author_name: '公众号作者',
    title: '公众号不入日报',
    publish_time: recent,
    metrics_source: 'manual',
    metrics_raw: { like: '9000', share: '9000' },
  });
  confirmContent(wechatArticle.id, { like_count: 9000, share_count: 9000, account_id: articleAccount.id });

  const rows = getEligible(new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, matched.id);
  assert.equal(rows[0].account_nickname, '商业老王');
});
