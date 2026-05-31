'use strict';
// 仪表盘前端逻辑（原生 JS，零框架）。所有 /api 调用都带配对 token。

let TOKEN = window.__VB_TOKEN__; // 可变：重置配对 token 后即时更新，避免后续请求 401
const PORT = window.__VB_PORT__;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const PLATFORM_LABEL = {
  douyin: '抖音', xiaohongshu: '小红书', wechat_channels: '视频号',
  wechat_article: '公众号文章', other: '其他',
};
const STATUS_LABEL = {
  confirmed: '已确认', needs_review: '待复核', missing_share: '缺转发数',
  missing_like: '缺点赞数', below_threshold: '未达阈值', duplicate: '重复', archived: '已归档',
  monitoring: '发酵中',
};
let accountsCache = [];

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-vb-token': TOKEN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  // 错误消息显示更久（6秒），成功消息显示3秒
  const duration = kind === 'bad' ? 6000 : 3200;
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 统一窗口格式与中文标签（与后端 filter.js 保持一致，单复数都解析为「最近 N 天」）。
const windowStr = (days) => `last_${Math.max(1, Number(days) || 1)}_days`;
const windowLabel = (wt) => { const m = String(wt).match(/last_(\d+)_days?/); return `最近 ${m ? m[1] : 1} 天`; };

async function getAccountsCache(force = false) {
  if (force || accountsCache.length === 0) accountsCache = await api('/accounts');
  return accountsCache;
}

// ---------------------------------------------------------------- tabs ----
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $$('.tab').forEach((t) => t.classList.add('hidden'));
  $(`#tab-${b.dataset.tab}`).classList.remove('hidden');
  loaders[b.dataset.tab]?.();
}));

// ---------------------------------------------------------------- overview ----
async function loadOverview() {
  const s = await api('/stats');
  const c = s.counts || {};
  const cards = [
    ['confirmed', '已确认（可入榜）', 'ok'],
    ['needs_review', '待复核', 'warn'],
    ['missing_share', '缺转发数', 'warn'],
    ['below_threshold', '未达阈值', ''],
    ['duplicate', '重复', ''],
  ].map(([k, label, cls]) => `<div class="statcard ${cls}"><div class="n">${c[k] || 0}</div><div class="l">${label}</div></div>`);
  cards.push(`<div class="statcard"><div class="n">${fmt(s.usage.total)}</div><div class="l">今日 token（缓存 ${fmt(s.usage.cached)}）</div></div>`);
  $('#statCards').innerHTML = cards.join('');
  $('#candCount').textContent = (c.needs_review || 0) + (c.missing_share || 0) + (c.missing_like || 0) || '';
  renderKeyState(s.hasApiKey, s.schedule);
}
function renderKeyState(hasKey, schedule) {
  const sch = schedule?.enabled ? `自动 ${schedule.time}` : '自动关';
  $('#keyState').innerHTML = `API Key：<b class="${hasKey ? 'on' : 'off'}">${hasKey ? '已配置' : '未配置'}</b> ｜ ${sch}`;
}

$('#ovGenerate').addEventListener('click', () => {
  const skipRpa = !$('#ovAutoCollect').checked;
  generateReport(windowStr($('#ovDays').value), $('#ovGenMsg'), skipRpa);
});

async function generateReport(win, msgEl, skipRpa = false) {
  const progressEl = $('#ovProgress');
  const progressText = $('#ovProgressText');
  const btn = $('#ovGenerate');

  btn.disabled = true;
  progressEl.style.display = 'block';

  if (skipRpa) {
    progressText.textContent = '正在分析已有数据并生成日报...';
  } else {
    progressText.textContent = '正在启动浏览器，自动采集最新数据...';
  }
  msgEl.textContent = '';

  try {
    const r = await api('/reports/generate', {
      method: 'POST',
      body: JSON.stringify({ window: win, skipRpa }),
    });

    progressEl.style.display = 'none';

    if (r.error) {
      toast('生成失败：' + r.error, 'bad');
      return;
    }

    let detail = `达标 ${r.eligibleCount} 条`;
    if (r.patrolResult) {
      detail += ` | 采集: 新增 ${r.patrolResult.newItems}, 去重 ${r.patrolResult.duplicates}`;
    }
    if (!r.aiUsed) detail += '（0 达标，未调用 AI）';
    msgEl.textContent = `✅ 完成：${detail}`;
    toast('日报已生成', 'ok');
    loadReports();
    loadOverview();
    loadCandidates();
  } catch (e) {
    progressEl.style.display = 'none';
    toast('生成失败：' + e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- candidates ----
let candFocusIdx = -1; // 当前键盘聚焦的卡片索引

async function loadCandidates() {
  const accounts = await getAccountsCache();
  const all = [];
  for (const st of ['needs_review', 'missing_share', 'missing_like', 'below_threshold', 'monitoring']) {
    const rows = await api(`/contents?status=${st}`);
    all.push(...rows);
  }
  candFocusIdx = -1;
  const toolbar = $('#candToolbar');
  if (all.length > 0) {
    toolbar.style.display = 'flex';
    $('#candSelectedCount').textContent = '';
    $('#candSelectAll').checked = false;
  } else {
    toolbar.style.display = 'none';
  }
  $('#candList').innerHTML = all.length
    ? all.map((it, i) => itemCard(it, accounts, i)).join('')
    : '<p class="muted">暂无待处理内容。用浏览器插件「保存当前内容」后会出现在这里。</p>';
  bindItemCards($('#candList'));
  updateCandSelectedCount();
}

function accountOptions(it, accounts) {
  const rows = accounts.filter((a) => a.platform === it.platform);
  const opts = [`<option value="">未关联账号池（不入日报）</option>`];
  for (const a of rows) {
    const label = `${a.nickname}${a.category ? ` / ${a.category}` : ''}`;
    opts.push(`<option value="${esc(a.id)}" ${it.account_id === a.id ? 'selected' : ''}>${esc(label)}</option>`);
  }
  return opts.join('');
}

function itemCard(it, accounts, idx) {
  const shot = it.screenshot_path
    ? `<img class="shot" src="/screenshots/${esc(it.screenshot_path.split('/').pop())}" alt="截图" />`
    : '<div class="shot"></div>';
  return `<div class="item" data-id="${it.id}" data-cidx="${idx}" tabindex="0">
    <div style="display:flex;align-items:flex-start;padding:2px 0 0 0">
      <input type="checkbox" class="cand-cb" data-id="${it.id}" style="margin:4px 8px 0 0;transform:scale(1.2)" />
    </div>
    ${shot}
    <div class="body">
      <div class="t">${esc(it.title) || '(无标题)'} <span class="badge ${it.data_status}">${STATUS_LABEL[it.data_status] || it.data_status}</span></div>
      <div class="sub">${PLATFORM_LABEL[it.platform] || it.platform} ｜ ${esc(it.author_name) || '未知作者'} ｜ 采集来源：${esc(it.metrics_source)} ${it.url ? `｜ <a href="${esc(it.url)}" target="_blank" rel="noreferrer">原链接</a>` : ''}</div>
      <div class="metricgrid">
        <label>点赞<input type="number" data-f="like_count" value="${it.like_count ?? ''}" placeholder="${esc(it.like_raw || '')}" /></label>
        <label>转发/分享<input type="number" data-f="share_count" value="${it.share_count ?? ''}" placeholder="${esc(it.share_raw || '')}" /></label>
        <label>评论<input type="number" data-f="comment_count" value="${it.comment_count ?? ''}" /></label>
        <label>收藏<input type="number" data-f="favorite_count" value="${it.favorite_count ?? ''}" /></label>
        <label>类型<select data-f="content_type"><option value="video" ${it.content_type === 'video' ? 'selected' : ''}>视频</option><option value="article" ${it.content_type === 'article' ? 'selected' : ''}>图文/文章</option></select></label>
        <label>账号池<select data-f="account_id">${accountOptions(it, accounts)}</select></label>
      </div>
      <div class="row" style="margin:6px 0 0">
        <label style="flex-direction:row;align-items:center;gap:6px">发布时间 <input type="date" data-f="publish_time" value="${it.publish_time ? it.publish_time.slice(0, 10) : ''}" /></label>
      </div>
      <div class="actions">
        <button class="primary" data-act="confirm">确认入库</button>
        <button data-act="archive">归档</button>
        <button class="danger" data-act="delete">删除</button>
      </div>
    </div>
  </div>`;
}

function collectCardData(card) {
  const o = {};
  $$('[data-f]', card).forEach((inp) => {
    const f = inp.dataset.f;
    if (f.endsWith('_count')) o[f] = inp.value === '' ? '' : inp.value;
    else o[f] = inp.value;
  });
  return o;
}

function updateCandSelectedCount() {
  const cbs = $$('.cand-cb');
  const checked = $$('.cand-cb:checked');
  const el = $('#candSelectedCount');
  if (el) el.textContent = checked.length > 0 ? `已选 ${checked.length} / ${cbs.length}` : `共 ${cbs.length} 条`;
}

function focusCandCard(idx) {
  const cards = $$('#candList .item');
  if (cards.length === 0) return;
  // 移除旧 focus 样式
  cards.forEach(c => c.style.outline = '');
  idx = Math.max(0, Math.min(idx, cards.length - 1));
  candFocusIdx = idx;
  const card = cards[idx];
  card.style.outline = '2px solid var(--brand)';
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function bindItemCards(root) {
  $$('.item', root).forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-act="confirm"]').addEventListener('click', async () => {
      try {
        const c = await api(`/contents/${id}/confirm`, { method: 'POST', body: JSON.stringify(collectCardData(card)) });
        toast(`已确认：${STATUS_LABEL[c.data_status] || c.data_status}`, c.data_status === 'confirmed' ? 'ok' : '');
        loadCandidates(); loadOverview();
      } catch (e) { toast('确认失败：' + e.message, 'bad'); }
    });
    card.querySelector('[data-act="archive"]').addEventListener('click', async () => {
      await api(`/contents/${id}/archive`, { method: 'POST' }); toast('已归档'); loadCandidates(); loadOverview();
    });
    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm('确认删除这条内容？')) return;
      await api(`/contents/${id}`, { method: 'DELETE' }); toast('已删除'); loadCandidates(); loadOverview();
    });
  });
  // 复选框变更 → 更新计数
  $$('.cand-cb', root).forEach(cb => cb.addEventListener('change', updateCandSelectedCount));
}

// 全选
$('#candSelectAll').addEventListener('change', (e) => {
  $$('.cand-cb').forEach(cb => cb.checked = e.target.checked);
  updateCandSelectedCount();
});

// 批量确认
$('#candBatchConfirm').addEventListener('click', async () => {
  const checked = $$('.cand-cb:checked');
  if (checked.length === 0) return toast('请先勾选要确认的内容', 'bad');
  if (!confirm(`确认批量确认 ${checked.length} 条内容？`)) return;
  let ok = 0;
  for (const cb of checked) {
    const card = cb.closest('.item');
    try {
      await api(`/contents/${card.dataset.id}/confirm`, { method: 'POST', body: JSON.stringify(collectCardData(card)) });
      ok++;
    } catch (e) { console.error('批量确认失败:', e); }
  }
  toast(`已确认 ${ok} 条`, 'ok');
  loadCandidates(); loadOverview();
});

// 一键自动巡检
$('#candRunRpa').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '启动中... (请查看弹出的 Chrome 窗口)';
  try {
    toast('正在启动 RPA...', 'ok');
    const res = await api('/patrol/run', { method: 'POST' });
    if (res.error) throw new Error(res.error);
    toast('自动巡检完成！', 'ok');
    loadCandidates();
    loadOverview();
  } catch (err) {
    toast('自动巡检失败: ' + err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '一键自动巡检';
  }
});

// 批量归档
$('#candBatchArchive').addEventListener('click', async () => {
  const checked = $$('.cand-cb:checked');
  if (checked.length === 0) return toast('请先勾选要归档的内容', 'bad');
  if (!confirm(`确认批量归档 ${checked.length} 条内容？`)) return;
  let ok = 0;
  for (const cb of checked) {
    const card = cb.closest('.item');
    try {
      await api(`/contents/${card.dataset.id}/archive`, { method: 'POST' });
      ok++;
    } catch (e) { console.error('批量归档失败:', e); }
  }
  toast(`已归档 ${ok} 条`, 'ok');
  loadCandidates(); loadOverview();
});

// 键盘快捷键（仅在候选池 tab 激活时生效）
document.addEventListener('keydown', (e) => {
  // 如果焦点在 input/select/textarea 中，不拦截（让用户正常输入）
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  // 仅候选池 tab 可见时生效
  if ($('#tab-candidates')?.classList.contains('hidden')) return;

  const cards = $$('#candList .item');
  if (cards.length === 0) return;

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    focusCandCard(candFocusIdx + 1);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    focusCandCard(candFocusIdx - 1);
  } else if (e.key === 'Enter' && candFocusIdx >= 0) {
    e.preventDefault();
    const card = cards[candFocusIdx];
    card?.querySelector('[data-act="confirm"]')?.click();
  } else if (e.key === 'Escape') {
    candFocusIdx = -1;
    cards.forEach(c => c.style.outline = '');
  } else if (e.key === ' ' && candFocusIdx >= 0) {
    e.preventDefault();
    const cb = cards[candFocusIdx]?.querySelector('.cand-cb');
    if (cb) { cb.checked = !cb.checked; updateCandSelectedCount(); }
  }
});

// ---------------------------------------------------------------- library ----
async function loadLibrary() {
  const q = encodeURIComponent($('#libQ').value || '');
  const status = $('#libStatus').value;
  const platform = $('#libPlatform').value;
  const rows = await api(`/contents?q=${q}&status=${status}&platform=${platform}`);
  $('#libTable').innerHTML = rows.length ? `
    <table><thead><tr>
      <th>状态</th><th>平台</th><th>作者</th><th>标题</th><th>点赞</th><th>转发</th><th>发布</th><th>操作</th>
    </tr></thead><tbody>
    ${rows.map((it) => `<tr>
      <td><span class="badge ${it.data_status}">${STATUS_LABEL[it.data_status] || it.data_status}</span></td>
      <td>${PLATFORM_LABEL[it.platform] || it.platform}</td>
      <td>${esc(it.author_name)}</td>
      <td>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noreferrer">${esc(it.title) || '(无标题)'}</a>` : esc(it.title)}</td>
      <td class="num">${fmt(it.like_count)}</td>
      <td class="num">${fmt(it.share_count)}</td>
      <td>${it.publish_time ? it.publish_time.slice(0, 10) : '—'}</td>
      <td><button data-del="${it.id}">删除</button></td>
    </tr>`).join('')}
    </tbody></table>` : '<p class="muted">没有匹配的内容。</p>';
  $$('#libTable [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除这条内容？')) return;
    await api(`/contents/${b.dataset.del}`, { method: 'DELETE' }); loadLibrary(); loadOverview();
  }));
}
['libRefresh'].forEach((id) => $(`#${id}`).addEventListener('click', loadLibrary));
['libQ'].forEach((id) => $(`#${id}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLibrary(); }));
['libStatus', 'libPlatform'].forEach((id) => $(`#${id}`).addEventListener('change', loadLibrary));

// ---------------------------------------------------------------- accounts ----
async function loadAccounts() {
  const rows = await getAccountsCache(true);
  const platformOpts = (sel) => ['douyin','xiaohongshu','wechat_channels','other'].map(
    p => `<option value="${p}" ${p===sel?'selected':''}>${PLATFORM_LABEL[p]||p}</option>`
  ).join('');
  const prioOpts = (sel) => ['S','A','B'].map(
    p => `<option ${p===sel?'selected':''}>${p}</option>`
  ).join('');
  $('#acTable').innerHTML = rows.length ? `
    <table><thead><tr><th>平台</th><th>昵称</th><th>分类</th><th>优先级</th><th>主页链接</th><th></th></tr></thead><tbody>
    ${rows.map((a) => `<tr data-acid="${a.id}">
      <td><select data-af="platform">${platformOpts(a.platform)}</select></td>
      <td><input data-af="nickname" value="${esc(a.nickname)}" style="min-width:80px" /></td>
      <td><input data-af="category" value="${esc(a.category || '')}" style="min-width:60px" /></td>
      <td><select data-af="priority">${prioOpts(a.priority||'B')}</select></td>
      <td><input data-af="homepage_url" value="${esc(a.homepage_url || '')}" placeholder="主页链接" style="min-width:150px;font-size:11px" /></td>
      <td style="white-space:nowrap">
        <button data-save="${a.id}">保存</button>
        <button data-del="${a.id}">删除</button>
      </td>
    </tr>`).join('')}
    </tbody></table>` : '<p class="muted">还没有账号。手动添加或导入 CSV。</p>';
  $$('#acTable [data-save]').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    const val = (f) => row.querySelector(`[data-af="${f}"]`).value;
    await api(`/accounts`, {
      method: 'POST',
      body: JSON.stringify({
        id: b.dataset.save,
        platform: val('platform'),
        nickname: val('nickname').trim(),
        homepage_url: val('homepage_url').trim(),
        category: val('category').trim(),
        priority: val('priority'),
        monitor_enabled: true,
      })
    });
    accountsCache = [];
    toast('已保存', 'ok');
  }));
  $$('#acTable [data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除该账号？')) return;
    await api(`/accounts/${b.dataset.del}`, { method: 'DELETE' });
    accountsCache = [];
    loadAccounts();
  }));
}
$('#acAdd').addEventListener('click', async () => {
  const body = {
    nickname: $('#acNick').value.trim(), platform: $('#acPlatform').value,
    homepage_url: $('#acUrl').value.trim(), category: $('#acCategory').value.trim(),
    priority: $('#acPriority').value,
  };
  if (!body.nickname) return toast('请填写昵称', 'bad');
  await api('/accounts', { method: 'POST', body: JSON.stringify(body) });
  $('#acNick').value = ''; $('#acUrl').value = ''; $('#acCategory').value = '';
  accountsCache = [];
  toast('已添加'); loadAccounts();
});
$('#acCsv').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const csv = await file.text();
  const r = await api('/accounts/import', { method: 'POST', body: JSON.stringify({ csv }) });
  accountsCache = [];
  toast(`导入 ${r.imported} 个账号`, 'ok'); loadAccounts(); e.target.value = '';
});

$('#acManualImport').addEventListener('click', async () => {
  const text = $('#acManualText').value.trim();
  if (!text) return toast('请先粘贴要导入的账号', 'bad');
  $('#acManualImport').disabled = true;
  $('#acManualMsg').textContent = '导入中…';
  try {
    const r = await api('/accounts/import-lines', { method: 'POST', body: JSON.stringify({ text }) });
    accountsCache = [];
    const err = r.errors?.length ? `，${r.errors.length} 行需检查` : '';
    $('#acManualMsg').textContent = `导入/更新 ${r.imported} 个，跳过 ${r.skipped || 0} 行${err}`;
    toast(`已导入/更新 ${r.imported} 个账号`, r.errors?.length ? '' : 'ok');
    loadAccounts();
  } catch (e) {
    $('#acManualMsg').textContent = '';
    toast('导入失败：' + e.message, 'bad');
  } finally {
    $('#acManualImport').disabled = false;
  }
});
$('#acManualClear').addEventListener('click', () => {
  $('#acManualText').value = '';
  $('#acManualMsg').textContent = '';
});

$('#acAiFill').addEventListener('click', async () => {
  const nick = $('#acNick').value.trim();
  if (!nick) return toast('请先输入昵称', 'bad');

  $('#acAiFill').disabled = true;
  const originalText = $('#acAiFill').textContent;
  $('#acAiFill').textContent = '补齐中…';

  try {
    const res = await api('/accounts/search-suggest', { method: 'POST', body: JSON.stringify({ q: nick }) });
    const suggestions = res.suggestions || [];
    if (suggestions.length === 0) {
      toast('未能检索到匹配信息，请手动填写', 'bad');
      return;
    }
    const match = suggestions.find(s => s.nickname.toLowerCase().includes(nick.toLowerCase())) || suggestions[0];
    if (match) {
      $('#acPlatform').value = match.platform;
      // 有已验证主页就用主页，否则用一定能打开的平台搜索链接兜底（不再留死链/空）。
      $('#acUrl').value = match.homepage_url || match.search_url || '';
      $('#acCategory').value = match.category || '';
      if (['S', 'A', 'B'].includes(match.priority)) {
        $('#acPriority').value = match.priority;
      } else {
        $('#acPriority').value = 'B';
      }
      toast(match.link_verified ? '已补齐（含已验证主页）' : '已补齐（主页用搜索链接兜底，可手动替换）', 'ok');
    }
  } catch (e) {
    toast('API 调用失败：' + e.message, 'bad');
  } finally {
    $('#acAiFill').disabled = false;
    $('#acAiFill').textContent = originalText;
  }
});

let aiSuggestions = [];

$('#acAiSearch').addEventListener('click', async () => {
  const q = $('#acAiQuery').value.trim();
  if (!q) return toast('请输入博主名称或关键词', 'bad');
  
  $('#acAiSearchMsg').textContent = '检索中，请稍候…';
  $('#acAiSearch').disabled = true;
  $('#acAiResults').style.display = 'none';
  
  try {
    const res = await api('/accounts/search-suggest', { method: 'POST', body: JSON.stringify({ q }) });
    aiSuggestions = res.suggestions || [];
    $('#acAiSearchMsg').textContent = '';
    
    if (aiSuggestions.length === 0) {
      toast('未找到匹配博主，请更换关键词重试', 'bad');
      return;
    }
    
    $('#acAiResultsTable').innerHTML = `
      <table>
        <thead>
          <tr>
            <th style="width: 40px; text-align: center;"><input type="checkbox" id="acAiSelectAll" checked /></th>
            <th>平台</th>
            <th>昵称</th>
            <th>分类</th>
            <th>优先级</th>
            <th>简介</th>
            <th>主页链接</th>
          </tr>
        </thead>
        <tbody>
          ${aiSuggestions.map((item, idx) => `
            <tr data-ai-idx="${idx}">
              <td style="text-align: center; vertical-align: middle;">
                <input type="checkbox" class="ac-ai-cb" data-idx="${idx}" checked />
              </td>
              <td>
                <select data-af="platform">
                  <option value="douyin" ${item.platform === 'douyin' ? 'selected' : ''}>抖音</option>
                  <option value="xiaohongshu" ${item.platform === 'xiaohongshu' ? 'selected' : ''}>小红书</option>
                  <option value="wechat_channels" ${item.platform === 'wechat_channels' ? 'selected' : ''}>视频号</option>
                  <option value="other" ${item.platform === 'other' ? 'selected' : ''}>其他</option>
                </select>
              </td>
              <td><input data-af="nickname" value="${esc(item.nickname)}" style="font-weight:600;min-width:80px" /></td>
              <td><input data-af="category" value="${esc(item.category || '')}" placeholder="分类" style="min-width:60px" /></td>
              <td>
                <select data-af="priority">
                  <option value="S" ${item.priority === 'S' ? 'selected' : ''}>S</option>
                  <option value="A" ${item.priority === 'A' ? 'selected' : ''}>A</option>
                  <option value="B" ${(item.priority || 'B') === 'B' ? 'selected' : ''}>B</option>
                </select>
              </td>
              <td><span class="muted">${esc(item.description || '—')}</span></td>
              <td>
                <input data-af="homepage_url" value="${esc(item.homepage_url || item.search_url || '')}" placeholder="主页链接" style="min-width:140px;font-size:11px" />
                <div style="font-size:11px;margin-top:3px">
                  ${item.link_verified
                    ? '<span style="color:var(--ok)">✓ 已验证主页</span>'
                    : '<span class="muted">🔍 搜索链接（点开找到本人后可替换为真实主页）</span>'}
                  ${(item.homepage_url || item.search_url) ? ` <a href="${esc(item.homepage_url || item.search_url)}" target="_blank" rel="noreferrer">打开</a>` : ''}
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    
    $('#acAiSelectAll').addEventListener('change', (e) => {
      $$('.ac-ai-cb').forEach((cb) => cb.checked = e.target.checked);
    });
    
    $('#acAiResults').style.display = 'block';
  } catch (e) {
    $('#acAiSearchMsg').textContent = '';
    toast('API 调用失败：' + e.message, 'bad');
  } finally {
    $('#acAiSearch').disabled = false;
  }
});

$('#acAiImportSelected').addEventListener('click', async () => {
  const cbs = $$('.ac-ai-cb:checked');
  if (cbs.length === 0) return toast('请先勾选要导入的账号', 'bad');
  
  $('#acAiImportSelected').disabled = true;
  let successCount = 0;
  for (const cb of cbs) {
    const row = cb.closest('tr');
    if (!row) continue;
    // 从 DOM 输入控件读取用户编辑后的值
    const val = (f) => { const el = row.querySelector(`[data-af="${f}"]`); return el ? el.value : ''; };
    
    try {
      await api('/accounts', {
        method: 'POST',
        body: JSON.stringify({
          platform: val('platform'),
          nickname: val('nickname').trim(),
          homepage_url: val('homepage_url').trim(),
          category: val('category').trim() || '商业',
          priority: val('priority') || 'B',
          monitor_enabled: true
        })
      });
      successCount++;
    } catch (e) {
      console.error('导入账号失败:', val('nickname'), e);
    }
  }
  
  accountsCache = [];
  toast(`成功导入 ${successCount} 个账号`, 'ok');
  loadAccounts();
  
  $('#acAiResults').style.display = 'none';
  $('#acAiQuery').value = '';
  $('#acAiImportSelected').disabled = false;
});

// ---------------------------------------------------------------- reports ----
async function loadReports() {
  const rows = await api('/reports');
  $('#rpList').innerHTML = rows.length ? rows.map((r) => `
    <div class="item"><div class="body">
      <div class="t">${r.report_date} ｜ ${windowLabel(r.window_type)} ｜ 达标 ${r.eligible_count} 条</div>
      <div class="sub">生成于 ${new Date(r.created_at).toLocaleString('zh-CN')}</div>
      <div class="actions">
        <a class="filebtn" href="/api/reports/${r.id}/export?format=html&inline=1&token=${TOKEN}" target="_blank">查看日报</a>
        <a class="filebtn" href="/api/reports/${r.id}/export?format=md&token=${TOKEN}">导出 Markdown</a>
        <a class="filebtn" href="/api/reports/${r.id}/export?format=csv&token=${TOKEN}">导出 CSV</a>
        ${r.export_zip_path ? `<a class="filebtn" href="/api/reports/${r.id}/export?format=zip&token=${TOKEN}">下载压缩包</a>` : ''}
        <button class="danger" data-rp-del="${r.id}">删除日报</button>
      </div>
    </div></div>`).join('') : '<p class="muted">还没有日报。点上方「生成日报」。</p>';
  $$('#rpList [data-rp-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('确认删除这份日报及其导出文件？')) return;
    await api(`/reports/${b.dataset.rpDel}`, { method: 'DELETE' });
    toast('日报已删除', 'ok');
    loadReports();
  }));
}
$('#rpGenerate').addEventListener('click', () => generateReport(windowStr($('#rpDays').value), $('#rpMsg')));

// ---------------------------------------------------------------- settings ----
// 供应商预设：选了就自动填 Base URL，并给模型名/获取 Key 的提示。
// 接口地址均为各家官方公开的 OpenAI/Anthropic 兼容地址（已核对）。
const VENDORS = {
  openai:      { name: 'OpenAI（官方）',        baseUrl: '',                                              models: ['gpt-4o-mini', 'gpt-4o'],                apply: 'https://platform.openai.com/api-keys' },
  deepseek:    { name: 'DeepSeek 深度求索',     baseUrl: 'https://api.deepseek.com',                      models: ['deepseek-chat', 'deepseek-reasoner'],   apply: 'https://platform.deepseek.com/api_keys' },
  xiaomi:      { name: '小米 MiMo',             baseUrl: 'https://api.xiaomimimo.com/v1',                 models: ['mimo-v2-flash', 'mimo-v2-pro'],          apply: 'https://platform.xiaomimimo.com' },
  moonshot:    { name: '月之暗面 Kimi',         baseUrl: 'https://api.moonshot.cn/v1',                    models: ['moonshot-v1-8k', 'kimi-k2-0905-preview'], apply: 'https://platform.moonshot.cn/console/api-keys' },
  zhipu:       { name: '智谱 GLM',              baseUrl: 'https://open.bigmodel.cn/api/paas/v4',          models: ['glm-4-flash', 'glm-4-plus'],            apply: 'https://open.bigmodel.cn/usercenter/apikeys' },
  qwen:        { name: '通义千问（阿里百炼）',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'], apply: 'https://bailian.console.aliyun.com/?apiKey=1' },
  siliconflow: { name: '硅基流动 SiliconFlow',  baseUrl: 'https://api.siliconflow.cn/v1',                 models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct'], apply: 'https://cloud.siliconflow.cn/account/ak' },
  anthropic:   { name: 'Anthropic Claude',      baseUrl: 'https://api.anthropic.com',                     models: ['claude-haiku-4-5', 'claude-sonnet-4-6'], apply: 'https://console.anthropic.com/settings/keys' },
  custom:      { name: '自定义', baseUrl: '', models: [], apply: '' },
};

/** 根据已保存的 baseUrl 反推选中哪个供应商（用于回填下拉框）。 */
function vendorFromBaseUrl(baseUrl) {
  const b = (baseUrl || '').replace(/\/$/, '').toLowerCase();
  if (!b) return 'openai';
  for (const [key, v] of Object.entries(VENDORS)) {
    if (v.baseUrl && v.baseUrl.toLowerCase().replace(/\/$/, '') === b) return key;
  }
  return 'custom';
}

/** 应用某个供应商预设到表单（填 Base URL、模型示例、获取 Key 链接）。 */
function applyVendor(vendorKey, { overwriteModel = false } = {}) {
  const v = VENDORS[vendorKey] || VENDORS.custom;
  const isCustom = vendorKey === 'custom';
  $('#stBaseUrl').value = isCustom ? $('#stBaseUrl').value : v.baseUrl;
  $('#stBaseUrl').readOnly = !isCustom && vendorKey !== 'openai' ? false : false; // 始终允许编辑，仅自动填默认
  // 模型名：仅在用户没填或要求覆盖时给出第一个示例
  if ((overwriteModel || !$('#stModel').value.trim()) && v.models.length) {
    $('#stModel').value = v.models[0];
  }
  $('#modelHints').innerHTML = v.models.map((m) => `<option value="${m}">`).join('');
  const applyLink = v.apply ? ` ｜ <a href="${v.apply}" target="_blank" rel="noreferrer">获取 ${v.name} 的 Key →</a>` : '';
  const urlNote = isCustom ? '自定义：请手动填写接口地址（OpenAI 兼容则填到 /v1）。' : `已自动填入 ${v.name} 的接口地址。`;
  $('#stVendorHint').innerHTML = `${urlNote}粘贴对应平台的 Key 即可。${applyLink}`;
}

$('#stVendor').addEventListener('change', (e) => applyVendor(e.target.value, { overwriteModel: true }));

async function loadSettings() {
  const c = await api('/settings');
  $('#stBaseUrl').value = c.baseUrl || '';
  $('#stModel').value = c.model || '';
  // 回填供应商下拉框 + 提示（不覆盖已保存的模型名）
  const vendor = vendorFromBaseUrl(c.baseUrl);
  $('#stVendor').value = vendor;
  applyVendor(vendor, { overwriteModel: false });
  $('#stSchedEnabled').checked = !!c.schedule.enabled;
  $('#stSchedTime').value = c.schedule.time || '09:00';
  const wm = (c.schedule.window || 'last_1_day').match(/last_(\d+)_days?/);
  $('#stSchedDays').value = wm ? Number(wm[1]) : 1;
  $('#stBudget').value = c.budgetDailyTokens || 0;
  $('#stToken').textContent = c.pairingToken;
  $('#stEndpoint').textContent = `http://127.0.0.1:${PORT}`;
  $('#stKeyState').textContent = c.hasApiKey ? `已配置（末4位 ${c.apiKeyLast4}）` : '未配置';
  $('#stKeyState2').textContent = c.hasApiKey2 ? `已配置（末4位 ${c.apiKey2Last4}）` : '未配置';
  renderKeyState(c.hasApiKey, c.schedule);
}
$('#stSaveKey').addEventListener('click', async () => {
  const apiKey = $('#stApiKey').value.trim();
  if (!apiKey) return toast('请粘贴 API Key', 'bad');
  // 先持久化接口地址/模型，再存 Key——否则刚选的供应商地址还没落库，
  // setApiKey 会用旧地址推断 provider（小米的 Key 配 DeepSeek 地址 = 401）。
  await api('/settings', { method: 'PUT', body: JSON.stringify({ baseUrl: $('#stBaseUrl').value.trim(), model: $('#stModel').value.trim() }) });
  await api('/settings/apikey', { method: 'POST', body: JSON.stringify({ apiKey }) });
  $('#stApiKey').value = ''; toast('已保存接口地址 + Key（加密存储）', 'ok'); loadSettings(); loadOverview();
});
$('#stClearKey').addEventListener('click', async () => {
  if (!confirm('确认清除已保存的 API Key？')) return;
  await api('/settings/apikey', { method: 'DELETE' }); toast('已清除'); loadSettings(); loadOverview();
});
$('#stSaveKey2').addEventListener('click', async () => {
  const apiKey = $('#stApiKey2').value.trim();
  if (!apiKey) return toast('请粘贴备用 API Key', 'bad');
  await api('/settings/apikey2', { method: 'POST', body: JSON.stringify({ apiKey }) });
  $('#stApiKey2').value = ''; toast('备用 Key 已保存', 'ok'); loadSettings();
});
$('#stClearKey2').addEventListener('click', async () => {
  if (!confirm('确认清除备用 API Key？')) return;
  await api('/settings/apikey2', { method: 'DELETE' }); toast('已清除'); loadSettings();
});
$('#stTestKey').addEventListener('click', async () => {
  toast('测试中…');
  try {
    const r = await api('/settings/test', { method: 'POST' });
    $('#stTestDetail').textContent = r.ok
      ? `当前调用：${r.provider || '—'} ｜ ${r.baseUrl || '—'} ｜ 模型 ${r.model}`
      : '';
    toast(r.ok ? `连通正常（模型 ${r.model}）` : '测试失败：' + r.error, r.ok ? 'ok' : 'bad');
  } catch (e) {
    $('#stTestDetail').textContent = '';
    toast('测试失败：' + e.message, 'bad');
  }
});
$('#stSaveSettings').addEventListener('click', async () => {
  const body = {
    baseUrl: $('#stBaseUrl').value.trim(),
    model: $('#stModel').value.trim(),
    budgetDailyTokens: Number($('#stBudget').value) || 0,
    schedule: {
      enabled: $('#stSchedEnabled').checked,
      time: $('#stSchedTime').value || '09:00',
      window: windowStr($('#stSchedDays').value),
    },
  };
  await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
  toast('设置已保存', 'ok'); loadOverview();
});
$('#stCopyToken').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#stToken').textContent); toast('已复制 token');
});
$('#stRegenToken').addEventListener('click', async () => {
  if (!confirm('重置后，已配对的插件需要重新填入新 token。继续？')) return;
  const r = await api('/settings/pairing/regenerate', { method: 'POST' });
  TOKEN = r.pairingToken; // 同步更新内存中的 token，后续请求与导出链接都用新值
  $('#stToken').textContent = r.pairingToken; toast('已重置 token，请更新插件设置', 'ok');
});

// ---------------------------------------------------------------- boot ----
const loaders = {
  overview: loadOverview, candidates: loadCandidates, library: loadLibrary,
  accounts: loadAccounts, reports: loadReports, settings: loadSettings,
};
loadOverview().catch((e) => toast('加载失败：' + e.message, 'bad'));
