/**
 * 帮助指令
 *
 * ⚠️ **本片只做文本帮助**。图片优先 / 文本回退的完整链路 (权威源 → 生成脚本 → 三张 PNG
 * + `helpText.generated.ts`) 在帮助输出片落地, 届时本文件的内容由生成产物替换,
 * 只保留变体选择与发送。
 *
 * 变体映射见 docs/help-output-pattern.md 的"变体映射"节。
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { UserRole } from '../../core/admin';
import { pluginState } from '../../core/state';
import { sendReply } from '../utils';

/** 帮助输出版本档位。**与权限档位不是一一对应** (群聊超管输出 admin 版)。 */
export type HelpVariant = 'user' | 'admin' | 'superAdmin';

/**
 * 由「角色 + 会话类型」共同决定输出版本
 *
 * 两个反直觉点, 不要"顺手统一":
 * - `privateUser` (好友私聊) 等同 admin 权限组 → 输出 **admin** 版;
 * - **群聊里的超管输出 admin 版而非 superAdmin 版**——SuperAdmin 版含仅私聊可用的指令,
 *   在群里输出会误导用户。只有私聊里的超管才看到完整版。
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
 * 文本帮助内容。
 *
 * ⚠️ 临时内容: 只列**当前真正可用**的指令, 不预告尚未实现的指令——列了就是骗用户。
 * 帮助输出片会用生成产物整体替换。
 */
function buildHelpText(variant: HelpVariant, prefix: string): string {
    const lines = [
        `[= 千岛通货价格 =]`,
        `${prefix} help    显示本帮助`,
        `${prefix} status  查看本会话订阅与数据状态`,
    ];

    if (variant === 'admin' || variant === 'superAdmin') {
        lines.push('', '管理指令（待后续实现）');
    }

    return lines.join('\n');
}

/** `#currency` / `#currency help` */
export async function helpHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _commands: string[],
    userRole: UserRole,
): Promise<void> {
    const variant = getHelpVariant(userRole);
    const text = buildHelpText(variant, pluginState.config.commandPrefix);

    await sendReply(ctx, event, text);
}
