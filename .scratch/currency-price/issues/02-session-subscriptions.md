# 02 — 订阅关系与订阅指令

Status: ready-for-human
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

- [x] `#currency notify on|off` 切换本会话通知，重启 / 重载后保持 —— 单测走真实 fs + 模拟重载（数据目录不变、宿主上下文全新）
- [x] `#currency notify`（不带参数）回显当前开关状态
- [x] `#currency game add 流放之路2` 后该会话订阅该游戏；`game list` 标出已订阅的
- [x] `game add` 传一个不在 `catalogs` 里的名字 → 「非法参数」文案
- [x] `game remove` 一个未订阅的游戏不会报错崩溃
- [x] 群与私聊的订阅互相独立，互不影响
- [x] 群普通成员发 `notify on` / `game add` → 「权限不足」文案（覆盖 ADR-0002 的显式反馈）—— 已从"注入注册表的单测"变成**真实注册表的端到端路径**; 真机确认通过
- [x] `#currency status` 显示通知开关、已订阅游戏、各游戏数据时间 —— 数据时间在片 03 接入 `data.json` 前一律「未抓取」
- [x] 「浏览器：可用」行**只对「私聊 + superAdmin」**出现 —— 四条可见性分支（私聊超管 / 群内超管 / 私聊好友 / 群成员）均有单测
- [x] `state.json` 损坏时备份为 `*.bak` 并初始化为空，插件正常启动
- [x] 写入被中断不产生半截文件（原子写）
- [x] `state.json` 里**不存在**任何全局时间戳字段

## Blocked by

- [01 — 插件骨架与指令链路贯通](01-plugin-skeleton-and-instruction-chain.md)

## Comments

### 2026-09-17 — 实现完成（TDD）

**验证结果**: `vitest run` 11 个文件 135 项全绿（片 01 结束时是 5 文件 71 项）;
`pnpm build` 通过（plugin `index.mjs` 27.13 → **35.10 kB**）; 本项目源码 `tsc --noEmit` 0 报错。

**缝（seam）**——开写前与用户确认的四处, 后续切片沿用:

1. `src/store/atomic-json.ts` —— 原子写与损坏备份的**唯一实现**, 片 03 的 `data.json`、片 07 的归档复用。
2. `src/store/session.store.ts` —— `SessionStore.getInstance()` + `getSession / setNotifyEnabled / addGame / removeGame / getSessions`。
3. `src/core/session.ts` —— `sessionKeyOf(from)` / `sessionScopeLabel(from)`。
4. 指令层 —— 用**真实注册表**跑分发校验, 用 `handleMessage`（真入口）跑 handler, 断言实际发出的消息文本。

**测试基建**: `tests/helpers/test-env.ts` 造一个假 ctx + 临时数据目录, **其余跑真实文件系统**——落盘、原子写、`*.bak` 备份因此是真跑出来的, 不是断言出来的。`createTestEnv(root)` 传上次的 root 即可模拟插件重载。

**实现期定下的判断**:

1. **`SessionStore` 不缓存**: 每次读写都现读文件, 不在内存里留副本。文件只有几百字节、指令是低频操作, 缓存换不来什么, 却要引入"内存与磁盘谁覆盖谁"的一致性问题——而 `state.json` **还有一个 WebUI 读者**（片 10 的群管理页），双写方下缓存必然出问题。
2. **`notify` / `game` 既是命名空间又是一级指令**: 查看视图（`notify` / `game`）挂**一级**, 开关（`on|off` / `add|remove`）挂**二级**。分发层查不到二级子指令时会回落查一级, 于是 `game bogus` 会落到"列出游戏"上——新增 `rejectUnexpectedArgs` 把这种回落变成「非法参数 bogus」, 免得打错子指令的用户以为指令生效了。
3. **`game remove` 不校验 `catalogs`**（与 `add` 不对称）: 游戏一旦被从配置里删掉, 订阅它的会话就再也退不掉, 只能手改文件。退订不存在的游戏因此是幂等空操作, 如实回「未订阅：X」。
4. **`renderFailure` 的「非法参数」在参数缺失时收掉尾随空格**（`game add` 后面什么都没跟 → 不再渲染成 `非法参数 ` 带个尾空格）。对片 01 已覆盖的用例是零影响。
5. **status 的「各游戏数据时间」一律「未抓取」**: 数据源（`data.json` 的游戏级 `readAt`）在片 03 落地, 而"从未抓到过"就是此刻的事实, 不是占位符。片 03 只需替换那一行的取数, 四段结构与可见性规则已定。
6. **顺手更新了帮助文本**: 片 01 留的临时文本里写着「管理指令（待后续实现）」, 本片落地 `notify` / `game` 后那句话就成了假话, 一并换成真实指令清单（`price` 仍不预告——它还没实现）。片 11 会用生成产物整体替换。

**留给后续切片的**:
- 片 03: 注册表加 `price`; `statusHandler` 的那行「未抓取」换成读 `data.json` 的 `readAt`。
- 片 06: `statusHandler` 的「浏览器：未检测」换成真实检测结果缓存（可见性规则已就位, 不要顺手放宽）。
- 片 10: 群管理页 `/sessions` 直接读 `SessionStore.getSessions()`。

**真机确认通过**（2026-09-17, 部署机实测确认）, 确认清单:
1. 群管理员发 `#currency notify on` → 「本群通知：已开启」; 重启/重载插件后发 `#currency notify` 仍是已开启。
2. 群普通成员发 `#currency notify on` / `#currency game add 流放之路2` → 「权限不足」文案。
3. 群管理员发 `#currency game add 流放之路2` → 「已订阅：流放之路2」, 随后 `#currency game` 里该游戏带「（已订阅）」。
4. 同一台机器上换个群发 `#currency game` → 不显示已订阅; 好友私聊同理（会话互相独立）。
5. `#currency status` 四段齐全; 用超管**私聊**发能看到「浏览器：未检测」, 在群里发看不到。
6. 调试机上手工把 `state.json` 改成 `{` 坏内容 → 重载插件, 插件正常加载、文件被备份成 `state.json.bak`。
