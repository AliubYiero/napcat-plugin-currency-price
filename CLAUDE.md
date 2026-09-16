# CLAUDE.md — NapCat 插件开发模板

NapCat 插件开发模板 (pnpm monorepo), 基于实际生产项目架构提炼。开发范式体系见 [docs/index.md](docs/index.md); 领域术语见 [CONTEXT.md](CONTEXT.md)。写代码/起名前先读这两处。

## 仓库结构

- `packages/plugin` — 插件后端发布物: 生命周期入口 `index.ts`、配置 `config.ts`、类型 `types.ts`、全局状态单例 `core/state.ts`、消息处理 handler、WebUI API 路由 `services/api-service.ts`。
- `packages/webui` — React SPA 前端 (vite + tailwind), 独立构建。
- `packages/shared` — 跨包共享类型 (plugin 的 types.ts 从此处重导出)。
- `docs/` — 开发范式文档体系, 入口 [docs/index.md](docs/index.md)。
- `.example/` — NapCat 官方插件开发文档 (外部参考资料)。

## 构建与验证

- `pnpm build` (根) — 构建 plugin 与 webui (vite, 含资源复制)。
- 验证以 **vite build** 为准; `typecheck` 可能报 napcat-types 包自身的语法错误, 与本项目代码无关。

## 本项目实例化

本仓库是通用模板; 范式文档正文零项目引用, 项目实例仅出现在各范式文档末尾"参考实现"一节:

- [store-pattern](docs/store-pattern.md) → `packages/plugin/src/store/`、`core/state.ts`
- [config-pattern](docs/config-pattern.md) → `types.ts`、`config.ts`、`core/state.ts`
- [permission-pattern](docs/permission-pattern.md) → `core/admin.ts`、`adminUsers` 配置链 (类型/默认值/清洗)
- [instruction-pattern](docs/instruction-pattern.md) → `handlers/message-handler.ts`、指令注册表
- [message-send-pattern](docs/message-send-pattern.md) → `handlers/utils.ts`
- [help-output-pattern](docs/help-output-pattern.md) → `scripts/generateHelp/`、`utils/helpMessage.ts`; 渲染服务在独立项目 `napcat-help-generate`

以本模板开新项目时: 复制 `CONTEXT.md` 与本文件的骨架, 按新项目领域填充术语与实例索引; 范式文档保持通用, 不写回项目细节。

## Agent skills

### Issue tracker

Issue 以本地 Markdown 落在 `.scratch/<feature-slug>/` (无 git remote, 也无 `gh` / `glab`)。见 `docs/agents/issue-tracker.md`。

### Triage labels

默认五档: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`, 写进 issue 头部的 `Status:` 行。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文: 根目录 `CONTEXT.md` + `docs/adr/`; 另有 `docs/design.md` 作为设计意图的长期权威。见 `docs/agents/domain.md`。
