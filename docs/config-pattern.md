# NapCat 插件配置范式

本文是 NapCat 插件配置层的通用范式, 覆盖配置从声明到生效的全链路: 类型定义、默认值与 Schema、清洗、运行时读写。遵循此范式时, 四环节分散在四个位置 (本文以类型文件、配置文件、全局状态文件称之)。强度档位 (必须/应该/可以) 见 [development-pattern.md](./development-pattern.md) 的"规范强度分级"。

## 全链路总览

一个配置项从声明到生效经过四个环节, 缺一不可:

```
(a) 类型定义          类型文件          PluginConfig / GroupConfig
(b) 默认值 + Schema   配置文件          DEFAULT_CONFIG / buildConfigSchema
(c) 清洗              全局状态文件      sanitizeConfig
(d) 运行时读写        全局状态文件      loadConfig / saveConfig / updateConfig
```

四处分散是插件框架的结构所致 (Schema 构建器需要 ctx、清洗需要独立纯函数、类型需要独立于运行时), 属于可接受的设计。范式不试图消除它, 而是用 checklist 保证四处同步。

## 核心约束: 四处同步 + 写入铁律

1. 【必须】新增或修改一个配置项时, 必须同步四处: 类型 (`PluginConfig` 或会话级 `GroupConfig` 加字段及注释)、默认值 (`DEFAULT_CONFIG`)、WebUI Schema (`buildConfigSchema` 加控件)、清洗 (`sanitizeConfig` 加分支)。
2. 【必须】**一切外部输入的配置写回必须经过 `sanitizeConfig`**。外部输入包括磁盘配置文件、WebUI 提交、指令修改。直接把外部对象合并进内存配置等于放弃类型安全。范式:
   - `loadConfig`: 读盘后经 `sanitizeConfig`; 文件不存在则写入默认配置落盘; 解析失败回退默认配置并记日志, 不抛错。
   - `replaceConfig(config)`: 入口统一 `sanitizeConfig(config)` 后再保存。
   - `updateConfig(partial)`: 仅限内部可信调用方使用 (字段已被上游清洗或来自 `DEFAULT_CONFIG`); 若来源不可信, 先清洗。

## 范式正文

### 清洗规则分类表

【必须】`sanitizeConfig` 是纯函数: 输入 `unknown`, 输出保证符合 `PluginConfig`。按字段形态分五类, 每类一个正例:

| 形态         | 规则                                                     |
| ------------ | -------------------------------------------------------- |
| 标量         | `typeof` 守卫; 不合法则保留默认值, 不报错                 |
| 数值         | `typeof` + 业务区间校验 (如 `> 0`); 不合法回退默认值      |
| 字符串列表   | 容错输入格式, 统一转为规范形态后去空项                    |
| 枚举数组     | 过滤非法值; **空数组是合法语义**, 不回退默认值            |
| 嵌套对象     | 逐字段递归使用上述规则; 整体不合法则丢弃该条目            |

正例:

```ts
// 标量: typeof 守卫, 不合法保留默认
if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
if (typeof raw.commandPrefix === 'string')
    out.commandPrefix = raw.commandPrefix;

// 数值: typeof + 区间校验
if (
    typeof raw.pollIntervalSeconds === 'number' &&
    raw.pollIntervalSeconds > 0
) {
    out.pollIntervalSeconds = raw.pollIntervalSeconds;
}

// 枚举数组: 过滤非法值; 空数组表示"不推送任何类型",
// 是用户的合法选择, 不回退默认
if (Array.isArray(raw.pushTypes)) {
    const validPushTypes = new Set<string>(VALID_PUSH_TYPES);
    const filtered = raw.pushTypes.filter(
        (t) => typeof t === 'string' && validPushTypes.has(t),
    );
    out.pushTypes = filtered as PluginConfig['pushTypes'];
}
```

字符串列表 (以"逗号分隔的管理员名单"为例):

```ts
if (typeof rawAdminUsers === 'string') {
    out.adminUsers = rawAdminUsers
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
} else if (Array.isArray(rawAdminUsers)) {
    out.adminUsers = rawAdminUsers
        .map(String)
        .filter((id) => id.length > 0);
}
```

嵌套对象 (会话级配置, 见下节):

```ts
if (isObject(raw.groupConfigs)) {
    for (const [groupId, groupConfig] of Object.entries(raw.groupConfigs)) {
        if (isObject(groupConfig)) {
            const cfg: GroupConfig = {};
            if (typeof groupConfig.enabled === 'boolean')
                cfg.enabled = groupConfig.enabled;
            out.groupConfigs[groupId] = cfg;
        }
    }
}
```

两条通用原则:

- 【必须】**清洗不抛错**。任何非法输入都回退默认值或丢弃条目, 保证插件在损坏的配置文件下仍能启动。
- 【必须】**尊重用户显式选择**。空数组、显式 `false` 等是语义, 不是缺失; 只有"字段不存在或类型不对" 才回退默认。

### WebUI Schema

Schema 由 `buildConfigSchema(ctx, ...)` 在运行时构建 (构建器方法挂在 `ctx.NapCatConfig` 上), 静态配置项遵循:

- 【必须】控件类型与字段类型一一对应: boolean → 开关, text → 文本, number → 数字, select/multiSelect → 单选/多选。文本控件收集到的是字符串, 若逻辑字段是列表 (如管理员名单), 由清洗层负责转换, Schema 描述里写清输入格式。
- 【应该】多选的候选值列表应有单一来源 (如 `VALID_PUSH_TYPES` 常量), 默认值与 Schema options 都从它派生, 避免两处硬编码。
- 【必须】每个控件写 `description` 说明业务含义与生效时机 (如 "修改后下一轮生效")。

#### Schema 的静态/动态边界

Schema 中允许出现运行时数据, 但【必须】只允许进入 **展示块** (`html` / `plainText`), 不得进入可保存配置项。通用规则:

1. Schema 构建函数接受可选的运行时快照参数 (如 `buildConfigSchema(ctx, loginStatus)`), 快照为空时跳过对应展示块。
2. 运行时状态 (登录信息、统计等) 只渲染为 HTML 展示块, 不参与配置保存。
3. 外部状态变化后需要刷新展示块时, 通过状态回调重建整个 Schema。

⚠️ 【必须】Schema 构建函数需要运行时数据时, **必须参数注入, 禁止配置模块静态 import 业务模块**——否则形成循环引用, 默认配置对象在模块加载期即触发 TDZ 错误。

### 会话级配置与启用开关

会话级配置 (群配置) 是 `Record<会话ID, GroupConfig>` 形态的嵌套配置项, 清洗时逐字段走标量规则。启用开关遵循三条规则:

1. 【必须】**单一查询入口**。提供 `pluginState.isGroupEnabled(groupId)` 之类的唯一判定函数, 业务代码不得散落读取 `groupConfigs[id].enabled`。
2. 【必须】**宽松判定**。判定式为 `enabled !== false`——缺失字段视为启用, 零配置可用。插件必须显式声明自己选择"默认开启"还是"默认关闭" (领域决策, 记入 `CONTEXT.md`, 必要时补 ADR)。
3. 【必须】**入口短路**。消息处理在最前端做开关检查, 禁用的会话直接忽略消息, 不进入指令解析。

开关的修改入口 (指令 / WebUI) 由插件自选, 范式不强制。

## 标准范式清单

新增一个配置项时:

- [ ] 【必须】类型文件: `PluginConfig` (或 `GroupConfig`) 加字段 + 注释
- [ ] 【必须】配置文件: `DEFAULT_CONFIG` 加默认值
- [ ] 【必须】配置文件: `buildConfigSchema` 加控件 (描述写清格式与生效时机)
- [ ] 【必须】全局状态文件: `sanitizeConfig` 按形态分类加清洗分支
- [ ] 【应该】若是枚举: 候选值抽常量, Schema 与清洗共用
- [ ] 【必须】若是会话级字段: 确认 `isGroupEnabled` 式单一入口仍覆盖
- [ ] 【应该】若语义有默认值选择 (尤其是启用开关): 在 `CONTEXT.md` 中声明, 必要时补 ADR

## 与其他范式的关系

- 与**生命周期铁律**的关系: 配置读盘发生在 `plugin_init` 之后, 清洗是纯函数可在任何时机调用; Schema 构建需要 ctx, 只能在运行期进行。见 [development-pattern](./development-pattern.md)。
- 与**指令分发范式**的关系: 接收层读取前缀与群启用状态都来自配置, 运行期生效; 会话开关在消息入口最前端短路。见 [instruction-pattern](./instruction-pattern.md)。
- 与**领域建模纪律**的关系: 启用开关等默认值语义是领域决策, 定型时记入 `CONTEXT.md` 并按需补 ADR。见 [development-pattern](./development-pattern.md) 的"领域建模纪律"与"ADR 纪律"。

## 参考实现

napcat-plugin-bilibili-monitor 项目: 类型见 `packages/plugin/src/types.ts`, 默认值与 Schema 见 `packages/plugin/src/config.ts`, 清洗与运行时读写见 `packages/plugin/src/core/state.ts` 的 `sanitizeConfig` / `loadConfig` 等。
