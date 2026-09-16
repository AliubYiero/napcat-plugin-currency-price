# 0003 - 内联打包 playwright-core，并接受随之而来的构建期补丁

## 背景与问题

抓取只能走浏览器自动化（[ADR-0001](./0001-page-click-over-direct-api.md)），因此 `playwright-core` 是本插件唯一的重量级依赖。

但 NapCat 的发布形态**只含 `index.mjs` / `package.json` / `webui/`**（见 `.example/plugin/publish.md`），宿主不会为插件安装 `dependencies`。所以 `playwright-core` 必须**内联打包**进单个 `index.mjs`。

问题在于：`playwright-core` 是 CJS 包，且**在模块加载期**（不是调用期）就按 `__dirname` 解析自指的"包根目录"、读取 `package.json` 与 `browsers.json`。而 rollup 会把 CJS 的 `require` 一律提升成产物**顶层的静态 import**——上游原本惰性的可选依赖因此变成加载期求值。内联不是"改个配置"就能成的事，需要六类构建期处置，缺任何一项都是「构建通过、加载即崩」，且六种症状各不相同。

## Considered Options

**内联打包 + 六类构建期补丁（已采纳）**。发布形态保持不变（单入口 `index.mjs`），与 NapCat 生态一致；代价是构建配置里积累一批针对第三方包内部实现的补丁（见结论）。

**保持 external，随包发布 `playwright-core` 的原始文件（已否决）**。让 `playwright-core` 保持真实的 CJS 文件布局随包发布，运行时用 `createRequire` 从插件目录加载。这条路会**一次性消掉全部六类补丁**：`__dirname` 真实存在、动态 `require` 正常、`inspector` 保持上游的惰性、`browsers.json` 本来就在包里。

否决理由：发布包从 1 个入口文件变成约 7 MB 的目录树，与 NapCat "单入口"的发布形态背离；插件目录下会多出一棵"几乎原样"的第三方依赖树，升级时靠手工同步。

> ⚠️ **如实记录**：这条路线**没有被实测**——它是在内联路线已经走通之后才成形的。若将来六类补丁的维护成本失控（例如升级 playwright 时反复踩坑），这是**首选的回退方向**，且回退成本集中在构建配置而非业务代码。

**不做浏览器自动化（已否决）**。见 [ADR-0001](./0001-page-click-over-direct-api.md)，不重复。

## 结论

内联打包，并**成组地**施加六类处置（完整实现见 `packages/plugin/vite.config.ts`）：

| 类别 | 处置 |
| --- | --- |
| 可选原生模块 `bufferutil` / `utf-8-validate` / `kerberos` | 保持 **external** |
| 可选外部包 `chromium-bidi/*`、`electron/*` | 解析为**空桩模块** |
| 内建模块 `inspector` | 解析为**惰性桩** |
| 动态 `require(join(packageRoot, …))` | `commonjsOptions.ignoreDynamicRequires: true` |
| 加载期自指的 `__dirname` / `require` | 产物前置 **shim 横幅** |
| `browsers.json` | 随包复制到插件根目录 |

要点：

- **六类是一个整体，不能只做一部分**。它们对应六个互不相同的加载期故障（`ERR_MODULE_NOT_FOUND` / `ERR_INSPECTOR_NOT_AVAILABLE` / `__dirname is not defined` / `commonjsRequire` 抛错 …），只修一部分只会换一种崩法。
- **可选原生模块必须保持 external，不得顺手改成桩**。它们包在 `try/catch` 里，靠"`require` 未定义 → 抛错 → 被 catch"回退到纯 JS 实现；换成 `{}` 桩会让 ws 选中"原生可用"分支，把启动期的确定性回退变成发大帧时的随机崩溃。
- **命中 `rollupOptions.external` 的 id 会绕过 `resolveId` 钩子**。需要打桩的内建模块（`inspector`）必须先从 `external` 里摘掉，否则桩静默不生效。
- **shim 把 `__dirname` 伪造成「插件根目录 /lib」**，使 playwright 算出的 `packageRoot` 落在插件根目录，从而读到随包发布的 `package.json` 与 `browsers.json`。这是六类里最"脏"的一处：它同时让 `libPath()` 指向不存在的 `<插件根>/lib/*`。

## 后果约束

由上面最后一点直接推出——**本决策把"不做截图 / trace / headed 启动"从实现细节上升为约束**：

`libPath()` 服务于 oopBrowserDownload / appIcon / electron loader / trace viewer / `webp_codec.wasm` 等路径。这些路径在内联布局下全部指向不存在的位置。本插件当前只做 headless + 显式 `executablePath` + `goto` + 页面交互，一条都不走；**将来若要启用截图（尤其 webp）、trace 或 headed 启动，必须先重新处理 shim，而不是直接调用 playwright API**。

## 该决策约束的范式文档

- [design.md](../design.md) §8.2「依赖与浏览器」——六类处置的表格与反直觉点已回写该节；§17 第 0 步记录了实测结论。
- 无对应的 `*-pattern.md`。范式体系的[「指南的生长」](../development-pattern.md)一节列出了尚未成文的区域，**构建与发布形态**不在其中，但本 ADR 表明它同样有可提炼的通用经验（第三方 CJS 包内联时的加载期陷阱），后续可考虑补一份范式文档。
