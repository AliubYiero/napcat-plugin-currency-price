/**
 * 状态指令（基础版）
 *
 * 完整输出（本会话通知开关 / 已订阅游戏 / 各游戏数据时间 / 浏览器状态）依赖订阅关系、
 * 数据层与浏览器层, 由后续片补全。本片只报告骨架期就已知的部分。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../../core/admin';
import { pluginState } from '../../core/state';
import { sendReply } from '../utils';

/** `#currency status` */
export async function statusHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _commands: string[],
    userRole: UserRole,
): Promise<void> {
    const { commandPrefix, catalogs } = pluginState.config;

    const lines = [
        `${commandPrefix} 状态`,
        `运行时长：${pluginState.getUptimeFormatted()}`,
        `已配置游戏：${catalogs.map((catalog) => catalog.name).join('、') || '（无）'}`,
    ];

    // 浏览器状态**只对「私聊 + 超管」显示**——普通成员看它没有意义, 也不该暴露部署细节
    if (userRole.role === 'superAdmin' && userRole.from.type === 'private') {
        lines.push('', '浏览器：未检测');
    }

    await sendReply(ctx, event, lines.join('\n'));
}
