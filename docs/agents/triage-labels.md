# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## 本地 Markdown 下的落法

标签写进 issue 文件头部的 `Status:` 行，不建目录、不加文件后缀。可取值即上表右列五个字符串。切片配对的 `Type:` 行（`AFK` / `HITL`）是**切片的性质**，与 `Status:` 的**分诊状态**是两回事：一片可以是 `Type: HITL` 且 `Status: ready-for-agent`，也可以是 `Type: AFK` 却因信息不全而 `Status: needs-info`。
