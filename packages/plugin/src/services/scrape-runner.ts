/**
 * 抓取运行编排 —— 调度器与手动抓取共用的「抓取 → 落盘 → 归档」一段
 *
 * 见设计文档 §12.1 §12.2。两条触发路径在这段动作上完全一致, 差别只在:
 * - `trigger` 的取值（`"schedule"` / `"manual:{会话键}"`）
 * - 抓哪些游戏（调度器抓订阅并集里过期的, 手动抓本会话订阅里过期的）
 * - 推送（片 09, 只属于调度器, 插在释放锁之前——由调用方自己做）
 *
 * 本模块**不管锁、不管新鲜度**: 抢锁与"轮到自己时重算过期集合"是调用方的编排,
 * 这里只负责一轮抓取的落定动作。
 */

import type { CatalogConfig } from '../types';
import { ArchiveStore } from '../store/archive.store';
import { DataStore, type GameResult } from '../store/data.store';
import { ensureBrowserStatus } from './browser/status';
import { scrapeGames } from './scraper';
import { configFingerprintOf } from './staleness';

/** 一轮抓取的结果 */
export interface ScrapeRoundResult {
    /** 与 `scrapeGames` 返回值同构 */
    results: Record<string, GameResult>;
    /** 本轮成功的游戏数。`0` = 没写归档 */
    successCount: number;
}

/** `runScrapeRound` 的注入点。生产代码用缺省值, 测试注入假抓取器 */
export interface ScrapeRoundDeps {
    /** 抓取入口。缺省走真实浏览器抓取 */
    scrape?: typeof scrapeGames;
}

/**
 * 一轮结果里**失败**的游戏名。
 *
 * 成败判定只看 `error` 字段的有无——与 `GameResult` 的定义一致, 不另设成功标志。
 * 推送层用它决定哪些游戏要加「（数据未更新）」（片 09）, 归档用它数成功率。
 */
export function failedGamesOf(results: Record<string, GameResult>): Set<string> {
    return new Set(
        Object.entries(results)
            .filter(([, result]) => 'error' in result)
            .map(([gameName]) => gameName),
    );
}

/**
 * 跑一轮抓取并落定:
 *
 * 1. `scrapeGames(这几个游戏)` —— 单个游戏的失败被隔离在它自己身上
 * 2. 逐个写 `data.json` —— 成功的覆盖（含 `readAt` / `missing` / `lastError=null`）,
 *    失败的只写 `lastError`, 数据保持上一次成功的（§7.2 规则 2）
 * 3. **至少一个游戏成功**才写归档一条 run + 顺带做归档维护（§7.3 §12.4）——
 *    全是 `error` 的 run 对渲染与回溯都没有价值
 */
export async function runScrapeRound(
    catalogs: CatalogConfig[],
    trigger: string,
    deps: ScrapeRoundDeps = {},
): Promise<ScrapeRoundResult> {
    if (catalogs.length === 0) return { results: {}, successCount: 0 };

    const scrape = deps.scrape ?? scrapeGames;
    const startedAt = new Date().toISOString();

    const results = await scrape(catalogs, {
        executablePath: ensureBrowserStatus().path ?? '',
    });

    const finishedAt = new Date().toISOString();

    // 本轮**实际用的**配置指纹, 逐个游戏存下——下次判新鲜度时拿它与当时的配置比对。
    // 取不到时落空串: 那份记录会一直判过期, 偏"多抓", 是安全的一侧
    const fingerprints = new Map(catalogs.map((catalog) => [catalog.name, configFingerprintOf(catalog)]));

    const store = DataStore.getInstance();
    for (const [gameName, result] of Object.entries(results)) {
        store.saveGameResult(gameName, result, fingerprints.get(gameName) ?? '');
    }

    const successCount = Object.keys(results).length - failedGamesOf(results).size;

    if (successCount > 0) {
        const archive = ArchiveStore.getInstance();
        archive.recordRun({ startedAt, finishedAt, trigger, games: results });
        await archive.runMaintenance();
    }

    return { results, successCount };
}
