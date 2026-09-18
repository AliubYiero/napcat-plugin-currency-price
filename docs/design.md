# 千岛通货价格插件 — 设计文档

> **状态**: 定稿, 可进入实现。
> **前身**: 抓取源项目 (`qiandao`) 的一次性 Node 脚本 `src/index.js` + 本设计草稿的 5 轮评审。
> **必读前置**: [CONTEXT.md](../CONTEXT.md) (术语)、[docs/index.md](./index.md) (范式体系)、[ADR-0001](./adr/0001-page-click-over-direct-api.md) (**不可违背**)。

本文件是设计意图的长期权威。术语以 `CONTEXT.md` 为准; 实现范式以 `docs/*-pattern.md` 为准; 与本文冲突时, 先校对再改, 不要默默按其中一方写代码。

---

## 1. 目标

把一次性抓取脚本改造成 NapCat 插件：

1. **定时推送**：在配置的整点集合上抓取并推送，默认每小时。
2. **按需刷新**：`#currency price` 只重新抓「数据已过期」的游戏，新鲜的直接复用。
3. **多会话订阅**：群聊 / 私聊各自独立地开关通知、订阅游戏。
4. **一键可用**：WebUI 检测并安装浏览器，用户不需要碰 Node 依赖或浏览器配置。
5. **数据留档**：按日归档，次日 gzip，保留 1 个月。

## 2. 非目标

- 不做价格趋势分析 / 图表。
- 不做历史价格的查询指令（只保留归档文件）。
- 不支持多语言（仅中文）。
- 不做定时与手动以外的触发源（如 WebHook）。
- **不改抓取策略**：仍走页面点击，不直连接口（见 ADR-0001）。
- 不做远程浏览器连接（`wsEndpoint`）、页面并发、浏览器健康检查——本插件一次抓取只开 1 个 context、1 个 page，串行走完即关。

---

## 3. 插件身份

```json
{
  "name": "napcat-plugin-currency-price",
  "plugin": "千岛通货价格",
  "description": "定时抓取千岛各游戏的通货价格并推送到群聊 / 私聊",
  "napcat": {
    "tags": ["工具"],
    "minVersion": "4.14.0",
    "homepage": "https://github.com/AliubYiero/napcat-plugin-currency-price"
  }
}
```

---

## 4. 领域基线

术语见 [CONTEXT.md](../CONTEXT.md), 此处只重申三条会直接影响实现的：

- **游戏 是订阅与开关的粒度**；区服组合是抓取粒度；通货是最小单位。**同名通货跨游戏独立**。
- **区服层数随游戏而变**（流放之路 3 级、火炬之光 2 级）。代码不得假设固定层数。
- **数据新鲜度阈值**（`5 分钟`）判断的是"某游戏的数据要不要重抓", 依据是该游戏**自己的 `readAt`**——不是全局时间戳, 也不是"用户能不能发指令"。

---

## 5. 配置

### 5.1 `PluginConfig`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | 插件总开关 |
| `debug` | `boolean` | `false` | 调试日志 |
| `commandPrefix` | `string` | `#currency` | 指令前缀, 运行期可改 |
| `adminUsers` | `string[]` | `[]` | 超管 QQ 号名单。WebUI 以逗号分隔文本输入, 清洗层一次性转数组 |
| `allowAtBotTrigger` | `boolean` | `true` | 允许 `@机器人 + 指令` 触发 (见 [instruction-pattern](./instruction-pattern.md) 1.1) |
| `catalogs` | `CatalogConfig[]` | 现有三分区 | 游戏配置。**不生成 Schema 控件**, 由自定义 WebUI 页编辑 |
| `pushHours` | `number[]` | `[0..23]` | 整点推送的小时集合 (本地时间, 取值 `0`~`23`)。**空数组 = 不做定时推送**, 是合法语义 |
| `pushIntervalMs` | `number` | `100` | 逐条推送之间的间隔。频控边界在 QQ 服务端, 因部署而异 |
| `chromeExecutablePath` | `string` | `''` | 手动指定的浏览器路径; 为空则走检测顺序 |
| `groupConfigs` | `Record<string, GroupConfig>` | `{}` | 会话级启用开关, 判定式 `enabled !== false` (默认开启) |

**从模板删除**：`cooldownSeconds`。指令冷却的语义已被"数据新鲜度阈值"取代, 两者混用会让用户以为自己在被限流。

### 5.2 `CatalogConfig`

```ts
interface CatalogConfig {
    name: string;             // 游戏名。同时是 data.json 的键与指令参数 `game add <游戏名>`
    pageUrl: string;          // 站点页面 URL, **原样存整条**(含 catalogName/islandId/tagIds/... 六个 query 参数)
    currencyList: string[];   // 要抓的通货名, 与站点名称**精确匹配**
    zoneConfigs: string[][];  // 要抓的区服组合, 层数随游戏而变
}
```

**为什么 `pageUrl` 原样存**：那几个 query 参数是站点改版时最先变的东西。拆成结构字段会让"从浏览器复制一条 URL"变成手工拆解六个参数, 更容易错。`specId` 本来就不进配置(运行时从级联接口解析), 说明配置的定位是"声明去哪抓", 而非"声明站点的内部结构"。

**`catalogs` 为什么不走 Schema 控件**：NapCat 的配置 Schema 只有 `boolean/text/number/select/multiSelect/html/combine`, **没有数组或表格控件**, `zoneConfigs` 是 `string[][]`, 表达不出来。它仍然走[配置范式](./config-pattern.md)的四环节(类型 / 默认值 / 清洗 / 运行时读写), 只是编辑入口换成自定义 WebUI 页。

### 5.3 清洗

`catalogs` 与 `pushHours` 都是**数组**：`pushHours` 是枚举数组(过滤非法值, **空数组合法**), `catalogs` 是嵌套对象数组(逐字段递归清洗, 整体不合法则丢弃该条目)。`catalogs` 的默认值见 §5.4——用户不改也能跑。

### 5.4 默认 `catalogs`（三分区）

即 `DEFAULT_CONFIG.catalogs`。

> ⚠️ 下面代码块里的注释是**实测得出的领域知识, 不是说明文字**。迁进 `config.ts` 时必须**原样保留**——它们是"为什么这份清单与隔壁那份不通用"的唯一记录。

```ts
const CATALOGS = [
	{
		name: '流放之路2',
		pageUrl:
			'https://qiandao.com/currency/currency-zone?catalogName=%E6%B5%81%E6%94%BE2%E4%B8%93%E5%8C%BA&islandId=301000&tagIds=[1707645,1708106,1824627,1708366,1815176,1856267,1708370,1707637,1708367,1708373,1708375,1820850,1815650]&attributeId=904221228984762040&entryId=1707645&entryType=TAG',
		zoneConfigs: [
			['国服', '赛季', '普通'],
			['国服', '赛季', '专家'],
			['国际服', '赛季', '普通'],
			['国际服', '赛季', '专家'],
		],
		currencyList: [
			'神圣石'
		],
	},
	{
		name: '流放之路1',
		pageUrl:
			'https://qiandao.com/currency/currency-zone?catalogName=%E6%B5%81%E6%94%BE%E4%B9%8B%E8%B7%AF%E4%B8%93%E5%8C%BA&islandId=300445&tagIds=[1837988,1837987,1837989]&attributeId=904221228984762040&entryId=1837988&entryType=TAG',
		// 实测该分区没有「闪回赛季」，赛季只有「永久 / 赛季」两种
		zoneConfigs: [
			['国服', '赛季', '普通'],
			['国服', '赛季', '专家'],
			['国际服', '赛季', '普通'],
			['国际服', '赛季', '专家'],
		],
		// 该分区没有「流放2金币」系列，也没有「悉妮蔻拉的发丝」（只有名称相近的「辛格拉的发辫」），
		// 因此清单与流放之路2 不通用，照抄会静默产出 0
		currencyList: ['神圣石'],
	},
	{
		name: '火炬之光',
		pageUrl:
			'https://qiandao.com/currency/currency-zone?catalogName=%E7%81%AB%E7%82%AC%E4%B9%8B%E5%85%89%E4%B8%93%E5%8C%BA&islandId=300444&tagIds=[1560053]&attributeId=904221228984762040&entryId=1560053&entryType=TAG',
		// 该分区只有两级，且「非赛季」下没有「专家」难度，故只取「赛季」的两个组合
		zoneConfigs: [
			['赛季', '普通'],
			['赛季', '专家'],
		],
		// 整个专区只有这一个通货
		currencyList: ['初火源质'],
	},
];
```

三个游戏合计 **10 个区服组合**, 与 §16「抓取耗时」一行的实测口径一致。

> ⚠️ **三份 `currencyList` 彼此不通用, 不要"顺手统一"**。同名通货跨游戏独立（见 `CONTEXT.md`），且站点上各专区提供的通货本就不同——把流放之路2 的清单照抄给流放之路1, 表现是**静默产出 0**（名称匹配不上, 不报错）。这正是 §7.2 的游戏级 `missing` 要兜的那类配置错误。

---

## 6. 目录结构与模块职责

```
src/
  index.ts                     入口: 生命周期装配、初始化编排, 不含业务
  types.ts                     类型定义 (从 @.../shared 重导出 WebUI 共用部分)
  config.ts                    DEFAULT_CONFIG + buildConfigSchema
  core/
    state.ts                   全局状态单例 (pluginState)
    admin.ts                   权限: getUserRole / hasRole / isSuperAdmin
  store/
    session.store.ts           state.json  — 订阅关系
    data.store.ts              data.json   — 最新价格 + 抓取状态
    archive.store.ts           archive/    — 按日归档、gzip、清理
  handlers/
    message-handler.ts         接收层: 群启用 → @剥离 → 前缀 → 切词 → 分发
    instruction.ts             指令注册表 (装配, 无业务)
    at-bot-prefix.ts           @机器人 CQ 段剥离纯函数
    currency/
      price.handler.ts         手动刷新 + 展示
      status.handler.ts
      notify.handler.ts        notify on|off
      game.handler.ts          game add|remove|list
      help.handler.ts
  services/
    scheduler.ts               小时集合 + 新鲜度 + 互斥锁 + 排队
    notifier.ts                消息模板 + 串行推送 + 旧值回退
    scraper/
      index.ts                 抓取主流程 (改造后的原 index.js)
      parse.ts                 纯 DOM 解析、specId 映射 (无副作用, 可单测)
    browser/
      launcher.ts              检测 + 启动 + 关闭 (精简版, 无健康检查/重连)
      chrome-installer.ts      多源下载 Chrome for Testing + 进度回调
    api-service.ts             WebUI API 路由
  utils/
    time.ts                    formatLocalTime / nextScheduledHour
    text.ts                    千分位剥离、失败文案拼装
```

分层与职责纪律见 [development-pattern.md](./development-pattern.md) 的"分层架构模型"。

---

## 7. 数据模型

### 7.1 `state.json` — 订阅关系

```json
{
  "version": 1,
  "sessions": {
    "group:123456": { "notifyEnabled": true, "enabledGames": ["流放之路2", "火炬之光"] },
    "private:789":  { "notifyEnabled": false, "enabledGames": ["流放之路1"] }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `sessions[].notifyEnabled` | 是否接收主动推送。**默认关闭** |
| `sessions[].enabledGames` | 该会话订阅的游戏名 |

> ⚠️ **不含任何全局时间戳**。早期设计里的 `lastDataReadAt` / `lastDataSuccess` 已删除——新鲜度判定下沉到 `data.json` 的游戏级 `readAt`, 全局时间戳失去存在理由。本文件因此是**纯粹的订阅关系表**, 不混入数据状态。

### 7.2 `data.json` — 最新价格

```json
{
  "version": 1,
  "games": {
    "流放之路2": {
      "readAt": "2026-09-16T08:00:05.123Z",
      "lastError": null,
      "missing": [],
      "zones": [
        {
          "zone": ["国服", "赛季", "普通"],
          "readAt": "2026-09-16T08:00:05.123Z",
          "prices": [
            { "name": "神圣石", "price": 0.2444, "unit": "元/个" },
            { "name": "崇高石", "price": null,   "unit": null }
          ]
        }
      ]
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `games[].readAt` | 游戏级读取时刻 = 各组合 `readAt` 的最大值。**新鲜度判定的依据** |
| `games[].lastError` | **最近一次抓取尝试**的失败原因; 成功时为 `null`。数据本身仍是上一次成功的 |
| `games[].missing` | **所有区服组合都找不到**的通货名(各组合 `missing` 的交集) |
| `zones[].readAt` | 该区服组合自己的读取时刻 (ISO 8601 UTC) |
| `zones[].prices[].price` | 数字 = 有效报价; **`null` = 本次未取到** |
| `zones[].prices[].unit` | `元/个`、`元/万金`、`元/火`……由页面 `计价单位/基准单位` 拼成; 无报价时为 `null` |

三条必须遵守的规则：

1. **游戏级原子性**：一个游戏内**任一区服组合**重试 3 次后仍失败 → **整个游戏本轮作废**，已成功读到的其他组合一并丢弃，只记 `lastError`。这是源项目三条硬约束中的「失败游戏不留半截数据」，**不得**为了"多保留一点数据"而改成部分成功。
2. **失败不覆盖**：游戏本轮失败 → `zones` / `readAt` 保持上一次成功的内容, 只更新 `lastError`。因此 **`zones[]` 的每一项必定有 `prices`, 永远不会有 `error` 字段**。
3. **`price: null` 与 `price: 0` 不同义**：`null` = 本次没取到(页面显示 `--` 或名称未匹配); `0` = 页面确实报 0。早期设计中两者都是 `0`、不可区分, 是本项目修掉的一处静默歧义。

> ⚠️ **`missing` 是交集而非并集**：不同区服提供的通货本来就不同(某通货可能只在国服有), 所以"某个组合缺某通货"是**正常业务差异**。真正指向配置写错(通货名拼错)的信号是"**所有组合都缺同一个名字**"——这正是唯一能让用户发现该类错误的途径, 因为被过滤掉的行在消息里看不见。

### 7.3 `archive/YYYY-MM-DD.json[.gz]` — 历史留档

```json
{
  "date": "2026-09-16",
  "runs": [
    {
      "startedAt": "2026-09-16T08:00:03.123Z",
      "finishedAt": "2026-09-16T08:02:15.456Z",
      "trigger": "schedule",
      "games": {
        "流放之路2": { "readAt": "...", "missing": [], "zones": [ ... ] },
        "火炬之光": { "error": "切换到 赛季 / 普通 失败：Timeout 20000ms exceeded" }
      }
    }
  ]
}
```

- `runs[].games` 与 `data.json` 的 `games` **同构**——归档因此是"`data.json` 的历史切片", 渲染与校验各只有一份代码。
- `games[]` **只有本次实际抓取的游戏**; 失败的游戏记 `{ "error": "..." }`。
- `trigger` 取 `"schedule"` 或 `"manual:{会话键}"`。
- **全部游戏失败时不写归档**。

### 7.4 归档生命周期

```
当天:   archive/2026-09-16.json        实时追加(run 级)
次日:   archive/2026-09-16.json.gz     压缩后删除原文件
30天后: 删除
```

> ⚠️ **维护任务不挂在调度器上**。早期设计把"压缩昨天 / 清理 30 天"放在"每次轮询开始时", 但并集为空或小时集合为空时调度器根本不启动, 归档会**永远不被压缩、永远不被清理**。维护改为挂在：**`plugin_init` 完成后执行一次 + 每次成功抓取后顺带执行**。维护任务的存在不应取决于"有没有人订阅"。

### 7.5 原子写

`data.json` / `state.json` / 归档一律**临时文件 + rename**; 归档用流式 gzip。损坏时备份为 `*.bak` 并初始化为空结构, **不阻塞启动**。

---

## 8. 抓取层

### 8.1 接口

```ts
scrapeGames(catalogs: CatalogConfig[]): Promise<Record<string, GameOk | GameFail>>

type GameOk   = { readAt: string; zones: ZoneResult[]; missing: string[] };
type GameFail = { error: string };
```

- 返回值与 `data.json` 的 `games`、归档的 `runs[].games` **完全同构**, 调用方零转换。
- `error` 字段的**有无即成败判定**, 不另设 `success` 标志。
- `startedAt` / `finishedAt` / `trigger` **由调度层记**, 抓取层不管——它只回答"这几个游戏现在值多少", 不知道谁订阅了、也不知道自己为什么被调用。
- 抓取层**不做落盘、不做推送、不做归档**。

### 8.2 依赖与浏览器

- `playwright-core` **内联打包进 `index.mjs`**。NapCat 宿主**不会**为插件安装 `dependencies`(发布包只含 `index.mjs` / `package.json` / `webui/`), 所以不能走外部依赖。

  ⚠️ **内联的代价比"补三处配置"大得多**。playwright-core 是 CJS 包, 且**在模块加载期**就按 `__dirname` 解析自指的"包根目录"、读取 `package.json` 与 `browsers.json`; 而 rollup 会把 CJS 的 `require` 一律提升成产物**顶层的静态 import**——上游原本惰性的依赖因此变成加载期求值。第 0 步实测踩到全部六类, 缺任何一项都是「构建通过、加载即崩」:

  | 类别 | 处置 | 不处理的后果 |
  | --- | --- | --- |
  | 可选原生模块 `bufferutil` / `utf-8-validate` / `kerberos` | 保持 **external** | rollup 报 `failed to resolve import` |
  | 可选外部包 `chromium-bidi/*`、`electron/*` | 解析为**空桩模块** | 加载期 `ERR_MODULE_NOT_FOUND` |
  | 内建模块 `inspector` | 解析为**惰性桩** | 加载期 `ERR_INSPECTOR_NOT_AVAILABLE`(QQ/Electron 未编译 inspector) |
  | 动态 `require(join(packageRoot, …))` | `commonjsOptions.ignoreDynamicRequires: true` | 被替换成抛错的 `commonjsRequire` |
  | 加载期自指的 `__dirname` / `require` | 产物前置 **shim 横幅** | `__dirname is not defined in ES module scope` |
  | `browsers.json` | 随包复制到插件根目录 | 加载期读不到, 直接抛错 |

  ⚠️ 两个反直觉点, 不要"顺手统一":
  - 第一类**必须**保持 external、**不得**改桩。它们包在 `try/catch` 里, 靠"`require` 未定义 → 抛错 → 被 catch"回退到纯 JS 实现; 换成 `{}` 桩会让 ws 选中"原生可用"分支, 把启动期的确定性回退变成发大帧时的随机崩溃。
  - 命中 `rollupOptions.external` 的 id **会绕过 `resolveId` 钩子**, 所以第三类必须先把它从 `external` 里摘掉, 否则桩不生效。

  完整实现见 `packages/plugin/vite.config.ts`(`bundleShim` / `STUB_MODULES` / `commonjsOptions`), 实测数据见 §17 第 0 步。

- **浏览器获取**：检测顺序为 `chromeExecutablePath` 配置 → **共享安装路径**（跨插件复用, 避免每个插件重下几百 MB）→ 系统浏览器常见路径。都没有时由 WebUI 一键安装（`chrome-installer.ts` 自建多源下载, Google 官方源 + npmmirror CDN + npmmirror Registry）。

  ⚠️ **检测路径表必须按平台分派, 不能只写 Windows**。原方案只列了 `LOCALAPPDATA/napcat-chrome` 与 Chrome/Edge 路径, 而第 0 步实测的部署机是 **Linux**, 这两类**零命中**——`chrome-installer` 因此不是"锦上添花"而是唯一出路。共享安装路径同理, 在 Linux 上应落在 `XDG_DATA_HOME` 一类位置而非 `LOCALAPPDATA`。

  ⚠️ **调用 `launch()` 时一律显式传 `executablePath`**。不给的话 playwright 会去找自带的浏览器: 1.63 的 headless 要的是 `chromium_headless_shell-<rev>`, 与 `chromium-<rev>` 是**两个独立下载物**（实测报错点名的就是前者）——凡遇到"明明装了浏览器却仍报找不到", 先核对这两个名字。

- **不采用** Playwright 自带的 registry 安装：内联打包后磁盘上没有 `node_modules/playwright-core/cli.js`, 自带的安装入口不存在。
- 精简版：**不做**远程 `wsEndpoint` 连接、页面信号量、健康检查、指数退避重连（本插件串行、单页、用完即关）。**不做** Windows 7/8 兼容分支与 Linux 发行版依赖安装。

### 8.3 三条硬约束（不得违反）

沿用源项目, 改造时**原样保留**：

1. **不写 0 占位**：失败时绝不填充假价格。本项目进一步把"未取到"表达为 `null`, 与真实 `0` 区分开。
2. **失败不留半截数据**：见 §7.2 规则 1。
3. **页面级加载校验**：`goto` 后先等关键元素出现, 否则抛错。站点按 UA 拦截时页面是空壳, 不校验会静默写出满篇空值。

配套的静默错值防线（均为既有实现, 不得简化）：切换区服后回读选择器确认、DOM 与价格接口返回值的交叉比对、按位置而非颜色类定位价格行。

> ⚠️ **交叉比对的判据有边界**：接口判为「无报价」（`rmbPrice` 为 `0`）的通货, 页面上**本来就只有占位符**——那是渲染完成的正确形态, 不得要求"页面上必须出现数字"。把这种形态当成"没渲染完", 表现是**整个游戏本轮作废**（实测于流放之路1 的「专家」区服, 见 §21）。接口**给了正价**的通货仍必须读到同一个正价, 这条不放宽: 上一个区服的旧值只要是正价, 照样会被识破。

> ⚠️ **新增一道**：解析价格时**先剥离千分位**再 `parseFloat`, 并**把结果规范化回字符串与页面原文比对**(容忍尾随零), 不一致则记 `null` 并告警。`Number.parseFloat("1,234.5")` 返回 `1` 且 `Number.isFinite` 检查不出来——这是一个"构建通过、静默错值"的漏洞。

---

## 9. 调度层

### 9.1 触发时刻

- **触发集合** = `pushHours` 中的整点（本地时间）。
- **下一个触发** = `now` 之后**第一个「整点在选中集合里」**的时刻; 今天剩余的选中小时都用完了就顺延到明天第一个。**在上一次运行结束后计算**（Q: 抓取耗时可能跨过整点, 基于完成时刻重算可保证抓取天然不自我重叠）。
- 边界：恰好整点时不能用 `Math.ceil(...) * 3600000`（会退化成 `setTimeout(0)` 立刻再触发一次）, 要用严格大于。
- **停摆条件（两个, 同一处处理）**：并集为空 **或** `pushHours` 为空 → 不挂定时器。运行中变为空则取消现有定时器。
- **配置变更**：`plugin_on_config_change` 检测到 `pushHours` / `catalogs` / `enabled` 变化 → 取消并重挂。运行期生效, 无需重启。

### 9.2 新鲜度

抓取前按**游戏**逐个判断：`now - game.readAt > 5 分钟`（或该游戏从未抓到、`readAt` 不存在）→ 过期, 需要抓; 否则复用。

**阈值 5 分钟当前是常量**（`STALENESS_THRESHOLD_MS`）, 不是配置项——它与"用户会不会想改"无关, 属于领域语义。若将来有实际需求, 按配置范式四环节提升为配置项即可。

### 9.3 互斥与排队

**全局一把锁**, 后到者**排队**（不是"复用前者结果"——在游戏级粒度下前者可能根本没抓你要的游戏）。

后到者轮到自己时**重新计算**需要抓的游戏（前者可能已经抓过了, 此时直接复用）。

**代价要说清**：先触发者先收到自己的结果, 后到者在锁释放后再抓自己缺的游戏、再推给自己——两人可能收到内容不同的两条消息。

> ⚠️ **不做游戏级并发**。现有抓取是多个游戏**共用同一个 page 串行**(UA 挂在 context 上, 页面状态在组合间累积), 并发就得开多个 browser/page。而"两个会话同一分钟都发 `price`"是低频事件, 排队等一两分钟是可接受的代价。

### 9.4 并发与资源

单次抓取持有 **1 个浏览器 + 1 个 context + 1 个 page**, 不并发开页面。抓完即关。

---

## 10. 通知层

### 10.1 推送范围

**推送"该会话订阅的全部游戏"**，包括本轮因数据新鲜而跳过抓取的。定时推送的价值在于**定期送达**, 不因为数据刚更新过就缺席。

### 10.2 消息模板

```
「流放之路2」2026-09-16 08:00 实时千岛通货价格

【国服 / 赛季 / 普通】
1. 神圣石 0.2444 元/个
2. 崇高石 1.2345 元/个
（3 项未取到价格）

【国际服 / 赛季 / 专家】
1. 初火源质 0.0012 元/火
```

规则：

- **头部时间用游戏级 `readAt`, 转本地时区**。区服级 `readAt` 留在数据文件里——同一轮内各区服只差几秒, 显示出来是噪音。
- **区服组合标题**用 `【区服 / 子级 / 子级】`, 层数随配置自适应。
- **过滤掉 `price` 为 `0` 或 `null` 的行**, 在组合末尾用 `（N 项未取到价格）` 交代数量。整块都没取到时**仍显示标题**, 否则用户会以为这个区服没在抓。
- **`missing`（配置的通货名在站点上不存在）单独成行**：
  ```
  （另有 1 项配置的通货名在站点上不存在）
  ```
  这是配置写错时用户**唯一**的可见信号——被过滤掉的行在消息里看不见。
- **抓取失败、回退旧数据时**头部加标记：
  ```
  「流放之路2」2026-09-16 07:00 实时千岛通货价格（数据未更新）
  ```
  不加标记等于给用户看一份他以为是新的数据。**"因新鲜而跳过"不加此标记**——那种情况数据是 5 分钟内的, 加了反而误导。
- 价格**原样显示**（不做固定小数位）。

### 10.3 推送方式

- **一游戏一条消息**, 按该会话 `enabledGames` 的顺序。
- **串行推送**（顺序可控）, 每条之间间隔 `pushIntervalMs`（默认 `100`）。串行本身不解决频控, 间隔才是。
- 每个会话各自发送, 不复用合并。
- 失败的游戏推 `data.json` 里的旧值; **从未成功抓到过的游戏直接跳过不发**。
- 全部游戏失败且都没有旧值 → **完全静默**。

### 10.4 语义澄清

草稿原文的「抓取失败不主动通知」应理解为「**不发专门的失败告警消息**」, 而不是"什么都不发"——推旧值时带的「（数据未更新）」标记本身已经是一种通知。

---

## 11. 指令层

### 11.1 指令表

前缀 `#currency`（读自 `commandPrefix` 配置）。分发规则、命名空间、失败反馈见 [instruction-pattern.md](./instruction-pattern.md)。

| 命名空间 | 指令 | 权限 | 作用域 | 行为 |
| --- | --- | --- | --- | --- |
| 一级 | `#currency` / `#currency help` | `user` | 不限 | 帮助（图片优先／文本回退, 按角色+会话类型选变体） |
| 一级 | `#currency price` | `user` | 不限 | 抓取过期的游戏, 然后展示本会话订阅的全部游戏 |
| 一级 | `#currency status` | `user` | 不限 | 本会话通知开关 / 已订阅游戏 / 各游戏数据时间 / 浏览器状态 |
| 二级 `notify` | `#currency notify` | `user` | 不限 | 查看本会话通知开关 |
| 二级 `notify` | `#currency notify on` | `admin` | 不限 | 开启本会话通知 |
| 二级 `notify` | `#currency notify off` | `admin` | 不限 | 关闭本会话通知 |
| 二级 `game` | `#currency game` | `user` | 不限 | 列出配置中的游戏, 标出本会话已订阅的 |
| 二级 `game` | `#currency game add <游戏名...>` | `admin` | 不限 | 订阅（**游戏名精确匹配**; 可空格分隔多个, **有一个不合法就整条拒绝**） |
| 二级 `game` | `#currency game remove <游戏名...>` | `admin` | 不限 | 退订（**不校验配置**; 可空格分隔多个, 回执按"退掉的／没订过的"分组） |

**不存在** `reload-chrome` 指令——浏览器重检只通过 WebUI 端点，由仪表盘按钮触发。

`notify` / `game` 是**二级命名空间**（模块 → 子指令）, `help` / `price` / `status` 在**一级**。范式分发逻辑本就是"先查二级, 未命中再查一级", 混合是合法的。

`#currency` **只有前缀、没有参数**时路由到 `help`（范式补充条款）。

### 11.2 失败反馈

三类校验失败**一律显式回复**（**覆盖**范式的默认静默策略，见 [ADR-0002](./adr/0002-explicit-failure-feedback-over-silence.md)）：

```
{commandPrefix}: 非法参数 {出错的参数}      ← 参数不合法(如 game add 原神)
{commandPrefix}: 未知指令 {整个参数串}      ← 未知子命令
{commandPrefix}: 权限不足 {整个参数串}      ← 权限不足
输入 '{commandPrefix} help' 获取帮助信息
```

**文案如实区分, 不统一成一句话**——既然回复本身已经放弃了防探测, 统一文案就只剩纯损失: 一个没权限的用户看到"非法参数"会去检查拼写, 而不是意识到"我没权限"。前缀取自配置, **不硬编码**。

作用域不符按范式回复固定提示。

### 11.3 权限

四档角色模型, 推导与比较见 [permission-pattern.md](./permission-pattern.md)：`user(0) < admin(1) < privateUser(2) < superAdmin(3)`。

- 超管名单来自 `adminUsers` 配置。**超管在别人的群里也能执行 `admin` 级指令**, 这是该档位的核心价值。
- 好友私聊 = `privateUser`（等同 admin 权限组）; **群临时会话 = `user`**（可用 `help` / `price` / `status`, 不能 `notify` / `game`）。
- **本插件无超管专属指令**。`superAdmin` 当前只影响 `status` 的最后一行（见下）。

### 11.4 `status` 输出

```
#currency 状态
本群通知：已开启／已关闭
已订阅游戏：流放之路2、火炬之光

流放之路2    08:00（3 分钟前）
火炬之光     08:00（3 分钟前）

浏览器：可用
```

最后一行**只对「私聊 + `superAdmin`」显示**——普通成员看浏览器状态没有意义, 也不该暴露部署细节。

---

## 12. 关键流程

### 12.1 定时推送

```
[配置的整点触发]
  ↓
停摆检查: 并集为空 或 pushHours 为空 → 重挂/取消, 结束
  ↓
算并集; 逐个游戏判断新鲜度
  ↓
抢全局锁(占用则排队等待)
  ↓
抓「过期的」→ scrapeGames(过期的那些)
  ↓
更新 data.json: 成功的覆盖(含 readAt / missing / lastError=null), 失败的只写 lastError
  ↓
若至少一个游戏成功 → 写 archive/当天.json 一条 run; 顺带做归档维护
  ↓
对每个 notifyEnabled 的会话:
  按该会话 enabledGames 顺序
  成功的用新数据、失败的用旧值(头部加「数据未更新」)
  从未成功过的跳过
  串行 + 每条间隔 pushIntervalMs
  ↓
释放锁 → 计算下一个选中整点 → 重挂定时器
```

### 12.2 手动刷新

```
收到 #currency price
  ↓
浏览器不可用 → 「服务不可用, 请联系机器人管理员」
  ↓
算本会话订阅游戏中过期的
  ├─ 一个都没有 → 不抓, 直接展示(12.3)
  └─ 有 → 回执「正在抓取…」→ 抢锁(占用则排队)
            → 轮到自己时**重算**(前者可能已抓) → 抓 → 落盘 → 归档
  ↓
展示本会话订阅的全部游戏(含复用旧数据的)
```

### 12.3 展示（`price` / 定时推送共用同一渲染器）

```
对每个游戏(按 enabledGames 顺序):
  成功或复用 → 用 data.json 渲染, 头部时间用游戏级 readAt
  失败但有旧值 → 渲染旧值 + 「（数据未更新）」
  失败且无旧值 → 跳过
```

### 12.4 归档维护

```
plugin_init 完成后 + 每次成功抓取后:
  检查 archive/昨天日期.json 是否存在 → 存在则 gzip 并删除原文件
  删除 archive/ 下超过 30 天的 .json.gz
```

---

## 13. WebUI

三个页面（React SPA, 构建产物由 `copyAssetsPlugin` 复制进 `dist/webui`）：

| 页面 | 内容 |
| --- | --- |
| **仪表盘** | 插件状态 / 运行时长 / 统计 + **浏览器状态卡**（可用性、路径、版本 + 「安装 Chrome」「重新检测」按钮）+ 各游戏最后抓取时间 |
| **分区配置** | `catalogs` 编辑器（游戏名、页面 URL、通货清单、区服组合） |
| **群管理** | 读 `state.json` 展示各会话的通知开关与已订阅游戏（**模板自带的 `GroupsPage` 读的是 `groupConfigs`, 必须改造**，否则会变成一份没人读的死 UI） |

### API 端点

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/status` | GET | 插件状态 + 各游戏 `readAt` |
| `/chrome/status` | GET | **只读缓存的**浏览器检测结果, 零副作用 |
| `/chrome/detect` | POST | 执行检测（`executablePath()` 轻量检查 → `launch()` 完整验证, 超时 5000ms）并刷新缓存 |
| `/chrome/install` | POST | 触发 Chrome 下载安装 |
| `/chrome/install/progress` | GET | 安装进度 |
| `/catalogs` | GET / POST | 读写分区配置 |
| `/sessions` | GET | 订阅关系一览 |

> ⚠️ **`/chrome/status` 必须只读缓存**。模板的 `App.tsx` 每 5 秒轮询一次 `/status`; 如果状态查询每次都跑 `launch()`, 只要有人开着面板就会**每 5 秒拉起一次浏览器**。检测与查询必须分离。

---

## 14. 错误处理

| 场景 | 处理 |
| --- | --- |
| `state.json` 损坏 | 备份 `*.bak` + 初始化为空结构 |
| `data.json` 损坏 | 备份 `*.bak` + 初始化为空 → **所有游戏判为过期 → 全量重抓**; 推送时无旧值可用则跳过 |
| 单个游戏抓取失败 | 该游戏不覆盖 `data.json`（只写 `lastError`）; 通知推旧值 + 「数据未更新」标记 |
| 全部游戏失败 | 不写归档; 有旧值的照推（带标记）; 全无旧值则静默 |
| 求值数字为 NaN / 千分位校验不通过 | 该条记 `null`, 记 warn |
| 磁盘写入失败 | 记日志 + 继续运行 |
| 归档 gzip 失败 | 保留未压缩文件 + 下次维护再试 |
| 浏览器不可用 | 不挂调度器; 指令返回「服务不可用，请联系机器人管理员」 |
| `catalogs` 为空 | 同浏览器不可用 |
| 插件卸载时抓取进行中 | `plugin_cleanup` 中 `browser.close()` 强制关闭, 不等待 |
| 热重载 | 定时器必须注册进 `pluginState.timers`, 否则每热重载一次就多一条 `setTimeout` 链在后台跑 |

---

## 15. 安全

- **不绕过站点约束**：坚持页面点击（ADR-0001）。`axios` 依赖即使未被使用也不要删——它是防止下一个人改成直连接口的路标。
- **UA 伪装**：沿用 `buildUserAgent(browser.version())`，挂在 context 上（UA 无法在 `launch()` 设置，所以不能用 `browser.newPage()`，必须显式建 context）。
- **不泄露**：`state.json` / `data.json` 不含敏感信息；浏览器状态只对私聊超管可见。
- **Chrome 安装**：由 WebUI 管理员显式触发。

---

## 16. 非功能需求

| 项 | 要求 |
| --- | --- |
| 运行环境 | NapCat ≥ 4.14.0 (**宿主 Node ≥ 20**, playwright 的 bootstrap 在加载期就会 `process.exit(1)`, 版本不足会直接杀进程); 系统需有 Chrome/Chromium 或由插件安装 (**实测部署机没有, 安装器是必需路径**) |
| 发布包体积 | `index.mjs` 约 **6.4 MB** (gzip 1.2 MB), 由内联 `playwright-core` 决定; 无法通过 tree-shaking 显著削减 (它自身是预打包的大 bundle) |
| 抓取耗时 | **全部成功时秒级**（实测 10 个区服组合的 `readAt` 总跨度约 9 秒）; 失败路径单组合最坏约 3 分钟 |
| 内存 | 单次抓取 1 浏览器 + 1 context + 1 page, 不并发开页面 |
| 磁盘 | `data.json` 单次覆盖写; 归档 1 天 1 文件, 30 天后清理 |
| 日志 | 分级 debug/info/warn/error; 抓取细节保留 debug; 名称未匹配记 warn |
| 可测试性 | `parse.ts` 纯函数可单测; 指令 handler 用 mock store 可测 |
| 可维护性 | 抓取核心逻辑最小改动; 配置驱动; 新增游戏只加配置 |

---

## 17. 编码顺序

```
0.  ✅ 打包 spike        playwright-core 内联 + 真机 launch/goto —— 已通过 (2026-09-17)
1.  骨架                index.ts / types / config / core/state / core/admin
2.  store 层            session / data / archive（原子写、损坏备份、gzip、清理）
3.  浏览器层            检测 + 共享路径安装器 + 端点 + 仪表盘页面
4.  抓取层              parse.ts 纯函数(+vitest) → scraper/index.ts 改造
5.  调度层              小时集合 + 新鲜度 + 互斥锁 + 排队
6.  通知层              模板 + 串行 + 间隔 + 旧值标记
7.  指令层              注册表 + handler + 三类失败文案
8.  帮助                权威源 + 生成脚本 + handler
9.  WebUI              分区配置页 + 群管理页改造
10. 联调               真实 NapCat 环境跑通全部流程
```

**第 0 步不能跳**：这是全案唯一的「构建通过、运行时才炸」风险点——NapCat 不为插件安装依赖, `playwright-core` 只能内联打包, 而它运行时按 `__dirname` 定位 `browsers.json`、spawn 浏览器进程。验证方法是写一个最小 `index.ts` 只做 `chromium.launch()` + `goto()`, 跑 `pnpm build` 看体积与报错, 再丢进真实 NapCat 里跑一次。**它不通过, 抓取层、浏览器层、分发方式全部要重新设计。**

> **第 0 步实测结论 (2026-09-17)：通过。** `dist/index.mjs` 6.4 MB(gzip 1.2 MB); 本机系统 Chrome 启动 463ms、`goto` 站点首页 1585ms(首页无 UA 拦截); 部署到远程 NapCat 后 `runtimeStatus: "loaded"`。
>
> **分发方式无需重新设计**, 但内联所需的构建期处置远比 §8.2 原先列出的多——已全部回写该节。
>
> 顺带测出两件影响后续步骤的事实:
>
> 1. **部署机是 Linux / Node v22.16.0, 且一个浏览器都没有**——直接决定第 3 步的检测顺序与安装器设计, 见 §8.2。
> 2. **远程可观测性只有 `runtimeError` 一个通道**。调试服务没有读远程日志 / 读远程文件的 RPC, `plugin_init` 的任何输出都传不回来; 第 0 步是靠"跑完后临时抛异常"把遥测塞进 `runtimeError` 才取到的。第 10 步联调会再需要这个手法。

---

## 18. 测试重点

模板无测试框架, 新增 vitest 到 `packages/plugin`（纯 devDependency, 不进产物）。

| 目标 | 内容 |
| --- | --- |
| `scraper/parse.ts` | `readCurrencyList` / `parseZoneSpecIds` / 千分位剥离 / 价格规范化比对（喂固定 HTML 与固定响应对象） |
| `utils/time.ts` | 下一个选中整点的计算（含跨零点、恰好整点、空集合、单元素集合） |
| `store/*` | 原子写、损坏恢复、归档 gzip 与清理 |
| 调度 | 并集计算、新鲜度判定、停摆条件 |
| 指令 | 每类失败的分支与文案（参数不合法 / 未知子命令 / 权限不足 / 作用域） |

---

## 19. 帮助输出

走[帮助输出范式](./help-output-pattern.md)全量链路：权威源（`scripts/generateHelp/`）→ 生成脚本 → **文本映射 + 三张 PNG**（由独立项目 `napcat-help-generate` 渲染）→ 运行时图片优先、文本回退。

| 分组 | 内容 | 标记 |
| --- | --- | --- |
| 核心指令 | `price`、`status` | 无 |
| 辅助指令 | `help` | 无 |
| 管理指令 | `notify on\|off`、`game add\|remove` | `isAdmin` |

**本插件无超管专属指令**，因此 SuperAdmin 版与 Admin 版内容相同。仍按范式生成三档——代价只是多渲一张相同的图, 换来的是将来加任何超管指令时只需改权威源。

---

## 20. 验收标准

### 20.1 功能

- [ ] 加载后仪表盘正确显示浏览器可用性与各游戏最后抓取时间
- [ ] 浏览器不可用时, 点击「安装 Chrome」能下载并安装成功
- [ ] `#currency` 与 `#currency help` 都返回帮助, 图片优先、缺图回退文本, 内容随角色与会话类型变化
- [ ] `#currency price` **只重新抓取过期的游戏**, 新鲜的游戏直接复用; 完成后展示本会话订阅的**全部**游戏
- [ ] 游戏级新鲜度: A 游戏 2 分钟前抓过、B 游戏 15 分钟前抓过时, `price` 只重抓 B, 然后展示 A 和 B
- [ ] 定时推送**包含**因新鲜而跳过的游戏, 且这些游戏**不加**「数据未更新」标记
- [ ] 在 `pushHours` 选中的整点触发; 未选中的小时不触发
- [ ] 并集为空 **或** `pushHours` 为空时, 不启动调度器
- [ ] `#currency notify on|off` 切换本会话通知
- [ ] `#currency game add 流放之路2` 后本会话订阅该游戏 (精确匹配)
- [ ] `#currency game add 流放之路1 流放之路2 火炬之光` 一次订三个; 其中混入非法名时**一个都不订**
- [ ] `#currency status` 显示通知开关、已订阅游戏、各游戏数据时间; **浏览器行只对私聊超管显示**
- [ ] 三类校验失败各自输出对应文案 (参数不合法 / 未知指令 / 权限不足)
- [ ] 一个游戏内**任一**区服组合失败 → 整个游戏本轮作废; `data.json` 保持旧数据, 只更新 `lastError`
- [ ] 失败游戏的推送回退旧值并加「数据未更新」; 从未成功抓到的游戏不发
- [ ] 全部游戏失败且都无旧值 → 完全静默
- [ ] `data.json` 中游戏级与区服级 `readAt` 并存且各自独立
- [ ] `price: null`(未取到) 与 `price: 0` 在数据中可区分, 推送时都被过滤, 并计数为 `（N 项未取到价格）`
- [ ] 配置的通货名在**所有**区服组合都找不到时, 出现在游戏级 `missing` 中并在推送里单独成行
- [ ] `pageUrl` 与 `zoneConfigs` 可通过 WebUI 分区配置页编辑并生效, 无需重启
- [ ] 归档按日写入、次日 gzip、30 天后清理; 维护在插件加载后与每次成功抓取后执行
- [ ] `state.json` / `data.json` 损坏时备份并初始化, 不阻塞启动
- [ ] 卸载时浏览器被正确关闭; 热重载后不残留定时器

### 20.2 非功能

- [ ] 抓取失败不写 0 占位 (改用 `null`)
- [ ] 一个游戏内任一区服组合失败不留半截数据
- [ ] 静默错值防线齐备: 页面加载校验 / 切换后回读选择器 / DOM 与接口比对 / **千分位剥离与规范化比对**
- [ ] 价格解析先剥千分位; 规范化比对不通过则记 `null` 并告警
- [ ] 浏览器状态查询**无副作用**——轮询 `/chrome/status` 不会反复 `launch()`
- [ ] 日志分级正确
- [ ] `parse.ts` / `time.ts` / store / 调度 / 指令分支有单测覆盖

## 21. 已知未解决 / 待观察

- **流放之路1 的「专家」区服整体无报价**：实测（2026-09-18）该分区的「国服 / 赛季 / 专家」与「国际服 / 赛季 / 专家」价格接口**对所有通货都返回 `0`**, 页面如实显示占位符, 因此落盘为 `price: null`。这是站点数据现状而非抓取失败, 消息里这两个组合只剩「（1 项未取到价格）」; 不想要这两行的话, 从该游戏的 `zoneConfigs` 里去掉即可。
- **站点改版即失效**：完全依赖站点 DOM 与接口路径, 无兜底。UA 拦截是"绕过"而非"解决", 站点升级识别手段会重新 405。
- **列表一次性渲染假设**：实测 20 条全渲染; 站点改虚拟滚动/分页会只取到可见部分且不报错。
- **`price: 0` 与 `price: null` 已可区分**, 但"页面显示 `--`"与"名称未匹配"在**单条价格**上仍共用 `null`；后者靠游戏级 `missing` 兜底, 是交集口径, 会漏掉"只有部分区服缺"的情况。
- **千分位**：已加剥离与自校验, 但页面若出现其他格式（百分号、科学计数法）仍可能静默错值。
- **单次抓取耗时上限未实测**：最坏路径（每组合都重试 3 次）下单轮可能超过 30 分钟, 会跳过若干配置的整点。
- **推送间隔 100ms 未实测**：QQ 服务端的实际频控边界未知, 可能需要调大。
