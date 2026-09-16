# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

**Single-context repo**——本仓库即是：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-page-click-over-direct-api.md
│   ├── 0002-explicit-failure-feedback-over-silence.md
│   └── 0003-inline-playwright-core.md
└── packages/
    ├── plugin/
    ├── shared/
    └── webui/
```

`packages/` 虽然有多个包，但**不是** multi-context：三个包共享同一份领域语言，`packages/shared` 就是类型层面的证据。因此没有 `CONTEXT-MAP.md`，将来也不该为了「包多」而拆出 per-package 的 `CONTEXT.md`——要拆的判据是**领域语言是否分叉**，不是包的数量。

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

本仓库最容易漂的三个词：

- **游戏**，不是「分区」「专区」。「分区」是抓取源项目 `qiandao` 的用词（该脚本在 `E:\Desktop\qiandao\src\index.js`，不在本仓库），`CONTEXT.md` 有映射表。
- **区服**，不是「服务器组合」。
- **数据新鲜度阈值**，不是「限流」「冷却」「CD」。它约束的是**数据要不要重新抓**，不是**用户能不能发指令**——同一个数值承载两种语义会导致实现时把两者混为一谈，早期设计草稿的 D22/D23 就是这个混淆。

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## 设计文档也是权威

除 `CONTEXT.md` 与 `docs/adr/` 外，本仓库还有第三份权威：[`docs/design.md`](../design.md)。它是**设计意图的长期权威**，定稿状态。工程技能在动手前应当读它对应的小节。

三者的分工：

| 文件 | 管什么 |
| --- | --- |
| `CONTEXT.md` | 术语与默认值语义——**词** |
| `docs/adr/` | 难逆转的决策及其理由——**为什么不能改** |
| `docs/design.md` | 本插件的设计意图与验收依据——**要建成什么样** |
| `docs/*-pattern.md` | 通用实现范式——**怎么写**（正文零项目引用） |

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

本仓库的 [ADR-0001](../../docs/adr/0001-page-click-over-direct-api.md)（坚持页面内点击，而非直连价格接口）标注为**不可违背**。任何「改用直连 `api.qiandao.com` 更简单 / 更快」的想法都先撞在这条上——理由见该 ADR 正文（签名头无法脱离页面静态构造）。
