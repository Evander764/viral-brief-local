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
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

$('#ovGenerate').addEventListener('click', () => generateReport($('#ovWindow').value, $('#ovGenMsg')));

async function generateReport(win, msgEl) {
  msgEl.textContent = '生成中…（首次/有新内容时会调用 AI，请稍候）';
  try {
    const r = await api('/reports/generate', { method: 'POST', body: JSON.stringify({ window: win }) });
    msgEl.textContent = `完成：达标 ${r.eligibleCount} 条 ${r.aiUsed ? '' : '（0 达标，未调用 AI）'}`;
    toast('日报已生成', 'ok');
    loadReports();
  } catch (e) {
    msgEl.textContent = '';
    toast('生成失败：' + e.message, 'bad');
  }
}

// ---------------------------------------------------------------- candidates ----
async function loadCandidates() {
  const accounts = await getAccountsCache();
  const all = [];
  for (const st of ['needs_review', 'missing_share', 'missing_like', 'below_threshold']) {
    const rows = await api(`/contents?status=${st}`);
    all.push(...rows);
  }
  $('#candList').innerHTML = all.length
    ? all.map((it) => itemCard(it, accounts)).join('')
    : '<p class="muted">暂无待处理内容。用浏览器插件「保存当前内容」后会出现在这里。</p>';
  bindItemCards($('#candList'));
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

function itemCard(it, accounts) {
  const shot = it.screenshot_path
    ? `<img class="shot" src="/screenshots/${esc(it.screenshot_path.split('/').pop())}" alt="截图" />`
    : '<div class="shot"></div>';
  return `<div class="item" data-id="${it.id}">
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

function bindItemCards(root) {
  $$('.item', root).forEach((card) => {
    const id = card.dataset.id;
    const collect = () => {
      const o = {};
      $$('[data-f]', card).forEach((inp) => {
        const f = inp.dataset.f;
        if (f.endsWith('_count')) o[f] = inp.value === '' ? '' : inp.value;
        else o[f] = inp.value;
      });
      return o;
    };
    card.querySelector('[data-act="confirm"]').addEventListener('click', async () => {
      try {
        const c = await api(`/contents/${id}/confirm`, { method: 'POST', body: JSON.stringify(collect()) });
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
}

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
  $('#acTable').innerHTML = rows.length ? `
    <table><thead><tr><th>平台</th><th>昵称</th><th>分类</th><th>优先级</th><th>巡检</th><th>主页</th><th></th></tr></thead><tbody>
    ${rows.map((a) => `<tr>
      <td>${PLATFORM_LABEL[a.platform] || a.platform}</td><td>${esc(a.nickname)}</td>
      <td>${esc(a.category)}</td><td>${esc(a.priority)}</td><td>${a.monitor_enabled ? '是' : '否'}</td>
      <td>${a.homepage_url ? `<a href="${esc(a.homepage_url)}" target="_blank" rel="noreferrer">打开</a>` : '—'}</td>
      <td><button data-del="${a.id}">删除</button></td>
    </tr>`).join('')}
    </tbody></table>` : '<p class="muted">还没有账号。手动添加或导入 CSV。</p>';
  $$('#acTable [data-del]').forEach((b) => b.addEventListener('click', async () => {
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

// ---------------------------------------------------------------- reports ----
async function loadReports() {
  const rows = await api('/reports');
  $('#rpList').innerHTML = rows.length ? rows.map((r) => `
    <div class="item"><div class="body">
      <div class="t">${r.report_date} ｜ ${r.window_type === 'last_7_days' ? '最近7天' : '最近3天'} ｜ 达标 ${r.eligible_count} 条</div>
      <div class="sub">生成于 ${new Date(r.created_at).toLocaleString('zh-CN')}</div>
      <div class="actions">
        <a class="filebtn" href="/api/reports/${r.id}/export?format=html&inline=1&token=${TOKEN}" target="_blank">查看日报</a>
        <a class="filebtn" href="/api/reports/${r.id}/export?format=md&token=${TOKEN}">导出 Markdown</a>
        <a class="filebtn" href="/api/reports/${r.id}/export?format=csv&token=${TOKEN}">导出 CSV</a>
      </div>
    </div></div>`).join('') : '<p class="muted">还没有日报。点上方「生成日报」。</p>';
}
$('#rpGenerate').addEventListener('click', () => generateReport($('#rpWindow').value, $('#rpMsg')));

// ---------------------------------------------------------------- settings ----
async function loadSettings() {
  const c = await api('/settings');
  $('#stProvider').value = c.provider;
  $('#stModel').value = c.model || '';
  $('#stReportModel').value = c.reportModel || '';
  $('#stBaseUrl').value = c.baseUrl || '';
  $('#stSchedEnabled').checked = !!c.schedule.enabled;
  $('#stSchedTime').value = c.schedule.time || '09:00';
  $('#stSchedWindow').value = c.schedule.window || 'last_3_days';
  $('#stBudget').value = c.budgetDailyTokens || 0;
  $('#stToken').textContent = c.pairingToken;
  $('#stEndpoint').textContent = `http://127.0.0.1:${PORT}`;
  $('#stKeyState').textContent = c.hasApiKey ? `已配置（末4位 ${c.apiKeyLast4}）` : '未配置';
  renderKeyState(c.hasApiKey, c.schedule);
}
$('#stSaveKey').addEventListener('click', async () => {
  const apiKey = $('#stApiKey').value.trim();
  if (!apiKey) return toast('请粘贴 API Key', 'bad');
  await api('/settings/apikey', { method: 'POST', body: JSON.stringify({ apiKey }) });
  $('#stApiKey').value = ''; toast('已保存（加密存储）', 'ok'); loadSettings(); loadOverview();
});
$('#stClearKey').addEventListener('click', async () => {
  if (!confirm('确认清除已保存的 API Key？')) return;
  await api('/settings/apikey', { method: 'DELETE' }); toast('已清除'); loadSettings(); loadOverview();
});
$('#stTestKey').addEventListener('click', async () => {
  toast('测试中…');
  try {
    const r = await api('/settings/test', { method: 'POST' });
    toast(r.ok ? `连通正常（模型 ${r.model}）` : '测试失败：' + r.error, r.ok ? 'ok' : 'bad');
  } catch (e) { toast('测试失败：' + e.message, 'bad'); }
});
$('#stSaveSettings').addEventListener('click', async () => {
  const body = {
    provider: $('#stProvider').value,
    model: $('#stModel').value.trim(),
    reportModel: $('#stReportModel').value.trim(),
    baseUrl: $('#stBaseUrl').value.trim(),
    budgetDailyTokens: Number($('#stBudget').value) || 0,
    schedule: {
      enabled: $('#stSchedEnabled').checked,
      time: $('#stSchedTime').value || '09:00',
      window: $('#stSchedWindow').value,
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
