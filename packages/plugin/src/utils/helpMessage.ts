/**
 * 帮助消息输出共享工具
 *
 * 帮助链路的**运行时一半**: 按「角色 + 会话类型」选变体, 图片优先、文本回退。
 * 另一半 (权威源 → 生成 → 产物) 在 `scripts/generateHelp/`, 见 docs/help-output-pattern.md。
 *
 * handler 只提供两份内容 (`imageMap` + `textMap`), **不自行实现选择与回退逻辑**——
 * 这两件事每个帮助面板都要做一遍, 抄第二遍时必然漏掉一条分支。
 */

import fs from 'node:fs';
import { resolve } from 'node:path';
import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../core/admin';
import { getUserRole } from '../core/admin';
import { pluginState } from '../core/state';
import { createImageMessage, sendReply } from '../handlers/utils';

/** 帮助输出版本档位。**与权限档位不是一一对应** (群聊超管输出 admin 版)。 */
export type HelpVariant = 'user' | 'admin' | 'superAdmin';

/** 按帮助版本组织的内容: 图片文件名 + 文本帮助 (图片降级用) */
export interface HelpContent {
    /** 变体 → PNG 文件名 (位于插件根目录的 `assets/`) */
    imageMap: Record<HelpVariant, string>;
    /** 变体 → 文本帮助, 由生成脚本产出 */
    textMap: Record<HelpVariant, string>;
}

/**
 * 由「角色 + 会话类型」共同决定输出版本
 *
 * 两个反直觉点, 不要"顺手统一":
 * - `privateUser` (好友私聊) 等同 admin 权限组 → 输出 **admin** 版;
 * - **群聊里的超管输出 admin 版而非 superAdmin 版**——SuperAdmin 版含仅私聊可用的指令,
 *   在群里输出会误导用户。只有私聊里的超管才看到完整版。
 *
 * 映射表见 docs/help-output-pattern.md 的"变体映射"节。
 */
export function getHelpVariant(userRole: UserRole): HelpVariant {
    switch (userRole.role) {
        case 'superAdmin':
            return userRole.from.type === 'private' ? 'superAdmin' : 'admin';
        case 'privateUser':
        case 'admin':
            return 'admin';
        case 'user':
            return 'user';
    }
}

/**
 * 找到帮助图片的绝对路径, 找不到返回 `null`
 *
 * 图片产物落在**插件目录**的 `assets/` 下 (build 时 vite 从 `src/assets` 复制到
 * `dist/assets`, 而 `dist` 就是部署出去的插件目录), 故首选 `ctx.pluginPath`。
 *
 * 兜底选项 `dataPath/..` 是另一种见过的落法 (`dataPath` 即 `<插件目录>/data` 时两者等价)。
 * 路径错了的表现是**静默降级成文本帮助**——不报错、只是图没了, 所以这里多花一次
 * `existsSync` 把两种布局都认下来。
 */
function findHelpImage(fileName: string): string | null {
    const candidates = [
        resolve(pluginState.ctx.pluginPath, 'assets', fileName),
        resolve(pluginState.ctx.dataPath, '..', 'assets', fileName),
    ];

    return candidates.find((file) => fs.existsSync(file)) ?? null;
}

/**
 * 输出帮助: **图片优先, 文本回退**
 *
 * 回退覆盖两种情况, 两者都只记一条 warn 后照常发文本:
 * - 图片文件不存在 (构建漏拷 assets、手动清理过);
 * - 图片存在但发送失败 (发送工具返回 `false`)。
 */
export async function sendHelpMessage(
    ctx: NapCatPluginContext,
    event: OB11Message,
    content: HelpContent,
): Promise<void> {
    const variant = getHelpVariant(getUserRole(event));

    const imagePath = findHelpImage(content.imageMap[variant]);
    if (imagePath) {
        const sent = await sendReply(ctx, event, createImageMessage(imagePath));
        if (sent) return;

        pluginState.logger.warn('帮助图片发送失败, 回退文本帮助:', imagePath);
    } else {
        pluginState.logger.warn('帮助图片不存在, 回退文本帮助:', content.imageMap[variant]);
    }

    await sendReply(ctx, event, content.textMap[variant]);
}
