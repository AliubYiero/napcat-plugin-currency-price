# 01 — 插件骨架与指令链路贯通

Status: ready-for-human
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

- [x] 真机群聊与私聊里 `#currency help` 都有回复；`@机器人 #currency` 同样触发 —— 人工确认; 插件在部署机加载成功, 收发消息正常
- [x] 三类校验失败各自输出对应文案（参数不合法 / 未知指令 / 权限不足），且文案里带的是**配置的**前缀而非硬编码
- [x] 作用域不符时返回范式规定的固定提示
- [x] 好友私聊（`privateUser`）能执行 admin 级指令；**群临时会话（`user`）不能** —— 角色推导与分发校验均已单测; 端到端要等片 02 装上真实的 admin 级指令
- [x] 超管在**别人的群里**也能执行 admin 级指令 —— 同上
- [ ] 通过 WebUI 改 `commandPrefix` 后前缀即时生效，无需重启 —— **待人工**：接线已完成（`reactive: true` + `replaceConfig` 走清洗）, 待真机点一次
- [x] `catalogs` 清洗：整体不合法的条目被丢弃，合法条目保留
- [x] `pushHours` 清洗：非法值被过滤，**空数组保持为空、不回退默认**
- [x] `adminUsers` 以逗号分隔文本输入，存下来是数组
- [x] 全仓库不再出现 `cooldownSeconds` 与任何指令 CD 逻辑
- [x] 单测覆盖四类失败分支（参数不合法 / 未知子命令 / 权限不足 / 作用域不符）

## Blocked by

None - can start immediately

## Comments

### 2026-09-17 — 实现完成（TDD）

**验证结果**: `vitest run` 5 个文件 71 项全绿; `pnpm build` 通过（plugin `index.mjs` 27.13 kB
——playwright-core 尚未被引用, 抓取片接入后才会涨到 6.4 MB）; 本项目源码 `tsc --noEmit` 0 报错;
部署机确认加载成功。

**实现期定下的三处判断**（各自影响后续切片, 记在此处免得重复讨论）:

1. **分发层是纯函数**。`resolveInstruction(userRole, args, registry)` 返回判别联合
   (`execute` / `invalid-args` / `unknown-command` / `permission-denied` / `scope-mismatch`),
   不发送消息、不碰全局状态; 接收层拿结果决定回复什么。失败文案的渲染 `renderFailure` 与它同模块
   ——ADR-0002 明文规定"分发层对三类校验失败一律回复", 文案属于分发层的策略, 因此没有按设计文档 §6
   的草图放进 `utils/text.ts`。
2. **`InstructionDefinition` 多了一个 `validateArgs`**。设计文档 §11.2 的「非法参数」样例是
   `game add 原神`——合法取值取决于运行期 `catalogs`, 表达不进声明式的 `requiredRole` / `scope`。
   故加一个可选钩子 `validateArgs(args) => string | null`（返回出错的参数表示不合法）。
   **校验顺序固定为 作用域 → 权限 → 参数取值**: 权限先于取值, 免得把"合法取值有哪些"泄露给
   本来就无权执行的人（有单测守着）。
3. **`catalogs` 的条目合法性判据 = `name` 与 `pageUrl` 都是非空字符串**。二者是"去哪抓"的定位信息,
   缺任一即整条丢弃; `currencyList` / `zoneConfigs` 缺失只降级为空数组, 条目保留。`zoneConfigs`
   的**每一行必须整行都是字符串**, 否则丢弃该行——少一级的组合会静默指向另一个区服。

**顺带发现**: 调试 CLI (`napcat-plugin-debug-cli@1.2.8`) 自身有两个打包 bug——`cli.mjs` 里有
**重复 shebang**（直接 `node cli.mjs` 报 SyntaxError）, 且其内联的 ws 把 `bufferutil` 处理成了桩,
`info` / `list` 一律报 `bufferUtil$1.mask is not a function`。这正好反证了 `vite.config.ts` 里
"`bufferutil` 必须保持 external、不得改桩"那段警告。**当前无法用 CLI 查远程插件状态**,
远程可观测性仍只有 `runtimeError` 一条通道。

**留给后续切片的**:
- 真实的 admin 级指令（`notify on|off` / `game add|remove`）在片 02 进注册表, 本片的权限分支
  目前只由注入注册表的单测覆盖。
- 帮助内容当前是手写的临时文本（只列已实现的 `help` / `status`）, 由帮助输出片用生成产物整体替换。
- `status` 是基础版: 只报运行时长与已配置游戏; 浏览器行留给浏览器层。
