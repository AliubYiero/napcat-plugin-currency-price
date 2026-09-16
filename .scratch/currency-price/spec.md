# 千岛通货价格插件 — 切片索引

Status: ready-for-agent

权威来源是 [docs/design.md](../../docs/design.md)（定稿）。本目录不复制设计内容，只放实现切片；与设计文档冲突时以设计文档为准，先校对再改。

术语以 [CONTEXT.md](../../CONTEXT.md) 为准，实现范式以 [docs/*-pattern.md](../../docs/index.md) 为准，[ADR-0001](../../docs/adr/0001-page-click-over-direct-api.md) **不可违背**。

## 切片

| # | 切片 | 类型 | 依赖 |
| --- | --- | --- | --- |
| 01 | [插件骨架与指令链路贯通](issues/01-plugin-skeleton-and-instruction-chain.md) | AFK | 无 |
| 02 | [订阅关系与订阅指令](issues/02-session-subscriptions.md) | AFK | 01 |
| 03 | [抓取层贯通：单游戏单区服到 price 展示](issues/03-scraper-end-to-end.md) | AFK | 02 |
| 04 | [多游戏多区服与领域规则](issues/04-multi-game-zone-rules.md) | AFK | 03 |
| 05 | [数据新鲜度与互斥排队](issues/05-staleness-and-mutex.md) | AFK | 04 |
| 06 | [浏览器检测与一键安装](issues/06-browser-detect-and-install.md) | AFK | 03 |
| 07 | [归档与维护](issues/07-archive-and-maintenance.md) | AFK | 04 |
| 08 | [调度器（小时集合）](issues/08-scheduler.md) | AFK | 05 |
| 09 | [通知层（模板 / 串行 / 旧值标记）](issues/09-notifier.md) | AFK | 08, 02 |
| 10 | [WebUI 分区配置页与群管理页](issues/10-webui-catalog-and-sessions.md) | AFK | 04, 02 |
| 11 | [帮助输出全链路](issues/11-help-output.md) | AFK | 02 |
| 12 | [真实环境联调验收](issues/12-real-environment-integration.md) | HITL | 全部 |

## 已完成，不在此列

- **第 0 步打包 spike**（`playwright-core` 内联 + 真机 launch/goto），2026-09-17 通过，结论已回写设计文档 §8.2 与 §17。

## 未排片的已知项

设计文档 §21「已知未解决 / 待观察」的条目（站点改版即失效、列表虚拟滚动假设、单条价格的 `--` 与名称未匹配共用 `null`、抓取耗时上限、推送间隔 100ms 未实测）**不是切片**——它们是观察项，不宜伪装成可交付的工作。
