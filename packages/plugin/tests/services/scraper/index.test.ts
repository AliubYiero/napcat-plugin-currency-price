/**
 * 抓取主流程的**编排层**
 *
 * 这里测的是决策: 哪个区服组合进结果、什么时候判整个游戏作废、`missing` 怎么算。
 * 真实的页面交互（等待响应、渲染轮询、点击级联选择器）在 `CatalogPage` 的实现里,
 * 那部分只能在真机上验——但"读到的数据该怎么处理"不该也一起陪绑。
 *
 * 三条硬约束（设计文档 §8.3）里的两条落在这一层, 因此可以被钉死:
 * - 失败不留半截数据
 * - 不写 0 占位
 */

import { describe, expect, it } from 'vitest';
import type { CatalogConfig } from '../../../src/types';
import {
    scrapeCatalog,
    scrapeGames,
    type CatalogPage,
    type ZoneExpectation,
} from '../../../src/services/scraper';
import type { RawCurrencyRow } from '../../../src/services/scraper/parse';
import { createTestEnv } from '../../helpers/test-env';

const NOW = '2026-09-16T08:00:05.123Z';

/** 造一份游戏配置 */
function catalog(zoneConfigs: string[][], currencyList = ['神圣石']): CatalogConfig {
    return {
        name: '流放之路2',
        pageUrl: 'https://qiandao.com/currency/currency-zone?islandId=301000',
        currencyList,
        zoneConfigs,
    };
}

/** 采集到的一行（浏览器侧产出的形态） */
function row(name: string, priceText: string | null, baseUnit = '个', quoteUnit = '元'): RawCurrencyRow {
    return { name, priceText, baseUnit, quoteUnit };
}

/** 造一个假页面。只实现 `CatalogPage` 的五个动作, 不模拟 playwright 的时序 */
function fakePage(options: {
    zoneSpecIds?: Map<string, string>;
    /** 当前区服下左侧列表的内容。按区服给不同数据, 才能测 `missing` 的交集语义 */
    rows?: (zonePath: string[]) => RawCurrencyRow[];
    rendered?: boolean;
    openError?: Error;
    selectError?: Error;
    /** 打开页面时回调。按 URL 区分不同游戏的页面 */
    onOpen?: (pageUrl: string) => void;
    /** 每次切换时回调（`index` 从 0 起）。抛错即模拟该次切换失败 */
    onSelect?: (zonePath: string[], index: number) => void;
}): CatalogPage & { selected: string[][] } {
    const selected: string[][] = [];
    let current: string[] = [];

    return {
        selected,
        async open(pageUrl: string) {
            options.onOpen?.(pageUrl);
            if (options.openError) throw options.openError;
        },
        async readZoneSpecIds() {
            return options.zoneSpecIds ?? new Map();
        },
        async selectZone(zonePath: string[]): Promise<ZoneExpectation> {
            const index = selected.length;
            selected.push(zonePath);
            current = zonePath;

            if (options.selectError) throw options.selectError;
            options.onSelect?.(zonePath, index);

            return new Map();
        },
        async readCurrencyRows() {
            return options.rows?.(current) ?? [];
        },
        async waitForListRendered() {
            return options.rendered ?? true;
        },
    };
}

const deps = { now: () => NOW };

describe('scrapeCatalog — 正常路径', () => {
    it('单游戏单区服: 读出价格、单位与读取时刻', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服/赛季/普通', '3794868']]),
            rows: () => [row('神圣石', '0.2444')],
        });

        const result = await scrapeCatalog(page, catalog([['国服', '赛季', '普通']]), deps);

        expect(result).toEqual({
            readAt: NOW,
            missing: [],
            zones: [
                {
                    zone: ['国服', '赛季', '普通'],
                    readAt: NOW,
                    prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
                },
            ],
        });
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
            rows: () => [row('神圣石', '0.2444')],
        });

        const result = await scrapeCatalog(page, catalog(zones), deps);

        expect(page.selected).toEqual(zones);
        expect(result.zones.map((zone) => zone.zone)).toEqual(zones);
    });
});

describe('scrapeCatalog — 静默错值防线（§8.3）', () => {
    it('**页面级加载校验**: 空壳页面（UA 被拦截）时抛错, 而不是写出满篇空值', async () => {
        const page = fakePage({
            openError: new Error('页面未能加载出内容（可能被拦截）'),
        });

        await expect(scrapeCatalog(page, catalog([['国服']]), deps)).rejects.toThrow(
            '页面未能加载出内容',
        );
    });

    it('**切换后回读不符**时抛错——不这样会读到上一个区服的旧值, 而且它看起来完全正常', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            selectError: new Error('切换后选择器显示为「国际服」，与目标「国服」不符，点击可能未生效'),
        });

        await expect(scrapeCatalog(page, catalog([['国服']]), deps)).rejects.toThrow('点击可能未生效');
    });

    it('**DOM 与价格接口交叉比对**不一致时抛错', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            rendered: false,
        });

        await expect(scrapeCatalog(page, catalog([['国服']]), deps)).rejects.toThrow(
            'DOM 与价格接口不一致',
        );
    });

    it('区服标识拿不到（级联接口没响应）时抛错, 不继续产出无法校验的结果', async () => {
        const page = fakePage({ zoneSpecIds: new Map() });

        await expect(scrapeCatalog(page, catalog([['国服']]), deps)).rejects.toThrow(
            'zoneConfigs 中存在页面上没有的组合',
        );
    });
});

describe('scrapeCatalog — 失败不留半截数据（§8.3 硬约束 2）', () => {
    it('第二个区服失败 → **整个游戏本轮作废**, 已成功读到的第一个组合一并丢弃', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([
                ['国服', '1'],
                ['国际服', '2'],
            ]),
            rows: () => [row('神圣石', '0.2444')],
            onSelect: (_zone, index) => {
                if (index === 1) throw new Error('切换到 国际服 失败：Timeout 20000ms exceeded');
            },
        });

        await expect(
            scrapeCatalog(page, catalog([['国服'], ['国际服']]), deps),
        ).rejects.toThrow('Timeout 20000ms exceeded');
    });

    it('失败是**整个游戏级**的: 第一个组合读到的数据不会以任何形式泄漏出去', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([
                ['国服', '1'],
                ['国际服', '2'],
            ]),
            rows: () => [row('神圣石', '0.2444')],
            onSelect: (_zone, index) => {
                if (index === 1) throw new Error('切换失败');
            },
        });

        // 用 `rejects` 而不是拿返回值: 只要有半截结果返回, 这条就会失败
        await expect(scrapeCatalog(page, catalog([['国服'], ['国际服']]), deps)).rejects.toThrow();

        // 两个组合都真的被尝试过——先成功再失败, 而不是第一个就挂了
        expect(page.selected).toHaveLength(2);
    });
});

describe('scrapeCatalog — missing 是交集不是并集（§7.2）', () => {
    const TWO_ZONES = [
        ['国服'],
        ['国际服'],
    ];

    it('**所有组合都缺**的名字才进 missing——这是配置拼错时唯一的可见信号', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([
                ['国服', '1'],
                ['国际服', '2'],
            ]),
            // 两个组合都没有「崇高石」
            rows: () => [row('神圣石', '0.2444')],
        });

        const result = await scrapeCatalog(page, catalog(TWO_ZONES, ['神圣石', '崇高石']), deps);

        expect(result.missing).toEqual(['崇高石']);
    });

    it('只有**部分**组合缺的名字不进 missing——不同区服提供的通货本来就不同', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([
                ['国服', '1'],
                ['国际服', '2'],
            ]),
            rows: (zone) =>
                zone[0] === '国服'
                    ? [row('神圣石', '0.2444'), row('崇高石', '1.5')]
                    : [row('神圣石', '0.2444')], // 国际服没有崇高石
        });

        const result = await scrapeCatalog(page, catalog(TWO_ZONES, ['神圣石', '崇高石']), deps);

        expect(result.missing).toEqual([]);
    });

    it('名称在列表里但**页面无报价**（显示 `--`）不算 missing, 它只是 `price` 为 `null`', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            rows: () => [row('神圣石', null)],
        });

        const result = await scrapeCatalog(page, catalog([['国服']], ['神圣石']), deps);

        expect(result.missing).toEqual([]);
        expect(result.zones[0]?.prices[0]).toEqual({ name: '神圣石', price: null, unit: null });
    });

    it('**不在列表里的通货记 `null`, 绝不写 0 占位**', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            rows: () => [],
        });

        const result = await scrapeCatalog(page, catalog([['国服']], ['神圣石']), deps);

        expect(result.zones[0]?.prices[0]).toEqual({ name: '神圣石', price: null, unit: null });
    });

    it('千分位价格在编排层被正确解析（整条链路上唯一的解析点在这里被真正接上）', async () => {
        const page = fakePage({
            zoneSpecIds: new Map([['国服', '1']]),
            rows: () => [row('神圣石', '1,234.5')],
        });

        const result = await scrapeCatalog(page, catalog([['国服']]), deps);

        expect(result.zones[0]?.prices[0]?.price).toBe(1234.5);
    });
});

/** 造一份带名字的游戏配置（名字同时是 `data.json` 的键） */
function namedCatalog(name: string, zoneConfigs: string[][] = [['国服']]): CatalogConfig {
    return {
        name,
        pageUrl: `https://qiandao.com/${name}`,
        currencyList: ['神圣石'],
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
            rows: () => [row('神圣石', '0.2444')],
            onOpen: (pageUrl) => {
                if (pageUrl.includes('火炬之光')) throw new Error('页面未能加载出内容（可能被拦截）');
            },
        });

        const result = await scrapeGames([namedCatalog('流放之路2'), namedCatalog('火炬之光')], {
            openPage: async () => session(page),
            now: () => NOW,
        });

        expect(result).toEqual({
            流放之路2: {
                readAt: NOW,
                missing: [],
                zones: [
                    {
                        zone: ['国服'],
                        readAt: NOW,
                        prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
                    },
                ],
            },
            火炬之光: { error: '页面未能加载出内容（可能被拦截）' },
        });
    });

    it('**一个游戏失败不影响其他游戏**: 失败的那个不会连累后面的', async () => {
        const page = fakePage({
            zoneSpecIds: specIds,
            rows: () => [row('神圣石', '0.2444')],
            onOpen: (pageUrl) => {
                if (pageUrl.includes('流放之路2')) throw new Error('挂了');
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
        const page = fakePage({ zoneSpecIds: specIds, rows: () => [row('神圣石', '0.2444')] });

        await scrapeGames([namedCatalog('流放之路2'), namedCatalog('火炬之光')], {
            openPage: async () => {
                opened++;

                return { page, close: async () => void closed++ };
            },
            now: () => NOW,
        });

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
            rows: () => [row('神圣石', '0.2444')],
        });

        await scrapeGames([namedCatalog('流放之路2')], {
            openPage: async () => ({ page, close: async () => void closed++ }),
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
            const page = fakePage({ zoneSpecIds: specIds, rows: () => [row('神圣石', '0.2444')] });

            const result = await scrapeGames([namedCatalog('流放之路2')], {
                openPage: async () => session(page),
                now: () => NOW,
            });

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
