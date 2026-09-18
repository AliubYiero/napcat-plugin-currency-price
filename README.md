# 千岛通货价格 · NapCat 插件

定时抓取[千岛](https://qiandao.com)各游戏专区的通货价格，按**会话**的订阅关系推送到 QQ 群聊 / 私聊。

- 插件 ID: `napcat-plugin-currency-price`
- 支持平台: Windows / Linux
- 最低 NapCat 版本: `4.14.0`

## 它做什么

千岛的每个游戏专区（流放之路2、流放之路1、火炬之光……）都有自己的页面、自己的区服清单、自己的通货清单。
本插件用浏览器打开这些页面、逐区服切过去，把配置里指定的通货价格读下来，落到本地数据文件，再按需展示或推送。

- **订阅粒度是游戏**，不是区服。用户 `game add 流放之路2` 就订下了这个游戏，
  抓哪些区服组合由管理员在「分区配置」里决定。
- **推送是显式订阅**。装上插件不会自动往任何群发消息，必须有人在会话里 `notify on`。
- **数据有 5 分钟新鲜度窗口**。新鲜的数据直接复用，不重复起浏览器；
  数据是否"新鲜"同时看它是不是按**当前这份配置**抓的——刚改完区服组合就敲 `price`，
  端出来的不会是旧组合的价格。

## 指令

指令前缀固定为 `#currency`（开发期常量，不是配置项，见 [CONTEXT.md](CONTEXT.md)）。
单独发送前缀等同于 `#currency help`。

| 指令 | 权限 | 说明 |
|------|------|------|
| `#currency price` | 所有人 | 抓取并展示本会话订阅的全部游戏价格 |
| `#currency help` | 所有人 | 帮助（图片，无法渲染时降级为文本） |
| `#currency status` | 所有人 | 本会话的通知开关、已订阅游戏、各游戏数据时间 |
| `#currency game` | 所有人 | 列出可订阅的游戏，标出本会话已订阅的 |
| `#currency game add <游戏名...>` | 管理员 | 订阅游戏，可空格分隔多个 |
| `#currency game remove <游戏名...>` | 管理员 | 退订游戏，可空格分隔多个 |
| `#currency notify` | 所有人 | 查看本会话的定时推送开关 |
| `#currency notify on \| off` | 管理员 | 开启 / 关闭本会话的定时推送 |

### 权限档位

角色从消息事件**推导**，不维护"用户 → 权限"的配置表（超管名单除外）：

| 档位 | 来源 |
|------|------|
| `superAdmin` | 在 `adminUsers` 名单里。在别人的群里也能执行管理指令 |
| `privateUser` | 机器人的**好友**私聊（群临时会话、陌生人不算） |
| `admin` | 群主 / 群管理员（取消息事件里平台给的 `owner` / `admin`） |
| `user` | 其他所有人 |

指令失败一律**显式回复**（权限不足 / 未知指令 / 非法参数三类文案各不相同），
不采用静默策略，见 [ADR-0002](docs/adr/0002-explicit-failure-feedback-over-silence.md)。

### 展示格式

**一个游戏一条消息**，按会话的订阅顺序串行发出，相邻两条之间隔 `pushIntervalMs`：

```
「流放之路2」2026-09-18 21:00 实时千岛通货价格
【国服 / 赛季 / 普通】
 · 神圣石 1.23
【国际服 / 赛季 / 普通】
 · 神圣石 0.98
```

- 一个区服只有一条数据时不编号，用 ` · ` 打头。
- 价格为空或为 `0` 的行不展示，在末尾交代跳过了几条。
- 配置里写了、但站点上不存在的通货名**单独成行**——这是配置写错时唯一的可见信号。
- 本轮抓取失败、展示的是旧值时，标题带「（数据未更新）」。

## 安装

### 方式一：从 Release 安装（推荐）

从 [Releases](https://github.com/AliubYiero/napcat-plugin-currency-price/releases) 下载 zip，
解压到 NapCat 的插件目录后重载插件。

### 方式二：从源码构建

```bash
pnpm install
pnpm build          # 构建 WebUI + 插件后端
```

产物在 `packages/plugin/dist/`，把它复制到 NapCat 插件目录即可。

## 配置

### 通用配置项（NapCat 配置面板）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `true` | 关闭后不响应任何指令，也不做定时推送 |
| `adminUsers` | 空 | 超管 QQ 号，多个用英文逗号分隔 |
| `allowAtBotTrigger` | `true` | 允许 `@机器人 #currency help` 触发 |
| `pushIntervalMs` | `100` | 逐条推送之间的间隔。被 QQ 频控时调大 |
| `pushHours` | `0`~`23` 全选 | 在选中的整点抓取并推送（本地时间）。**清空 = 不推送**，是合法配置 |
| `chromeExecutablePath` | 空 | 浏览器可执行文件路径。留空走自动检测，仅在检测失败时手填 |

### 分区配置（插件页面 →「分区配置」）

`catalogs` 含 `zoneConfigs: string[][]`，NapCat 的配置 Schema 没有数组 / 表格控件，
因此它**不在配置面板里**，唯一的编辑入口是插件 WebUI 的「分区配置」页。

每个游戏一条配置：

| 字段 | 说明 |
|------|------|
| `name` | 游戏名。同时是数据文件的键与 `game add <游戏名>` 的参数，**精确匹配** |
| `pageUrl` | 站点页面 URL，**原样存整条**（含六个 query 参数），从浏览器地址栏复制即可 |
| `currencyList` | 要抓的通货名，与站点名称精确匹配 |
| `zoneConfigs` | 要抓的区服组合，**层数随游戏而变**（流放之路 3 级、火炬之光 2 级） |

默认配置里预置了三个游戏：

| 游戏 | 区服组合 | 通货 |
|------|----------|------|
| 流放之路2 | 国服 / 赛季 / 普通、国际服 / 赛季 / 普通 | 神圣石 |
| 流放之路1 | 国服 / 赛季 / 普通、国际服 / 赛季 / 普通 | 神圣石 |
| 火炬之光 | 赛季 / 普通、赛季 / 专家 | 初火源质 |

> ⚠️ **各游戏的 `currencyList` 彼此不通用**。同名通货跨游戏是独立数据，
> 站点上各专区提供的通货本就不同——把流放之路2 的清单照抄给流放之路1，
> 表现是**静默产出 0**（名称匹配不上，不报错）。

## 数据文件

全部落在 NapCat 的插件数据目录（`ctx.dataPath`）下：

```
data.json                      # 各游戏最新价格（含游戏级 readAt 与配置指纹）
state.json                     # 会话订阅关系：谁开了通知、订了哪些游戏
archive/
├── 2026-09-18.json            # 当天：按 run 实时追加
└── 2026-09-17.json.gz         # 次日起：gzip 压缩，30 天后删除
```

- `data.json` —— "各游戏现在值多少" + 最近一次抓取尝试的失败原因。**失败不覆盖**已成功的数据。
- `state.json` —— 纯订阅关系表，不含任何时间戳。
- `archive/` —— `data.json` 的历史切片，结构与 `data.json` 的 `games` 同构。
  维护任务挂在 `plugin_init` 与每次成功抓取之后，**不依赖调度器**——
  插件被停用或 `pushHours` 为空时归档照样压缩清理。

## 浏览器

抓取依赖一个 Chromium 内核浏览器。检测顺序：

1. 配置项 `chromeExecutablePath`（用户显式指定的排最前）
2. **共享安装路径**：`%LOCALAPPDATA%\napcat-chrome\`（Windows）/ `$XDG_DATA_HOME/napcat-chrome/`（Linux，缺省 `~/.local/share`）
3. 系统浏览器常见路径（Linux 的 `google-chrome` / `chromium` 等，Windows 的 Chrome / Edge）

三条都没命中时，在插件 WebUI 点「安装浏览器」，会从官方源（失败则回退 npmmirror 镜像）
下载 Chrome for Testing 到共享安装路径——该路径**不含插件名**，装的浏览器其它 NapCat 插件也能用。

> Chrome 下载与完整检测（会真的起一个浏览器进程）都**只由 WebUI 显式触发**；
> 指令里的 `status` 只读缓存，不会拉起浏览器。

## 开发

```bash
pnpm install
pnpm build              # 构建 WebUI + 插件后端
pnpm dev:webui          # WebUI 开发服务器（纯前端开发用）
pnpm watch              # 监听插件后端，重新构建即自动部署 + 热重载
pnpm typecheck          # 类型检查
pnpm help:generate      # 重新生成帮助文本（改动指令后必跑）
pnpm --filter napcat-plugin-currency-price test    # 单元测试
```

热重载依赖 `napcat-plugin-debug` 插件，连接地址读根目录 `.env`：

```env
WS_URL=ws://192.168.1.100:8998
TOKEN=your-token
```

> **改指令前缀或指令表之后必须重跑 `pnpm help:generate`**：前缀被烧进帮助文本与帮助图片，
> 不重跑就会出现"帮助里写的指令敲不出来"。前缀本身只能由开发者改
> `packages/plugin/src/config.ts` 的 `DEFAULT_CONFIG.commandPrefix`，清洗层刻意忽略外部输入。

> `pnpm watch` 只监听插件后端。改完 WebUI 需先 `pnpm --filter @napcat-plugin-template/webui build`。
> 验证以 **vite build** 为准，`typecheck` 可能报 napcat-types 包自身的语法错误，与本项目代码无关。

### 项目结构

```
packages/
├── plugin/                     # 插件后端（发布物）
│   ├── src/
│   │   ├── index.ts            # 生命周期入口
│   │   ├── config.ts           # 默认配置、内置游戏清单、配置 Schema
│   │   ├── core/               # 全局状态单例 / 角色推导 / 会话键
│   │   ├── handlers/           # 消息处理：指令注册表与分发、各指令 handler
│   │   ├── services/           # 抓取、渲染、调度、推送、归档维护、浏览器
│   │   ├── store/              # data.json / state.json / archive 读写
│   │   └── utils/
│   ├── scripts/generateHelp/   # 帮助文本生成（权威源 → helpText.generated.ts）
│   └── tests/                  # vitest
├── webui/                      # React SPA（仪表盘 / 分区配置 / 群管理 / 配置）
└── shared/                     # 前后端共享类型（单一事实来源）
```

### 参考文档

| 文档 | 内容 |
|------|------|
| [CONTEXT.md](CONTEXT.md) | 领域术语的唯一权威（游戏 / 区服 / 通货 / 数据新鲜度 / 配置指纹……） |
| [docs/design.md](docs/design.md) | 设计意图的长期权威 |
| [docs/index.md](docs/index.md) | 开发范式体系入口 |
| [docs/adr/](docs/adr/) | 架构决策记录 |

## CI/CD

推送 `v*` 格式的 tag 会自动构建并创建 Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

也可在 GitHub Actions 页面手动触发，可选填版本号。

Release Note 支持由 AI 按 `.github/prompt/release_note_prompt.txt` 从 commit 记录生成：
配置仓库 Secrets 里的 `AI_API_URL` / `AI_API_KEY`（可选 `AI_MODEL`，默认 `gpt-4o-mini`，
需为兼容 OpenAI 格式的接口）即启用；未配置或调用失败时自动回退到
`.github/prompt/default.md` 模板，不会阻断发布。

## 许可证

MIT License
