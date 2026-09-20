/**
 * 价格消息渲染
 *
 * 见设计文档 §10.2（消息模板）与 §12.3。**`price` 展示与定时推送共用本渲染器**——
 * 两处各写一份模板, 迟早会在改文案时漏掉一处, 表现是同一条数据在两个场景里长得不一样。
 *
 * ⚠️ 本模块是**纯函数**: 给数据、出文本, 不读全局状态、不发消息。
 */

import type { GameRecord } from '../store/data.store';
import type { ListingItem } from './scraper/detail';
import type { PriceItem } from './scraper/parse';
import { formatLocalTime } from '../utils/time';

/** 区服组合标题: `【国服 / 赛季 / 普通】`。**层数随配置自适应**, 不假设固定几级 */
function zoneTitle(zone: string[]): string {
    return `【${zone.join(' / ')}】`;
}

/** `renderGame` 的调用方上下文。**不是数据的一部分**——同一份数据两种处境下长得不同 */
export interface RenderOptions {
    /**
     * 本轮抓取失败、渲染的是 `data.json` 里的**旧值**。
     *
     * ⚠️ 与「因新鲜而跳过」**不是一回事**（§10.2）: 后者渲染的数据是 5 分钟内的新数据,
     * 加标记反而误导。只有调用方知道本轮到底抓没抓到, 所以由调用方传入。
     */
    notUpdated?: boolean;
}

/**
 * 渲染一个游戏的价格块。
 *
 * 规则（§10.2 与 ADR-0005 / ADR-0007）:
 * - 头部时间用**游戏级 `readAt`** 并转本地时区。区服级 `readAt` 留在数据文件里——
 *   同一轮内各区服只差几秒, 显示出来是噪音。
 * - **过滤掉 `price` 为 `null` 的行**, 在组合末尾交代数量。
 * - **两种"没价"分开交代**（ADR-0007 结论 6）: 「未取到价格」与「挂单过少、价格失真」
 *   是两件事（前者无解, 后者是"这个区服没人交易"）, 并成一句会让用户无从应对。
 * - 一个区服**只有一条数据时不编号**, 用 ` · ` 打头（与 `1. ` 等宽）——只有一个候选时
 *   数字序号不提供任何信息, 只是噪音。**逐区服判定**, 同一游戏里可以有的编号有的不编号。
 * - 整块都没取到时**仍显示标题**, 否则用户会以为这个区服没在抓。
 * - `missing`（配置的通货名在站点上不存在）**单独成行**: 被过滤掉的行在消息里看不见,
 *   这是配置写错时用户唯一的可见信号。
 */
export function renderGame(
    gameName: string,
    record: GameRecord,
    options: RenderOptions = {},
): string {
    const marker = options.notUpdated ? '（数据未更新）' : '';
    const lines = [
        `「${gameName}」${formatLocalTime(record.readAt)} 实时千岛通货价格${marker}`,
    ];

    for (const zone of record.zones) {
        lines.push('', zoneTitle(zone.zone));

        const priced = zone.prices.filter(
            (price) => price.price !== null,
        );

        priced.forEach((price, index) => {
            lines.push(
                (priced.length > 1 ? `${index + 1}. ` : ' · ') +
                    priceLine(price),
            );
            lines.push(...listingLines(price));
        });

        // ⚠️ 失真的条目价格也是 `null`, 但它**不是"未取到"**——先把它从那一档里减出去,
        // 否则用户看到的是"N 项未取到价格", 而真相是"那几项挂单太少, 价不算数"
        const distorted = zone.prices.filter(
            (price) => price.thinMarket === true,
        ).length;
        const unpriced =
            zone.prices.length - priced.length - distorted;

        if (unpriced > 0) lines.push(`（${unpriced} 项未取到价格）`);
        if (distorted > 0)
            lines.push(`（${distorted} 项挂单过少，价格失真）`);
    }

    if (record.missing.length > 0) {
        lines.push(
            '',
            `（另有 ${record.missing.length} 项配置的通货名在站点上不存在）`,
        );
    }

    return lines.join('\n');
}

/**
 * 一行价格: `「神圣石」 8.417 个/元 (0.1188 元/个) · 成交量 522.8w/天`。
 *
 * ⚠️ **通货名带 `「」`**, 与头部的游戏名同一种写法——两者都是"某物的名字", 在一个消息里
 * 用两种写法会让人以为它们不是一类东西。
 *
 * ⚠️ **主方向（`个/元`）在前, 元方向在括号里**。同一个消息里只有**一个**方向规则——
 * 挂单块也是主方向在前（见 `listingLines`）, 两处可以对照着读。
 *
 * ⚠️ 元方向是**独立字段**, 不是 `1 / price` 算出来的（ADR-0005 结论 2）; 读不到时
 * 整个括号省略, 不补位、不换算。
 * ⚠️ 成交量**只在详情块存在且原文非空时**显示——空串是合法值（详情取到了但这个字段
 * 没读到）, 那时候该整截省略, 而不是显示"成交量 "。
 */
function priceLine(price: PriceItem): string {
    const unit = price.unit ? ` ${price.unit}` : '';
    let line = `「${price.name}」 ${trim(price.price)}${unit}`;

    if (price.rmbPrice !== undefined && price.rmbUnit) {
        line += ` (${trim(price.rmbPrice)} ${price.rmbUnit})`;
    }

    const volume = price.detail?.volume;
    if (volume) line += ` · 成交量 ${volume}/天`;

    return line;
}

/**
 * 挂单块。
 *
 * 形状（与主方向一致, 见 `priceLine`——括号里那一项是同一件事）:
 *
 * ```
 *    前5个挂单：
 *     (1) 2000 个 = 251.00 元 (7.9681 个/元)
 *     (2) 300   个 = 37.65   元 (7.9681 个/元)
 * ```
 *
 * 即「**这一单**有多少个 = 买下它要多少元（1 元能买几个）」。挂单块与价格行因此读法相同:
 * 主方向（`个/元`）在括号里, 元方向的结论在等号右边。
 *
 * ⚠️ **不写算式**。改造前是 `库存 ÷ 比率价 = 总价`, 那个形状把"除法"摆到了台面上;
 * 而这一行真正要回答的是"这一单多少钱、单价多少", 不是"这两个数怎么算出来的"。
 *
 * ⚠️ **三列各自按本块最长的那个数**补空格对齐**（见 `columnPad`）**。一列数字长短不齐时
 * 眼睛没法竖着扫——而挂单块存在的意义恰恰是"扫一眼看盘口"。**逐块算**, 不同通货的挂单
 * 各排各的: 跨通货对齐要用到别的通货的数字宽度, 那和这一块自己的可读性无关。
 *
 * ⚠️ **标题写实际条数, 不写上限**。`detailTopN = 5` 是**上限**不是承诺——冷门通货只挂
 * 3 条很常见, 写死"前5个"再列 3 行会让用户以为抓漏了 2 条, 而"抓漏"与"本来就只有 3 条"
 * 在显示上无从分辨。
 *
 * ⚠️ **0 条时不显示这一块**（整截省略）, 而不是显示一个"前0个挂单："的空壳。
 *
 * ⚠️ **编号只表示数组顺序, 不承诺任何含义**。站点并不保证挂单按价格排序（真机产物里
 * 既有升序块也有降序块）, 所以这里不写"最低价""最优"之类的标注——那会是一个看起来
 * 可信、实际无依据的断言。
 *
 * ⚠️ 总价是**展示口径**: `库存 ÷ 比率价`, 拿屏幕上那两个数就能验算。需要精确口径时读
 * 产物里的 `listings[].pricePerYuan`。
 */
function listingLines(price: PriceItem): string[] {
    const listings = price.detail?.listings ?? [];
    if (listings.length === 0) return [];

    const stocks = listings.map((listing) => String(listing.stock));
    const totals = listings.map((listing) => totalOf(listing).toFixed(2));
    const rates = listings.map((listing) => trim(listing.pricePerYuan));

    const lines = [`   前${listings.length}个挂单：`];

    listings.forEach((listing, index) => {
        lines.push(
            `    (${index + 1}) ` +
                listingLine(listing, {
                    stock: stocks,
                    total: totals,
                    rate: rates,
                    index,
                }),
        );
    });

    return lines;
}

/** 对齐要用的三列文本与当前行号。**整块一起传**, 因为宽度是逐块算出来的 */
interface ListingColumns {
    stock: string[];
    total: string[];
    rate: string[];
    index: number;
}

/**
 * 一条挂单: `2000 个 = 251.00 元 (7.9681 个/元)`。
 *
 * 单位缺失时整段省略, 不留下孤零零的 `/元` 或一个没有量纲的裸数。
 */
function listingLine(listing: ListingItem, columns: ListingColumns): string {
    const unit = listing.ratioUnit;
    const stock = columnPad(columns.stock, columns.index);
    const total = columnPad(columns.total, columns.index);
    const rate = columnPad(columns.rate, columns.index);

    const count = unit ? `${stock} ${unit}` : stock.trimEnd();
    const unitRate = unit ? `${rate} ${unit}/元` : rate.trimEnd();

    return `${count} = ${total} 元 (${unitRate})`;
}

/**
 * 把一列里的某一行补齐到本列最宽的那个数。
 *
 * 最终看到的空格数是 **`1 + 2 × (本列最长字符数 − 本行字符数)`**: 分隔符那一个空格由
 * 调用处的模板给, 本函数只补"每短一个字符再补两个"的那部分。所以这里返回的字符串
 * **末尾带补出来的空格**（可能为空）。按**字符数**算, 不按数字位数——`7.94` 与 `7.9681`
 * 差两个字符, 合计补 5 个空格。
 *
 * ⚠️ 这是**纯显示口径**, 只对挂单块这三列生效: 价格行的数字不参与（那一行是"这个通货
 * 什么价", 不是一张要竖着扫的表）。
 *
 * ⚠️ 按字符数补在一个**比例字体**里并不能真正对齐（中英混排更是如此）。它换来的是
 * "短的那个数字后面空得更开", 眼睛更容易分段——这是可读性上的取舍, 不是排版精确性。
 */
function columnPad(column: string[], index: number): string {
    const value = column[index] ?? '';
    const widest = column.reduce(
        (max, text) => Math.max(max, text.length),
        0,
    );

    return value + ' '.repeat(2 * (widest - value.length));
}

/** 一条挂单的总价 = `库存 ÷ 比率价`（比率价是「1 元能买几个」） */
function totalOf(listing: ListingItem): number {
    return listing.stock / listing.pricePerYuan;
}

/**
 * 显示用的数字: 四舍五入到 4 位小数, **不补零**（`8.3333` / `91` / `1.7` 都保持原样）。
 *
 * 上限取 4 位是因为元方向只有 4 位小数, 主方向也就没有必要显示更多——而要显示得更多
 * 就得让两个方向看起来精度不同, 那反而是噪音。
 */
function trim(value: number | null): string {
    if (value === null) return '--';

    return String(Math.round(value * 10_000) / 10_000);
}
