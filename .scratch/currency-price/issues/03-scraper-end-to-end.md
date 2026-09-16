# 03 — 抓取层贯通：单游戏单区服到 price 展示

Status: ready-for-agent
Type: AFK
Blocked by: 02
来源: [docs/design.md](../../../docs/design.md) §7.2 §7.5 §8 §12.2 §12.3
参考实现: 抓取源项目 `qiandao` 的一次性脚本 —— **`E:\Desktop\qiandao\src\index.js`**（583 行，**不在本仓库**；同目录下还有 `CONTEXT.md` 与 `docs/`，用词映射见本仓库 `CONTEXT.md` 的「与抓取源项目的用词映射」：源项目的「分区」= 本插件的「游戏」）

## What to build

**全案风险最高的一片。** 端到端行为是：用户发 `#currency price`，机器人在真机上打开浏览器、打开千岛页面、点级联选择器切到目标区服、把价格解析出来、落盘，然后展示给用户。这是「构建通过、运行时才炸」风险最集中的一段。

先用一个游戏的一个区服组合把整条链路打通，**不要**在这一片就铺开三分区——铺开是片 04。

要落定：

**`parse.ts` 纯函数** —— 无副作用、可单测：读取通货列表、从级联接口的选项树解析 `specId` 映射、千分位剥离、价格规范化比对。（设计文档 §6 把它列在 `scraper/` 下，§18 要求它有 vitest 覆盖。**测试框架要新加 vitest 到 plugin 包**，纯 devDependency，不进产物。）

**精简版浏览器启动** —— 检测顺序 `chromeExecutablePath` 配置 → 共享安装路径（跨插件复用，避免每个插件重下几百 MB）→ 系统浏览器常见路径。**按平台分派，不能只写 Windows**——第 0 步实测的部署机是 Linux，Windows 那两类路径**零命中**。检测路径的完整版与安装器在片 06。

**调用 `launch()` 时一律显式传 `executablePath`**。不给的话 playwright 会去找自带的浏览器：1.63 的 headless 要的是 `chromium_headless_shell-<rev>`，与 `chromium-<rev>` 是**两个独立下载物**——凡遇到「明明装了浏览器却仍报找不到」，先核对这两个名字。

**不采用** Playwright 自带的 registry 安装：内联打包后磁盘上没有 `node_modules/playwright-core/cli.js`，自带安装入口不存在。

**抓取主流程** —— 改造自源项目的一次性脚本。三条硬约束**原样保留**（§8.3）：不写 0 占位；失败不留半截数据；页面级加载校验（`goto` 后先等关键元素出现，否则抛错——站点按 UA 拦截时页面是空壳，不校验会静默写出满篇空值）。

配套的静默错值防线**均为既有实现，不得简化**：切换区服后回读选择器确认、DOM 与价格接口返回值的交叉比对、按位置而非颜色类定位价格行。

**新增一道**（这是本项目修掉的漏洞）：解析价格时**先剥离千分位**再 `parseFloat`，并**把结果规范化回字符串与页面原文比对**（容忍尾随零），不一致则记 `null` 并告警。`Number.parseFloat("1,234.5")` 返回 `1`，且 `Number.isFinite` 检查不出来——这是一个「构建通过、静默错值」的洞。

**UA 伪装** —— 沿用 `buildUserAgent(browser.version())`，挂在 **context** 上（UA 无法在 `launch()` 设置，所以不能用 `browser.newPage()`，必须显式建 context）。

**抓取层接口** —— `scrapeGames(catalogs)` 返回 `Record<string, GameOk | GameFail>`，与 `data.json` 的 `games`、归档的 `runs[].games` **完全同构**，调用方零转换。`error` 字段的**有无即成败判定**，不另设 `success` 标志。抓取层**不做落盘、不做推送、不做归档**，也不知道谁订阅了、为什么被调用。

**`data.json` 落盘** —— `{ version, games: { "<游戏名>": { readAt, lastError, missing, zones: [{ zone, readAt, prices: [{ name, price, unit }] }] } } }`。原子写；损坏时备份 `*.bak` 并初始化为空（→ 所有游戏判为过期 → 全量重抓）。

**`price` 指令** —— 抓取后展示本会话订阅的游戏。浏览器不可用、或 `catalogs` 为空 → 「服务不可用，请联系机器人管理员」。手动抓取时先回执「正在抓取…」。

## Acceptance criteria

- [ ] 真机上 `#currency price` 抓到真实价格并展示，`unit` 由页面的「计价单位 / 基准单位」拼成
- [ ] `price: null`（本次未取到）与 `price: 0`（页面确实报 0）在数据文件中**可区分**，展示时都被过滤
- [ ] 千分位不静默错值：`"1,234.5"` 解析为 `1234.5`；规范化回字符串与原文比对不通过时记 `null` 并记 warn
- [ ] 页面级加载校验生效：UA 被拦截（空壳页面）时抛错，而不是写出满篇空值
- [ ] 切换区服后回读选择器；不一致时抛错
- [ ] DOM 与价格接口的交叉比对在两条来源不一致时抛错
- [ ] 价格行按位置定位，不依赖颜色类名
- [ ] `launch()` 被显式传入 `executablePath`；缺失时报错点名的是 `chromium_headless_shell-<rev>` 时能被识别为「浏览器未装」而非配置错误
- [ ] `scrapeGames` 的返回值与 `data.json` 的 `games` 键名、结构完全一致，调用方零转换
- [ ] 抓取层不落盘、不推送、不归档（可用调用前后的文件状态断言）
- [ ] `data.json` 写入中断不产生半截文件；损坏时备份 `*.bak` 并初始化为空，之后所有游戏判为过期
- [ ] 浏览器不可用 或 `catalogs` 为空 → 「服务不可用，请联系机器人管理员」
- [ ] `parse.ts` 的纯函数有 vitest 覆盖（喂固定 HTML 与固定响应对象）：通货列表读取 / `specId` 映射 / 千分位剥离 / 价格规范化比对
- [ ] vitest 是 devDependency，不出现在构建产物里

## Blocked by

- [02 — 订阅关系与订阅指令](02-session-subscriptions.md)
