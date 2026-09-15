# CONTEXT — 领域术语表

本文件是领域术语的唯一权威。新术语在概念定型时即写入此处, 与代码冲突时先校对再改。范式体系的引用见 [docs/development-pattern.md](docs/development-pattern.md) 的"领域建模纪律"。

## 术语

### 全局状态单例 (pluginState)

进程内唯一的全局状态对象, 持有 ctx (nullable)、config、data 目录 JSON 读写、logger 与定时器注册表。构造期零 IO, 真正的初始化发生在 `plugin_init(ctx)` 调用其 `init(ctx)` 时。
_Avoid_: "全局变量""context 单例"——它不是裸全局变量, 也不是 ctx 本身。

### 延迟实例化 (lazy instantiation)

store 单例不在模块加载期创建, 而是推迟到业务代码首次调用 `getInstance()` 时。目的: 保证任何文件 IO 都发生在 `plugin_init` 之后。
_Avoid_: "导出即初始化""饿汉单例"——在本框架下属于反模式。

### 指令定义 (InstructionDefinition)

注册表中的一条指令声明: handler + 可选的 `requiredRole` / `scope` / `scopeRules`。分发层在调用 handler 前完成全部校验。
_Avoid_: "命令对象"——不是命令模式, 只是声明式配置。

### 角色推导 (role derivation)

在消息入口处由消息事件一次性推导出发送者角色 (superAdmin / privateUser / admin / user), 而非为每个用户配置权限。"好友私聊即提权"是领域决策: 与机器人互为好友的用户视为可信。
_Avoid_: "权限配置""用户等级"——角色不是配置项, 也没有等级成长概念。

### 会话级开关 (group enabled switch)

群配置中的启用开关, 判定式 `enabled !== false` (宽松判定, 缺失即启用)。默认开启是领域决策, 原因: 插件以零配置可用为目标。
_Avoid_: "默认关闭、手动开启"的表述——与本项目的默认值语义相反。

### 帮助变体 (help variant)

帮助输出的版本档位 (`user` / `admin` / `superAdmin`), 由"角色 + 会话类型"共同决定, 与权限档位不是一一对应 (群聊超管输出 Admin 版)。
_Avoid_: 把"权限档位"直接当"帮助版本"用——两者计数相同但映射不同。

## 默认值语义声明

- 会话级启用开关: **默认开启** (`enabled !== false`)。
- 指令前缀: 缺省 `#cmd`, 可经配置覆盖。

新增有默认值语义的配置项时, 在此处声明选择及理由; 难逆转的补 ADR (判据见 [docs/development-pattern.md](docs/development-pattern.md) 的"ADR 纪律")。
