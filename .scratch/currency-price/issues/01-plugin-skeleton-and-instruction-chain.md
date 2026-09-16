# 01 — 插件骨架与指令链路贯通

Status: ready-for-agent
Type: AFK
Blocked by: 无
来源: [docs/design.md](../../../docs/design.md) §3 §5 §11

## What to build

**承重片**：其余每一片都长在它上面。把模板骨架改造成本插件自己的骨架，并让「消息进 → 回复出」这条链路在真机上完整跑通。

端到端行为是：用户在群里发 `@机器人 #currency help`，机器人回一条帮助文本；发一条拼错的子指令，机器人回未知指令文案；一个没有权限的用户尝试管理指令，机器人回权限不足文案。全程不需要重启，改配置前缀即时生效。

具体要落定：

**插件身份**——按设计文档 §3 的四个字段（`name` / `plugin` / `description` / `napcat.tags|minVersion|homepage`）落定。`git log` 显示 identity 已部分改过，核对并补全。

**配置全链路（四环节：类型 / 默认值 / 清洗 / 运行时读写）**——按设计文档 §5.1 落定全部字段。要点：

- **删除 `cooldownSeconds`** 及其在消息处理里的全部 CD 逻辑。指令冷却的语义已被「数据新鲜度阈值」取代，两者混用会让用户以为自己在被限流（见 `CONTEXT.md` 的「数据新鲜度阈值」_Avoid_）。
- `catalogs` 与 `pushHours` 都是数组，清洗规则不同：`pushHours` 是枚举数组（过滤非法值，**空数组合法，不回退默认**）；`catalogs` 是嵌套对象数组（逐字段递归清洗，整体不合法则丢弃该条目、其余保留）。
- `adminUsers` 在 WebUI 是逗号分隔文本，清洗层一次性转数组。
- `catalogs` **不生成 Schema 控件**——NapCat 的配置 Schema 只有 `boolean/text/number/select/multiSelect/html/combine`，没有数组或表格控件，`zoneConfigs` 是 `string[][]`，表达不出来。它仍走完整四环节，只是编辑入口换成片 10 的自定义页面。
- 默认 `catalogs` 用设计文档 §5.4 的三分区清单，**代码块里的注释必须原样保留**——它们是「为什么这份清单与隔壁那份不通用」的唯一记录。

**四档角色模型**——`user(0) < admin(1) < privateUser(2) < superAdmin(3)`，在消息入口一次性推导，不逐用户配置。超管名单来自 `adminUsers`。好友私聊 = `privateUser`；**群临时会话 = `user`**。

**指令注册表与分发**——声明式（handler + 可选 `requiredRole` / `scope`），分发层在调用 handler 前完成全部校验。链路：群启用判定 → `@机器人` CQ 段剥离 → 前缀匹配 → **先查二级命名空间，未命中再查一级** → 作用域校验 → 权限校验 → 执行。`#currency` 只有前缀、没有参数时路由到 `help`。

**首批指令**——`#currency` / `#currency help` 回**文本**帮助（图片链路在片 11）；`#currency status` 基础版。

**三类失败文案**（覆盖范式的默认静默策略，见 [ADR-0002](../../../docs/adr/0002-explicit-failure-feedback-over-silence.md)）——非法参数 / 未知指令 / 权限不足，各自如实区分，前缀取自配置不硬编码；作用域不符按范式回固定提示。

## Acceptance criteria

- [ ] 真机群聊与私聊里 `#currency help` 都有回复；`@机器人 #currency` 同样触发
- [ ] 三类校验失败各自输出对应文案（参数不合法 / 未知指令 / 权限不足），且文案里带的是**配置的**前缀而非硬编码
- [ ] 作用域不符时返回范式规定的固定提示
- [ ] 好友私聊（`privateUser`）能执行 admin 级指令；**群临时会话（`user`）不能**
- [ ] 超管在**别人的群里**也能执行 admin 级指令
- [ ] 通过 WebUI 改 `commandPrefix` 后前缀即时生效，无需重启
- [ ] `catalogs` 清洗：整体不合法的条目被丢弃，合法条目保留
- [ ] `pushHours` 清洗：非法值被过滤，**空数组保持为空、不回退默认**
- [ ] `adminUsers` 以逗号分隔文本输入，存下来是数组
- [ ] 全仓库不再出现 `cooldownSeconds` 与任何指令 CD 逻辑
- [ ] 单测覆盖四类失败分支（参数不合法 / 未知子命令 / 权限不足 / 作用域不符）

## Blocked by

None - can start immediately
