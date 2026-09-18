# 11 — 帮助输出全链路

Status: ready-for-human
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

- [x] `#currency` 与 `#currency help` 都返回帮助，内容一致
- [x] 有图片产物时返回图片；图片缺失时回退文本，且文本与图片表达的内容一致
- [x] 群聊普通成员 → `user` 版；群聊超管 → **Admin 版**；好友私聊 → `privateUser` 对应的版本；群临时会话 → `user` 版
- [x] 管理指令（`notify on|off`、`game add|remove`）**不出现**在 `user` 版里
- [x] 帮助里的前缀取自 `DEFAULT_CONFIG.commandPrefix`（**开发期常量**，非用户配置项——见 Comments 的决策）
- [x] 改权威源后重新生成，文本映射与三张 PNG 同步更新
- [x] SuperAdmin 版与 Admin 版内容相同（当前如此，且生成链路支持将来只改权威源就能让两者产生差异）
- [x] 三张 PNG 与文本映射都由生成脚本产出，不手工维护

## Blocked by

- [02 — 订阅关系与订阅指令](02-session-subscriptions.md)

## Comments

**落点**（与 `docs/help-output-pattern.md` 的职责切分一一对应）:

| 环节 | 文件 |
| --- | --- |
| 权威源 | `packages/plugin/scripts/generateHelp/cmds/napcat-plugin-currency-price.ts`（`buildCurrencyPriceHelp(prefix)`） |
| 生成脚本 | `packages/plugin/scripts/generateHelp/index.ts` + `scripts/tsconfig.json`；`pnpm help:generate` |
| 产物 | `src/assets/napcat-plugin-currency-price-{User,Admin,SuperAdmin}.png`、`src/handlers/currency/helpText.generated.ts` |
| 运行时 | `src/utils/helpMessage.ts`（`sendHelpMessage` / `getHelpVariant`）、`src/handlers/currency/help.handler.ts`（只剩 `HELP_IMAGE` 命名映射） |
| 静态资源上线 | `packages/plugin/vite.config.ts` 第 5 步把 `src/assets` 复制到 `dist/assets` |

**决策: 指令前缀固定为 `#currency`, 不再是用户配置项**（用户在本片拍板）。

前缀被烧进 PNG（渲染发生在生成期, 运行期没有渲染服务可用）, 所以"运行期可改前缀"与"帮助图上的指令敲得出来"二者不可兼得。选定的是前者让位于后者:

- `DEFAULT_CONFIG.commandPrefix` 保留, 但只作为**开发期常量**——改它的人必须同时重跑 `pnpm help:generate`；
- 清洗层 (`sanitizeConfig`) **忽略**外部写入的 `commandPrefix`, NapCat Schema 面板与 WebUI 配置页都不再提供该控件（WebUI 仪表盘仍**只读展示**当前前缀）;
- 同步改了 `CONTEXT.md` 的默认值语义声明与 `docs/design.md` §5.1 §11.1。

**生成脚本用 node 直跑**（`node scripts/generateHelp/index.ts`），没有引入 `tsx`: Node 22.18+ 原生剥离类型, 少一个 devDependency。代价是权威源只能用**可擦除语法**（不用 enum / namespace / 参数属性）。

**图片查找认两种布局**: 首选 `ctx.pluginPath/assets`（类型注释写明它是"插件目录路径", 而 `dist` 就是部署出去的插件目录），兜底 `dataPath/../assets`（姊妹项目 napcat-plugin-bilibili-monitor 的落法）。路径错了的表现是**静默降级成文本**, 多一次 `existsSync` 换掉这个静默风险。

**留给后续切片的 / 待人工确认**:

1. **真机确认（片 12）**: 单测覆盖到"发的是图片段、文件路径选对了变体", 但"图在 QQ 里真的发得出去"必须在部署机上跑一次——`send_msg` 的 `file` 传绝对路径在真实适配器上的行为, 以及 `pluginPath/assets` 在真实 NapCat 上的解析结果, 都只有真机能证。
2. **`#currency game`（列出可订阅游戏）与 `#currency notify`（查看开关）没有出现在帮助里**——设计文档 §11.1 的指令表里它们是 `user` 级, 但 §19 的帮助分组表（本片按它实现）只列了 `price` / `status` / `help`。两者能敲、能用, 只是帮助里查不到。要补的话是改权威源加一个分组 + 重跑生成, 一行的事; **本片按 §19 原样实现, 未擅自加内容**。
3. 本片不含 `reload-chrome`——浏览器重检只走 WebUI 端点（片 06）。已在 help.handler 的注释里留了边界说明(权威源里也没有它)。
