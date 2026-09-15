# 文档索引

NapCat 插件开发模板的文档导航。范式体系的定位、强度分级与生命周期铁律见总纲 [development-pattern.md](./development-pattern.md)。

## 范式文档

| 文档 | 覆盖范围 |
| --- | --- |
| [development-pattern.md](./development-pattern.md) | **总纲**: 强度分级、文档骨架、生命周期铁律、分层架构、领域建模与 ADR 纪律 |
| [store-pattern.md](./store-pattern.md) | 数据持久化: 单例 store、延迟实例化、模块加载期禁 IO |
| [config-pattern.md](./config-pattern.md) | 配置全链路: 类型/默认值/Schema/清洗四环节、会话级开关 |
| [permission-pattern.md](./permission-pattern.md) | 权限: 四档角色模型、入口推导、线性比较、超管名单、按形态裁剪 |
| [instruction-pattern.md](./instruction-pattern.md) | 指令分发: 接收→分发→执行链路、作用域校验、失败反馈策略 |
| [message-send-pattern.md](./message-send-pattern.md) | 消息发送: 发送工具收敛、消息段工厂 |
| [help-output-pattern.md](./help-output-pattern.md) | 帮助输出: 权威源 → 生成 → 产物 → 运行时变体选择 |

## 项目级文档

| 文档 | 覆盖范围 |
| --- | --- |
| `CONTEXT.md` (根目录) | 领域术语表 (含 _Avoid_ 反用词) 与默认值语义声明 |
| `CLAUDE.md` (根目录) | 插件项目结构、构建运行方式、本项目实例化说明 |
| `.example/` | NapCat 官方插件开发文档 (api/、mechanism.md、structure.md 等), 外部参考资料 |

## 新插件项目阅读顺序

1. **总纲** [development-pattern.md](./development-pattern.md) — 先建立强度分级与生命周期铁律的全局认知。
2. **[store-pattern.md](./store-pattern.md)** — 全局状态单例是其余一切范式的前提, 先读它。
3. **[permission-pattern.md](./permission-pattern.md)** — 角色推导与线性比较; 它是指令门槛声明 (`requiredRole`) 的取值来源, 先读它再看指令范式更顺。
4. **[config-pattern.md](./config-pattern.md)** 与 **[instruction-pattern.md](./instruction-pattern.md)** — 两大高频链路: 配置与指令。
5. **[message-send-pattern.md](./message-send-pattern.md)** 与 **[help-output-pattern.md](./help-output-pattern.md)** — 横切能力, 写 handler 时随用随查。

同时将本模板的 `CONTEXT.md` 与 `CLAUDE.md` 作为骨架复制到新项目, 再按新项目领域填充术语与实例。
