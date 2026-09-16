/**
 * 通知开关指令
 *
 * `#currency notify`（查看, user 级） / `#currency notify on|off`（admin 级）。
 * 开关是**会话级**的: 群聊与私聊各自独立, 公告式推送的订阅由用户自己显式打开——
 * **默认关闭**是领域决策 (见 CONTEXT.md 的"默认值语义声明"), 本模块不提供"默认开启"的入口。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../../core/admin';
import { sessionKeyOf, sessionScopeLabel } from '../../core/session';
import { SessionStore } from '../../store/session.store';
import type { InstructionHandler } from '../instruction';
import { sendReply } from '../utils';

/** 开关状态的统一文案: 查看与切换后的回执用同一句, 用户不必对照两条不同的说法 */
function statusText(from: UserRole['from'], notifyEnabled: boolean): string {
    return `${sessionScopeLabel(from)}通知：${notifyEnabled ? '已开启' : '已关闭'}`;
}

/** `#currency notify`——回显本会话当前的通知开关 */
export async function notifyViewHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _commands: string[],
    userRole: UserRole,
): Promise<void> {
    const { notifyEnabled } = SessionStore.getInstance().getSession(sessionKeyOf(userRole.from));

    await sendReply(ctx, event, statusText(userRole.from, notifyEnabled));
}

/**
 * 生成开关指令的 handler
 *
 * `on` 与 `off` 是同一条逻辑的两个取值, 各自声明在注册表里 (见 handlers/instruction.ts),
 * 权限门槛因此也是各自声明的——不需要在 handler 里判断"我是哪一条"。
 */
export function createNotifySwitchHandler(enabled: boolean): InstructionHandler {
    return async (ctx, event, _commands, userRole) => {
        SessionStore.getInstance().setNotifyEnabled(sessionKeyOf(userRole.from), enabled);

        await sendReply(ctx, event, statusText(userRole.from, enabled));
    };
}
