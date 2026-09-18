# 08 — 调度器（小时集合）

Status: ready-for-human
Type: AFK
Blocked by: 05
来源: [docs/design.md](../../../docs/design.md) §9.1 §9.4 §12.1 §14 §18

## What to build

端到端行为是：`pushHours` 设成 `[9, 21]` 时，机器人在每天 9 点和 21 点自己抓一遍，`data.json` 的 `readAt` 随之前进；把 `pushHours` 清空保存，它立刻停下来；改成 `[10]`，它不用重启就按新集合来。

**本片只做「到点抓取并落盘」，不做推送**——推送是片 09。本片因此通过 `data.json` 的 `readAt` 与归档记录来验收。

要落定：

**触发时刻** —— 触发集合 = `pushHours` 中的整点（**本地时间**）。下一个触发 = `now` 之后**第一个「整点在选中集合里」**的时刻；今天剩余的选中小时都用完了就顺延到明天第一个。

**在上一次运行结束后计算** —— 抓取耗时可能跨过整点，基于完成时刻重算可保证抓取天然不自我重叠。

**边界** —— 恰好整点时不能用 `Math.ceil(...) * 3600000`（会退化成 `setTimeout(0)` 立刻再触发一次），要用**严格大于**。

**停摆条件（两个，同一处处理）** —— 订阅并集为空 **或** `pushHours` 为空 → 不挂定时器。运行中变为空则取消现有定时器。

**配置变更** —— 检测到 `pushHours` / `catalogs` / `enabled` 变化 → 取消并重挂。运行期生效，无需重启。

**热重载** —— 定时器必须注册进 `pluginState.timers`，否则每热重载一次就多一条 `setTimeout` 链在后台跑。

**卸载** —— `plugin_cleanup` 中 `browser.close()` 强制关闭，**不等待**（抓取可能正在进行中）。

**触发后的动作序列** —— 停摆检查 → 算并集 → 逐个游戏判断新鲜度（片 05）→ 抢全局锁（占用则排队）→ `scrapeGames(过期的那些)` → 更新 `data.json`（成功的覆盖含 `readAt` / `missing` / `lastError=null`，失败的只写 `lastError`）→ 若至少一个游戏成功则写归档 + 顺带做归档维护（片 07）→ 释放锁 → 计算下一个选中整点 → 重挂定时器。

（推送环节插在释放锁之前，片 09 接入。）

**浏览器不可用时不挂调度器**（片 06 的规则在这里落地）。

## Acceptance criteria

- [x] `pushHours` 为 `[9, 21]` 时只在 9 点与 21 点抓取，未选中的小时不触发
- [x] **恰好整点触发时不会退化成立刻再触发一次**
- [x] 跨零点正确：今天剩余的选中小时用完后顺延到明天第一个选中小时
- [x] `pushHours` 为空数组 → 不挂定时器（空数组是合法语义，不是「回退默认全选」）
- [x] 运行中把 `pushHours` 改成空数组 → 取消现有定时器，不再触发
- [x] 订阅并集为空 → 不挂定时器
- [x] 改 `pushHours` / `catalogs` / `enabled` 后无需重启即按新配置触发
- [x] 抓取跨过整点时，下一次触发基于**完成时刻**重算，不产生自我重叠
- [x] 热重载多次后 `pluginState.timers` 不累积（每次重载后条数稳定）
- [x] `plugin_cleanup` 时抓取正在进行 → 浏览器被强制关闭，不等待
- [x] 定时抓取成功后 `data.json` 的 `readAt` 前进，且当天归档多出一条 `trigger: "schedule"` 的 run
- [x] 浏览器不可用时不挂调度器
- [x] 单测覆盖下一个选中整点：跨零点 / 恰好整点 / 空集合 / 单元素集合 / 乱序与重复的 `pushHours`

## 实现期判断

- **接缝**：`services/scheduler.ts`（`rearmScheduler` / `stopScheduler` / `schedulerTick` / `isSchedulerStalled` / `subscribedGameUnion`）、`utils/time.ts` 新增 `nextSelectedHour(nowMs, hours)`（纯函数, 严格大于）。
- **片 05 的前置一并落定**（它是本片触发序列的硬依赖, 当时未实现）：`services/staleness.ts`（`STALENESS_THRESHOLD_MS = 5min` 常量、`isStaleGame` / `getStaleGames`）、`services/scrape-lock.ts`（全局一把锁、FIFO 排队、错误不传染）、`price.handler` 改造为「只抓过期 + 抢锁后重算 + 归档 `manual:{会话键}`」。
- **共享编排**：`services/scrape-runner.ts` 的 `runScrapeRound(catalogs, trigger)` = 抓取 → 落 `data.json` → 至少一成功才写归档 + 顺带维护。调度器与手动抓取共用; 片 07 遗留的「接线留给片 08」在此兑现。
- **强制关闭浏览器**：抓取层起浏览器时向 `services/browser/active.ts` 登记句柄, `plugin_cleanup` 调 `closeActiveBrowser()`（fire-and-forget, 不等待）。互斥锁保证同一时刻至多一个浏览器, 登记口只留一个槽位。
- **配置变更接线**：三处配置写回点（`plugin_set_config` / `plugin_on_config_change` / WebUI `POST /config`）统一在写回后调 `rearmScheduler()`——重挂本身先取消再判停摆, 对未涉及三个关键项的变更结果等价, 代价只是一次空算, 换来不需要在各写回点重复 diff 字段。
- **tick 时浏览器不可用**：本轮跳过并照常重挂的判定交给 `rearmScheduler`（其浏览器检查会不再挂）——即"浏览器不可用 → 调度器不活动", 装好后下一次配置变更把它带回来。
- **推送环节留位**：`schedulerTick` 持锁段的末尾有注释锚点（释放锁之前）, 片 09 在此插入。
- **测试基建**：调度器用 `vi.useFakeTimers` 挂钟测试（跨整点重算、恰好整点、停摆均为确定性断言）; 新增 `tests/utils/time.test.ts`、`tests/services/{staleness,scrape-lock,scheduler}.test.ts`。全套 300 用例通过, `pnpm build` 通过（产物 6.63 MB, 与 §16 基线一致）。
- **实现期踩的坑**：`deps.now ?? Date.now()` 漏了调用——`deps.now` 是函数, 函数参与减法得 `NaN`, `NaN > 阈值` 恒 false, 表现为"永远新鲜"。正确写法 `deps.now?.() ?? Date.now()`。

## Blocked by

- [05 — 数据新鲜度与互斥排队](05-staleness-and-mutex.md)
