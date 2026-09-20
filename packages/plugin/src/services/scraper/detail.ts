/**
 * 挂单详情的纯函数层
 *
 * 与 `parse.ts` 同一条纪律: **无副作用、不碰 DOM 全局、不碰文件**, 只做
 * "给我一个接口响应 / 一段采集到的原始文本, 我告诉你数据是什么"。
 *
 * 为什么单开一个文件而不塞进 `parse.ts`: 详情的数据来源有**两个**——
 * 挂单的价格优先来自详情接口（全精度原始值）, 接口没等到时退回页面文本;
 * 而成交量与"当前面板是哪个通货"只有 DOM 有。两侧都要能独立单测,
 * 混进列表页那套选择器里会互相干扰。
 *
 * 浏览器侧的采集函数（`readListingEntries` / `readDetailPanel` / `DETAIL_SELECTORS`）
 * 仍在 `parse.ts`——`page.evaluate` 要的东西放一起, 免得两份采集各带一半选择器。
 */

import {
    parsePriceText,
    type PriceItem,
    type RawListingRow,
} from './parse';

// ==================== 数据形状 ====================

/** 一条挂单。**只有三个字段**——元方向由 `stock ÷ pricePerYuan` 在渲染时得出, 不另存 */
export interface ListingItem {
    /** 挂单可售量 */
    stock: number;
    /**
     * 比率价 = 1 元能买几个（接口 `ratioPrice`, **全精度原始值**）。
     *
     * ⚠️ **这是权威的挂单价格**, 且它**不是**「每个多少元」——方向与列表页的 `price` 一致,
     * 与元价相反。断言方向见 `parse.ts` 的 `RawListingRow.ratioSpans`。
     */
    pricePerYuan: number;
    /** 比率单位, 如 `个` / `火`。与「元」拼成 `个/元` */
    ratioUnit: string;
}

/** 一个通货的详情块 */
export interface CurrencyDetail {
    /**
     * 成交量**原文**（如 `518.3w` / `50`）。
     *
     * ⚠️ 真机上出现过的后缀只有 `w`, 另有一个**空串**形态（详情取到了但成交量没读到）。
     * 空串是合法值, 不是错误。
     */
    volume: string;
    /** 成交量解析值（`万`/`w`/`W` 按 ×10000）。**认不出的形态记 `null`, 原文照样保留** */
    volumeValue: number | null;
    /** 前 N 条挂单, **按页面顺序, 不重排**。仅含读得出价格的条目 */
    listings: ListingItem[];
}

// ==================== 详情接口响应 ====================

/**
 * 单条挂单在接口响应里用到的字段。
 *
 * ⚠️ 其余字段一律忽略——接口加字段不影响本模块。
 */
export interface ListingNode {
    /** 挂单可售量 */
    stock?: unknown;
    /** 比率价：1 元能买几个。**这是权威的挂单价格, 不取倒数** */
    ratioPrice?: unknown;
    /** 比率单位, 如 `个` */
    ratioUnit?: unknown;
    /** 元价（保留 4 位小数）。**只作为单位名的回退来源, 不参与数值计算** */
    rmbPrice?: unknown;
    rmbPriceUnit?: unknown;
    /** 该挂单适用的区服属性。`specValues[].id` 与级联接口的 specId 同源 */
    specValues?: unknown;
}

/** 详情接口响应的最小形状 */
export interface DetailResponse {
    data?: { items?: unknown; total?: unknown };
}

/** 有限正数判定。`NaN` / `Infinity` / `0` / 负数都算读不出来 */
function positiveNumber(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? raw
        : null;
}

/**
 * 从 `specValues` 里取出该挂单所属的区服标识（与级联接口的 specId 同一套编号）。
 *
 * ⚠️ **这个假设不够牢**: 那一层里除了区服还有「交易方式」等属性, 这里退到"第一个带 `id`
 * 的项"。抓取源项目也是这么做的, 并把它标为待收紧——真机跑通后若发现错位要回来改。
 * 单测里的 `specValues` 只有一项, **照不出这个假设的问题**。
 */
function specIdOf(item: ListingNode): string | null {
    const values = item.specValues;
    if (!Array.isArray(values)) return null;

    for (const value of values) {
        if (
            value &&
            typeof value === 'object' &&
            typeof (value as { id?: unknown }).id === 'string'
        ) {
            return (value as { id: string }).id;
        }
    }

    return null;
}

/** 比率单位。`ratioUnit` 缺省时退到 `rmbPriceUnit`（实测两者同值——它们都是「个」这种通货单位） */
function unitOf(item: ListingNode): string | null {
    if (typeof item.ratioUnit === 'string' && item.ratioUnit.trim())
        return item.ratioUnit.trim();
    if (
        typeof item.rmbPriceUnit === 'string' &&
        item.rmbPriceUnit.trim()
    ) {
        return item.rmbPriceUnit.trim();
    }

    return null;
}

/**
 * 把接口响应里的挂单转成 `ListingItem[]`。
 *
 * ⚠️ **价格只认 `ratioPrice`, 没有取倒数的回退。** `rmbPrice` 只有 4 位小数, 取倒数会算出
 * **页面上找不到的数**（`1 / 0.0063 = 158.73`, 而真值是 `160.006`）——这正是 ADR-0005
 * 结论 2 点名的那个动作。读不出价就整条丢弃: 一条没有价格的挂单在展示上只会是个空洞,
 * 而且会静默改变"前 N 条"是哪 N 条。
 *
 * ⚠️ **按响应顺序取前 N 条, 不重排**：重排会让"抓到的 top N"与用户看到的不是同一批。
 *
 * @param response 响应体
 * @param limit 取前 N 条
 * @param specId 只保留属于该区服的挂单; 缺省则不过滤
 */
export function readTopListings(
    response: DetailResponse,
    limit: number,
    specId?: string,
): ListingItem[] {
    const items = response?.data?.items;
    if (!Array.isArray(items)) return [];

    const out: ListingItem[] = [];

    for (const raw of items) {
        if (out.length >= limit) break;
        if (!raw || typeof raw !== 'object') continue;

        const item = raw as ListingNode;
        if (specId !== undefined && specIdOf(item) !== specId)
            continue;

        const ratioPrice = positiveNumber(item.ratioPrice);
        if (ratioPrice === null) continue;

        const stock =
            typeof item.stock === 'number' &&
            Number.isFinite(item.stock)
                ? item.stock
                : null;
        if (stock === null) continue;

        out.push({
            stock,
            pricePerYuan: ratioPrice,
            ratioUnit: unitOf(item) ?? '',
        });
    }

    return out;
}

/**
 * 解析 DOM 读到的挂单卡片（**接口响应没等到时的兜底路径**）。
 *
 * ⚠️ 挂单卡价格区的**第一行**是 `1 元 = <值> <通货>`——**这个数本身就是比率方向**,
 * 原样取用即可。抓取源项目曾在这里按"页面显示元价、我们要比率价"取过一次倒数, 后果是
 * **同一份产物里方向混着**: 走接口的通货写 `52.6537`（真的个/元）, 走 DOM 的写 `0.118`
 * （其实是 `8.4746` 的倒数）。两者单看都像正常价格, 只在与同区服市价对照时才暴露。
 *
 * ⚠️ 页面只显示 4 位小数, 所以这个值是**兜底近似值**; 接口到达时会换成全精度的
 * `ratioPrice`（`enrichListingsFromResponse`）。
 *
 * @returns 解析成功的挂单。**任何一行解析不出来就整条丢弃**——理由同 `readTopListings`
 */
export function parseListingRows(
    rows: RawListingRow[],
    limit: number,
): ListingItem[] {
    const out: ListingItem[] = [];

    for (const row of rows) {
        if (out.length >= limit) break;

        const ratioText = row.ratioSpans[PRICE_VALUE_INDEX];
        if (ratioText === undefined) continue;

        const ratioPrice = parsePriceText(ratioText);
        if (ratioPrice === null || ratioPrice <= 0) continue;

        const stock = parseStock(row.nums);
        if (stock === null) continue;

        out.push({
            stock,
            pricePerYuan: ratioPrice,
            ratioUnit: row.ratioSpans[PRICE_QUOTE_UNIT_INDEX] ?? '',
        });
    }

    return out;
}

/**
 * 挂单卡价格区的 span 布局：`1 元 = <价格> <计价单位>`，如 `1 元 = 8.4746 个`。
 *
 * ⚠️ 这几个下标是绑在**这个方向**上的。列表页的价格区也有同样的一行, 但那一行是
 * `1 <通货> = <值> 元`, 两者读法相反——**不要把那套语义搬到这儿来**（`parse.ts` 的
 * `readCurrencyList` 用 `spans[1] === '元'` 分辨它们）。
 */
const PRICE_VALUE_INDEX = 3;
const PRICE_QUOTE_UNIT_INDEX = 4;

/**
 * 从卡片数字里认出库存量。
 *
 * ⚠️ 认法是「**第一个不带小数点的非负整数**」, 而不是"第 1 个数字": 实测形态是
 * `库存 <整数>`、`起售 <整数>`、`1 元 = <小数> 个`，价格带小数而两个数量都不带。
 * 这个判据的依据是数字形态本身, 比"按位置取第 1 个"更抗结构变动——价格区若被移到
 * 数量之前, 按位置会取到价格。
 *
 * 起售价与库存量同为整数, 因此仍按出现顺序取先出现的那个（实测库存在前）。
 */
function parseStock(nums: string[]): number | null {
    for (const raw of nums) {
        const text = raw.trim();
        if (!/^\d+$/.test(text)) continue;

        const value = Number(text);
        if (!Number.isSafeInteger(value)) continue;

        return value;
    }

    return null;
}

// ==================== 市价失真（挂单深度） ====================

/**
 * 一个通货在某区服**至少要有多少条挂单**, 它的市价才算数。
 *
 * 少于这个数就没有统一的价格市场：价格接口给的 `ratioPrice` 是那一小撮挂单的汇总,
 * 汇总出来的数字不是"市场价格", 只是"恰好有那几个人在挂单"。**这类价格比没有价格更糟——
 * 它看起来完全合理。** 因此本项目把「挂单过少」判为**失真, 等同于没有数据**。
 *
 * ⚠️ 判据是**严格小于**: 恰好 15 条算够。
 * ⚠️ 这个数只来自抓取源项目的实测（流放之路 2 / 1）, 插件侧的三个游戏未各自验证——
 * 所以判定结果必须打进日志, 否则阈值不合适时无从发现。
 */
export const MIN_MARKET_LISTINGS = 15;

/**
 * 接口给的挂单总数（`data.total`）。
 *
 * @returns 有限正数时返回它; 字段缺失、非数、为 0 时返回 `null`（= 接口没给可用总数）
 */
export function readResponseTotal(
    response: DetailResponse,
): number | null {
    const total = response?.data?.total;

    return typeof total === 'number' &&
        Number.isFinite(total) &&
        total > 0
        ? total
        : null;
}

/**
 * 数出该通货在该区服的挂单条数。
 *
 * 取 `data.total`（该区服的挂单总数）优先, 缺失或非法时退到 `data.items.length`
 * ——**两者不等时以 `total` 为准**: `items` 可能是分页的一页, `total` 才是全量。
 *
 * ⚠️ **产物里的 `listings` 是被截断的（最多 5 条）, 不能拿来当深度**——深度只从响应里数。
 *
 * @returns 条数; **响应里两个都读不出时返回 `null`**——那是「无法判定」, 不是 0 条。
 *   调用方必须把这两件事分开: 0 条是确定的薄市场, `null` 只是没证据。
 */
export function readListingCount(
    response: DetailResponse,
): number | null {
    const total = readResponseTotal(response);
    if (total !== null) return total;

    const items = response?.data?.items;
    if (Array.isArray(items)) return items.length;

    return null;
}

/**
 * 这个响应里的挂单是否少到「市价失真」。
 *
 * @returns `true` = 挂单过少, 该通货本次的价格不可信; `false` = 够深;
 *   `null` = 数不出条数（响应没到 / 结构变了）, **不判定**
 */
export function isThinMarket(
    response: DetailResponse,
): boolean | null {
    const count = readListingCount(response);
    if (count === null) return null;

    return count < MIN_MARKET_LISTINGS;
}

// ==================== 装配 ====================

/**
 * 拼出一个通货的详情块。
 *
 * @param volumeText 成交量原文（只有 DOM 有）
 * @param listings 挂单
 */
export function buildCurrencyDetail(
    volumeText: string,
    listings: ListingItem[],
): CurrencyDetail {
    return {
        volume: volumeText.trim(),
        volumeValue: parseVolumeText(volumeText),
        listings,
    };
}

/** 成交量后缀 → 倍率。真机上出现过的只有 `w`; `万`/`W` 是站点换写法的免费保险 */
const VOLUME_SUFFIX: Record<string, number> = {
    万: 1e4,
    w: 1e4,
    W: 1e4,
};

/**
 * 解析成交量原文。
 *
 * ⚠️ 真机实测的后缀**只有 `w`**, 且存在**空串**形态（详情取到了但成交量没读到）。
 * 认不出的形态记 `null`, **原文照样保留**——宁可少一条数据, 不可多一条错数据。
 */
export function parseVolumeText(raw: string): number | null {
    const text = raw.trim();
    if (!text) return null;

    const last = text.slice(-1);
    const hasSuffix = Object.prototype.hasOwnProperty.call(
        VOLUME_SUFFIX,
        last,
    );
    const numberText = hasSuffix ? text.slice(0, -1).trim() : text;

    // 去掉末尾的零再比对: `1.2000` ≡ `1.2`。纯字符串操作, 不走 Number, 避免精度丢失
    const normalized = numberText.includes('.')
        ? numberText.replace(/0+$/, '').replace(/\.$/, '')
        : numberText;

    // 只认纯十进制字面量（与 `parsePriceText` 的 DECIMAL_PATTERN 同款）:
    // 不含符号、指数、千分位
    if (!/^\d+(\.\d*)?$/.test(normalized)) return null;

    const base = Number(normalized);
    if (!Number.isFinite(base)) return null;

    const value = hasSuffix
        ? base * (VOLUME_SUFFIX[last] as number)
        : base;

    // 精度守卫**只在本该是整数的输入上生效**: 超长整数会被 Number 静默截断
    // (`9007199254740993` → `...992`), 那种读数是错的。
    // ⚠️ 不能无条件用 `Number.isSafeInteger`——它对 `1.2` 返回 false, 会把"没有后缀的
    // 小数成交量"整类读成 null（实测踩过）
    const exact = !normalized.includes('.');
    if (exact && !Number.isSafeInteger(value)) return null;

    return value;
}

/**
 * 把详情装配到价格项上, 并施加**市价失真**的降级。
 *
 * 这是"失真"唯一的落地点, 所以规则集中在这里:
 *
 * - **失真 ⇒ 价格归零、详情保留**：`price` / `unit` 置 `null`, **元方向的两个键一起撤掉**
 *   （它们是同一个失真价格的反向, 留着会变成"没有价, 但每个 0.1267 元"）, `detail` 保留
 *   ——失真的是"市场价"这个汇总, 单条挂单的价格仍是事实。
 * - **数不出条数（`thin === null`）不判定**：不因缺少证据删数据。
 * - **只降级本来有价的条目**：本来就没价的保持原状, 不抹掉它携带的信号。
 *
 * @param base 已装配好的价格项（有价, 或本来就无价）
 * @param detail 详情块; `null` = 配了详情但没取到
 * @param thin 失真判定; `null` = 数不出条数
 */
export function attachDetail(
    base: PriceItem,
    detail: CurrencyDetail | null,
    thin: boolean | null,
): PriceItem {
    if (thin === true && base.price !== null) {
        // 显式重建而不是 `delete`: 让"失真时有哪些键"在这一处一眼看全
        return {
            name: base.name,
            price: null,
            unit: null,
            thinMarket: true,
            detail,
        };
    }

    return { ...base, detail };
}
