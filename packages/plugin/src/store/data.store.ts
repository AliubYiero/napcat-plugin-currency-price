/**
 * 最新价格存储 —— `data.json`
 *
 * 见设计文档 §7.2。本文件记录"各游戏现在值多少"以及**最近一次抓取尝试**的结果。
 *
 * 三条必须遵守的规则（§7.2）:
 * 1. **游戏级原子性**——一个游戏内任一区服组合失败, 整个游戏本轮作废, 已成功读到的其他
 *    组合一并丢弃。由抓取层保证, 本层只负责"别把半截数据写进去"。
 * 2. **失败不覆盖**——本轮失败时 `zones` / `readAt` 保持上一次成功的内容, 只更新 `lastError`。
 * 3. **`price: null` 与 `price: 0` 不同义**——JSON 天然区分, 本层不得把 `null` 归一成 `0`。
 *
 * ⚠️ 新鲜度判定读的是**游戏级 `readAt`**（片 05）与 **`configFingerprint`**（片 05 补）,
 * 不是全局时间戳。本文件因此不含任何全局时间字段, 也不要往里加。
 */

import { pluginState } from '../core/state';
import type { PriceItem } from '../services/scraper/parse';
import { readJsonSafe, writeJsonAtomic } from './atomic-json';

/** 数据文件名 */
export const DATA_FILENAME = 'data.json';

/** 结构版本号。将来字段语义变更时用它区分旧文件 */
export const DATA_VERSION = 1;

/** 一个区服组合的价格记录 */
export interface ZoneRecord {
    /** 区服路径, 层数随游戏而变（如 `['赛季', '普通']`） */
    zone: string[];
    /** 该组合自己的读取时刻 (ISO 8601 UTC) */
    readAt: string;
    prices: PriceItem[];
}

/** 一次成功的抓取结果 —— 与 `scrapeGames` 的返回值同构, 调用方零转换 */
export interface GameOk {
    /** 游戏级读取时刻 = 各组合 `readAt` 的最大值。**新鲜度判定的依据** */
    readAt: string;
    zones: ZoneRecord[];
    /** **所有区服组合都找不到**的通货名（各组合 `missing` 的交集） */
    missing: string[];
}

/** 一次失败的抓取结果。**`error` 字段的有无即成败判定**, 不另设成功标志 */
export interface GameFail {
    error: string;
}

export type GameResult = GameOk | GameFail;

/** `data.json` 里一个游戏的完整记录: 上一次成功的数据 + 最近一次尝试的失败原因 */
export interface GameRecord extends GameOk {
    /**
     * 抓到这份数据时, 该游戏的**配置指纹**（由 `services/staleness` 计算）。
     *
     * `zones` 是**按当时那份配置**抓下来的死数据——组合名、有哪些组合、抓哪些通货都
     * 固化在里面。配置改了, `readAt` 再新也说明不了"这份数据就是现在要的那份", 所以
     * 指纹与当前配置对不上时, 这份记录判为**过期**(见 design.md §9.2)。
     *
     * 旧文件没有该字段 → 清洗层落成空串 → 与任何真实配置都不符 → 重抓一次。
     * 这是刻意的"宁可多抓"。
     */
    configFingerprint: string;
    /** **最近一次抓取尝试**的失败原因; 成功时为 `null`。数据本身仍是上一次成功的 */
    lastError: string | null;
}

export interface DataState {
    version: number;
    games: Record<string, GameRecord>;
}

/** 空结构。文件缺失或损坏时都是它——所有游戏因此判为过期, 触发全量重抓 */
function emptyState(): DataState {
    return { version: DATA_VERSION, games: {} };
}

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * `data.json` 存储 (单例)
 *
 * 延迟实例化: 类本身在 import 时不触碰 `ctx` / 文件 IO, 由使用方在**方法内部**取实例。
 */
export class DataStore {
    private static instance: DataStore | null = null;

    private constructor() {
        /* 构造期零 IO —— 见 docs/store-pattern.md 的"为什么不能在模块加载期读数据" */
    }

    /** 单例入口。**不要**在模块加载期调用 */
    static getInstance(): DataStore {
        if (!DataStore.instance) {
            DataStore.instance = new DataStore();
        }

        return DataStore.instance;
    }

    /** 全部游戏的最新数据（指令展示、WebUI 用） */
    getGames(): Record<string, GameRecord> {
        return this.read().games;
    }

    /** 单个游戏的最新数据; 从未成功抓到过时返回 `null`（调用方据此判为过期） */
    getGame(gameName: string): GameRecord | null {
        return this.read().games[gameName] ?? null;
    }

    /**
     * 落盘一个游戏的抓取结果。
     *
     * 成功与失败走同一个入口, 因为调用方拿到的是 `Record<string, GameOk | GameFail>`,
     * 分派依据就是 `error` 字段的有无（见设计文档 §8.1）。
     *
     * @param configFingerprint 本轮抓取**所用配置**的指纹（见 `services/staleness`）。
     *        由调用方算好传入: 本层不认识 `CatalogConfig`, 也不该认识。
     */
    saveGameResult(gameName: string, result: GameResult, configFingerprint: string): void {
        const state = this.read();

        if ('error' in result) {
            const previous = state.games[gameName];

            // 从未成功抓到过的游戏: **不产生条目**。没有数据就是没有, 写一条只有错误的
            // 半截记录会让新鲜度判定读到"有记录但 readAt 是空的", 把简单的是非题变成特例。
            if (!previous) return;

            // ⚠️ **指纹保持不变**, 因为留下的数据也确实还是上一次成功时那份配置抓的。
            // 换成本轮(可能已经改过)的指纹, 就会把一份旧配置的数据标成"新鲜",
            // 正是本字段要防的那种错
            state.games[gameName] = { ...previous, lastError: result.error };
            this.write(state);

            return;
        }

        state.games[gameName] = {
            readAt: result.readAt,
            zones: result.zones,
            missing: result.missing,
            configFingerprint,
            lastError: null,
        };

        this.write(state);
    }

    /** 现读。损坏时 `readJsonSafe` 已把坏文件备份走 */
    private read(): DataState {
        const { data, corrupted } = readJsonSafe(
            pluginState.getDataFilePath(DATA_FILENAME),
            emptyState(),
        );

        if (corrupted) {
            // 备份 + 初始化为空 → **所有游戏判为过期 → 全量重抓**（设计文档 §14）。
            // 不阻塞启动: 调用方拿到的永远是可用的空表
            pluginState.logger.warn(
                '价格数据文件损坏, 已备份为 *.bak 并初始化为空（所有游戏将重新抓取）',
            );
            this.write(emptyState());

            return emptyState();
        }

        return sanitizeDataState(data);
    }

    /** 立即落盘（原子写）。写失败只记日志, 不影响正在处理的这条消息 */
    private write(state: DataState): void {
        try {
            writeJsonAtomic(pluginState.getDataFilePath(DATA_FILENAME), state, 2);
        } catch (error) {
            pluginState.logger.error('保存价格数据失败:', error);
        }
    }
}

/**
 * 清洗从磁盘读到的数据
 *
 * 与配置清洗同理（见 docs/config-pattern.md）: 外部输入一律先清洗再进内存。
 * 单个游戏不合法只丢弃该游戏, 其余保留——一处手改坏了不该让所有游戏的数据一起消失。
 *
 * ⚠️ **不得把 `price: null` 归一成 `0`**: 两者语义相反（"未取到" vs "页面确实报 0"）,
 * 归一化会把本插件特意修掉的静默歧义又引回来。这里只做形态校验, 不做值转换。
 */
export function sanitizeDataState(raw: unknown): DataState {
    const out = emptyState();
    if (!isObject(raw) || !isObject(raw.games)) return out;

    for (const [gameName, value] of Object.entries(raw.games)) {
        if (!isObject(value) || typeof value.readAt !== 'string') continue;

        out.games[gameName] = {
            readAt: value.readAt,
            zones: sanitizeZones(value.zones),
            missing: Array.isArray(value.missing)
                ? value.missing.filter((name): name is string => typeof name === 'string')
                : [],
            // 旧文件（该字段出现之前写下的）落成空串: 指纹与当前配置必然对不上 → 判过期
            // → 重抓一次。宁可多抓一轮, 不可把一份来历不明的数据当新的用
            configFingerprint:
                typeof value.configFingerprint === 'string' ? value.configFingerprint : '',
            lastError: typeof value.lastError === 'string' ? value.lastError : null,
        };
    }

    return out;
}

/** 清洗区服组合列表。结构不完整的组合整条丢弃——宁可少一个组合, 不可留半条 */
function sanitizeZones(raw: unknown): ZoneRecord[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((zone): ZoneRecord[] => {
        if (!isObject(zone)) return [];
        if (!Array.isArray(zone.zone) || typeof zone.readAt !== 'string') return [];

        return [
            {
                zone: zone.zone.filter((level): level is string => typeof level === 'string'),
                readAt: zone.readAt,
                prices: sanitizePrices(zone.prices),
            },
        ];
    });
}

/** 清洗价格项。`price` 为数字或 `null`, **两者都保留原样** */
function sanitizePrices(raw: unknown): PriceItem[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((price): PriceItem[] => {
        if (!isObject(price) || typeof price.name !== 'string') return [];

        return [
            {
                name: price.name,
                price: typeof price.price === 'number' && Number.isFinite(price.price)
                    ? price.price
                    : null,
                unit: typeof price.unit === 'string' ? price.unit : null,
            },
        ];
    });
}
