# 0004 - 分发层做成纯函数，并为其引入 validateArgs 钩子

## 背景与问题

[指令分发范式](../instruction-pattern.md) 的核心约束 2 要求"**校验在分发层统一完成**", handler 内不重复校验。范式的 `InstructionDefinition` 只声明 `requiredRole` / `scope` / `scopeRules` 三个门槛, 这几项都能纯靠"角色 + 会话类型 + 参数个数"判定。

本插件有一条范式覆盖不到的校验: **参数取值取决于运行期配置**。设计文档 §11.2 举的「非法参数」样例是 `game add 原神`——`原神` 不是 `catalogs` 里配置的游戏名, 所以非法。这个判断需要读 `pluginState.config.catalogs`, 表达不进 `requiredRole` / `scope`; 范式也没有 `scopeRules` 那样的取值白名单形态 (`scopeRules` 只按 `args` **个数**分形态)。

于是核心约束 2 在这类校验上出现了缺口: 要么破例让 handler 自己校验并回报失败, 要么扩展声明式模型。同时, 范式的参考实现里分发层是**直接调 `sendReply` 发消息**的——这让分发逻辑与 `ctx` 绑死, 四类失败分支只能靠造 ctx 桩来测。

## Considered Options

**handler 返回失败回执（已否决）**。`handler` 签名改成可返回 `{ invalidArg }`, 接收层拿到后走同一套渲染。不必新增声明字段, 但校验重新散回 handler——正是核心约束 2 要消灭的形态, 而且每个新增指令都要记得"取值不对时 return 而不是 send", 漏一个就是静默的成功假象。

**把取值也塞进 `scopeRules`（已否决）**。`scopeRules` 的匹配维度是 `args` 个数, 用它表达"合法取值集合"要么给每个合法游戏名写一条规则(配置一变就得改代码), 要么扩它的语义, 把"按个数分形态"和"按取值白名单"两种正交的规则挤进同一个结构。

**分发层直接发送, 文案留在 `utils/text.ts`（已否决）**。按设计文档 §6 的分层草图, "失败文案拼装"归 `utils`。但 [ADR-0002](./0002-explicit-failure-feedback-over-silence.md) 已把失败反馈定为**分发层的策略**, 而 `utils` 是比 `handlers` 更底层的一层——让 `utils` 反过来 import `handlers` 的 `DispatchOutcome` 类型是分层倒置。

**纯函数分发 + `validateArgs` 钩子（已采纳）**。

## 结论

**分发层是纯函数**。`resolveInstruction(userRole, args, registry)` 只回答"这条消息该执行什么 / 该回该回什么失败", 返回判别联合:

```ts
type DispatchOutcome =
    | { kind: 'execute'; definition: InstructionDefinition; args: string[] }
    | { kind: 'invalid-args'; arg: string }
    | { kind: 'unknown-command'; raw: string }
    | { kind: 'permission-denied'; raw: string }
    | { kind: 'scope-mismatch'; required: 'group' | 'private' };
```

它不发送消息、不碰全局状态; 发送与日志留在接收层 (`handlers/message-handler.ts`), 由它拿结果决定回复什么。失败文案的渲染 `renderFailure` 因此与 `resolveInstruction` **同处 `handlers/instruction.ts`**, 不放进 `utils/text.ts`。

**`InstructionDefinition` 增加一个可选钩子**:

```ts
validateArgs?: (args: string[]) => string | null;
```

返回**出错的参数**(供文案渲染)表示不合法, `null` 表示通过。分发层在调用 handler 前执行它。

**校验顺序固定为 作用域 → 权限 → 参数取值**, 不可调换。权限先于取值是有意的: 反过来会把"合法取值有哪些"泄露给一个本来就无权执行的人——没权限的用户发 `game add 原神`, 应当看到"权限不足"而不是"非法参数 原神"(后者等于告诉他 `原神` 这个位置该填别的)。这条顺序有单测守着。

要点:

- **注册表按参数注入**, 便于测试与将来的多面板场景; `resolveInstruction` 的 `registry` 是必填参数, 接收层传真实注册表, 单测传注入的。
- **四类失败各有独立的 `kind`**, 不合并成布尔或错误码——[ADR-0002](./0002-explicit-failure-feedback-over-silence.md) 要求文案如实区分, 判别联合让"某一类忘了处理"在编译期暴露。
- `validateArgs` 只在**声明式门槛都通过之后**才跑, 它不承担权限语义。

## 该决策约束的范式文档

- [instruction-pattern.md](../instruction-pattern.md)——其 `InstructionDefinition` 只有 `requiredRole` / `scope` / `scopeRules`, 本 ADR 为"合法取值取决于运行期配置"的校验补了第四个字段; 其"校验失败反馈不对称"策略已被 [ADR-0002](./0002-explicit-failure-feedback-over-silence.md) 覆盖, 本文不重复。判别联合的返回形态与范式的"分发层直接发送"参考实现不同, 属本项目的实现选择。
- [development-pattern.md](../development-pattern.md)——其分层架构的"纯函数优先"一条在此从"解析、清洗、模板渲染"扩到了**分发判定**; `renderFailure` 未按设计文档 §6 的分层草图放进 `utils/text.ts`, 理由见上。
