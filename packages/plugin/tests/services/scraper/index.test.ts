/**
 * 抓取主流程的**编排层**
 *
 * 这里测的是决策: 价格取自哪个来源、哪个区服组合进结果、什么时候判整个游戏作废、
 * `missing` 怎么算、详情怎么装配。真实的页面交互（等待响应、点击级联选择器、点开面板）
 * 在 `CatalogPage` 的实现里, 那部分只能在真机上验——但"读到的数据该怎么处理"不该也一起陪绑。
 *
 * 三条硬约束（设计文档 §8.3）里的两条落在这一层, 因此可以被钉死:
 * - 失败不留半截数据
 * - 不写 0 占位
 *
 * ⚠️ 另有一条**反过来的**纪律也在这里钉死（ADR-0006 / ADR-0007）: 有两类失败**不该**
 * 作废整轮——DOM 没刷新出来、详情取不到。它们各自只影响自己那一条。
 */

import { describe, expect, it } from 'vitest';
import type {
    CatalogConfig,
    CurrencyConfig,
} from '../../../src/types';
import {
    scrapeCatalog,
    scrapeGames,
    type CatalogPage,
    type DetailFetch,
    type ExpectedPrice,
    type ZoneExpectation,
} from '../../../src/services/scraper';
import type { RawCurrencyRow } from '../../../src/services/scraper/parse';
import { createTestEnv } from '../../helpers/test-env';

const NOW = '2026-09-16T08:00:05.123Z';

/** 默认的通货清单: 一个通货、不开详情 */
const ONE_CURRENCY: CurrencyConfig[] = [
    { name: '神圣石', detail: false },
];

/** 造一份游戏配置 */
function catalog(
    zoneConfigs: string[][],
    currencyList = ONE_CURRENCY,
): CatalogConfig {
    return {
        name: '流放之路2',
        pageUrl:
            'https://qiandao.com/currency/currency-zone?islandId=301000',
        currencyList,
        zoneConfigs,
    };
}

/** 采集到的一行（浏览器侧产出的形态）。默认值是真实的 `1 元 = 7.893 个` / `1 个 = 0.1267 元` */
function row(
    name: string,
    ratioText: string | null,
    rmbText = '0.1267',
    countUnit = '个',
): RawCurrencyRow {
    return {
        name,
        ratioText,
        rmbText: ratioText === null ? null : rmbText,
        countUnit: ratioText === null ? null : countUnit,
    };
}

/** 价格接口给的一条期望值 */
function price(
    ratioPrice: number,
    ratioUnit = '个',
    rmbPrice: number | null = null,
): ExpectedPrice {
    return { ratioPrice, ratioUnit, rmbPrice };
}

/** 一条装配好的价格项（接口来源, 两个方向都在） */
const FROM_API = {
    name: '神圣石',
    price: 7.893,
    unit: '个/元',
    rmbPrice: 0.1267,
    rmbUnit: '元/个',
};

/** 详情没取到时的那一个返回值（与 `page.ts` 的 `NO_DETAIL` 同形） */
const NO_DETAIL: DetailFetch = {
    detail: null,
    thin: null,
    count: null,
    total: null,
};

/** 一个假的挂单 */
const LISTING = { stock: 600, pricePerYuan: 8.3333, ratioUnit: '个' };

/** 造一个假页面。只实现 `CatalogPage` 的六个动作, 不模拟 playwright 的时序 */
function fakePage(options: {
    zoneSpecIds?: Map<string, string>;
    /** 价格接口给出的期望值。**不传 = 接口什么都没给**, 那一律走 DOM 兜底 */
    expected?: (zonePath: string[]) => ZoneExpectation;
    /** 当前区服下左侧列表的内容 */
    rows?: (zonePath: string[]) => RawCurrencyRow[];
    rendered?: boolean;
    /** 详情采集的结果。缺省 = 详情全空 */
    detail?: (currencyName: string, specId: string) => DetailFetch;
    openError?: Error;
    selectError?: Error;
    /** 打开页面时回调。按 URL 区分不同游戏的页面 */
    onOpen?: (pageUrl: string) => void;
    /** 每次切换时回调（`index` 从 0 起）。抛错即模拟该次切换失败 */
    onSelect?: (zonePath: string[], index: number) => void;
}): CatalogPage & { selected: string[][]; detailCalls: string[] } {
    const selected: string[][] = [];
    const detailCalls: string[] = [];
    let current: string[] = [];

    return {
        selected,
        detailCalls,
        async open(pageUrl: string) {
            options.onOpen?.(pageUrl);
            if (options.openError) throw options.openError;
        },
        async readZoneSpecIds() {
            return options.zoneSpecIds ?? new Map();
        },
        async selectZone(
            zonePath: string[],
        ): Promise<ZoneExpectation> {
            const index = selected.length;
            selected.push(zonePath);
            current = zonePath;

            if (options.selectError) throw options.selectError;
            options.onSelect?.(zonePath, index);

            return options.expected?.(zonePath) ?? new Map();
        },
        async readCurrencyRows() {
            return options.rows?.(current) ?? [];
        },
        async waitForListRendered() {
            return options.rendered ?? true;
        },
        async readCurrencyDetail(
            currencyName: string,
            specId: string,
        ): Promise<DetailFetch> {
            detailCalls.push(currencyName);

            return (
                options.detail?.(currencyName, specId) ?? NO_DETAIL
            );
        },
    };
}

const deps = { now: () => NOW, log: () => {} };

describe('scrapeCatalog — 价格来源（ADR-0006: 接口优先, DOM 兜底）', () => {
    it('接口给了这个通货 → 两个方向都取接口的, 单位拼成 `个/元` 与 `元/个`', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            expected: () =>
                new Map([['神圣石', price(7.893, '个', 0.1267)]]),
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']]),
            deps,
        );

        expect(result).toEqual({
            readAt: NOW,
            missing: [],
            zones: [
                { zone: ['国服'], readAt: NOW, prices: [FROM_API] },
            ],
        });
    });

    it('接口**没给**这个通货时退回 DOM, 两个方向都从页面搬', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            rows: () => [row('神圣石', '7.893', '0.1267')],
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']]),
            deps,
        );

        expect(result.zones[0]?.prices[0]).toEqual(FROM_API);
    });

    it('**接口说本区服无报价（`ratioPrice` 为 0）时不看页面**', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            expected: () => new Map([['神圣石', price(0)]]),
            // 页面上还留着上一个区服的旧正价。按接口记是**少一条数据**, 按页面记是
            // **多一条可能过期的数据**——本项目的取舍一贯是前者
            rows: () => [row('神圣石', '7.893')],
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']]),
            deps,
        );

        expect(result.zones[0]?.prices[0]).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
    });

    it('`price` 只可能是正数或 `null`——**接口报 0 不等于"真的报 0"这个值存在**', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            expected: () => new Map([['神圣石', price(0)]]),
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']]),
            deps,
        );

        expect(result.zones[0]?.prices[0]?.price).toBe(null);
        expect(result.zones[0]?.prices[0]?.price).not.toBe(0);
    });

    it('千分位价格在 DOM 兜底路径上被正确解析（唯一的解析点）', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            rows: () => [row('神圣石', '1,234.5')],
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']]),
            deps,
        );

        expect(result.zones[0]?.prices[0]?.price).toBe(1234.5);
    });

    it('多个区服按配置顺序逐个切换, 每个组合各有自己的读取时刻', async () => {
        const zones = [
            ['国服', '赛季', '普通'],
            ['国际服', '赛季', '专家'],
        ];
        const page = fakePage({
            zoneSpecIds: new Map([
                ['国服/赛季/普通', '1'],
                ['国际服/赛季/专家', '2'],
            ]),
            expected: () =>
                new Map([['神圣石', price(7.893, '个', 0.1267)]]),
        });

        const result = await scrapeCatalog(
            page,
            catalog(zones),
            deps,
        );

        expect(page.selected).toEqual(zones);
        expect(result.zones.map((zone) => zone.zone)).toEqual(zones);
    });
});

describe('scrapeCatalog — 静默错值防线（§8.3）', () => {
    it('**页面级加载校验**: 空壳页面（UA 被拦截）时抛错, 而不是写出满篇空值', async () => {
        const page = fakePage({
            openError: new Error('页面未能加载出内容（可能被拦截）'),
        });

        await expect(
            scrapeCatalog(page, catalog([['国服']]), deps),
        ).rejects.toThrow('页面未能加载出内容');
    });

    it('**切换后回读不符**时抛错——不这样会读到上一个区服的旧值, 而且它看起来完全正常', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            selectError: new Error(
                '切换后选择器显示为「国际服」，与目标「国服」不符，点击可能未生效',
            ),
        });

        await expect(
            scrapeCatalog(page, catalog([['国服']]), deps),
        ).rejects.toThrow('点击可能未生效');
    });

    it('**DOM 没刷新出来时不作废整轮**: 需要兜底的通货记 `null`, 接口给了的照常', async () => {
        // 改造前这里是"DOM 与接口交叉比对不一致 → 整个游戏本轮作废"。价格改由接口定之后,
        // 这条判据的比对对象消失了——而它判错的代价（整轮作废）远大于收益（ADR-0006 结论 6）
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            expected: () =>
                new Map([['神圣石', price(7.893, '个', 0.1267)]]),
            rows: () => [],
            rendered: false,
        });

        const result = await scrapeCatalog(
            page,
            catalog(
                [['国服']],
                [
                    { name: '神圣石', detail: false },
                    { name: '混沌石', detail: false },
                ],
            ),
            deps,
        );

        expect(result.zones[0]?.prices).toEqual([
            FROM_API,
            { name: '混沌石', price: null, unit: null },
        ]);
    });

    it('区服标识拿不到（级联接口没响应）时抛错, 不继续产出无法校验的结果', async () => {
        const page = fakePage({ zoneSpecIds: new Map() });

        await expect(
            scrapeCatalog(page, catalog([['国服']]), deps),
        ).rejects.toThrow('zoneConfigs 中存在页面上没有的组合');
    });
});

describe('scrapeCatalog — 失败不留半截数据（§8.3 硬约束 2）', () => {
    it('第二个区服失败 → **整个游戏本轮作废**, 已成功读到的第一个组合一并丢弃', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([
                ['国服', '1'],
                ['国际服', '2'],
            ]),
            expected: () => new Map([['神圣石', price(7.893)]]),
            onSelect: (_zone, index) => {
                if (index === 1)
                    throw new Error(
                        '切换到 国际服 失败：Timeout 20000ms exceeded',
                    );
            },
        });

        await expect(
            scrapeCatalog(
                page,
                catalog([['国服'], ['国际服']]),
                deps,
            ),
        ).rejects.toThrow('Timeout 20000ms exceeded');
    });

    it('失败是**整个游戏级**的: 第一个组合读到的数据不会以任何形式泄漏出去', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([
                ['国服', '1'],
                ['国际服', '2'],
            ]),
            expected: () => new Map([['神圣石', price(7.893)]]),
            onSelect: (_zone, index) => {
                if (index === 1) throw new Error('切换失败');
            },
        });

        // 用 `rejects` 而不是拿返回值: 只要有半截结果返回, 这条就会失败
        await expect(
            scrapeCatalog(
                page,
                catalog([['国服'], ['国际服']]),
                deps,
            ),
        ).rejects.toThrow();

        // 两个组合都真的被尝试过——先成功再失败, 而不是第一个就挂了
        expect(page.selected).toHaveLength(2);
    });
});

describe('scrapeCatalog — missing 是交集不是并集（§7.2 / ADR-0006 结论 5）', () => {
    const TWO_ZONES = [['国服'], ['国际服']];

    /** 两个区服的级联标识 */
    const TWO_SPEC_IDS = new Map([
        ['国服', '1'],
        ['国际服', '2'],
    ]);

    const TWO_CURRENCIES: CurrencyConfig[] = [
        { name: '神圣石', detail: false },
        { name: '崇高石', detail: false },
    ];

    it('**所有组合的接口响应里都没有**这个名字才进 missing——配置拼错时唯一的可见信号', async () => {
        const page = fakePage({
            zoneSpecIds: TWO_SPEC_IDS,
            // 两个区服的接口都只给了神圣石
            expected: () => new Map([['神圣石', price(7.893)]]),
        });

        const result = await scrapeCatalog(
            page,
            catalog(TWO_ZONES, TWO_CURRENCIES),
            deps,
        );

        expect(result.missing).toEqual(['崇高石']);
    });

    it('只有**部分**组合缺的名字不进 missing——不同区服提供的通货本来就不同', async () => {
        const page = fakePage({
            zoneSpecIds: TWO_SPEC_IDS,
            expected: (zone) =>
                zone[0] === '国服'
                    ? new Map([
                          ['神圣石', price(7.893)],
                          ['崇高石', price(1666.7)],
                      ])
                    : new Map([['神圣石', price(7.893)]]), // 国际服的接口没有崇高石
        });

        const result = await scrapeCatalog(
            page,
            catalog(TWO_ZONES, TWO_CURRENCIES),
            deps,
        );

        expect(result.missing).toEqual([]);
    });

    it('接口**给了这个名字但报 0**（本区服无报价）不算 missing, 它只是 `price` 为 `null`', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            expected: () => new Map([['神圣石', price(0)]]),
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']]),
            deps,
        );

        expect(result.missing).toEqual([]);
        expect(result.zones[0]?.prices[0]).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
    });

    it('**接口里没有的通货记 `null`, 绝不写 0 占位**', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']]),
            deps,
        );

        expect(result.zones[0]?.prices[0]).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
        expect(result.missing).toEqual(['神圣石']);
    });
});

describe('scrapeCatalog — 详情与市价失真（ADR-0005 / ADR-0007）', () => {
    const DETAIL_ON: CurrencyConfig[] = [
        { name: '神圣石', detail: true },
    ];
    const SPEC_ID = new Map([['国服', '3794868']]);

    /** 接口给了价 + 一份正常的详情 */
    function withApi(): Parameters<typeof fakePage>[0] {
        return {
            zoneSpecIds: SPEC_ID,
            expected: () =>
                new Map([['神圣石', price(7.893, '个', 0.1267)]]),
        };
    }

    it('详情取到时挂进价格项, 且**不改动价格本身**', async () => {
        const detail = {
            volume: '518.3w',
            volumeValue: 5183000,
            listings: [LISTING],
        };
        const page = fakePage({
            ...withApi(),
            detail: () => ({
                detail,
                thin: false,
                count: 20,
                total: 20,
            }),
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']], DETAIL_ON),
            deps,
        );

        expect(result.zones[0]?.prices[0]).toEqual({
            ...FROM_API,
            detail,
        });
    });

    it('**挂单过少 → 价格归零、元方向两个键一起撤掉、详情保留**', async () => {
        const detail = {
            volume: '',
            volumeValue: null,
            listings: [LISTING],
        };
        const page = fakePage({
            ...withApi(),
            detail: () => ({
                detail,
                thin: true,
                count: 3,
                total: 3,
            }),
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']], DETAIL_ON),
            deps,
        );
        const entry = result.zones[0]?.prices[0];

        expect(entry).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
            thinMarket: true,
            detail,
        });
        // 元方向是同一个失真价格的反向, 留着会变成"没有价, 但每个 0.1267 元"
        expect(entry).not.toHaveProperty('rmbPrice');
        expect(entry).not.toHaveProperty('rmbUnit');
    });

    it('**数不出挂单条数时不判定**: 价格原样, `thinMarket` 不出现', async () => {
        const detail = {
            volume: '518.3w',
            volumeValue: 5183000,
            listings: [LISTING],
        };
        const page = fakePage({
            ...withApi(),
            detail: () => ({
                detail,
                thin: null,
                count: null,
                total: null,
            }),
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']], DETAIL_ON),
            deps,
        );
        const entry = result.zones[0]?.prices[0];

        expect(entry?.price).toBe(7.893);
        expect(entry).not.toHaveProperty('thinMarket');
    });

    it('**无报价的通货不点详情**——点进去多半是空面板, 而它不产生错值', async () => {
        const page = fakePage({
            zoneSpecIds: SPEC_ID,
            expected: () => new Map([['神圣石', price(0)]]),
        });

        await scrapeCatalog(
            page,
            catalog([['国服']], DETAIL_ON),
            deps,
        );

        expect(page.detailCalls).toEqual([]);
    });

    it('**没开详情的通货不点详情**——逐通货开启, 默认关闭', async () => {
        const page = fakePage(withApi());

        await scrapeCatalog(
            page,
            catalog([['国服']], ONE_CURRENCY),
            deps,
        );

        expect(page.detailCalls).toEqual([]);
    });

    it('**详情失败不判游戏失败**: 价格照常落盘, 只是没有详情块', async () => {
        const page = fakePage({
            ...withApi(),
            detail: () => {
                throw new Error(
                    '「神圣石」详情面板读到了 2 张卡片，但没有一张能读出价格行',
                );
            },
        });

        const result = await scrapeCatalog(
            page,
            catalog([['国服']], DETAIL_ON),
            deps,
        );

        expect(result.zones[0]?.prices[0]).toEqual({
            ...FROM_API,
            detail: null,
        });
    });
});

/** 造一份带名字的游戏配置（名字同时是 `data.json` 的键） */
function namedCatalog(
    name: string,
    zoneConfigs: string[][] = [['国服']],
): CatalogConfig {
    return {
        name,
        pageUrl: `https://qiandao.com/${name}`,
        currencyList: ONE_CURRENCY,
        zoneConfigs,
    };
}

/** 造一个只服务一次抓取过程的假页面会话 */
function session(page: CatalogPage) {
    return { page, close: async (): Promise<void> => {} };
}

const specIds = new Map([['国服', '1']]);

describe('scrapeGames — 多游戏编排', () => {
    it('返回值与 `data.json` 的 `games` 同构: 成功的记结果、失败的记 `error`', async () => {
        const page = fakePage({
            zoneSpecIds: specIds,
            expected: () =>
                new Map([['神圣石', price(7.893, '个', 0.1267)]]),
            onOpen: (pageUrl) => {
                if (pageUrl.includes('火炬之光'))
                    throw new Error(
                        '页面未能加载出内容（可能被拦截）',
                    );
            },
        });

        const result = await scrapeGames(
            [namedCatalog('流放之路2'), namedCatalog('火炬之光')],
            {
                openPage: async () => session(page),
                now: () => NOW,
            },
        );

        expect(result).toEqual({
            流放之路2: {
                readAt: NOW,
                missing: [],
                zones: [
                    {
                        zone: ['国服'],
                        readAt: NOW,
                        prices: [FROM_API],
                    },
                ],
            },
            火炬之光: { error: '页面未能加载出内容（可能被拦截）' },
        });
    });

    it('**一个游戏失败不影响其他游戏**: 失败的那个不会连累后面的', async () => {
        const page = fakePage({
            zoneSpecIds: specIds,
            expected: () =>
                new Map([['神圣石', price(7.893, '个', 0.1267)]]),
            onOpen: (pageUrl) => {
                if (pageUrl.includes('流放之路2'))
                    throw new Error('挂了');
            },
        });

        const result = await scrapeGames(
            [namedCatalog('流放之路2'), namedCatalog('火炬之光')],
            { openPage: async () => session(page), now: () => NOW },
        );

        expect(result['流放之路2']).toEqual({ error: '挂了' });
        expect(result['火炬之光']).toHaveProperty('zones');
    });

    it('**同一时刻只用 1 个页面会话**: 多个游戏共用同一个 page 串行跑（不做并发）', async () => {
        let opened = 0;
        let closed = 0;
        const page = fakePage({
            zoneSpecIds: specIds,
            expected: () => new Map([['神圣石', price(7.893)]]),
        });

        await scrapeGames(
            [namedCatalog('流放之路2'), namedCatalog('火炬之光')],
            {
                openPage: async () => {
                    opened++;

                    return { page, close: async () => void closed++ };
                },
                now: () => NOW,
            },
        );

        expect(opened).toBe(1);
        expect(closed).toBe(1);
    });

    it('**`catalogs` 为空时不启动浏览器**——没有要抓的东西就别去开一个进程', async () => {
        let opened = 0;

        const result = await scrapeGames([], {
            openPage: async () => {
                opened++;

                return session(fakePage({}));
            },
        });

        expect(result).toEqual({});
        expect(opened).toBe(0);
    });

    it('抓取完一定关掉页面会话, 即使中途抛错', async () => {
        let closed = 0;
        const page = fakePage({
            zoneSpecIds: specIds,
            expected: () => new Map([['神圣石', price(7.893)]]),
        });

        await scrapeGames([namedCatalog('流放之路2')], {
            openPage: async () => ({
                page,
                close: async () => void closed++,
            }),
            now: () => NOW,
        });

        expect(closed).toBe(1);
    });
});

describe('抓取层 — 不落盘、不推送、不归档（§8.1）', () => {
    it('跑完一整轮抓取, **数据目录里不会多出任何文件、也不会发出任何消息**', async () => {
        const env = createTestEnv();
        env.init();

        try {
            const page = fakePage({
                zoneSpecIds: specIds,
                expected: () => new Map([['神圣石', price(7.893)]]),
            });

            const result = await scrapeGames(
                [namedCatalog('流放之路2')],
                {
                    openPage: async () => session(page),
                    now: () => NOW,
                },
            );

            // 抓取层只回答"这几个游戏现在值多少"——落盘、推送、归档都是调用方的事
            expect(Object.keys(result)).toEqual(['流放之路2']);
            expect(env.readDataFile('data.json')).toBe(null);
            expect(env.readDataFile('state.json')).toBe(null);
            expect(env.sent).toEqual([]);
        } finally {
            env.dispose();
        }
    });
});
