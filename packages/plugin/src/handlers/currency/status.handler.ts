/**
 * 状态指令 (完整版)
 *
 * 输出见设计文档 §11.4: 通知开关 / 已订阅游戏 / 各游戏数据时间 / 浏览器状态。
 * **全部是本会话的**——同一个群看到的状态与隔壁群、与私聊互不相干。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../../core/admin';
import { sessionKeyOf, sessionScopeLabel } from '../../core/session';
import { pluginState } from '../../core/state';
import { getBrowserStatus } from '../../services/browser/status';
import { DataStore } from '../../store/data.store';
import { SessionStore } from '../../store/session.store';
import { sendReply } from '../utils';

/**
 * 浏览器状态的一行文案。
 *
 * ⚠️ **只读缓存**（`getBrowserStatus`）。这里绝不能触发检测——`status` 是随时会被敲的指令,
 * 而完整检测要起一个浏览器进程。
 *
 * 「未检测」是真话, 不是占位符: 插件启动时会做一次轻量检测填充缓存, 因此这个状态只会出现在
 * 启动异常或检测被清空之后。
 */
function browserLabel(): string {
    const status = getBrowserStatus();
    if (status.checkedAt === null) return '未检测';

    return status.available ? '可用' : '不可用';
}

/** `#currency status` */
export async function statusHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _commands: string[],
    userRole: UserRole,
): Promise<void> {
    const { commandPrefix } = pluginState.config;
    const { notifyEnabled, enabledGames } = SessionStore.getInstance().getSession(
        sessionKeyOf(userRole.from),
    );

    const lines = [
        `${commandPrefix} 状态`,
        `${sessionScopeLabel(userRole.from)}通知：${notifyEnabled ? '已开启' : '已关闭'}`,
        `已订阅游戏：${enabledGames.join('、') || '（无）'}`,
    ];

    if (enabledGames.length > 0) {
        lines.push('');
        for (const gameName of enabledGames) {
            // 数据时间取自 data.json 的**游戏级** readAt (片 03 落盘)。数据层落地前,
            // 每个游戏都确实"从未抓到过"——这不是占位符, 是此刻的事实
            lines.push(`${gameName}：未抓取`);
        }
    }

    // 浏览器状态**只对「私聊 + 超管」显示**——普通成员看它没有意义, 也不该暴露部署细节
    if (userRole.role === 'superAdmin' && userRole.from.type === 'private') {
        lines.push('', `浏览器：${browserLabel()}`);
    }

    await sendReply(ctx, event, lines.join('\n'));
}
