# NapCat 插件指令帮助输出范式

本文是 NapCat 插件指令帮助输出的通用范式, 覆盖从指令定义到用户可见帮助消息的全链路: 配置权威源编写、生成、产物落盘、运行时变体选择与回退。强度档位 (必须/应该/可以) 见 [development-pattern.md](./development-pattern.md) 的"规范强度分级"。

## 核心约束

1. 【必须】**按角色与会话类型输出对应版本**: 帮助内容分 User / Admin / SuperAdmin 三个权限组, 由消息来源的角色与会话类型共同决定输出版本 (见"变体映射"节), 而非仅按角色。
2. 【必须】**图片优先 / 文本回退**: 优先发送帮助图片, 图片文件缺失或发送失败时回退发送纯文本帮助。
3. 【必须】**配置单源**: 帮助内容有唯一权威源 (开发者维护的配置文件); 生成产物 (文本映射与图片) 一律由生成脚本产出, 禁止手改。

## 范式正文

### 全链路流水线

```
帮助配置权威源 (开发者维护, 每个帮助面板一个文件)
    → 生成步骤 (一条 npm script, 可调外部渲染服务)
    → 落盘: 图片产物 (assets) + 文本帮助映射 (generated 文件)
    → handler import 生成文件
    → 运行时: 发送工具按变体发送图片, 失败回退文本
```

范式不绑定具体的渲染实现 (本地 canvas、外部渲染服务、纯 HTML 截图皆可), 只约束**链路的职责切分与单向依赖**: 权威源是唯一可手改的地方, 产物只读, 运行时只做变体选择与回退。

### 一、配置权威源

帮助配置以 TS 模块编写, 每个帮助面板一个文件, 类型定义集中在同目录:

```typescript
interface Cmd {
    id: string;     // 脚注, 同时用作导出文件名
    title: string;  // 面板标题
    cmd: (InstructionSet | ContentHelp)[];
}

interface InstructionSet {
    groupName: string;           // 指令集名称
    instructions: Instruction[];
    isAdmin?: boolean;           // 仅群管理员可用 (超管也可用)
    isSuperAdmin?: boolean;      // 仅超管可用
}

interface Instruction {
    cmd: string;              // 指令
    desc: string;             // 指令描述
    onlyPrivate?: boolean;    // 仅私聊可用
    onlyGroup?: boolean;      // 仅群聊可用
}
```

#### 标记系统与互斥规则

- 【必须】`isAdmin` 与 `isSuperAdmin` **互斥**, 一个指令集只能存在其一; 均缺省表示所有用户可见。
- 【必须】`onlyPrivate` 与 `onlyGroup` **互斥**; 均缺省表示私聊与群聊均可用。
- 【应该】渲染/生成端依据标记自动添加 `[管理员]` / `[超管]` / `[仅私聊]` / `[仅群聊]` 标识, 无需在描述文本中手写。
- 【必须】权限过滤规则: User 可见无标记内容; Admin 可见无标记 + `isAdmin` 内容; SuperAdmin 可见全部。

#### 分组命名约定

【应该】指令集按职责分组, 参考命名:

- `核心指令` — 面向普通用户的主功能
- `辅助指令` — help、查询类等辅助功能
- `监听管理指令` — 管理类指令, 按权限拆成 `isAdmin` 与 `isSuperAdmin` 两个同名指令集

同一 `groupName` 可以出现多次 (搭配不同权限标记), 渲染时按权限组各自过滤。

#### SuperAdmin 版的内容取舍

【必须】SuperAdmin 版可以包含**仅私聊可用**的指令 (`onlyPrivate`)。这直接影响下游变体映射的合理性: 群聊中不输出 SuperAdmin 版, 正是因为其含有的仅私聊指令在群聊中不可用 (见"变体映射"节)。编写配置时保持这一内容构成约定。

### 二、生成步骤

生成脚本由一条 npm script 触发, 职责:

1. 【应该】读取渲染服务的连接参数 (端口等, 缺省值写在脚本内)。
2. 【应该】服务未运行时自动拉起, 轮询就绪 (设超时; 首次运行的外部依赖如浏览器内核安装, 在脚本 README 中说明)。
3. 【必须】对每个注册的帮助面板: 提交完整 cmd 配置, 分别生成文本与图片。
4. 【必须】落盘 (见下节)。

若采用外部渲染服务, 服务端环境项 (端口、截图缩放、图片格式) 由服务端自行管理, 生成脚本不干预。

### 三、产物与落盘

| 产物 | 落盘位置 | 说明 |
|---|---|---|
| 帮助图片 PNG | `src/assets/{cmdId}-{Role}.png` | 按权限组三张, 覆盖写入 |
| 文本帮助 | `src/handlers/<模块>/helpText.generated.ts` | 导出 `HELP_TEXT_MAP: Record<HelpVariant, string>`, 键为 `user` / `admin` / `superAdmin` |

【必须】**同步纪律**: 生成文件头部标注"由 xx 脚本生成, 禁止手改"。任何帮助内容变更都只修改权威源, 再重新生成。handler 以 `HELP_IMAGE` 常量声明各变体对应的 PNG 文件名 (纯命名映射, 无内容), 并 `import { HELP_TEXT_MAP } from './helpText.generated'`。

【应该】运行时发送逻辑由共享工具 `sendHelpMessage` 承担, handler 只需提供 `imageMap` 与 `textMap` 两份内容, 不自行实现选择与回退逻辑。

### 四、变体映射

【必须】帮助版本由"角色 + 会话类型"共同决定, 定义于 `getHelpVariant`:

| 角色 | 会话类型 | 输出版本 |
|---|---|---|
| `user` | 任意 | User |
| `admin` (群管理员) | 任意 | Admin |
| `privateUser` (好友私聊用户) | 好友私聊 | Admin |
| `superAdmin` | 群聊 | Admin |
| `superAdmin` | 私聊 | SuperAdmin |

映射依据 (角色定义见 [permission-pattern](./permission-pattern.md) 的四档角色模型):

- `privateUser` (机器人好友的私聊用户) 等同 admin 权限组, 故输出 Admin 版; 非好友私聊角色为 user, 输出 User 版。
- **群聊超管输出 Admin 版而非 SuperAdmin 版**: SuperAdmin 版含有仅私聊可用的指令, 在群聊中输出会误导用户。私聊超管才能看到完整版。

【必须】`HelpVariant` 类型 (`'user' | 'admin' | 'superAdmin'`) 与 PNG 文件名中的权限组、`HELP_TEXT_MAP` 的键一一对应 (大小写拼写差异由脚本映射)。

## 标准范式清单

新增一个帮助面板时:

- [ ] 【必须】在权威源目录新建 cmd 配置文件 (遵循标记互斥与分组命名约定)。
- [ ] 【必须】在生成脚本的映射表注册 (cmd 配置 + 落盘 handler 目录)。
- [ ] 【必须】执行生成脚本, 产物自动落盘 assets 与 handler 目录。
- [ ] 【必须】新建 handler 文件, `HELP_IMAGE` 填入三个 PNG 文件名, `import { HELP_TEXT_MAP } from './helpText.generated'`。
- [ ] 【必须】handler 导出形如 `helpXxxHandler` 的函数, 调用 `sendHelpMessage(ctx, event, { imageMap, textMap })`。
- [ ] 【必须】在指令解析层注册对应 help 指令。

## 与其他范式的关系

- 与**指令分发范式**的关系: 帮助 handler 是普通指令 handler, 在注册表中注册, 并复用分发层推导好的 `UserRole`。见 [instruction-pattern](./instruction-pattern.md)。
- 与**权限范式**的关系: 变体映射的输入 `UserRole` 来自权限模块的入口推导; 权限档位与帮助版本档位不是一一对应关系。见 [permission-pattern](./permission-pattern.md)。
- 与**消息发送范式**的关系: `sendHelpMessage` 内部走发送工具模块发送图片/文本, 失败即触发文本回退。见 [message-send-pattern](./message-send-pattern.md)。

## 参考实现

napcat-plugin-bilibili-monitor 项目: 权威源与生成脚本位于插件项目 `scripts/generateHelp/` (cmd 配置、生成入口与 `CMD_TARGETS` 映射表), 运行时工具见 `src/utils/helpMessage.ts` 的 `sendHelpMessage` 与各模块 `help.handler.ts`; 图片渲染由独立项目 `napcat-help-generate` 提供 (TS + express + Playwright, 无状态渲染), 其 API 详见该项目 README 与 CLAUDE.md。
