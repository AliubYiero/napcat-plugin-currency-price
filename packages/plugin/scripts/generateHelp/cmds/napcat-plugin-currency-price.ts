/**
 * 千岛通货价格 — 帮助权威源 (**唯一可手改的帮助内容源**)
 *
 * 分组见设计文档 §11.1 / §19。改完这里**必须**重跑 `pnpm help:generate`,
 * 文本映射与三张 PNG 一并重新落盘 (headless 图不会自己知道源变了)。
 *
 * ⚠️ **SuperAdmin 版与 Admin 版内容相同**——本插件没有超管专属指令。不是漏了分组:
 * 三档照常生成是范式要求, 代价只是多渲一张相同的图, 换来的是将来加任何超管指令时
 * 只需在这里加一个 `isSuperAdmin: true` 的分组, 生成链路与运行时都不用动。
 *
 * ⚠️ **前缀烧进产物**: 指令原文连前缀一起渲染, 所以 `prefix` 由生成脚本从
 * `src/config.ts` 的 `DEFAULT_CONFIG.commandPrefix` 传入——前缀是开发期常量,
 * 改它必须重跑生成, 否则用户看到的帮助与生效的指令对不上。
 */

import type { Cmd } from '../cmd.ts';

/** 帮助面板 id, 同时是 PNG 文件名前缀 (`{id}-{Role}.png`) */
export const CMD_ID = 'napcat-plugin-currency-price';

export function buildCurrencyPriceHelp(prefix: string): Cmd {
    return {
        id: CMD_ID,
        title: '千岛通货价格 插件帮助',
        cmd: [
            {
                groupName: '核心指令',
                instructions: [
                    {
                        cmd: `${prefix} price`,
                        desc: '获取游戏通货价格数据, 然后展示本会话订阅的全部游戏通货价格',
                    }
                ],
            },
            {
                groupName: '辅助指令',
                instructions: [
                    {
                        cmd: `${prefix} help`,
                        desc: '显示本帮助',
                    },
                    {
                        cmd: `${prefix} status`,
                        desc: '查看本会话的通知开关、已订阅游戏与各游戏数据时间',
                    },
                ],
            },
            {
                // 与上一个分组同名是有意的: 同组按权限拆开, 由上游按权限组各自过滤
                groupName: '管理指令',
                isAdmin: true,
                instructions: [
                    {
                        cmd: `${prefix} notify on`,
                        desc: '开启本会话定时价格通知',
                    },
                    {
                        cmd: `${prefix} notify off`,
                        desc: '关闭本会话定时价格通知',
                    },
                    {
                        cmd: `${prefix} game add <游戏名...>`,
                        desc: '订阅游戏 (可空格分隔多个)',
                    },
                    {
                        cmd: `${prefix} game remove <游戏名...>`,
                        desc: '退订游戏 (可空格分隔多个)',
                    },
                ],
            },
        ],
    };
}
