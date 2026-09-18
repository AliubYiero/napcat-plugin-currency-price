/**
 * 帮助指令 (`{prefix}` 与 `{prefix} help` 都路由到这里)
 *
 * 本文件**只声明"哪些图片文件对应哪些变体"**, 不写任何帮助内容:
 * 内容与文本在 `scripts/generateHelp/cmds/currency-price.ts` (权威源) 里,
 * 由 `pnpm help:generate` 产出三张 PNG 与本目录的 `helpText.generated.ts`。
 * 选变体与图片/文本的回退在 `src/utils/helpMessage.ts`。
 *
 * ⚠️ **不要在这里写帮助文本**——手写的文案不会随权威源更新, 两处内容必然分叉。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../../core/admin';
import { sendHelpMessage, type HelpVariant } from '../../utils/helpMessage';
import { HELP_TEXT_MAP } from './helpText.generated';

/**
 * 各变体对应的帮助图片
 *
 * 纯命名映射, 无内容; 文件名由生成脚本按 `{cmdId}-{Role}.png` 落盘到 `src/assets/`,
 * 构建时复制进插件根目录的 `assets/`。
 */
const HELP_IMAGE: Record<HelpVariant, string> = {
    user: 'napcat-plugin-currency-price-User.png',
    admin: 'napcat-plugin-currency-price-Admin.png',
    superAdmin: 'napcat-plugin-currency-price-SuperAdmin.png',
};

/** `{prefix}` / `{prefix} help` */
export async function helpHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _commands: string[],
    _userRole: UserRole,
): Promise<void> {
    await sendHelpMessage(ctx, event, {
        imageMap: HELP_IMAGE,
        textMap: HELP_TEXT_MAP,
    });
}
