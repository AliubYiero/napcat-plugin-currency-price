/**
 * 最新价格存储 —— `data.json`
 *
 * 见设计文档 §7.2。本文件记录"各游戏现在值多少"以及**最近一次抓取尝试**的结果。
 *
 * 三条必须遵守的规则（§7.2）:
 * 1. **游戏级原子性**——一个游戏内任一区服组合失败, 整个游戏本轮作废, 已成功读到的其他
 *    组合一并丢弃。由抓取层保证, 本层只负责"别把半截数据写进去"。
 * 2. **失败不覆盖**——本轮失败时 `zones` / `readAt` 保持上一次成功的内容, 只更新 `lastError`。
 * 3. **`price: null` 不可与任何数字归一**——`null` 是"本次没取到"(站点无报价 / 挂单过少失真 /
 *    名称对不上), JSON 天然区分; 本层不得把它归成 `0` 或别的占位。
 *
 * ⚠️ 新鲜度判定读的是**游戏级 `readAt`**（片 05）与 **`configFingerprint`**（片 05 补）,
 * 不是全局时间戳。本文件因此不含任何全局时间字段, 也不要往里加。
 */

import { pluginState } from '../core/state';
import type {
    CurrencyDetail,
    ListingItem,
} from '../services/scraper/detail';
import type { PriceItem } from '../services/scraper/parse';
import { readJsonSafe, writeJsonAtomic } from './atomic-json';

/** 数据文件名 */
export const DATA_FILENAME = 'data.json';

/**
 * 结构版本号。
 *
 * ⚠️ **升到 2 的原因不是"加了几个字段", 而是 `price` 的语义变了**（ADR-0006 / ADR-0007）:
 * - v1 里 `price` 是**元/个**方向; v2 起是**个/元**（比率方向）
 * - v1 里 `price: 0` 表示"本区服无报价"; v2 起 `0` 被删掉, `price` 只可能是正数或 `null`
 *
 * ⚠️ **单靠配置指纹挡住这次变更是不够的**, 这一点反直觉: 「失败不覆盖」会让一份**旧数据**
 * 在抓取失败时原样留下——于是升级后的第一条路径就可能是"指纹失配 → 判过期 → 重抓 → 失败
 * → 旧的、方向相反的 `zones` 原样留着 → 渲染层把它当新数据"。`0.2444` 会被读成「个/元」,
 * **差十几倍, 而且看起来完全正常**。指纹兜不住这条路径, 所以这里是硬性的:
 * **版本对不上就整份丢弃, 当作从未抓到过**。
 *
 * 代价是升级后首次抓取失败的游戏显示成"从未抓到"而不是旧价——这正是我们想要的:
 * 宁可没有, 不要错值。
 */
export const DATA_VERSION = 2;

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
    saveGameResult(
        gameName: string,
        result: GameResult,
        configFingerprint: string,
    ): void {
        const state = this.read();

        if ('error' in result) {
            const previous = state.games[gameName];

            // 从未成功抓到过的游戏: **不产生条目**。没有数据就是没有, 写一条只有错误的
            // 半截记录会让新鲜度判定读到"有记录但 readAt 是空的", 把简单的是非题变成特例。
            if (!previous) return;

            // ⚠️ **指纹保持不变**, 因为留下的数据也确实还是上一次成功时那份配置抓的。
            // 换成本轮(可能已经改过)的指纹, 就会把一份旧配置的数据标成"新鲜",
            // 正是本字段要防的那种错
            state.games[gameName] = {
                ...previous,
                lastError: result.error,
            };
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
            writeJsonAtomic(
                pluginState.getDataFilePath(DATA_FILENAME),
                state,
                2,
            );
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
 * ⚠️ **不得把 `price: null` 归一成任何数字**: 它表示"本次没取到", 与"真的报 0"完全不同义。
 * 归一化会把本插件特意修掉的静默歧义又引回来。这里只做形态校验, 不做值转换。
 *
 * ⚠️ **版本对不上时整份丢弃**（不是逐字段兼容）。理由见 `DATA_VERSION`: 这一次的语义变更
 * 是"`price` 换了方向", 而旧值在形态上与合法值无法区分——兼容它就是把一个错值当好值用。
 */
export function sanitizeDataState(raw: unknown): DataState {
    const out = emptyState();
    if (!isObject(raw) || !isObject(raw.games)) return out;

    // 旧版本的数据一律当"从未抓到过": 见 `DATA_VERSION` 的说明
    if (raw.version !== DATA_VERSION) return out;

    for (const [gameName, value] of Object.entries(raw.games)) {
        if (!isObject(value) || typeof value.readAt !== 'string')
            continue;

        out.games[gameName] = {
            readAt: value.readAt,
            zones: sanitizeZones(value.zones),
            missing: Array.isArray(value.missing)
                ? value.missing.filter(
                      (name): name is string =>
                          typeof name === 'string',
                  )
                : [],
            // 旧文件（该字段出现之前写下的）落成空串: 指纹与当前配置必然对不上 → 判过期
            // → 重抓一次。宁可多抓一轮, 不可把一份来历不明的数据当新的用
            configFingerprint:
                typeof value.configFingerprint === 'string'
                    ? value.configFingerprint
                    : '',
            lastError:
                typeof value.lastError === 'string'
                    ? value.lastError
                    : null,
        };
    }

    return out;
}

/** 清洗区服组合列表。结构不完整的组合整条丢弃——宁可少一个组合, 不可留半条 */
function sanitizeZones(raw: unknown): ZoneRecord[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((zone): ZoneRecord[] => {
        if (!isObject(zone)) return [];
        if (
            !Array.isArray(zone.zone) ||
            typeof zone.readAt !== 'string'
        )
            return [];

        return [
            {
                zone: zone.zone.filter(
                    (level): level is string =>
                        typeof level === 'string',
                ),
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
        if (!isObject(price) || typeof price.name !== 'string')
            return [];

        const item: PriceItem = {
            name: price.name,
            price:
                typeof price.price === 'number' &&
                Number.isFinite(price.price)
                    ? price.price
                    : null,
            unit: typeof price.unit === 'string' ? price.unit : null,
        };

        // 元方向**同进同出**: 缺一个就两个都不要。半个价格（有 `rmbPrice` 没 `rmbUnit`）
        // 比没有价格更容易被误读——消费方会以为单位是自己推出来的
        if (
            typeof price.rmbPrice === 'number' &&
            Number.isFinite(price.rmbPrice) &&
            typeof price.rmbUnit === 'string'
        ) {
            item.rmbPrice = price.rmbPrice;
            item.rmbUnit = price.rmbUnit;
        }

        if (price.thinMarket === true) item.thinMarket = true;

        // `detail` 的三种状态分开处理: **键在**才装配, `null` 也是合法值（"配了但没取到"）。
        // 用 `in` 而不是真值判断, 否则 `null` 与"没有这个键"会被归一
        if ('detail' in price)
            item.detail = sanitizeDetail(price.detail);

        return [item];
    });
}

/** 清洗详情块。`null` 是合法值（配了详情但这次没取到）, 原样保留 */
function sanitizeDetail(raw: unknown): CurrencyDetail | null {
    if (!isObject(raw)) return null;

    return {
        // 成交量原文。**空串是合法值**（详情取到了但这一个字段没读到）, 不回退成别的
        volume: typeof raw.volume === 'string' ? raw.volume : '',
        volumeValue:
            typeof raw.volumeValue === 'number' &&
            Number.isFinite(raw.volumeValue)
                ? raw.volumeValue
                : null,
        listings: sanitizeListings(raw.listings),
    };
}

/** 清洗挂单列表。**结构不完整的整条丢弃**——宁可少一条挂单, 不可留半条 */
function sanitizeListings(raw: unknown): ListingItem[] {
    if (!Array.isArray(raw)) return [];

    return raw.flatMap((listing): ListingItem[] => {
        if (!isObject(listing)) return [];
        if (
            typeof listing.stock !== 'number' ||
            !Number.isFinite(listing.stock)
        )
            return [];
        if (
            typeof listing.pricePerYuan !== 'number' ||
            !Number.isFinite(listing.pricePerYuan)
        ) {
            return [];
        }

        return [
            {
                stock: listing.stock,
                pricePerYuan: listing.pricePerYuan,
                ratioUnit:
                    typeof listing.ratioUnit === 'string'
                        ? listing.ratioUnit
                        : '',
            },
        ];
    });
}
