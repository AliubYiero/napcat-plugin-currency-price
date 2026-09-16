# 06 — 浏览器检测与一键安装

Status: ready-for-agent
Type: AFK
Blocked by: 03
来源: [docs/design.md](../../../docs/design.md) §8.2 §11.4 §13 §14 §15 §20.2

## What to build

端到端行为是：在一台**一个浏览器都没有**的部署机上打开插件仪表盘，浏览器状态卡显示不可用；管理员点「安装 Chrome」，看到进度，装完之后状态变可用，抓取随即能跑。**这正是第 0 步实测出来的处境**——部署机是 Linux、Node v22.16.0，Windows 那两类检测路径零命中，所以安装器**不是**「锦上添花」而是唯一出路。

要落定：

**按平台分派的检测路径表** —— `chromeExecutablePath` 配置 → **共享安装路径**（跨插件复用，避免每个插件重下几百 MB；在 Linux 上应落在 `XDG_DATA_HOME` 一类位置而非 `LOCALAPPDATA`）→ 系统浏览器常见路径（Windows 与 Linux 分别列）。**不能只写 Windows。**

**多源下载安装器** —— 自建下载（Google 官方源 + npmmirror CDN + npmmirror Registry），带进度回调。装到共享安装路径。

**API 端点** —— `/chrome/status`（GET，**只读缓存的**检测结果，零副作用）、`/chrome/detect`（POST，执行检测：`executablePath()` 轻量检查 → `launch()` 完整验证，超时 5000ms，然后刷新缓存）、`/chrome/install`（POST，触发下载安装）、`/chrome/install/progress`（GET，安装进度）。

**`/chrome/status` 必须只读缓存** —— 模板的 WebUI 每 5 秒轮询一次状态；如果状态查询每次都跑 `launch()`，只要有人开着面板就会**每 5 秒拉起一次浏览器**。检测与查询必须分离。这是本片的头号验收项。

**仪表盘浏览器状态卡** —— 可用性 / 路径 / 版本 + 「安装 Chrome」「重新检测」两个按钮。仪表盘同时显示插件状态、运行时长、统计与各游戏最后抓取时间。

**`status` 指令的浏览器行** —— 片 02 留出的「浏览器：可用」行在这一片接上真实数据源，**只对「私聊 + superAdmin」显示**。

**错误处理与安全** —— Chrome 安装由 WebUI 管理员显式触发；浏览器状态只对私聊超管可见，不暴露部署细节。浏览器不可用时**不挂调度器**（片 08 接入），指令返回「服务不可用，请联系机器人管理员」（片 03 已落）。

## Acceptance criteria

- [ ] 在无任何浏览器的 Linux 部署机上点「安装 Chrome」能装上，状态卡变为可用
- [ ] **轮询 `/chrome/status` 不会触发 `launch()`**（用进程列表或日志断言，连续轮询多次浏览器进程数不变）
- [ ] `/chrome/detect` 执行检测并刷新缓存，返回路径与版本；`executablePath()` 轻量检查不通过时才跑 `launch()`
- [ ] `/chrome/detect` 的 `launch()` 验证有 5000ms 超时
- [ ] `/chrome/install/progress` 能读到安装进度，安装失败时给出可读的失败原因（多源逐个回退）
- [ ] 检测路径表按平台分派：Windows 与 Linux 各有对应路径；共享安装路径在 Linux 上落在 `XDG_DATA_HOME` 一类位置，**不是** `LOCALAPPDATA`
- [ ] 检测顺序为 `chromeExecutablePath` → 共享安装路径 → 系统浏览器常见路径
- [ ] `launch()` 一律显式传 `executablePath`
- [ ] 仪表盘显示可用性 / 路径 / 版本，两个按钮都生效
- [ ] 仪表盘显示各游戏最后抓取时间
- [ ] `#currency status` 的「浏览器：可用」行**只对「私聊 + superAdmin」**出现
- [ ] 浏览器不可用时不挂调度器（片 08 落地后回归此项）

## Blocked by

- [03 — 抓取层贯通：单游戏单区服到 price 展示](03-scraper-end-to-end.md)
