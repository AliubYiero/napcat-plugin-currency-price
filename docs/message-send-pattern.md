# NapCat 插件消息发送范式

本文是适用于任意 NapCat 插件项目的消息发送通用范式, 覆盖发送 API 的选型规则、消息段的构造方式与错误处理约定。各项目遵循此范式时, 应将所有发送工具集中在一个工具模块中 (下称"发送工具模块")。强度档位 (必须/应该/可以) 见 [development-pattern.md](./development-pattern.md) 的"规范强度分级"。

## 核心约束: 收敛发送入口

插件内所有消息发送最终都通过 `ctx.actions.call(...)` 调用 OneBot 11 的 action 完成。如果业务代码分散地直接调用 `ctx.actions.call('send_msg', ...)`, 会带来三个问题:

1. **目标推断重复**。群消息 / 私聊消息的参数结构不同 (`group_id` vs `user_id`), 每处调用都要自行判断 `event.message_type`, 容易漏分支。
2. **错误处理不一致**。发送失败 (网络异常、账号风控、目标不存在) 的处理逻辑会散落在各个调用点。
3. **类型不安全**。绕过工具函数意味着绕过其参数类型约束。

由此得出两条铁律:

1. 【必须】**发送必须走发送工具模块提供的四个工具函数**, 禁止在业务代码中直接调用 `ctx.actions.call('send_msg' | 'send_group_msg' | 'send_private_msg' | ...)`。
2. 【必须】**复杂消息 (多段消息、含图片/表情等消息段的消息) 必须用 `createXxxMessage` 工厂函数构造**, 禁止在业务代码中手写 `{ type: 'text', data: { ... } }` 字面量 (工厂未覆盖的消息段类型除外, 见下文)。

## 范式正文

### 发送工具模块应提供的 API: 按场景三分法

【必须】发送工具模块应提供以下四个函数, 各有明确的适用场景, 按"是否持有 event"和"目标类型"选择:

| 函数 | 场景 | 典型调用方 |
| --- | --- | --- |
| `sendReply(ctx, event, message)` | handler 中**响应收到的消息** (有 `event` 可推断目标) | 各 handler (指令响应、错误提示) |
| `sendGroupMessage(ctx, groupId, message)` | **主动推送**到指定群 (无 event) | service (状态通知、日报推送) |
| `sendPrivateMessage(ctx, userId, message)` | **主动推送**到指定用户私聊 (无 event) | service |
| `sendForwardMsg(ctx, target, isGroup, nodes)` | 发送**合并转发**消息 (可选, 暂未使用时可视为预留能力) | — |

参考实现 (可直接复制到新项目):

- `sendReply` 内部根据 `event.message_type` 分支构造 `send_msg` 参数: 群消息带 `group_id`, 私聊带 `user_id`, 调用方无需关心。
- `sendGroupMessage` / `sendPrivateMessage` 分别封装 `send_group_msg` / `send_private_msg`。
- `sendForwardMsg` 按 `isGroup` 选择 `send_group_forward_msg` / `send_private_forward_msg`, 节点类型为 `ForwardNode` (见下文)。
- 【必须】四个函数统一返回 `Promise<boolean>`: 内部 try/catch, 失败时记录日志并返回 `false`, **不向调用方抛出**。

要点:

- 判断标准很简单: **有 `event` 就用 `sendReply`, 没有就按目标类型选 `sendGroupMessage` / `sendPrivateMessage`**。不要在 handler 里从 `event` 手动提取 `group_id` 再调 `sendGroupMessage`, 那是重复实现 `sendReply` 的逻辑。

### 消息段构造规则

#### 1. 简单消息直接传字符串

【应该】纯文本消息不需要构造消息段, 直接传字符串:

```ts
await sendReply( ctx, event, `请等待 ${ remaining } 秒后再试` );
```

要点:

- 这是默认写法。**只有出现下面第 2 条的理由时才升级为消息段。**

#### 2. 复杂消息用工厂函数构造

【必须】需要消息段 (@、回复、图片、表情等) 或多段组合时, 用 `createXxxMessage` 工厂构造后再发送:

```ts
const imageMessage = createImageMessage(imagePath);
await sendReply(ctx, event, imageMessage);
```

**推荐支持的消息段类型与工厂函数**:

| 消息段类型 | 工厂函数 |
| --- | --- |
| 纯文本 (text) | `createTextMessage(text)` |
| QQ 表情 (face) | `createFaceMessage(id)` |
| @ (at) | `createAtMessage(qq, name?)` (`qq` 取 `'all'` 即 @全体成员, 见下文第 3 条) |
| 回复 (reply) | `createReplyMessage(id)` |
| 图片 (image) | `createImageMessage(file)` |
| 商城表情 (mface) | `createMFaceMessage(emojiPackageId, emojiId, key, summary)` |
| 文件 (file) | `createFileMessage(file, name?)` |
| 合并转发节点 (node) | `createForwardNode(nickname, content, userId?)` |

【必须】范式覆盖的消息段范围即上表所列 8 种, 全部提供工厂函数。范围外的消息段类型 (markdown、record、video、location、json、music 等) 不属于本范式覆盖范围, 各项目如需支持应先扩展工厂函数再使用。

`ForwardNode` 参考定义:

```ts
export interface ForwardNode {
    type: 'node';
    data: {
        nickname: string;
        user_id?: string;
        content: OB11MessageMixType;
    };
}
```

工厂函数参考实现 (可直接复制到发送工具模块):

```ts
/** 创建文本消息段 */
export function createTextMessage(text: string): OB11MessageText {
    return { type: 'text', data: { text } };
}

/** 创建 QQ 表情消息段 */
export function createFaceMessage(id: string): OB11MessageFace {
    return { type: 'face', data: { id } };
}

/** 创建 @ 消息段 */
export function createAtMessage(qq: string, name?: string): OB11MessageAt {
    const data: OB11MessageAt['data'] = { qq };
    if (name) data.name = name;
    return { type: 'at', data };
}

/** 创建回复消息段 */
export function createReplyMessage(id: string): OB11MessageReply {
    return { type: 'reply', data: { id } };
}

/** 创建图片消息段 */
export function createImageMessage(file: string): OB11MessageImage {
    return { type: 'image', data: { file } };
}

/** 创建商城表情消息段 */
export function createMFaceMessage(
    emojiPackageId: number,
    emojiId: string,
    key: string,
    summary: string,
): OB11MessageMFace {
    return {
        type: 'mface',
        data: { emoji_package_id: emojiPackageId, emoji_id: emojiId, key, summary }
    };
}

/** 创建文件消息段 */
export function createFileMessage(file: string, name?: string): OB11MessageFile {
    const data: OB11MessageFile['data'] = { file };
    if (name) data.name = name;
    return { type: 'file', data };
}

/** 创建合并转发节点 */
export function createForwardNode(
    nickname: string,
    content: OB11MessageMixType,
    userId?: string,
): ForwardNode {
    const node: ForwardNode = { type: 'node', data: { nickname, content } };
    if (userId) node.data.user_id = userId;
    return node;
}
```

要点:

- 【应该】工厂函数返回的是**单个消息段**; 多段消息把它们放进数组:

```ts
await sendReply(ctx, event, [
    createReplyMessage(replyId),
    createAtMessage(qq),
    createTextMessage(' 已绑定'),
]);
```

- 【必须】混合字符串与消息段时, 统一升级为消息段数组 (字符串那一部分用 `createTextMessage`), 不要在一个数组里混放字符串与消息段对象。
- 【必须】范围内的 8 种消息段类型一律通过工厂函数构造; 确需使用范围外类型时才允许手写字面量, 且必须能通过 `OB11MessageData` 联合类型的类型检查。

#### 3. @全体成员: 构造无常、前置校验有三

@全体成员**不是独立的消息段类型**, 而是 `at` 段的特殊形态——`qq` 取固定值 `all`。因此它不需要新的工厂函数, 构造方式与普通 @ 完全一致:

```ts
const atAllMessage = [
    createAtMessage('all'),
    createTextMessage(' 今晚八点开播'),
];
```

它与普通 @ 的本质区别全在**平台侧的三重前置限制**: 任一不满足, 发送要么被平台拒绝、要么消息被静默丢弃 (客户端渲染为空)。因此本节的范式重心不是"怎么构造", 而是"发之前必须确认什么"。

| 前置检查 | 判定方式 |
| --- | --- |
| 群聊限定 | `event.message_type === 'group'` |
| 权限: 群管理员及以上 | `hasRole(getUserRole(event), 'admin')` (见 [permission-pattern](./permission-pattern.md)) |
| 配额: 当日剩余次数 > 0 且机器人有权限 | `get_group_at_all_remain` API |

【必须】三项检查**缺一不可且必须前置**, 不能靠"发出去再看结果"反推——平台对越权与超额的失败反馈并不一致, 事后无法可靠区分失败原因。

配额查询封装 (放在发送工具模块):

```ts
/** @全体成员 配额查询结果 (字段名沿用 OneBot 11 的 get_group_at_all_remain) */
interface AtAllRemain {
    /** 机器人账号在该群是否具备 @全体成员 权限 */
    can_at_all: boolean;
    /** 该群当日剩余 @全体成员 次数 */
    remain_at_all_count_for_group: number;
    /** 机器人账号当日剩余 @全体成员 次数 (跨群共享) */
    remain_at_all_count_for_uin: number;
}

/** 查询群内 @全体成员 剩余配额; 查询失败返回 null (按不可发送处理) */
async function getAtAllQuota(
    ctx: PluginContext,
    groupId: string | number,
): Promise<AtAllRemain | null> {
    try {
        return await ctx.actions.call(
            'get_group_at_all_remain',
            { group_id: groupId },
            ctx.adapterName,
            ctx.pluginManager.config,
        );
    } catch (error) {
        pluginState.logger.error('查询 @全体成员 配额失败', error);
        return null;
    }
}
```

要点:

- 【必须】配额查询失败返回 `null` 而非抛错 (与四个发送函数同约定), 调用方按"不可发送"处理。**查询失败时不要盲目尝试发送**——这正是前置检查要规避的场景。

自包含的发送函数:

```ts
/** 发送 @全体成员; 返回是否发出 */
async function sendAtAll(
    ctx: PluginContext,
    event: OB11Message,
    text: string,
): Promise<boolean> {
    // 1. 群聊限定: 非群聊没有"全体成员"这个概念
    if (event.message_type !== 'group') return false;

    // 2. 权限: 群管理员及以上 (角色推导见 permission-pattern)
    if (!hasRole(getUserRole(event), 'admin')) return false;

    // 3. 配额: 机器人有权限, 且群内当日还有剩余次数
    const quota = await getAtAllQuota(ctx, event.group_id);
    if (!quota || !quota.can_at_all || quota.remain_at_all_count_for_group <= 0) {
        await sendReply(ctx, event, '@全体成员 次数已用完, 请稍后再试');
        return false;
    }

    // 4. 构造并发送
    return sendReply(ctx, event, [
        createAtMessage('all'),
        createTextMessage(` ${ text }`),
    ]);
}
```

要点:

- 【必须】检查顺序固定为 **会话类型 → 权限 → 配额**。前两项是纯本地判定, 最先短路; 配额需要一次 API 往返, 放在最后, 避免为注定失败的调用付出网络开销。
- 【必须】失败反馈**不对称**: 权限不足静默返回 (防权限探测), 配额不足回复提示 (可用性信息, 不敏感)。理由见 [instruction-pattern](./instruction-pattern.md) 的"校验失败的反馈策略"。
- 【应该】**优先用声明式门槛**。若 @全体成员 由指令触发, 在指令定义上声明 `requiredRole: 'admin'` 与 `scope: 'group'`, 分发层即完成前两项检查, handler 内不必重复。上面的自包含写法适用于**无 event 的主动推送**路径, 或该发送函数被多个调用点共用、需要自带防线的场合。
- 【应该】`createAtMessage('all')` 后**紧跟一个文本段**。纯 @全体成员 无正文的消息在多数客户端渲染为空白, 用户看不出意图。
- 【必须】`createAtMessage('all')` **不传** `name` 参数 (该参数用于显示群昵称, 对 `all` 无意义)。
- 【必须】@全体成员 的消息**只走 `sendReply` / `sendGroupMessage` 等发送工具**, 不因其特殊而直接调用 `ctx.actions.call`。

### 反例: 发送走工具、构造却手写字面量

一种常见的错误写法:

```ts
await sendGroupMessage( pluginState.ctx, groupId, [
    { type: 'text', data: { text: message + '\n' } },
    { type: 'image', data: { file: `base64://${ svgBase64 }` } },
] );
```

它的问题:

1. **发送入口正确, 构造方式违规**。绕过工厂直接拼消息段字面量, 类型约束只剩联合类型的兜底, 字段名拼错 (如 `text` 写成 `txt`) 只能靠运行时发现。
2. **两个类型明明都有工厂** (`createTextMessage` / `createImageMessage`), 却各自手写了一份结构, 与同类型消息在其它调用点的构造方式不一致。

该写法应改为:

```ts
await sendGroupMessage( pluginState.ctx, groupId, [
    createTextMessage(message + '\n'),
    createImageMessage(`base64://${ svgBase64 }`),
] );
```

### 错误处理约定 (应该, 非铁律)

【应该】发送函数失败时**不会抛出** (内部已 try/catch、记日志、返回 `false`), 因此调用方是否检查返回值是弹性的:

- **推荐检查**的场景: 指令响应、用户可见的失败提示等关键路径——发送失败后往往需要后续逻辑 (如提示用户重试)。
- **可忽略返回值**的场景: 日志性质的通知、状态推送——失败已被工具函数记录日志, 静默即可。

【应该】无需在调用点重复 try/catch 或重复记日志; 工具函数已统一处理。

## 标准范式清单

发送一条消息时按以下步骤:

- [ ] 【必须】有 `event` → `sendReply(ctx, event, message)`; 无 `event` 按目标选 `sendGroupMessage` / `sendPrivateMessage`; 合并转发用 `sendForwardMsg`。
- [ ] 【应该】纯文本消息直接传字符串, 不构造消息段。
- [ ] 【必须】需要 @ / 回复 / 图片 / 表情 / 文件或多段组合 → 用 `createXxxMessage` 工厂构造成消息段数组再发送。
- [ ] 【必须】禁止在业务代码中直接调用 `ctx.actions.call('send_msg' | ...)`。
- [ ] 【必须】范围内消息段一律用工厂构造; 范围外类型允许手写字面量, 且必须通过 `OB11MessageData` 类型检查。
- [ ] 【必须】发送 @全体成员 前完成三项前置检查 (群聊限定 / 群管理员及以上 / 当日配额), 顺序为 会话类型 → 权限 → 配额。
- [ ] 【应该】不重复 try/catch 发送逻辑; 关键路径按需检查返回的 `boolean`, 通知类可忽略。

## 与其他范式的关系

- 与**生命周期铁律**的关系: 发送工具函数内部依赖全局状态的 logger 等, 只在 `plugin_init` 之后的运行期被调用; **不要在模块加载期调用任何发送函数**。前提约束见 [development-pattern](./development-pattern.md) 与 [store-pattern](./store-pattern.md)。
- 与**指令分发范式**的关系: handler 回复用户用 `sendReply`; 主动推送 (无 event) 按目标类型选 `sendGroupMessage` / `sendPrivateMessage`。见 [instruction-pattern](./instruction-pattern.md)。
- 与**权限范式**的关系: @全体成员 等"仅管理员可用"的发送能力, 需先用 `getUserRole` 推导档位、`hasRole` 判定是否达标。指令触发时优先由分发层的 `requiredRole` 声明完成, 无 event 的推送路径才自行判定。见 [permission-pattern](./permission-pattern.md)。

## 参考实现

napcat-plugin-bilibili-monitor 项目: 发送工具模块见 `packages/plugin/src/handlers/utils.ts`。
