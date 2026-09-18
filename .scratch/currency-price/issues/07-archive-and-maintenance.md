# 07 — 归档与维护

Status: ready-for-human
Type: AFK
Blocked by: 04
来源: [docs/design.md](../../../docs/design.md) §7.3 §7.4 §7.5 §12.4 §14 §20.1

## What to build

端到端行为是：每次成功抓取后，当天的归档文件里多出一条**抓取运行**记录；第二天它自己变成 `.json.gz`；30 天后再自己消失。这一整套**不依赖有没有人订阅**。

要落定：

**归档文件** —— `archive/YYYY-MM-DD.json`，按日、**run 级**追加：

```json
{
  "date": "2026-09-16",
  "runs": [
    {
      "startedAt": "...", "finishedAt": "...", "trigger": "schedule",
      "games": { "<游戏名>": { "readAt": "...", "missing": [], "zones": [ ... ] } }
    }
  ]
}
```

- `runs[].games` 与 `data.json` 的 `games` **同构**——归档因此是「`data.json` 的历史切片」，渲染与校验各只有一份代码。
- `games[]` **只有本次实际抓取的游戏**；失败的游戏记 `{ "error": "..." }`。
- `trigger` 取 `"schedule"` 或 `"manual:{会话键}"`。
- **全部游戏失败时不写归档。**
- `startedAt` / `finishedAt` / `trigger` **由调度层记**，抓取层不管（§8.1）。

**生命周期** —— 当天实时追加；次日 gzip（**流式**）并删除原文件；30 天后删除过期 `.json.gz`。

**维护任务的挂载点（本片的关键决策）** —— `plugin_init` 完成后执行一次 **+ 每次成功抓取后顺带执行**。**不挂在调度器上**：早期设计把「压缩昨天 / 清理 30 天」放在「每次轮询开始时」，但并集为空或小时集合为空时调度器根本不启动，归档会**永远不被压缩、永远不被清理**。维护任务的存在不应取决于「有没有人订阅」。

**原子写** —— 归档同样用临时文件 + rename。

**错误处理** —— 归档 gzip 失败 → 保留未压缩文件 + 下次维护再试；磁盘写入失败 → 记日志 + 继续运行。

## Acceptance criteria

- [x] 成功抓取一次后，当天的归档文件里出现一条 `run`，`games` 只含本次实际抓取的游戏
- [x] 失败的游戏在 `runs[].games` 里记为 `{ "error": "..." }`
- [x] **全部游戏失败时不写归档**
- [x] 手动触发的 `trigger` 为 `manual:{会话键}`，定时触发的为 `schedule`
- [x] `runs[].games` 与 `data.json` 的 `games` 结构同构（同一份渲染/校验代码可通吃）——`recordRun` 直接收 `scrapeGames` 返回值，零转换
- [x] 把归档文件日期改成昨天后执行维护 → 被 gzip 成 `.json.gz` 且原 `.json` 被删除
- [x] 超过 30 天的 `.json.gz` 被清理
- [x] **订阅并集为空 或 `pushHours` 为空时，归档维护依然会执行**（这是本片的核心回归项）
- [x] `plugin_init` 完成后维护执行过一次
- [x] gzip 失败时保留未压缩文件，下次维护重试
- [x] 归档写入中断不产生半截文件（原子写）——gzip 产物同样走临时文件 + rename
- [x] 单测覆盖：归档追加、gzip 与删除、30 天清理边界、损坏文件不阻塞

## 实现期判断

- **接缝**：`packages/plugin/src/store/archive.store.ts` 的 `recordRun(run, now?)` 与 `runMaintenance(now?)`；挂载点在 `plugin_init`（`src/index.ts`）。`now` 注入，日期与 30 天边界直接可测。
- **日期基准**：归档文件名按**本地时区**日期分天（与展示层 `formatLocalTime` 同一基准）；文件内时间戳仍是 ISO UTC。
- **维护以文件名为准而非 mtime**：mtime 会被复制/同步污染；今天及未来的文件不压缩，恰好 30 天的保留（边界取"超过"）。
- **"每次成功抓取后顺带执行"的接线留给片 08**：当前 `scrapeGames` 尚无调用方，store 已就绪，调用方在调度接通时补 `recordRun` + `runMaintenance`。
- **测试基建补漏**：`test-env.ts` 的假 ctx 原来缺 `NapCatConfig`，`plugin_init` 在 `buildConfigSchema` 处即抛错——已补桩（透传型）。

## Blocked by

- [04 — 多游戏多区服与领域规则](04-multi-game-zone-rules.md)
