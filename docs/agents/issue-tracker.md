# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

> **为什么是本地 Markdown**：本仓库没有 git remote，机器上也没有 `gh` / `glab`，GitHub 与 GitLab 追踪器都开箱不可用。选本地 Markdown 是当前唯一无需额外前置的选项。将来若接入远程仓库，改本文件即可切换。

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## 本仓库的附加约定

- 每片 issue 头部除 `Status:` 外还有两行：`Type:`（`AFK` / `HITL`）与 `Blocked by:`（其余切片的编号；无依赖时写 `None - can start immediately`）。
- `Source:` 行指向设计文档的对应小节（如 `docs/design.md §9.2`）。设计文档是设计意图的**长期权威**，issue 里不复制其内容，只引用；冲突时以设计文档为准。
- 领域术语一律用 `CONTEXT.md` 的词（**游戏 / 区服 / 通货 / 会话 / 抓取运行 / 数据新鲜度阈值**），不要漂到源项目 `qiandao` 的用词。源项目把「游戏」叫「分区」，映射写在 `CONTEXT.md` 里。

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
