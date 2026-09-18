/**
 * 通知层 —— 定时推送
 *
 * 见设计文档 §10 与 §12.1。行为是: 对**每个开了通知的会话**, 按该会话 `enabledGames`
 * 的顺序, 一个游戏一条消息, 串行发出、每条之间间隔 `pushIntervalMs`。
 *
 * 三条容易做反的规则:
 * - **推送该会话订阅的全部游戏**, 包括本轮因新鲜而跳过抓取的（§10.1）——定时推送的价值
 *   在于**定期送达**, 不因为数据刚更新过就缺席。这类游戏**不加**「（数据未更新）」标记。
 * - **没有旧值的游戏直接跳过**（从未成功抓到过）——推一条空壳只会让人以为抓到了。
 * - **全部游戏都没得推时完全静默**——不发专门的失败告警消息本身就是设计（§10.4）。
 *
 * ⚠️ 本模块**只管推送**: 抓取、落盘、归档在 `scrape-runner`; 什么时候推由调度器决定,
 * 本模块不知道也管不着调度。
 */

import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { parseSessionKey, type SessionTarget } from '../core/session';
import { pluginState } from '../core/state';
import { sendGroupMessage, sendPrivateMessage } from '../handlers/utils';
import { DataStore } from '../store/data.store';
import { SessionStore } from '../store/session.store';
import { createSendPacer } from '../utils/pacing';
import { renderGame } from './renderer';

/** 送到目标会话。群与私聊各走各的接口——`send_msg` 的目标字段不同 */
async function deliver(
    ctx: NapCatPluginContext,
    target: SessionTarget,
    message: string,
): Promise<void> {
    if (target.type === 'group') {
        await sendGroupMessage(ctx, target.id, message);

        return;
    }

    await sendPrivateMessage(ctx, target.id, message);
}

/**
 * 向所有开了通知的会话推送价格。
 *
 * @param failedGames **本轮抓取失败**的游戏名。这些游戏渲染的是 `data.json` 里的旧值,
 *                    头部要带「（数据未更新）」。不在集合里的游戏——无论本轮抓成功、
 *                    因新鲜而跳过、还是压根没参与本轮——都按新数据渲染。
 *
 *                    判定依据刻意选「本轮结果」而不是 `data.json` 的 `lastError`:
 *                    后者会误标「上次抓失败、这轮因新鲜而跳过」的游戏, 而那种情况下的
 *                    数据是 5 分钟内的, 加标记反而误导（§10.2）。
 */
export async function pushToSubscribers(
    failedGames: ReadonlySet<string> = new Set(),
): Promise<void> {
    const sessions = SessionStore.getInstance().getSessions();
    const store = DataStore.getInstance();
    const ctx = pluginState.ctx;

    // 全局串行节拍: 消息**一条一条发**, 间隔加在相邻两条之间（含跨会话的那一次接续）。
    // 「串行本身不解决频控, 间隔才是」——边界在 QQ 服务端, 因部署而异（§10.3）
    const pace = createSendPacer(pluginState.config.pushIntervalMs);

    for (const [sessionKey, session] of Object.entries(sessions)) {
        if (!session.notifyEnabled) continue;

        const target = parseSessionKey(sessionKey);
        if (!target) {
            pluginState.logger.warn('(；′⌒`) 会话键格式非法, 跳过推送: ' + sessionKey);

            continue;
        }

        for (const gameName of session.enabledGames) {
            const record = store.getGame(gameName);
            // 从未成功抓到过 → 没有旧值可推, 跳过（§10.3）
            if (!record) continue;

            await pace();

            await deliver(
                ctx,
                target,
                renderGame(gameName, record, { notUpdated: failedGames.has(gameName) }),
            );
        }
    }
}
