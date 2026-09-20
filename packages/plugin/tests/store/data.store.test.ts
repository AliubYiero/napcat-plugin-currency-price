/**
 * `data.json` —— 最新价格 + 抓取状态
 *
 * 见设计文档 §7.2。本片落定结构、原子写、损坏恢复与两条覆盖规则（成功覆盖 / 失败只记
 * `lastError`）。**新鲜度判定**（读游戏级 `readAt`）在片 05, 但它依据的字段在这里落盘。
 */

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DataStore,
    type GameOk,
    type GameRecord,
} from '../../src/store/data.store';
import { createTestEnv, type TestEnv } from '../helpers/test-env';

let env: TestEnv;
let store: DataStore;

/** 指纹在本层是**不透明字符串**——这里挑一个随便的值, 只验"原样落盘 / 不被覆盖" */
const FINGERPRINT = 'fp:流放之路2';

/** 一个成功的游戏抓取结果 */
function okResult(): GameOk {
    return {
        readAt: '2026-09-16T08:00:05.123Z',
        missing: [],
        zones: [
            {
                zone: ['国服', '赛季', '普通'],
                readAt: '2026-09-16T08:00:05.123Z',
                prices: [
                    { name: '神圣石', price: 0.2444, unit: '元/个' },
                ],
            },
        ],
    };
}

beforeEach(() => {
    env = createTestEnv();
    env.init();
    store = DataStore.getInstance();
});

afterEach(() => {
    env.dispose();
});

describe('DataStore — 落盘与读回', () => {
    it('成功结果落盘, 结构与设计文档 §7.2 一致（`lastError` 补 `null`）', () => {
        store.saveGameResult('流放之路2', okResult(), FINGERPRINT);

        expect(
            JSON.parse(env.readDataFile('data.json') ?? '{}'),
        ).toEqual({
            version: 2,
            games: {
                流放之路2: {
                    readAt: '2026-09-16T08:00:05.123Z',
                    configFingerprint: FINGERPRINT,
                    lastError: null,
                    missing: [],
                    zones: [
                        {
                            zone: ['国服', '赛季', '普通'],
                            readAt: '2026-09-16T08:00:05.123Z',
                            prices: [
                                {
                                    name: '神圣石',
                                    price: 0.2444,
                                    unit: '元/个',
                                },
                            ],
                        },
                    ],
                },
            },
        });
    });
});

describe('DataStore — 失败不覆盖（§7.2 规则 2）', () => {
    const ERROR =
        '切换到 国服 / 赛季 / 普通 失败：Timeout 20000ms exceeded';

    it('本轮失败时 `zones` / `readAt` 保持上一次成功的内容, **只更新 `lastError`**', () => {
        store.saveGameResult('流放之路2', okResult(), FINGERPRINT);
        store.saveGameResult(
            '流放之路2',
            { error: ERROR },
            FINGERPRINT,
        );

        const game = store.getGame('流放之路2');

        expect(game?.readAt).toBe('2026-09-16T08:00:05.123Z');
        expect(game?.zones).toHaveLength(1);
        expect(game?.lastError).toBe(ERROR);
    });

    it('失败后又成功一次, `lastError` 清回 `null`', () => {
        store.saveGameResult('流放之路2', okResult(), FINGERPRINT);
        store.saveGameResult(
            '流放之路2',
            { error: ERROR },
            FINGERPRINT,
        );
        store.saveGameResult('流放之路2', okResult(), FINGERPRINT);

        expect(store.getGame('流放之路2')?.lastError).toBe(null);
    });

    it('**从未成功抓到过的游戏**失败后不产生条目——没有数据就是没有, 不写半截记录充数', () => {
        // 先落一个别的游戏, 让文件存在——否则"失败的游戏不在文件里"是文件压根不存在造出来的假象
        store.saveGameResult('流放之路2', okResult(), FINGERPRINT);
        store.saveGameResult(
            '火炬之光',
            { error: '页面未能加载出内容（可能被拦截）' },
            FINGERPRINT,
        );

        expect(store.getGame('火炬之光')).toBe(null);
        expect(Object.keys(store.getGames())).toEqual(['流放之路2']);
    });
});

describe('DataStore — 配置指纹（§9.2 新鲜度判定的第二个依据）', () => {
    it('指纹原样落盘、原样读回', () => {
        store.saveGameResult('流放之路2', okResult(), FINGERPRINT);

        expect(store.getGame('流放之路2')?.configFingerprint).toBe(
            FINGERPRINT,
        );
    });

    it('**失败不改指纹**——留下的数据确实还是上一次那份配置抓的', () => {
        store.saveGameResult('流放之路2', okResult(), 'fp:旧配置');
        store.saveGameResult(
            '流放之路2',
            { error: '页面打不开' },
            'fp:新配置',
        );

        expect(store.getGame('流放之路2')?.configFingerprint).toBe(
            'fp:旧配置',
        );
    });

    it('**指纹字段缺失（版本号对得上）读回空串**——与任何真实配置都对不上, 于是重抓一轮', () => {
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(
            path.join(env.dataPath, 'data.json'),
            JSON.stringify({
                version: 2,
                games: {
                    流放之路2: {
                        readAt: '2026-09-16T08:00:05.123Z',
                        zones: [],
                        missing: [],
                        lastError: null,
                    },
                },
            }),
            'utf-8',
        );

        expect(store.getGame('流放之路2')?.configFingerprint).toBe(
            '',
        );
    });
});

describe('DataStore — 版本门（ADR-0006 / ADR-0007 的硬性要求）', () => {
    /** 写一份指定版本号的 `data.json` */
    function writeVersion(version: number, price: unknown): void {
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(
            path.join(env.dataPath, 'data.json'),
            JSON.stringify({
                version,
                games: {
                    流放之路2: {
                        readAt: '2026-09-16T08:00:05.123Z',
                        configFingerprint: 'fp:旧配置',
                        lastError: null,
                        missing: [],
                        zones: [
                            {
                                zone: ['国服'],
                                readAt: '2026-09-16T08:00:05.123Z',
                                prices: [
                                    {
                                        name: '神圣石',
                                        ...(price as object),
                                    },
                                ],
                            },
                        ],
                    },
                },
            }),
            'utf-8',
        );
    }

    it('**v1 的文件整份丢弃, 当"从未抓到过"**——不是逐字段兼容', () => {
        // v1 里 `price` 是**元/个**方向、`0` 表示无报价。形态上与合法值无法区分,
        // 兼容它就是把一个错值当好值用。而「失败不覆盖」会让这份旧数据在抓取失败时
        // 原样留下、被新渲染层当新数据读——指纹兜不住那条路径（DATA_VERSION 的说明）
        writeVersion(1, { price: 0.2444, unit: '元/个' });

        expect(store.getGame('流放之路2')).toBe(null);
        expect(store.getGames()).toEqual({});
    });

    it('版本号对得上时照常读回——门不是"一律丢弃"', () => {
        writeVersion(2, { price: 7.893, unit: '个/元' });

        expect(
            store.getGame('流放之路2')?.zones[0]?.prices[0],
        ).toEqual({
            name: '神圣石',
            price: 7.893,
            unit: '个/元',
        });
    });

    it('版本号缺失（手改坏、更早的文件）同样整份丢弃', () => {
        writeVersion(undefined as never, {
            price: 7.893,
            unit: '个/元',
        });

        expect(store.getGames()).toEqual({});
    });
});

describe('DataStore — 价格项的字段（§7.2 / ADR-0006 / ADR-0007）', () => {
    /** 落一个只含给定价格项的游戏, 再原样读回 */
    function roundTrip(
        prices: GameRecord['zones'][number]['prices'],
    ) {
        store.saveGameResult(
            '流放之路2',
            {
                readAt: '2026-09-16T08:00:05.123Z',
                missing: [],
                zones: [
                    {
                        zone: ['国服'],
                        readAt: '2026-09-16T08:00:05.123Z',
                        prices,
                    },
                ],
            },
            FINGERPRINT,
        );

        return store.getGame('流放之路2')?.zones[0]?.prices ?? [];
    }

    it('`price: null` 落盘后仍是 `null`——**不被归一成任何数字**', () => {
        const prices = roundTrip([
            { name: '崇高石', price: null, unit: null },
        ]);

        expect(prices[0]).toEqual({
            name: '崇高石',
            price: null,
            unit: null,
        });
        expect(env.readDataFile('data.json')).toContain(
            '"price": null',
        );
    });

    it('元方向**同进同出**: 缺一个就两个都不装配（半个价格更容易被误读）', () => {
        const prices = roundTrip([
            // 只有 rmbPrice、没有 rmbUnit —— 消费方会以为单位是自己推出来的
            {
                name: '神圣石',
                price: 7.893,
                unit: '个/元',
                rmbPrice: 0.1267,
            },
        ]);

        expect(prices[0]).toEqual({
            name: '神圣石',
            price: 7.893,
            unit: '个/元',
        });
    });

    it('元方向齐备时原样读回', () => {
        const prices = roundTrip([
            {
                name: '神圣石',
                price: 7.893,
                unit: '个/元',
                rmbPrice: 0.1267,
                rmbUnit: '元/个',
            },
        ]);

        expect(prices[0]).toEqual({
            name: '神圣石',
            price: 7.893,
            unit: '个/元',
            rmbPrice: 0.1267,
            rmbUnit: '元/个',
        });
    });

    it('`thinMarket` 只在 `true` 时出现, 原样读回', () => {
        const prices = roundTrip([
            {
                name: '混沌石',
                price: null,
                unit: null,
                thinMarket: true,
                detail: null,
            },
            { name: '神圣石', price: 7.893, unit: '个/元' },
        ]);

        expect(prices[0]?.thinMarket).toBe(true);
        expect(prices[1]).not.toHaveProperty('thinMarket');
    });

    it('**`detail` 的三种状态分开保留**: 键不出现 / `null` / 有值（ADR-0005 结论 6）', () => {
        const listing = {
            stock: 600,
            pricePerYuan: 8.3333,
            ratioUnit: '个',
        };
        const prices = roundTrip([
            // 没开详情
            { name: '甲', price: 1, unit: '个/元' },
            // 开了但这次没取到
            { name: '乙', price: 2, unit: '个/元', detail: null },
            // 取到了
            {
                name: '丙',
                price: 3,
                unit: '个/元',
                detail: {
                    volume: '518.3w',
                    volumeValue: 5183000,
                    listings: [listing],
                },
            },
        ]);

        expect(prices[0]).not.toHaveProperty('detail');
        expect(prices[1]).toHaveProperty('detail', null);
        expect(prices[2]?.detail).toEqual({
            volume: '518.3w',
            volumeValue: 5183000,
            listings: [listing],
        });
    });

    it('挂单结构不完整的**整条丢弃**——宁可少一条挂单, 不可留半条', () => {
        const prices = roundTrip([
            {
                name: '丙',
                price: 3,
                unit: '个/元',
                detail: {
                    volume: '',
                    volumeValue: null,
                    listings: [
                        {
                            stock: 600,
                            pricePerYuan: 8.3333,
                            ratioUnit: '个',
                        },
                        { stock: 100 } as never, // 缺价格
                    ],
                },
            },
        ]);

        expect(prices[0]?.detail?.listings).toHaveLength(1);
    });
});

describe('DataStore — 损坏恢复', () => {
    it('文件损坏时备份为 `*.bak` 并初始化为空, **不阻塞启动**', () => {
        const filePath = path.join(env.dataPath, 'data.json');
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(filePath, '{ 这不是 JSON', 'utf-8');

        expect(store.getGames()).toEqual({});
        expect(fs.readFileSync(`${filePath}.bak`, 'utf-8')).toBe(
            '{ 这不是 JSON',
        );
    });

    it('备份之后所有游戏判为过期——文件被重写成空结构, 而不是留一个读不动的坏文件', () => {
        const filePath = path.join(env.dataPath, 'data.json');
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(filePath, '{ 坏文件', 'utf-8');

        store.getGames();

        expect(
            JSON.parse(env.readDataFile('data.json') ?? '{}'),
        ).toEqual({ version: 2, games: {} });
    });
});
