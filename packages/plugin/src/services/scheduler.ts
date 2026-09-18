/**
 * 调度器 —— `pushHours` 小时集合的定时抓取
 *
 * 见设计文档 §9.1 §9.4 §12.1。端到端行为: `pushHours` 设成 `[9, 21]` 时, 机器人每天
 * 9 点和 21 点自己抓一遍; 清空 `pushHours` 立刻停下; 改成 `[10]` 不用重启就按新集合来。
 *
 * 关键决策（§9.1）:
 * - **下一个触发在上一次运行结束后计算**——抓取耗时可能跨过整点, 基于完成时刻重算
 *   保证抓取天然不自我重叠
 * - **停摆条件两个, 同一处处理**: 订阅并集为空 或 `pushHours` 为空 → 不挂定时器;
 *   运行中变为空则取消现有定时器
 * - **定时器必须注册进 `pluginState.timers`**——否则每热重载一次就多一条 `setTimeout`
 *   链在后台跑
 *
 * 本片只做「到点抓取并落盘」, 推送是片 09（插在释放锁之前）。
 */

import { pluginState } from '../core/state';
import { SessionStore } from '../store/session.store';
import { ensureBrowserStatus } from './browser/status';
import { pushToSubscribers } from './notifier';
import { runWithScrapeLock } from './scrape-lock';
import { failedGamesOf, runScrapeRound, type ScrapeRoundDeps } from './scrape-runner';
import { getStaleGames } from './staleness';
import { nextSelectedHour } from '../utils/time';

/** 调度器定时器在 `pluginState.timers` 里的键。全插件只有一个调度器 */
export const SCHEDULER_TIMER_ID = 'currency-scheduler';

/** 调度器的注入点。生产代码用缺省值, 测试注入固定时刻与假抓取器 */
export interface SchedulerDeps extends ScrapeRoundDeps {
    /** 当前时刻 (毫秒时间戳)。缺省取系统时间 */
    now?: () => number;
}

/**
 * 订阅并集: 所有会话订阅的游戏名的并集。
 *
 * 调度器抓的是"有人在听"的游戏——一个游戏没有任何会话订阅时, 抓了也没人要。
 */
export function subscribedGameUnion(): string[] {
    const sessions = SessionStore.getInstance().getSessions();

    return [...new Set(Object.values(sessions).flatMap((session) => session.enabledGames))];
}

/**
 * 停摆判定（两个条件, 同一处处理）:
 * 插件未启用 / `pushHours` 为空 / 订阅并集为空 → 停摆。
 */
export function isSchedulerStalled(deps: SchedulerDeps = {}): boolean {
    void deps;

    if (!pluginState.config.enabled) return true;
    if (!pluginState.config.pushHours || pluginState.config.pushHours.length === 0) return true;
    if (subscribedGameUnion().length === 0) return true;

    return false;
}

/**
 * 取消现有定时器。重挂与停摆都从这里走——**先取消再决定挂不挂**, 免得配置收紧后
 * 旧定时器还挂在已不再选中的时刻上。
 */
export function stopScheduler(): void {
    const timer = pluginState.timers.get(SCHEDULER_TIMER_ID);
    if (timer) {
        clearTimeout(timer);
        pluginState.timers.delete(SCHEDULER_TIMER_ID);
        pluginState.logger.debug('(｡-ω-) 已取消定时抓取定时器');
    }
}

/**
 * 重挂调度器: 取消现有定时器 → 评估停摆条件 → 决定挂不挂、挂在哪。
 *
 * 配置变更（`pushHours` / `catalogs` / `enabled`）后调用, 运行期生效, 无需重启。
 * 浏览器不可用时**不挂**（设计文档 §14）——装好浏览器后的首次配置变更会把它带回来。
 */
export function rearmScheduler(deps: SchedulerDeps = {}): void {
    stopScheduler();

    if (isSchedulerStalled(deps)) return;
    if (!ensureBrowserStatus().available) {
        pluginState.logger.debug('(｡-ω-) 浏览器不可用, 不挂定时抓取调度器');

        return;
    }

    const now = deps.now?.() ?? Date.now();
    const next = nextSelectedHour(now, pluginState.config.pushHours);
    if (next === null) return;

    const timer = setTimeout(() => {
        void schedulerTick(deps);
    }, next - now);

    // ⚠️ 必须注册进 `pluginState.timers`: 热重载时 NapCat 只清理这里登记的定时器,
    // 漏登记就每重载一次多一条 setTimeout 链在后台跑
    pluginState.timers.set(SCHEDULER_TIMER_ID, timer);

    pluginState.logger.debug(`(｡･ω･) 下次定时抓取: ${new Date(next).toLocaleString()}`);
}

/**
 * 到点触发的一轮抓取。也供测试直接调用（等价于把定时器拨到触发时刻）。
 *
 * 触发后的动作序列（§12.1）:
 * 停摆检查 → 算并集 → 抢全局锁 → 轮到自己时重算过期集合 → 抓过期的 → 落盘 → 归档 + 维护
 * → **推送**（无论本轮抓没抓）→ 释放锁 → 基于完成时刻计算下一个选中整点 → 重挂定时器
 */
export async function schedulerTick(deps: SchedulerDeps = {}): Promise<void> {
    try {
        // 停摆检查在触发后**再做一次**: 挂定时器到真正触发之间配置可能已经变了
        if (isSchedulerStalled(deps)) {
            stopScheduler();

            return;
        }

        if (!ensureBrowserStatus().available) {
            pluginState.logger.warn('(；′⌒`) 定时抓取时浏览器不可用, 本轮跳过');

            return;
        }

        const union = subscribedGameUnion();
        const unionCatalogs = pluginState.config.catalogs.filter(
            (catalog) => union.includes(catalog.name),
        );

        // ⚠️ **锁提到最外层**: 推送要落在锁内（§12.1 的"释放锁之前"——推送期间不该有
        // 另一个抓取插进来）, 而推送**每一轮都要发生**。若像片 08 那样把锁包在
        // `if (stale.length > 0)` 里, "全部游戏都新鲜"的那一轮就整轮缺席推送——
        // 而那种轮次恰恰是最常见的（每小时推一次, 数据只有 5 分钟算新鲜）
        await runWithScrapeLock(async () => {
            // 后到者轮到自己时重算: 排队期间前一个持锁者（如手动抓取）可能已经
            // 把这些游戏抓过了, 此时直接复用, 不再起浏览器
            const stillStale = getStaleGames(union);
            let failed = new Set<string>();

            if (stillStale.length > 0) {
                const { results } = await runScrapeRound(
                    unionCatalogs.filter((catalog) => stillStale.includes(catalog.name)),
                    'schedule',
                    { scrape: deps.scrape },
                );

                failed = failedGamesOf(results);
            }

            // 推送范围是**该会话订阅的全部游戏**, 与本轮抓了哪些无关（§10.1）
            await pushToSubscribers(failed);
        });
    } catch (error) {
        pluginState.logger.error('(╥﹏╥) 定时抓取失败:', error);
    } finally {
        // ⚠️ 在上一次运行**结束后**计算下一次: 抓取跨过整点时, 基于完成时刻重算
        // 保证下一次触发不可能落在正在进行的时间段里——抓取天然不自我重叠
        rearmScheduler(deps);
    }
}
