/**
 * `price` 指令 —— 手动刷新 + 展示
 *
 * 见设计文档 §12.2（手动刷新）与 §12.3（展示）。本片落定"抓取 → 落盘 → 展示"这条链路;
 * 新鲜度（只重抓过期的）与互斥锁在片 05, 归档在片 07。
 *
 * ⚠️ 本片会抓**全部**订阅游戏, 而不是"只抓过期的"——这是范围边界, 不是实现简化。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { UserRole } from '../../core/admin';
import { sessionKeyOf } from '../../core/session';
import { pluginState } from '../../core/state';
import { ensureBrowserStatus } from '../../services/browser/status';
import { renderGame } from '../../services/renderer';
import { scrapeGames } from '../../services/scraper';
import { DataStore } from '../../store/data.store';
import { SessionStore } from '../../store/session.store';
import { sendReply } from '../utils';

/**
 * 服务不可用的统一文案。
 *
 * 浏览器不可用与 `catalogs` 为空**共用同一句**（设计文档 §14）: 对用户而言两者的下一步
 * 动作是一样的——找管理员。把"是没装浏览器还是没配游戏"暴露给普通群成员没有意义。
 */
export const SERVICE_UNAVAILABLE = '服务不可用，请联系机器人管理员';

/** 手动抓取前的回执。抓取可能要跑几十秒, 期间用户需要知道指令被收到了 */
export const SCRAPING_NOTICE = '正在抓取…';

/**
 * `price` 的依赖注入点。
 *
 * 抓取要起浏览器访问站点, 单测里不该真做。但本项目其余测试**一律跑真实实现**, 所以这里
 * 不用 mock 框架, 只把"起浏览器抓取"这一个动作换成可替换引用。
 */
export const priceHandlerDeps = {
    scrape: scrapeGames,
};

/** `#currency price` */
export async function priceHandler(
    ctx: NapCatPluginContext,
    event: OB11Message,
    _commands: string[],
    userRole: UserRole,
): Promise<void> {
    const { catalogs } = pluginState.config;

    // 浏览器不可用 **或** catalogs 为空 → 服务不可用（§14）。顺序上先判 catalogs:
    // 它是纯配置判断, 不依赖任何检测结果
    if (catalogs.length === 0 || !ensureBrowserStatus().available) {
        await sendReply(ctx, event, SERVICE_UNAVAILABLE);

        return;
    }

    const sessionKey = sessionKeyOf(userRole.from);
    const { enabledGames } = SessionStore.getInstance().getSession(sessionKey);

    // 订阅的游戏可能已经被从配置里删掉了, 这类名字抓不了也不该抓
    const targets = catalogs.filter((catalog) => enabledGames.includes(catalog.name));

    if (targets.length === 0) {
        await sendReply(ctx, event, NO_GAME_TO_SCRAPE);

        return;
    }

    // 抓取可能要跑几十秒, 先回执一声, 免得用户以为指令没被收到
    await sendReply(ctx, event, SCRAPING_NOTICE);

    const results = await priceHandlerDeps.scrape(targets, {
        executablePath: ensureBrowserStatus().path ?? '',
    });

    const store = DataStore.getInstance();
    for (const [gameName, result] of Object.entries(results)) {
        store.saveGameResult(gameName, result);
    }

    await sendReply(ctx, event, renderSessionGames(enabledGames, store));
}

/** 本会话没有可抓的游戏时的提示（还没订阅, 或订阅的游戏已从配置里删掉） */
export const NO_GAME_TO_SCRAPE = '本会话没有可抓取的游戏，用 game 指令查看并订阅';

/**
 * 按**本会话订阅顺序**渲染全部游戏。
 *
 * 顺序取自 `enabledGames` 而不是 `catalogs`: 用户按什么顺序订的, 就按什么顺序看。
 * 没有数据的游戏（从未成功抓到过）直接跳过——展示一个空壳只会让人以为抓到了。
 */
function renderSessionGames(enabledGames: string[], store: DataStore): string {
    const blocks: string[] = [];

    for (const gameName of enabledGames) {
        const record = store.getGame(gameName);
        if (record) blocks.push(renderGame(gameName, record));
    }

    return blocks.join('\n\n');
}
