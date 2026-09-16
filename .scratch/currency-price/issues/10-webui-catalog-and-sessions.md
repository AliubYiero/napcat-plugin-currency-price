# 10 — WebUI 分区配置页与群管理页

Status: ready-for-agent
Type: AFK
Blocked by: 04, 02
来源: [docs/design.md](../../../docs/design.md) §5.2 §13

## What to build

端到端行为是：管理员在「分区配置」页改一个游戏的页面 URL 或区服组合，保存后**下一次抓取就用新配置**，不用重启；在「群管理」页看到每个会话的通知开关与已订阅游戏——**看到的是真实订阅数据，不是一份没人读的死 UI**。

要落定：

**分区配置页** —— `catalogs` 编辑器：游戏名、页面 URL、通货清单、区服组合。配 `GET /catalogs` 与 `POST /catalogs` 端点。

`pageUrl` **原样存整条**（含 `catalogName` / `islandId` / `tagIds` / `attributeId` / `entryId` / `entryType` 六个 query 参数）。**为什么**：那几个参数是站点改版时最先变的东西。拆成结构字段会让「从浏览器复制一条 URL」变成手工拆解六个参数，更容易错。`specId` 本来就不进配置（运行时从级联接口解析），说明配置的定位是「声明去哪抓」，而非「声明站点的内部结构」。

`zoneConfigs` 是 `string[][]`、`currencyList` 是字符串数组——这正是 `catalogs` 走自定义页而非 Schema 控件的原因（NapCat 配置 Schema 没有数组或表格控件）。

**群管理页改造** —— 模板自带的 `GroupsPage` 读的是 `groupConfigs`，**必须改造**成读 `state.json` 展示各会话的通知开关与已订阅游戏。**否则会变成一份没人读的死 UI**：`groupConfigs` 在本插件里只有「会话级启用开关」一个字段，而用户真正关心的是订阅了什么、收不收推送。配 `GET /sessions`。

**仪表盘** —— 插件状态 / 运行时长 / 统计 + 各游戏最后抓取时间。（浏览器状态卡在片 06 落地。）

**生效方式** —— 页面改完保存即生效，无需重启。`price` 与调度器下次执行时读到的是新配置。

**配置清洗在保存路径上同样生效** —— 页面 POST 上来的 `catalogs` 要走与配置加载同一套清洗（非法条目丢弃、其余保留），不能只信前端。

## Acceptance criteria

- [ ] 在分区配置页改 `pageUrl` / `zoneConfigs` / `currencyList` 并保存后，**下一次抓取按新配置执行**，无需重启
- [ ] `pageUrl` 原样存储与回显，六个 query 参数一个不丢、不做结构拆分
- [ ] 页面能增删改游戏（含新增一个游戏），新增后 `game` 指令与调度器都能看到它
- [ ] `zoneConfigs` 支持不同层数（2 级与 3 级）的编辑
- [ ] 群管理页展示的是 `state.json` 的**会话订阅关系**（通知开关 + 已订阅游戏），**不是** `groupConfigs`
- [ ] 群管理页能反映 `notify on|off` 与 `game add|remove` 在群里的改动
- [ ] 仪表盘显示各游戏最后抓取时间
- [ ] `GET /catalogs` 的返回与 `plugin_get_config` 中的 `catalogs` 一致
- [ ] `POST /catalogs` 的非法条目被清洗丢弃、合法条目保留，**不只是前端校验**
- [ ] 保存配置后 `GET /sessions` 与 `state.json` 内容一致

## Blocked by

- [04 — 多游戏多区服与领域规则](04-multi-game-zone-rules.md)
- [02 — 订阅关系与订阅指令](02-session-subscriptions.md)
