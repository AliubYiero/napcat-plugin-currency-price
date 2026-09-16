# 02 — 订阅关系与订阅指令

Status: ready-for-agent
Type: AFK
Blocked by: 01
来源: [docs/design.md](../../../docs/design.md) §7.1 §7.5 §11.1 §11.4 §14

## What to build

端到端行为是：群里的管理员发 `#currency game add 流放之路2`，这个群就订阅了该游戏；发 `#currency notify on`，这个群开始接收主动推送。别的群和私聊各自独立，互不影响。机器人重启后订阅关系还在。

这一片也把片 01 里只能靠单测验证的「权限不足」分支变成真机可端到端验证的路径——`notify` / `game` 是 admin 级，普通群成员发就是权限不足。

要落定：

**订阅存储** —— `state.json`：`{ version, sessions: { "group:123456": { notifyEnabled, enabledGames } } }`。判定式与默认值：`notifyEnabled` **默认关闭**（机器人一装上就向所有群推送价格是不可接受的，主动推送必须由用户显式订阅）；`enabledGames` 是该会话订阅的游戏名。

**这个文件不含任何全局时间戳**。早期设计的 `lastDataReadAt` / `lastDataSuccess` 已删除——新鲜度判定下沉到 `data.json` 的游戏级 `readAt`。它是**纯粹的订阅关系表**，不混入数据状态。

**订阅指令** —— `notify`（查看）与 `notify on|off`（`admin`）；`game`（列出配置中的游戏并标出本会话已订阅的）与 `game add|remove <游戏名>`（`admin`，**游戏名精确匹配**，匹配对象是 `catalogs` 里的游戏名）。`status` 补全为完整版：通知开关 / 已订阅游戏 / 各游戏数据时间。

`status` 的最后一行「浏览器：可用」**只对「私聊 + superAdmin」显示**——普通成员看浏览器状态没有意义，也不该暴露部署细节。该行的数据来源在片 06 落地；本片先按可见性规则把位置留出。

**原子写与损坏恢复** —— 临时文件 + rename；文件损坏时备份为 `*.bak` 并初始化为空结构，**不阻塞启动**。

## Acceptance criteria

- [ ] `#currency notify on|off` 切换本会话通知，重启 / 重载后保持
- [ ] `#currency notify`（不带参数）回显当前开关状态
- [ ] `#currency game add 流放之路2` 后该会话订阅该游戏；`game list` 标出已订阅的
- [ ] `game add` 传一个不在 `catalogs` 里的名字 → 「非法参数」文案
- [ ] `game remove` 一个未订阅的游戏不会报错崩溃
- [ ] 群与私聊的订阅互相独立，互不影响
- [ ] 群普通成员发 `notify on` / `game add` → 「权限不足」文案（覆盖 ADR-0002 的显式反馈）
- [ ] `#currency status` 显示通知开关、已订阅游戏、各游戏数据时间
- [ ] 「浏览器：可用」行**只对「私聊 + superAdmin」**出现
- [ ] `state.json` 损坏时备份为 `*.bak` 并初始化为空，插件正常启动
- [ ] 写入被中断不产生半截文件（原子写）
- [ ] `state.json` 里**不存在**任何全局时间戳字段

## Blocked by

- [01 — 插件骨架与指令链路贯通](01-plugin-skeleton-and-instruction-chain.md)
