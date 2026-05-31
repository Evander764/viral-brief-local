# 📡 爆款选题雷达 Local

> 本地内容情报工作台：浏览器插件采集 + 本地服务筛选 + AI 每日爆款选题日报。
> **零原生依赖、零数据库安装、接入 API Key 即可每天自动产出日报。**

每天自动获取「每日爆款选题」——来自你账号池里关注的商业博主，在**视频号 / 小红书 / 抖音**上，
**点赞 ≥ 1000 且 转发/分享 ≥ 1000** 的内容，由 AI 聚类、提炼、给出可复用选题与商业承接建议。

本项目按内部实施计划（《每日爆款选题雷达 Local - 实施计划》）落地，定位为**本地浏览辅助 + 内容保存 + 指标确认 + AI 总结**工具，不是批量爬虫。

---

## 目录
- [它能做什么](#它能做什么)
- [架构](#架构)
- [快速开始](#快速开始-5-分钟)
- [安装浏览器插件](#安装浏览器插件)
- [日常使用流程](#日常使用流程)
- [核心规则：双 1000 与数据状态](#核心规则双-1000-与数据状态)
- [Token 策略：又省又准](#token-策略又省又准)
- [自动运行](#自动运行)
- [API Key 安全](#api-key-安全)
- [支持的模型供应商](#支持的模型供应商)
- [合规边界](#合规边界v1-不做什么)
- [项目结构](#项目结构)
- [测试](#测试)
- [常见问题](#常见问题)
- [打包成桌面 App（可选）](#打包成桌面-app可选)

---

## 它能做什么

1. **浏览时一键保存**：在抖音/小红书/视频号看到好内容，点插件「保存当前内容」，自动抓取标题、作者、可见指标并截图。
2. **人工确认指标**：在桌面端「今日候选」里核对/补录点赞、转发数（保证关键数据准确）。
3. **确定性硬筛选**：系统按「账号池三平台」+「最近 3 天 / 7 天」+「点赞≥1000 且 转发≥1000」自动筛出达标内容（**纯代码判定，绝不靠 AI 猜**）。
4. **AI 生成日报**：对达标内容做选题拆解、母题聚类、爆点分析、改写标题、商业承接建议。
5. **自动运行 + 导出**：接入 API Key 后每天定时自动产出日报，支持导出 Markdown / HTML（可打印为 PDF）/ CSV。

---

## 架构

三层结构，全部本地运行：

```
┌─────────────────────┐   POST /api/capture    ┌──────────────────────────────┐
│  浏览器插件 (MV3)    │ ─────────────────────► │  本地服务（桌面端大脑）       │
│  抓取/截图/人工修正  │   127.0.0.1 + token    │  Node + node:sqlite          │
└─────────────────────┘                        │  ・SQLite 本地库              │
                                               │  ・确定性筛选引擎（双1000）   │
┌─────────────────────┐   浏览器访问            │  ・AI 分析/日报（BYOK）       │
│  本地仪表盘 (Web UI) │ ◄───────────────────── │  ・每日自动调度器             │
│  候选池/内容库/设置  │   http://127.0.0.1     │  ・Markdown/HTML/CSV 导出     │
└─────────────────────┘                        └──────────────────────────────┘
```

**技术选型**：Node.js（内置 `node:sqlite`、内置 `fetch`）→ **运行时零 npm 依赖、零原生编译**，真正「拿起来就能跑」。

---

## 快速开始（5 分钟）

### 前置条件
- **Node.js ≥ 22.5.0**（推荐 22 LTS 或更高；用到内置的 `node:sqlite`）。检查：`node -v`

### 启动桌面端
```bash
cd "Viral Brief"
npm start
```
启动后会自动打开仪表盘 `http://127.0.0.1:8787`（不想自动打开浏览器：`VB_OPEN_BROWSER=false npm start`）。

### 首次配置（在仪表盘「设置」里）
1. **AI API Key**：填模型名（如 `deepseek-chat` / `gpt-4o-mini` / `claude-haiku-4-5`）、可选填 Base URL，粘贴你的 API Key → 「保存 Key」→ 「测试调用」确认连通。Key 会 **AES-256-GCM 加密**存储在本地。
   - **供应商自动识别**：无需手动选——系统按 Key 前缀和 Base URL 自动判断是 OpenAI / OpenAI 兼容（DeepSeek、硅基流动、通义…）/ Anthropic。
   - **备用 Key（可选）**：可再填一个备用 Key，主 Key 调用失败时自动回退，保证日报不因单点故障而中断。
2. **自动运行**：勾选「开启每日自动生成」，设定时间（如 09:00）与默认回溯天数（1–30 天，默认 1 天）→「保存设置」。
3. **配对 token**：复制「浏览器插件配对」里的 token（安装插件时要用）。
4. **账号池**：导入/添加你关注的商业博主（模板见 `scripts/seed-accounts.example.csv`），也可以在「手动多行导入」里反复粘贴多行账号；重复的平台+昵称会更新，不会越导越多。也可用 **「AI 检索」** 输入博主名/关键词让 AI 推荐账号信息再勾选导入。**内容必须关联账号池后才会进入正式日报。**

> 没有 API Key 也能用：采集、确认、硬筛选、查看候选都正常；只有「生成 AI 日报」和「AI 检索账号」这两步需要 Key。

---

## 安装浏览器插件

支持 Chrome / Edge。

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本项目的 `extension/` 目录。
4. 点插件图标 → 「配置桌面端连接」（或扩展的「选项」），填：
   - 本机服务地址：`http://127.0.0.1:8787`
   - 配对 token：粘贴仪表盘「设置」里显示的 token
   - 点「测试连接」应显示成功。

---

## 日常使用流程

```
浏览一条视频/笔记
   └─ 点插件「保存当前内容」（自动抓取+截图，可手动修正点赞/转发）
        └─ 进入桌面端「今日候选池」（状态：待复核/缺转发数…）
             └─ 在候选池关联账号池、核对指标并「确认入库」（→ confirmed）
                  └─ 系统按 3天/7天 + 双1000 自动判定是否达标
                       └─ 「生成日报」或等每日自动运行
                            └─ AI 聚类 + 选题提炼 → 导出 MD/HTML/CSV
```

**为什么需要人工确认？** 平台展示的「1.2w」「1000+」等需要标准化，且不同平台「转发/分享」口径不一、有时不可见。
人工点一下「确认」，关键数据才被信任——这是日报可信的根基。

---

## 核心规则：双 1000 与数据状态

入选正式日报的**硬条件**（确定性代码判定，见 `server/filter.js`）：

```
publish_time 在窗口内（最近 3 天 = 滚动 72h / 最近 7 天 = 滚动 7×24h）
AND platform ∈ {douyin, xiaohongshu, wechat_channels}
AND account_id 关联到 accounts（你关注的商业博主账号池）
AND content_type ∈ {video, article}
AND like_count  >= 1000
AND share_count >= 1000
AND data_status == 'confirmed'
```

**指标标准化**（`server/normalize.js`，含单元测试）：`1.2w → 12000`、`1万+ → 10000`、`1000+ → 1000`、`12,300 → 12300`、全角数字……
**识别不到的指标返回 `null`（未知），而不是 0** —— 这决定了内容是「待补录」还是「确定不达标」，二者绝不能混。

**数据状态分层**：

| 状态 | 含义 | 能否入正式日报 |
|---|---|---|
| `confirmed` | 点赞与转发均已确认且 ≥1000 | ✅ 可以 |
| `missing_share` | 点赞达标但转发数缺失/不可见 | ❌ 待补录 |
| `missing_like` | 转发达标但点赞数缺失 | ❌ 待补录 |
| `below_threshold` | 任一已知指标 < 1000 | ❌ |
| `needs_review` | 自动识别、未经人工确认 | ❌ 需人工复核 |
| `duplicate` | 与已有内容重复（按 URL / 平台+作者+标题 去重） | ❌ 合并 |

> **无法确认就不入榜**：平台不展示转发数的内容停留在「待补录」，绝不会被自动算成达标。

---

## Token 策略：又省又准

把数据分成两类，**同时**做到「省 token」和「关键数据绝不出错」：

**硬数据 = 纯代码，零 AI、零 token**
点赞/转发数、双 1000 判定、去重、时间窗口、达标清单里的每个数字 —— 全部由确定性代码计算。
AI **永远不参与**「是否达标」的判断，所以关键数据不可能因模型幻觉而错，而且这部分**一分钱不花**。

**软分析 = 才用 AI**
选题提炼、爆点分析、母题聚类、改写标题、商业承接建议 —— AI 在这里才有价值。

**省 token 的具体做法**
- 只分析「已确认且达标」的内容，垃圾内容永远不进 API。
- 每条分析按 `content_id` **永久缓存**，已分析过的不再花钱。
- **0 达标时完全跳过 AI**（连日报模型都不调）。
- 日报阶段只喂「选题/钩子/标题/真实计数」的精简摘要，不喂全文。
- 系统提示词稳定且靠前：Anthropic 显式打 **prompt cache**，OpenAI 自动命中前缀缓存。
- 分析与日报可分别配置模型（分析用便宜的，日报用更强的）。

**保正确的具体做法（这里宁可多花）**
- AI 返回的 JSON 强制**校验 + 失败重试**，直到拿到合法结构。
- **日报里的数字一律从数据库重新渲染，绝不采信 AI 文本**——即便模型乱写数字，清单也是对的。
- 校验 AI 引用的内容编号必须真实存在，杜绝编造来源。
- 今日 token 用量在「概览」实时可见；可设每日预算提醒（仅提醒，不为省钱牺牲日报完整性）。

---

## 自动运行

在「设置 → 自动运行」开启后：
- 每天到点自动跑完整管线（刷新状态 → 硬筛选 → 分析新达标内容 → 生成日报 → 导出文件）。
- 进程重启后，若当天计划时间已过且尚未运行，会**自动补跑一次**。
- 也可命令行手动触发（适合接系统 cron）：
  ```bash
  npm run report -- last_7_days     # 或 last_3_days（默认）
  ```

导出的文件在 `data/exports/`，每份日报会同时生成 Markdown / HTML / CSV / ZIP 压缩包。数据库在 `data/viral-brief.db`，截图在 `data/screenshots/`。

---

## API Key 安全

遵循实施计划第 6.3 / 12.3 节：
- **桌面端保存 Key，浏览器插件绝不保存、绝不直接调模型。**
- Key 用 **AES-256-GCM 加密**存储（密钥在 `data/.keyfile`，权限 0600）。
- 日志/错误信息中**永不打印完整 Key**，只在界面显示末 4 位。
- 导出配置不含 Key；可一键清除 Key。
- 服务只监听 `127.0.0.1`，所有 `/api`（除健康检查）需要**配对 token**，防止其他网页越权调用。

> 更强方案：接入 OS 钥匙串（macOS Keychain / Windows Credential Manager）。当前实现已满足「配置文件必须加密存储」的要求，钥匙串可作为后续增强。

---

## 支持的模型供应商

BYOK（自带 Key）。在「设置 → 供应商」**下拉选一家，接口地址会自动填好**，你只需粘贴对应平台的 Key、填模型名。选「自定义」可手填任意 OpenAI/Anthropic 兼容地址。

| 供应商 | 接口地址 Base URL | 模型名示例 |
|---|---|---|
| OpenAI（官方） | 留空（= `https://api.openai.com/v1`） | `gpt-4o-mini` / `gpt-4o` |
| DeepSeek 深度求索 | `https://api.deepseek.com` | `deepseek-chat` / `deepseek-reasoner` |
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | `mimo-v2-flash` / `mimo-v2-pro` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` / `kimi-k2-0905-preview` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` / `glm-4-plus` |
| 通义千问（阿里百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` / `qwen-turbo` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` … |
| Anthropic Claude | `https://api.anthropic.com` | `claude-haiku-4-5` / `claude-sonnet-4-6` |

> **重要**：Key 必须和接口地址同一家——把小米的 Key 配到 DeepSeek 地址会报 401「认证失败」。用下拉选供应商可避免这种错配。
> 底层仍由 `server/config.js` 的 `inferProvider` 按地址/Key 前缀适配协议（官方 OpenAI 带 `response_format:json_object`，兼容接口不带；`sk-ant-` 或 anthropic 地址走 Anthropic 协议）。保存 Key 时会一并保存接口地址并立即重新识别，无需重启。

---

## 合规边界（V1 不做什么）

- ❌ 不做全网批量采集 / 平台私有接口调用 / App 逆向 / 抓包 / 验证码绕过 / 代理池 / 批量账号。
- ❌ 不承诺自动获得所有平台的转发/分享数；不可见时进入「待补录」。
- ❌ 不把不完整数据伪装成官方数据；日报会标注数据来源与置信度。
- ✅ 只处理用户主动打开/授权的公开可见信息。

---

## 项目结构

```
Viral Brief/
├── server/                 本地服务（桌面端大脑）
│   ├── index.js            HTTP 服务 + 静态托管 + 调度启动
│   ├── normalize.js        指标标准化（确定性）★
│   ├── filter.js           双1000 + 窗口 + 状态判定（确定性）★
│   ├── dedup.js            去重（确定性）★
│   ├── db.js / store.js    SQLite 架构 + 仓储层
│   ├── config.js           配置 + API Key 加解密
│   ├── pipeline.js         每日总结处理管线
│   ├── scheduler.js        每日自动运行
│   ├── report/render.js    JSON+DB → Markdown/HTML/CSV
│   ├── ai/                 prompts / client(多供应商) / analyze / report
│   └── lib/                paths / log(脱敏) / secret(AES)
├── web/                    本地仪表盘（index.html / app.js / styles.css）
├── extension/              Chrome MV3 插件（manifest / popup / options）
├── scripts/                run-report.js（CLI） + 账号池 CSV 模板
├── test/                   单元测试（normalize / filter / dedup / render）
└── data/                   运行时数据（库/截图/导出/配置，已 gitignore）
```

★ = 关键数据正确性的确定性核心，均有单元测试覆盖。

---

## 测试

```bash
npm test
```
81 个单元测试，覆盖：指标标准化（文档数据字典全部案例 + 边界）、双 1000 与各数据状态、去重、日报渲染（数字来自 DB、HTML 防 XSS、CSV BOM）、日报 ZIP 压缩包、日报记录删除、日报反幻觉护栏、采集入库与账号池自动关联、人工确认强制 manual、CSV/手动多行导入、配置 provider 自动识别 + API Key 加密/脱敏、AI 返回 JSON 的稳健解析。

> 关键数据正确性的确定性核心（normalize / filter / dedup）做了重点覆盖；AI 部分用真实 DeepSeek key 跑通过完整日报，并验证「日报数字全部来自 DB、单条分析命中缓存不重复计费」。

---

## 常见问题

- **端口被占用**：`VB_PORT=8888 npm start`（插件里的地址也要改成对应端口）。
- **插件「保存」失败**：确认桌面端已 `npm start`；插件「选项」里地址/token 是否与仪表盘一致；token 重置后需在插件里更新。
- **没识别到点赞/转发数**：各平台 DOM 经常改版，自动识别是「尽力而为」，**手动填写永远可用**（这也是设计原则：人确认数据）。视频号网页端指标多不可读，基本靠手填。
- **生成日报报「未配置 API Key」**：去「设置」填 Key 并测试通过。
- **想换数据目录**：`VB_DATA_DIR=/your/path npm start`。

---

## 打包成 Mac App

生成可双击运行的 macOS `.app`：

```bash
npm run package:mac
```

产物位置：
- `dist/mac/Viral Brief.app`：可直接双击启动。
- `dist/releases/*-mac.zip`：给其他 Mac 复制/分发用的压缩包。
- `dist/releases/*-source.tar.gz`：当前版本源码快照（排除 `data/`、`node_modules/`、`.git/`）。
- `dist/releases/*-manifest.txt`：本次打包清单。

运行要求：
- macOS 12 或更高版本。
- Node.js 22.5 或更高版本。

应用数据不会写进 `.app` 包内。双击启动后，本地数据库、配置、导出文件会保存在：

```text
~/Library/Application Support/Viral Brief
```

日志保存在：

```text
~/Library/Logs/Viral Brief
```

当前 `.app` 是轻量本地服务壳，保持零 npm 依赖。若后续需要完全免安装 Node 的发行版，可再引入 Tauri/Electron 或嵌入 Node runtime，但会增加包体和维护成本。

---

_判断这个工具是否成功，不看它抓了多少数据，而看它能否每天稳定产出「高质量、可复用、数据来源清晰可信」的爆款选题总结。_
