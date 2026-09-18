/**
 * 数据新鲜度判定
 *
 * 见设计文档 §9.2。抓取前按**游戏**逐个判断: 距上次成功抓取超过阈值 → 过期, 需要重抓。
 *
 * ⚠️ 判定依据是**该游戏自己的 `readAt`**（`data.json` 的游戏级字段）, 不是全局时间戳,
 * 也不是「用户能不能发指令」。从未成功抓到过的游戏（无记录）天然判为过期——
 * 没有数据就是没有, 不存在"还算新鲜"。
 */

import { DataStore, type GameRecord } from '../store/data.store';

/**
 * 数据新鲜度阈值: 5 分钟。
 *
 * ⚠️ **是常量, 不是配置项**（§9.2）——它与「用户会不会想改」无关, 属于领域语义。
 * 将来真有需求时, 再按配置范式四环节提升为配置项。
 */
export const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

/** 新鲜度判定的注入点。生产代码用缺省值, 测试注入固定时刻 */
export interface StalenessDeps {
    /** 当前时刻 (毫秒时间戳)。缺省取系统时间 */
    now?: () => number;
    /** 查游戏记录。缺省读 `data.json` 存储 */
    getGame?: (gameName: string) => GameRecord | null;
}

/**
 * 判断**一个游戏**是否过期。
 *
 * `readAt` 缺失 / 无法解析都算过期——宁可多抓一次, 不可拿着未知新旧的数据当新的用。
 * 边界: 恰好等于阈值算**新鲜**（判定条件是严格大于）。
 */
export function isStaleGame(readAt: string | null | undefined, deps: StalenessDeps = {}): boolean {
    if (!readAt) return true;

    const readAtMs = new Date(readAt).getTime();
    if (Number.isNaN(readAtMs)) return true;

    const now = deps.now?.() ?? Date.now();

    return now - readAtMs > STALENESS_THRESHOLD_MS;
}

/**
 * 从一批游戏名里筛出**过期的**那些。调用方只重抓返回值里的游戏。
 *
 * ⚠️ 保持**传入顺序**输出: 抓取顺序是展示顺序的依据, 这里不重排。
 */
export function getStaleGames(
    gameNames: string[],
    deps: StalenessDeps = {},
): string[] {
    const getGame = deps.getGame ?? ((name: string) => DataStore.getInstance().getGame(name));

    return gameNames.filter((name) => isStaleGame(getGame(name)?.readAt, deps));
}
