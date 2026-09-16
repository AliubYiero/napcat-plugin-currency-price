# 11 — 帮助输出全链路

Status: ready-for-agent
Type: AFK
Blocked by: 02
来源: [docs/design.md](../../../docs/design.md) §11.1 §19；[docs/help-output-pattern.md](../../../docs/help-output-pattern.md)
外部依赖: `napcat-help-generate`（独立项目，本机路径 `D:\Code\.project\87_napcat_plugin\napcat-help-generate`）

## What to build

端到端行为是：`#currency` 与 `#currency help` 都返回帮助；**有图时返回图片**，图缺失时**回退文本且内容一致**；返回的版本按「角色 + 会话类型」选变体。

这一片要把片 01 里那个临时的手写帮助文本，换成**权威源 → 生成 → 产物 → 运行时选变体**的完整链路。

要落定：

**权威源** —— 帮助内容的唯一来源，指令表按设计文档 §11.1 分组：

| 分组 | 内容 | 标记 |
| --- | --- | --- |
| 核心指令 | `price`、`status` | 无 |
| 辅助指令 | `help` | 无 |
| 管理指令 | `notify on\|off`、`game add\|remove` | `isAdmin` |

**生成脚本** —— 从权威源生成「文本映射 + 三张 PNG」（图片由独立项目 `napcat-help-generate` 渲染）。

**运行时** —— 图片优先、文本回退；按「角色 + 会话类型」共同决定变体（`user` / `admin` / `superAdmin`）。

**三档与权限档位不是一一对应** —— 角色档位是 `user < admin < privateUser < superAdmin`，帮助变体是 `user / admin / superAdmin`，映射不同：**群聊里超管输出 Admin 版**（见 `CONTEXT.md` 的「帮助变体」_Avoid_）。

**SuperAdmin 版与 Admin 版内容相同** —— 本插件无超管专属指令。仍按范式生成三档：代价只是多渲一张相同的图，换来的是将来加任何超管指令时只需改权威源。

**本片不含** `reload-chrome` 指令——浏览器重检只通过 WebUI 端点，由仪表盘按钮触发（片 06）。

## Acceptance criteria

- [ ] `#currency` 与 `#currency help` 都返回帮助，内容一致
- [ ] 有图片产物时返回图片；图片缺失时回退文本，且文本与图片表达的内容一致
- [ ] 群聊普通成员 → `user` 版；群聊超管 → **Admin 版**；好友私聊 → `privateUser` 对应的版本；群临时会话 → `user` 版
- [ ] 管理指令（`notify on|off`、`game add|remove`）**不出现**在 `user` 版里
- [ ] 帮助里的前缀随 `commandPrefix` 配置变化（不硬编码）
- [ ] 改权威源后重新生成，文本映射与三张 PNG 同步更新
- [ ] SuperAdmin 版与 Admin 版内容相同（当前如此，且生成链路支持将来只改权威源就能让两者产生差异）
- [ ] 三张 PNG 与文本映射都由生成脚本产出，不手工维护

## Blocked by

- [02 — 订阅关系与订阅指令](02-session-subscriptions.md)
