/**
 * 消息接收入口
 *
 * 职责固定为五步, **顺序不可调换** (见 docs/instruction-pattern.md):
 *   1. 群启用检查
 *   2. 规范化 rawMessage (按 `allowAtBotTrigger` 决定是否剥离 @机器人 CQ 段)
 *   3. 前缀检查
 *   4. 切词
 *   5. 分发
 *
 * ⚠️ 接收层**不做权限校验**——权限是指令语义, 由分发层统一处理。
 * 接收层也不认识指令语义, 只负责把切好的参数交给 `resolveInstruction`。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { getUserRole } from '../core/admin';
import { pluginState } from '../core/state';
import { stripAtBotPrefix } from './at-bot-prefix';
import { registry, renderFailure, resolveInstruction } from './instruction';
import { sendReply } from './utils';

export { sendForwardMsg, sendGroupMessage, sendPrivateMessage, sendReply } from './utils';
export type { ForwardNode } from './utils';

/**
 * 规范化 rawMessage: `trim()` → 剥离 @机器人 → `trimStart()`
 *
 * `allowAtBotTrigger` 关闭时**完全跳过规范化** (连 `trim()` 都不做), `rawMessage` 原样
 * 进入前缀检查。此时 `[CQ:at,qq=机器人] #cmd` 会因不以 `commandPrefix` 开头而静默返回。
 */
function normalizeRawMessage(rawMessage: string, selfId: string, allowAtBotTrigger: boolean): string {
    if (!allowAtBotTrigger) return rawMessage;

    return stripAtBotPrefix(rawMessage.trim(), selfId).trimStart();
}

/**
 * 消息处理主函数
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        const { commandPrefix, allowAtBotTrigger } = pluginState.config;

        // 1. 群启用检查: 先于规范化与前缀检查, 避免在禁用的群里做无谓的字符串处理
        if (event.message_type === 'group' && event.group_id) {
            if (!pluginState.isGroupEnabled(String(event.group_id))) return;
        }

        // 2. 规范化
        const rawMessage = event.raw_message || '';
        const normalized = normalizeRawMessage(rawMessage, pluginState.selfId, allowAtBotTrigger);

        // 3. 前缀检查: 不匹配是绝大多数消息的正常路径, **不回复、不记日志**
        if (!normalized.startsWith(commandPrefix)) return;

        // 4. 切词: 空串会切出 [''], 由分发层的空参数兜底与参数校验接手
        const args = normalized.slice(commandPrefix.length).trim().split(/\s+/);

        // 5. 分发: 角色在入口**一次性推导**, 之后在分发层与 handler 间传递
        const userRole = getUserRole(event);
        const outcome = resolveInstruction(userRole, args, registry);

        if (outcome.kind !== 'execute') {
            const text = renderFailure(outcome, commandPrefix);
            if (text !== null) await sendReply(ctx, event, text);
            return;
        }

        await outcome.definition.handler(ctx, event, outcome.args, userRole);
        pluginState.incrementProcessed();
    } catch (error) {
        // 本函数是所有消息事件的入口, 异常外抛会影响插件宿主
        pluginState.logger.error('处理消息时出错:', error);
    }
}
