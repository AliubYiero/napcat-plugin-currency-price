# NapCat 插件权限范式

本文是适用于任意 NapCat 插件项目的权限通用范式, 覆盖角色的推导、比较、裁剪与超级管理员名单的配置。各项目遵循此范式时, 应将角色推导与判定函数集中在一个权限模块中 (下称"权限模块")。强度档位 (必须/应该/可以) 见 [development-pattern.md](./development-pattern.md) 的"规范强度分级"。

权限模块只回答"发送者是谁", 不回答"这条指令需要谁"——后者是指令定义里的门槛声明, 校验时机与反馈策略见 [instruction-pattern](./instruction-pattern.md)。

## 核心约束

1. 【必须】**推导而非配置**。除 `superAdmin` 需配置名单外, 角色全部从消息事件推导, 不维护"用户 → 权限"的数据面。
2. 【必须】**入口一次性推导, 下游复用**。`getUserRole(event)` 在消息入口调用一次, 分发层、帮助输出版本选择与业务 handler 共用同一个 `UserRole`, 不各自解析 `event.sender`。
3. 【必须】**线性比较**。角色按数值表线性排列, 权限判断一律是"至少 X 级"的 `>=` 比较, 不写矩阵式权限表。
4. 【必须】**校验收敛在分发层**。权限模块只提供推导与比较能力, 何时校验、失败如何反馈由分发层统一决定, handler 内不重复校验。见 [instruction-pattern](./instruction-pattern.md)。

## 范式正文

### 一、四档角色标准模型

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

设计依据:

- **推导而非配置**: `admin` 来自 QQ 平台的群身份 (`sender.role`), `privateUser` 来自私聊消息的 `sub_type` (`friend` = 好友, `group` = 群临时会话), 二者无需人工维护; 只有 `superAdmin` 需要配置名单。这样权限数据面最小化。
- **"好友私聊即提权"**: 与机器人互为好友的用户必然知晓其 QQ 号且经平台关系链约束, 视为可信度高于匿名群成员与非好友临时会话。非好友私聊降为 `user` 处理——这是领域决策。
- **线性比较**: `hasRole(user, required)` 即 `LEVEL[user] >= LEVEL[required]`, 一条比较覆盖所有"至少 X 级"的语义, 无需矩阵式权限表。

### 二、入口推导: getUserRole

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

要点:

- 【必须】推导按 superAdmin → privateUser → admin → user 的顺序**短路命中**, 一票定档, 不做档位叠加。
- 【必须】`from` 记录来源会话, 供作用域校验与推送目标复用——下游拿 `userRole.from.id` 就知道该往哪回。
- 【应该】`getUserRole` 是**纯函数** (只读事件的字段, 不触碰全局状态), 因此可被分发层、帮助输出、业务 handler 任意位置调用而不破坏生命周期铁律。唯一的例外是 `isSuperAdmin` 内部要读配置, 见"超级管理员"节。

### 三、群身份检查: isAdmin

【必须】群管理员身份只从消息事件的 `sender.role` 读取平台给出的判定结果 (`admin` = 群管理员, `owner` = 群主), **不自行调用群成员查询 API**——消息事件已带该字段, 额外查询只是浪费一次往返:

```ts
function isAdmin(event: OB11Message): boolean {
    if (event.message_type !== 'group') return false;
    const role = (event.sender as Record<string, unknown>)?.role;
    return role === 'admin' || role === 'owner';
}
```

要点:

- 【必须】该方法**只在群聊分支调用**。非群聊场景不存在"群身份", 因此返回 `false` 而非 `true`——返回 `true` 会让任何误在私聊路径上的调用静默通过权限判定。
- 【应该】`event.sender` 在类型定义中往往是宽松类型, 访问 `role` 时用 `as Record<string, unknown>` 收窄后再判等, 避免依赖可选字段链。

### 四、线性比较: hasRole

【必须】等级表与档位定义**同处一模块**, 新增档位时两处同步修改:

```ts
const ROLE_LEVEL: Record<UserRole['role'], number> = {
    user: 0,
    admin: 1,
    privateUser: 2,
    superAdmin: 3,
};

/** 判断角色是否达到所需档位 */
export function hasRole(userRole: UserRole, required: UserRole['role']): boolean {
    return ROLE_LEVEL[userRole.role] >= ROLE_LEVEL[required];
}
```

要点:

- 【必须】判定函数接收 `UserRole` 对象而非裸字符串, 避免调用方在传递过程中丢失来源会话信息。
- 【应该】`hasRole` 只做比较, 不负责拒绝与反馈; 拒绝路径 (静默还是提示) 属于分发层策略。

### 五、超级管理员: 唯一需要配置的档位

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

【必须】`isSuperAdmin` 是全模块中**唯一**触碰全局状态的函数, 因此 `getUserRole` 也只在运行期可用; 不要在模块加载期求值任何角色。

### 六、按机器人形态裁剪档位

四档是标准模型, 但【应该】按机器人形态自然裁剪档位, 并非都必须存在:

- **纯群聊机器人** (不响应私聊): `privateUser` 永远不会出现, 退化为 `user < admin < superAdmin` 三档。
- **纯私聊机器人**: `admin` 永远不会出现 (群管理员身份不存在), `user` 与 `privateUser` 语义重合, 退化为 `user < superAdmin` 两档。
- **混合场景**: 四档全保留。

【必须】裁剪只减少档位, **推导逻辑与线性比较机制不变**——这是本范式可迁移的核心。裁剪后 `ROLE_LEVEL` 表与 `UserRole['role']` 联合类型同步收窄, 让遗漏的档位在编译期暴露。

## 标准范式清单

新增角色档位或接入权限模块时:

- [ ] 【必须】更新 `UserRole['role']` 联合类型与 `ROLE_LEVEL` 等级表, 两处同步。
- [ ] 【必须】在 `getUserRole` 的短路链中插入新档位的推导分支, 顺序为 superAdmin → privateUser → admin → user。
- [ ] 【必须】若新档位需要配置名单, 同步四处: 类型、默认值、WebUI Schema、`sanitizeConfig` (见 [config-pattern](./config-pattern.md))。
- [ ] 【必须】裁剪档位时收窄联合类型与等级表, 不只删除推导分支。
- [ ] 【应该】新档位影响帮助输出时, 同步更新帮助变体映射 (见 [help-output-pattern](./help-output-pattern.md))。
- [ ] 【必须】业务代码判断权限一律用 `hasRole(userRole, xxx)`, 不自行比较角色字符串。

## 与其他范式的关系

- 与**生命周期铁律**的关系: 权限模块的推导函数是纯函数, 可模块加载期导出; 但 `isSuperAdmin` 读全局状态单例的配置, 整个模块只在 `plugin_init` 之后的运行期被调用。见 [development-pattern](./development-pattern.md) 与 [store-pattern](./store-pattern.md)。
- 与**指令分发范式**的关系: 分发层在调用 handler 前用 `hasRole` 完成校验, 失败静默; `InstructionDefinition.requiredRole` 的取值即 `UserRole['role']`。见 [instruction-pattern](./instruction-pattern.md)。
- 与**配置范式**的关系: 超管名单经 `sanitizeConfig` 一次性清洗为数组, 运行期无解析逻辑。见 [config-pattern](./config-pattern.md)。
- 与**帮助输出范式**的关系: 帮助变体由"角色 + 会话类型"共同决定, `UserRole` 是映射的输入; 权限档位与帮助版本档位不是一一对应。见 [help-output-pattern](./help-output-pattern.md)。
- 与**消息发送范式**的关系: 需要"仅管理员可用"的发送能力 (如 @全体成员) 时, 权限判定复用本文的 `getUserRole` / `hasRole`。见 [message-send-pattern](./message-send-pattern.md)。

## 参考实现

napcat-plugin-bilibili-monitor 项目: 权限推导与比较见 `packages/plugin/src/core/admin.ts`; 超管名单 (`adminUsers`) 的类型、默认值与清洗分别见 `packages/plugin/src/types.ts`、`config.ts` 与 `core/state.ts`; 分发层的角色校验见同目录指令模块。
