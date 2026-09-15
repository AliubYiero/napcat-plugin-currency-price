# NapCat 插件指令分发范式

本文是适用于任意 NapCat 插件项目的指令分发通用范式, 覆盖从消息接收到指令执行的完整链路: 前缀检查、参数切词、注册表分发、权限与作用域校验。各项目遵循此范式时, 应将消息接收入口、指令注册表与权限推导分别放在独立的 handler / core 模块中。强度档位 (必须/应该/可以) 见 [development-pattern.md](./development-pattern.md) 的"规范强度分级"。

发送消息的工具函数规范不在本文范围, 参见 [message-send-pattern](./message-send-pattern.md)。

## 核心约束

1. 【必须】**四层链路, 各层只做自己的事**: 接收层不认识指令语义, 分发层不做业务, 执行层不再做权限校验。业务 handler 收到的参数已保证满足角色与作用域要求, 可直接执行。
2. 【必须】**权限在入口推导, 校验在分发层统一完成**: 权限检查散落在接收层或 handler 内会随指令增多而失控。
3. 【必须】**校验失败反馈不对称是设计而非偶然**: 权限不足与未知指令静默 (防权限探测), 作用域不符回复提示 (可用性)。

## 范式正文

### 一、接收层: handleMessage

接收层职责固定为四步, 顺序不可调换:

1. 【必须】**群启用检查**: 群消息先查该群是否启用插件, 未启用直接返回 (先于前缀检查, 避免在禁用群里做无谓的字符串处理)。
2. 【必须】**前缀检查**: `rawMessage` 必须以配置的 `commandPrefix` 开头, 否则静默返回。前缀不匹配是绝大多数消息的正常路径, **不回复、不记日志**。
3. 【必须】**切词**: 去掉前缀后 `trim().split(/\s+/)` 得到参数数组。空串会切出 `['']`, 由分发层的参数检查兜底。
4. 【必须】**分发**: 将参数数组交给分发层。

要点:

- 【必须】整个 `handleMessage` 包在 try/catch 中, 任何异常记日志不外抛——它是所有消息事件的入口, 异常外抛会影响插件宿主。
- 【应该】前缀与群启用状态读自配置, 运行期生效, 无需重启。
- 【必须】接收层**不做权限校验**。权限属于指令语义, 由分发层统一处理。

### 二、分发层: 注册表工厂

#### 指令命名空间

指令支持一级与二级两种命名空间形态:

- **二级命名空间**: `模块 → 子指令` (如 `#mybot reminder add`), 注册在两级字典 `instructionSetMapper` 中。
- **一级命名空间**: 无模块前缀的直达指令 (如 `#mybot help`), 注册在单级字典 `rootInstructionSetMapper` 中。

【必须】分发时先查二级 (`arg1` 为模块名、`arg2` 为子指令名), 未命中再查一级 (`arg1` 为指令名, `arg2` 起为参数)。两种形态最终汇入同一个 `dispatch` 校验终点。

```ts
// 二级: 模块 -> 子指令 -> 定义
const instructionSetMapper: Record<
    string,
    Record<string, InstructionDefinition>
> = {
    reminder: {
        add: { handler: addReminderHandler },
        list: { handler: listReminderHandler, scope: 'group' },
        // ...
    },
    // ...
};

// 一级: 指令名 -> 定义
const rootInstructionSetMapper: Record<string, InstructionDefinition> = {
    // help: { handler: helpHandler },
};
```

要点:

- 【必须】**新增指令 = 注册表加一行**。handler 写成独立文件按模块分目录 (如 `handlers/reminder/`), 注册表只做装配, 不含业务逻辑。
- 【必须】指令名在分发前统一 `toLocaleLowerCase()`, 指令不区分大小写。
- 【必须】未命中模块/子指令/一级指令时**静默返回**。未知指令不回复提示, 防止机器人被任意文本触发刷屏。

#### 指令定义 (InstructionDefinition)

```ts
interface InstructionDefinition {
    handler: InstructionHandler;
    /** 执行所需最低角色, 缺省 user (所有人可用) */
    requiredRole?: UserRole['role'];
    /** 允许的会话类型, 缺省不限 */
    scope?: 'group' | 'private';
    /** 形态化作用域规则 (进阶, 见下文) */
    scopeRules?: ScopeRule[];
}
```

【必须】一个定义 = 一个执行函数 + 可选的门槛声明。分发层在调用 `handler` 前完成全部校验, handler 内部**不再重复校验**。

### 三、权限模型: 四档角色 + 线性比较

#### 标准模型

【必须】角色在**消息入口处推导** (而非为每个用户配置), 四档线性排列, 比较靠数值表:

| 角色 | 来源 | 说明 |
| --- | --- | --- |
| `superAdmin` | 配置名单 (QQ 号数组, 如 `adminUsers`) | 插件属主 |
| `privateUser` | 机器人好友的私聊用户 (`event.sub_type === 'friend'`) | 等同 admin 权限组 |
| `admin` | 群聊场景的群管理员/群主 | 来自消息事件中的群身份 |
| `user` | 其余所有人 | 缺省档 |

```
user(0) < admin(1) < privateUser(2) < superAdmin(3)
```

【应该】`getUserRole(event)` 在入口一次性推导出发送者的角色与来源会话 (`from: { id, type }`), 返回的 `UserRole` 同时供权限校验与帮助输出版本选择使用。

设计依据:

- **推导而非配置**: `admin` 来自 QQ 平台的群身份 (`sender.role`), `privateUser` 来自私聊消息的 `sub_type` (`friend` = 好友, `group` = 群临时会话), 二者无需人工维护; 只有 `superAdmin` 需要配置名单。这样权限数据面最小化。
- **"好友私聊即提权"**: 与机器人互为好友的用户必然知晓其 QQ 号且经平台关系链约束, 视为可信度高于匿名群成员与非好友临时会话。非好友私聊降为 `user` 处理——这是领域决策。
- **线性比较**: `hasRole(user, required)` 即 `LEVEL[user] >= LEVEL[required]`, 一条比较覆盖所有"至少 X 级"的语义, 无需矩阵式权限表。

#### 裁剪指引

四档是标准模型, 但【应该】按机器人形态自然裁剪档位, 并非都必须存在:

- **纯群聊机器人** (不响应私聊): `privateUser` 永远不会出现, 退化为 `user < admin < superAdmin` 三档。
- **纯私聊机器人**: `admin` 永远不会出现 (群管理员身份不存在), `user` 与 `privateUser` 语义重合, 退化为 `user < superAdmin` 两档。
- **混合场景**: 四档全保留。

【必须】裁剪只减少档位, **推导逻辑与线性比较机制不变**——这是本范式可迁移的核心。

#### 权限模块参考实现

权限模块整体很小, 可直接复制到新项目后按需裁剪档位。四部分职责:

**UserRole 类型**——角色推导的返回结构, 一次推导、处处使用:

```ts
export interface UserRole {
    userId: string; // 用户QQ号
    role: 'user' | 'admin' | 'privateUser' | 'superAdmin';
    from: {
        id: string;                      // 群号或用户QQ号
        type: 'private' | 'group';
    };
}
```

**getUserRole(event)**——入口推导函数, 分发层与帮助输出都从这里取角色:

```ts
export function getUserRole(event: OB11Message): UserRole {
    const userId = String(event.user_id);
    const isGroup = event.message_type === 'group';

    let role: UserRole['role'] = 'user';
    if (isSuperAdmin(userId)) {
        role = 'superAdmin';
    } else if (!isGroup) {
        // 仅机器人好友的私聊等同 admin 权限组
        // (sub_type: friend=好友, group=临时会话)
        if (event.sub_type === 'friend') {
            role = 'privateUser';
        }
    } else if (isAdmin(event)) {
        role = 'admin';
    }

    return {
        userId,
        role,
        from: {
            id: isGroup ? String(event.group_id) : String(event.user_id),
            type: isGroup ? 'group' : 'private',
        },
    };
}
```

要点: 【必须】推导按 superAdmin → privateUser → admin → user 的顺序**短路命中**, 一票定档, 不做档位叠加; `from` 记录来源会话, 供作用域校验与推送目标复用。

**isAdmin(event)**——群身份检查, 从消息事件的 `sender.role` 读取平台给出的群身份 (`admin` = 群管理员, `owner` = 群主):

```ts
function isAdmin(event: OB11Message): boolean {
    if (event.message_type !== 'group') return true;
    const role = (event.sender as Record<string, unknown>)?.role;
    return role === 'admin' || role === 'owner';
}
```

**isSuperAdmin(qq) + getAdminUsers()**——超级管理员名单判断 (见下文)。

#### 超级管理员的配置与解析

`superAdmin` 是四档中唯一需要人工配置的档位, 配置面刻意最小化:

- 【应该】**配置载体**: 插件配置项 `adminUsers` (`string[]`)。WebUI 中以文本输入呈现, 多个 QQ 号用英文逗号分隔; 配置文件中直接存数组。
- 【必须】**解析时机: 清洗而非使用**。字符串 → 数组的解析 (`split(',')` → `trim()` → 剔除空段) 在 `sanitizeConfig` 中**一次性完成** (见 [config-pattern](./config-pattern.md) 的字符串列表规则), 运行期始终是干净的 `string[]`。使用方 (权限判断、批量通知) 直接读数组, **不重复解析字符串**。
- 【必须】**判断逻辑**: `isSuperAdmin(qq)` 做数组包含检查, 在 `getUserRole` 中**最先**短路判定——超管身份高于一切会话类型推导, 群聊里的超管与私聊里的超管都是 `superAdmin`。
- 【必须】**无删除手段**: 名单中不存在"降权"指令, 移除超管 = 从配置中删去其 QQ 号。这一档位设计上就不接受来自消息侧的变更 (防止超管被指令篡改)。

```ts
// 权限模块: 使用方直接读数组
export function isSuperAdmin(qq: string): boolean {
    return pluginState.config.adminUsers.includes(qq);
}
```

### 四、作用域校验: scope 与 scopeRules

#### 指令级 scope

【应该】`scope: 'group' | 'private'` 声明指令允许的会话类型, 缺省不限。作用域不满足时回复固定提示 ("该指令仅限群聊使用"/"该指令仅限私聊使用") 后返回。

#### scopeRules: 按参数个数分形态 (进阶)

同一指令不同参数个数可以绑定不同权限/作用域 (如 `max`: 无参查看是 admin 级、带参设置是超管级):

```ts
max: {
    handler: setLimitHandler,
    scopeRules: [
        { args: 0, scope: 'group', requiredRole: 'admin' },
        { args: 1, scope: 'group', requiredRole: 'superAdmin' },
        { args: 3, scope: 'private', requiredRole: 'superAdmin' },
    ],
},
```

⚠️ 【必须】**未命中即静默**: `scopeRules` 命中逻辑是"按 `args` 数匹配第一条规则", **未命中任何形态时静默返回**, 不进入 handler。这确保权限防线闭合——不存在"分发层未校验、handler 又未设防"的穿透路径; 代价是形态枚举必须完备, 漏写形态会导致该参数个数的合法调用被静默吞掉。新增参数形态时必须同步补充 `scopeRules` 条目。

### 五、校验失败的反馈策略

【必须】分发层对两类校验失败采取**不对称**策略, 这是有意设计而非偶然:

| 失败类型 | 行为 | 理由 |
| --- | --- | --- |
| 权限不足 | **静默忽略** | 防权限探测。若回复"权限不足", 攻击者可通过枚举指令名区分"指令存在但无权"与"指令不存在", 映射出插件的完整指令面 |
| 作用域不符 | **回复提示** | 可用性。作用域不是敏感信息 (指令是否支持群聊对用户无攻击价值), 静默反而让用户误以为指令无效 |
| 未知指令 | **静默返回** | 同权限不足, 不暴露指令面 |

## 标准范式清单

新增一个指令时:

- [ ] 【必须】在 `handlers/<模块>/xxx.handler.ts` 写业务 handler, 函数签名 `(ctx, event, commands) => void`, 内部不做权限/作用域校验。
- [ ] 【必须】在 `instructionSetMapper` 对应模块下注册: `{ handler }`, 按需声明 `requiredRole` / `scope`。
- [ ] 【应该】参数形态绑定不同权限时才用 `scopeRules`, 并确认所有形态已枚举完备 (未命中形态会被静默吞掉)。
- [ ] 【应该】权限档位需要调整时改权限模块的推导函数与等级表, 不改分发层。
- [ ] 【必须】回复一律走发送工具模块, 不直接调 `ctx.actions.call`。
- [ ] 【必须】新增角色档位时: 更新等级表 + 推导函数 + 帮助输出版本映射, 三处同步。

## 与其他范式的关系

- 与**生命周期铁律**的关系: 注册表与 handler 均为纯装配 (构造期零 IO), 可模块加载期导出; 消息事件只在运行期到达。见 [development-pattern](./development-pattern.md)。
- 与**配置范式**的关系: 前缀、群启用开关、超管名单均读自配置, 经 `sanitizeConfig` 清洗后使用; 会话开关在接收层最前端短路。见 [config-pattern](./config-pattern.md)。
- 与**消息发送范式**的关系: 所有回复走发送工具模块。见 [message-send-pattern](./message-send-pattern.md)。
- 与**帮助输出范式**的关系: 帮助指令按"角色 + 会话类型"选输出版本 (而非仅按角色), 版本档位与权限档位不是一一对应。见 [help-output-pattern](./help-output-pattern.md)。

## 参考实现

napcat-plugin-bilibili-monitor 项目: 消息接收入口见 `packages/plugin/src/handlers/message-handler.ts`, 指令注册表与分发见同目录指令模块, 权限推导见 `packages/plugin/src/core/admin.ts`; 示例业务 handler 为 live 模块的 `addLiveHandler` / `mentionLiveHandler` / `maxLiveHandler`。
