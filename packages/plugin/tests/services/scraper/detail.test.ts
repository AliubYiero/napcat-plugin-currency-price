/**
 * `scraper/detail.ts` 纯函数 —— 挂单、成交量、挂单深度（市价失真）
 *
 * 这个文件的价值集中在两件事上:
 *
 * 1. **方向**: 挂单卡第一行是 `1 元 = <值> 个`，**那个数本身就是比率价**。抓取源项目
 *    曾在这里按"页面显示元价、我们要比率价"取了一次倒数，后果是同一份产物里同一个字段名
 *    两个方向（`52.6537` 与 `0.118` 并存），两者单看都像正常价格。所以这里逐条钉死
 *    "不取倒数"，以及"没有取倒数的回退路径"。
 * 2. **市价失真的两个边界**: "数不出条数"与"0 条"是两件事；"本来没价"的条目不该被降级。
 */

import { describe, expect, it } from 'vitest';
import {
    MIN_MARKET_LISTINGS,
    attachDetail,
    buildCurrencyDetail,
    isThinMarket,
    parseListingRows,
    parseVolumeText,
    readListingCount,
    readResponseTotal,
    readTopListings,
    type DetailResponse,
} from '../../../src/services/scraper/detail';
import type {
    PriceItem,
    RawListingRow,
} from '../../../src/services/scraper/parse';

const SPEC_ID = '3794868';

/** 造一个接口挂单节点。字段名照抄实测响应 */
function node(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        stock: 600,
        ratioPrice: 8.3333,
        ratioUnit: '个',
        specValues: [{ id: SPEC_ID }],
        ...overrides,
    };
}

/** 造一个响应 */
function respond(items: unknown[], total?: unknown): DetailResponse {
    return {
        data: { items, ...(total === undefined ? {} : { total }) },
    };
}

/** 造一行 DOM 读到的挂单卡片 */
function card(
    nums: string[],
    ratioSpans: string[],
    rmbSpans: string[] = [],
): RawListingRow {
    return { nums, ratioSpans, rmbSpans };
}

// ==================== 成交量 ====================

describe('parseVolumeText — 成交量原文', () => {
    it('真机形态 `w` 按 ×10000 解析', () => {
        expect(parseVolumeText('518.3w')).toBe(5183000);
        expect(parseVolumeText('2w')).toBe(20000);
        expect(parseVolumeText('4542.8w')).toBe(45428000);
    });

    it('没有后缀的整数就是它本身', () => {
        expect(parseVolumeText('50')).toBe(50);
    });

    it('`万` / `W` 也认——真机上没出现过, 但站点换写法时是免费的保险', () => {
        expect(parseVolumeText('1.2万')).toBe(12000);
        expect(parseVolumeText('3W')).toBe(30000);
    });

    it('**空串记 `null`, 不记 0**——"详情取到了但成交量没读到"是一个合法形态', () => {
        expect(parseVolumeText('')).toBe(null);
        expect(parseVolumeText('   ')).toBe(null);
    });

    it('认不出的形态记 `null`（原文仍保留在 `volume` 里）', () => {
        expect(parseVolumeText('约 500')).toBe(null);
        expect(parseVolumeText('1.2e3')).toBe(null);
        expect(parseVolumeText('--')).toBe(null);
    });

    it('**不带后缀的小数照常解析**——不能无条件用 `Number.isSafeInteger` 守卫', () => {
        // 那个守卫对 `1.2` 返回 false, 会把"没有后缀的小数成交量"整类读成 null（实测踩过）
        expect(parseVolumeText('1.2')).toBe(1.2);
    });

    it('超长整数会被 Number 静默截断, 此时记 null 而不是返回一个错值', () => {
        expect(parseVolumeText('9007199254740993')).toBe(null);
    });
});

// ==================== 挂单深度与失真 ====================

describe('readListingCount / readResponseTotal / isThinMarket — 挂单深度', () => {
    const counts = (
        data: Record<string, unknown>,
    ): DetailResponse => ({ data });

    it('`total` 优先: 它才是全量条数, `items` 可能只是分页的一页', () => {
        expect(
            readListingCount(
                counts({ total: 20, items: [1, 2, 3, 4, 5] }),
            ),
        ).toBe(20);
    });

    it('`total` 缺失 / 非数 / 为 0 时退到 `items.length`', () => {
        expect(readListingCount(counts({ items: [1, 2, 3] }))).toBe(
            3,
        );
        expect(
            readListingCount(
                counts({ total: '20', items: [1, 2, 3] }),
            ),
        ).toBe(3);
        expect(
            readListingCount(counts({ total: 0, items: [1, 2, 3] })),
        ).toBe(3);
    });

    it('两个都读不出时是「无法判定」, **不是 0 条**', () => {
        // 0 条是确定的薄市场, null 只是没证据——两者必须分开, 否则响应没到会被判成失真
        expect(readListingCount(counts({ items: 'x' }))).toBe(null);
        expect(readListingCount(counts({}))).toBe(null);
        expect(readListingCount({})).toBe(null);
        expect(isThinMarket(counts({ items: 'x' }))).toBe(null);
        expect(isThinMarket({})).toBe(null);
    });

    it('`readResponseTotal` 单独暴露 `total`, 给日志分辨"条数是不是按 items 数的"', () => {
        expect(
            readResponseTotal(
                counts({ total: 20, items: [1, 2, 3] }),
            ),
        ).toBe(20);
        expect(readResponseTotal(counts({ items: [1, 2, 3] }))).toBe(
            null,
        );
        expect(readResponseTotal(counts({ total: 0 }))).toBe(null);
    });

    it('边界是**严格的小于 15**: 14 条失真, 15 条算够', () => {
        expect(MIN_MARKET_LISTINGS).toBe(15);
        expect(isThinMarket(counts({ total: 14 }))).toBe(true);
        expect(isThinMarket(counts({ total: 15 }))).toBe(false);
        expect(isThinMarket(counts({ total: 16 }))).toBe(false);
    });

    it('**一条挂单都没有的响应判失真**（0 条是最该判的情形）', () => {
        expect(
            readListingCount(counts({ total: 0, items: [] })),
        ).toBe(0);
        expect(isThinMarket(counts({ total: 0, items: [] }))).toBe(
            true,
        );
    });
});

// ==================== 挂单取值 ====================

describe('readTopListings — 从接口响应取挂单', () => {
    it('价格取 `ratioPrice` **原样**, 不取倒数', () => {
        const listings = readTopListings(
            respond([node({ ratioPrice: 8.3333 })]),
            5,
        );

        expect(listings[0]?.pricePerYuan).toBe(8.3333);
        expect(listings[0]?.pricePerYuan).not.toBeCloseTo(
            1 / 8.3333,
            6,
        );
    });

    it('**`ratioPrice` 读不出来就整条丢弃**——没有"拿 `rmbPrice` 取倒数"的回退', () => {
        // 取倒数会算出"页面上找不到的数"（1/0.0063 = 158.73, 而真值是 160.006）
        const listings = readTopListings(
            respond([
                node({ ratioPrice: undefined, rmbPrice: 0.0063 }),
            ]),
            5,
        );

        expect(listings).toEqual([]);
    });

    it('`ratioPrice` 为 0 或负数同样丢弃（不是有效报价）', () => {
        expect(
            readTopListings(respond([node({ ratioPrice: 0 })]), 5),
        ).toEqual([]);
        expect(
            readTopListings(respond([node({ ratioPrice: -1 })]), 5),
        ).toEqual([]);
    });

    it('只保留属于目标区服的挂单', () => {
        const listings = readTopListings(
            respond([
                node({ specValues: [{ id: '别人' }] }),
                node({ specValues: [{ id: SPEC_ID }] }),
            ]),
            5,
            SPEC_ID,
        );

        expect(listings).toHaveLength(1);
    });

    it('**按响应顺序取前 N 条, 不重排**——重排会让"抓到的 topN"与用户看到的不是同一批', () => {
        const listings = readTopListings(
            respond([
                node({ ratioPrice: 52.6 }),
                node({ ratioPrice: 8.33 }),
                node({ ratioPrice: 91 }),
            ]),
            2,
        );

        expect(
            listings.map((listing) => listing.pricePerYuan),
        ).toEqual([52.6, 8.33]);
    });

    it('库存缺失的整条丢弃（没有库存的挂单在展示上是个空洞）', () => {
        expect(
            readTopListings(respond([node({ stock: undefined })]), 5),
        ).toEqual([]);
    });

    it('`ratioUnit` 缺失时退到 `rmbPriceUnit`（实测两者同值）', () => {
        const listings = readTopListings(
            respond([
                node({ ratioUnit: undefined, rmbPriceUnit: '火' }),
            ]),
            5,
        );

        expect(listings[0]?.ratioUnit).toBe('火');
    });

    it('响应结构不对时不抛错, 返回空数组', () => {
        expect(readTopListings({}, 5)).toEqual([]);
        expect(
            readTopListings({ data: { items: '不是数组' } }, 5),
        ).toEqual([]);
    });
});

describe('parseListingRows — DOM 兜底路径解析挂单卡片', () => {
    /** 挂单卡价格区第一行：`1 元 = <值> 个`——**值本身就是比率价** */
    const ratioLine = (value: string, unit = '个') => [
        '1',
        '元',
        '=',
        value,
        unit,
    ];

    it('**原样取用, 绝不取倒数**（真机形态 `1 元 = 8.4746 个`）', () => {
        // 取倒数会得到 0.118——量级上像是"元/个", 与接口来源的 52.6537 混在同一个字段里
        const listings = parseListingRows(
            [card(['350'], ratioLine('8.4746'))],
            5,
        );

        expect(listings[0]?.pricePerYuan).toBeCloseTo(8.4746, 9);
        expect(listings[0]?.pricePerYuan).not.toBeCloseTo(
            1 / 8.4746,
            3,
        );
    });

    it('库存取**第一个不带小数点的非负整数**, 跳过带小数的价格', () => {
        const listings = parseListingRows(
            [card(['7.413', '382', '382'], ratioLine('7.413'))],
            5,
        );

        expect(listings[0]?.stock).toBe(382);
    });

    it('单位取价格行最后一个 span', () => {
        const listings = parseListingRows(
            [card(['382'], ratioLine('7.413', '火'))],
            5,
        );

        expect(listings[0]?.ratioUnit).toBe('火');
    });

    it('**任何一行解析不出来就整条丢弃**', () => {
        // 价格区没认出来（选择器过期）→ 两行都是空 → 整条丢弃, 不产出空洞
        expect(parseListingRows([card(['382'], [])], 5)).toEqual([]);
        // 没有库存
        expect(
            parseListingRows([card([], ratioLine('7.413'))], 5),
        ).toEqual([]);
    });

    it('零价格 / 负价格丢弃（页面上的占位符不是价格）', () => {
        expect(
            parseListingRows([card(['382'], ratioLine('0'))], 5),
        ).toEqual([]);
        expect(
            parseListingRows([card(['382'], ratioLine('-5'))], 5),
        ).toEqual([]);
    });

    it('**按数组顺序取前 N 条, 不重排**', () => {
        const listings = parseListingRows(
            [
                card(['1'], ratioLine('3')),
                card(['2'], ratioLine('1')),
                card(['3'], ratioLine('2')),
            ],
            2,
        );

        expect(
            listings.map((listing) => listing.pricePerYuan),
        ).toEqual([3, 1]);
    });
});

// ==================== 装配 ====================

describe('buildCurrencyDetail — 详情块', () => {
    it('成交量**原文与解析值一并保留**', () => {
        const detail = buildCurrencyDetail(' 518.3w ', []);

        expect(detail.volume).toBe('518.3w');
        expect(detail.volumeValue).toBe(5183000);
    });

    it('成交量空串时原文是空串、解析值是 `null`——两个都保留, 不归一', () => {
        const detail = buildCurrencyDetail('', []);

        expect(detail.volume).toBe('');
        expect(detail.volumeValue).toBe(null);
    });
});

describe('attachDetail — 市价失真的降级（ADR-0007）', () => {
    /** 一条有价的条目 */
    const priced: PriceItem = {
        name: '神圣石',
        price: 8.417,
        unit: '个/元',
        rmbPrice: 0.1188,
        rmbUnit: '元/个',
    };
    const detail = {
        volume: '522.8w',
        volumeValue: 5228000,
        listings: [
            { stock: 600, pricePerYuan: 8.3333, ratioUnit: '个' },
        ],
    };

    it('挂单过少: 价格归零, **元方向两个键一起撤掉**', () => {
        const entry = attachDetail(priced, detail, true);

        expect(entry).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
            thinMarket: true,
            detail,
        });
        // 元方向是同一个失真价格的反向, 留着等于"没有价, 但每个 0.1188 元"
        expect(entry).not.toHaveProperty('rmbPrice');
        expect(entry).not.toHaveProperty('rmbUnit');
    });

    it('**详情保留**——失真的是"市场价"这个汇总, 不是单条挂单', () => {
        expect(attachDetail(priced, detail, true).detail).toEqual(
            detail,
        );
    });

    it('挂单够深时价格原样带过去', () => {
        const entry = attachDetail(priced, detail, false);

        expect(entry.price).toBe(8.417);
        expect(entry.rmbPrice).toBe(0.1188);
        expect(entry).not.toHaveProperty('thinMarket');
    });

    it('**数不出条数（`thin` 为 `null`）时不判定**——不因缺少证据删数据', () => {
        const entry = attachDetail(priced, detail, null);

        expect(entry.price).toBe(8.417);
        expect(entry).not.toHaveProperty('thinMarket');
    });

    it('**只降级本来有价的条目**——本来就没价的保持原状, 不抹掉它携带的信号', () => {
        const noPrice: PriceItem = {
            name: '神圣石',
            price: null,
            unit: null,
        };
        const entry = attachDetail(noPrice, detail, true);

        expect(entry).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
            detail,
        });
        expect(entry).not.toHaveProperty('thinMarket');
    });

    it('没取到详情时照常装配（`detail` 记 `null`, 价格不动）', () => {
        expect(attachDetail(priced, null, null)).toEqual({
            ...priced,
            detail: null,
        });
    });
});
