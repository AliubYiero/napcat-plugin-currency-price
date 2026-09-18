/**
 * 数据新鲜度判定
 *
 * 见设计文档 §9.2。抓取前按**游戏**逐个判断, 判过期的要重抓。
 *
 * 判定有**两个**依据, 缺一不可:
 *
 * 1. **时间**: 距上次成功抓取超过阈值 → 过期。
 * 2. **配置指纹**: 数据是**按抓取当时那份配置**抓下来的死数据——`zones` 里的组合名、
 *    组合数量、抓过哪些通货都固化在里面。配置改了而指纹对不上 → 过期。少了这一条,
 *    改完区服组合后 5 分钟内再执行 `price`, 拿到的仍是旧组合的数据, 且它看起来完全正常。
 *
 * ⚠️ 判定依据是**该游戏自己的 `readAt`**（`data.json` 的游戏级字段）, 不是全局时间戳,
 * 也不是「用户能不能发指令」。从未成功抓到过的游戏（无记录）天然判为过期——
 * 没有数据就是没有, 不存在"还算新鲜"。
 */

import type { CatalogConfig } from '../types';
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
 * 配置指纹: 描述"这份数据是按哪份配置抓的"。
 *
 * 只取**决定抓到什么**的三个字段, 且**不含 `name`**——名字是记录的键, 改个名字相当于
 * 换了个游戏, 由"无记录 → 过期"覆盖, 不必也不该进指纹。
 *
 * 顺序敏感（`zoneConfigs` 的顺序就是消息里区服的呈现顺序）, 所以直接序列化, 不排序。
 */
export function configFingerprintOf(catalog: CatalogConfig): string {
    return JSON.stringify([catalog.pageUrl, catalog.zoneConfigs, catalog.currencyList]);
}

/**
 * 判断**一个游戏**的数据是否过期。
 *
 * `readAt` 缺失 / 无法解析都算过期——宁可多抓一次, 不可拿着未知新旧的数据当新的用。
 * 边界: 恰好等于阈值算**新鲜**（判定条件是严格大于）。
 *
 * ⚠️ 本函数只看**时间**。配置指纹的比对在 `getStaleGames`——那里才有"抓的是哪个游戏
 * 的哪份配置"这个上下文。
 */
export function isStaleGame(readAt: string | null | undefined, deps: StalenessDeps = {}): boolean {
    if (!readAt) return true;

    const readAtMs = new Date(readAt).getTime();
    if (Number.isNaN(readAtMs)) return true;

    const now = deps.now?.() ?? Date.now();

    return now - readAtMs > STALENESS_THRESHOLD_MS;
}

/**
 * 从一批 catalog 里筛出**过期的**那些游戏, 返回游戏名。
 *
 * 三种情况都算过期: 从未抓到过 / 指纹与当前配置对不上 / 时间超阈值。
 *
 * ⚠️ 取 catalog 而非游戏名, 是因为指纹要现算: 调用方手里有的是配置, 缺的只是"这份数据
 * 还算不算数"的答案。
 *
 * ⚠️ 保持**传入顺序**输出: 抓取顺序是展示顺序的依据, 这里不重排。
 */
export function getStaleGames(
    catalogs: CatalogConfig[],
    deps: StalenessDeps = {},
): string[] {
    const getGame = deps.getGame ?? ((name: string) => DataStore.getInstance().getGame(name));

    return catalogs
        .filter((catalog) => {
            const record = getGame(catalog.name);

            // 配置改了 → 记录里那份按旧配置抓的数据不再是"现在要的那份", 与时间无关
            if (!record) return true;
            if (record.configFingerprint !== configFingerprintOf(catalog)) return true;

            return isStaleGame(record.readAt, deps);
        })
        .map((catalog) => catalog.name);
}
