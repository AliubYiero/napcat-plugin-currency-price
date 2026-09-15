# NapCat 插件指令分发范式

本文是适用于任意 NapCat 插件项目的指令分发通用范式, 覆盖从消息接收到指令执行的完整链路: 前缀检查、参数切词、注册表分发、作用域校验。各项目遵循此范式时, 应将消息接收入口与指令注册表分别放在独立的 handler 模块中。强度档位 (必须/应该/可以) 见 [development-pattern.md](./development-pattern.md) 的"规范强度分级"。

角色的推导与比较不在本文范围, 已抽离为 [permission-pattern](./permission-pattern.md); 发送消息的工具函数规范见 [message-send-pattern](./message-send-pattern.md)。分发层只负责**何时校验、如何反馈**, 不重复实现角色判定。

## 核心约束

1. 【必须】**四层链路, 各层只做自己的事**: 接收层不认识指令语义, 分发层不做业务, 执行层不再做权限校验。业务 handler 收到的参数已保证满足角色与作用域要求, 可直接执行。
2. 【必须】**校验在分发层统一完成**: 角色的推导与比较能力由权限模块提供 (见 [permission-pattern](./permission-pattern.md)), 但**校验时机与失败反馈收敛在分发层**。权限检查散落在接收层或 handler 内会随指令增多而失控。
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

要点:

- 【必须】`requiredRole` 的取值即权限模块的 `UserRole['role']`; 判定用 `hasRole(userRole, requiredRole)` 的线性比较, 不写档位矩阵。角色的推导与比较见 [permission-pattern](./permission-pattern.md)。
- 【必须】分发层从消息事件推导角色的动作**只发生一次** (入口处), 之后 `UserRole` 对象在分发层与 handler 间传递; 不要在每个校验点重复调用 `getUserRole`。

### 三、作用域校验: scope 与 scopeRules

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

### 四、校验失败的反馈策略

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
- [ ] 【应该】需要调整角色档位或推导规则时改权限模块, 不改分发层 (见 [permission-pattern](./permission-pattern.md))。
- [ ] 【必须】回复一律走发送工具模块, 不直接调 `ctx.actions.call`。

## 与其他范式的关系

- 与**生命周期铁律**的关系: 注册表与 handler 均为纯装配 (构造期零 IO), 可模块加载期导出; 消息事件只在运行期到达。见 [development-pattern](./development-pattern.md)。
- 与**权限范式**的关系: 分发层消费 `hasRole(UserRole, requiredRole)` 的判定结果, 但不实现角色推导——推导与比较属于权限模块。见 [permission-pattern](./permission-pattern.md)。
- 与**配置范式**的关系: 前缀与群启用开关读自配置, 经 `sanitizeConfig` 清洗后使用; 会话开关在接收层最前端短路。见 [config-pattern](./config-pattern.md)。
- 与**消息发送范式**的关系: 所有回复走发送工具模块。见 [message-send-pattern](./message-send-pattern.md)。
- 与**帮助输出范式**的关系: 帮助指令按"角色 + 会话类型"选输出版本 (而非仅按角色), 版本档位与权限档位不是一一对应。见 [help-output-pattern](./help-output-pattern.md)。

## 参考实现

napcat-plugin-bilibili-monitor 项目: 消息接收入口见 `packages/plugin/src/handlers/message-handler.ts`, 指令注册表与分发见同目录指令模块; 示例业务 handler 为 live 模块的 `addLiveHandler` / `mentionLiveHandler` / `maxLiveHandler`。权限模块的实例索引见 [permission-pattern](./permission-pattern.md)。
