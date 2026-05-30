'use strict';
// 弹窗逻辑：注入页面提取可见数据 → 截图 → 用户确认/修正 → POST 到本地桌面端。

const $ = (id) => document.getElementById(id);

/** 在页面上下文里运行，尽力提取可见数据。识别不到的返回 null，交给用户手填。 */
function pageExtract() {
  const host = location.hostname;
  let platform = 'other';
  if (host.includes('douyin.com')) platform = 'douyin';
  else if (host.includes('xiaohongshu.com') || host.includes('xhslink')) platform = 'xiaohongshu';
  else if (host.includes('channels.weixin') || location.href.includes('weixin.qq.com/channels')) platform = 'wechat_channels';
  else if (host.includes('mp.weixin.qq.com')) platform = 'wechat_article';

  const content_type = (platform === 'douyin' || platform === 'wechat_channels') ? 'video' : 'article';

  const text = (sel) => { try { const el = document.querySelector(sel); return el ? (el.textContent || '').trim() : null; } catch { return null; } };
  const meta = (name) => { const el = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`); return el ? el.content : null; };

  const title = meta('og:title') || document.title || text('h1') || '';
  let author = meta('og:author') || meta('author') || null;

  const m = { like: null, share: null, comment: null, favorite: null };
  try {
    if (platform === 'douyin') {
      m.like = text('[data-e2e="like-count"]') || text('[data-e2e="video-like-count"]');
      m.comment = text('[data-e2e="comment-count"]');
      m.favorite = text('[data-e2e="collect-count"]') || text('[data-e2e="undefined-collect-count"]');
      m.share = text('[data-e2e="share-count"]');
      author = author || text('[data-e2e="video-author-uniqueid"]') || text('[data-e2e="user-name"]');
    } else if (platform === 'xiaohongshu') {
      m.like = text('.like-wrapper .count') || text('.like-active .count') || text('.engage-bar .like .count');
      m.favorite = text('.collect-wrapper .count') || text('.collect .count');
      m.comment = text('.chat-wrapper .count') || text('.comment .count') || text('.comments-count');
      m.share = text('.share-wrapper .count') || text('.share .count');
      author = author || text('.author-wrapper .username') || text('.username');
    } else if (platform === 'wechat_article') {
      m.like = text('#js_likes') || text('.like_num') || text('#js_like_count');
      m.favorite = text('#js_collect_count');
      author = author || text('#js_name') || text('.account_nickname_inner') || text('#meta_content .rich_media_meta_text');
    }
  } catch { /* ignore */ }

  // 兜底：从可见文本里就近匹配「赞/转发/分享/评论/收藏 + 数字」。
  const grab = (kw) => {
    try {
      const re = new RegExp(`(${kw})\\s*[:：]?\\s*([\\d.,]+\\s*[万千wkWK]?\\+?)`);
      const hit = document.body.innerText.match(re);
      return hit ? hit[2].trim() : null;
    } catch { return null; }
  };
  if (!m.like) m.like = grab('赞|点赞|like');
  if (!m.share) m.share = grab('转发|分享|share');
  if (!m.comment) m.comment = grab('评论|comment');
  if (!m.favorite) m.favorite = grab('收藏|collect');

  const body_excerpt = (meta('og:description') || (document.querySelector('article,#js_content,.note-content,.desc') || {}).innerText || '').slice(0, 1000);

  return {
    url: location.href, platform, content_type, title, author_name: author,
    body_excerpt, metrics_raw: m,
  };
}

async function init() {
  const cfg = await chrome.storage.local.get(['endpoint', 'token']);
  if (!cfg.endpoint || !cfg.token) {
    $('msg').textContent = '请先在「配置桌面端连接」里填写地址与配对 token。';
    $('msg').className = 'msg bad';
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageExtract });
    const d = result || {};
    $('platform').value = d.platform || 'other';
    $('content_type').value = d.content_type || 'article';
    $('title').value = d.title || '';
    $('author_name').value = d.author_name || '';
    $('like').value = d.metrics_raw?.like || '';
    $('share').value = d.metrics_raw?.share || '';
    $('comment').value = d.metrics_raw?.comment || '';
    $('favorite').value = d.metrics_raw?.favorite || '';
    window.__extract = d;
  } catch (e) {
    $('msg').textContent = '无法读取此页面（可能是受限页面）。可手动填写后保存。';
    $('msg').className = 'msg bad';
    window.__extract = { url: tab?.url || '', platform: 'other', content_type: 'article', metrics_raw: {} };
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 70 });
    $('shot').src = dataUrl;
    window.__shot = dataUrl;
  } catch { /* 截图失败不阻塞保存 */ }
}

$('save').addEventListener('click', async () => {
  const cfg = await chrome.storage.local.get(['endpoint', 'token']);
  if (!cfg.endpoint || !cfg.token) { $('msg').textContent = '未配置桌面端连接。'; $('msg').className = 'msg bad'; return; }
  const d = window.__extract || {};
  const payload = {
    url: d.url, platform: $('platform').value, content_type: $('content_type').value,
    title: $('title').value.trim(), author_name: $('author_name').value.trim(),
    body_excerpt: d.body_excerpt || '',
    publish_time: $('publish_time').value || null,
    metrics_raw: {
      like: $('like').value.trim() || null, share: $('share').value.trim() || null,
      comment: $('comment').value.trim() || null, favorite: $('favorite').value.trim() || null,
    },
    metrics_source: 'page_text',
    screenshot: window.__shot || null,
  };
  $('save').disabled = true; $('msg').textContent = '保存中…'; $('msg').className = 'msg';
  try {
    const res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/api/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vb-token': cfg.token },
      body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
    $('msg').textContent = r.duplicate ? '该内容已存在，已合并补充信息。' : '已保存到「今日候选」，去桌面端确认指标即可。';
    $('msg').className = 'msg ok';
  } catch (e) {
    $('msg').textContent = '保存失败：' + e.message + '（确认桌面端已启动）';
    $('msg').className = 'msg bad';
  } finally {
    $('save').disabled = false;
  }
});

$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

init();
